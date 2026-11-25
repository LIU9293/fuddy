import type { z } from 'zod'
import type { ConnectorRuntime } from '../connectors/connector-runtime'
import type { AppDatabase } from '../services/database'
import type { TaskDispatcher } from '../services/task-dispatcher'
import type { DecisionRemediationService } from '../services/decision-remediation'
import type { CredentialVault } from '../services/credential-vault'
import type { ProviderSettingsService } from '../services/provider-settings'
import type { AsrService } from '../services/asr-service'
import type { WorkspaceFilesService } from '../services/workspace-files'
import type { AutomationRuntime } from '../services/automation-runtime'
import type { ProjectAgentIntegrationService } from '../services/project-agent-integration'
import type { CompanionSyncService } from '../services/companion-sync'
import type { AccountService } from '../services/account-service'
import type { AccountEnrollmentCoordinator } from '../services/account-enrollment-coordinator'
import type { workAssistantImageSchema } from './schemas'

export type PersistAttachments = (
  projectId: string | null,
  scope: string,
  attachments?: z.infer<typeof workAssistantImageSchema>[]
) => Array<{ label: string; uri: string }>

export interface IpcContext {
  macPeers?: import('../services/mac-peer-sync').MacPeerSyncService
  t3Catalog: import('../services/t3-provider-catalog').T3ProviderCatalog
  database: AppDatabase
  dispatcher: TaskDispatcher
  connectorRuntime: ConnectorRuntime
  decisionRemediationService: DecisionRemediationService
  credentialVault: CredentialVault
  providerSettings: ProviderSettingsService
  asrService: AsrService
  workspaceFiles: WorkspaceFilesService
  automationRuntime: AutomationRuntime
  projectAgentIntegration: ProjectAgentIntegrationService
  companionSync: CompanionSyncService
  accountService: AccountService
  accountEnrollmentCoordinator: AccountEnrollmentCoordinator
  persistAttachments: PersistAttachments
}
