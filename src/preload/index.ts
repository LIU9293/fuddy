import { contextBridge, ipcRenderer } from 'electron'
import type {
  AskMorningBriefingInput,
  AgentRunStreamEnvelope,
  AgentRunStreamUpdate,
  AgentSessionUpdate,
  AgentStreamEnvelope,
  ConfigureAgentProviderInput,
  ConfigureCodingAgentSettingsInput,
  ConfigureConnectorInput,
  ConfigurePostgresInput,
  ConfigureTtsProviderInput,
  CreateDecisionInput,
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
  RespondAgentApprovalInput
} from '../shared/contracts'

const api: DesktopApi = {
  getBootstrap: () => ipcRenderer.invoke('app:get-bootstrap'),
  requestComputerUsePermissions: () => ipcRenderer.invoke('capability:request-computer-permissions'),
  updateProject: (input: UpdateProjectInput) => ipcRenderer.invoke('project:update', input),
  createGoal: (input: CreateGoalInput) => ipcRenderer.invoke('goal:create', input),
  checkGoal: (id: string) => ipcRenderer.invoke('goal:check', id),
  updateGoalStatus: (id: string, status: GoalStatus) =>
    ipcRenderer.invoke('goal:update-status', { id, status }),
  updateGoalPriority: (id: string, priority: GoalPriority) =>
    ipcRenderer.invoke('goal:update-priority', { id, priority }),
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
  renameAgentRun: (id: string, title: string) => ipcRenderer.invoke('agent-run:rename', { id, title }),
  archiveAgentRun: (id: string) => ipcRenderer.invoke('agent-run:archive', id),
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
  configureAgentProvider: (input: ConfigureAgentProviderInput) =>
    ipcRenderer.invoke('provider:configure-agent', input),
  configureCodingAgents: (input: ConfigureCodingAgentSettingsInput) =>
    ipcRenderer.invoke('provider:configure-coding-agents', input),
  listCodingAgentModels: () => ipcRenderer.invoke('provider:list-coding-agent-models'),
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
