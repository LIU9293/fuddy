import { BrowserWindow, dialog, ipcMain, shell, systemPreferences } from 'electron'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { DecisionStatus, GoalStatus, PermissionIntent } from '../../shared/contracts'
import { evaluateAggressivePermission } from '../../shared/permissions'
import { createProjectSchema, updateProjectSchema } from '../../shared/project-validation'
import { connectorCatalog } from '../connectors/connector-runtime'
import { listProjectAnalyticsProfileSummaries } from '../analytics/project-analytics-profiles'
import { getCapabilities } from '../services/capabilities'
import { discoverCodingAgentModels } from '../services/coding-agent-models'
import { collectGitWorkingTreeSummary } from '../services/git-working-tree'
import { requestMacMicrophoneAccess } from '../services/microphone-permissions'
import {
  agentEndpointSchema,
  configureConnectorSchema,
  configurePostgresSchema,
  connectorIdSchema,
  connectorToggleSchema,
  createAgentRunDraftSchema,
  createDecisionSchema,
  dispatchProjectAgentSchema,
  dispatchTaskSchema,
  permissionIntentSchema,
  renameAgentRunSchema,
  respondAgentApprovalSchema,
  saveAutomationSchema,
  sendAgentRunMessageSchema,
  ttsEndpointSchema,
  updateDecisionSchema,
  workspacePathSchema,
  workspaceProjectIdSchema,
  workAssistantImageSchema
} from './schemas'
import type { IpcContext } from './context'

export function registerSettingsIpc(context: IpcContext): void {
  const {
    database,
    dispatcher,
    connectorRuntime,
    decisionRemediationService,
    credentialVault,
    dailyBriefingService,
    morningBriefingService,
    goalTrackingService,
    providerSettings,
    asrService,
    ttsService,
    workspaceFiles,
    automationRuntime,
    projectAgentIntegration,
    companionSync,
    persistAttachments
  } = context
  ipcMain.handle('provider:configure-agent', (_event, rawInput: unknown) => {
    const input = z
      .object({
        primary: agentEndpointSchema,
        backup: agentEndpointSchema,
        backupEnabled: z.boolean()
      })
      .parse(rawInput)
    const settings = providerSettings.configureAgent(input)
    companionSync.publishModelLabels()
    return settings
  })

  ipcMain.handle('provider:configure-coding-agents', (_event, rawInput: unknown) => {
    const model = z.object({
      defaultModel: z.string().trim().max(300),
      defaultReasoningEffort: z.string().trim().max(100)
    })
    const input = z
      .object({
        defaultAgent: z.enum(['codex', 'claude', 'opencode']),
        codex: model,
        claude: model,
        opencode: model
      })
      .parse(rawInput)
    const settings = providerSettings.configureCodingAgents(input)
    companionSync.publishModelLabels()
    return settings
  })

  ipcMain.handle('provider:list-coding-agent-models', () => discoverCodingAgentModels())

  ipcMain.handle('provider:configure-asr', (_event, rawInput: unknown) => {
    const input = z
      .object({
        mode: z.enum(['local-first', 'cloud']),
        cloudBaseUrl: z.string().trim().min(1).max(1_000),
        cloudModel: z.string().trim().min(1).max(200),
        cloudApiKey: z.string().trim().max(4_000).optional(),
        fallbackToCloud: z.boolean()
      })
      .parse(rawInput)
    return providerSettings.configureAsr(input)
  })

  ipcMain.handle('asr:model-status', () => asrService.getModelStatus())
  ipcMain.handle('asr:download-model', () => asrService.downloadModel())
  ipcMain.handle('asr:delete-model', () => asrService.deleteModel())
  ipcMain.handle('asr:transcribe', (_event, rawInput: unknown) => {
    const input = z
      .object({
        audioDataUrl: z.string().max(35_000_000),
        language: z.string().trim().max(20).optional(),
        prompt: z.string().trim().max(1_000).optional()
      })
      .parse(rawInput)
    return asrService.transcribe(input)
  })

  ipcMain.handle('provider:configure-tts', (_event, rawInput: unknown) => {
    const input = z
      .object({
        primary: ttsEndpointSchema,
        backup: ttsEndpointSchema,
        backupEnabled: z.boolean()
      })
      .parse(rawInput)
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
