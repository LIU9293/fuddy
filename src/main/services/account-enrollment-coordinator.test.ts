import { describe, expect, it, vi } from 'vitest'
import { AccountEnrollmentCoordinator, resolveCompanionRelayUrl } from './account-enrollment-coordinator'
import type { AccountService } from './account-service'
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
    expect(resolveCompanionRelayUrl('http://relay.example.com', 'production')).toBeNull()
  })

  it('does not create a Relay identity when no development Relay is configured', async () => {
    const account = {
      getState: vi.fn(() => ({ status: 'signed-in', device: { syncSpaceId: 'space-1' } }))
    } as unknown as AccountService
    const companion = { ensureAccountRelay: vi.fn() } as unknown as CompanionSyncService

    await new AccountEnrollmentCoordinator(account, companion, null).processOnce()

    expect(companion.ensureAccountRelay).not.toHaveBeenCalled()
  })
})
