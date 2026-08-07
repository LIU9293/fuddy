export type DecisionKind = 'risk' | 'opportunity' | 'decision' | 'result' | 'info'
export type DecisionStatus = 'inbox' | 'later' | 'resolved'
export type Urgency = 'low' | 'medium' | 'high'
export type CodingAgentProvider = 'codex' | 'claude' | 'opencode'

export interface ProjectWorkspaceRoot {
  id: string
  label: string
  path: string
}

export interface ProjectCurrentState {
  summary: string
  facts: string[]
  source: 'user' | 'agent' | 'connector'
  updatedAt: string | null
}

export interface ProjectProfile {
  productType: string
  stage: string
  mission: string
  vision: string
  repoPath: string
  workspaceRoots: ProjectWorkspaceRoot[]
  primaryWorkspaceRootId: string | null
  defaultAgent: AgentRunProvider
  websiteUrl: string | null
  surfaces: string[]
  focusAreas: string[]
  dataSources: string[]
  nextMoves: string[]
  currentState: ProjectCurrentState
}

export interface Project {
  id: string
  name: string
  summary: string
  focus: string
  status: 'active' | 'watching' | 'paused'
  accent: string
  profile: ProjectProfile
}

export type UpdateProjectInput = Project

export interface EvidenceRef {
  label: string
  uri: string
}

export interface DecisionItem {
  id: string
  projectId: string | null
  goalId?: string | null
  /** Stable identity for the underlying issue. It must not contain a report date. */
  dedupeKey?: string | null
  kind: DecisionKind
  title: string
  summary: string
  impact: string
  urgency: Urgency
  confidence: number
  suggestedActions: string[]
  evidenceRefs: EvidenceRef[]
  status: DecisionStatus
  source: string
  createdAt: string
  firstSeenAt?: string
  lastSeenAt?: string
  occurrenceCount?: number
  resolvedAt?: string | null
  resolutionSummary?: string | null
}

export type AgentRunProvider = 'pi' | CodingAgentProvider
export type AgentRunStatus = 'draft' | 'queued' | 'running' | 'idle' | 'completed' | 'failed' | 'cancelled'
export type AgentRunMessageRole = 'user' | 'assistant' | 'system' | 'tool'

export interface AgentRun {
  id: string
  projectId: string | null
  goalId?: string | null
  milestoneId?: string | null
  provider: AgentRunProvider
  title: string
  status: AgentRunStatus
  sessionId: string | null
  workingDirectory: string | null
  startedAt: string | null
  completedAt: string | null
  summary: string
  createdAt: string
  updatedAt: string
}

export interface AgentRunMessage {
  id: string
  runId: string
  role: AgentRunMessageRole
  content: string
  eventType: string | null
  toolName: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

export interface AgentRunArtifact {
  id: string
  runId: string
  projectId: string | null
  relativePath: string
  label: string
  mimeType: string | null
  createdAt: string
}

export interface AgentApprovalRequest {
  id: string
  runId: string
  provider: Extract<AgentRunProvider, 'pi' | 'codex' | 'claude'>
  kind: 'command' | 'file-change' | 'tool'
  title: string
  detail: string
  command: string | null
  toolName: string | null
  createdAt: string
}

export type AgentApprovalDecision = 'approve' | 'deny'

export interface AgentRunDetail {
  run: AgentRun
  messages: AgentRunMessage[]
  artifacts: AgentRunArtifact[]
}

export type AgentRunStreamUpdate =
  | { type: 'created'; run: AgentRun }
  | { type: 'status'; status: AgentRunStatus; detail?: string }
  | { type: 'message_delta'; messageId: string; delta: string }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'tool'; toolName: string; status: 'running' | 'completed' | 'failed'; detail: string }
  | { type: 'approval'; request: AgentApprovalRequest }

export interface AgentRunStreamEnvelope {
  requestId: string
  runId: string
  update: AgentRunStreamUpdate
}

