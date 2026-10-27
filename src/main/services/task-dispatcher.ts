import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import type {
  AgentRun,
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentRunArtifact,
  AgentRunDetail,
  AgentRunMessage,
  AgentRunStreamUpdate,
  AgentRunProvider,
  DispatchTaskInput,
  DispatchTaskResult,
  CreateAgentRunDraftInput
} from '../../shared/contracts'
import { AppDatabase } from './database'
import { CliAgentRuntime } from './cli-agent-runtime'
import { PiTaskHarness } from './pi-task-harness'
import { WorkspaceFilesService } from './workspace-files'
import { evaluateAggressivePermission } from '../../shared/permissions'
import { normalizeWorkspaceRoots, primaryWorkspaceRoot } from '../../shared/project-workspaces'
import { buildProjectContext } from './agent-runtime-context'
import type { AgentTurnOutcome, AgentTurnSettledPayload } from '../../shared/companion-sync'
import { agentToolPresentation } from '../../shared/agent-activity'
import { agentRunRetryTarget } from '../../shared/agent-run-retry'
import {
  AgentProviderRegistry,
  createDefaultAgentProviderRegistry
} from './agent-provider-registry'
import { throwIfCancelled } from './cancellation'
import { defaultAgentRunTitle, firstMessageTitle, parseGeneratedChatTitle } from '../../shared/agent-run-title'
import type { ChatAttachmentInput } from '../../shared/chat-attachments'
import type { RuntimeAttachment } from '../../shared/chat-attachments'
import type { ChatActor } from '../../shared/project-sharing'
import { persistInputAttachments, registerLinkedArtifacts, describeArtifact, snapshotOutput } from './agent-attachments'

type ResolvedDispatchTaskInput = Omit<DispatchTaskInput, 'provider'> & {
  provider: AgentRunProvider
}

export const AGENT_RUN_INACTIVITY_TIMEOUT_MS = 10 * 60_000

class AgentRunStoppedError extends Error {
  constructor() {
    super('Chat 当前回复已停止。')
    this.name = 'AgentRunStoppedError'
  }
}

async function runWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  // Adapters receive the same signal and own runtime cleanup. Keep the queue
  // occupied until they settle, even when cancellation has already been requested.
  const value = await operation
  throwIfCancelled(signal)
  return value
}

function projectWorkspacesFor(database: AppDatabase, projectId: string | null): string[] {
  if (!projectId) return []
  const project = database.listProjects().find((item) => item.id === projectId)
  return project ? normalizeWorkspaceRoots(project.profile).workspaceRoots.map((root) => root.path) : []
}

function isWithinWorkspace(target: string, root: string): boolean {
  const relation = relative(resolve(root), resolve(target))
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))
}

