import { describe, expect, it } from 'vitest'
import {
  generateCompanionAccountKey,
  openCompanionAttachment,
  openCompanionJson,
  sealCompanionAttachment,
  sealCompanionJson
} from './companion-crypto'

describe('companion application-layer encryption', () => {
  it('round-trips JSON only with the account key and matching metadata', async () => {
    const key = generateCompanionAccountKey()
    const envelope = await sealCompanionJson(key, { prompt: 'private command' }, 'command:command-1')
    expect(envelope).toMatchObject({ algorithm: 'A256GCM' })
    expect(JSON.stringify(envelope)).not.toContain('private command')
    await expect(openCompanionJson(key, envelope, 'command:command-1'))
      .resolves.toEqual({ prompt: 'private command' })
  })

  it('rejects the wrong key, metadata, or modified ciphertext', async () => {
    const key = generateCompanionAccountKey()
    const envelope = await sealCompanionJson(key, { value: 1 }, 'event:event-1')
    await expect(openCompanionJson(generateCompanionAccountKey(), envelope, 'event:event-1')).rejects.toThrow()
    await expect(openCompanionJson(key, envelope, 'event:event-2')).rejects.toThrow()
    await expect(openCompanionJson(key, { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -1)}A` }, 'event:event-1'))
      .rejects.toThrow()
  })

  it('round-trips binary attachments without exposing plaintext bytes', async () => {
    const key = generateCompanionAccountKey()
    const plaintext = new TextEncoder().encode('private attachment body')
    const sealed = await sealCompanionAttachment(key, plaintext, 'attachment:account:file')
    expect(new TextDecoder().decode(sealed)).not.toContain('private attachment body')
    await expect(openCompanionAttachment(key, sealed, 'attachment:account:file'))
      .resolves.toEqual(plaintext)
    await expect(openCompanionAttachment(key, sealed, 'attachment:account:other')).rejects.toThrow()
  })
})
