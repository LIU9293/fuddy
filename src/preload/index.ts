import { contextBridge, ipcRenderer } from 'electron'
import type {
  AskMorningBriefingInput,
  AgentRunStreamEnvelope,
  AgentRunStreamUpdate,
  AgentSessionUpdate,
  AppBootstrapDataKey,
  AgentStreamEnvelope,
  ConfigureAgentProviderInput,
  ConfigureAsrProviderInput,
  ConfigureCodingAgentSettingsInput,
  ConfigureConnectorInput,
  ConfigurePostgresInput,
  ConfigureTtsProviderInput,
  CreateDecisionInput,
  CreateProjectInput,
  CreateAgentRunDraftInput,
  DecisionStatus,
  DesktopApi,
  CreateAgentRunInput,
  CreateWorkspaceFolderInput,
  PermissionIntent,
  GoalStatus,
  GoalPriority,
  CreateGoalInput,
  UpdateProjectInput,
  SendAgentRunMessageInput,
  SaveAutomationInput,
  WriteWorkspaceFileInput,
  DispatchProjectAgentInput,
  ExecuteWorkAssistantActionInput,
  RespondAgentApprovalInput,
  TranscribeAudioInput,
  AsrDownloadProgress
} from '../shared/contracts'
import type { CompanionMacStatus } from '../shared/companion-sync'

const openAgentRunCallbacks = new Set<(runId: string) => void>()
let pendingOpenAgentRunId: string | null = null

ipcRenderer.on('navigation:open-agent-run', (_event, runId: unknown) => {
  if (typeof runId !== 'string' || !runId.trim()) return
  if (openAgentRunCallbacks.size === 0) {
    pendingOpenAgentRunId = runId
    return
  }
  for (const callback of openAgentRunCallbacks) callback(runId)
})

