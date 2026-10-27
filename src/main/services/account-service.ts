import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type {
  AccountDevice,
  AccountDeviceSummary,
  AccountEnrollmentPage,
  AccountIdentity,
  AccountOnboardingState,
  AccountOnboardingStep,
  AccountState,
  AccountUser,
  StartEmailSignInResult
} from '../../shared/account'
import { companionProtocol } from '../../shared/companion-protocol'
import { projectSharingProtocolVersion } from '../../shared/project-sharing-protocol'
import { chatTitleInputLimit, parseGeneratedChatTitle } from '../../shared/agent-run-title'
import type { FuddyRuntimeChannel } from '../runtime-profile'
import type { CredentialVault } from './credential-vault'
import type { AppDatabase } from './database'
import { getGoogleAuthorizationCode } from './google-desktop-oauth'
import {
  wrapDeviceGrant,
  openDeviceGrant,
  wrapProjectDeviceGrant,
  openProjectDeviceGrant,
  type AccountRelayCredentials
} from './account-device-grant'

const accessTokenReference = 'account.access-token'
const refreshTokenReference = 'account.refresh-token'
const devicePrivateKeyReference = 'account.device-private-key'
const cachedAccountKey = 'account.cached-state'
const onboardingKeyPrefix = 'account.onboarding-state:'
const deviceIdentityKey = 'account.device-identity'
const lastSignOutKey = 'account.last-sign-out'

type SignOutReason = 'user_logout' | 'all_devices_logout' | 'device_revoked'
  | 'refresh_expired_locally' | 'missing_refresh_token' | 'refresh_rejected' | 'access_rejected_after_refresh'

interface SignOutDiagnostic {
  reason: SignOutReason
  occurredAt: string
  serverCode: string | null
}

type CredentialStore = Pick<CredentialVault, 'get' | 'set' | 'delete' | 'deleteByPrefix'>

interface CachedAccount {
  user: AccountUser
  device: AccountDevice
  accessExpiresAt?: string
  refreshExpiresAt?: string
}

interface DeviceIdentity {
  id: string
  publicKey: string
}

interface SessionPayload {
  accessToken: string
  refreshToken: string
  accessExpiresAt: string
  refreshExpiresAt: string
}

interface AuthPayload {
  user: AccountUser
  device: AccountDevice
  session: SessionPayload
}

interface AccountApiErrorBody {
  error?: {
    code?: string
    message?: string
  }
}

export class AccountRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string
  ) {
    super(message)
  }
}

export class AccountAuthorizationLostError extends Error {
  constructor() {
    super('登录状态已失效，请重新登录。')
    this.name = 'AccountAuthorizationLostError'
  }
}

export interface AccountServiceOptions {
  apiUrl: string | null
  runtimeChannel: FuddyRuntimeChannel
  appVersion: string
  deviceName?: string
  googleClientId?: string | null
  fetch?: typeof globalThis.fetch
  onSignedOut?: (state: AccountState) => void
}

