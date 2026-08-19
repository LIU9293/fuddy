import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes
} from 'node:crypto'

const grantAlgorithm = 'P256-HKDF-SHA256-A256GCM' as const
const grantInfo = Buffer.from('fuddy-sync-space-grant-v1', 'utf8')

export interface AccountRelayCredentials {
  relayURL: string
  accountID: string
  deviceID: string
  deviceToken: string
  encryptionKey: string
  encryptionKeyId: string
}

interface WrappedDeviceGrant {
  version: 1
  algorithm: typeof grantAlgorithm
  senderPublicKey: string
  salt: string
  nonce: string
  ciphertext: string
  tag: string
}

export interface WrapDeviceGrantInput {
  enrollmentId: string
  spaceId: string
  deviceId: string
  recipientPublicKey: string
  senderPublicKey: string
  senderPrivateKey: string
  credentials: AccountRelayCredentials
}

function associatedData(input: Pick<WrapDeviceGrantInput, 'enrollmentId' | 'spaceId' | 'deviceId'>): Buffer {
  return Buffer.from(
    `fuddy-enrollment:${input.enrollmentId}:${input.spaceId}:${input.deviceId}:v1`,
    'utf8'
  )
}

function deriveKey(privateKey: string, publicKey: string, salt: Buffer): Buffer {
  const sharedSecret = diffieHellman({
    privateKey: createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' }),
    publicKey: createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
  })
  return Buffer.from(hkdfSync('sha256', sharedSecret, salt, grantInfo, 32))
}

export function wrapDeviceGrant(input: WrapDeviceGrantInput): string {
  const salt = randomBytes(32)
  const nonce = randomBytes(12)
  const key = deriveKey(input.senderPrivateKey, input.recipientPublicKey, salt)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(associatedData(input))
  const plaintext = Buffer.from(JSON.stringify(input.credentials), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const envelope: WrappedDeviceGrant = {
    version: 1,
    algorithm: grantAlgorithm,
    senderPublicKey: input.senderPublicKey,
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64')
  }
  return JSON.stringify(envelope)
}

export function openDeviceGrant(input: {
  wrappedGrant: string
  enrollmentId: string
  spaceId: string
  deviceId: string
  recipientPrivateKey: string
}): AccountRelayCredentials {
  const envelope = JSON.parse(input.wrappedGrant) as WrappedDeviceGrant
  if (envelope.version !== 1 || envelope.algorithm !== grantAlgorithm) {
    throw new Error('不支持的设备授权格式。')
  }
  const salt = Buffer.from(envelope.salt, 'base64')
  const key = deriveKey(input.recipientPrivateKey, envelope.senderPublicKey, salt)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'))
  decipher.setAAD(associatedData(input))
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final()
  ])
  return JSON.parse(plaintext.toString('utf8')) as AccountRelayCredentials
}
