import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { openDeviceGrant, wrapDeviceGrant } from './account-device-grant'

function keyPair(): { publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  }
}

describe('account device grants', () => {
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
