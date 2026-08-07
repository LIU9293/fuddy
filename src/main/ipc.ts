import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { z } from 'zod'
import type { DecisionStatus, GoalStatus, PermissionIntent } from '../shared/contracts'
import { evaluateAggressivePermission } from '../shared/permissions'
import { connectorCatalog, ConnectorRuntime } from './connectors/connector-runtime'
import { getCapabilities } from './services/capabilities'
import { CredentialVault } from './services/credential-vault'
import { DailyBriefingService } from './services/daily-briefing'
import { MorningBriefingService } from './services/morning-briefing'
import { ProviderSettingsService } from './services/provider-settings'
import { AppDatabase } from './services/database'
import { TaskDispatcher } from './services/task-dispatcher'
import { TtsService } from './services/tts-service'
import { GoalTrackingService } from './services/goal-tracking'
import { WorkspaceFilesService } from './services/workspace-files'
import { AutomationRuntime } from './services/automation-runtime'
import { listProjectAnalyticsProfileSummaries } from './analytics/project-analytics-profiles'
import { ProjectAgentIntegrationService } from './services/project-agent-integration'
import { discoverCodingAgentModels } from './services/coding-agent-models'
import { CompanionSyncService } from './services/companion-sync'

const createDecisionSchema = z.object({
  projectId: z.string().nullable(),
  goalId: z.string().nullable().optional(),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(2_000).optional()
})

const projectProfileSchema = z.object({
  productType: z.string().trim().min(1).max(200),
  stage: z.string().trim().min(1).max(200),
  mission: z.string().trim().min(1).max(2_000),
  vision: z.string().trim().min(1).max(2_000),
  repoPath: z.string().trim().max(2_000),
  workspaceRoots: z.array(z.object({
    id: z.string().trim().min(1).max(100),
    label: z.string().trim().min(1).max(200),
    path: z.string().trim().min(1).max(2_000)
  })).max(12),
  primaryWorkspaceRootId: z.string().trim().min(1).max(100).nullable(),
  defaultAgent: z.enum(['pi', 'codex', 'claude', 'opencode']),
  websiteUrl: z.url().nullable(),
  surfaces: z.array(z.string().trim().min(1).max(200)).max(30),
  focusAreas: z.array(z.string().trim().min(1).max(200)).max(30),
  dataSources: z.array(z.string().trim().min(1).max(300)).max(50),
  nextMoves: z.array(z.string().trim().min(1).max(500)).max(30),
  currentState: z.object({
    summary: z.string().trim().min(1).max(2_000),
    facts: z.array(z.string().trim().min(1).max(500)).max(30),
    source: z.enum(['user', 'agent', 'connector']),
    updatedAt: z.iso.datetime().nullable()
  })
})

const updateProjectSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(2_000),
  focus: z.string().trim().min(1).max(500),
  status: z.enum(['active', 'watching', 'paused']),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  profile: projectProfileSchema
})

const updateDecisionSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['inbox', 'later', 'resolved'])
})

const permissionIntentSchema = z.object({
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

const dispatchTaskSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  projectId: z.string().nullable(),
  goalId: z.string().nullable().optional(),
  milestoneId: z.string().nullable().optional(),
  provider: z.enum(['pi', 'codex', 'claude', 'opencode']).optional(),
  title: z.string().trim().max(200).optional(),
  workingDirectory: z.string().trim().max(2_000).nullable().optional(),
  prompt: z.string().trim().min(1).max(20_000)
})

const createAgentRunDraftSchema = dispatchTaskSchema.omit({ requestId: true, prompt: true }).extend({
  title: z.string().trim().min(1).max(200)
})

const dispatchProjectAgentSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  projectId: z.enum(['vows', 'ai-marketing']),
  prompt: z.string().trim().min(1).max(20_000)
})

const sendAgentRunMessageSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  runId: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(20_000)
})

const renameAgentRunSchema = z.object({
  id: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(200)
})

const respondAgentApprovalSchema = z.object({
  requestId: z.string().trim().min(1).max(300),
  decision: z.enum(['approve', 'deny'])
})

const workspaceProjectIdSchema = z.string().trim().min(1).max(200).nullable()
const workspacePathSchema = z.string().max(2_000)

const connectorIdSchema = z.string().trim().min(1).max(200)

const connectorToggleSchema = z.object({
  id: connectorIdSchema,
  enabled: z.boolean()
})

const configurePostgresSchema = z.object({
  projectId: z.string().trim().min(1).max(200),
  connectionString: z.string().trim().min(1).max(4_000),
  metricView: z.string().trim().max(200).optional(),
  analyticsProfile: z.string().trim().max(200).optional()
})

