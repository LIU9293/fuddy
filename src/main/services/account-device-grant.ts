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
const projectGrantInfo = Buffer.from('fuddy-shared-project-grant-v1', 'utf8')

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

function deriveKey(privateKey: string, publicKey: string, salt: Buffer, info = grantInfo): Buffer {
  const sharedSecret = diffieHellman({
    privateKey: createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' }),
    publicKey: createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
  })
  return Buffer.from(hkdfSync('sha256', sharedSecret, salt, info, 32))
}

export interface WrapProjectDeviceGrantInput {
  grantId: string
  projectId: string
  deviceId: string
  keyEpoch: number
  projectKey: string
  recipientPublicKey: string
  senderPublicKey: string
  senderPrivateKey: string
}

function projectGrantAssociatedData(input: Pick<
  WrapProjectDeviceGrantInput, 'grantId' | 'projectId' | 'deviceId' | 'keyEpoch'
>): Buffer {
  return Buffer.from(
    `fuddy-project-grant:v1:${input.grantId}:${input.projectId}:${input.deviceId}:${input.keyEpoch}`,
    'utf8'
  )
}

export function wrapProjectDeviceGrant(input: WrapProjectDeviceGrantInput): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(input.projectKey)) throw new Error('项目密钥格式无效。')
  const salt = randomBytes(32)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm',
    deriveKey(input.senderPrivateKey, input.recipientPublicKey, salt, projectGrantInfo), nonce)
  cipher.setAAD(projectGrantAssociatedData(input))
  const ciphertext = Buffer.concat([cipher.update(input.projectKey, 'utf8'), cipher.final()])
  const envelope: WrappedDeviceGrant = {
    version: 1, algorithm: grantAlgorithm, senderPublicKey: input.senderPublicKey,
    salt: salt.toString('base64'), nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64')
  }
  return JSON.stringify(envelope)
}

export function openProjectDeviceGrant(input: {
  wrappedGrant: string
  grantId: string
  projectId: string
  deviceId: string
  keyEpoch: number
  recipientPrivateKey: string
}): string {
  const envelope = JSON.parse(input.wrappedGrant) as WrappedDeviceGrant
  if (envelope.version !== 1 || envelope.algorithm !== grantAlgorithm) {
    throw new Error('不支持的项目设备授权格式。')
  }
  const key = deriveKey(input.recipientPrivateKey, envelope.senderPublicKey,
    Buffer.from(envelope.salt, 'base64'), projectGrantInfo)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'))
  decipher.setAAD(projectGrantAssociatedData(input))
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  const projectKey = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()
  ]).toString('utf8')
  if (!/^[A-Za-z0-9_-]{43}$/u.test(projectKey)) throw new Error('项目密钥格式无效。')
  return projectKey
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
