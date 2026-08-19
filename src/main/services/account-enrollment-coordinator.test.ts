import { describe, expect, it, vi } from 'vitest'
import { AccountEnrollmentCoordinator, resolveCompanionRelayUrl } from './account-enrollment-coordinator'
import { AccountAuthorizationLostError, AccountRequestError, type AccountService } from './account-service'
import type { CompanionSyncService } from './companion-sync'

describe('AccountEnrollmentCoordinator', () => {
  it('binds the host Relay and completes every pending iPhone grant', async () => {
    const account = {
      getState: vi.fn(() => ({
        status: 'signed-in',
        user: { id: 'user-1' },
        device: { syncSpaceId: 'space-1' }
      })),
      bindRelay: vi.fn(),
      listPendingEnrollments: vi.fn(async () => ({
        syncSpace: {
          id: 'space-1',
          keyVersion: 2,
          relayUrl: 'https://relay.example.com',
          relayAccountId: 'relay-account'
        },
        revocations: [{ id: 'revoked-grant', deviceId: 'removed-phone' }],
        enrollments: [{
          id: 'grant-1',
          spaceId: 'space-1',
          deviceId: 'phone-1',
          deviceName: 'Kai 的 iPhone',
          publicKey: 'phone-public-key',
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        }]
      })),
      wrapEnrollmentGrant: vi.fn(() => 'opaque-grant'),
      completeEnrollment: vi.fn(),
      completeRelayRevocation: vi.fn()
    } as unknown as AccountService
    const companion = {
      ensureAccountRelay: vi.fn(async () => ({
        relayUrl: 'https://relay.example.com',
        relayAccountId: 'relay-account'
      })),
      isAccountRelayBindingConfirmed: vi.fn(() => false),
      confirmAccountRelayBinding: vi.fn(),
      start: vi.fn(),
      enrollAccountDevice: vi.fn(async () => ({
        relayURL: 'https://relay.example.com',
        accountID: 'relay-account',
        deviceID: 'phone-1',
        deviceToken: 'secret',
        encryptionKey: 'data-key',
        encryptionKeyId: 'key-id'
      })),
      revokeAccountDevice: vi.fn()
    } as unknown as CompanionSyncService

    await new AccountEnrollmentCoordinator(account, companion, 'https://relay.example.com').processOnce()

    expect(companion.ensureAccountRelay).toHaveBeenCalledWith(
      'https://relay.example.com',
      undefined,
      'space-1',
      'user-1'
    )
    expect(account.bindRelay).toHaveBeenCalledWith({
      spaceId: 'space-1',
      relayUrl: 'https://relay.example.com',
      relayAccountId: 'relay-account'
    })
    expect(account.bindRelay).toHaveBeenCalledBefore(companion.start as ReturnType<typeof vi.fn>)
    expect(companion.confirmAccountRelayBinding).toHaveBeenCalledWith({
      ownerUserId: 'user-1',
      syncSpaceId: 'space-1',
      relayUrl: 'https://relay.example.com',
      relayAccountId: 'relay-account'
    })
    expect(companion.start).toHaveBeenCalledOnce()
    expect(companion.revokeAccountDevice).toHaveBeenCalledWith('removed-phone', 'revoked-grant')
    expect(account.completeRelayRevocation).toHaveBeenCalledWith({
      spaceId: 'space-1',
      enrollmentId: 'revoked-grant'
    })
    expect(companion.enrollAccountDevice).toHaveBeenCalledWith({
      deviceId: 'phone-1',
      deviceName: 'Kai 的 iPhone',
      publicKey: 'phone-public-key',
      grantId: 'grant-1'
    })
    expect(account.completeEnrollment).toHaveBeenCalledWith({
      spaceId: 'space-1',
      enrollmentId: 'grant-1',
      wrappedSpaceKey: 'opaque-grant',
      keyVersion: 2
    })
  })

  it('never falls back to the production Relay in a development runtime', () => {
    expect(resolveCompanionRelayUrl(undefined, 'development')).toBeNull()
    expect(resolveCompanionRelayUrl('http://127.0.0.1:8789/', 'development')).toBe('http://127.0.0.1:8789')
    expect(resolveCompanionRelayUrl(undefined, 'production')).toBe('https://fuddy.ai/api/relay')
    expect(resolveCompanionRelayUrl('https://fuddy.ai/api/relay/', 'production')).toBe('https://fuddy.ai/api/relay')
    expect(resolveCompanionRelayUrl('https://custom-relay.example.com', 'production')).toBeNull()
    expect(resolveCompanionRelayUrl('http://relay.example.com', 'production')).toBeNull()
  })

  it('revokes a newly installed Relay token when Account activation is rejected', async () => {
    const account = {
      getState: vi.fn(() => ({
        status: 'signed-in',
        user: { id: 'user-1' },
        device: { syncSpaceId: 'space-1' }
      })),
      bindRelay: vi.fn(),
      listPendingEnrollments: vi.fn(async () => ({
        syncSpace: {
          id: 'space-1',
          keyVersion: 1,
          relayUrl: 'https://relay.example.com',
          relayAccountId: 'relay-account'
        },
        revocations: [],
        enrollments: [{
          id: 'revoked-grant',
          spaceId: 'space-1',
          deviceId: 'phone-1',
          deviceName: 'Kai 的 iPhone',
          publicKey: 'phone-public-key',
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        }]
      })),
      wrapEnrollmentGrant: vi.fn(() => 'opaque-grant'),
      completeEnrollment: vi.fn(async () => {
        throw new AccountRequestError(409, 'enrollment_not_pending', '这次连接申请已失效。')
      })
    } as unknown as AccountService
    const companion = {
      ensureAccountRelay: vi.fn(async () => ({
        relayUrl: 'https://relay.example.com',
        relayAccountId: 'relay-account'
      })),
      isAccountRelayBindingConfirmed: vi.fn(() => false),
      confirmAccountRelayBinding: vi.fn(),
      start: vi.fn(),
      enrollAccountDevice: vi.fn(async () => ({
        relayURL: 'https://relay.example.com',
        accountID: 'relay-account',
        deviceID: 'phone-1',
        deviceToken: 'new-secret',
        encryptionKey: 'data-key',
        encryptionKeyId: 'key-id'
      })),
      revokeAccountDevice: vi.fn()
    } as unknown as CompanionSyncService

    await expect(
      new AccountEnrollmentCoordinator(account, companion, 'https://relay.example.com').processOnce()
    ).rejects.toThrow('这次连接申请已失效。')

    expect(companion.enrollAccountDevice).toHaveBeenCalledWith(expect.objectContaining({ grantId: 'revoked-grant' }))
    expect(companion.revokeAccountDevice).toHaveBeenCalledWith('phone-1', 'revoked-grant')
  })

  it('does not start Relay synchronization before its account binding succeeds', async () => {
    const account = {
      getState: vi.fn(() => ({
        status: 'signed-in',
        user: { id: 'user-1' },
        device: { syncSpaceId: 'space-1' }
      })),
      bindRelay: vi.fn(async () => { throw new Error('Account API unavailable') })
    } as unknown as AccountService
    const companion = {
      ensureAccountRelay: vi.fn(async () => ({
        relayUrl: 'https://relay.example.com',
        relayAccountId: 'new-relay-account'
      })),
      isAccountRelayBindingConfirmed: vi.fn(() => false),
      confirmAccountRelayBinding: vi.fn(),
      start: vi.fn()
    } as unknown as CompanionSyncService

    await expect(
      new AccountEnrollmentCoordinator(account, companion, 'https://relay.example.com').processOnce()
    ).rejects.toThrow('Account API unavailable')

    expect(companion.start).not.toHaveBeenCalled()
    expect(companion.confirmAccountRelayBinding).not.toHaveBeenCalled()
  })

  it('disconnects a confirmed Relay when Account API authorization expires', async () => {
    let signedOut = false
    const authorizationError = new AccountAuthorizationLostError()
    const account = {
      getState: vi.fn(() => signedOut
        ? { status: 'signed-out' }
        : {
            status: 'signed-in',
            user: { id: 'user-1' },
            device: { syncSpaceId: 'space-1' }
          }),
      bindRelay: vi.fn(async () => {
        signedOut = true
        throw authorizationError
      })
    } as unknown as AccountService
    const companion = {
      ensureAccountRelay: vi.fn(async () => ({
        relayUrl: 'https://relay.example.com',
        relayAccountId: 'confirmed-relay'
      })),
      isAccountRelayBindingConfirmed: vi.fn(() => true),
      start: vi.fn(),
      disconnect: vi.fn(async () => undefined)
    } as unknown as CompanionSyncService
    const coordinator = new AccountEnrollmentCoordinator(account, companion, 'https://relay.example.com')

    await expect(coordinator.processOnce()).rejects.toBe(authorizationError)

    expect(companion.start).toHaveBeenCalledOnce()
    expect(companion.disconnect).toHaveBeenCalledOnce()
    await coordinator.processOnce()
    expect(companion.ensureAccountRelay).toHaveBeenCalledOnce()
  })

  it('does not create a Relay identity when no development Relay is configured', async () => {
    const account = {
      getState: vi.fn(() => ({ status: 'signed-in', device: { syncSpaceId: 'space-1' } }))
    } as unknown as AccountService
    const companion = { ensureAccountRelay: vi.fn() } as unknown as CompanionSyncService

    await new AccountEnrollmentCoordinator(account, companion, null).processOnce()

    expect(companion.ensureAccountRelay).not.toHaveBeenCalled()
  })

  it('pauses new work and drains an active Relay binding before logout', async () => {
    let releaseBinding!: () => void
    let bindingStarted!: () => void
    const started = new Promise<void>((resolve) => { bindingStarted = resolve })
    const blocked = new Promise<void>((resolve) => { releaseBinding = resolve })
    const account = {
      getState: vi.fn(() => ({
        status: 'signed-in',
        user: { id: 'user-1' },
        device: { syncSpaceId: 'space-1' }
      })),
      bindRelay: vi.fn(),
      listPendingEnrollments: vi.fn(async () => ({
        syncSpace: {
          id: 'space-1',
          keyVersion: 1,
          relayUrl: 'https://relay.example.com',
          relayAccountId: 'relay-account'
        },
        revocations: [],
        enrollments: []
      }))
    } as unknown as AccountService
    const companion = {
      ensureAccountRelay: vi.fn(async () => {
        bindingStarted()
        await blocked
        return { relayUrl: 'https://relay.example.com', relayAccountId: 'relay-account' }
      }),
      isAccountRelayBindingConfirmed: vi.fn(() => false),
      confirmAccountRelayBinding: vi.fn(),
      start: vi.fn()
    } as unknown as CompanionSyncService
    const coordinator = new AccountEnrollmentCoordinator(account, companion, 'https://relay.example.com')
    coordinator.start()
    await started

    let drained = false
    const draining = coordinator.pauseAndDrain().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    releaseBinding()
    await draining
    expect(account.bindRelay).toHaveBeenCalledTimes(1)

    await coordinator.processOnce()
    expect(companion.ensureAccountRelay).toHaveBeenCalledTimes(1)
  })
})
