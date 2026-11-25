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

export function registerWorkspaceIpc(context: IpcContext): void {
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
  ipcMain.handle('workspace-files:list', (_event, rawProjectId: unknown) => {
    return workspaceFiles.list(workspaceProjectIdSchema.parse(rawProjectId))
  })

  ipcMain.handle('workspace-files:read', (_event, rawInput: unknown) => {
    const input = z.object({ projectId: workspaceProjectIdSchema, relativePath: workspacePathSchema }).parse(rawInput)
    return workspaceFiles.read(input.projectId, input.relativePath)
  })

  ipcMain.handle('workspace-files:write', (_event, rawInput: unknown) => {
    const input = z
      .object({
        projectId: workspaceProjectIdSchema,
        relativePath: workspacePathSchema,
        content: z.string().max(5_000_000)
      })
      .parse(rawInput)
    return workspaceFiles.write(input.projectId, input.relativePath, input.content)
  })

  ipcMain.handle('workspace-files:create-folder', (_event, rawInput: unknown) => {
    const input = z.object({ projectId: workspaceProjectIdSchema, relativePath: workspacePathSchema }).parse(rawInput)
    return workspaceFiles.createFolder(input.projectId, input.relativePath)
  })

  ipcMain.handle('workspace-files:import', async (event, rawInput: unknown) => {
    const input = z
      .object({
        projectId: workspaceProjectIdSchema,
        targetDirectory: workspacePathSchema.optional()
      })
      .parse(rawInput)
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const options = {
      title: '导入项目文件',
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>
    }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    if (result.canceled) return []
    return workspaceFiles.importFiles(input.projectId, result.filePaths, input.targetDirectory)
  })

  ipcMain.handle('workspace-files:reveal', (_event, rawInput: unknown) => {
    const input = z
      .object({
        projectId: workspaceProjectIdSchema,
        relativePath: workspacePathSchema.optional()
      })
      .parse(rawInput)
    shell.showItemInFolder(workspaceFiles.resolvePath(input.projectId, input.relativePath))
  })

  ipcMain.handle('connector:run', (_event, rawId: unknown) => {
    return connectorRuntime.runConnector(connectorIdSchema.parse(rawId))
  })

  ipcMain.handle('connector:run-all', (_event, rawProjectId: unknown) => {
    const projectId = z.string().nullable().parse(rawProjectId)
    return connectorRuntime.runConnectors(projectId).then(async (result) => {
      if (database.decisionInboxEnabled) await decisionRemediationService.sync(projectId)
      return result
    })
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
}
