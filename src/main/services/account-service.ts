import { generateKeyPairSync, randomUUID } from 'node:crypto'
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
import type { FuddyRuntimeChannel } from '../runtime-profile'
import type { CredentialVault } from './credential-vault'
import type { AppDatabase } from './database'
import { getGoogleIdToken } from './google-desktop-oauth'
import {
  wrapDeviceGrant,
  type AccountRelayCredentials
} from './account-device-grant'

const accessTokenReference = 'account.access-token'
const refreshTokenReference = 'account.refresh-token'
const devicePrivateKeyReference = 'account.device-private-key'
const cachedAccountKey = 'account.cached-state'
const onboardingKeyPrefix = 'account.onboarding-state:'
const deviceIdentityKey = 'account.device-identity'

type CredentialStore = Pick<CredentialVault, 'get' | 'set' | 'delete'>

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

class AccountRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string
  ) {
    super(message)
  }
}

export interface AccountServiceOptions {
  apiUrl: string | null
  runtimeChannel: FuddyRuntimeChannel
  appVersion: string
  deviceName?: string
  googleClientId?: string | null
  fetch?: typeof globalThis.fetch
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
  private refreshInFlight: Promise<void> | null = null

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
      this.clearLocalAuth()
      return this.signedOutState('登录状态已过期，请重新登录。')
    }
    if (!cached || !this.credentialVault.get(refreshTokenReference)) {
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
    const accessToken = this.credentialVault.get(accessTokenReference)
    if (!accessToken || !this.credentialVault.get(refreshTokenReference)) return this.signedOutState(null)
    try {
      const current = await this.fetchImpl(`${this.options.apiUrl}/v1/me`, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8_000)
      })
      if (current.ok) return local
      if (current.status !== 401) return { ...local, serviceStatus: 'offline', serviceMessage: '账户服务暂时不可用。' }
      await this.refreshAuthorization(accessToken)
      return this.getState()
    } catch {
      if (this.getState().status === 'signed-out') {
        return this.signedOutState('登录状态已失效，请重新登录。')
      }
      return { ...local, serviceStatus: 'offline', serviceMessage: '当前离线，仍可使用这台 Mac 上的项目。' }
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

  async signInWithGoogle(openExternal: (url: string) => Promise<unknown>): Promise<AccountState> {
    const clientId = this.options.googleClientId?.trim()
    if (!clientId) throw new Error('Google 登录尚未配置。')
    const idToken = await getGoogleIdToken({ clientId, openExternal, fetch: this.fetchImpl })
    return this.acceptGoogleIdToken(idToken)
  }

  async listIdentities(): Promise<AccountIdentity[]> {
    const response = await this.requestAuthorized('/v1/identities', { method: 'GET' })
    return (await response.json() as { identities: AccountIdentity[] }).identities
  }

  async linkGoogle(openExternal: (url: string) => Promise<unknown>): Promise<AccountIdentity[]> {
    const clientId = this.options.googleClientId?.trim()
    if (!clientId) throw new Error('Google 登录尚未配置。')
    const idToken = await getGoogleIdToken({ clientId, openExternal, fetch: this.fetchImpl })
    const response = await this.requestAuthorized('/v1/identities/google', {
      method: 'POST',
      body: JSON.stringify({ idToken })
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

  async revokeDevice(deviceId: string): Promise<void> {
    const currentDeviceId = this.getState().device?.id
    await this.requestAuthorized(`/v1/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' })
    if (deviceId === currentDeviceId) this.clearLocalAuth()
  }

  async logoutAll(): Promise<AccountState> {
    await this.requestAuthorized('/v1/auth/logout-all', { method: 'POST' })
    this.clearLocalAuth()
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
    const accessToken = this.credentialVault.get(accessTokenReference)
    if (accessToken && this.options.apiUrl) {
      try {
        await this.request('/v1/auth/logout', { method: 'POST' }, accessToken)
      } catch {
        // Local sign-out must remain available while the Account API is offline.
      }
    }
    this.clearLocalAuth()
    return this.getState()
  }

  async bindRelay(input: { spaceId: string; relayUrl: string; relayAccountId: string }): Promise<void> {
    await this.requestAuthorized(`/v1/sync-spaces/${encodeURIComponent(input.spaceId)}/relay-binding`, {
      method: 'POST',
      body: JSON.stringify({ relayUrl: input.relayUrl, relayAccountId: input.relayAccountId })
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

  private clearLocalAuth(): void {
    this.credentialVault.delete(accessTokenReference)
    this.credentialVault.delete(refreshTokenReference)
    this.database.setSetting<CachedAccount | null>(cachedAccountKey, null)
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
    let accessToken = this.credentialVault.get(accessTokenReference)
    if (!accessToken) throw new Error('请先登录。')
    let response = await this.fetchResponse(path, init, accessToken)
    if (response.status === 401) {
      await this.refreshAuthorization(accessToken)
      accessToken = this.credentialVault.get(accessTokenReference)
      if (!accessToken) throw new Error('登录状态已失效，请重新登录。')
      response = await this.fetchResponse(path, init, accessToken)
      if (response.status === 401) {
        this.clearLocalAuth()
        throw new Error('登录状态已失效，请重新登录。')
      }
    }
    return this.assertResponse(response)
  }

  private async refreshAuthorization(rejectedAccessToken?: string): Promise<void> {
    if (
      rejectedAccessToken
      && this.credentialVault.get(accessTokenReference) !== rejectedAccessToken
    ) return
    if (this.refreshInFlight) return this.refreshInFlight
    this.refreshInFlight = (async () => {
      const refreshToken = this.credentialVault.get(refreshTokenReference)
      if (!refreshToken) throw new Error('登录状态已失效，请重新登录。')
      let response: Response
      try {
        response = await this.request('/v1/auth/refresh', {
          method: 'POST',
          body: JSON.stringify({ refreshToken })
        })
      } catch (error) {
        if (error instanceof AccountRequestError && error.status === 401) {
          this.clearLocalAuth()
          throw new Error('登录状态已失效，请重新登录。')
        }
        throw error
      }
      const payload = await response.json() as { session: SessionPayload }
      this.persistSession(payload.session)
    })()
    try {
      await this.refreshInFlight
    } finally {
      this.refreshInFlight = null
    }
  }

  private async fetchResponse(path: string, init: RequestInit, accessToken?: string): Promise<Response> {
    if (!this.options.apiUrl) throw new Error('Account API 尚未配置。')
    const headers = new Headers(init.headers)
    headers.set('content-type', 'application/json')
    if (accessToken) headers.set('authorization', `Bearer ${accessToken}`)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.options.apiUrl}${path}`, {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(8_000)
      })
    } catch {
      throw new Error('无法连接 Fuddy 账户服务，请检查网络后重试。')
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
        body?.error?.message || `账户服务请求失败（${response.status}）。`
      )
    }
    return response
  }
}
