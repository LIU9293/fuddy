import { describe, expect, it } from 'vitest'
import type { AccountOnboardingState } from '../../shared/account'
import { AccountAuthorizationLostError, AccountService, normalizeAccountApiUrl } from './account-service'

class FakeDatabase {
  private readonly values = new Map<string, unknown>()
  getSetting<T>(key: string, fallback: T): T {
    return (this.values.has(key) ? this.values.get(key) : fallback) as T
  }
  setSetting<T>(key: string, value: T): void {
    this.values.set(key, value)
  }
  listProjects(): unknown[] { return [] }
}

class FakeVault {
  private readonly values = new Map<string, string>()
  get(key: string): string | null { return this.values.get(key) ?? null }
  set(key: string, value: string): void { this.values.set(key, value) }
  delete(key: string): void { this.values.delete(key) }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('AccountService', () => {
  it('requires HTTPS outside local development', () => {
    expect(normalizeAccountApiUrl('https://fuddy.ai/api/account/', 'production')).toBe('https://fuddy.ai/api/account')
    expect(normalizeAccountApiUrl('http://accounts.fuddy.app', 'production')).toBeNull()
    expect(normalizeAccountApiUrl('http://127.0.0.1:8788', 'development')).toBe('http://127.0.0.1:8788')
    expect(normalizeAccountApiUrl('https://user:secret@accounts.fuddy.app', 'production')).toBeNull()
    expect(normalizeAccountApiUrl('https://fuddy.ai/api/account?target=other', 'production')).toBeNull()
  })

  it('persists tokens in the credential vault and keeps onboarding after an offline restart', async () => {
    const database = new FakeDatabase()
    const vault = new FakeVault()
    const service = new AccountService(database as never, vault, {
      apiUrl: 'https://account.test',
      runtimeChannel: 'development',
      appVersion: '0.0.3',
      deviceName: 'Test Mac',
      fetch: async (url, init) => {
        if (String(url).endsWith('/v1/auth/email/start')) {
          return response({ challengeId: 'challenge', expiresAt: '2026-08-19T01:00:00.000Z', retryAfterSeconds: 60 })
        }
        const body = JSON.parse(String(init?.body)) as { device: { protocolVersion: number } }
        expect(body.device.protocolVersion).toBe(4)
        return response({
          user: { id: 'user-1', email: 'kai@example.com', displayName: null },
          device: { id: 'device-1', platform: 'macos', name: 'Test Mac', hostId: 'host-1', syncSpaceId: 'space-1' },
          session: { accessToken: 'access', refreshToken: 'refresh', accessExpiresAt: '', refreshExpiresAt: '' }
        })
      }
    })

    const challenge = await service.startEmailSignIn(' KAI@example.com ')
    expect(challenge.email).toBe('kai@example.com')
    const signedIn = await service.verifyEmailSignIn('challenge', '123456')
    expect(signedIn.status).toBe('signed-in')
    expect(signedIn.onboarding?.step).toBe('detect-agent')
    expect(vault.get('account.refresh-token')).toBe('refresh')

    service.setOnboardingStep('complete')
    const offline = new AccountService(database as never, vault, {
      apiUrl: null,
      runtimeChannel: 'development',
      appVersion: '0.0.3'
    }).getState()
    expect(offline.serviceStatus).toBe('offline')
    expect((offline.onboarding as AccountOnboardingState).completedAt).toBeTruthy()
  })

  it('allows local sign-out while the server is unavailable', async () => {
    const database = new FakeDatabase()
    const vault = new FakeVault()
    database.setSetting('account.cached-state', {
      user: { id: 'user-1', email: 'kai@example.com', displayName: null },
      device: { id: 'device-1', platform: 'macos', name: 'Mac', hostId: null, syncSpaceId: null }
    })
    vault.set('account.refresh-token', 'refresh')
    vault.set('account.access-token', 'access')
    const service = new AccountService(database as never, vault, {
      apiUrl: 'https://account.test',
      runtimeChannel: 'development',
      appVersion: '0.0.3',
      fetch: async () => { throw new Error('offline') }
    })
    await expect(service.logout()).resolves.toMatchObject({ status: 'signed-out' })
    expect(vault.get('account.refresh-token')).toBeNull()
  })

  it('refreshes an expired access token before signing out on the server', async () => {
    const database = new FakeDatabase()
    const vault = new FakeVault()
    database.setSetting('account.cached-state', {
      user: { id: 'user-1', email: 'kai@example.com', displayName: null },
      device: { id: 'device-1', platform: 'macos', name: 'Mac', hostId: 'host-1', syncSpaceId: 'space-1' },
      refreshExpiresAt: '2099-08-19T00:00:00.000Z'
    })
    vault.set('account.refresh-token', 'valid-refresh')
    vault.set('account.access-token', 'expired-access')
    const observations: string[] = []
    const service = new AccountService(database as never, vault, {
      apiUrl: 'https://account.test',
      runtimeChannel: 'development',
      appVersion: '0.0.3',
      fetch: async (url, init) => {
        const path = new URL(String(url)).pathname
        const authorization = new Headers(init?.headers).get('authorization') ?? ''
        observations.push(`${path}|${authorization}`)
        if (path === '/v1/auth/logout' && authorization === 'Bearer expired-access') {
          return response({ error: { code: 'session_expired', message: 'expired' } }, 401)
        }
        if (path === '/v1/auth/refresh') {
          return response({ session: {
            accessToken: 'fresh-access',
            refreshToken: 'fresh-refresh',
            accessExpiresAt: '2099-08-19T00:15:00.000Z',
            refreshExpiresAt: '2099-09-18T00:00:00.000Z'
          } })
        }
        if (path === '/v1/auth/logout' && authorization === 'Bearer fresh-access') {
          return new Response(null, { status: 204 })
        }
        return response({}, 500)
      }
    })

    await expect(service.logout()).resolves.toMatchObject({ status: 'signed-out' })
    expect(observations).toEqual([
      '/v1/auth/logout|Bearer expired-access',
      '/v1/auth/refresh|',
      '/v1/auth/logout|Bearer fresh-access'
    ])
    expect(vault.get('account.refresh-token')).toBeNull()
  })

  it('completes the removed phone onboarding step for upgrading accounts', () => {
    const database = new FakeDatabase()
    const vault = new FakeVault()
    database.setSetting('account.cached-state', {
      user: { id: 'user-1', email: 'kai@example.com', displayName: null },
      device: { id: 'device-1', platform: 'macos', name: 'Mac', hostId: 'host-1', syncSpaceId: 'space-1' }
    })
    database.setSetting('account.onboarding-state:user-1', { step: 'connect-phone', completedAt: null })
    vault.set('account.refresh-token', 'refresh')

    const state = new AccountService(database as never, vault, {
      apiUrl: 'https://account.test',
      runtimeChannel: 'development',
      appVersion: '0.0.3'
    }).getState()

    expect(state.onboarding?.step).toBe('complete')
    expect(state.onboarding?.completedAt).toBeTruthy()
    expect(database.getSetting('account.onboarding-state:user-1', null)).toMatchObject({ step: 'complete' })
  })

  it('keeps completed onboarding for the same account without leaking it to another account', async () => {
    const database = new FakeDatabase()
    const vault = new FakeVault()
    let userId = 'user-1'
    const service = new AccountService(database as never, vault, {
      apiUrl: 'https://account.test',
      runtimeChannel: 'development',
      appVersion: '0.0.3',
      fetch: async (url) => String(url).endsWith('/v1/auth/logout')
        ? new Response(null, { status: 204 })
        : response({
            user: { id: userId, email: `${userId}@example.com`, displayName: null },
            device: { id: `device-${userId}`, platform: 'macos', name: 'Mac', hostId: null, syncSpaceId: null },
            session: { accessToken: 'access', refreshToken: 'refresh', accessExpiresAt: '', refreshExpiresAt: '' }
          })
    })

    await service.verifyEmailSignIn('challenge', '123456')
    service.setOnboardingStep('complete')
    await service.logout()
    expect((await service.verifyEmailSignIn('challenge', '123456')).onboarding?.step).toBe('complete')

    await service.logout()
    userId = 'user-2'
    expect((await service.verifyEmailSignIn('challenge', '123456')).onboarding?.step).toBe('detect-agent')
  })

  it('rotates an expired access token before returning the startup state', async () => {
    const database = new FakeDatabase()
    const vault = new FakeVault()
    database.setSetting('account.cached-state', {
      user: { id: 'user-1', email: 'kai@example.com', displayName: null },
      device: { id: 'device-1', platform: 'macos', name: 'Mac', hostId: 'host-1', syncSpaceId: 'space-1' },
      accessExpiresAt: '2026-08-19T00:00:00.000Z',
      refreshExpiresAt: '2099-08-19T00:00:00.000Z'
    })
    vault.set('account.refresh-token', 'old-refresh')
    vault.set('account.access-token', 'old-access')
    const service = new AccountService(database as never, vault, {
      apiUrl: 'https://account.test',
      runtimeChannel: 'development',
      appVersion: '0.0.3',
      fetch: async (url) => String(url).endsWith('/v1/me')
        ? response({}, 401)
        : response({ session: {
            accessToken: 'new-access',
            refreshToken: 'new-refresh',
            accessExpiresAt: '2099-08-19T00:15:00.000Z',
            refreshExpiresAt: '2099-09-18T00:00:00.000Z'
          } })
    })

    await expect(service.getValidatedState()).resolves.toMatchObject({ status: 'signed-in', serviceStatus: 'ready' })
    expect(vault.get('account.access-token')).toBe('new-access')
    expect(vault.get('account.refresh-token')).toBe('new-refresh')
  })

  it('coalesces validation refreshes that overlap another authorized request', async () => {
    const database = new FakeDatabase()
    const vault = new FakeVault()
    database.setSetting('account.cached-state', {
      user: { id: 'user-1', email: 'kai@example.com', displayName: null },
      device: { id: 'device-1', platform: 'macos', name: 'Mac', hostId: 'host-1', syncSpaceId: 'space-1' },
      refreshExpiresAt: '2099-08-19T00:00:00.000Z'
    })
    vault.set('account.refresh-token', 'old-refresh')
    vault.set('account.access-token', 'old-access')
    let identityCalls = 0
    let refreshCalls = 0
    let releaseRefresh = (): void => undefined
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve })
    const service = new AccountService(database as never, vault, {
      apiUrl: 'https://account.test',
      runtimeChannel: 'development',
      appVersion: '0.0.3',
      fetch: async (url, init) => {
        if (String(url).endsWith('/v1/me')) {
          return response({}, 401)
        }
        if (String(url).endsWith('/v1/auth/refresh')) {
          refreshCalls += 1
          await refreshGate
          return response({ session: {
            accessToken: 'new-access',
            refreshToken: 'new-refresh',
            accessExpiresAt: '2099-08-19T00:15:00.000Z',
            refreshExpiresAt: '2099-09-18T00:00:00.000Z'
          } })
        }
        identityCalls += 1
        return new Headers(init?.headers).get('authorization') === 'Bearer old-access'
          ? response({}, 401)
          : response({ identities: [] })
      }
    })

    const validation = service.getValidatedState()
    while (refreshCalls < 1) await new Promise((resolve) => setTimeout(resolve, 0))
    const authorized = service.listIdentities()
    while (identityCalls < 1) await new Promise((resolve) => setTimeout(resolve, 0))
    releaseRefresh()

    await expect(Promise.all([validation, authorized])).resolves.toMatchObject([
      { status: 'signed-in' },
      []
    ])
    expect(refreshCalls).toBe(1)
    expect(vault.get('account.refresh-token')).toBe('new-refresh')
  })

