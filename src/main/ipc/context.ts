import type { z } from 'zod'
import type { ConnectorRuntime } from '../connectors/connector-runtime'
import type { AppDatabase } from '../services/database'
import type { TaskDispatcher } from '../services/task-dispatcher'
import type { DecisionRemediationService } from '../services/decision-remediation'
import type { CredentialVault } from '../services/credential-vault'
import type { DailyBriefingService } from '../services/daily-briefing'
import type { MorningBriefingService } from '../services/morning-briefing'
import type { GoalTrackingService } from '../services/goal-tracking'
import type { ProviderSettingsService } from '../services/provider-settings'
import type { AsrService } from '../services/asr-service'
import type { TtsService } from '../services/tts-service'
import type { WorkspaceFilesService } from '../services/workspace-files'
import type { AutomationRuntime } from '../services/automation-runtime'
import type { ProjectAgentIntegrationService } from '../services/project-agent-integration'
import type { CompanionSyncService } from '../services/companion-sync'
import type { workAssistantImageSchema } from './schemas'

export type PersistAttachments = (
  projectId: string | null,
  scope: string,
  attachments?: z.infer<typeof workAssistantImageSchema>[]
) => Array<{ label: string; uri: string }>

export interface IpcContext {
  database: AppDatabase
  dispatcher: TaskDispatcher
  connectorRuntime: ConnectorRuntime
  decisionRemediationService: DecisionRemediationService
  credentialVault: CredentialVault
  dailyBriefingService: DailyBriefingService
  morningBriefingService: MorningBriefingService
  goalTrackingService: GoalTrackingService
  providerSettings: ProviderSettingsService
  asrService: AsrService
  ttsService: TtsService
  workspaceFiles: WorkspaceFilesService
  automationRuntime: AutomationRuntime
  projectAgentIntegration: ProjectAgentIntegrationService
  companionSync: CompanionSyncService
  persistAttachments: PersistAttachments
}
