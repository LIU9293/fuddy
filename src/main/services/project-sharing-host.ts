import { statSync } from 'node:fs'
import type { AccountProjectShare } from '../../shared/account'
import { primaryWorkspaceRoot } from '../../shared/project-workspaces'
import { openSharedProjectCommand,
  type SharedProjectCommand, type SharedProjectCommandPayload } from '../../shared/project-sharing-commands'
import type { ChatActor } from '../../shared/project-sharing'
import { AccountRequestError, type AccountService } from './account-service'
import type { AppDatabase } from './database'
import type { ProjectSharingKeyStore } from './project-sharing-key-store'
import type { ProjectSharingTransport } from './project-sharing-transport'
import type { TaskDispatcher } from './task-dispatcher'

const commandPollMs = 15_000
const leaseRenewMs = 15_000

/** Executes only commands claimed from the authenticated account control plane. */
export class ProjectSharingHost {
  private timer: ReturnType<typeof setInterval> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private processing = false

  constructor(
    private readonly database: AppDatabase,
    private readonly account: AccountService,
    private readonly keys: ProjectSharingKeyStore,
    private readonly transport: ProjectSharingTransport,
    private readonly dispatcher: TaskDispatcher
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.processOnce().catch(() => undefined) }, commandPollMs)
    this.timer.unref?.()
    this.heartbeatTimer = setInterval(() => { void this.heartbeat().catch(() => undefined) }, commandPollMs)
    this.heartbeatTimer.unref?.()
    void this.heartbeat().catch(() => undefined)
    void this.processOnce().catch(() => undefined)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.timer = null
    this.heartbeatTimer = null
  }

  private async heartbeat(): Promise<void> {
    if (this.account.getState().status !== 'signed-in') return
    const hostId = this.account.getState().device?.hostId
    if (!hostId) return
    const projects = this.database.listProjects()
    const shares = (await this.account.listProjectShares()).filter((share) =>
      share.role === 'owner' && share.localProjectId
        && projects.some((project) => project.shared?.id === share.localProjectId))
    await Promise.allSettled(shares.map(async (share) => {
      const project = projects.find((item) => item.shared?.id === share.localProjectId)
      const root = project && primaryWorkspaceRoot(project.profile)?.path
      if (!root) return
      try { if (!statSync(root).isDirectory()) return } catch { return }
      await this.keys.getReadable(share)
      if ((await this.account.listProjectBaselines(share.projectId)).length === 0) return
      await this.account.heartbeatProjectHost(share.projectId)
    }))
  }

  async processOnce(): Promise<void> {
    if (this.processing || this.account.getState().status !== 'signed-in') return
    this.processing = true
    try {
      const hostId = this.account.getState().device?.hostId
      if (!hostId) return
      const shares = (await this.account.listProjectShares()).filter((share) =>
        share.role === 'owner' && share.localProjectId
          && this.database.listProjects().some((project) => project.shared?.id === share.localProjectId))
      for (const share of shares) {
        try {
          const sourceDeviceId = this.account.getState().device?.id
          const baselines = await this.account.listProjectBaselines(share.projectId)
          if (sourceDeviceId && !baselines.some((baseline) => baseline.sourceDeviceId === sourceDeviceId)) {
            await this.transport.publishBaseline(share.projectId)
          }
          await this.keys.authorizePendingDevices(share)
          const commands = await this.account.listHostProjectCommands(share.projectId)
          for (const command of commands) {
            if (command.type === 'send-message') {
              // Keep polling while a provider runs so a stop command can be
              // claimed and delivered before that provider finishes.
              void this.executeCommand(share, command).catch(() => undefined)
            } else {
              await this.executeCommand(share, command)
            }
          }
          await this.transport.publishIncremental(share.projectId)
        } catch (error) {
          // Compact only this source when its event log fills. Other projects
          // keep syncing even if a key or network is temporarily unavailable.
          if (error instanceof AccountRequestError && error.code === 'snapshot_required') {
            await this.transport.publishBaseline(share.projectId).catch(() => undefined)
          }
        }
      }
    } finally {
      this.processing = false
    }
  }

  private localProjectId(share: AccountProjectShare): string {
    const project = this.database.listProjects().find((item) => item.shared?.id === share.localProjectId)
    if (!project) throw new Error('本机项目不存在。')
    return project.id
  }

  private async executeCommand(share: AccountProjectShare, pending: SharedProjectCommand): Promise<void> {
    let command: SharedProjectCommand
    try {
      command = await this.account.claimProjectCommand(share.projectId, pending.commandId)
    } catch {
      return
    }
    const abort = new AbortController()
    const leaseTimer = setInterval(() => {
      void this.account.renewProjectCommand(share.projectId, command.commandId)
        .catch(() => abort.abort(new Error('项目成员授权已失效，当前执行已停止。')))
    }, leaseRenewMs)
    leaseTimer.unref?.()
    let resultRunId: string | null = null
    let status: 'completed' | 'failed' = 'completed'
    let errorCode: string | null = null
    try {
      const key = await this.keys.getReadable(share)
      const payload = await openSharedProjectCommand(key, command)
      const actor: ChatActor = { userId: command.actorUserId, snapshot: command.authorSnapshot }
      resultRunId = await this.applyCommand(share, command, payload, actor, abort.signal)
    } catch (error) {
      status = 'failed'
      errorCode = abort.signal.aborted ? 'authorization_lost'
        : error instanceof Error ? 'execution_failed' : 'unknown_error'
      if (command.type === 'send-message' && command.runId && command.requestId) {
        try {
          const run = this.database.getAgentRun(command.runId)
          if (run.visibility === 'published'
            && this.database.hasAgentRunMessage(command.runId, command.requestId)) {
            resultRunId = command.runId
          }
        } catch { /* A message was not persisted, so the draft remains private. */ }
      }
    } finally {
      clearInterval(leaseTimer)
    }
    try {
      await this.account.completeProjectCommand(share.projectId, command.commandId,
        { status, resultRunId, errorCode })
      if (command.type !== 'create-chat') await this.transport.publishIncremental(share.projectId)
    } catch {
      // A lost lease is terminal. The cloud marks an unacknowledged claimed
      // command interrupted; never submit it to a provider again automatically.
    }
  }

  private async applyCommand(
    share: AccountProjectShare, command: SharedProjectCommand,
    payload: SharedProjectCommandPayload, actor: ChatActor, signal: AbortSignal
  ): Promise<string | null> {
    if (signal.aborted) throw signal.reason
    const projectId = this.localProjectId(share)
    if (payload.type === 'create-chat') {
      return this.dispatcher.createDraft({
        id: command.commandId, projectId, title: payload.title, provider: payload.provider
      }, actor).run.id
    }
    const runId = command.runId
    if (!runId) throw new Error('命令缺少 Chat ID。')
    const run = this.database.getAgentRun(runId)
    if (run.projectId !== projectId) throw new Error('Chat 不属于这个项目。')
    if (run.visibility === 'draft' && run.createdByUserId !== actor.userId) {
      throw new Error('草稿 Chat 只允许创建者发送。')
    }
    switch (payload.type) {
      case 'send-message':
        if (run.archivedAt) throw new Error('已归档的 Chat 不能继续发送消息。')
        if (!command.requestId) throw new Error('缺少消息请求 ID。')
        const attachments = await Promise.all((payload.attachments ?? []).map((descriptor) =>
          this.transport.downloadInput(share, descriptor, runId, command.requestId!, actor.userId)))
        await this.dispatcher.sendMessage(runId, payload.prompt, undefined,
          command.requestId, attachments, signal, actor)
        return runId
      case 'cancel-turn':
        if (!command.requestId) throw new Error('缺少消息请求 ID。')
        if (!this.dispatcher.cancelQueuedTurn(command.requestId,
          actor.userId === this.account.getState().user?.id ? null : actor.userId)) {
          throw new Error('消息已经开始或已经取消。')
        }
        return runId
      case 'stop-turn':
        if (!command.requestId) throw new Error('缺少消息请求 ID。')
        if (this.dispatcher.cancelQueuedTurn(command.requestId,
          actor.userId === this.account.getState().user?.id ? null : actor.userId)) {
          return runId
        }
        await this.dispatcher.stopRequest(runId, command.requestId,
          actor.userId === this.account.getState().user?.id ? null : actor.userId)
        return runId
      case 'rename-chat':
      case 'archive-chat':
        if (actor.userId !== this.account.getState().user?.id && run.createdByUserId !== actor.userId) {
          throw new Error('只能管理自己创建的 Chat。')
        }
        if (payload.type === 'rename-chat') this.database.renameAgentRun(runId, payload.title)
        else this.database.archiveAgentRun(runId)
        return runId
    }
  }
}