  it('discards an old refresh after signing out and into another account', async () => {
    const database = new FakeDatabase()
    const vault = new FakeVault()
    database.setSetting('account.cached-state', {
      user: { id: 'user-1', email: 'first@example.com', displayName: null },
      device: { id: 'device-1', platform: 'macos', name: 'Mac', hostId: 'host-1', syncSpaceId: 'space-1' },
      refreshExpiresAt: '2099-08-19T00:00:00.000Z'
    })
    vault.set('account.refresh-token', 'refresh-1')
    vault.set('account.access-token', 'access-1')
    let releaseRefresh = (): void => undefined
    let refreshStarted = false
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve })
    const service = new AccountService(database as never, vault, {
      apiUrl: 'https://account.test',
      runtimeChannel: 'development',
      appVersion: '0.0.3',
      fetch: async (url) => {
        const path = new URL(String(url)).pathname
        if (path === '/v1/me') return response({}, 401)
        if (path === '/v1/auth/refresh') {
          refreshStarted = true
          await refreshGate
          return response({ session: {
            accessToken: 'late-access-1',
            refreshToken: 'late-refresh-1',
            accessExpiresAt: '2099-08-19T00:15:00.000Z',
            refreshExpiresAt: '2099-09-18T00:00:00.000Z'
          } })
        }
        if (path === '/v1/auth/logout') return new Response(null, { status: 204 })
        if (path === '/v1/auth/email/verify') {
          return response({
            user: { id: 'user-2', email: 'second@example.com', displayName: null },
            device: { id: 'device-2', platform: 'macos', name: 'Mac', hostId: 'host-2', syncSpaceId: 'space-2' },
            session: {
              accessToken: 'access-2',
              refreshToken: 'refresh-2',
              accessExpiresAt: '2099-08-19T00:15:00.000Z',
              refreshExpiresAt: '2099-09-18T00:00:00.000Z'
            }
          })
        }
        return response({}, 404)
      }
    })