export class TaskDispatcher {
  private readonly providerRegistry: AgentProviderRegistry
  private readonly runUpdateListeners = new Set<(runId: string, update: AgentRunStreamUpdate) => void>()
  private readonly turnQueueTails = new Map<string, Promise<AgentRunDetail>>()
  private readonly pendingTurnPromises = new Map<string, Promise<AgentRunDetail>>()
  private readonly steerOperations = new Map<string, Promise<void>>()
  private readonly pendingTitles = new Map<AbortController, Promise<void>>()
  private readonly activeTurns = new Map<string, {
    requestId: string
    abortController: AbortController
    settled: Promise<void>
    steer?: (prompt: string, attachments: RuntimeAttachment[], requestId: string) => Promise<void>
  }>()
  private stopping = false
  private readonly pendingApprovals = new Map<string, {
    runId: string
    auditId: string
    resolve: (decision: AgentApprovalDecision) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  constructor(
    private readonly database: AppDatabase,
    piHarness: PiTaskHarness,
    private readonly workspaceFiles: WorkspaceFilesService,
    private readonly cliRuntime: CliAgentRuntime,
    private readonly inactivityTimeoutMs = AGENT_RUN_INACTIVITY_TIMEOUT_MS,
    private readonly onRunSettled?: (run: AgentRun, turn: AgentTurnSettledPayload) => void | Promise<void>,
    providerRegistry?: AgentProviderRegistry,
    private readonly generateTitle?: (prompt: string, signal: AbortSignal) => Promise<string | null>
  ) {
    this.providerRegistry = providerRegistry ?? createDefaultAgentProviderRegistry(piHarness, cliRuntime)
    this.database.recoverInterruptedAgentRuns(new Date().toISOString())
    this.database.recoverInterruptedAgentTurns()
    const localUserId = this.database.getSetting<{ user?: { id?: string } } | null>('account.cached-state', null)?.user?.id
    const recoverableTurns = this.database.listQueuedAgentTurns().filter((turn) =>
      !turn.requestedByUserId || turn.requestedByUserId === localUserId)
    // Queued requests have not entered a provider, so replay is safe. A request
    // marked running needs review after a crash and is never re-executed here.
    // A different account's request requires fresh remote authorization first.
    if (recoverableTurns.length > 0) queueMicrotask(() => {
      for (const turn of recoverableTurns) {
        void this.sendMessage(turn.runId, turn.prompt, undefined, turn.requestId,
          turn.attachments, undefined, turn.requestedByUserId
            ? { userId: turn.requestedByUserId, snapshot: turn.authorSnapshot ?? { displayName: '历史用户', avatarRef: null } }
            : null).catch(() => undefined)
      }
    })
  }

  onRunUpdate(listener: (runId: string, update: AgentRunStreamUpdate) => void): () => void {
    this.runUpdateListeners.add(listener)
    return () => this.runUpdateListeners.delete(listener)
  }

  private publishRunUpdate(runId: string, update: AgentRunStreamUpdate): void {
    for (const listener of this.runUpdateListeners) {
      try {
        listener(runId, update)
      } catch {
        // A renderer observer must never interrupt the Agent turn itself.
      }
    }
  }

  private publishTurnSettled(runId: string, turnId: string, outcome: AgentTurnOutcome): void {
    const run = this.database.getAgentRunDetail(runId).run
    const payload: AgentTurnSettledPayload = {
      runId: run.id,
      turnId,
      title: run.title,
      outcome,
      summary: run.summary.replace(/\s+/g, ' ').trim().slice(0, 600),
      settledAt: run.updatedAt
    }
    this.database.enqueueAgentTurnSettled(payload)
    void Promise.resolve(this.onRunSettled?.(run, payload)).catch(() => undefined)
  }

  async dispatch(
    input: DispatchTaskInput,
    onUpdate: (update: AgentRunStreamUpdate) => void = () => undefined,
    cancellationSignal?: AbortSignal,
    actor?: ChatActor | null
  ): Promise<DispatchTaskResult> {
    throwIfCancelled(cancellationSignal)
    const now = new Date().toISOString()
    const project = input.projectId
      ? this.database.listProjects().find((item) => item.id === input.projectId) ?? null
      : null
    const resolvedInput: ResolvedDispatchTaskInput = {
      ...input,
      provider: input.provider ?? project?.profile.defaultAgent ?? 'pi'
    }
    this.validateInput(resolvedInput)
    const projectWorkspaces = project ? normalizeWorkspaceRoots(project.profile).workspaceRoots : []
    const requestedDirectory = input.workingDirectory?.trim() || null
    if (requestedDirectory && project && !projectWorkspaces.some((root) => isWithinWorkspace(requestedDirectory, root.path))) {
      throw new Error('Working directory 必须位于项目配置的 Workspace Root 内。')
    }
    const workingDirectory = requestedDirectory
      ?? (project ? primaryWorkspaceRoot(project.profile)?.path ?? null : this.workspaceFiles.getRoot(null))
    if (project && !workingDirectory) {
      throw new Error('这个项目需要先配置至少一个 Workspace Root。')
    }

    const run: AgentRun = {
      id: randomUUID(),
      createdByUserId: actor?.userId ?? null,
      createdBySnapshot: actor?.snapshot ?? null,
      projectId: input.projectId,
      decisionId: input.decisionId ?? null,
      goalId: input.goalId ?? null,
      milestoneId: input.milestoneId ?? null,
      provider: resolvedInput.provider,
      model: null,
      reasoningEffort: null,
      title: input.title?.trim() || defaultAgentRunTitle,
      status: 'queued',
      sessionId: null,
      workingDirectory,
      startedAt: null,
      completedAt: null,
      summary: '等待首次运行',
      draftPrompt: null,
      createdAt: now,
      updatedAt: now
    }
    this.database.createAgentRun(run, !input.title?.trim())
    const createdUpdate = { type: 'created', run } as const
    this.publishRunUpdate(run.id, createdUpdate)
    onUpdate(createdUpdate)
    const detail = await this.sendMessage(run.id, input.prompt, onUpdate, undefined, [], cancellationSignal, actor)
    throwIfCancelled(cancellationSignal)
    return { detail, message: detail.run.summary }
  }

  createDraft(input: CreateAgentRunDraftInput, actor?: ChatActor | null): AgentRunDetail {
    const now = new Date().toISOString()
    const project = input.projectId
      ? this.database.listProjects().find((item) => item.id === input.projectId) ?? null
      : null
    const provider = input.provider ?? project?.profile.defaultAgent ?? 'pi'
    this.validateInput(input)
    const projectWorkspaces = project ? normalizeWorkspaceRoots(project.profile).workspaceRoots : []
    const requestedDirectory = input.workingDirectory?.trim() || null
    if (requestedDirectory && project && !projectWorkspaces.some((root) => isWithinWorkspace(requestedDirectory, root.path))) {
      throw new Error('Working directory 必须位于项目配置的 Workspace Root 内。')
    }
    const workingDirectory = requestedDirectory
      ?? (project ? primaryWorkspaceRoot(project.profile)?.path ?? null : this.workspaceFiles.getRoot(null))
    if (project && !workingDirectory) {
      throw new Error('这个项目需要先配置至少一个 Workspace Root。')
    }

    const run: AgentRun = {
      id: input.id?.trim() || randomUUID(),
      createdByUserId: actor?.userId ?? null,
      createdBySnapshot: actor?.snapshot ?? null,
      projectId: input.projectId,
      decisionId: input.decisionId ?? null,
      goalId: input.goalId ?? null,
      milestoneId: input.milestoneId ?? null,
      provider,
      model: null,
      reasoningEffort: null,
      title: input.title?.trim() || defaultAgentRunTitle,
      status: 'draft',
      sessionId: null,
      workingDirectory,
      startedAt: null,
      completedAt: null,
      summary: '等待首次消息',
      draftPrompt: input.draftPrompt?.trim() || null,
      createdAt: now,
      updatedAt: now
    }
    this.database.createAgentRun(run, !input.title?.trim() || input.title.trim() === defaultAgentRunTitle)
    this.publishRunUpdate(run.id, { type: 'created', run })
    return this.database.getAgentRunDetail(run.id)
  }

  getDetail(id: string): AgentRunDetail {
    return this.database.getAgentRunDetail(id)
  }

  respondToApproval(requestId: string, decision: AgentApprovalDecision): void {
    const pending = this.pendingApprovals.get(requestId)
    if (!pending) throw new Error('审批请求不存在、已处理或已超时。')
    clearTimeout(pending.timer)
    this.pendingApprovals.delete(requestId)
    this.database.updateAuditOutcome(pending.auditId, decision === 'approve' ? 'approved' : 'rejected')
    pending.resolve(decision)
  }

  async sendMessage(
    runId: string,
    prompt: string,
    onUpdate: (update: AgentRunStreamUpdate) => void = () => undefined,
    userMessageId?: string,
    attachments: ChatAttachmentInput[] = [],
    cancellationSignal?: AbortSignal,
    actor?: ChatActor | null
  ): Promise<AgentRunDetail> {
    this.database.getAgentRun(runId)
    const requestId = userMessageId?.trim() || randomUUID()
    const normalizedPrompt = prompt.trim()
    const existingRequest = this.database.getAgentTurn(requestId)
    if (existingRequest && (existingRequest.runId !== runId || existingRequest.prompt !== normalizedPrompt
      || JSON.stringify(existingRequest.attachments) !== JSON.stringify(attachments)
      || existingRequest.requestedByUserId !== (actor?.userId ?? null))) {
      throw new Error('请求 ID 已用于另一条消息。')
    }
    const inFlight = this.pendingTurnPromises.get(requestId)
    if (inFlight) return inFlight
    if (!existingRequest && this.database.hasAgentRunMessage(runId, requestId)) {
      return this.database.getAgentRunDetail(runId)
    }
    const queued = this.database.enqueueAgentTurn({
      requestId, runId, prompt: normalizedPrompt, attachments,
      requestedByUserId: actor?.userId ?? null, authorSnapshot: actor?.snapshot ?? null
    })
    // A retry may arrive after the account display name changes. The first
    // accepted request owns the author snapshot for both history and execution.
    const acceptedActor: ChatActor | null = queued.requestedByUserId
      ? {
          userId: queued.requestedByUserId,
          snapshot: queued.authorSnapshot ?? { displayName: '历史用户', avatarRef: null }
        }
      : null
    if (queued.status === 'completed' || queued.status === 'failed') return this.database.getAgentRunDetail(runId)
    if (queued.status === 'cancelled') throw new AgentRunStoppedError()
    const pending = this.pendingTurnPromises.get(requestId)
    if (pending) return pending
    if (queued.status !== 'queued') throw new Error('这次请求的执行状态不明，需要确认后才能重试。')
    const previous = this.turnQueueTails.get(runId)
    if (previous) {
      const queuedUpdate = { type: 'status', status: 'queued' } as const
      this.publishRunUpdate(runId, queuedUpdate)
      onUpdate(queuedUpdate)
    }
    const execute = async (): Promise<AgentRunDetail> => {
      if (this.stopping) return Promise.reject(new AgentRunStoppedError())
      if (cancellationSignal?.aborted) {
        return Promise.reject(cancellationSignal.reason instanceof Error
          ? cancellationSignal.reason
          : new Error('这次手机操作已停止。'))
      }
      const steering = this.steerOperations.get(requestId)
      if (steering) await steering.catch(() => undefined)
      if (this.database.getAgentTurn(requestId)?.status === 'completed') return this.database.getAgentRunDetail(runId)
      if (!this.database.claimAgentTurn(requestId)) throw new AgentRunStoppedError()
      return this.executeTurn(runId, normalizedPrompt, onUpdate, requestId, attachments, cancellationSignal, acceptedActor)
        .catch((error: unknown) => {
          this.database.settleAgentTurn(requestId, 'failed')
          throw error
        })
    }
    const turn = previous ? previous.then(execute, execute) : execute()
    this.turnQueueTails.set(runId, turn)
    this.pendingTurnPromises.set(requestId, turn)
    const clearQueueTail = (): void => {
      if (this.turnQueueTails.get(runId) === turn) this.turnQueueTails.delete(runId)
      if (this.pendingTurnPromises.get(requestId) === turn) this.pendingTurnPromises.delete(requestId)
    }
    void turn.then(clearQueueTail, clearQueueTail)
    const detail = await turn
    throwIfCancelled(cancellationSignal)
    return detail
  }

  async retryMessage(
    runId: string,
    errorMessageId: string,
    onUpdate: (update: AgentRunStreamUpdate) => void = () => undefined,
    cancellationSignal?: AbortSignal,
    actor?: ChatActor | null
  ): Promise<AgentRunDetail> {
    throwIfCancelled(cancellationSignal)
    const detail = this.database.getAgentRunDetail(runId)
    const target = agentRunRetryTarget(detail.messages)
    if (!target || target.error.id !== errorMessageId) throw new Error('这条错误已过期，请重试最新的失败消息。')
    const message = target.userMessage
    if (actor && message.authorUserId && actor.userId !== message.authorUserId) throw new Error('只能重试自己发送的消息。')
    const requestId = message.requestId || message.id
    const inFlight = this.pendingTurnPromises.get(requestId)
    if (inFlight) return inFlight
    if (detail.run.status !== 'failed') return detail
    if (this.activeTurns.has(runId) || this.database.listAgentTurnsForRun(runId).length) {
      throw new Error('请等待当前消息完成后再重试。')
    }
    let turn = this.database.getAgentTurn(requestId)
    if (!turn) {
      // Older messages predate the durable queue. Recover only their recorded
      // input, validating attachment bytes against their persisted descriptor.
      const attachments = (message.attachments ?? []).map(descriptor => {
        const artifact = detail.artifacts.find(item => item.id === descriptor.artifactId)
        if (!artifact) throw new Error('原消息附件已不可用，无法重试。')
        const bytes = readFileSync(this.workspaceFiles.resolvePath(artifact.projectId, artifact.relativePath))
        if (bytes.length !== descriptor.size || createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256) {
          throw new Error('原消息附件校验失败，无法重试。')
        }
        return { id: descriptor.id, name: descriptor.filename, mimeType: descriptor.mimeType,
          dataUrl: `data:${descriptor.mimeType};base64,${bytes.toString('base64')}` }
      })
      turn = this.database.enqueueAgentTurn({ requestId, runId, prompt: message.content.trim(), attachments,
        requestedByUserId: message.authorUserId ?? null, authorSnapshot: message.authorSnapshot ?? null })
    } else {
      if (turn.runId !== runId || turn.status !== 'failed') throw new Error('这条消息当前无法重试。')
      if (!this.database.retryFailedAgentTurn(requestId)) throw new Error('这条消息当前无法重试。')
    }
    const originalActor = turn.requestedByUserId
      ? { userId: turn.requestedByUserId, snapshot: turn.authorSnapshot ?? { displayName: `用户 ${turn.requestedByUserId.slice(0, 6)}`, avatarRef: null } }
      : null
    return this.sendMessage(runId, turn.prompt, onUpdate, requestId, turn.attachments, cancellationSignal, originalActor)
  }

  async stopMessage(runId: string): Promise<AgentRunDetail> {
    this.database.getAgentRun(runId)
    const active = this.activeTurns.get(runId)
    if (!active) return this.database.getAgentRunDetail(runId)
    active.abortController.abort(new AgentRunStoppedError())
    this.rejectPendingApprovals(runId)
    await active.settled
    return this.database.getAgentRunDetail(runId)
  }

  async stopRequest(runId: string, requestId: string, actorUserId?: string | null): Promise<AgentRunDetail> {
    const turn = this.database.getAgentTurn(requestId)
    if (!turn || turn.runId !== runId || turn.status !== 'running') {
      throw new Error('这条消息当前没有运行。')
    }
    if (actorUserId && turn.requestedByUserId !== actorUserId) {
      throw new Error('只能停止自己提交的消息。')
    }
    if (this.activeTurns.get(runId)?.requestId !== requestId) {
      throw new Error('当前运行的不是这条消息。')
    }
    return this.stopMessage(runId)
  }

  listPendingTurns(runId: string): import('../../shared/agent-turn-queue').AgentTurnQueueSummary[] {
    this.database.getAgentRun(runId)
    return this.database.listAgentTurnsForRun(runId).map((turn) => ({
      requestId: turn.requestId, runId: turn.runId, prompt: turn.prompt,
      requestedByUserId: turn.requestedByUserId, authorSnapshot: turn.authorSnapshot,
      status: turn.status, enqueuedAt: turn.enqueuedAt, attachmentCount: turn.attachments.length
    }))
  }

  cancelQueuedTurn(requestId: string, actorUserId?: string | null): boolean {
    const turn = this.database.getAgentTurn(requestId)
    if (!turn) return false
    if (actorUserId && turn.requestedByUserId !== actorUserId) {
      throw new Error('只能取消自己提交的排队消息。')
    }
    return this.database.cancelQueuedAgentTurn(requestId)
  }

  async steerQueuedTurn(requestId: string, actorUserId?: string | null): Promise<AgentRunDetail> {
    const turn = this.database.getAgentTurn(requestId)
    if (!turn || turn.status !== 'queued') throw new Error('这条消息当前没有等待发送。')
    if (turn.requestedByUserId && turn.requestedByUserId !== actorUserId) throw new Error('只能 Steer 自己提交的消息。')
    const active = this.activeTurns.get(turn.runId)
    const steer = active?.steer
    if (!active || !steer || active.abortController.signal.aborted) {
      throw new Error('当前 Agent 暂时无法接收 Steer；消息仍在队列中。')
    }
    if (!this.database.claimAgentTurnForSteer(requestId)) throw new Error('这条消息的状态已变化，请刷新后重试。')
    const operation = Promise.resolve().then(async () => {
      const run = this.database.getAgentRun(turn.runId)
      const files = persistInputAttachments(this.database, this.workspaceFiles, run, requestId, turn.attachments)
      await steer(turn.prompt, files.runtime, requestId)
      this.database.createAgentRunMessage({
        id: requestId,
        requestId,
        runId: turn.runId,
        role: 'user',
        content: turn.prompt,
        eventType: null,
        toolName: null,
        metadata: null,
        attachments: files.descriptors,
        authorUserId: turn.requestedByUserId,
        authorSnapshot: turn.authorSnapshot,
        createdAt: new Date().toISOString()
      })
      this.database.finishAgentTurnSteer(requestId)
    }).catch((error: unknown) => {
      this.database.releaseAgentTurnSteer(requestId)
      throw error
    }).finally(() => {
      this.steerOperations.delete(requestId)
    })
    this.steerOperations.set(requestId, operation)
    await operation
    return this.database.getAgentRunDetail(turn.runId)
  }

  async stopAndDrain(): Promise<void> {
    this.stopping = true
    for (const controller of this.pendingTitles.keys()) controller.abort()
    const activeTurns = [...this.activeTurns.values()]
    for (const active of activeTurns) active.abortController.abort(new AgentRunStoppedError())
    for (const runId of new Set([...this.pendingApprovals.values()].map((approval) => approval.runId))) {
      this.rejectPendingApprovals(runId)
    }
    await Promise.allSettled([
      ...activeTurns.map((active) => active.settled),
      ...this.turnQueueTails.values(),
      ...this.pendingTitles.values()
    ])
    await this.cliRuntime.stopAndDrain?.()
  }

  private generateFirstMessageTitle(runId: string, prompt: string): void {
    if (!this.generateTitle || this.stopping) return
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)])
    const task = Promise.resolve().then(() => this.generateTitle!(prompt, signal)).then(title => {
      const normalized = parseGeneratedChatTitle(title)
      if (normalized && !signal.aborted && !this.stopping) {
        const updated = this.database.updateAutomaticAgentRunTitle(runId, normalized)
        this.publishRunUpdate(runId, { type: 'updated', run: updated })
      }
    }).catch(() => undefined).finally(() => this.pendingTitles.delete(controller))
    this.pendingTitles.set(controller, task)
  }

  private rejectPendingApprovals(runId: string): void {
    for (const [requestId, approval] of this.pendingApprovals) {
      if (approval.runId !== runId) continue
      clearTimeout(approval.timer)
      this.pendingApprovals.delete(requestId)
      this.database.updateAuditOutcome(approval.auditId, 'rejected')
      approval.resolve('deny')
    }
  }

  private async executeTurn(
    runId: string,
    prompt: string,
    onUpdate: (update: AgentRunStreamUpdate) => void,
    userMessageId?: string,
    attachments: ChatAttachmentInput[] = [],
    cancellationSignal?: AbortSignal,
    actor?: ChatActor | null
  ): Promise<AgentRunDetail> {
    const abortController = new AbortController()
    const abortForCallerCancellation = (): void => {
      abortController.abort(new AgentRunStoppedError())
      this.rejectPendingApprovals(runId)
    }
    if (cancellationSignal?.aborted) {
      throw cancellationSignal.reason instanceof Error
        ? cancellationSignal.reason
        : new Error('这次手机操作已停止。')
    }
    let settleActiveTurn = (): void => undefined
    const settled = new Promise<void>((resolve) => { settleActiveTurn = resolve })
    let inactivityTimer: ReturnType<typeof setTimeout> | null = null
    const runningTools = new Set<string>()
    let turnFinished = false
    let activeReasoning: {
      id: string
      segmentId: string | null
      content: string
      createdAt: string
    } | null = null
    let activeVisibleText = ''
    let activeVisibleMessageId: string | null = null
    let activeVisiblePhase: 'commentary' | 'final_answer' | null = null
    let visibleThinkingIndex = 0
    const persistReasoning = (content: string, segmentId: string | null, id: string = randomUUID(), createdAt = new Date().toISOString()): void => {
      const normalized = content.trim()
      if (!normalized) return
      this.database.createAgentRunMessage({
        id,
        runId,
        role: 'assistant',
        content: normalized,
        eventType: 'reasoning',
        toolName: null,
        metadata: segmentId ? { segmentId } : null,
        createdAt
      })
    }
    const flushReasoning = (): void => {
      if (!activeReasoning) return
      const reasoning = activeReasoning
      activeReasoning = null
      persistReasoning(reasoning.content, reasoning.segmentId, reasoning.id, reasoning.createdAt)
    }
    const flushVisibleTextAsReasoning = (): void => {
      const content = activeVisibleText
      const phase = activeVisiblePhase
      activeVisibleText = ''
      activeVisibleMessageId = null
      activeVisiblePhase = null
      if (phase === 'final_answer') return
      persistReasoning(content, `visible-thinking-${visibleThinkingIndex++}`)
    }
    const flushVisibleTextAtTurnEnd = (): void => {
      if (activeVisiblePhase === 'commentary') {
        flushVisibleTextAsReasoning()
        return
      }
      activeVisibleText = ''
      activeVisibleMessageId = null
      activeVisiblePhase = null
    }
    const touchActivity = (): void => {
      if (inactivityTimer) clearTimeout(inactivityTimer)
      inactivityTimer = null
      // Tool execution time belongs to the provider/tool, not the silence
      // watchdog. Keep waiting for its terminal event (or user cancellation).
      if (turnFinished || abortController.signal.aborted || runningTools.size > 0) return
      inactivityTimer = setTimeout(() => {
        const minutes = Math.max(1, Math.round(this.inactivityTimeoutMs / 60_000))
        abortController.abort(new Error(`未检测到正在执行的工具，且连续 ${minutes} 分钟未收到 Agent 运行进展，本轮已自动停止。可能正在等待模型响应或网络恢复，你可以发送新消息重试。`))
      }, this.inactivityTimeoutMs)
      inactivityTimer.unref?.()
    }
    const trackedUpdate = (update: AgentRunStreamUpdate): void => {
      if (update.type === 'tool') {
        const key = update.toolCallId ? `id:${update.toolCallId}` : `name:${update.toolName}`
        if (update.status === 'running') runningTools.add(key)
        else runningTools.delete(key)
      }
      touchActivity()
      if (update.type === 'reasoning_delta') {
        if (activeVisibleText.trim()) flushVisibleTextAsReasoning()
        const nextSegmentId = update.segmentId?.trim() || null
        if (activeReasoning?.segmentId && nextSegmentId && activeReasoning.segmentId !== nextSegmentId) {
          flushReasoning()
        }
        activeReasoning ??= {
          id: randomUUID(),
          segmentId: nextSegmentId,
          content: '',
          createdAt: new Date().toISOString()
        }
        activeReasoning.content += update.delta
      } else if (update.type === 'message_delta') {
        flushReasoning()
        const phase = update.phase ?? null
        const continuesCurrentMessage = activeVisibleMessageId === update.messageId && activeVisiblePhase === phase
        if (activeVisibleText.trim() && !continuesCurrentMessage) flushVisibleTextAsReasoning()
        activeVisibleMessageId = update.messageId
        activeVisiblePhase = phase
        activeVisibleText += update.delta
      } else if (update.type === 'tool' || update.type === 'approval') {
        flushReasoning()
        flushVisibleTextAsReasoning()
      } else if (update.type === 'status' && update.status !== 'running') {
        flushReasoning()
      }
      this.publishRunUpdate(runId, update)
      onUpdate(update)
    }
    let run = this.database.getAgentRun(runId)
    const needsTitle = this.database.canGenerateAgentRunTitle(runId)
    run = this.database.updateAutomaticAgentRunTitle(runId, firstMessageTitle(prompt), true)
    const messageId = userMessageId?.trim() || randomUUID()
    const attachmentFiles = persistInputAttachments(this.database, this.workspaceFiles, run, messageId, attachments)
    const projectFilesBefore = new Map(
      this.workspaceFiles.list(run.projectId)
        .filter((entry) => entry.kind === 'file' && !entry.relativePath.startsWith('_attachments/'))
        .map((entry) => [entry.relativePath, `${entry.size}:${entry.modifiedAt}`])
    )
    const existingUserMessage = this.database.listAgentRunMessages(runId).find(message => message.id === messageId && message.role === 'user')
    const userMessage: AgentRunMessage = existingUserMessage ?? {
      id: messageId,
      authorUserId: actor?.userId ?? null,
      authorSnapshot: actor?.snapshot ?? null,
      requestId: userMessageId ?? null,
      runId,
      role: 'user',
      content: prompt.trim(),
      eventType: null,
      toolName: null,
      metadata: null,
      attachments: attachmentFiles.descriptors,
      createdAt: new Date().toISOString()
    }
    const startedAt = new Date().toISOString()
    run = this.database.startAgentTurn(userMessage, {
      ...run,
      status: 'running',
      visibility: 'published',
      draftPrompt: null,
      startedAt: run.startedAt ?? startedAt,
      completedAt: null,
      updatedAt: startedAt
    }, Boolean(existingUserMessage))
    this.activeTurns.set(runId, { requestId: messageId, abortController, settled })
    if (needsTitle) this.generateFirstMessageTitle(runId, prompt)
    trackedUpdate({ type: 'status', status: 'running' })

    const recordTool = (toolName: string, detail: string, metadata?: Record<string, unknown>): void => {
      touchActivity()
      flushReasoning()
      flushVisibleTextAsReasoning()
      const presentation = agentToolPresentation(toolName, detail, metadata ?? null)
      const failed = metadata?.status === 'failed'
        || metadata?.isError === true
        || metadata?.is_error === true
      const toolMessage: AgentRunMessage = {
        id: randomUUID(),
        runId,
        role: 'tool',
        content: detail || toolName,
        eventType: 'tool',
        toolName,
        metadata: {
          ...(metadata ?? {}),
          status: failed ? 'failed' : 'completed',
          toolKind: presentation.kind,
          toolSummary: presentation.summary
        },
        createdAt: new Date().toISOString()
      }
      this.database.createAgentRunMessage(toolMessage)
      if (metadata?.artifact === true && typeof metadata.relativePath === 'string') {
        const artifact: AgentRunArtifact = {
          id: randomUUID(),
          runId,
          projectId: run.projectId,
          relativePath: metadata.relativePath,
          label: basename(metadata.relativePath),
          mimeType: typeof metadata.mimeType === 'string' ? metadata.mimeType : null,
          createdAt: new Date().toISOString()
        }
        this.database.upsertAgentRunArtifact(artifact)
      }
    }

    cancellationSignal?.addEventListener('abort', abortForCallerCancellation, { once: true })
    if (cancellationSignal?.aborted) abortForCallerCancellation()
    try {
      const result = await runWithAbort(this.providerRegistry.runTurn(run.provider, {
        runId,
        projectId: run.projectId,
        projectContext: this.buildRunContext(run),
        prompt: prompt.trim(),
        attachments: attachmentFiles.runtime,
        history: () => this.database.listAgentRunMessages(runId).filter((message) => message.id !== userMessage.id),
        sessionId: run.sessionId,
        codexSessionOwned: this.database.ownsCodexSession(runId, run.sessionId),
        onCodexSessionReady: ready => {
          touchActivity()
          run = this.database.bindCodexSession(runId, ready)
        },
        model: run.model,
        reasoningEffort: run.reasoningEffort,
        workingDirectory: run.workingDirectory,
        workspaceRoots: projectWorkspacesFor(this.database, run.projectId),
        filesDirectory: this.workspaceFiles.getRoot(run.projectId),
        abortController,
        onUpdate: trackedUpdate,
        onActivity: touchActivity,
        onAccountContext: context => this.database.updateAgentRunAccountContext(runId, context),
        onTool: recordTool,
        onApproval: (request) => this.waitForApproval(run.id, request, trackedUpdate),
        onSessionId: (sessionId) => {
          touchActivity()
          run = this.database.updateAgentRun({ ...run, sessionId, updatedAt: new Date().toISOString() })
        },
        onSteerReady: (steer) => {
          const active = this.activeTurns.get(runId)
          if (active?.abortController === abortController) active.steer = steer ?? undefined
        }
      }), abortController.signal)
      const response = result.text
      if (result.sessionId && result.sessionId !== run.sessionId) {
        run = this.database.updateAgentRun({ ...run, sessionId: result.sessionId, updatedAt: new Date().toISOString() })
      }

      flushReasoning()
      flushVisibleTextAtTurnEnd()
      const finalResponse = registerLinkedArtifacts(this.database, this.workspaceFiles, run, response, projectWorkspacesFor(this.database, run.projectId))
      this.tryRegisterChangedProjectFiles(run, projectFilesBefore)
      const assistantMessageId = randomUUID()
      const outputAttachments = this.database.getAgentRunDetail(run.id).artifacts
        .filter(artifact => !artifact.relativePath.startsWith('_attachments/') && (
          finalResponse.includes(encodeURI(artifact.relativePath)) || !projectFilesBefore.has(artifact.relativePath)
        )).flatMap(artifact => {
          try { return [describeArtifact(artifact, this.workspaceFiles, assistantMessageId)] } catch { return [] }
        })
      const assistantMessage: AgentRunMessage = {
        id: assistantMessageId,
        runId,
        role: 'assistant',
        content: finalResponse,
        eventType: null,
        toolName: null,
        metadata: null,
        attachments: outputAttachments,
        createdAt: new Date().toISOString()
      }
      this.database.createAgentRunMessage(assistantMessage)
      const updatedAt = new Date().toISOString()
      run = this.database.updateAgentRun({
        ...run,
        status: 'idle',
        summary: finalResponse.replace(/\s+/g, ' ').slice(0, 240),
        updatedAt
      })
      trackedUpdate({ type: 'status', status: 'idle' })
      this.database.settleAgentTurn(messageId, 'completed')
      this.publishTurnSettled(run.id, userMessage.id, 'completed')
      this.tryRegisterChangedProjectFiles(run, projectFilesBefore)
      return this.database.getAgentRunDetail(run.id)
    } catch (error) {
      flushReasoning()
      flushVisibleTextAtTurnEnd()
      if (error instanceof AgentRunStoppedError || abortController.signal.reason instanceof AgentRunStoppedError) {
        run = this.database.updateAgentRun({
          ...run,
          status: 'idle',
          summary: run.summary === '等待首次消息' ? '当前回复已停止' : run.summary,
          updatedAt: new Date().toISOString()
        })
        trackedUpdate({ type: 'status', status: 'idle', detail: '当前回复已停止。' })
        this.database.settleAgentTurn(messageId, 'cancelled')
        this.tryRegisterChangedProjectFiles(run, projectFilesBefore)
        return this.database.getAgentRunDetail(run.id)
      }
      const message = error instanceof Error ? error.message : 'Chat 执行失败。'
      const systemMessage: AgentRunMessage = {
        id: randomUUID(),
        requestId: messageId,
        runId,
        role: 'system',
        content: message,
        eventType: 'error',
        toolName: null,
        metadata: null,
        createdAt: new Date().toISOString()
      }
      this.database.createAgentRunMessage(systemMessage)
      run = this.database.updateAgentRun({
        ...run,
        status: 'failed',
        summary: message,
        updatedAt: new Date().toISOString()
      })
      trackedUpdate({ type: 'status', status: 'failed', detail: message })
      this.database.settleAgentTurn(messageId, 'failed')
      this.publishTurnSettled(run.id, userMessage.id, 'failed')
      this.tryRegisterChangedProjectFiles(run, projectFilesBefore)
      return this.database.getAgentRunDetail(run.id)
    } finally {
      turnFinished = true
      if (inactivityTimer) clearTimeout(inactivityTimer)
      cancellationSignal?.removeEventListener('abort', abortForCallerCancellation)
      if (this.activeTurns.get(runId)?.abortController === abortController) this.activeTurns.delete(runId)
      settleActiveTurn()
    }
  }

  private waitForApproval(
    runId: string,
    request: Omit<AgentApprovalRequest, 'runId' | 'createdAt'>,
    onUpdate: (update: AgentRunStreamUpdate) => void
  ): Promise<AgentApprovalDecision> {
    const fullRequest: AgentApprovalRequest = {
      ...request,
      runId,
      createdAt: new Date().toISOString()
    }
    const intent = {
      tool: `${request.provider}-approval`,
      action: request.kind,
      target: request.toolName ?? request.command ?? request.title,
      command: request.command ?? undefined,
      description: request.detail
    }
    const evaluation = evaluateAggressivePermission(intent)
    const audit = this.database.recordPermissionEvaluation(intent, evaluation)
    if (evaluation.decision === 'auto-approved') {
      return Promise.resolve('approve')
    }
    return new Promise<AgentApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pendingApprovals.get(request.id)
        if (!pending) return
        this.pendingApprovals.delete(request.id)
        this.database.updateAuditOutcome(audit.id, 'rejected')
        resolve('deny')
      }, 10 * 60_000)
      this.pendingApprovals.set(request.id, { runId, auditId: audit.id, resolve, timer })
      onUpdate({ type: 'approval', request: fullRequest })
    })
  }

  private validateInput(input: Pick<ResolvedDispatchTaskInput, 'projectId' | 'decisionId' | 'goalId' | 'milestoneId'>): void {
    if (input.decisionId) {
      const decision = this.database.listDecisions().find((item) => item.id === input.decisionId)
      if (!decision) throw new Error('关联的收件箱事项不存在。')
      if (input.projectId && decision.projectId !== input.projectId) {
        throw new Error('收件箱事项不属于所选项目。')
      }
    }
    if (input.milestoneId && !input.goalId) {
      throw new Error('关联 Milestone 时必须同时关联 Goal。')
    }
    if (input.goalId) {
      const goal = this.database.getGoal(input.goalId)
      if (input.projectId && goal.projectId !== input.projectId) throw new Error('Goal 不属于所选项目。')
      if (input.milestoneId && !goal.milestones.some((item) => item.id === input.milestoneId)) {
        throw new Error('Milestone 不属于所选 Goal。')
      }
    }
  }

  private buildRunContext(run: AgentRun): string {
    const project = run.projectId
      ? this.database.listProjects().find((item) => item.id === run.projectId) ?? null
      : null
    const goal = run.goalId ? this.database.getGoal(run.goalId) : null
    const milestone = goal?.milestones.find((item) => item.id === run.milestoneId) ?? null
    const lines = [buildProjectContext(project)]
    if (goal) {
      lines.push(`关联目标：${goal.title}`, `目标说明：${goal.description}`)
    }
    if (milestone) {
      lines.push(`关联 Milestone：${milestone.title}`, `Milestone 状态：${milestone.status}`)
    }
    const decision = run.decisionId
      ? this.database.listDecisions().find((item) => item.id === run.decisionId) ?? null
      : null
    if (decision) {
      lines.push(
        `关联收件箱事项：${decision.title}`,
        `事项稳定标识：${decision.dedupeKey ?? decision.id}`,
        `事项最新证据：${decision.summary}`
      )
    }
    return lines.filter((line): line is string => Boolean(line)).join('\n')
  }

  private registerChangedProjectFiles(run: AgentRun, before: Map<string, string>): void {
    const changed = this.workspaceFiles.list(run.projectId).filter((entry) =>
      entry.kind === 'file'
      && !entry.relativePath.startsWith('_attachments/')
      && !entry.relativePath.startsWith('_artifacts/')
      && !entry.relativePath.split('/').some(part => part.startsWith('.'))
      && !/\.(pem|key)$/i.test(entry.name)
      && before.get(entry.relativePath) !== `${entry.size}:${entry.modifiedAt}`
    )
    for (const entry of changed) {
      try {
        snapshotOutput(this.database, this.workspaceFiles, run, this.workspaceFiles.resolvePath(run.projectId, entry.relativePath), entry.name, entry.mimeType)
      } catch { /* An oversized or removed file must not prevent other outputs from being registered. */ }
    }
  }

  private tryRegisterChangedProjectFiles(run: AgentRun, before: Map<string, string>): void {
    try {
      this.registerChangedProjectFiles(run, before)
    } catch {
      // A file-indexing failure must not replace the Agent's actual turn result.
    }
  }
}
