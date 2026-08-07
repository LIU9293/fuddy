import { z } from 'zod'
import { companionProtocolVersion } from '../../../src/shared/companion-sync'

const identifier = z.string().trim().min(1).max(200)
const isoDate = z.string().datetime({ offset: true })

export const pairingStartSchema = z.object({
  macDeviceId: identifier,
  macDeviceName: z.string().trim().min(1).max(200),
  publicKey: z.string().trim().max(2_000).nullable().optional()
})

export const pairingClaimSchema = z.object({
  accountId: identifier,
  pairingSecret: z.string().trim().min(20).max(500),
  deviceId: identifier,
  deviceName: z.string().trim().min(1).max(200),
  publicKey: z.string().trim().max(2_000).nullable().optional()
})

export const syncEventSchema = z.object({
  eventId: identifier,
  protocolVersion: z.literal(companionProtocolVersion),
  type: z.string().trim().min(1).max(200),
  entityType: z.enum([
    'snapshot',
    'project',
    'goal',
    'decision',
    'agent-run',
    'agent-message',
    'artifact',
    'work-assistant-message'
  ]),
  entityId: identifier,
  revision: z.number().int().min(0),
  payload: z.unknown(),
  occurredAt: isoDate
})

export const commandSchema = z.object({
  commandId: identifier,
  protocolVersion: z.literal(companionProtocolVersion),
  type: z.enum([
    'assistant.send-message',
    'agent.send-message',
    'agent.rename-session',
    'agent.archive-session',
    'decision.update-status'
  ]),
  payload: z.unknown(),
  createdAt: isoDate
})

export const commandUpdateSchema = z.object({
  status: z.enum(['delivered', 'executing', 'completed', 'failed']),
  result: z.unknown().optional(),
  error: z.string().max(8_000).nullable().optional()
})

export const pushRegistrationSchema = z.object({
  token: z.string().regex(/^[a-fA-F0-9]{32,256}$/)
})
