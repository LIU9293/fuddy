import { randomUUID } from 'node:crypto'
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
  CreateAgentRunDraftInput,
  WorkAssistantImageAttachment
} from '../../shared/contracts'
import { AppDatabase } from './database'
import { CliAgentRuntime } from './cli-agent-runtime'
import { PiTaskHarness } from './pi-task-harness'
import { WorkspaceFilesService } from './workspace-files'
import { evaluateAggressivePermission } from '../../shared/permissions'
import { normalizeWorkspaceRoots, primaryWorkspaceRoot } from '../../shared/project-workspaces'
import { buildAgentStoragePolicy } from './agent-runtime-context'
import type { AgentTurnOutcome, AgentTurnSettledPayload } from '../../shared/companion-sync'
import { agentToolPresentation } from '../../shared/agent-activity'
import {
  AgentProviderRegistry,
  createDefaultAgentProviderRegistry
} from './agent-provider-registry'

type ResolvedDispatchTaskInput = Omit<DispatchTaskInput, 'provider'> & {
  provider: AgentRunProvider
}

export const AGENT_RUN_INACTIVITY_TIMEOUT_MS = 10 * 60_000

class AgentRunStoppedError extends Error {
  constructor() {
    super('Agent Run 当前回复已停止。')
    this.name = 'AgentRunStoppedError'
  }
}

function runWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const rejectForAbort = (): void => {
      rejectPromise(signal.reason instanceof Error ? signal.reason : new Error('Agent Run 已停止。'))
    }
    if (signal.aborted) {
      rejectForAbort()
      return
    }
    signal.addEventListener('abort', rejectForAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', rejectForAbort)
        resolvePromise(value)
      },
      (error) => {
        signal.removeEventListener('abort', rejectForAbort)
        rejectPromise(error)
      }
    )
  })
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
  private readonly activeTurns = new Map<string, {
    abortController: AbortController
    settled: Promise<void>
  }>()
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
    cliRuntime: CliAgentRuntime,
    private readonly inactivityTimeoutMs = AGENT_RUN_INACTIVITY_TIMEOUT_MS,
    private readonly onRunSettled?: (run: AgentRun, turn: AgentTurnSettledPayload) => void | Promise<void>,
    providerRegistry?: AgentProviderRegistry
  ) {
    this.providerRegistry = providerRegistry ?? createDefaultAgentProviderRegistry(piHarness, cliRuntime)
    this.database.recoverInterruptedAgentRuns(new Date().toISOString())
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
    onUpdate: (update: AgentRunStreamUpdate) => void = () => undefined
  ): Promise<DispatchTaskResult> {
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
      projectId: input.projectId,
      decisionId: input.decisionId ?? null,
      goalId: input.goalId ?? null,
      milestoneId: input.milestoneId ?? null,
      provider: resolvedInput.provider,
      model: null,
      reasoningEffort: null,
      title: input.title?.trim() || input.prompt.trim().split('\n')[0].slice(0, 80),
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
    this.database.createAgentRun(run)
    const createdUpdate = { type: 'created', run } as const
    this.publishRunUpdate(run.id, createdUpdate)
    onUpdate(createdUpdate)
    const detail = await this.sendMessage(run.id, input.prompt, onUpdate)
    return { detail, message: detail.run.summary }
  }

  createDraft(input: CreateAgentRunDraftInput): AgentRunDetail {
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
      projectId: input.projectId,
      decisionId: input.decisionId ?? null,
      goalId: input.goalId ?? null,
      milestoneId: input.milestoneId ?? null,
      provider,
      model: null,
      reasoningEffort: null,
      title: input.title.trim(),
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
    this.database.createAgentRun(run)
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
    attachments: WorkAssistantImageAttachment[] = [],
    cancellationSignal?: AbortSignal
  ): Promise<AgentRunDetail> {
    this.database.getAgentRun(runId)
    const previous = this.turnQueueTails.get(runId)
    if (previous) {
      const queuedUpdate = { type: 'status', status: 'queued' } as const
      this.publishRunUpdate(runId, queuedUpdate)
      onUpdate(queuedUpdate)
    }
    const execute = (): Promise<AgentRunDetail> => {
      if (cancellationSignal?.aborted) {
        return Promise.reject(cancellationSignal.reason instanceof Error
          ? cancellationSignal.reason
          : new Error('这次手机操作已停止。'))
      }
      return this.executeTurn(runId, prompt, onUpdate, userMessageId, attachments, cancellationSignal)
    }
    const turn = previous ? previous.then(execute, execute) : execute()
    this.turnQueueTails.set(runId, turn)
    const clearQueueTail = (): void => {
      if (this.turnQueueTails.get(runId) === turn) this.turnQueueTails.delete(runId)
    }
    void turn.then(clearQueueTail, clearQueueTail)
    return turn
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
    attachments: WorkAssistantImageAttachment[] = [],
    cancellationSignal?: AbortSignal
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
      inactivityTimer = setTimeout(() => {
        const minutes = Math.max(1, Math.round(this.inactivityTimeoutMs / 60_000))
        abortController.abort(new Error(`Agent 连续 ${minutes} 分钟没有返回消息或工具活动，本轮已自动停止。你可以发送新消息重试。`))
      }, this.inactivityTimeoutMs)
      inactivityTimer.unref?.()
    }
    const trackedUpdate = (update: AgentRunStreamUpdate): void => {
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
    const attachmentFiles = attachments.map((attachment) => {
      const safeName = attachment.name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'attachment'
      const relativePath = `_attachments/agent-runs/${runId}/${attachment.id}-${safeName}`
      this.workspaceFiles.writeDataUrl(run.projectId, relativePath, attachment.dataUrl)
      return {
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        relativePath,
        absolutePath: this.workspaceFiles.resolvePath(run.projectId, relativePath)
      }
    })
    const runtimePrompt = attachmentFiles.length > 0
      ? `${prompt.trim()}\n\n用户同时提供了以下附件，请读取并结合附件内容完成任务：\n${attachmentFiles.map((file) => `- ${file.name}: ${file.absolutePath}`).join('\n')}`
      : prompt.trim()
    const projectFilesBefore = new Map(
      this.workspaceFiles.list(run.projectId)
        .filter((entry) => entry.kind === 'file' && !entry.relativePath.startsWith('_attachments/'))
        .map((entry) => [entry.relativePath, `${entry.size}:${entry.modifiedAt}`])
    )
    const userMessage: AgentRunMessage = {
      id: userMessageId?.trim() || randomUUID(),
      runId,
      role: 'user',
      content: prompt.trim(),
      eventType: null,
      toolName: null,
      metadata: attachmentFiles.length > 0
        ? { attachments: attachmentFiles.map(({ absolutePath: _absolutePath, ...file }) => file) }
        : null,
      createdAt: new Date().toISOString()
    }
    this.database.createAgentRunMessage(userMessage)
    const startedAt = new Date().toISOString()
    run = this.database.updateAgentRun({
      ...run,
      status: 'running',
      draftPrompt: null,
      startedAt: run.startedAt ?? startedAt,
      completedAt: null,
      updatedAt: startedAt
    })
    this.activeTurns.set(runId, { abortController, settled })
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
        prompt: runtimePrompt,
        history: () => this.database.listAgentRunMessages(runId).filter((message) => message.id !== userMessage.id),
        sessionId: run.sessionId,
        model: run.model,
        reasoningEffort: run.reasoningEffort,
        workingDirectory: run.workingDirectory,
        workspaceRoots: projectWorkspacesFor(this.database, run.projectId),
        filesDirectory: this.workspaceFiles.getRoot(run.projectId),
        abortController,
        onUpdate: trackedUpdate,
        onTool: recordTool,
        onApproval: (request) => this.waitForApproval(run.id, request, trackedUpdate),
        onSessionId: (sessionId) => {
          touchActivity()
          run = this.database.updateAgentRun({ ...run, sessionId, updatedAt: new Date().toISOString() })
        }
      }), abortController.signal)
      const response = result.text
      if (result.sessionId && result.sessionId !== run.sessionId) {
        run = this.database.updateAgentRun({ ...run, sessionId: result.sessionId, updatedAt: new Date().toISOString() })
      }

      flushReasoning()
      flushVisibleTextAtTurnEnd()
      const finalResponse = response
      const assistantMessage: AgentRunMessage = {
        id: randomUUID(),
        runId,
        role: 'assistant',
        content: finalResponse,
        eventType: null,
        toolName: null,
        metadata: null,
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
        this.tryRegisterChangedProjectFiles(run, projectFilesBefore)
        return this.database.getAgentRunDetail(run.id)
      }
      const message = error instanceof Error ? error.message : 'Agent Run 执行失败。'
      const systemMessage: AgentRunMessage = {
        id: randomUUID(),
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
      this.publishTurnSettled(run.id, userMessage.id, 'failed')
      this.tryRegisterChangedProjectFiles(run, projectFilesBefore)
      return this.database.getAgentRunDetail(run.id)
    } finally {
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
    const lines = project
      ? [
          `项目：${project.name}`,
          `项目简介：${project.summary}`,
          `使命：${project.profile.mission}`,
          `愿景：${project.profile.vision}`,
          `当前状态：${project.profile.currentState.summary}`,
          project.profile.currentState.facts.length > 0
            ? `用户确认事实：${project.profile.currentState.facts.join('；')}`
            : null,
          `当前重点：${project.profile.focusAreas.join('、') || '未设置'}`,
          `Workspace Roots：${normalizeWorkspaceRoots(project.profile).workspaceRoots.map((root) => `${root.label}=${root.path}${root.id === normalizeWorkspaceRoots(project.profile).primaryWorkspaceRootId ? '（主）' : ''}`).join('；') || '未设置'}`
        ]
      : ['项目：共享任务']
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
    const workspaceRoots = projectWorkspacesFor(this.database, run.projectId)
    const workingDirectory = run.workingDirectory ?? this.workspaceFiles.getRoot(run.projectId)
    lines.push(buildAgentStoragePolicy({
      workingDirectory,
      workspaceRoots,
      filesDirectory: this.workspaceFiles.getRoot(run.projectId)
    }))
    return lines.filter((line): line is string => Boolean(line)).join('\n')
  }

  private registerChangedProjectFiles(run: AgentRun, before: Map<string, string>): void {
    const changed = this.workspaceFiles.list(run.projectId).filter((entry) =>
      entry.kind === 'file'
      && !entry.relativePath.startsWith('_attachments/')
      && before.get(entry.relativePath) !== `${entry.size}:${entry.modifiedAt}`
    )
    for (const entry of changed) {
      this.database.upsertAgentRunArtifact({
        id: randomUUID(),
        runId: run.id,
        projectId: run.projectId,
        relativePath: entry.relativePath,
        label: entry.name,
        mimeType: entry.mimeType,
        createdAt: new Date().toISOString()
      })
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
