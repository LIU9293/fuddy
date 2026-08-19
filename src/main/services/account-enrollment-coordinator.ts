import { defaultCompanionRelayUrl } from '../../shared/companion-sync'
import type { FuddyRuntimeChannel } from '../runtime-profile'
import type { AccountService } from './account-service'
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
    return `${url.origin}${pathname}`
  } catch {
    return null
  }
}

export class AccountEnrollmentCoordinator {
  private timer: NodeJS.Timeout | null = null
  private active: Promise<void> | null = null
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
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), accountEnrollmentPollIntervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.lastBindingSignature = null
    this.lastBindingAt = 0
  }

  async processOnce(): Promise<void> {
    if (!this.relayUrl) return
    const state = this.accountService.getState()
    const spaceId = state.status === 'signed-in' ? state.device?.syncSpaceId : null
    const ownerUserId = state.status === 'signed-in' ? state.user?.id : null
    if (!spaceId || !ownerUserId) return
    const binding = await this.companionSync.ensureAccountRelay(
      this.relayUrl,
      undefined,
      spaceId,
      ownerUserId
    )
    const bindingSignature = `${spaceId}\0${binding.relayUrl}\0${binding.relayAccountId}`
    if (bindingSignature !== this.lastBindingSignature || Date.now() - this.lastBindingAt >= 5 * 60_000) {
      await this.accountService.bindRelay({ spaceId, ...binding })
      this.lastBindingSignature = bindingSignature
      this.lastBindingAt = Date.now()
    }
    const page = await this.accountService.listPendingEnrollments(spaceId)
    if (
      page.syncSpace.relayAccountId !== binding.relayAccountId
      || normalizedServiceUrl(page.syncSpace.relayUrl) !== normalizedServiceUrl(binding.relayUrl)
    ) {
      throw new Error('账户服务与本机 Relay 绑定不一致。')
    }
    for (const revocation of page.revocations ?? []) {
      await this.companionSync.revokeAccountDevice(revocation.deviceId)
      await this.accountService.completeRelayRevocation({
        spaceId,
        enrollmentId: revocation.id
      })
    }
    for (const enrollment of page.enrollments) {
      const credentials = await this.companionSync.enrollAccountDevice({
        deviceId: enrollment.deviceId,
        deviceName: enrollment.deviceName,
        publicKey: enrollment.publicKey
      })
      const wrappedSpaceKey = this.accountService.wrapEnrollmentGrant({
        enrollmentId: enrollment.id,
        spaceId,
        deviceId: enrollment.deviceId,
        recipientPublicKey: enrollment.publicKey,
        credentials
      })
      await this.accountService.completeEnrollment({
        spaceId,
        enrollmentId: enrollment.id,
        wrappedSpaceKey,
        keyVersion: page.syncSpace.keyVersion
      })
    }
  }

  private async tick(): Promise<void> {
    if (this.active) return await this.active
    this.active = this.processOnce().catch(() => {
      // Account/Relay connectivity is opportunistic. The next poll retries without
      // interrupting local Fuddy work or turning an offline Mac into a sign-out.
    })
    try {
      await this.active
    } finally {
      this.active = null
    }
  }
}
