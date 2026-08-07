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
  DispatchTaskResult
} from '../../shared/contracts'
import { AppDatabase } from './database'
import { CliAgentRuntime } from './cli-agent-runtime'
import { PiTaskHarness } from './pi-task-harness'
import { WorkspaceFilesService } from './workspace-files'
import { evaluateAggressivePermission } from '../../shared/permissions'
import { normalizeWorkspaceRoots, primaryWorkspaceRoot } from '../../shared/project-workspaces'

type ResolvedDispatchTaskInput = Omit<DispatchTaskInput, 'provider'> & {
  provider: AgentRunProvider
}

export const AGENT_RUN_INACTIVITY_TIMEOUT_MS = 10 * 60_000

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
  private readonly pendingApprovals = new Map<string, {
    runId: string
    auditId: string
    resolve: (decision: AgentApprovalDecision) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  constructor(
    private readonly database: AppDatabase,
    private readonly piHarness: PiTaskHarness,
    private readonly workspaceFiles: WorkspaceFilesService,
    private readonly cliRuntime: CliAgentRuntime,
    private readonly inactivityTimeoutMs = AGENT_RUN_INACTIVITY_TIMEOUT_MS
  ) {
    this.database.recoverInterruptedAgentRuns(new Date().toISOString())
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
      goalId: input.goalId ?? null,
      milestoneId: input.milestoneId ?? null,
      provider: resolvedInput.provider,
      title: input.title?.trim() || input.prompt.trim().split('\n')[0].slice(0, 80),
      status: 'queued',
      sessionId: null,
      workingDirectory,
      startedAt: null,
      completedAt: null,
      summary: '等待首次运行',
      createdAt: now,
      updatedAt: now
    }
    this.database.createAgentRun(run)
    onUpdate({ type: 'created', run })
    const detail = await this.executeTurn(run.id, input.prompt, onUpdate)
    return { detail, message: detail.run.summary }
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
    onUpdate: (update: AgentRunStreamUpdate) => void = () => undefined
  ): Promise<AgentRunDetail> {
    const run = this.database.getAgentRun(runId)
    if (run.status === 'running') throw new Error('这个 Agent Run 正在执行，请等待当前回合结束。')
    return this.executeTurn(runId, prompt, onUpdate)
  }

  private async executeTurn(
    runId: string,
    prompt: string,
    onUpdate: (update: AgentRunStreamUpdate) => void
  ): Promise<AgentRunDetail> {
    const abortController = new AbortController()
    let inactivityTimer: ReturnType<typeof setTimeout> | null = null
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
      onUpdate(update)
    }
    let run = this.database.getAgentRun(runId)
    const userMessage: AgentRunMessage = {
      id: randomUUID(),
      runId,
      role: 'user',
      content: prompt.trim(),
      eventType: null,
      toolName: null,
      metadata: null,
      createdAt: new Date().toISOString()
    }
    this.database.createAgentRunMessage(userMessage)
    const startedAt = new Date().toISOString()
    run = this.database.updateAgentRun({
      ...run,
      status: 'running',
      startedAt: run.startedAt ?? startedAt,
      completedAt: null,
      updatedAt: startedAt
    })
    trackedUpdate({ type: 'status', status: 'running' })

    const recordTool = (toolName: string, detail: string, metadata?: Record<string, unknown>): void => {
      touchActivity()
      const toolMessage: AgentRunMessage = {
        id: randomUUID(),
        runId,
        role: 'tool',
        content: detail || toolName,
        eventType: 'tool',
        toolName,
        metadata: metadata ?? null,
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

    try {
      let response: string
      if (run.provider === 'pi') {
        const history = this.database.listAgentRunMessages(runId).filter((message) => message.id !== userMessage.id)
        response = await runWithAbort(this.piHarness.runTurn({
          runId,
          projectId: run.projectId,
          projectContext: this.buildRunContext(run),
          prompt: userMessage.content,
          history,
          sessionId: run.sessionId,
          workingDirectory: run.workingDirectory ?? this.workspaceFiles.getRoot(run.projectId),
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
      } else {
        if (!run.workingDirectory) throw new Error('这个 Agent Run 缺少 working directory。')
        const result = await runWithAbort(this.cliRuntime.runTurn({
          projectId: run.projectId,
          provider: run.provider,
          prompt: run.sessionId
            ? userMessage.content
            : `${this.buildRunContext(run)}\n\n用户任务：\n${userMessage.content}`,
          sessionId: run.sessionId,
          workingDirectory: run.workingDirectory,
          workspaceRoots: projectWorkspacesFor(this.database, run.projectId),
          filesDirectory: this.workspaceFiles.getRoot(run.projectId),
          abortController,
          onUpdate: trackedUpdate,
          onSessionId: (sessionId) => {
            touchActivity()
            run = this.database.updateAgentRun({
              ...run,
              sessionId,
              updatedAt: new Date().toISOString()
            })
          },
          onTool: recordTool,
          onApproval: (request) => this.waitForApproval(run.id, request, trackedUpdate)
        }), abortController.signal)
        response = result.text
        if (result.sessionId && result.sessionId !== run.sessionId) {
          run = this.database.updateAgentRun({ ...run, sessionId: result.sessionId, updatedAt: new Date().toISOString() })
        }
      }

      const assistantMessage: AgentRunMessage = {
        id: randomUUID(),
        runId,
        role: 'assistant',
        content: response,
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
        summary: response.replace(/\s+/g, ' ').slice(0, 240),
        updatedAt
      })
      onUpdate({ type: 'status', status: 'idle' })
      return this.database.getAgentRunDetail(run.id)
    } catch (error) {
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
      onUpdate({ type: 'status', status: 'failed', detail: message })
      return this.database.getAgentRunDetail(run.id)
    } finally {
      if (inactivityTimer) clearTimeout(inactivityTimer)
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

  private validateInput(input: ResolvedDispatchTaskInput): void {
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
    return lines.filter((line): line is string => Boolean(line)).join('\n')
  }
}
