import type { AgentRun, AgentRunDetail, AppBootstrapPatch, DesktopApi } from '../../shared/contracts'
import type { SharedProjectBaselineData } from '../../shared/project-sharing-events'
import type { SharedProjectCommand } from '../../shared/project-sharing-commands'
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
  const previewShareId = '11111111-1111-4111-8111-111111111111'
  const memberId = '22222222-2222-4222-8222-222222222222'
  const shared: SharedProjectBaselineData = {
    version: 1,
    project: { id: previewShareId, name: '协作示例项目', icon: '协',
      summary: '用于检查多人 Chat 的虚构项目。', status: 'active' as const,
      productType: 'macOS App', stage: '设计评审' },
    chats: [{ id: '33333333-3333-4333-8333-333333333333', projectId: previewShareId,
      title: '多人讨论示例', status: 'idle' as const, provider: 'codex' as const,
      executionHostId: '44444444-4444-4444-8444-444444444444',
      createdByUserId: memberId, createdBySnapshot: { displayName: '陈林', avatarRef: null },
      createdAt: now(), updatedAt: now(), archivedAt: null }],
    messages: [{ id: crypto.randomUUID(), runId: '33333333-3333-4333-8333-333333333333',
      role: 'user' as const, content: '请先整理项目共享的验收要点。', authorUserId: memberId,
      authorSnapshot: { displayName: '陈林', avatarRef: null }, createdAt: now() },
    { id: crypto.randomUUID(), runId: '33333333-3333-4333-8333-333333333333',
      role: 'assistant' as const, content: '先确认成员权限、历史范围和执行机状态。',
      authorUserId: null, authorSnapshot: null, createdAt: now() },
    { id: crypto.randomUUID(), runId: '33333333-3333-4333-8333-333333333333',
      role: 'user' as const, content: '我会补充 iPhone 上的阅读体验。',
      authorUserId: 'preview-user', authorSnapshot: { displayName: 'Web 预览', avatarRef: null },
      createdAt: now() }]
  }
  const sharedCommands = new Map<string, SharedProjectCommand>()
  const previewDrafts = new Map<string, string>()

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
    getProjectSharingOverview: async () => ({ share: null, members: [], invitations: [] }),
    activateProjectSharing: unavailable,
    syncProjectSharing: unavailable,
    setProjectSharingHost: unavailable,
    inviteProjectMember: unavailable,
    acceptProjectInvitation: unavailable,
    listSharedProjects: async () => empty ? [] : [{ projectId: previewShareId, role: 'member',
      executionHostId: '44444444-4444-4444-8444-444444444444',
      keyAuthorityHostId: '44444444-4444-4444-8444-444444444444', permissionRevision: 1, keyEpoch: 1 }],
    readSharedProject: async (projectId) => {
      if (projectId !== previewShareId) throw new PreviewUnavailableError()
      return copy(shared)
    },
    requestProjectDeviceGrant: unavailable,
    authorizeProjectDevices: unavailable,
    uploadSharedProjectAttachments: async () => [],
    downloadSharedProjectAttachment: unavailable,
    submitSharedProjectCommand: async ({ projectId, runId, requestId, payload }) => {
      if (projectId !== previewShareId) throw new PreviewUnavailableError()
      const commandId = crypto.randomUUID()
      const resultRunId = payload.type === 'create-chat' ? crypto.randomUUID() : runId
      if (payload.type === 'create-chat' && resultRunId) previewDrafts.set(resultRunId, payload.title)
      if (payload.type === 'rename-chat' && runId) {
        const chat = shared.chats.find((item) => item.id === runId)
        if (chat) chat.title = payload.title
      }
      if (payload.type === 'archive-chat' && runId) {
        const chat = shared.chats.find((item) => item.id === runId)
        if (chat) chat.archivedAt = now()
      }
      if (payload.type === 'send-message' && runId) {
        shared.messages.push({ id: crypto.randomUUID(), runId, role: 'user', content: payload.prompt,
          authorUserId: 'preview-user', authorSnapshot: { displayName: 'Web 预览', avatarRef: null }, createdAt: now() })
        if (!shared.chats.some((item) => item.id === runId)) shared.chats.push({
          id: runId, projectId, title: previewDrafts.get(runId) ?? '新建 Chat', status: 'idle', provider: 'codex',
          executionHostId: '44444444-4444-4444-8444-444444444444',
          createdByUserId: 'preview-user', createdBySnapshot: { displayName: 'Web 预览', avatarRef: null },
          createdAt: now(), updatedAt: now(), archivedAt: null
        })
      }
      const command: SharedProjectCommand = { commandId, projectId, runId, requestId,
        type: payload.type, actorUserId: 'preview-user',
        authorSnapshot: { displayName: 'Web 预览', avatarRef: null },
        sourceDeviceId: 'preview-device', targetHostId: '44444444-4444-4444-8444-444444444444',
        keyEpoch: 1, permissionRevision: 1,
        envelope: { algorithm: 'A256GCM', keyId: 'preview', nonce: 'preview', ciphertext: 'preview' },
        status: 'completed', leaseExpiresAt: null, resultRunId, errorCode: null,
        createdAt: now(), updatedAt: now() }
      sharedCommands.set(commandId, command)
      return copy(command)
    },
    getSharedProjectCommand: async (_projectId, commandId) => copy(required(sharedCommands.get(commandId))),
    listSharedProjectActivity: async () => ({ drafts: [...previewDrafts].map(([runId, title]) => ({ runId, title })), activeTurns: [] }),
    leaveSharedProject: unavailable,
    removeProjectMember: unavailable,
    revokeProjectInvitation: unavailable,
    closeProjectSharing: unavailable,
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
    selectProjectFolder: unavailable,
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
          title: input.title ?? '新建 Chat', status: 'draft', draftPrompt: input.draftPrompt ?? null,
          workingDirectory: null, sessionId: null, startedAt: null, completedAt: null,
          summary: '', createdAt: now(), updatedAt: now()
        }, messages: [], artifacts: []
      }
      details.set(id, detail)
      data.runs.unshift(detail.run)
      return copy(detail)
    },
    listExecutionHosts: async (projectId) => [{ id: 'preview-host', name: '本机（预览）', isCurrent: true, online: true,
      workspaceConfigured: !projectId || Boolean(data.projects.find((project) => project.id === projectId)?.profile.repoPath), unavailableReason: null }],
    getAgentRun: async (id) => copy(required(details.get(id))),
    loadAgentRunHistory: async (id) => copy(required(details.get(id))),
    getAgentRunGitSummary: async () => ({
      available: false, repoRoot: null, branch: null, head: null, additions: 0,
      deletions: 0, changedFileCount: 0, changes: [], error: previewOnly
    }),
    getAgentRunArtifactPreview: async (runId, artifactId) => {
      const artifact = required(required(details.get(runId)).artifacts.find((item) => item.id === artifactId))
      const file = required(files.find((item) => item.entry.relativePath === artifact.relativePath
        && item.entry.projectId === artifact.projectId))
      return copy({ artifact, kind: file.kind === 'markdown' ? 'markdown' : 'text', content: file.content, dataUrl: null, size: file.entry.size })
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
    retryAgentRunMessage: unavailable,
    stopAgentRunMessage: unavailable,
    listAgentRunPendingTurns: async () => [],
    cancelQueuedAgentTurn: unavailable,
    steerQueuedAgentTurn: unavailable,
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
