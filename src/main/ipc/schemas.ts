import { z } from 'zod'

export const workAssistantImageSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    dataUrl: z.string().max(7_100_000)
  })
  .superRefine((image, context) => {
    if (!image.dataUrl.startsWith(`data:${image.mimeType};base64,`)) {
      context.addIssue({ code: 'custom', path: ['dataUrl'], message: '图片数据格式无效' })
    }
  })

export const createDecisionSchema = z.object({
  projectId: z.string().nullable(),
  goalId: z.string().nullable().optional(),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(2_000).optional(),
  attachments: z.array(workAssistantImageSchema).max(4).optional()
})

export const updateDecisionSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['inbox', 'in_progress', 'waiting', 'resolved', 'ignored'])
})

export const permissionIntentSchema = z.object({
  tool: z.string().min(1),
  action: z.string().min(1),
  target: z.string().optional(),
  command: z.string().optional(),
  description: z.string().optional(),
  projectRoot: z.string().optional(),
  irreversible: z.boolean().optional(),
  production: z.boolean().optional(),
  affectsMoney: z.boolean().optional(),
  handlesCredentials: z.boolean().optional(),
  transmitsCredentials: z.boolean().optional(),
  changesSecuritySettings: z.boolean().optional(),
  deletesAccount: z.boolean().optional()
})

export const dispatchTaskSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  projectId: z.string().nullable(),
  decisionId: z.string().trim().min(1).max(200).nullable().optional(),
  goalId: z.string().nullable().optional(),
  milestoneId: z.string().nullable().optional(),
  provider: z.enum(['pi', 'codex', 'claude', 'opencode']).optional(),
  title: z.string().trim().max(200).optional(),
  workingDirectory: z.string().trim().max(2_000).nullable().optional(),
  prompt: z.string().trim().min(1).max(20_000)
})

export const createAgentRunDraftSchema = dispatchTaskSchema.omit({ requestId: true, prompt: true }).extend({
  title: z.string().trim().min(1).max(200),
  draftPrompt: z.string().trim().max(20_000).nullable().optional()
})

export const dispatchProjectAgentSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  projectId: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(20_000)
})

export const sendAgentRunMessageSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  runId: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(20_000),
  attachments: z.array(workAssistantImageSchema).max(4).optional()
})

export const renameAgentRunSchema = z.object({
  id: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(200)
})

export const updateAgentRunExecutionSettingsSchema = z.object({
  id: z.string().trim().min(1).max(200),
  provider: z.enum(['pi', 'codex', 'claude', 'opencode']),
  model: z.string().trim().max(300).nullable(),
  reasoningEffort: z.string().trim().max(100).nullable()
})

export const respondAgentApprovalSchema = z.object({
  requestId: z.string().trim().min(1).max(300),
  decision: z.enum(['approve', 'deny'])
})

export const workspaceProjectIdSchema = z.string().trim().min(1).max(200).nullable()
export const workspacePathSchema = z.string().max(2_000)

export const connectorIdSchema = z.string().trim().min(1).max(200)

export const connectorToggleSchema = z.object({
  id: connectorIdSchema,
  enabled: z.boolean()
})

export const configurePostgresSchema = z.object({
  projectId: z.string().trim().min(1).max(200),
  connectionString: z.string().trim().min(1).max(4_000),
  metricView: z.string().trim().max(200).optional(),
  analyticsProfile: z.string().trim().max(200).optional()
})

export const configureConnectorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('cloudflare'),
    projectId: z.string().trim().min(1).max(200),
    accountId: z.string().trim().min(1).max(100),
    zoneId: z.string().trim().max(100).optional(),
    apiToken: z.string().trim().max(4_000).optional()
  }),
  z.object({
    kind: z.literal('ga4'),
    projectId: z.string().trim().min(1).max(200),
    propertyId: z.string().trim().min(1).max(100),
    accessToken: z.string().trim().max(8_000).optional(),
    refreshToken: z.string().trim().max(8_000).optional(),
    clientId: z.string().trim().max(1_000).optional(),
    clientSecret: z.string().trim().max(4_000).optional()
  }),
  z.object({
    kind: z.literal('project-agent'),
    projectId: z.string().trim().min(1).max(200),
    agentName: z.string().trim().min(1).max(200),
    baseUrl: z.string().trim().min(1).max(2_000),
    statusPath: z.string().trim().max(500).optional(),
    apiKey: z.string().trim().max(8_000).optional()
  })
])

export const agentEndpointSchema = z.object({
  mode: z.enum(['cc-switch-codex-oauth', 'openai-compatible']),
  baseUrl: z.string().trim().min(1).max(1_000),
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().trim().max(4_000).optional()
})

export const ttsEndpointSchema = z.object({
  mode: z.enum(['system', 'openai-compatible', 'elevenlabs']),
  baseUrl: z.string().trim().min(1).max(1_000),
  model: z.string().trim().max(200),
  voice: z.string().trim().max(300),
  instructions: z.string().trim().max(1_000),
  apiKey: z.string().trim().max(4_000).optional()
})

export const saveAutomationSchema = z.object({
  id: z.string().trim().min(1).max(200).optional(),
  projectId: z.string().trim().min(1).max(200).nullable(),
  name: z.string().trim().min(1).max(200),
  scheduleDescription: z.string().trim().min(1).max(500),
  cronExpression: z.string().trim().min(1).max(200),
  timezone: z.string().trim().min(1).max(100),
  action: z.enum(['agent-task', 'run-connectors', 'check-goals', 'generate-briefing']),
  prompt: z.string().trim().max(20_000),
  agentProvider: z.enum(['pi', 'codex', 'claude', 'opencode']),
  enabled: z.boolean(),
  requiresConfirmation: z.boolean(),
  maxRetries: z.number().int().min(0).max(5),
  retryDelaySeconds: z.number().int().min(0).max(3_600)
})
