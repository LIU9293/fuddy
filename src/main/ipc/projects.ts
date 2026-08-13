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

export function registerProjectIpc(context: IpcContext): void {
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
  ipcMain.handle('project:update', (_event, rawInput: unknown) => {
    return database.updateProject(updateProjectSchema.parse(rawInput))
  })

  ipcMain.handle('project:create', (_event, rawInput: unknown) => {
    return database.createProject(createProjectSchema.parse(rawInput))
  })

  ipcMain.handle('goal:create', (_event, rawInput: unknown) => {
    const input = z
      .object({
        projectId: z.string().trim().min(1).max(200),
        prompt: z.string().trim().min(1).max(4_000),
        attachments: z.array(workAssistantImageSchema).max(4).optional(),
        priority: z.enum(['P0', 'P1', 'P2']).optional(),
        status: z.enum(['planned', 'active']).optional()
      })
      .parse(rawInput)
    const evidenceRefs = persistAttachments(input.projectId, `goals/${randomUUID()}`, input.attachments)
    return goalTrackingService.createFromPrompt(input.projectId, input.prompt, {
      priority: input.priority,
      status: input.status,
      attachments: input.attachments,
      evidenceRefs
    })
  })

  ipcMain.handle('goal:check', (_event, rawId: unknown) => {
    return goalTrackingService.check(z.string().trim().min(1).max(200).parse(rawId))
  })

  ipcMain.handle('goal:update-status', (_event, rawInput: unknown) => {
    const input = z
      .object({
        id: z.string().trim().min(1).max(200),
        status: z.enum(['planned', 'active', 'at-risk', 'completed', 'paused'])
      })
      .parse(rawInput)
    return database.updateGoalStatus(input.id, input.status as GoalStatus)
  })

  ipcMain.handle('goal:update-priority', (_event, rawInput: unknown) => {
    const input = z
      .object({
        id: z.string().trim().min(1).max(200),
        priority: z.enum(['P0', 'P1', 'P2'])
      })
      .parse(rawInput)
    return database.updateGoalPriority(input.id, input.priority)
  })

  const goalMilestoneSchema = z.object({
    goalId: z.string().trim().min(1).max(200),
    milestoneId: z.string().trim().min(1).max(200)
  })

  ipcMain.handle('goal:complete-milestone', (_event, rawInput: unknown) => {
    const input = goalMilestoneSchema.parse(rawInput)
    return database.completeGoalMilestone(input.goalId, input.milestoneId)
  })

  ipcMain.handle('goal:delete-milestone', (_event, rawInput: unknown) => {
    const input = goalMilestoneSchema.parse(rawInput)
    return database.deleteGoalMilestone(input.goalId, input.milestoneId)
  })

  ipcMain.handle('decision:create', (_event, rawInput: unknown) => {
    const input = createDecisionSchema.parse(rawInput)
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
