import { z } from 'zod'
import {
  companionCommandTypes,
  companionEventDefinitions,
  companionProtocolVersionIsSupported,
  type CompanionEventType
} from './companion-protocol'
import type {
  CompanionCommand,
  CompanionCommandInput,
  CompanionEncryptedCommand,
  CompanionEncryptedCommandInput,
  CompanionEncryptedSyncEventInput,
  CompanionRelayEventPayloadMap,
  CompanionSyncEventInput
} from './companion-sync'

const identifier = z.string().trim().min(1).max(200)
const chatRecordIdentifier = z.string().trim().min(1).max(260)
const isoDate = z.string().datetime({ offset: true })
const protocolVersion = z.number().int().refine(companionProtocolVersionIsSupported, 'Unsupported companion protocol version')
export const companionEncryptedEnvelopeSchema = z.object({
  algorithm: z.literal('A256GCM'),
  keyId: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]+$/).max(8 * 1024 * 1024)
})
const attachment = z.object({
  id: identifier,
  messageId: identifier.nullish().transform((value) => value ?? null),
  artifactId: identifier.nullish().transform((value) => value ?? null),
  filename: z.string().trim().min(1).max(500),
  mimeType: z.string().trim().min(1).max(200),
  size: z.number().int().positive().max(100 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  width: z.number().int().positive().nullish().transform((value) => value ?? null),
  height: z.number().int().positive().nullish().transform((value) => value ?? null),
  thumbnailAttachmentId: identifier.nullish().transform((value) => value ?? null),
  createdAt: isoDate
})
const evidence = z.object({ label: z.string(), uri: z.string() })
const workspaceRoot = z.object({ id: identifier, label: z.string(), path: z.string() })
const projectCurrentState = z.object({
  summary: z.string(),
  facts: z.array(z.string()),
  source: z.enum(['user', 'agent', 'connector']),
  updatedAt: isoDate.nullable()
})
const projectProfile = z.object({
  productType: z.string(),
  stage: z.string(),
  mission: z.string(),
  vision: z.string(),
  repoPath: z.string(),
  workspaceRoots: z.array(workspaceRoot),
  primaryWorkspaceRootId: identifier.nullable(),
  defaultAgent: z.enum(['pi', 'codex', 'claude', 'opencode']),
  websiteUrl: z.string().nullable(),
  surfaces: z.array(z.string()),
  focusAreas: z.array(z.string()),
  dataSources: z.array(z.string()),
  nextMoves: z.array(z.string()),
  currentState: projectCurrentState
})
const project = z.object({
  id: identifier,
  name: z.string().trim().min(1),
  icon: z.string().nullable().optional(),
  summary: z.string(),
  focus: z.string(),
  status: z.enum(['active', 'watching', 'paused']),
  accent: z.string(),
  profile: projectProfile
})
const goalMetric = z.object({
  label: z.string(), unit: z.string(), baseline: z.number().nullable(), current: z.number().nullable(), target: z.number().nullable()
})
const goalMilestone = z.object({
  id: identifier,
  goalId: identifier,
  title: z.string(),
  status: z.enum(['pending', 'completed', 'blocked']),
  dueAt: isoDate.nullable(),
  evidenceRefs: z.array(evidence),
  sortOrder: z.number().int(),
  createdAt: isoDate,
  updatedAt: isoDate,
  completedAt: isoDate.nullable()
})
const goalCheckIn = z.object({
  id: identifier,
  goalId: identifier,
  status: z.enum(['planned', 'active', 'at-risk', 'completed', 'paused']),
  progress: z.number(),
  summary: z.string(),
  evidenceRefs: z.array(evidence),
  generation: z.enum(['agent', 'deterministic']),
  createdAt: isoDate
})
const goal = z.object({
  id: identifier,
  projectId: identifier,
  title: z.string(),
  description: z.string(),
  status: z.enum(['planned', 'active', 'at-risk', 'completed', 'paused']),
  priority: z.enum(['P0', 'P1', 'P2']),
  metric: goalMetric,
  deadline: isoDate.nullable(),
  nextCheckInAt: isoDate.nullable(),
  progress: z.number(),
  confidence: z.number(),
  agentSummary: z.string(),
  monitoringSources: z.array(z.string()),
  milestones: z.array(goalMilestone),
  checkIns: z.array(goalCheckIn),
  createdBy: z.enum(['user', 'agent']),
  createdAt: isoDate,
  updatedAt: isoDate,
  completedAt: isoDate.nullable()
})
const decision = z.object({
  id: identifier,
  projectId: identifier.nullable(),
  goalId: identifier.nullable().optional(),
  dedupeKey: z.string().nullable().optional(),
  kind: z.enum(['risk', 'opportunity', 'decision', 'result', 'info']),
  title: z.string(),
  summary: z.string(),
  impact: z.string(),
  urgency: z.enum(['low', 'medium', 'high']),
  confidence: z.number(),
  suggestedActions: z.array(z.string()),
  evidenceRefs: z.array(evidence),
  status: z.enum(['inbox', 'in_progress', 'waiting', 'resolved', 'ignored']),
  waitingReason: z.enum(['deployment', 'verification', 'external', 'measurement', 'user', 'scheduled']).nullable().optional(),
  statusSummary: z.string().nullable().optional(),
  statusUpdatedAt: isoDate.optional(),
  reopenCount: z.number().int().optional(),
  source: z.string(),
  createdAt: isoDate,
  firstSeenAt: isoDate.optional(),
  lastSeenAt: isoDate.optional(),
  occurrenceCount: z.number().int().optional(),
  resolvedAt: isoDate.nullable().optional(),
  resolutionSummary: z.string().nullable().optional()
})
const agentRun = z.object({
  id: identifier,
  projectId: identifier.nullable(),
  decisionId: identifier.nullable().optional(),
  goalId: identifier.nullable().optional(),
  milestoneId: identifier.nullable().optional(),
  provider: z.enum(['pi', 'codex', 'claude', 'opencode']),
  model: z.string().nullable().optional(),
  reasoningEffort: z.string().nullable().optional(),
  title: z.string(),
  status: z.enum(['draft', 'queued', 'running', 'idle', 'completed', 'failed', 'cancelled']),
  sessionId: z.string().nullable(),
  workingDirectory: z.string().nullable(),
  startedAt: isoDate.nullable(),
  completedAt: isoDate.nullable(),
  summary: z.string(),
  draftPrompt: z.string().nullable(),
  createdAt: isoDate,
  updatedAt: isoDate
})
const agentMessage = z.object({
  id: identifier,
  runId: identifier,
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  eventType: z.string().nullable(),
  toolName: z.string().nullable(),
  toolStatus: z.enum(['completed', 'failed']).optional(),
  toolKind: z.enum(['read', 'search', 'edit', 'command', 'browser', 'other']).optional(),
  toolSummary: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: isoDate
})
const artifact = z.object({
  id: identifier,
  runId: identifier,
  projectId: identifier.nullable(),
  relativePath: z.string(),
  label: z.string(),
  mimeType: z.string().nullable(),
  createdAt: isoDate
})
const morningBriefing = z.object({
  id: identifier,
  reportDate: z.string(),
  timezone: z.string(),
  status: z.enum(['completed', 'failed']),
  headline: z.string(),
  body: z.string(),
  narration: z.string(),
  estimatedDurationSeconds: z.number().int(),
  sourceBriefingIds: z.array(identifier),
  signalIds: z.array(identifier),
  generatedAt: isoDate,
  error: z.string().nullable(),
  generation: z.enum(['agent', 'deterministic'])
})
const workAssistantTaskContext = z.object({
  projectId: identifier,
  goalId: identifier,
  milestoneId: identifier,
  projectName: z.string(),
  goalTitle: z.string(),
  milestoneTitle: z.string()
})
const workAssistantActionOption = z.object({
  id: identifier,
  label: z.string(),
  style: z.enum(['primary', 'secondary', 'quiet']),
  capability: z.enum([
    'project.list', 'project.inspect', 'project.create', 'project.update', 'project.pause',
    'agent-run.find', 'agent-run.inspect', 'agent-run.open', 'agent-run.create', 'agent-run.update',
    'agent-run.archive', 'agent-run.send', 'goal.manage', 'inbox.manage', 'files.search', 'files.read',
    'web.search', 'web.read', 'briefing.read', 'briefing.generate', 'automation.manage', 'assistant.dismiss'
  ]),
  payload: z.record(z.string(), z.unknown())
})
const workAssistantAction = z.object({
  id: identifier,
  title: z.string(),
  description: z.string(),
  status: z.enum(['pending', 'accepted', 'dismissed', 'expired']),
  context: z.string().nullable(),
  options: z.array(workAssistantActionOption),
  acceptedOptionId: identifier.nullable(),
  createdAt: isoDate,
  resolvedAt: isoDate.nullable()
})
const assistantMessage = z.object({
  id: identifier,
  briefingId: identifier.nullable(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  attachments: z.array(attachment),
  taskContext: workAssistantTaskContext.nullable(),
  linkedRunId: identifier.nullable().optional(),
  actions: z.array(workAssistantAction).optional(),
  createdAt: isoDate
})
const chatRecord = z.object({
  id: chatRecordIdentifier,
  chatId: identifier,
  chatKind: z.enum(['assistant', 'agent']),
  kind: z.enum(['message', 'process', 'briefing']),
  createdAt: isoDate,
  completedAt: isoDate.nullable(),
  assistantMessage: assistantMessage.nullable(),
  agentMessages: z.array(agentMessage),
  morningBriefing: morningBriefing.nullable()
}).superRefine((record, context) => {
  const reject = (message: string): void => {
    context.addIssue({ code: 'custom', message })
  }
  if (record.kind !== 'process' && record.completedAt !== null) {
    reject('Only process blocks may contain completedAt.')
  }
  if (record.chatKind === 'assistant') {
    if (record.kind === 'message' && record.assistantMessage === null) reject('Assistant message block requires assistantMessage.')
    if (record.kind === 'briefing' && record.morningBriefing === null) reject('Briefing block requires morningBriefing.')
    if (record.kind === 'process') reject('Assistant chat cannot contain process blocks.')
    if (record.agentMessages.length > 0) reject('Assistant chat cannot contain Agent messages.')
    if (record.kind !== 'message' && record.assistantMessage !== null) reject('Only message blocks may contain assistantMessage.')
    if (record.kind !== 'briefing' && record.morningBriefing !== null) reject('Only briefing blocks may contain morningBriefing.')
    return
  }
  if (record.kind === 'briefing') reject('Agent chat cannot contain briefing blocks.')
  if (record.assistantMessage !== null || record.morningBriefing !== null) {
    reject('Agent chat cannot contain Assistant payloads.')
  }
  if (record.agentMessages.length === 0) reject('Agent chat block requires Agent messages.')
  if (record.kind === 'message' && record.agentMessages.length !== 1) reject('Agent message block requires exactly one message.')
  if (record.agentMessages.some((message) => message.runId !== record.chatId)) {
    reject('Agent message runId must match chatId.')
  }
})
const chatPage = z.object({
  chatId: identifier,
  chatKind: z.enum(['assistant', 'agent']),
  records: z.array(chatRecord).max(100),
  hasMore: z.boolean(),
  nextBefore: chatRecordIdentifier.nullable()
}).superRefine((page, context) => {
  if (page.hasMore && page.records.length === 0) {
    context.addIssue({ code: 'custom', path: ['records'], message: 'A paged chat window cannot be empty.' })
  }
  if (page.records.some((record) => record.chatId !== page.chatId || record.chatKind !== page.chatKind)) {
    context.addIssue({ code: 'custom', path: ['records'], message: 'Chat records must match their page.' })
  }
  const expectedCursor = page.hasMore ? page.records[0]?.id ?? null : null
  if (page.nextBefore !== expectedCursor) {
    context.addIssue({ code: 'custom', path: ['nextBefore'], message: 'Chat history cursor must reference the first record.' })
  }
})
const modelLabels = z.object({
  workAssistant: z.string(),
  providers: z.object({ pi: z.string(), codex: z.string(), claude: z.string(), opencode: z.string() })
})

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
    runs: z.array(z.object({ run: agentRun, messages: z.array(agentMessage), artifacts: z.array(artifact) })),
    chatPages: z.array(chatPage).optional()
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
    payload: z.unknown(),
    sourceDeviceId: identifier,
    status: z.enum(['queued', 'delivered', 'executing', 'completed', 'failed']),
    result: z.unknown().nullable(),
    error: z.string().nullable(),
    createdAt: isoDate,
    updatedAt: isoDate
  })
} satisfies { [TType in CompanionEventType]: z.ZodType<CompanionRelayEventPayloadMap[TType]> }

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
}).transform((event, context) => {
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
    return z.NEVER
  }
  // Persist the parsed value, not just the validation result. Several payload
  // schemas trim identifiers and bounded user input; returning the original
  // object would let whitespace-padded values bypass those bounds.
  return { ...event, payload: parsedPayload.data } as CompanionSyncEventInput
})

