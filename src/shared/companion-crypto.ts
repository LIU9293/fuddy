export interface CompanionEncryptedEnvelope {
  algorithm: 'A256GCM'
  keyId: string
  nonce: string
  ciphertext: string
}

export function companionEventAssociatedData(event: {
  eventId: string
  protocolVersion: number
  type: string
  entityType: string
  entityId: string
  revision: number
  occurredAt: string
}): string {
  return [
    'project-agent:event', event.eventId, event.protocolVersion, event.type,
    event.entityType, event.entityId, event.revision, event.occurredAt
  ].join(':')
}

export function companionCommandAssociatedData(command: {
  commandId: string
  protocolVersion: number
  type: string
  createdAt: string
}): string {
  return ['project-agent:command', command.commandId, command.protocolVersion, command.type, command.createdAt].join(':')
}

export function companionAttachmentAssociatedData(accountId: string, attachmentId: string): string {
  return ['project-agent:attachment', accountId, attachmentId].join(':')
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

async function importAccountKey(encoded: string, usage: KeyUsage): Promise<CryptoKey> {
  const bytes = base64UrlDecode(encoded)
  if (bytes.byteLength !== 32) throw new Error('Companion E2EE key must be 256 bits.')
  return crypto.subtle.importKey('raw', arrayBuffer(bytes), { name: 'AES-GCM' }, false, [usage])
}

export function generateCompanionAccountKey(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

export async function companionAccountKeyId(encoded: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer(base64UrlDecode(encoded)))
  return base64UrlEncode(new Uint8Array(digest)).slice(0, 16)
}

export async function sealCompanionBytes(
  encodedKey: string,
  plaintext: Uint8Array,
  associatedData: string
): Promise<CompanionEncryptedEnvelope> {
  const nonce = new Uint8Array(12)
  crypto.getRandomValues(nonce)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: arrayBuffer(nonce), additionalData: arrayBuffer(new TextEncoder().encode(associatedData)), tagLength: 128 },
    await importAccountKey(encodedKey, 'encrypt'),
    arrayBuffer(plaintext)
  )
  return {
    algorithm: 'A256GCM',
    keyId: await companionAccountKeyId(encodedKey),
    nonce: base64UrlEncode(nonce),
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext))
  }
}

export async function openCompanionBytes(
  encodedKey: string,
  envelope: CompanionEncryptedEnvelope,
  associatedData: string
): Promise<Uint8Array> {
  if (envelope.algorithm !== 'A256GCM') throw new Error('Unsupported Companion encryption algorithm.')
  if (envelope.keyId !== await companionAccountKeyId(encodedKey)) throw new Error('Companion encryption key does not match.')
  const nonce = base64UrlDecode(envelope.nonce)
  if (nonce.byteLength !== 12) throw new Error('Companion encryption nonce is invalid.')
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: arrayBuffer(nonce), additionalData: arrayBuffer(new TextEncoder().encode(associatedData)), tagLength: 128 },
    await importAccountKey(encodedKey, 'decrypt'),
    arrayBuffer(base64UrlDecode(envelope.ciphertext))
  )
  return new Uint8Array(plaintext)
}

export async function sealCompanionJson(
  encodedKey: string,
  value: unknown,
  associatedData: string
): Promise<CompanionEncryptedEnvelope> {
  return sealCompanionBytes(encodedKey, new TextEncoder().encode(JSON.stringify(value)), associatedData)
}

export async function openCompanionJson<T>(
  encodedKey: string,
  envelope: CompanionEncryptedEnvelope,
  associatedData: string
): Promise<T> {
  return JSON.parse(new TextDecoder().decode(
    await openCompanionBytes(encodedKey, envelope, associatedData)
  )) as T
}

const attachmentMagic = new Uint8Array([0x50, 0x41, 0x45, 0x32]) // PAE2

export async function sealCompanionAttachment(
  encodedKey: string,
  plaintext: Uint8Array,
  associatedData: string
): Promise<Uint8Array> {
  const nonce = new Uint8Array(12)
  crypto.getRandomValues(nonce)
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: arrayBuffer(nonce), additionalData: arrayBuffer(new TextEncoder().encode(associatedData)), tagLength: 128 },
    await importAccountKey(encodedKey, 'encrypt'),
    arrayBuffer(plaintext)
  ))
  const sealed = new Uint8Array(attachmentMagic.byteLength + nonce.byteLength + ciphertext.byteLength)
  sealed.set(attachmentMagic, 0)
  sealed.set(nonce, attachmentMagic.byteLength)
  sealed.set(ciphertext, attachmentMagic.byteLength + nonce.byteLength)
  return sealed
}

export async function openCompanionAttachment(
  encodedKey: string,
  sealed: Uint8Array,
  associatedData: string
): Promise<Uint8Array> {
  const minimumLength = attachmentMagic.byteLength + 12 + 16
  if (sealed.byteLength < minimumLength || !attachmentMagic.every((byte, index) => sealed[index] === byte)) {
    throw new Error('Companion attachment envelope is invalid.')
  }
  const nonce = sealed.slice(attachmentMagic.byteLength, attachmentMagic.byteLength + 12)
  const ciphertext = sealed.slice(attachmentMagic.byteLength + 12)
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: arrayBuffer(nonce), additionalData: arrayBuffer(new TextEncoder().encode(associatedData)), tagLength: 128 },
    await importAccountKey(encodedKey, 'decrypt'),
    arrayBuffer(ciphertext)
  ))
}
