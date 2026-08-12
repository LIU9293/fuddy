import { describe, expect, it } from 'vitest'
import { commandSchema, syncEventSchema } from '../src/schemas'

const occurredAt = '2026-08-12T05:00:00.000Z'

describe('companion protocol contracts', () => {
  it('binds each event type to its entity type and payload schema', () => {
    const valid = {
      eventId: 'event-1',
      protocolVersion: 1,
      type: 'agent-message.created',
      entityType: 'agent-message',
      entityId: 'message-1',
      revision: 1,
      payload: { id: 'message-1', runId: 'run-1', role: 'assistant', content: '完成', createdAt: occurredAt },
      occurredAt
    }
    expect(syncEventSchema.safeParse(valid).success).toBe(true)
    expect(syncEventSchema.safeParse({ ...valid, entityType: 'agent-run' }).success).toBe(false)
    expect(syncEventSchema.safeParse({ ...valid, payload: { content: 'missing identifiers' } }).success).toBe(false)
  })

  it('rejects unsupported protocol versions', () => {
    expect(syncEventSchema.safeParse({
      eventId: 'event-1',
      protocolVersion: 2,
      type: 'agent-run.archived',
      entityType: 'agent-run',
      entityId: 'run-1',
      revision: 1,
      payload: { id: 'run-1', archivedAt: occurredAt },
      occurredAt
    }).success).toBe(false)
  })

  it('binds command payloads to their command type', () => {
    const base = { commandId: 'command-1', protocolVersion: 1, createdAt: occurredAt }
    expect(commandSchema.safeParse({
      ...base,
      type: 'agent.rename-session',
      payload: { runId: 'run-1', title: 'New name' }
    }).success).toBe(true)
    expect(commandSchema.safeParse({
      ...base,
      type: 'agent.rename-session',
      payload: { decisionId: 'decision-1', status: 'resolved' }
    }).success).toBe(false)
  })

  it('persists the normalized payload returned by its type-specific schema', () => {
    const parsed = commandSchema.parse({
      commandId: 'command-1',
      protocolVersion: 1,
      createdAt: occurredAt,
      type: 'agent.rename-session',
      payload: {
        runId: '  run-1  ',
        title: '  Rename me  ',
        ignored: 'do not persist'
      }
    })

    expect(parsed.payload).toEqual({ runId: 'run-1', title: 'Rename me' })
  })

  it('accepts Swift attachments that omit nil optional fields', () => {
    const parsed = commandSchema.parse({
      commandId: 'command-attachment',
      protocolVersion: 1,
      createdAt: occurredAt,
      type: 'assistant.send-message',
      payload: {
        prompt: '检查附件',
        attachments: [{
          id: 'attachment-1',
          filename: 'photo.jpg',
          mimeType: 'image/jpeg',
          size: 128,
          sha256: 'a'.repeat(64),
          createdAt: occurredAt
        }]
      }
    })

    expect(parsed.payload.attachments?.[0]).toMatchObject({
      messageId: null,
      artifactId: null,
      width: null,
      height: null,
      thumbnailAttachmentId: null
    })
  })
})
