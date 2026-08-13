import { BrowserWindow, dialog, ipcMain, shell, systemPreferences } from 'electron'
import { randomUUID } from 'node:crypto'
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
import { AsrService } from './services/asr-service'
import { GoalTrackingService } from './services/goal-tracking'
import { WorkspaceFilesService } from './services/workspace-files'
import { AutomationRuntime } from './services/automation-runtime'
import { listProjectAnalyticsProfileSummaries } from './analytics/project-analytics-profiles'
import { ProjectAgentIntegrationService } from './services/project-agent-integration'
import { discoverCodingAgentModels } from './services/coding-agent-models'
import { CompanionSyncService } from './services/companion-sync'
import { createProjectSchema, updateProjectSchema } from '../shared/project-validation'
import { DecisionRemediationService } from './services/decision-remediation'
import { collectGitWorkingTreeSummary } from './services/git-working-tree'
import { requestMacMicrophoneAccess } from './services/microphone-permissions'

import { registerCoreIpc } from './ipc/core'
import { registerProjectIpc } from './ipc/projects'
import { registerRunIpc } from './ipc/runs'
import { registerWorkspaceIpc } from './ipc/workspace'
import { registerSettingsIpc } from './ipc/settings'
import type { IpcContext } from './ipc/context'
import { workAssistantImageSchema } from './ipc/schemas'

export function registerIpc(
  database: AppDatabase,
  dispatcher: TaskDispatcher,
  connectorRuntime: ConnectorRuntime,
  decisionRemediationService: DecisionRemediationService,
  credentialVault: CredentialVault,
  dailyBriefingService: DailyBriefingService,
  morningBriefingService: MorningBriefingService,
  goalTrackingService: GoalTrackingService,
  providerSettings: ProviderSettingsService,
  asrService: AsrService,
  ttsService: TtsService,
  workspaceFiles: WorkspaceFilesService,
  automationRuntime: AutomationRuntime,
  projectAgentIntegration: ProjectAgentIntegrationService,
  companionSync: CompanionSyncService
): void {
  const persistAttachments = (
    projectId: string | null,
    scope: string,
    attachments: z.infer<typeof workAssistantImageSchema>[] = []
  ): Array<{ label: string; uri: string }> =>
    attachments.map((attachment) => {
      const safeName = attachment.name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'attachment'
      const relativePath = `_attachments/${scope}/${attachment.id}-${safeName}`
      workspaceFiles.writeDataUrl(projectId, relativePath, attachment.dataUrl)
      const logicalPath = relativePath.split('/').map(encodeURIComponent).join('/')
      return {
        label: attachment.name,
        uri: `project-agent://files/${encodeURIComponent(projectId ?? '_shared')}/${logicalPath}`
      }
    })

  const context: IpcContext = {
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
  }
  registerCoreIpc(context)
  registerProjectIpc(context)
  registerRunIpc(context)
  registerWorkspaceIpc(context)
  registerSettingsIpc(context)
}