export const syncEventBatchSchema = z.object({ events: z.array(syncEventSchema).min(1).max(100) })

export const encryptedSyncEventSchema = z.object({
  ...eventBase,
  type: z.enum(companionEventTypes),
  entityType: z.enum(companionEntityTypes),
  payload: companionEncryptedEnvelopeSchema
}).superRefine((event, context) => {
  const expectedEntityType = companionEventDefinitions[event.type]
  if (event.entityType !== expectedEntityType) {
    context.addIssue({
      code: 'custom',
      path: ['entityType'],
      message: `Event ${event.type} must use entity type ${expectedEntityType}.`
    })
  }
}).transform((event) => event as CompanionEncryptedSyncEventInput)

export const encryptedSyncEventBatchSchema = z.object({
  events: z.array(encryptedSyncEventSchema).min(1).max(100)
})

const commandBase = { commandId: identifier, protocolVersion, createdAt: isoDate }
const commandPayloadSchemas = {
  'assistant.send-message': z.object({ prompt: z.string().trim().min(1).max(20_000), attachments: z.array(attachment).max(4).optional() }),
  'assistant.execute-action': z.object({ messageId: identifier, proposalId: identifier, optionId: identifier }),
  'agent.send-message': z.object({ runId: identifier, prompt: z.string().trim().min(1).max(20_000), attachments: z.array(attachment).max(4).optional(), clientMessageId: identifier.optional() }),
  'agent.stop-message': z.object({ runId: identifier }),
  'agent.create-session': z.object({
    runId: identifier,
    projectId: identifier.optional(),
    title: z.string().trim().min(1).max(200)
  }),
  'agent.rename-session': z.object({ runId: identifier, title: z.string().trim().min(1).max(200) }),
  'agent.update-draft-prompt': z.object({ runId: identifier, draftPrompt: z.string().max(20_000) }),
  'agent.archive-session': z.object({ runId: identifier }),
  'chat.load-history': z.object({
    chatKind: z.enum(['assistant', 'agent']),
    chatId: identifier,
    before: chatRecordIdentifier.optional(),
    limit: z.number().int().min(1).max(100)
  }),
  'artifact.request-upload': z.object({ artifactId: identifier }),
  'decision.update-status': z.object({ decisionId: identifier, status: z.enum(['inbox', 'in_progress', 'waiting', 'resolved', 'ignored']) }),
  'decision.handle': z.object({ decisionId: identifier, runId: identifier }),
  'project.update': z.object({ project })
} satisfies Record<(typeof companionCommandTypes)[number], z.ZodType>

