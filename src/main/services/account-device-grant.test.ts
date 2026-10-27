import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { openDeviceGrant, openProjectDeviceGrant, wrapDeviceGrant, wrapProjectDeviceGrant } from './account-device-grant'
import { generateSharedProjectKey } from '../../shared/project-sharing-events'

function keyPair(): { publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  }
}

describe('account device grants', () => {
  it('wraps only a project key to one member device and one epoch', () => {
    const mac = keyPair()
    const phone = keyPair()
    const other = keyPair()
    const projectKey = generateSharedProjectKey()
    const context = {
      grantId: crypto.randomUUID(), projectId: crypto.randomUUID(),
      deviceId: crypto.randomUUID(), keyEpoch: 2
    }
    const wrappedGrant = wrapProjectDeviceGrant({
      ...context, projectKey, recipientPublicKey: phone.publicKey,
      senderPublicKey: mac.publicKey, senderPrivateKey: mac.privateKey
    })
    expect(wrappedGrant).not.toContain(projectKey)
    expect(openProjectDeviceGrant({ ...context, wrappedGrant, recipientPrivateKey: phone.privateKey })).toBe(projectKey)
    expect(() => openProjectDeviceGrant({ ...context, projectId: crypto.randomUUID(),
      wrappedGrant, recipientPrivateKey: phone.privateKey })).toThrow()
    expect(() => openProjectDeviceGrant({ ...context, keyEpoch: 3,
      wrappedGrant, recipientPrivateKey: phone.privateKey })).toThrow()
    expect(() => openProjectDeviceGrant({ ...context,
      wrappedGrant, recipientPrivateKey: other.privateKey })).toThrow()
    expect(() => openDeviceGrant({ wrappedGrant, enrollmentId: context.grantId,
      spaceId: context.projectId, deviceId: context.deviceId,
      recipientPrivateKey: phone.privateKey })).toThrow()
  })

  it('wraps Relay credentials to the requesting iPhone public key', () => {
    const mac = keyPair()
    const phone = keyPair()
    const context = { enrollmentId: 'grant-1', spaceId: 'space-1', deviceId: 'phone-1' }
    const credentials = {
      relayURL: 'https://relay.example.com',
      accountID: 'relay-account',
      deviceID: 'phone-1',
      deviceToken: 'secret-device-token',
      encryptionKey: 'secret-data-key',
      encryptionKeyId: 'key-1'
    }
    const wrappedGrant = wrapDeviceGrant({
      ...context,
      recipientPublicKey: phone.publicKey,
      senderPublicKey: mac.publicKey,
      senderPrivateKey: mac.privateKey,
      credentials
    })

    expect(wrappedGrant).not.toContain(credentials.deviceToken)
    expect(openDeviceGrant({ ...context, wrappedGrant, recipientPrivateKey: phone.privateKey })).toEqual(credentials)
    expect(() => openDeviceGrant({
      ...context,
      deviceId: 'another-phone',
      wrappedGrant,
      recipientPrivateKey: phone.privateKey
    })).toThrow()
  })
})