const api: DesktopApi = {
  getAccountState: () => ipcRenderer.invoke('account:get-state'),
  startEmailSignIn: (email: string) => ipcRenderer.invoke('account:start-email-sign-in', { email }),
  verifyEmailSignIn: (input) => ipcRenderer.invoke('account:verify-email-sign-in', input),
  signInWithGoogle: () => ipcRenderer.invoke('account:sign-in-google'),
  listAccountIdentities: () => ipcRenderer.invoke('account:list-identities'),
  linkGoogleAccount: () => ipcRenderer.invoke('account:link-google'),
  unlinkGoogleAccount: () => ipcRenderer.invoke('account:unlink-google'),
  listAccountDevices: () => ipcRenderer.invoke('account:list-devices'),
  revokeAccountDevice: (deviceId: string) => ipcRenderer.invoke('account:revoke-device', { deviceId }),
  logoutAccount: () => ipcRenderer.invoke('account:logout'),
  logoutAllAccounts: () => ipcRenderer.invoke('account:logout-all'),
  onAccountStateChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: import('../shared/account').AccountState): void => callback(state)
    ipcRenderer.on('account:state-changed', listener)
    return () => ipcRenderer.removeListener('account:state-changed', listener)
  },
  detectCodingAgents: () => ipcRenderer.invoke('onboarding:detect-coding-agents'),
  completeAgentDetection: () => ipcRenderer.invoke('onboarding:complete-agent-detection'),
  selectOnboardingProjectFolder: () => ipcRenderer.invoke('onboarding:select-project-folder'),
  completeProjectOnboarding: (input) => ipcRenderer.invoke('onboarding:complete-project', input),
  getBootstrap: () => ipcRenderer.invoke('app:get-bootstrap'),
  getBootstrapPatch: (keys: AppBootstrapDataKey[]) => ipcRenderer.invoke('app:get-bootstrap-patch', keys),
  requestComputerUsePermissions: () => ipcRenderer.invoke('capability:request-computer-permissions'),
  requestMicrophoneAccess: () => ipcRenderer.invoke('capability:request-microphone-access'),
  openMicrophoneSettings: () => ipcRenderer.invoke('capability:open-microphone-settings'),
  updateProject: (input: UpdateProjectInput) => ipcRenderer.invoke('project:update', input),
  createProject: (input: CreateProjectInput) => ipcRenderer.invoke('project:create', input),
  createGoal: (input: CreateGoalInput) => ipcRenderer.invoke('goal:create', input),
  checkGoal: (id: string) => ipcRenderer.invoke('goal:check', id),
  updateGoalStatus: (id: string, status: GoalStatus) =>
    ipcRenderer.invoke('goal:update-status', { id, status }),
  updateGoalPriority: (id: string, priority: GoalPriority) =>
    ipcRenderer.invoke('goal:update-priority', { id, priority }),
  completeGoalMilestone: (goalId: string, milestoneId: string) =>
    ipcRenderer.invoke('goal:complete-milestone', { goalId, milestoneId }),
  deleteGoalMilestone: (goalId: string, milestoneId: string) =>
    ipcRenderer.invoke('goal:delete-milestone', { goalId, milestoneId }),
  createDecision: (input: CreateDecisionInput) => ipcRenderer.invoke('decision:create', input),
  updateDecisionStatus: (id: string, status: DecisionStatus) =>
    ipcRenderer.invoke('decision:update-status', { id, status }),
  evaluatePermission: (intent: PermissionIntent) =>
    ipcRenderer.invoke('permission:evaluate', intent),
  dispatchTask: (
    input: CreateAgentRunInput,
    onUpdate: (update: AgentRunStreamUpdate) => void
  ) => {
    const listener = (_event: Electron.IpcRendererEvent, envelope: AgentRunStreamEnvelope): void => {
      if (envelope.requestId === input.requestId) onUpdate(envelope.update)
    }
    ipcRenderer.on('agent-run:update', listener)
    return ipcRenderer.invoke('task:dispatch', input).finally(() => {
      ipcRenderer.removeListener('agent-run:update', listener)
    })
  },
  createAgentRunDraft: (input: CreateAgentRunDraftInput) =>
    ipcRenderer.invoke('agent-run:create-draft', input),
  dispatchProjectAgent: (
    input: DispatchProjectAgentInput,
    onUpdate: (update: AgentRunStreamUpdate) => void
  ) => {
    const listener = (_event: Electron.IpcRendererEvent, envelope: AgentRunStreamEnvelope): void => {
      if (envelope.requestId === input.requestId) onUpdate(envelope.update)
    }
    ipcRenderer.on('agent-run:update', listener)
    return ipcRenderer.invoke('project-agent:dispatch', input).finally(() => {
      ipcRenderer.removeListener('agent-run:update', listener)
    })
  },
  getAgentRun: (id: string) => ipcRenderer.invoke('agent-run:get', id),
  getAgentRunGitSummary: (id: string) => ipcRenderer.invoke('agent-run:git-summary', id),
  getAgentRunArtifactPreview: (runId: string, artifactId: string) =>
    ipcRenderer.invoke('agent-run:artifact-preview', { runId, artifactId }),
  renameAgentRun: (id: string, title: string) => ipcRenderer.invoke('agent-run:rename', { id, title }),
  updateAgentRunDraftPrompt: (id: string, draftPrompt: string) =>
    ipcRenderer.invoke('agent-run:update-draft-prompt', { id, draftPrompt }),
  updateAgentRunExecutionSettings: (input) =>
    ipcRenderer.invoke('agent-run:update-execution-settings', input),
  archiveAgentRun: (id: string) => ipcRenderer.invoke('agent-run:archive', id),
  getCompanionStatus: () => ipcRenderer.invoke('companion:get-status'),
  getCompanionRelayConfiguration: () => ipcRenderer.invoke('companion:get-relay-configuration'),
  syncCompanionNow: () => ipcRenderer.invoke('companion:sync-now'),
  onCompanionStatusChanged: (callback: (status: CompanionMacStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: CompanionMacStatus): void => callback(status)
    ipcRenderer.on('companion:status-changed', listener)
    return () => ipcRenderer.removeListener('companion:status-changed', listener)
  },
  onCompanionDataChanged: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('companion:data-changed', listener)
    return () => ipcRenderer.removeListener('companion:data-changed', listener)
  },
  onOpenAgentRun: (callback: (runId: string) => void) => {
    openAgentRunCallbacks.add(callback)
    if (pendingOpenAgentRunId) {
      const runId = pendingOpenAgentRunId
      pendingOpenAgentRunId = null
      queueMicrotask(() => {
        if (openAgentRunCallbacks.has(callback)) callback(runId)
      })
    }
    return () => { openAgentRunCallbacks.delete(callback) }
  },
  onAgentRunUpdate: (callback: (envelope: AgentRunStreamEnvelope) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, envelope: AgentRunStreamEnvelope): void => callback(envelope)
    ipcRenderer.on('agent-run:broadcast', listener)
    return () => ipcRenderer.removeListener('agent-run:broadcast', listener)
  },
  sendAgentRunMessage: (
    input: SendAgentRunMessageInput,
    onUpdate: (update: AgentRunStreamUpdate) => void
  ) => {
    const listener = (_event: Electron.IpcRendererEvent, envelope: AgentRunStreamEnvelope): void => {
      if (envelope.requestId === input.requestId) onUpdate(envelope.update)
    }
    ipcRenderer.on('agent-run:update', listener)
    return ipcRenderer.invoke('agent-run:send', input).finally(() => {
      ipcRenderer.removeListener('agent-run:update', listener)
    })
  },
  stopAgentRunMessage: (runId: string) => ipcRenderer.invoke('agent-run:stop', runId),
  respondAgentApproval: (input: RespondAgentApprovalInput) =>
    ipcRenderer.invoke('agent-run:approval', input),
  listWorkspaceFiles: (projectId: string | null) => ipcRenderer.invoke('workspace-files:list', projectId),
  readWorkspaceFile: (projectId: string | null, relativePath: string) =>
    ipcRenderer.invoke('workspace-files:read', { projectId, relativePath }),
  writeWorkspaceFile: (input: WriteWorkspaceFileInput) => ipcRenderer.invoke('workspace-files:write', input),
  createWorkspaceFolder: (input: CreateWorkspaceFolderInput) =>
    ipcRenderer.invoke('workspace-files:create-folder', input),
  importWorkspaceFiles: (projectId: string | null, targetDirectory?: string) =>
    ipcRenderer.invoke('workspace-files:import', { projectId, targetDirectory }),
  revealWorkspacePath: (projectId: string | null, relativePath?: string) =>
    ipcRenderer.invoke('workspace-files:reveal', { projectId, relativePath }),
  runConnector: (id: string) => ipcRenderer.invoke('connector:run', id),
  runConnectors: (projectId: string | null) => ipcRenderer.invoke('connector:run-all', projectId),
  setConnectorEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('connector:set-enabled', { id, enabled }),
  configurePostgres: (input: ConfigurePostgresInput) =>
    ipcRenderer.invoke('connector:configure-postgres', input),
  configureConnector: (input: ConfigureConnectorInput) =>
    ipcRenderer.invoke('connector:configure', input),
  generateDailyBriefing: (projectId: string) =>
    ipcRenderer.invoke('briefing:generate-daily', projectId),
  generateMorningBriefing: () => ipcRenderer.invoke('briefing:generate-morning'),
  askMorningBriefing: (
    input: AskMorningBriefingInput,
    onUpdate: (update: AgentSessionUpdate) => void
  ) => {
    const listener = (_event: Electron.IpcRendererEvent, envelope: AgentStreamEnvelope): void => {
      if (envelope.requestId === input.requestId) onUpdate(envelope.update)
    }
    ipcRenderer.on('briefing:ask-update', listener)
    return ipcRenderer.invoke('briefing:ask', input).finally(() => {
      ipcRenderer.removeListener('briefing:ask-update', listener)
    })
  },
  executeWorkAssistantAction: (input: ExecuteWorkAssistantActionInput) =>
    ipcRenderer.invoke('work-assistant:execute-action', input),
  configureAgentProvider: (input: ConfigureAgentProviderInput) =>
    ipcRenderer.invoke('provider:configure-agent', input),
  configureCodingAgents: (input: ConfigureCodingAgentSettingsInput) =>
    ipcRenderer.invoke('provider:configure-coding-agents', input),
  listCodingAgentModels: () => ipcRenderer.invoke('provider:list-coding-agent-models'),
  configureAsrProvider: (input: ConfigureAsrProviderInput) =>
    ipcRenderer.invoke('provider:configure-asr', input),
  getAsrModelStatus: () => ipcRenderer.invoke('asr:model-status'),
  downloadAsrModel: () => ipcRenderer.invoke('asr:download-model'),
  deleteAsrModel: () => ipcRenderer.invoke('asr:delete-model'),
  transcribeAudio: (input: TranscribeAudioInput) => ipcRenderer.invoke('asr:transcribe', input),
  onAsrDownloadProgress: (callback: (progress: AsrDownloadProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: AsrDownloadProgress): void => callback(progress)
    ipcRenderer.on('asr:download-progress', listener)
    return () => ipcRenderer.removeListener('asr:download-progress', listener)
  },
  configureTtsProvider: (input: ConfigureTtsProviderInput) =>
    ipcRenderer.invoke('provider:configure-tts', input),
  getMorningBriefingAudio: (briefingId: string) =>
    ipcRenderer.invoke('tts:get-briefing-audio', briefingId),
  testTtsProvider: () => ipcRenderer.invoke('tts:test'),
  designElevenLabsVoice: () => ipcRenderer.invoke('tts:design-elevenlabs-voice'),
  saveAutomation: (input: SaveAutomationInput) => ipcRenderer.invoke('automation:save', input),
  setAutomationEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('automation:set-enabled', { id, enabled }),
  runAutomation: (id: string) => ipcRenderer.invoke('automation:run', id),
  approveAutomationRun: (runId: string) => ipcRenderer.invoke('automation:approve', runId),
  onMorningBriefingReady: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('briefing:morning-ready', listener)
    return () => ipcRenderer.removeListener('briefing:morning-ready', listener)
  },
  onAutomationsChanged: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('automation:changed', listener)
    return () => ipcRenderer.removeListener('automation:changed', listener)
  }
}

contextBridge.exposeInMainWorld('projectAgent', api)