export const commandSchema = z.object({
  ...commandBase,
  type: z.enum(companionCommandTypes),
  payload: z.unknown()
}).transform((command, context) => {
  const parsedPayload = commandPayloadSchemas[command.type].safeParse(command.payload)
  if (!parsedPayload.success) {
    for (const issue of parsedPayload.error.issues) {
      context.addIssue({ ...issue, path: ['payload', ...issue.path] })
    }
    return z.NEVER
  }
  return { ...command, payload: parsedPayload.data } as CompanionCommandInput
})

export const companionCommandSchema = z.object({
  ...commandBase,
  type: z.enum(companionCommandTypes),
  payload: z.unknown(),
  sourceDeviceId: identifier,
  status: z.enum(['queued', 'delivered', 'executing', 'completed', 'failed']),
  result: z.unknown().nullable(),
  error: z.string().max(8_000).nullable(),
  updatedAt: isoDate
}).transform((command, context) => {
  const parsedPayload = commandPayloadSchemas[command.type].safeParse(command.payload)
  if (!parsedPayload.success) {
    for (const issue of parsedPayload.error.issues) {
      context.addIssue({ ...issue, path: ['payload', ...issue.path] })
    }
    return z.NEVER
  }
  return { ...command, payload: parsedPayload.data } as CompanionCommand
})

export const encryptedCommandSchema = z.object({
  ...commandBase,
  type: z.enum(companionCommandTypes),
  payload: companionEncryptedEnvelopeSchema
}).transform((command) => command as CompanionEncryptedCommandInput)

export const companionEncryptedCommandSchema = z.object({
  ...commandBase,
  type: z.enum(companionCommandTypes),
  payload: companionEncryptedEnvelopeSchema,
  sourceDeviceId: identifier,
  status: z.enum(['queued', 'delivered', 'executing', 'completed', 'failed']),
  result: z.null(),
  error: z.null(),
  updatedAt: isoDate
}).transform((command) => command as CompanionEncryptedCommand)

export const commandUpdateSchema = z.object({
  status: z.enum(['delivered', 'executing', 'completed', 'failed'])
}).strict()