export interface WorkspaceFileEntry {
  projectId: string | null
  relativePath: string
  name: string
  kind: 'file' | 'directory'
  size: number
  modifiedAt: string
  mimeType: string | null
  editable: boolean
}

export interface WorkspaceFileContent {
  entry: WorkspaceFileEntry
  content: string | null
}

export type GoalStatus = 'planned' | 'active' | 'at-risk' | 'completed' | 'paused'
export type GoalPriority = 'P0' | 'P1' | 'P2'
export type GoalMilestoneStatus = 'pending' | 'completed' | 'blocked'

export interface GoalMetric {
  label: string
  unit: string
  baseline: number | null
  current: number | null
  target: number | null
}

export interface GoalMilestone {
  id: string
  goalId: string
  title: string
  status: GoalMilestoneStatus
  dueAt: string | null
  evidenceRefs: EvidenceRef[]
  sortOrder: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface GoalCheckIn {
  id: string
  goalId: string
  status: GoalStatus
  progress: number
  summary: string
  evidenceRefs: EvidenceRef[]
  generation: 'agent' | 'deterministic'
  createdAt: string
}

export interface ProjectGoal {
  id: string
  projectId: string
  title: string
  description: string
  status: GoalStatus
  priority: GoalPriority
  metric: GoalMetric
  deadline: string | null
  nextCheckInAt: string | null
  progress: number
  confidence: number
  agentSummary: string
  monitoringSources: string[]
  milestones: GoalMilestone[]
  checkIns: GoalCheckIn[]
  createdBy: 'user' | 'agent'
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface CreateGoalInput {
  projectId: string
  prompt: string
  priority?: GoalPriority
  status?: Extract<GoalStatus, 'planned' | 'active'>
}

export interface CheckGoalResult {
  goal: ProjectGoal
  checkIn: GoalCheckIn
  createdSignal: DecisionItem | null
  message: string
}

export type CapabilityStatus = 'ready' | 'needs-setup' | 'scaffolded' | 'unavailable'

export interface Capability {
  id: 'pi' | 'browser' | 'computer' | 'codex' | 'claude' | 'opencode' | 'tts'
  label: string
  status: CapabilityStatus
  detail: string
}

export type PermissionRisk = 'routine' | 'sensitive' | 'dangerous'
export type PermissionDecision = 'auto-approved' | 'requires-confirmation'

export interface PermissionIntent {
  tool: string
  action: string
  target?: string
  command?: string
  description?: string
  projectRoot?: string
  irreversible?: boolean
  production?: boolean
  affectsMoney?: boolean
  handlesCredentials?: boolean
  transmitsCredentials?: boolean
  changesSecuritySettings?: boolean
  deletesAccount?: boolean
}

export interface PermissionEvaluation {
  decision: PermissionDecision
  risk: PermissionRisk
  reason: string
  auditLevel: 'standard' | 'highlighted' | 'critical'
  evaluatedAt: string
}

export interface AuditEntry {
  id: string
  intent: PermissionIntent
  evaluation: PermissionEvaluation
  outcome: 'pending' | 'approved' | 'rejected' | 'completed' | 'failed'
  createdAt: string
}

export type ConnectorKind = 'repo' | 'postgres' | 'cloudflare' | 'ga4' | 'project-agent'
export type ConnectorStatus = 'connected' | 'needs-setup' | 'running' | 'error' | 'disabled'
export type ConnectorRunStatus = 'completed' | 'failed'

export interface ConnectorInstance {
  id: string
  projectId: string
  kind: ConnectorKind
  name: string
  enabled: boolean
  status: ConnectorStatus
  config: Record<string, string | number | boolean>
  credentialRef: string | null
  capabilities: string[]
  lastCheckedAt: string | null
  lastSyncAt: string | null
  lastError: string | null
}

export interface ConnectorRun {
  id: string
  connectorId: string
  projectId: string
  status: ConnectorRunStatus
  startedAt: string
  completedAt: string
  summary: string
  evidenceRefs: EvidenceRef[]
  decisionId: string | null
  data: Record<string, unknown> | null
}

export type DailyBriefingStatus = 'completed' | 'failed'
export type DailyBriefingGeneration = 'agent' | 'deterministic'

export interface DailyBriefing {
  id: string
  projectId: string
  reportDate: string
  timezone: string
  status: DailyBriefingStatus
  headline: string
  body: string
  metrics: Record<string, unknown> | null
  signalIds: string[]
  generatedAt: string
  error: string | null
  generation: DailyBriefingGeneration
}

export interface GenerateDailyBriefingResult {
  briefing: DailyBriefing
  createdSignals: DecisionItem[]
}

export interface MorningBriefing {
  id: string
  reportDate: string
  timezone: string
  status: DailyBriefingStatus
  headline: string
  body: string
  narration: string
  estimatedDurationSeconds: number
  sourceBriefingIds: string[]
  signalIds: string[]
  generatedAt: string
  error: string | null
  generation: DailyBriefingGeneration
}

export interface WorkAssistantTaskReference {
  projectId: string
  goalId: string
  milestoneId: string
}

export interface WorkAssistantTaskContext extends WorkAssistantTaskReference {
  projectName: string
  goalTitle: string
  milestoneTitle: string
}

export type WorkAssistantImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export interface WorkAssistantImageAttachment {
  id: string
  name: string
  mimeType: WorkAssistantImageMimeType
  dataUrl: string
}

export interface BriefingMessage {
  id: string
  briefingId: string | null
  role: 'user' | 'assistant'
  content: string
  attachments: WorkAssistantImageAttachment[]
  taskContext: WorkAssistantTaskContext | null
  createdAt: string
}

export type AgentProviderMode = 'cc-switch-codex-oauth' | 'openai-compatible'

export interface AgentEndpointSettings {
  mode: AgentProviderMode
  baseUrl: string
  model: string
  apiKeyConfigured: boolean
}

export interface AgentProviderSettings {
  primary: AgentEndpointSettings
  backup: AgentEndpointSettings
  backupEnabled: boolean
}

export type TtsProviderMode = 'system' | 'openai-compatible' | 'elevenlabs'

export interface TtsEndpointSettings {
  mode: TtsProviderMode
  baseUrl: string
  model: string
  voice: string
  instructions: string
  apiKeyConfigured: boolean
}

export interface TtsProviderSettings {
  primary: TtsEndpointSettings
  backup: TtsEndpointSettings
  backupEnabled: boolean
}

export interface CodingAgentModelSettings {
  defaultModel: string
}

export interface CodingAgentSettings extends Record<CodingAgentProvider, CodingAgentModelSettings> {
  defaultAgent: CodingAgentProvider
}

export type ConfigureCodingAgentSettingsInput = CodingAgentSettings

export interface CodingAgentModelOption {
  id: string
  label: string
  description: string | null
  isDefault: boolean
}

export interface CodingAgentModelCatalogEntry {
  provider: CodingAgentProvider
  models: CodingAgentModelOption[]
  error: string | null
}

export type CodingAgentModelCatalog = Record<CodingAgentProvider, CodingAgentModelCatalogEntry>

export interface ConfigureAgentEndpointInput {
  mode: AgentProviderMode
  baseUrl: string
  model: string
  apiKey?: string
}

export interface ConfigureTtsEndpointInput {
  mode: TtsProviderMode
  baseUrl: string
  model: string
  voice: string
  instructions: string
  apiKey?: string
}

export interface ProviderSettings {
  agent: AgentProviderSettings
  codingAgents: CodingAgentSettings
  tts: TtsProviderSettings
}

export interface ConfigureAgentProviderInput {
  primary: ConfigureAgentEndpointInput
  backup: ConfigureAgentEndpointInput
  backupEnabled: boolean
}

export interface ConfigureTtsProviderInput {
  primary: ConfigureTtsEndpointInput
  backup: ConfigureTtsEndpointInput
  backupEnabled: boolean
}

export interface BriefingAudioResult {
  mode: 'system' | 'cloud'
  provider: TtsProviderMode
  fallbackUsed: boolean
  audioDataUrl: string | null
  mimeType: 'audio/mpeg' | null
  message: string
}

export interface ElevenLabsVoiceDesignResult {
  voiceId: string
  name: string
  audioDataUrl: string
  message: string
}

export interface GenerateMorningBriefingResult {
  briefing: MorningBriefing
  createdSignals: DecisionItem[]
}

export interface AskMorningBriefingInput {
  requestId: string
  briefingId: string | null
  question: string
  attachments: WorkAssistantImageAttachment[]
  taskContext?: WorkAssistantTaskReference | null
}

export interface AgentPlanEntry {
  content: string
  priority: 'high' | 'medium' | 'low'
  status: 'pending' | 'in_progress' | 'completed'
}

export type AgentSessionUpdate =
  | {
      sessionUpdate: 'agent_message_chunk'
      messageId: string
      content: { type: 'text'; text: string }
    }
  | {
      sessionUpdate: 'plan'
      entries: AgentPlanEntry[]
    }

export interface AgentStreamEnvelope {
  requestId: string
  briefingId: string | null
  update: AgentSessionUpdate
}

export interface AskMorningBriefingResult {
  userMessage: BriefingMessage
  assistantMessage: BriefingMessage
}

export interface ConnectorCatalogItem {
  kind: ConnectorKind
  label: string
  description: string
  availability: 'built-in' | 'planned'
  authType: 'none' | 'credential' | 'oauth' | 'project-api'
  capabilities: string[]
}

export interface ProjectAnalyticsMetric {
  key: string
  label: string
  funnelStage: string
  source: string
  unit: 'count' | 'percent' | 'CNY' | 'minutes'
}

export interface ProjectAnalyticsProfileSummary {
  id: string
  version: number
  projectId: string
  projectName: string
  timezone: string
  objective: string
  funnel: string[]
  metrics: ProjectAnalyticsMetric[]
  requiredConnectors: ConnectorKind[]
  recommendedConnectors: ConnectorKind[]
  decisionRules: string[]
  agentKind: 'repo-skill' | 'http-super-agent'
  agentLabel: string
  approvalBoundary: string
}

export interface CredentialStorageStatus {
  available: boolean
  backend: 'macos-keychain' | 'os-encryption' | 'unavailable'
  detail: string
}

export interface ConnectorActionResult {
  connector: ConnectorInstance
  run: ConnectorRun
  decision: DecisionItem | null
  message: string
}

export interface RunConnectorsResult {
  results: ConnectorActionResult[]
  succeeded: number
  failed: number
}

export type AutomationAction = 'agent-task' | 'run-connectors' | 'check-goals' | 'generate-briefing'
export type AutomationStatus = 'idle' | 'running' | 'waiting-confirmation' | 'paused' | 'error'
export type AutomationRunStatus = 'awaiting-confirmation' | 'running' | 'completed' | 'failed' | 'skipped'
export type AutomationRunTrigger = 'scheduled' | 'manual'

export interface AutomationJob {
  id: string
  projectId: string | null
  name: string
  scheduleDescription: string
  cronExpression: string
  timezone: string
  action: AutomationAction
  prompt: string
  agentProvider: AgentRunProvider
  enabled: boolean
  requiresConfirmation: boolean
  maxRetries: number
  retryDelaySeconds: number
  status: AutomationStatus
  lastRunAt: string | null
  nextRunAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export interface AutomationRun {
  id: string
  automationId: string
  status: AutomationRunStatus
  trigger: AutomationRunTrigger
  attempt: number
  startedAt: string
  completedAt: string | null
  summary: string
  error: string | null
  agentRunId: string | null
}

export interface SaveAutomationInput {
  id?: string
  projectId: string | null
  name: string
  scheduleDescription: string
  cronExpression: string
  timezone: string
  action: AutomationAction
  prompt: string
  agentProvider: AgentRunProvider
  enabled: boolean
  requiresConfirmation: boolean
  maxRetries: number
  retryDelaySeconds: number
}

export interface RunAutomationResult {
  job: AutomationJob
  run: AutomationRun
}

export interface ConfigurePostgresInput {
  projectId: string
  connectionString: string
  metricView?: string
  analyticsProfile?: string
}

export interface ConfigureCloudflareInput {
  projectId: string
  accountId: string
  zoneId?: string
  apiToken?: string
}

export interface ConfigureGa4Input {
  projectId: string
  propertyId: string
  accessToken?: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
}

export interface ConfigureProjectAgentInput {
  projectId: string
  agentName: string
  baseUrl: string
  statusPath?: string
  apiKey?: string
}

export type ConfigureConnectorInput =
  | ({ kind: 'cloudflare' } & ConfigureCloudflareInput)
  | ({ kind: 'ga4' } & ConfigureGa4Input)
  | ({ kind: 'project-agent' } & ConfigureProjectAgentInput)

export interface AppBootstrap {
  projects: Project[]
  goals: ProjectGoal[]
  decisions: DecisionItem[]
  runs: AgentRun[]
  connectors: ConnectorInstance[]
  connectorRuns: ConnectorRun[]
  dailyBriefings: DailyBriefing[]
  morningBriefings: MorningBriefing[]
  briefingMessages: BriefingMessage[]
  automations: AutomationJob[]
  automationRuns: AutomationRun[]
  providerSettings: ProviderSettings
  connectorCatalog: ConnectorCatalogItem[]
  analyticsProfiles: ProjectAnalyticsProfileSummary[]
  capabilities: Capability[]
  credentialStorage: CredentialStorageStatus
  permissionMode: 'full-access'
}

export interface CreateDecisionInput {
  projectId: string | null
  goalId?: string | null
  title: string
  summary?: string
}

export interface DispatchTaskInput {
  projectId: string | null
  goalId?: string | null
  milestoneId?: string | null
  /** Uses the project's default agent when omitted. */
  provider?: AgentRunProvider
  title?: string
  workingDirectory?: string | null
  prompt: string
}

export interface DispatchTaskResult {
  detail: AgentRunDetail
  message: string
}

export interface DispatchProjectAgentInput {
  requestId: string
  projectId: 'vows' | 'ai-marketing'
  prompt: string
}

export interface DispatchProjectAgentResult {
  mode: 'repo-skill' | 'http-super-agent'
  projectId: string
  message: string
  agentRun: AgentRunDetail | null
  externalThreadId: string | null
  data: Record<string, unknown> | null
}

export interface SendAgentRunMessageInput {
  requestId: string
  runId: string
  prompt: string
}

export interface RespondAgentApprovalInput {
  requestId: string
  decision: AgentApprovalDecision
}

export interface CreateAgentRunInput extends DispatchTaskInput {
  requestId: string
}

export interface CreateAgentRunDraftInput {
  projectId: string | null
  goalId?: string | null
  milestoneId?: string | null
  /** Uses the project's default agent when omitted. */
  provider?: AgentRunProvider
  title: string
  workingDirectory?: string | null
}

export interface WriteWorkspaceFileInput {
  projectId: string | null
  relativePath: string
  content: string
}

export interface CreateWorkspaceFolderInput {
  projectId: string | null
  relativePath: string
}

export interface DesktopApi {
  getBootstrap(): Promise<AppBootstrap>
  requestComputerUsePermissions(): Promise<Capability[]>
  updateProject(input: UpdateProjectInput): Promise<Project>
  createGoal(input: CreateGoalInput): Promise<ProjectGoal>
  checkGoal(id: string): Promise<CheckGoalResult>
  updateGoalStatus(id: string, status: GoalStatus): Promise<ProjectGoal>
  updateGoalPriority(id: string, priority: GoalPriority): Promise<ProjectGoal>
  createDecision(input: CreateDecisionInput): Promise<DecisionItem>
  updateDecisionStatus(id: string, status: DecisionStatus): Promise<DecisionItem>
  evaluatePermission(intent: PermissionIntent): Promise<PermissionEvaluation>
  dispatchTask(
    input: CreateAgentRunInput,
    onUpdate: (update: AgentRunStreamUpdate) => void
  ): Promise<DispatchTaskResult>
  createAgentRunDraft(input: CreateAgentRunDraftInput): Promise<AgentRunDetail>
  dispatchProjectAgent(
    input: DispatchProjectAgentInput,
    onUpdate: (update: AgentRunStreamUpdate) => void
  ): Promise<DispatchProjectAgentResult>
  getAgentRun(id: string): Promise<AgentRunDetail>
  renameAgentRun(id: string, title: string): Promise<AgentRun>
  archiveAgentRun(id: string): Promise<void>
  getCompanionStatus(): Promise<import('./companion-sync').CompanionMacStatus>
  beginCompanionPairing(relayUrl: string): Promise<import('./companion-sync').CompanionPairingSession>
  disconnectCompanion(): Promise<void>
  syncCompanionNow(): Promise<import('./companion-sync').CompanionMacStatus>
  onCompanionStatusChanged(
    callback: (status: import('./companion-sync').CompanionMacStatus) => void
  ): () => void
  sendAgentRunMessage(
    input: SendAgentRunMessageInput,
    onUpdate: (update: AgentRunStreamUpdate) => void
  ): Promise<AgentRunDetail>
  respondAgentApproval(input: RespondAgentApprovalInput): Promise<void>
  listWorkspaceFiles(projectId: string | null): Promise<WorkspaceFileEntry[]>
  readWorkspaceFile(projectId: string | null, relativePath: string): Promise<WorkspaceFileContent>
  writeWorkspaceFile(input: WriteWorkspaceFileInput): Promise<WorkspaceFileEntry>
  createWorkspaceFolder(input: CreateWorkspaceFolderInput): Promise<WorkspaceFileEntry>
  importWorkspaceFiles(projectId: string | null, targetDirectory?: string): Promise<WorkspaceFileEntry[]>
  revealWorkspacePath(projectId: string | null, relativePath?: string): Promise<void>
  runConnector(id: string): Promise<ConnectorActionResult>
  runConnectors(projectId: string | null): Promise<RunConnectorsResult>
  setConnectorEnabled(id: string, enabled: boolean): Promise<ConnectorInstance>
  configurePostgres(input: ConfigurePostgresInput): Promise<ConnectorActionResult>
  configureConnector(input: ConfigureConnectorInput): Promise<ConnectorActionResult>
  generateDailyBriefing(projectId: string): Promise<GenerateDailyBriefingResult>
  generateMorningBriefing(): Promise<GenerateMorningBriefingResult>
  askMorningBriefing(
    input: AskMorningBriefingInput,
    onUpdate: (update: AgentSessionUpdate) => void
  ): Promise<AskMorningBriefingResult>
  configureAgentProvider(input: ConfigureAgentProviderInput): Promise<ProviderSettings>
  configureCodingAgents(input: ConfigureCodingAgentSettingsInput): Promise<ProviderSettings>
  listCodingAgentModels(): Promise<CodingAgentModelCatalog>
  configureTtsProvider(input: ConfigureTtsProviderInput): Promise<ProviderSettings>
  getMorningBriefingAudio(briefingId: string): Promise<BriefingAudioResult>
  testTtsProvider(): Promise<BriefingAudioResult>
  designElevenLabsVoice(): Promise<ElevenLabsVoiceDesignResult>
  saveAutomation(input: SaveAutomationInput): Promise<AutomationJob>
  setAutomationEnabled(id: string, enabled: boolean): Promise<AutomationJob>
  runAutomation(id: string): Promise<RunAutomationResult>
  approveAutomationRun(runId: string): Promise<RunAutomationResult>
  onMorningBriefingReady(callback: () => void): () => void
  onAutomationsChanged(callback: () => void): () => void
}
