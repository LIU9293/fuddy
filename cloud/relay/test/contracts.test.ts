import { describe, expect, it } from 'vitest'
import type { CompanionEncryptedSyncEvent } from '../../../src/shared/companion-sync'
import { companionMinimumProtocolVersion, companionProtocolVersion } from '../../../src/shared/companion-sync'
import { agentTurnAlertPushRequest } from '../src/account-relay'
import { commandSchema, syncEventSchema } from '../src/schemas'

const occurredAt = '2026-08-12T05:00:00.000Z'
const encryptedPayload = {
  algorithm: 'A256GCM',
  keyId: 'keyidentifier123',
  nonce: '0123456789abcdef',
  ciphertext: 'ciphertext_AQID'
} as const

describe('companion protocol contracts', () => {
  it('binds each event type to its entity type and requires an encrypted payload', () => {
    const valid = {
      eventId: 'event-1',
      protocolVersion: companionProtocolVersion,
      type: 'agent-message.created',
      entityType: 'agent-message',
      entityId: 'message-1',
      revision: 1,
      payload: encryptedPayload,
      occurredAt
    }
    expect(syncEventSchema.safeParse(valid).success).toBe(true)
    expect(syncEventSchema.safeParse({ ...valid, entityType: 'agent-run' }).success).toBe(false)
    expect(syncEventSchema.safeParse({ ...valid, payload: { content: 'plaintext' } }).success).toBe(false)
  })

  it('rejects unsupported protocol versions', () => {
    expect(syncEventSchema.safeParse({
      eventId: 'event-1',
      protocolVersion: companionMinimumProtocolVersion - 1,
      type: 'agent-run.archived',
      entityType: 'agent-run',
      entityId: 'run-1',
      revision: 1,
      payload: encryptedPayload,
      occurredAt
    }).success).toBe(false)
  })

  it('accepts only encrypted command payloads', () => {
    const base = { commandId: 'command-1', protocolVersion: companionProtocolVersion, createdAt: occurredAt }
    expect(commandSchema.safeParse({
      ...base,
      type: 'agent.rename-session',
      payload: encryptedPayload
    }).success).toBe(true)
    expect(commandSchema.safeParse({
      ...base,
      type: 'agent.rename-session',
      payload: { runId: 'run-1', title: 'plaintext' }
    }).success).toBe(false)
  })

  it('preserves an opaque encrypted payload without inspecting business data', () => {
    const parsed = commandSchema.parse({
      commandId: 'command-1',
      protocolVersion: companionProtocolVersion,
      createdAt: occurredAt,
      type: 'agent.rename-session',
      payload: encryptedPayload
    })

    expect(parsed.payload).toEqual(encryptedPayload)
  })

  it('rejects malformed nonces and key identifiers', () => {
    expect(commandSchema.safeParse({
      commandId: 'command-attachment', protocolVersion: companionProtocolVersion, createdAt: occurredAt,
      type: 'assistant.send-message', payload: { ...encryptedPayload, nonce: 'short' }
    }).success).toBe(false)
  })

  it('includes the completed Run identifier in Agent alert pushes', () => {
    const event: CompanionEncryptedSyncEvent = {
      sequence: 42,
      eventId: 'event-agent-settled',
      protocolVersion: companionProtocolVersion,
      type: 'agent-turn.settled',
      entityType: 'agent-run',
      entityId: 'run-42',
      revision: 1,
      payload: encryptedPayload,
      sourceDeviceId: 'mac-1',
      occurredAt
    }

    expect(agentTurnAlertPushRequest(event)).toMatchObject({
      body: { sequence: 42, runId: 'run-42' }
    })
  })
})
