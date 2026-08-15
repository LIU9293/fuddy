import { BrowserWindow, dialog, ipcMain, shell, systemPreferences } from 'electron'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { appBootstrapDataKeys, type DecisionStatus, type GoalStatus, type PermissionIntent } from '../../shared/contracts'
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

export function registerCoreIpc(context: IpcContext): void {
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

  ipcMain.handle('app:get-bootstrap-patch', (_event, rawKeys: unknown) => {
    const keys = z.array(z.enum(appBootstrapDataKeys)).min(1).max(appBootstrapDataKeys.length).parse(rawKeys)
    const settings = providerSettings.getPublicSettings()
    return database.getBootstrapPatch(
      [...new Set(keys)],
      getCapabilities(settings),
      connectorCatalog,
      listProjectAnalyticsProfileSummaries(),
      credentialVault.getStatus(),
      settings
    )
  })

  ipcMain.handle('capability:request-computer-permissions', async () => {
    if (process.platform !== 'darwin') return getCapabilities(providerSettings.getPublicSettings())
    const { hasRequiredMacOSPermissions, openMacOSScreenRecordingSettings, requestMacOSPermissions } =
      await import('@trycua/cua-driver/electron')
    const status = requestMacOSPermissions()
    if (!hasRequiredMacOSPermissions(status) && !status.screenRecording) {
      await openMacOSScreenRecordingSettings()
    }
    return getCapabilities(providerSettings.getPublicSettings())
  })

  ipcMain.handle('capability:request-microphone-access', () =>
    requestMacMicrophoneAccess({
      platform: process.platform,
      getStatus: () => systemPreferences.getMediaAccessStatus('microphone'),
      askForAccess: () => systemPreferences.askForMediaAccess('microphone')
    })
  )

  ipcMain.handle('capability:open-microphone-settings', async () => {
    if (process.platform !== 'darwin') return
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
  })
}