    const staleValidation = service.getValidatedState()
    while (!refreshStarted) await new Promise((resolve) => setTimeout(resolve, 0))
    await service.logout()
    await service.verifyEmailSignIn('challenge-2', '123456')
    releaseRefresh()

    await expect(staleValidation).resolves.toMatchObject({ user: { id: 'user-2' } })
    expect(service.getState()).toMatchObject({ user: { id: 'user-2' } })
    expect(vault.get('account.access-token')).toBe('access-2')
    expect(vault.get('account.refresh-token')).toBe('refresh-2')
  })

  it('lists linked identities and normalizes the current-device marker', async () => {
    const database = new FakeDatabase()
    const vault = new FakeVault()
    database.setSetting('account.cached-state', {
      user: { id: 'user-1', email: 'kai@example.com', displayName: null },
      device: { id: 'device-1', platform: 'macos', name: 'Mac', hostId: 'host-1', syncSpaceId: 'space-1' },
      refreshExpiresAt: '2099-08-19T00:00:00.000Z'
    })
    vault.set('account.refresh-token', 'refresh')
    vault.set('account.access-token', 'access')
    const service = new AccountService(database as never, vault, {
      apiUrl: 'https://account.test',
      runtimeChannel: 'development',
      appVersion: '0.0.3',
      fetch: async (url) => String(url).endsWith('/v1/identities')
        ? response({ identities: [{
            provider: 'email', email: 'kai@example.com', createdAt: '2026-08-19T00:00:00.000Z', lastUsedAt: '2026-08-19T00:00:00.000Z'
          }] })
        : response({ devices: [{
            id: 'device-1', platform: 'macos', name: 'Mac', appVersion: '0.0.3', protocolVersion: 1,
            createdAt: '2026-08-19T00:00:00.000Z', lastSeenAt: '2026-08-19T00:00:00.000Z', isCurrent: 1
          }] })
    })

    await expect(service.listIdentities()).resolves.toMatchObject([{ provider: 'email' }])
    await expect(service.listDevices()).resolves.toMatchObject([{ id: 'device-1', isCurrent: true }])
  })

  it('clears local credentials after signing out every device', async () => {
    const database = new FakeDatabase()
    const vault = new FakeVault()
    database.setSetting('account.cached-state', {
      user: { id: 'user-1', email: 'kai@example.com', displayName: null },
      device: { id: 'device-1', platform: 'macos', name: 'Mac', hostId: 'host-1', syncSpaceId: 'space-1' },
      refreshExpiresAt: '2099-08-19T00:00:00.000Z'
    })
    vault.set('account.refresh-token', 'refresh')
    vault.set('account.access-token', 'access')
    const service = new AccountService(database as never, vault, {
      apiUrl: 'https://account.test',
      runtimeChannel: 'development',
      appVersion: '0.0.3',
      fetch: async () => new Response(null, { status: 204 })
    })

    await expect(service.logoutAll()).resolves.toMatchObject({ status: 'signed-out' })
    expect(vault.get('account.access-token')).toBeNull()
    expect(vault.get('account.refresh-token')).toBeNull()
  })

  it('clears a stale local session when refresh is rejected', async () => {
    const database = new FakeDatabase()
    const vault = new FakeVault()
    database.setSetting('account.cached-state', {
      user: { id: 'user-1', email: 'kai@example.com', displayName: null },
      device: { id: 'device-1', platform: 'macos', name: 'Mac', hostId: 'host-1', syncSpaceId: 'space-1' },
      refreshExpiresAt: '2099-08-19T00:00:00.000Z'
    })
    vault.set('account.refresh-token', 'revoked-refresh')
    vault.set('account.access-token', 'expired-access')
    const service = new AccountService(database as never, vault, {
      apiUrl: 'https://account.test',
      runtimeChannel: 'development',
      appVersion: '0.0.3',
      fetch: async (url) => String(url).endsWith('/v1/auth/refresh')
        ? response({ error: { code: 'invalid_session', message: '登录已失效。' } }, 401)
        : response({}, 401)
    })

    await expect(service.listDevices()).rejects.toBeInstanceOf(AccountAuthorizationLostError)
    expect(service.getState().status).toBe('signed-out')
    expect(vault.get('account.refresh-token')).toBeNull()
  })
})