const configureConnectorSchema = z.discriminatedUnion('kind', [
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

const agentEndpointSchema = z.object({
  mode: z.enum(['cc-switch-codex-oauth', 'openai-compatible']),
  baseUrl: z.string().trim().min(1).max(1_000),
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().trim().max(4_000).optional()
})

const ttsEndpointSchema = z.object({
  mode: z.enum(['system', 'openai-compatible', 'elevenlabs']),
  baseUrl: z.string().trim().min(1).max(1_000),
  model: z.string().trim().max(200),
  voice: z.string().trim().max(300),
  instructions: z.string().trim().max(1_000),
  apiKey: z.string().trim().max(4_000).optional()
})

const workAssistantImageSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  dataUrl: z.string().max(7_100_000)
}).superRefine((image, context) => {
  if (!image.dataUrl.startsWith(`data:${image.mimeType};base64,`)) {
    context.addIssue({ code: 'custom', path: ['dataUrl'], message: '图片数据格式无效' })
  }
})

const saveAutomationSchema = z.object({
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

export function registerIpc(
  database: AppDatabase,
  dispatcher: TaskDispatcher,
  connectorRuntime: ConnectorRuntime,
  credentialVault: CredentialVault,
  dailyBriefingService: DailyBriefingService,
  morningBriefingService: MorningBriefingService,
  goalTrackingService: GoalTrackingService,
  providerSettings: ProviderSettingsService,
  ttsService: TtsService,
  workspaceFiles: WorkspaceFilesService,
  automationRuntime: AutomationRuntime,
  projectAgentIntegration: ProjectAgentIntegrationService,
  companionSync: CompanionSyncService
): void {
  ipcMain.handle('app:get-bootstrap', () => {
    const settings = providerSettings.getPublicSettings()
    return database.getBootstrap(
      getCapabilities(settings),
      connectorCatalog,
      listProjectAnalyticsProfileSummaries(),
      credentialVault.getStatus(),
      settings
    )
  })

  ipcMain.handle('capability:request-computer-permissions', async () => {
    if (process.platform !== 'darwin') return getCapabilities(providerSettings.getPublicSettings())
    const {
      hasRequiredMacOSPermissions,
      openMacOSScreenRecordingSettings,
      requestMacOSPermissions
    } = await import('@trycua/cua-driver/electron')
    const status = requestMacOSPermissions()
    if (!hasRequiredMacOSPermissions(status) && !status.screenRecording) {
      await openMacOSScreenRecordingSettings()
    }
    return getCapabilities(providerSettings.getPublicSettings())
  })

  ipcMain.handle('project:update', (_event, rawInput: unknown) => {
    return database.updateProject(updateProjectSchema.parse(rawInput))
  })

  ipcMain.handle('goal:create', (_event, rawInput: unknown) => {
    const input = z.object({
      projectId: z.string().trim().min(1).max(200),
      prompt: z.string().trim().min(1).max(4_000),
      priority: z.enum(['P0', 'P1', 'P2']).optional(),
      status: z.enum(['planned', 'active']).optional()
    }).parse(rawInput)
    return goalTrackingService.createFromPrompt(input.projectId, input.prompt, {
      priority: input.priority,
      status: input.status
    })
  })

  ipcMain.handle('goal:check', (_event, rawId: unknown) => {
    return goalTrackingService.check(z.string().trim().min(1).max(200).parse(rawId))
  })

  ipcMain.handle('goal:update-status', (_event, rawInput: unknown) => {
    const input = z.object({
      id: z.string().trim().min(1).max(200),
      status: z.enum(['planned', 'active', 'at-risk', 'completed', 'paused'])
    }).parse(rawInput)
    return database.updateGoalStatus(input.id, input.status as GoalStatus)
  })

  ipcMain.handle('goal:update-priority', (_event, rawInput: unknown) => {
    const input = z.object({
      id: z.string().trim().min(1).max(200),
      priority: z.enum(['P0', 'P1', 'P2'])
    }).parse(rawInput)
    return database.updateGoalPriority(input.id, input.priority)
  })

  ipcMain.handle('decision:create', (_event, rawInput: unknown) => {
    return database.createDecision(createDecisionSchema.parse(rawInput))
  })

  ipcMain.handle('decision:update-status', (_event, rawInput: unknown) => {
    const input = updateDecisionSchema.parse(rawInput)
    return database.updateDecisionStatus(input.id, input.status as DecisionStatus)
  })

  ipcMain.handle('permission:evaluate', (_event, rawInput: unknown) => {
    const intent = permissionIntentSchema.parse(rawInput) as PermissionIntent
    const evaluation = evaluateAggressivePermission(intent)
    database.recordPermissionEvaluation(intent, evaluation)
    return evaluation
  })

  ipcMain.handle('task:dispatch', (event, rawInput: unknown) => {
    const input = dispatchTaskSchema.parse(rawInput)
    return dispatcher.dispatch(input, (update) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('agent-run:update', { requestId: input.requestId, runId: '', update })
      }
    })
  })

  ipcMain.handle('agent-run:create-draft', (_event, rawInput: unknown) => {
    return dispatcher.createDraft(createAgentRunDraftSchema.parse(rawInput))
  })

  ipcMain.handle('project-agent:dispatch', (event, rawInput: unknown) => {
    const input = dispatchProjectAgentSchema.parse(rawInput)
    return projectAgentIntegration.dispatch(input, (update) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('agent-run:update', { requestId: input.requestId, runId: '', update })
      }
    })
  })

  ipcMain.handle('agent-run:get', (_event, rawId: unknown) => {
    return dispatcher.getDetail(z.string().trim().min(1).max(200).parse(rawId))
  })

  ipcMain.handle('agent-run:rename', (_event, rawInput: unknown) => {
    const input = renameAgentRunSchema.parse(rawInput)
    return database.renameAgentRun(input.id, input.title)
  })

  ipcMain.handle('agent-run:archive', (_event, rawId: unknown) => {
    database.archiveAgentRun(z.string().trim().min(1).max(200).parse(rawId))
  })

  ipcMain.handle('companion:get-status', () => companionSync.getStatus())

  ipcMain.handle('companion:begin-pairing', (_event, rawRelayUrl: unknown) => {
    return companionSync.beginPairing(z.url().parse(rawRelayUrl))
  })

  ipcMain.handle('companion:disconnect', () => companionSync.disconnect())

  ipcMain.handle('companion:sync-now', () => companionSync.syncNow())

  ipcMain.handle('agent-run:send', (event, rawInput: unknown) => {
    const input = sendAgentRunMessageSchema.parse(rawInput)
    return dispatcher.sendMessage(input.runId, input.prompt, (update) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('agent-run:update', { requestId: input.requestId, runId: input.runId, update })
      }
    })
  })

  ipcMain.handle('agent-run:approval', (_event, rawInput: unknown) => {
    const input = respondAgentApprovalSchema.parse(rawInput)
    dispatcher.respondToApproval(input.requestId, input.decision)
  })

  ipcMain.handle('workspace-files:list', (_event, rawProjectId: unknown) => {
    return workspaceFiles.list(workspaceProjectIdSchema.parse(rawProjectId))
  })

  ipcMain.handle('workspace-files:read', (_event, rawInput: unknown) => {
    const input = z.object({ projectId: workspaceProjectIdSchema, relativePath: workspacePathSchema }).parse(rawInput)
    return workspaceFiles.read(input.projectId, input.relativePath)
  })

  ipcMain.handle('workspace-files:write', (_event, rawInput: unknown) => {
    const input = z.object({
      projectId: workspaceProjectIdSchema,
      relativePath: workspacePathSchema,
      content: z.string().max(5_000_000)
    }).parse(rawInput)
    return workspaceFiles.write(input.projectId, input.relativePath, input.content)
  })

  ipcMain.handle('workspace-files:create-folder', (_event, rawInput: unknown) => {
    const input = z.object({ projectId: workspaceProjectIdSchema, relativePath: workspacePathSchema }).parse(rawInput)
    return workspaceFiles.createFolder(input.projectId, input.relativePath)
  })

  ipcMain.handle('workspace-files:import', async (event, rawInput: unknown) => {
    const input = z.object({
      projectId: workspaceProjectIdSchema,
      targetDirectory: workspacePathSchema.optional()
    }).parse(rawInput)
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const options = {
      title: '导入项目文件',
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled) return []
    return workspaceFiles.importFiles(input.projectId, result.filePaths, input.targetDirectory)
  })

  ipcMain.handle('workspace-files:reveal', (_event, rawInput: unknown) => {
    const input = z.object({
      projectId: workspaceProjectIdSchema,
      relativePath: workspacePathSchema.optional()
    }).parse(rawInput)
    shell.showItemInFolder(workspaceFiles.resolvePath(input.projectId, input.relativePath))
  })

  ipcMain.handle('connector:run', (_event, rawId: unknown) => {
    return connectorRuntime.runConnector(connectorIdSchema.parse(rawId))
  })

  ipcMain.handle('connector:run-all', (_event, rawProjectId: unknown) => {
    const projectId = z.string().nullable().parse(rawProjectId)
    return connectorRuntime.runConnectors(projectId)
  })

  ipcMain.handle('connector:set-enabled', (_event, rawInput: unknown) => {
    const input = connectorToggleSchema.parse(rawInput)
    return connectorRuntime.setEnabled(input.id, input.enabled)
  })

  ipcMain.handle('connector:configure-postgres', (_event, rawInput: unknown) => {
    return connectorRuntime.configurePostgres(configurePostgresSchema.parse(rawInput))
  })

  ipcMain.handle('connector:configure', (_event, rawInput: unknown) => {
    const input = configureConnectorSchema.parse(rawInput)
    if (input.kind === 'cloudflare') return connectorRuntime.configureCloudflare(input)
    if (input.kind === 'ga4') return connectorRuntime.configureGa4(input)
    return connectorRuntime.configureProjectAgent(input)
  })

  ipcMain.handle('briefing:generate-daily', (_event, rawProjectId: unknown) => {
    return dailyBriefingService.generate(z.string().trim().min(1).max(200).parse(rawProjectId))
  })

  ipcMain.handle('briefing:generate-morning', () => {
    return morningBriefingService.generate()
  })

  ipcMain.handle('briefing:ask', (event, rawInput: unknown) => {
    const input = z.object({
      requestId: z.string().trim().min(1).max(200),
      briefingId: z.string().trim().min(1).max(200).nullable(),
      question: z.string().trim().min(1).max(4_000),
      attachments: z.array(workAssistantImageSchema).max(4),
      taskContext: z.object({
        projectId: z.string().trim().min(1).max(200),
        goalId: z.string().trim().min(1).max(200),
        milestoneId: z.string().trim().min(1).max(200)
      }).nullable().optional()
    }).parse(rawInput)
    return morningBriefingService.ask(input.briefingId, input.question, input.taskContext ?? null, input.attachments, (update) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('briefing:ask-update', {
          requestId: input.requestId,
          briefingId: input.briefingId,
          update
        })
      }
    })
  })

  ipcMain.handle('provider:configure-agent', (_event, rawInput: unknown) => {
    const input = z.object({
      primary: agentEndpointSchema,
      backup: agentEndpointSchema,
      backupEnabled: z.boolean()
    }).parse(rawInput)
    return providerSettings.configureAgent(input)
  })

  ipcMain.handle('provider:configure-coding-agents', (_event, rawInput: unknown) => {
    const model = z.object({ defaultModel: z.string().trim().max(300) })
    const input = z.object({
      defaultAgent: z.enum(['codex', 'claude', 'opencode']),
      codex: model,
      claude: model,
      opencode: model
    }).parse(rawInput)
    return providerSettings.configureCodingAgents(input)
  })

  ipcMain.handle('provider:list-coding-agent-models', () => discoverCodingAgentModels())

  ipcMain.handle('provider:configure-tts', (_event, rawInput: unknown) => {
    const input = z.object({
      primary: ttsEndpointSchema,
      backup: ttsEndpointSchema,
      backupEnabled: z.boolean()
    }).parse(rawInput)
    return providerSettings.configureTts(input)
  })

  ipcMain.handle('tts:get-briefing-audio', (_event, rawId: unknown) => {
    return ttsService.getBriefingAudio(z.string().trim().min(1).max(200).parse(rawId))
  })

  ipcMain.handle('tts:test', () => ttsService.testProvider())
  ipcMain.handle('tts:design-elevenlabs-voice', () => ttsService.designElevenLabsVoice())

  ipcMain.handle('automation:save', (_event, rawInput: unknown) => {
    return automationRuntime.save(saveAutomationSchema.parse(rawInput))
  })

  ipcMain.handle('automation:set-enabled', (_event, rawInput: unknown) => {
    const input = z.object({ id: z.string().trim().min(1).max(200), enabled: z.boolean() }).parse(rawInput)
    return automationRuntime.setEnabled(input.id, input.enabled)
  })

  ipcMain.handle('automation:run', (_event, rawId: unknown) => {
    return automationRuntime.runNow(z.string().trim().min(1).max(200).parse(rawId))
  })

  ipcMain.handle('automation:approve', (_event, rawId: unknown) => {
    return automationRuntime.approve(z.string().trim().min(1).max(200).parse(rawId))
  })

}
