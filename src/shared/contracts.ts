export type DecisionKind = 'risk' | 'opportunity' | 'decision' | 'result' | 'info'
export type DecisionStatus = 'inbox' | 'in_progress' | 'waiting' | 'resolved' | 'ignored'
export type DecisionWaitingReason =
  | 'deployment'
  | 'verification'
  | 'external'
  | 'measurement'
  | 'user'
  | 'scheduled'
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
  icon?: string | null
  summary: string
  focus: string
  status: 'active' | 'watching' | 'paused'
  accent: string
  profile: ProjectProfile
}

export type UpdateProjectInput = Project

export interface CreateProjectInput {
  name: string
  icon?: string | null
  summary: string
  focus: string
  mission: string
  vision: string
  productType: string
  stage: string
  websiteUrl?: string | null
  workspacePath?: string | null
  defaultAgent?: AgentRunProvider
}

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
  waitingReason?: DecisionWaitingReason | null
  statusSummary?: string | null
  statusUpdatedAt?: string
  reopenCount?: number
  source: string
  createdAt: string
  firstSeenAt?: string
  lastSeenAt?: string
  occurrenceCount?: number
  resolvedAt?: string | null
  resolutionSummary?: string | null
}

export type DecisionRemediationState =
  | 'investigating'
  | 'in_progress'
  | 'review_required'
  | 'ready_to_merge'
  | 'merged_awaiting_deploy'
  | 'blocked'

export interface DecisionRemediation {
  id: string
  decisionId: string
  sourceType: 'github-pr'
  sourceRef: string
  state: DecisionRemediationState
  summary: string
  nextAction: string
  evidenceRefs: EvidenceRef[]
  metadata: Record<string, unknown>
  firstSeenAt: string
  lastSeenAt: string
}

export type AgentRunProvider = 'pi' | CodingAgentProvider
export type AgentRunStatus = 'draft' | 'queued' | 'running' | 'idle' | 'completed' | 'failed' | 'cancelled'
export type AgentRunMessageRole = 'user' | 'assistant' | 'system' | 'tool'

