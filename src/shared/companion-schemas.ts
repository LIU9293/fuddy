import { z } from 'zod'
import {
  companionCommandTypes,
  companionEventDefinitions,
  companionProtocolVersionIsSupported,
  type CompanionEventType
} from './companion-protocol'
import type { CompanionCommand, CompanionCommandInput, CompanionSyncEventInput } from './companion-sync'

const identifier = z.string().trim().min(1).max(200)
const isoDate = z.string().datetime({ offset: true })
const protocolVersion = z.number().int().refine(companionProtocolVersionIsSupported, 'Unsupported companion protocol version')
const attachment = z.object({
  id: identifier,
  messageId: identifier.nullable(),
  artifactId: identifier.nullable(),
  filename: z.string().trim().min(1).max(500),
  mimeType: z.string().trim().min(1).max(200),
  size: z.number().int().positive().max(100 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  thumbnailAttachmentId: identifier.nullable(),
  createdAt: isoDate
})
const project = z.object({ id: identifier, name: z.string().trim().min(1), status: z.string(), profile: z.record(z.string(), z.unknown()) }).passthrough()
const goal = z.object({ id: identifier, projectId: identifier, title: z.string(), status: z.string() }).passthrough()
const decision = z.object({ id: identifier, title: z.string(), status: z.string() }).passthrough()
const agentRun = z.object({ id: identifier, title: z.string(), status: z.string(), provider: z.string() }).passthrough()
const agentMessage = z.object({ id: identifier, runId: identifier, role: z.string(), content: z.string(), createdAt: isoDate }).passthrough()
const artifact = z.object({ id: identifier, runId: identifier, relativePath: z.string(), createdAt: isoDate }).passthrough()
const morningBriefing = z.object({ id: identifier, status: z.string(), generatedAt: isoDate }).passthrough()
const assistantMessage = z.object({ id: identifier, role: z.string(), content: z.string(), createdAt: isoDate }).passthrough()
const modelLabels = z.record(z.string(), z.unknown())

const payloadSchemas = {
  'snapshot.created': z.object({
    generatedAt: isoDate,
    modelLabels,
    projects: z.array(project),
    goals: z.array(goal),
    decisions: z.array(decision),
    morningBriefings: z.array(morningBriefing),
    workAssistantMessages: z.array(assistantMessage),
    attachments: z.array(attachment),
    runs: z.array(z.object({ run: agentRun, messages: z.array(agentMessage), artifacts: z.array(artifact) }))
  }),
  'project.created': project,
  'project.updated': project,
  'goal.created': goal,
  'goal.updated': goal,
  'decision.created': decision,
  'decision.updated': decision,
  'agent-run.created': agentRun,
  'agent-run.updated': agentRun,
  'agent-run.archived': z.object({ id: identifier, archivedAt: isoDate }),
  'agent-message.created': agentMessage,
  'artifact.updated': z.union([artifact, z.object({ artifact, attachment: attachment.nullable() })]),
  'morning-briefing.updated': morningBriefing,
  'work-assistant-message.created': assistantMessage,
  'work-assistant-message.updated': assistantMessage,
  'agent-turn.settled': z.object({
    runId: identifier,
    turnId: identifier,
    title: z.string(),
    outcome: z.enum(['completed', 'failed']),
    summary: z.string(),
    settledAt: isoDate
  }),
  'model-labels.updated': modelLabels,
  'command.updated': z.object({
    commandId: identifier,
    protocolVersion,
    type: z.enum(companionCommandTypes),
    sourceDeviceId: identifier,
    status: z.enum(['queued', 'delivered', 'executing', 'completed', 'failed']),
    result: z.unknown().nullable(),
    error: z.string().nullable(),
    createdAt: isoDate,
    updatedAt: isoDate
  }).passthrough()
} satisfies Record<CompanionEventType, z.ZodType>

const eventBase = {
  eventId: identifier,
  protocolVersion,
  entityId: identifier,
  revision: z.number().int().min(0),
  occurredAt: isoDate
}

const companionEventTypes = Object.keys(companionEventDefinitions) as [CompanionEventType, ...CompanionEventType[]]
const companionEntityTypes = [...new Set(Object.values(companionEventDefinitions))] as [
  (typeof companionEventDefinitions)[CompanionEventType],
  ...(typeof companionEventDefinitions)[CompanionEventType][]
]
export const syncEventSchema = z.object({
  ...eventBase,
  type: z.enum(companionEventTypes),
  entityType: z.enum(companionEntityTypes),
  payload: z.unknown()
}).superRefine((event, context) => {
  const expectedEntityType = companionEventDefinitions[event.type]
  if (event.entityType !== expectedEntityType) {
    context.addIssue({
      code: 'custom',
      path: ['entityType'],
      message: `Event ${event.type} must use entity type ${expectedEntityType}.`
    })
  }
  const parsedPayload = payloadSchemas[event.type].safeParse(event.payload)
  if (!parsedPayload.success) {
    for (const issue of parsedPayload.error.issues) {
      context.addIssue({ ...issue, path: ['payload', ...issue.path] })
    }
  }
}).transform((event) => event as unknown as CompanionSyncEventInput)

export const syncEventBatchSchema = z.object({ events: z.array(syncEventSchema).min(1).max(100) })

const commandBase = { commandId: identifier, protocolVersion, createdAt: isoDate }
const commandPayloadSchemas = {
  'assistant.send-message': z.object({ prompt: z.string().trim().min(1).max(20_000), attachments: z.array(attachment).max(4).optional() }),
  'assistant.execute-action': z.object({ messageId: identifier, proposalId: identifier, optionId: identifier }),
  'agent.send-message': z.object({ runId: identifier, prompt: z.string().trim().min(1).max(20_000), attachments: z.array(attachment).max(4).optional(), clientMessageId: identifier.optional() }),
  'agent.stop-message': z.object({ runId: identifier }),
  'agent.rename-session': z.object({ runId: identifier, title: z.string().trim().min(1).max(200) }),
  'agent.update-draft-prompt': z.object({ runId: identifier, draftPrompt: z.string().max(20_000) }),
  'agent.archive-session': z.object({ runId: identifier }),
  'artifact.request-upload': z.object({ artifactId: identifier }),
  'decision.update-status': z.object({ decisionId: identifier, status: z.enum(['inbox', 'in_progress', 'waiting', 'resolved', 'ignored']) }),
  'decision.handle': z.object({ decisionId: identifier, runId: identifier }),
  'project.update': z.object({ project })
} satisfies Record<(typeof companionCommandTypes)[number], z.ZodType>

export const commandSchema = z.object({
  ...commandBase,
  type: z.enum(companionCommandTypes),
  payload: z.unknown()
}).superRefine((command, context) => {
  const parsedPayload = commandPayloadSchemas[command.type].safeParse(command.payload)
  if (!parsedPayload.success) {
    for (const issue of parsedPayload.error.issues) {
      context.addIssue({ ...issue, path: ['payload', ...issue.path] })
    }
  }
}).transform((command) => command as unknown as CompanionCommandInput)

export const companionCommandSchema = z.object({
  ...commandBase,
  type: z.enum(companionCommandTypes),
  payload: z.unknown(),
  sourceDeviceId: identifier,
  status: z.enum(['queued', 'delivered', 'executing', 'completed', 'failed']),
  result: z.unknown().nullable(),
  error: z.string().max(8_000).nullable(),
  updatedAt: isoDate
}).superRefine((command, context) => {
  const parsedPayload = commandPayloadSchemas[command.type].safeParse(command.payload)
  if (!parsedPayload.success) {
    for (const issue of parsedPayload.error.issues) {
      context.addIssue({ ...issue, path: ['payload', ...issue.path] })
    }
  }
}).transform((command) => command as unknown as CompanionCommand)

export const commandUpdateSchema = z.object({
  status: z.enum(['delivered', 'executing', 'completed', 'failed']),
  result: z.unknown().optional(),
  error: z.string().max(8_000).nullable().optional()
})
