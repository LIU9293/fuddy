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
  updateDecisionSchema,
  workspacePathSchema,
  workspaceProjectIdSchema,
  workAssistantImageSchema
} from './schemas'
import type { IpcContext } from './context'

export function registerProjectIpc(context: IpcContext): void {
  const {
    database,
    dispatcher,
    connectorRuntime,
    decisionRemediationService,
    credentialVault,
    providerSettings,
    asrService,
    workspaceFiles,
    automationRuntime,
    projectAgentIntegration,
    companionSync,
    persistAttachments
  } = context
  ipcMain.handle('project:update', (_event, rawInput: unknown) => {
    return database.updateProject(updateProjectSchema.parse(rawInput))
  })

  ipcMain.handle('project:create', (_event, rawInput: unknown) => {
    return database.createProject(createProjectSchema.parse(rawInput))
  })

  ipcMain.handle('decision:create', (_event, rawInput: unknown) => {
    const input = createDecisionSchema.parse(rawInput)
    if (!database.decisionInboxEnabled) throw new Error('决策收件箱已下线。')
    const evidenceRefs = persistAttachments(input.projectId, `decisions/${randomUUID()}`, input.attachments)
    return database.createDecision({ ...input, evidenceRefs })
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
}