export function normalizeAccountApiUrl(
  value: string | null | undefined,
  runtimeChannel: FuddyRuntimeChannel
): string | null {
  const normalized = value?.trim()
  if (!normalized) return null
  try {
    const url = new URL(normalized)
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

export class AccountService {
  private readonly fetchImpl: typeof globalThis.fetch
  private authGeneration = 0
  private refreshInFlight: { generation: number; promise: Promise<void> } | null = null

  constructor(
    private readonly database: AppDatabase,
    private readonly credentialVault: CredentialStore,
    private readonly options: AccountServiceOptions
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  getState(): AccountState {
    const cached = this.database.getSetting<CachedAccount | null>(cachedAccountKey, null)
    if (cached?.refreshExpiresAt && new Date(cached.refreshExpiresAt).getTime() <= Date.now()) {
      this.clearLocalAuth('refresh_expired_locally')
      return this.signedOutState('登录状态已过期，请重新登录。')
    }
    if (cached && !this.credentialVault.get(refreshTokenReference)) {
      this.clearLocalAuth('missing_refresh_token')
      return this.signedOutState('登录状态已失效，请重新登录。')
    }
    if (!cached) {
      return this.signedOutState(this.options.apiUrl ? null : 'Account API 尚未配置。')
    }
    const onboardingKey = `${onboardingKeyPrefix}${cached.user.id}`
    const storedOnboarding = this.database.getSetting<
      AccountOnboardingState | { step: 'connect-phone'; completedAt: string | null }
    >(onboardingKey, {
      step: 'detect-agent',
      completedAt: null
    })
    const onboarding: AccountOnboardingState = storedOnboarding.step === 'connect-phone'
      ? { step: 'complete', completedAt: storedOnboarding.completedAt ?? new Date().toISOString() }
      : storedOnboarding
    if (storedOnboarding.step === 'connect-phone') this.database.setSetting(onboardingKey, onboarding)
    return {
      status: 'signed-in',
      serviceStatus: this.options.apiUrl ? 'ready' : 'offline',
      serviceMessage: this.options.apiUrl ? null : '当前离线，仍可使用这台 Mac 上的项目。',
      user: cached.user,
      device: cached.device,
      onboarding,
      availableProviders: { email: true, google: Boolean(this.options.googleClientId) },
      existingProjectCount: this.database.listProjects().length
    }
  }

  async getValidatedState(): Promise<AccountState> {
    const local = this.getState()
    if (local.status !== 'signed-in' || !this.options.apiUrl) return local
    const generation = this.authGeneration
    const accessToken = this.credentialVault.get(accessTokenReference)
    if (!accessToken || !this.credentialVault.get(refreshTokenReference)) return this.signedOutState(null)
    try {
      const current = await this.fetchImpl(`${this.options.apiUrl}/v1/me`, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8_000)
      })
      if (this.authGeneration !== generation) return this.getState()
      if (current.ok) return local
      if (current.status !== 401) return { ...local, serviceStatus: 'offline', serviceMessage: '账户服务暂时不可用。' }
      await this.refreshAuthorization(accessToken)
      return this.getState()
    } catch (error) {
      if (error instanceof AccountAuthorizationLostError) throw error
      if (this.authGeneration !== generation) return this.getState()
      if (this.getState().status === 'signed-out') {
        return this.signedOutState('登录状态已失效，请重新登录。')
      }
      return { ...local, serviceStatus: 'offline', serviceMessage: '当前离线，仍可使用这台 Mac 上的项目。' }
    }
  }

  async generateChatTitle(prompt: string, signal?: AbortSignal): Promise<string | null> {
    if (!this.options.apiUrl || this.getState().status !== 'signed-in') return null
    const generation = this.authGeneration
    try {
      const response = await this.requestAuthorized('/v1/chat-titles', {
        method: 'POST', body: JSON.stringify({ prompt: prompt.trim().slice(0, chatTitleInputLimit) }),
        signal: signal ?? AbortSignal.timeout(12_000)
      })
      const payload: unknown = await response.json()
      if (generation !== this.authGeneration) return null
      return parseGeneratedChatTitle(payload && typeof payload === 'object' && 'title' in payload ? payload.title : null)
    } catch {
      return null
    }
  }

  async startEmailSignIn(email: string): Promise<StartEmailSignInResult> {
    const normalizedEmail = email.trim().toLowerCase()
    const response = await this.request('/v1/auth/email/start', {
      method: 'POST',
      body: JSON.stringify({ email: normalizedEmail })
    })
    const payload = await response.json() as Omit<StartEmailSignInResult, 'email'>
    return { ...payload, email: normalizedEmail }
  }

  async verifyEmailSignIn(challengeId: string, code: string): Promise<AccountState> {
    const response = await this.request('/v1/auth/email/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId, code, device: this.getDeviceInput() })
    })
    const payload = await response.json() as AuthPayload
    this.persistAuth(payload)
    return this.getState()
  }

  async acceptGoogleIdToken(idToken: string): Promise<AccountState> {
    const response = await this.request('/v1/auth/google', {
      method: 'POST',
      body: JSON.stringify({ idToken, device: this.getDeviceInput() })
    })
    const payload = await response.json() as AuthPayload
    this.persistAuth(payload)
    return this.getState()
  }

  async signInWithGoogle(
    openExternal: (url: string) => Promise<unknown>,
    onAuthorizationUrl?: (url: string) => void
  ): Promise<AccountState> {
    const clientId = this.options.googleClientId?.trim()
    if (!clientId) throw new Error('Google 登录暂时不可用，请使用邮箱继续。')
    const authorization = await getGoogleAuthorizationCode({
      clientId,
      openExternal,
      onAuthorizationUrl
    })
    const response = await this.request('/v1/auth/google', {
      method: 'POST',
      body: JSON.stringify({ ...authorization, device: this.getDeviceInput() })
    })
    const payload = await response.json() as AuthPayload
    this.persistAuth(payload)
    return this.getState()
  }

  async listIdentities(): Promise<AccountIdentity[]> {
    const response = await this.requestAuthorized('/v1/identities', { method: 'GET' })
    return (await response.json() as { identities: AccountIdentity[] }).identities
  }

  async linkGoogle(openExternal: (url: string) => Promise<unknown>): Promise<AccountIdentity[]> {
    const clientId = this.options.googleClientId?.trim()
    if (!clientId) throw new Error('Google 登录暂时不可用，请使用邮箱继续。')
    const authorization = await getGoogleAuthorizationCode({ clientId, openExternal })
    const response = await this.requestAuthorized('/v1/identities/google', {
      method: 'POST',
      body: JSON.stringify(authorization)
    })
    return (await response.json() as { identities: AccountIdentity[] }).identities
  }

  async unlinkGoogle(): Promise<AccountIdentity[]> {
    const response = await this.requestAuthorized('/v1/identities/google', { method: 'DELETE' })
    return (await response.json() as { identities: AccountIdentity[] }).identities
  }

  async listDevices(): Promise<AccountDeviceSummary[]> {
    const response = await this.requestAuthorized('/v1/devices', { method: 'GET' })
    const devices = (await response.json() as { devices: Array<Omit<AccountDeviceSummary, 'isCurrent'> & { isCurrent: boolean | number }> }).devices
    return devices.map((device) => ({ ...device, isCurrent: Boolean(device.isCurrent) }))
  }

  async listSyncSpaces(): Promise<import('../../shared/account').AccountSyncSpace[]> {
    const response = await this.requestAuthorized('/v1/sync-spaces', { method: 'GET' })
    return (await response.json() as { syncSpaces: import('../../shared/account').AccountSyncSpace[] }).syncSpaces
  }

  async registerProjectShare(localProjectId: string, executionHostId: string): Promise<import('../../shared/account').AccountProjectShare> {
    const response = await this.requestAuthorized('/v1/project-shares', {
      method: 'POST', body: JSON.stringify({ localProjectId, executionHostId })
    })
    return (await response.json() as { projectShare: import('../../shared/account').AccountProjectShare }).projectShare
  }

  async listProjectShares(): Promise<import('../../shared/account').AccountProjectShare[]> {
    const response = await this.requestAuthorized('/v1/project-shares', { method: 'GET' })
    return (await response.json() as { projectShares: import('../../shared/account').AccountProjectShare[] }).projectShares
  }

  async getProjectShare(projectId: string): Promise<import('../../shared/account').AccountProjectShare> {
    const response = await this.requestAuthorized(`/v1/project-shares/${encodeURIComponent(projectId)}`, { method: 'GET' })
    return (await response.json() as { projectShare: import('../../shared/account').AccountProjectShare }).projectShare
  }

  async registerProjectPublisher(projectId: string): Promise<string> {
    const response = await this.requestAuthorized(
      `/v1/project-shares/${encodeURIComponent(projectId)}/publishers/self`, { method: 'POST' }
    )
    return (await response.json() as { hostId: string }).hostId
  }

  async listProjectPublishers(projectId: string): Promise<Array<{
    hostId: string; sourceDeviceId: string; hostName: string; lastSeenAt: string
  }>> {
    const response = await this.requestAuthorized(
      `/v1/project-shares/${encodeURIComponent(projectId)}/publishers`, { method: 'GET' }
    )
    return (await response.json() as { publishers: Array<{
      hostId: string; sourceDeviceId: string; hostName: string; lastSeenAt: string
    }> }).publishers
  }

  async publishProjectEvent(
    projectId: string,
    event: import('../../shared/project-sharing-events').SharedProjectEventSubmission
  ): Promise<import('../../shared/project-sharing-events').SharedProjectEncryptedEvent> {
    const response = await this.requestAuthorized(`/v1/project-shares/${encodeURIComponent(projectId)}/events`, {
      method: 'POST', body: JSON.stringify(event)
    })
    return (await response.json() as {
      event: import('../../shared/project-sharing-events').SharedProjectEncryptedEvent
    }).event
  }

  async listProjectEvents(projectId: string, after = 0, limit = 100): Promise<{
    events: import('../../shared/project-sharing-events').SharedProjectEncryptedEvent[]
    nextCursor: number
  }> {
    const query = new URLSearchParams({ after: String(after), limit: String(limit) })
    const response = await this.requestAuthorized(
      `/v1/project-shares/${encodeURIComponent(projectId)}/events?${query}`, { method: 'GET' }
    )
    return await response.json() as {
      events: import('../../shared/project-sharing-events').SharedProjectEncryptedEvent[]
      nextCursor: number
    }
  }

  async uploadProjectAttachment(input: {
    projectId: string; attachmentId: string; runId: string; requestId: string | null
    kind: 'input' | 'artifact'; keyEpoch: number; ciphertext: Uint8Array
  }): Promise<void> {
    const hash = createHash('sha256').update(input.ciphertext).digest('hex')
    await this.requestAuthorized(
      `/v1/project-shares/${encodeURIComponent(input.projectId)}/attachments/${encodeURIComponent(input.attachmentId)}`,
      { method: 'PUT', headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(input.ciphertext.byteLength),
        'X-Content-SHA256': hash,
        'X-Project-Run-Id': input.runId,
        'X-Project-Request-Id': input.requestId ?? '',
        'X-Project-Attachment-Kind': input.kind,
        'X-Project-Key-Epoch': String(input.keyEpoch)
      }, body: Buffer.from(input.ciphertext), signal: AbortSignal.timeout(60_000) }
    )
  }

  async downloadProjectAttachment(projectId: string, attachmentId: string): Promise<{
    ciphertext: Uint8Array; runId: string; requestId: string | null
    kind: string; keyEpoch: number; uploadedByUserId: string
  }> {
    const response = await this.requestAuthorized(
      `/v1/project-shares/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: 'GET', signal: AbortSignal.timeout(60_000) }
    )
    const ciphertext = new Uint8Array(await response.arrayBuffer())
    const expectedHash = response.headers.get('X-Content-SHA256')
    if (!expectedHash || createHash('sha256').update(ciphertext).digest('hex') !== expectedHash) {
      throw new Error('共享附件传输校验失败。')
    }
    const runId = response.headers.get('X-Project-Run-Id')
    const kind = response.headers.get('X-Project-Attachment-Kind')
    const uploadedByUserId = response.headers.get('X-Uploaded-By-User-Id')
    const keyEpoch = Number(response.headers.get('X-Project-Key-Epoch'))
    if (!runId || !kind || !uploadedByUserId || !Number.isSafeInteger(keyEpoch)) {
      throw new Error('共享附件范围信息缺失。')
    }
    return { ciphertext, runId, requestId: response.headers.get('X-Project-Request-Id') || null,
      kind, keyEpoch, uploadedByUserId }
  }

  async beginProjectBaseline(projectId: string, baselineId: string,
    keyEpoch: number, chunkCount: number): Promise<import('../../shared/project-sharing-events').SharedProjectBaseline> {
    const response = await this.requestAuthorized(`/v1/project-shares/${encodeURIComponent(projectId)}/baselines`, {
      method: 'POST', body: JSON.stringify({ baselineId, keyEpoch, chunkCount })
    })
    return (await response.json() as {
      baseline: import('../../shared/project-sharing-events').SharedProjectBaseline
    }).baseline
  }

  async putProjectBaselineChunk(projectId: string,
    chunk: import('../../shared/project-sharing-events').SharedProjectBaselineChunk): Promise<void> {
    await this.requestAuthorized(
      `/v1/project-shares/${encodeURIComponent(projectId)}/baselines/${encodeURIComponent(chunk.baselineId)}/chunks`,
      { method: 'PUT', body: JSON.stringify({ index: chunk.index, envelope: chunk.envelope }) }
    )
  }

  async commitProjectBaseline(projectId: string, baselineId: string): Promise<void> {
    await this.requestAuthorized(
      `/v1/project-shares/${encodeURIComponent(projectId)}/baselines/${encodeURIComponent(baselineId)}/commit`,
      { method: 'POST' }
    )
  }

  async listProjectBaselines(projectId: string): Promise<import('../../shared/project-sharing-events').SharedProjectBaseline[]> {
    const response = await this.requestAuthorized(`/v1/project-shares/${encodeURIComponent(projectId)}/baselines`, {
      method: 'GET'
    })
    return (await response.json() as {
      baselines: import('../../shared/project-sharing-events').SharedProjectBaseline[]
    }).baselines
  }

  async listProjectBaselineChunks(projectId: string, baselineId: string,
    afterIndex = -1, limit = 100): Promise<{
      chunks: import('../../shared/project-sharing-events').SharedProjectBaselineChunk[]
      nextIndex: number
    }> {
    const query = new URLSearchParams({ after: String(afterIndex), limit: String(limit) })
    const response = await this.requestAuthorized(
      `/v1/project-shares/${encodeURIComponent(projectId)}/baselines/${encodeURIComponent(baselineId)}/chunks?${query}`,
      { method: 'GET' }
    )
    return await response.json() as {
      chunks: import('../../shared/project-sharing-events').SharedProjectBaselineChunk[]
      nextIndex: number
    }
  }

  async registerSharedChat(projectId: string, runId: string,
    createdByUserId: string | null): Promise<void> {
    await this.requestAuthorized(`/v1/project-shares/${encodeURIComponent(projectId)}/chats`, {
      method: 'POST', body: JSON.stringify({ runId, createdByUserId, visibility: 'published' })
    })
  }

  async heartbeatProjectHost(projectId: string): Promise<void> {
    await this.requestAuthorized(`/v1/project-shares/${encodeURIComponent(projectId)}/host-heartbeat`, {
      method: 'POST'
    })
  }

  async submitProjectCommand(projectId: string,
    submission: import('../../shared/project-sharing-commands').SharedProjectCommandSubmission
  ): Promise<import('../../shared/project-sharing-commands').SharedProjectCommand> {
    const response = await this.requestAuthorized(`/v1/project-shares/${encodeURIComponent(projectId)}/commands`, {
      method: 'POST', body: JSON.stringify(submission)
    })
    return (await response.json() as {
      command: import('../../shared/project-sharing-commands').SharedProjectCommand
    }).command
  }

  async listHostProjectCommands(projectId: string): Promise<import('../../shared/project-sharing-commands').SharedProjectCommand[]> {
    const response = await this.requestAuthorized(`/v1/project-shares/${encodeURIComponent(projectId)}/commands`, {
      method: 'GET'
    })
    return (await response.json() as {
      commands: import('../../shared/project-sharing-commands').SharedProjectCommand[]
    }).commands
  }

  async listOwnProjectCommands(projectId: string): Promise<import('../../shared/project-sharing-commands').SharedProjectCommand[]> {
    const response = await this.requestAuthorized(
      `/v1/project-shares/${encodeURIComponent(projectId)}/commands?mine=1`, { method: 'GET' }
    )
    return (await response.json() as {
      commands: import('../../shared/project-sharing-commands').SharedProjectCommand[]
    }).commands
  }

  async getProjectCommand(projectId: string, commandId: string): Promise<import('../../shared/project-sharing-commands').SharedProjectCommand> {
    const response = await this.requestAuthorized(
      `/v1/project-shares/${encodeURIComponent(projectId)}/commands/${encodeURIComponent(commandId)}`,
      { method: 'GET' }
    )
    return (await response.json() as {
      command: import('../../shared/project-sharing-commands').SharedProjectCommand
    }).command
  }

  async claimProjectCommand(projectId: string, commandId: string): Promise<import('../../shared/project-sharing-commands').SharedProjectCommand> {
    const response = await this.requestAuthorized(
      `/v1/project-shares/${encodeURIComponent(projectId)}/commands/${encodeURIComponent(commandId)}/claim`,
      { method: 'POST' }
    )
    return (await response.json() as {
      command: import('../../shared/project-sharing-commands').SharedProjectCommand
    }).command
  }

  async renewProjectCommand(projectId: string, commandId: string): Promise<string> {
    const response = await this.requestAuthorized(
      `/v1/project-shares/${encodeURIComponent(projectId)}/commands/${encodeURIComponent(commandId)}/renew`,
      { method: 'POST' }
    )
    return (await response.json() as { leaseExpiresAt: string }).leaseExpiresAt
  }

  async completeProjectCommand(projectId: string, commandId: string,
    result: { status: 'completed' | 'failed'; resultRunId: string | null; errorCode: string | null }
  ): Promise<void> {
    await this.requestAuthorized(
      `/v1/project-shares/${encodeURIComponent(projectId)}/commands/${encodeURIComponent(commandId)}/complete`,
      { method: 'POST', body: JSON.stringify(result) }
    )
  }

  async setProjectExecutionHost(projectId: string, executionHostId: string): Promise<import('../../shared/account').AccountProjectShare> {
    const response = await this.requestAuthorized(`/v1/project-shares/${encodeURIComponent(projectId)}/execution-host`, {
      method: 'POST', body: JSON.stringify({ executionHostId })
    })
    return (await response.json() as { projectShare: import('../../shared/account').AccountProjectShare }).projectShare
  }

  async createProjectInvitation(projectId: string, email: string): Promise<import('../../shared/account').AccountProjectInvitation> {
    const response = await this.requestAuthorized(`/v1/project-shares/${encodeURIComponent(projectId)}/invitations`, {
      method: 'POST', body: JSON.stringify({ email })
    })
    return (await response.json() as { invitation: import('../../shared/account').AccountProjectInvitation }).invitation
  }

  async listProjectInvitations(projectId: string): Promise<import('../../shared/account').AccountProjectInvitation[]> {
    const response = await this.requestAuthorized(`/v1/project-shares/${encodeURIComponent(projectId)}/invitations`, { method: 'GET' })
    return (await response.json() as { invitations: import('../../shared/account').AccountProjectInvitation[] }).invitations
  }

  async revokeProjectInvitation(projectId: string, invitationId: string): Promise<void> {
    await this.requestAuthorized(
      `/v1/project-shares/${encodeURIComponent(projectId)}/invitations/${encodeURIComponent(invitationId)}`,
      { method: 'DELETE' }
    )
  }

  async acceptProjectInvitation(token: string): Promise<string> {
    const response = await this.requestAuthorized('/v1/project-invitations/accept', {
      method: 'POST', body: JSON.stringify({ token })
    })
    return (await response.json() as { projectId: string }).projectId
  }

  async listProjectMembers(projectId: string): Promise<import('../../shared/account').AccountProjectMember[]> {
    const response = await this.requestAuthorized(`/v1/project-shares/${encodeURIComponent(projectId)}/members`, { method: 'GET' })
    return (await response.json() as { members: import('../../shared/account').AccountProjectMember[] }).members
  }

  async removeProjectMember(projectId: string, userId: string): Promise<void> {
    await this.requestAuthorized(
      `/v1/project-shares/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' }
    )
  }

  async closeProjectShare(projectId: string): Promise<void> {
    await this.requestAuthorized(`/v1/project-shares/${encodeURIComponent(projectId)}`, { method: 'DELETE' })
  }

  async requestProjectDeviceGrant(projectId: string): Promise<import('../../shared/account').AccountProjectDeviceGrant> {
    const response = await this.requestAuthorized(`/v1/project-shares/${encodeURIComponent(projectId)}/device-grant`, {
      method: 'POST'
    })
    return (await response.json() as { grant: import('../../shared/account').AccountProjectDeviceGrant }).grant
  }

  async getProjectDeviceGrant(projectId: string): Promise<import('../../shared/account').AccountProjectDeviceGrant> {
    const response = await this.requestAuthorized(`/v1/project-shares/${encodeURIComponent(projectId)}/device-grant`, {
      method: 'GET'
    })
    return (await response.json() as { grant: import('../../shared/account').AccountProjectDeviceGrant }).grant
  }

  async listPendingProjectDeviceGrants(projectId: string): Promise<import('../../shared/account').AccountPendingProjectDeviceGrant[]> {
    const response = await this.requestAuthorized(`/v1/project-shares/${encodeURIComponent(projectId)}/device-grants`, {
      method: 'GET'
    })
    return (await response.json() as { grants: import('../../shared/account').AccountPendingProjectDeviceGrant[] }).grants
  }

  async completeProjectDeviceGrant(projectId: string, grantId: string, wrappedProjectKey: string, keyEpoch: number): Promise<void> {
    await this.requestAuthorized(
      `/v1/project-shares/${encodeURIComponent(projectId)}/device-grants/${encodeURIComponent(grantId)}/complete`,
      { method: 'POST', body: JSON.stringify({ wrappedProjectKey, keyEpoch }) }
    )
  }

  wrapProjectGrant(input: {
    grantId: string
    projectId: string
    deviceId: string
    keyEpoch: number
    projectKey: string
    recipientPublicKey: string
  }): string {
    const identity = this.getDeviceInput()
    const privateKey = this.credentialVault.get(devicePrivateKeyReference)
    if (!privateKey) throw new Error('Mac 设备密钥不存在，请重新登录。')
    return wrapProjectDeviceGrant({
      ...input, senderPublicKey: identity.publicKey, senderPrivateKey: privateKey
    })
  }

  async openOwnProjectGrant(projectId: string): Promise<string | null> {
    const grant = await this.getProjectDeviceGrant(projectId)
    if (grant.status !== 'active' || !grant.wrappedProjectKey) return null
    const deviceId = this.getState().device?.id
    const privateKey = this.credentialVault.get(devicePrivateKeyReference)
    if (!deviceId || !privateKey) throw new Error('设备密钥不可用。')
    return openProjectDeviceGrant({
      wrappedGrant: grant.wrappedProjectKey, grantId: grant.id,
      projectId, deviceId, keyEpoch: grant.keyEpoch, recipientPrivateKey: privateKey
    })
  }

  async enrollMacPeer(spaceId: string, enrollmentId?: string): Promise<{ id: string; credentials: AccountRelayCredentials | null }> {
    const deviceId = this.getState().device?.id
    if (!deviceId) throw new Error('请先登录。')
    const root = `/v1/sync-spaces/${encodeURIComponent(spaceId)}/enrollments`
    const response = await this.requestAuthorized(enrollmentId ? `${root}/${encodeURIComponent(enrollmentId)}` : root,
      enrollmentId ? { method: 'GET' } : { method: 'POST', body: JSON.stringify({ deviceId }) })
    const { enrollment } = await response.json() as { enrollment: { id: string; status: string; wrappedSpaceKey?: string; expiresAt?: string } }
    if (enrollment.status === 'revoked' || (enrollment.status === 'pending' && enrollment.expiresAt && Date.parse(enrollment.expiresAt) < Date.now())) {
      throw new Error('Mac 连接授权已失效，请重试。')
    }
    if (enrollment.status !== 'active' || !enrollment.wrappedSpaceKey) return { id: enrollment.id, credentials: null }
    const privateKey = this.credentialVault.get(devicePrivateKeyReference)
    if (!privateKey) throw new Error('设备密钥不可用。')
    return { id: enrollment.id, credentials: openDeviceGrant({
      wrappedGrant: enrollment.wrappedSpaceKey, enrollmentId: enrollment.id, spaceId, deviceId, recipientPrivateKey: privateKey
    }) }
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const currentDeviceId = this.getState().device?.id
    await this.requestAuthorized(`/v1/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' })
    if (deviceId === currentDeviceId) this.clearLocalAuth('device_revoked')
  }

  async logoutAll(): Promise<AccountState> {
    await this.requestAuthorized('/v1/auth/logout-all', { method: 'POST' })
    this.clearLocalAuth('all_devices_logout')
    return this.getState()
  }

  setOnboardingStep(step: AccountOnboardingStep): AccountState {
    const current = this.getState()
    if (current.status !== 'signed-in') throw new Error('请先登录。')
    const onboarding: AccountOnboardingState = {
      step,
      completedAt: step === 'complete' ? new Date().toISOString() : null
    }
    this.database.setSetting(`${onboardingKeyPrefix}${current.user!.id}`, onboarding)
    return { ...current, onboarding }
  }

  async logout(): Promise<AccountState> {
    const generation = this.authGeneration
    if (this.credentialVault.get(accessTokenReference) && this.options.apiUrl) {
      try {
        await this.requestAuthorized('/v1/auth/logout', { method: 'POST' })
      } catch {
        // Local sign-out must remain available while the Account API is offline.
      }
    }
    if (this.authGeneration === generation) this.clearLocalAuth('user_logout')
    return this.getState()
  }

  async bindRelay(input: {
    spaceId: string
    relayUrl: string
    relayAccountId: string
    bindingProof: string
  }): Promise<void> {
    await this.requestAuthorized(`/v1/sync-spaces/${encodeURIComponent(input.spaceId)}/relay-binding`, {
      method: 'POST',
      body: JSON.stringify({
        relayUrl: input.relayUrl,
        relayAccountId: input.relayAccountId,
        bindingProof: input.bindingProof
      })
    })
  }

  async listPendingEnrollments(spaceId: string): Promise<AccountEnrollmentPage> {
    const response = await this.requestAuthorized(
      `/v1/sync-spaces/${encodeURIComponent(spaceId)}/enrollments`,
      { method: 'GET' }
    )
    return await response.json() as AccountEnrollmentPage
  }

  async completeEnrollment(input: {
    spaceId: string
    enrollmentId: string
    wrappedSpaceKey: string
    keyVersion: number
  }): Promise<void> {
    await this.requestAuthorized(
      `/v1/sync-spaces/${encodeURIComponent(input.spaceId)}/enrollments/${encodeURIComponent(input.enrollmentId)}/complete`,
      {
        method: 'POST',
        body: JSON.stringify({ wrappedSpaceKey: input.wrappedSpaceKey, keyVersion: input.keyVersion })
      }
    )
  }

  async completeRelayRevocation(input: { spaceId: string; enrollmentId: string }): Promise<void> {
    await this.requestAuthorized(
      `/v1/sync-spaces/${encodeURIComponent(input.spaceId)}/enrollments/${encodeURIComponent(input.enrollmentId)}/revocation-complete`,
      { method: 'POST' }
    )
  }

  wrapEnrollmentGrant(input: {
    enrollmentId: string
    spaceId: string
    deviceId: string
    recipientPublicKey: string
    credentials: AccountRelayCredentials
  }): string {
    const identity = this.getDeviceInput()
    const privateKey = this.credentialVault.get(devicePrivateKeyReference)
    if (!privateKey) throw new Error('Mac 设备密钥不存在，请重新登录。')
    return wrapDeviceGrant({
      ...input,
      senderPublicKey: identity.publicKey,
      senderPrivateKey: privateKey
    })
  }

  private getDeviceInput(): {
    id: string
    platform: 'macos'
    name: string
    publicKey: string
    appVersion: string
    protocolVersion: number
  } {
    let identity = this.database.getSetting<DeviceIdentity | null>(deviceIdentityKey, null)
    if (!identity || !this.credentialVault.get(devicePrivateKeyReference)) {
      const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      identity = {
        id: randomUUID(),
        publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
      }
      this.credentialVault.set(
        devicePrivateKeyReference,
        privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
      )
      this.database.setSetting(deviceIdentityKey, identity)
    }
    return {
      id: identity.id,
      platform: 'macos',
      name: this.options.deviceName?.trim() || hostname() || '我的 Mac',
      publicKey: identity.publicKey,
      appVersion: this.options.appVersion,
      protocolVersion: companionProtocol.currentVersion
    }
  }

  private persistAuth(payload: AuthPayload): void {
    this.authGeneration += 1
    this.persistSession(payload.session)
    this.database.setSetting<CachedAccount>(cachedAccountKey, {
      user: payload.user,
      device: payload.device,
      accessExpiresAt: payload.session.accessExpiresAt,
      refreshExpiresAt: payload.session.refreshExpiresAt
    })
  }

  private persistSession(session: SessionPayload): void {
    this.credentialVault.set(accessTokenReference, session.accessToken)
    this.credentialVault.set(refreshTokenReference, session.refreshToken)
    const cached = this.database.getSetting<CachedAccount | null>(cachedAccountKey, null)
    if (cached) {
      this.database.setSetting<CachedAccount>(cachedAccountKey, {
        ...cached,
        accessExpiresAt: session.accessExpiresAt,
        refreshExpiresAt: session.refreshExpiresAt
      })
    }
  }

  private clearLocalAuth(reason: SignOutReason, serverCode?: string): void {
    this.authGeneration += 1
    const cached = this.database.getSetting<CachedAccount | null>(cachedAccountKey, null)
    if (cached?.user.id) {
      this.credentialVault.deleteByPrefix(`project-sharing.key:${cached.user.id}:`)
    }
    this.credentialVault.delete(accessTokenReference)
    this.credentialVault.delete(refreshTokenReference)
    this.database.setSetting<CachedAccount | null>(cachedAccountKey, null)
    // Keep only a fixed reason/code and timestamp; never persist tokens or raw responses.
    const knownCodes = ['refresh_token_expired', 'refresh_token_reused', 'invalid_session', 'session_expired', 'device_revoked']
    this.database.setSetting<SignOutDiagnostic>(lastSignOutKey, {
      reason,
      occurredAt: new Date().toISOString(),
      serverCode: serverCode && knownCodes.includes(serverCode) ? serverCode : null
    })
    this.options.onSignedOut?.(this.signedOutState(
      reason === 'user_logout' || reason === 'all_devices_logout' ? null : '登录状态已失效，请重新登录。'
    ))
  }

  private signedOutState(serviceMessage: string | null): AccountState {
    return {
      status: 'signed-out',
      serviceStatus: this.options.apiUrl ? 'ready' : 'configuration-required',
      serviceMessage,
      user: null,
      device: null,
      onboarding: null,
      availableProviders: { email: true, google: Boolean(this.options.googleClientId) },
      existingProjectCount: this.database.listProjects().length
    }
  }

  private async request(path: string, init: RequestInit, accessToken?: string): Promise<Response> {
    return this.assertResponse(await this.fetchResponse(path, init, accessToken))
  }

  private async requestAuthorized(path: string, init: RequestInit): Promise<Response> {
    const generation = this.authGeneration
    let accessToken = this.credentialVault.get(accessTokenReference)
    if (!accessToken) throw new Error('请先登录。')
    let response = await this.fetchResponse(path, init, accessToken)
    if (this.authGeneration !== generation) throw new Error('账户已切换，请重试。')
    if (response.status === 401) {
      await this.refreshAuthorization(accessToken)
      if (this.authGeneration !== generation) throw new Error('账户已切换，请重试。')
      accessToken = this.credentialVault.get(accessTokenReference)
      if (!accessToken) throw new AccountAuthorizationLostError()
      response = await this.fetchResponse(path, init, accessToken)
      if (this.authGeneration !== generation) throw new Error('账户已切换，请重试。')
      if (response.status === 401) {
        if (this.credentialVault.get(accessTokenReference) === accessToken) {
          this.clearLocalAuth('access_rejected_after_refresh')
          throw new AccountAuthorizationLostError()
        }
        throw new Error('账户已切换，请重试。')
      }
    }
    return this.assertResponse(response)
  }

  private async refreshAuthorization(rejectedAccessToken?: string): Promise<void> {
    if (
      rejectedAccessToken
      && this.credentialVault.get(accessTokenReference) !== rejectedAccessToken
    ) return
    const generation = this.authGeneration
    if (this.refreshInFlight?.generation === generation) return this.refreshInFlight.promise
    const refreshToken = this.credentialVault.get(refreshTokenReference)
    if (!refreshToken) {
      this.clearLocalAuth('missing_refresh_token')
      throw new AccountAuthorizationLostError()
    }
    const promise = (async () => {
      let response: Response
      try {
        response = await this.request('/v1/auth/refresh', {
          method: 'POST',
          body: JSON.stringify({ refreshToken })
        })
      } catch (error) {
        if (error instanceof AccountRequestError && error.status === 401) {
          if (
            this.authGeneration === generation
            && this.credentialVault.get(refreshTokenReference) === refreshToken
          ) {
            this.clearLocalAuth('refresh_rejected', error.code)
            throw new AccountAuthorizationLostError()
          }
          throw new Error('账户已切换，请重试。')
        }
        throw error
      }
      const payload = await response.json() as { session: SessionPayload }
      if (
        this.authGeneration !== generation
        || this.credentialVault.get(refreshTokenReference) !== refreshToken
      ) return
      this.persistSession(payload.session)
    })()
    const flight = { generation, promise }
    this.refreshInFlight = flight
    try {
      await promise
    } finally {
      if (this.refreshInFlight === flight) this.refreshInFlight = null
    }
  }

  private async fetchResponse(path: string, init: RequestInit, accessToken?: string): Promise<Response> {
    if (!this.options.apiUrl) throw new Error('暂时无法登录，请稍后再试。')
    const headers = new Headers(init.headers)
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
    if (path.startsWith('/v1/project-shares') || path === '/v1/project-invitations/accept') {
      headers.set('X-Fuddy-Project-Sharing-Version', String(projectSharingProtocolVersion))
    }
    if (accessToken) headers.set('authorization', `Bearer ${accessToken}`)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.options.apiUrl}${path}`, {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(8_000)
      })
    } catch {
      throw new Error('暂时无法登录，请检查网络后重试。')
    }
    return response
  }

  private async assertResponse(response: Response): Promise<Response> {
    if (!response.ok) {
      let body: AccountApiErrorBody | null = null
      try {
        body = await response.json() as AccountApiErrorBody
      } catch {
        // Preserve the stable fallback below when an upstream returns non-JSON.
      }
      throw new AccountRequestError(
        response.status,
        body?.error?.code,
        body?.error?.message || '操作没有完成，请稍后重试。'
      )
    }
    return response
  }
}
