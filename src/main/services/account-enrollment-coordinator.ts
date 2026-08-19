import { defaultCompanionRelayUrl } from '../../shared/companion-sync'
import type { FuddyRuntimeChannel } from '../runtime-profile'
import { AccountAuthorizationLostError, AccountRequestError, type AccountService } from './account-service'
import type { CompanionSyncService } from './companion-sync'

export const accountEnrollmentPollIntervalMs = 5_000

function normalizedServiceUrl(value: string): string {
  const url = new URL(value)
  const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/u, '')
  return `${url.origin}${pathname}`
}

export function resolveCompanionRelayUrl(
  value: string | null | undefined,
  runtimeChannel: FuddyRuntimeChannel
): string | null {
  const candidate = value?.trim() || (runtimeChannel === 'production' ? defaultCompanionRelayUrl : '')
  if (!candidate) return null
  try {
    const url = new URL(candidate)
    const isLocalDevelopment = runtimeChannel === 'development'
      && url.protocol === 'http:'
      && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
    if (url.protocol !== 'https:' && !isLocalDevelopment) return null
    if (url.username || url.password || url.search || url.hash) return null
    const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/u, '')
    const normalized = `${url.origin}${pathname}`
    if (runtimeChannel === 'production' && normalized !== defaultCompanionRelayUrl) return null
    return normalized
  } catch {
    return null
  }
}

export class AccountEnrollmentCoordinator {
  private timer: NodeJS.Timeout | null = null
  private active: Promise<void> | null = null
  private paused = false
  private lastBindingSignature: string | null = null
  private lastBindingAt = 0

  constructor(
    private readonly accountService: AccountService,
    private readonly companionSync: CompanionSyncService,
    private readonly relayUrl: string | null
  ) {}

  getRelayUrl(): string | null {
    return this.relayUrl
  }

  start(): void {
    this.paused = false
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), accountEnrollmentPollIntervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    this.paused = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.lastBindingSignature = null
    this.lastBindingAt = 0
  }

  async pauseAndDrain(): Promise<void> {
    this.stop()
    await this.active?.catch(() => undefined)
  }

  async processOnce(): Promise<void> {
    if (this.paused) return
    if (this.active) return await this.active
    const operation = this.runOnce().catch(async (error: unknown) => {
      if (error instanceof AccountAuthorizationLostError) {
        this.stop()
        await this.companionSync.disconnectAllAccountRelays().catch(() => {
          // Keep the stopped Relay identity locally so a later sign-in can
          // retry revocation instead of losing the only cleanup credential.
        })
      }
      throw error
    })
    this.active = operation
    try {
      await operation
    } finally {
      if (this.active === operation) this.active = null
    }
  }

  private async runOnce(): Promise<void> {
    const state = this.accountService.getState()
    if (state.status === 'signed-out') {
      this.stop()
      await this.companionSync.disconnectAllAccountRelays().catch(() => undefined)
      return
    }
    if (!this.relayUrl) return
    const spaceId = state.device?.syncSpaceId
    const ownerUserId = state.user?.id
    if (!spaceId || !ownerUserId) return
    const binding = await this.companionSync.ensureAccountRelay(
      this.relayUrl,
      undefined,
      spaceId,
      ownerUserId
    )
    const bindingSignature = `${spaceId}\0${binding.relayUrl}\0${binding.relayAccountId}`
    const bindingInput = { ownerUserId, syncSpaceId: spaceId, ...binding }
    let bindingConfirmed = this.companionSync.isAccountRelayBindingConfirmed(bindingInput)
    if (bindingConfirmed) await this.companionSync.start()
    if (bindingSignature !== this.lastBindingSignature || Date.now() - this.lastBindingAt >= 5 * 60_000) {
      const bindingProof = await this.companionSync.createAccountBindingProof()
      await this.accountService.bindRelay({ spaceId, ...binding, bindingProof: bindingProof.proof })
      this.companionSync.confirmAccountRelayBinding(bindingInput)
      bindingConfirmed = true
      this.lastBindingSignature = bindingSignature
      this.lastBindingAt = Date.now()
    }
    if (!bindingConfirmed) throw new Error('账户 Relay 绑定尚未确认。')
    // Account-owned Relay identities stay locally paused until the Account API
    // has durably recorded the exact ID that must later be revoked.
    await this.companionSync.start()
    const page = await this.accountService.listPendingEnrollments(spaceId)
    if (
      page.syncSpace.relayAccountId !== binding.relayAccountId
      || normalizedServiceUrl(page.syncSpace.relayUrl) !== normalizedServiceUrl(binding.relayUrl)
    ) {
      throw new Error('账户服务与本机 Relay 绑定不一致。')
    }
    for (const revocation of page.revocations ?? []) {
      await this.companionSync.revokeAccountDevice(revocation.deviceId, revocation.id)
      await this.accountService.completeRelayRevocation({
        spaceId,
        enrollmentId: revocation.id
      })
    }
    for (const enrollment of page.enrollments) {
      const credentials = await this.companionSync.enrollAccountDevice({
        deviceId: enrollment.deviceId,
        deviceName: enrollment.deviceName,
        publicKey: enrollment.publicKey,
        grantId: enrollment.id
      })
      const wrappedSpaceKey = this.accountService.wrapEnrollmentGrant({
        enrollmentId: enrollment.id,
        spaceId,
        deviceId: enrollment.deviceId,
        recipientPublicKey: enrollment.publicKey,
        credentials
      })
      try {
        await this.accountService.completeEnrollment({
          spaceId,
          enrollmentId: enrollment.id,
          wrappedSpaceKey,
          keyVersion: page.syncSpace.keyVersion
        })
      } catch (error) {
        if (error instanceof AccountRequestError && (error.status === 404 || error.status === 409)) {
          try {
            await this.companionSync.revokeAccountDevice(enrollment.deviceId, enrollment.id)
          } catch {
            // A revoked grant is durably requeued by the Account API. Other
            // rejected grants rotate this generation again on the next poll.
          }
        }
        throw error
      }
    }
  }

  private async tick(): Promise<void> {
    await this.processOnce().catch(() => {
      // Account/Relay connectivity is opportunistic. The next poll retries without
      // interrupting local Fuddy work or turning an offline Mac into a sign-out.
    })
  }
}