export interface AgentRun {
  id: string
  projectId: string | null
  decisionId?: string | null
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
  /** Composer seed for a draft Run. It is not a chat message and is cleared after the first send. */
  draftPrompt: string | null
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

export interface AgentRunArtifactPreview {
  artifact: AgentRunArtifact
  kind: 'markdown' | 'text' | 'image' | 'unsupported'
  content: string | null
  dataUrl: string | null
  size: number
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

export interface GitWorkingTreeChange {
  path: string
  status: string
}

export interface GitWorkingTreeSummary {
  available: boolean
  repoRoot: string | null
  branch: string | null
  head: string | null
  additions: number
  deletions: number
  changedFileCount: number
  changes: GitWorkingTreeChange[]
  error: string | null
}

export type AgentRunStreamUpdate =
  | { type: 'created'; run: AgentRun }
  | { type: 'status'; status: AgentRunStatus; detail?: string }
  | { type: 'message_delta'; messageId: string; delta: string }
  | { type: 'reasoning_delta'; segmentId?: string; delta: string }
  | { type: 'tool'; toolCallId?: string; toolName: string; status: 'running' | 'completed' | 'failed'; detail: string }
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
  attachments?: WorkAssistantImageAttachment[]
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
  linkedRunId?: string | null
  actions?: WorkAssistantActionProposal[]
  createdAt: string
}

export type WorkAssistantCapabilityAccess = 'read' | 'confirm' | 'explicit'

export type WorkAssistantCapabilityId =
  | 'project.list'
  | 'project.inspect'
  | 'project.create'
  | 'project.update'
  | 'project.pause'
  | 'agent-run.find'
  | 'agent-run.inspect'
  | 'agent-run.open'
  | 'agent-run.create'
  | 'agent-run.update'
  | 'agent-run.archive'
  | 'agent-run.send'
  | 'goal.manage'
  | 'inbox.manage'
  | 'files.search'
  | 'files.read'
  | 'web.search'
  | 'web.read'
  | 'briefing.read'
  | 'briefing.generate'
  | 'automation.manage'

export interface WorkAssistantCapabilityDescriptor {
  id: WorkAssistantCapabilityId
  label: string
  access: WorkAssistantCapabilityAccess
  description: string
}

export interface WorkAssistantActionOption {
  id: string
  label: string
  style: 'primary' | 'secondary' | 'quiet'
  capability: WorkAssistantCapabilityId | 'assistant.dismiss'
  payload: Record<string, unknown>
}

export interface WorkAssistantActionProposal {
  id: string
  title: string
  description: string
  status: 'pending' | 'accepted' | 'dismissed' | 'expired'
  context: string | null
  options: WorkAssistantActionOption[]
  acceptedOptionId: string | null
  createdAt: string
  resolvedAt: string | null
}

export interface ExecuteWorkAssistantActionInput {
  messageId: string
  proposalId: string
  optionId: string
}

export interface ExecuteWorkAssistantActionResult {
  message: BriefingMessage
  notice: string
  navigation: null | {
    kind: 'agent-run' | 'project'
    id: string
    draftPrompt?: string | null
  }
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

export type AsrProviderMode = 'local-first' | 'cloud'

export interface AsrProviderSettings {
  mode: AsrProviderMode
  cloudBaseUrl: string
  cloudModel: string
  cloudApiKeyConfigured: boolean
  fallbackToCloud: boolean
}

export interface ConfigureAsrProviderInput {
  mode: AsrProviderMode
  cloudBaseUrl: string
  cloudModel: string
  cloudApiKey?: string
  fallbackToCloud: boolean
}

export type AsrLocalModelState = 'not-downloaded' | 'downloading' | 'installed' | 'error'

export interface AsrModelStatus {
  state: AsrLocalModelState
  model: 'large-v3-turbo-q5_0'
  bytesDownloaded: number
  totalBytes: number
  error: string | null
}

export interface AsrDownloadProgress {
  bytesDownloaded: number
  totalBytes: number
}

export interface TranscribeAudioInput {
  audioDataUrl: string
  language?: string
  prompt?: string
}

export interface TranscriptionResult {
  text: string
  provider: 'local-whisper' | 'cloud'
  fallbackUsed: boolean
  durationMilliseconds: number
}

export interface CodingAgentModelSettings {
  defaultModel: string
  defaultReasoningEffort: string
}

export interface CodingAgentSettings extends Record<CodingAgentProvider, CodingAgentModelSettings> {
  defaultAgent: CodingAgentProvider
}

export type ConfigureCodingAgentSettingsInput = CodingAgentSettings

export interface CodingAgentReasoningEffortOption {
  id: string
  label: string
  description: string | null
}

export interface CodingAgentModelOption {
  id: string
  label: string
  description: string | null
  isDefault: boolean
  reasoningEfforts: CodingAgentReasoningEffortOption[]
  defaultReasoningEffort: string | null
}

export interface CodingAgentModelCatalogEntry {
  provider: CodingAgentProvider
  models: CodingAgentModelOption[]
  defaultReasoningEfforts: CodingAgentReasoningEffortOption[]
  defaultReasoningEffort: string | null
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
  asr: AsrProviderSettings
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
  decisionRemediations: DecisionRemediation[]
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
  attachments?: WorkAssistantImageAttachment[]
  evidenceRefs?: EvidenceRef[]
}

export interface DispatchTaskInput {
  projectId: string | null
  decisionId?: string | null
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
  projectId: string
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
  attachments?: WorkAssistantImageAttachment[]
}

export interface RespondAgentApprovalInput {
  requestId: string
  decision: AgentApprovalDecision
}

export interface CreateAgentRunInput extends DispatchTaskInput {
  requestId: string
}

export interface CreateAgentRunDraftInput {
  id?: string
  projectId: string | null
  decisionId?: string | null
  goalId?: string | null
  milestoneId?: string | null
  /** Uses the project's default agent when omitted. */
  provider?: AgentRunProvider
  title: string
  draftPrompt?: string | null
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

export type MicrophoneAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'

export interface MicrophoneAccessResult {
  granted: boolean
  status: MicrophoneAccessStatus
}

export interface DesktopApi {
  getBootstrap(): Promise<AppBootstrap>
  requestComputerUsePermissions(): Promise<Capability[]>
  requestMicrophoneAccess(): Promise<MicrophoneAccessResult>
  openMicrophoneSettings(): Promise<void>
  updateProject(input: UpdateProjectInput): Promise<Project>
  createProject(input: CreateProjectInput): Promise<Project>
  createGoal(input: CreateGoalInput): Promise<ProjectGoal>
  checkGoal(id: string): Promise<CheckGoalResult>
  updateGoalStatus(id: string, status: GoalStatus): Promise<ProjectGoal>
  updateGoalPriority(id: string, priority: GoalPriority): Promise<ProjectGoal>
  completeGoalMilestone(goalId: string, milestoneId: string): Promise<ProjectGoal>
  deleteGoalMilestone(goalId: string, milestoneId: string): Promise<ProjectGoal>
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
  getAgentRunGitSummary(id: string): Promise<GitWorkingTreeSummary>
  getAgentRunArtifactPreview(runId: string, artifactId: string): Promise<AgentRunArtifactPreview>
  renameAgentRun(id: string, title: string): Promise<AgentRun>
  updateAgentRunDraftPrompt(id: string, draftPrompt: string): Promise<AgentRun>
  archiveAgentRun(id: string): Promise<void>
  getCompanionStatus(): Promise<import('./companion-sync').CompanionMacStatus>
  beginCompanionPairing(relayUrl: string): Promise<import('./companion-sync').CompanionPairingSession>
  disconnectCompanion(): Promise<void>
  syncCompanionNow(): Promise<import('./companion-sync').CompanionMacStatus>
  onCompanionStatusChanged(
    callback: (status: import('./companion-sync').CompanionMacStatus) => void
  ): () => void
  onCompanionDataChanged(callback: () => void): () => void
  onOpenAgentRun(callback: (runId: string) => void): () => void
  sendAgentRunMessage(
    input: SendAgentRunMessageInput,
    onUpdate: (update: AgentRunStreamUpdate) => void
  ): Promise<AgentRunDetail>
  stopAgentRunMessage(runId: string): Promise<AgentRunDetail>
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
  executeWorkAssistantAction(input: ExecuteWorkAssistantActionInput): Promise<ExecuteWorkAssistantActionResult>
  configureAgentProvider(input: ConfigureAgentProviderInput): Promise<ProviderSettings>
  configureCodingAgents(input: ConfigureCodingAgentSettingsInput): Promise<ProviderSettings>
  listCodingAgentModels(): Promise<CodingAgentModelCatalog>
  configureAsrProvider(input: ConfigureAsrProviderInput): Promise<ProviderSettings>
  getAsrModelStatus(): Promise<AsrModelStatus>
  downloadAsrModel(): Promise<AsrModelStatus>
  deleteAsrModel(): Promise<AsrModelStatus>
  transcribeAudio(input: TranscribeAudioInput): Promise<TranscriptionResult>
  onAsrDownloadProgress(callback: (progress: AsrDownloadProgress) => void): () => void
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
