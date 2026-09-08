import type { AgentRun, AgentRunDetail, AppBootstrapPatch, DesktopApi } from '../../shared/contracts'
import { previewAccount, previewBootstrap, previewFiles, previewOnly, previewProject, previewRunDetails } from './fixtures'

export class PreviewUnavailableError extends Error {
  constructor() {
    super(previewOnly)
    this.name = 'PreviewUnavailableError'
  }
}

/** Browser-only state. Never imports main/preload, reads disk, or calls a service. */
export function createPreviewApi(empty = false): DesktopApi {
  const data = previewBootstrap(empty)
  const details = new Map((empty ? [] : previewRunDetails()).map((detail) => [detail.run.id, detail]))
  const files = empty ? [] : previewFiles()
  const copy = <T,>(value: T): T => structuredClone(value)
  const now = (): string => new Date().toISOString()
  const unavailable = async (): Promise<never> => { throw new PreviewUnavailableError() }
  const noSubscription = (): (() => void) => () => undefined

  function required<T>(value: T | undefined): T {
    if (value === undefined) throw new Error('找不到示例数据，请重置 Web 预览。')
    return value
  }

  function updateRun(id: string, patch: Partial<AgentRun>): AgentRun {
    const detail = required(details.get(id))
    Object.assign(detail.run, copy(patch), { updatedAt: now() })
    data.runs = data.runs.map((run) => run.id === id ? detail.run : run)
    return copy(detail.run)
  }

  const api: DesktopApi = {
    getAccountState: async () => ({ ...previewAccount(), existingProjectCount: data.projects.length }),
    listAccountIdentities: async () => [],
    listAccountDevices: async () => [],
    onAccountStateChanged: noSubscription,
    startEmailSignIn: unavailable,
    verifyEmailSignIn: unavailable,
    signInWithGoogle: unavailable,
    copyGoogleAuthorizationUrl: unavailable,
    linkGoogleAccount: unavailable,
    unlinkGoogleAccount: unavailable,
    revokeAccountDevice: unavailable,
    logoutAccount: unavailable,
    logoutAllAccounts: unavailable,
    detectCodingAgents: unavailable,
    completeAgentDetection: unavailable,
    selectOnboardingProjectFolder: unavailable,
    completeProjectOnboarding: unavailable,
    getBootstrap: async () => copy(data),
    getBootstrapPatch: async (keys) => copy(Object.fromEntries(keys.map((key) => [key, data[key]])) as AppBootstrapPatch),
    requestComputerUsePermissions: unavailable,
    requestMicrophoneAccess: unavailable,
    openMicrophoneSettings: unavailable,
    createProject: async (input) => {
      const project = previewProject(crypto.randomUUID(), input.name)
      project.summary = input.summary
      project.focus = input.focus
      Object.assign(project.profile, {
        mission: input.mission, vision: input.vision, productType: input.productType,
        stage: input.stage, websiteUrl: input.websiteUrl ?? null, defaultAgent: input.defaultAgent ?? 'codex'
      })
      data.projects.push(project)
      return copy(project)
    },
    updateProject: async (input) => {
      const index = data.projects.findIndex((project) => project.id === input.id)
      required(data.projects[index])
      data.projects[index] = copy(input)
      return copy(input)
    },
    createGoal: unavailable,
    checkGoal: unavailable,
    updateGoalStatus: async (id, status) => {
      const goal = required(data.goals.find((item) => item.id === id))
      goal.status = status
      goal.updatedAt = now()
      goal.completedAt = status === 'completed' ? now() : null
      return copy(goal)
    },
    updateGoalPriority: async (id, priority) => {
      const goal = required(data.goals.find((item) => item.id === id))
      goal.priority = priority
      return copy(goal)
    },
    completeGoalMilestone: async (goalId, milestoneId) => {
      const goal = required(data.goals.find((item) => item.id === goalId))
      const milestone = required(goal.milestones.find((item) => item.id === milestoneId))
      Object.assign(milestone, { status: 'completed', completedAt: now(), updatedAt: now() })
      return copy(goal)
    },
    deleteGoalMilestone: async (goalId, milestoneId) => {
      const goal = required(data.goals.find((item) => item.id === goalId))
      goal.milestones = goal.milestones.filter((item) => item.id !== milestoneId)
      return copy(goal)
    },
    createDecision: async (input) => {
      const decision = {
        id: crypto.randomUUID(), projectId: input.projectId, goalId: input.goalId,
        kind: 'decision' as const, title: input.title, summary: input.summary ?? '', impact: '',
        urgency: 'medium' as const, confidence: 0, suggestedActions: [], evidenceRefs: input.evidenceRefs ?? [],
        status: 'inbox' as const, source: 'Web 预览示例', createdAt: now()
      }
      data.decisions.unshift(decision)
      return copy(decision)
    },
    updateDecisionStatus: async (id, status) => {
      const decision = required(data.decisions.find((item) => item.id === id))
      decision.status = status
      decision.statusUpdatedAt = now()
      return copy(decision)
    },
    evaluatePermission: unavailable,
    dispatchTask: unavailable,
    dispatchProjectAgent: unavailable,
    createAgentRunDraft: async (input) => {
      const id = input.id ?? crypto.randomUUID()
      if (details.has(id)) return copy(required(details.get(id)))
      const detail: AgentRunDetail = {
        run: {
          id, projectId: input.projectId, decisionId: input.decisionId, goalId: input.goalId,
          milestoneId: input.milestoneId, provider: input.provider ?? data.projects.find(
            (project) => project.id === input.projectId
          )?.profile.defaultAgent ?? data.providerSettings.codingAgents.defaultAgent,
          title: input.title, status: 'draft', draftPrompt: input.draftPrompt ?? null,
          workingDirectory: null, sessionId: null, startedAt: null, completedAt: null,
          summary: '', createdAt: now(), updatedAt: now()
        }, messages: [], artifacts: []
      }
      details.set(id, detail)
      data.runs.unshift(detail.run)
      return copy(detail)
    },
    getAgentRun: async (id) => copy(required(details.get(id))),
    getAgentRunGitSummary: async () => ({
      available: false, repoRoot: null, branch: null, head: null, additions: 0,
      deletions: 0, changedFileCount: 0, changes: [], error: previewOnly
    }),
    getAgentRunArtifactPreview: async (runId, artifactId) => {
      const artifact = required(required(details.get(runId)).artifacts.find((item) => item.id === artifactId))
      const file = required(files.find((item) => item.entry.relativePath === artifact.relativePath
        && item.entry.projectId === artifact.projectId))
      return copy({ artifact, kind: 'markdown', content: file.content, dataUrl: null, size: file.entry.size })
    },
    renameAgentRun: async (id, title) => updateRun(id, { title }),
    updateAgentRunDraftPrompt: async (id, draftPrompt) => updateRun(id, { draftPrompt }),
    updateAgentRunExecutionSettings: async (input) => updateRun(input.id, input),
    archiveAgentRun: async (id) => {
      required(details.get(id))
      details.delete(id)
      data.runs = data.runs.filter((run) => run.id !== id)
    },
    getCompanionStatus: async () => ({
      configuration: null, state: 'disconnected', realtimeState: 'disconnected', lastConnectedAt: null,
      lastSyncedAt: null, lastError: null, pendingEvents: 0, isolatedEvents: 0, iosDevicesOnline: null
    }),
    getCompanionRelayConfiguration: async () => ({ relayUrl: null, available: false }),
    syncCompanionNow: unavailable,
    onCompanionStatusChanged: noSubscription,
    onCompanionDataChanged: noSubscription,
    onOpenAgentRun: noSubscription,
    onAgentRunUpdate: noSubscription,
    sendAgentRunMessage: unavailable,
    stopAgentRunMessage: unavailable,
    respondAgentApproval: unavailable,
    listWorkspaceFiles: async (projectId) => copy(files.filter((file) => file.entry.projectId === projectId).map((file) => file.entry)),
    readWorkspaceFile: async (projectId, path) => copy(required(files.find(
      (file) => file.entry.projectId === projectId && file.entry.relativePath === path
    ))),
    writeWorkspaceFile: async (input) => {
      const file = required(files.find((item) => item.entry.projectId === input.projectId && item.entry.relativePath === input.relativePath))
      file.content = input.content
      file.entry.size = new TextEncoder().encode(input.content).length
      file.entry.modifiedAt = now()
      return copy(file.entry)
    },
    createWorkspaceFolder: unavailable,
    importWorkspaceFiles: unavailable,
    revealWorkspacePath: unavailable,
    runConnector: unavailable,
    runConnectors: unavailable,
    setConnectorEnabled: unavailable,
    configurePostgres: unavailable,
    configureConnector: unavailable,
    generateDailyBriefing: unavailable,
    generateMorningBriefing: unavailable,
    askMorningBriefing: unavailable,
    executeWorkAssistantAction: unavailable,
    configureAgentProvider: unavailable,
    configureCodingAgents: async (input) => {
      data.providerSettings.codingAgents = copy(input)
      return copy(data.providerSettings)
    },
    listCodingAgentModels: async () => ({
      codex: { provider: 'codex', models: [], defaultReasoningEfforts: [], defaultReasoningEffort: null, error: previewOnly },
      claude: { provider: 'claude', models: [], defaultReasoningEfforts: [], defaultReasoningEffort: null, error: previewOnly },
      opencode: { provider: 'opencode', models: [], defaultReasoningEfforts: [], defaultReasoningEffort: null, error: previewOnly }
    }),
    configureAsrProvider: unavailable,
    getAsrModelStatus: async () => ({
      state: 'not-downloaded', model: 'large-v3-turbo-q5_0', bytesDownloaded: 0, totalBytes: 0, error: null
    }),
    downloadAsrModel: unavailable,
    deleteAsrModel: unavailable,
    transcribeAudio: unavailable,
    onAsrDownloadProgress: noSubscription,
    configureTtsProvider: unavailable,
    getMorningBriefingAudio: unavailable,
    testTtsProvider: unavailable,
    designElevenLabsVoice: unavailable,
    saveAutomation: async (input) => {
      const existing = data.automations.find((item) => item.id === input.id)
      const automation = {
        ...copy(input), id: input.id ?? crypto.randomUUID(), status: input.enabled ? 'idle' as const : 'paused' as const,
        lastRunAt: existing?.lastRunAt ?? null, nextRunAt: null, lastError: null,
        createdAt: existing?.createdAt ?? now(), updatedAt: now()
      }
      data.automations = [automation, ...data.automations.filter((item) => item.id !== automation.id)]
      return copy(automation)
    },
    setAutomationEnabled: async (id, enabled) => {
      const automation = required(data.automations.find((item) => item.id === id))
      Object.assign(automation, { enabled, status: enabled ? 'idle' : 'paused', updatedAt: now() })
      return copy(automation)
    },
    runAutomation: unavailable,
    approveAutomationRun: unavailable,
    onMorningBriefingReady: noSubscription,
    onAutomationsChanged: noSubscription
  }
  return api
}
