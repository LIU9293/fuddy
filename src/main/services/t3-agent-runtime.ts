import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { attachmentPrompt, isNativeImage, type RuntimeAttachment } from '../../shared/chat-attachments'
import { buildAgentInstructions } from './agent-runtime-context'
import { throwIfCancelled } from './cancellation'
import type { CliAgentTurnInput, CliAgentTurnResult } from './cli-agent-runtime'
import type { AgentRunProvider } from '../../shared/contracts'
import type { McpServerLaunchConfig } from './third-party-mcp-runtime'
import type { T3RuntimeProcess } from './t3-runtime-process'
import { AgentSteerDeliveryUnknown, type AgentSteerDelivery, type AgentSteer } from './agent-provider-registry'

const itemSchema = z.object({
  id: z.string(),
  ordinal: z.number().int().nonnegative().optional(),
  type: z.string(),
  status: z.string(),
  parentItemId: z.string().nullable(),
  title: z.string().nullish(),
  text: z.string().optional(),
  phase: z.enum(['commentary', 'partial_answer', 'final_answer']).optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  fileName: z.string().optional(),
  diffStr: z.string().optional(),
  changes: z.array(z.object({ path: z.string() })).optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  toolName: z.string().nullish(),
  requestId: z.string().optional(),
  questions: z.array(z.object({
    id: z.string(), header: z.string().optional(), question: z.string(),
    options: z.array(z.object({
      label: z.string(), description: z.string().optional().default(''),
      value: z.string().optional(), preview: z.string().optional()
    })),
    multiSelect: z.boolean().optional(), allowCustomAnswer: z.boolean().optional(), required: z.boolean().optional()
  })).optional(),
  questionAnswer: z.object({ answers: z.record(z.string(), z.unknown()) }).optional(),
  failure: z.object({ message: z.string().optional() }).optional()
})

const snapshotSchema = z.object({
  sequence: z.number().int().nonnegative(),
  canSteer: z.boolean().optional(),
  run: z.object({ id: z.string(), status: z.string(), attemptId: z.string().nullable() }).nullable(),
  nativeId: z.string().nullable(),
  items: z.array(itemSchema)
})
const acceptedSchema = z.object({ runId: z.string() })
const steerStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('delivered'), ordinal: z.number().int().nonnegative() }),
  z.object({ status: z.enum(['missing', 'pending', 'queued', 'cancelled', 'unknown']) })
])
const terminal = new Set(['completed', 'cancelled', 'interrupted', 'failed', 'rolled_back'])

type TurnItem = z.infer<typeof itemSchema>
const responseActivity = new Set([
  'assistant_message', 'reasoning', 'command_execution', 'file_change',
  'dynamic_tool', 'file_search', 'web_search', 'user_input_request'
])

function selectedQuestionOptions(item: TurnItem): string[] {
  const answers = item.questionAnswer?.answers
  if (!answers) return []
  return (item.questions ?? []).flatMap(question => {
    const value = answers[question.id] ?? answers[question.question]
    const selected = Array.isArray(value) ? value : [value]
    return question.options.filter(option => selected.includes(option.value ?? option.label))
      .map(option => option.label.slice(0, 160))
  }).slice(0, 12)
}

function diffLineCounts(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const match of diff.matchAll(/^([+-])(?!\1\1 )/gm)) {
    if (match[1] === '+') additions += 1
    else deletions += 1
  }
  return { additions, deletions }
}

function nativeImages(attachments: RuntimeAttachment[]): string[] {
  return attachments.filter(file => isNativeImage(file.mimeType)).map(file => file.path)
}

function asTool(item: TurnItem): { name: string; detail: string } | null {
  switch (item.type) {
    case 'command_execution':
      return {
        name: 'runCommand',
        detail: [item.input, item.output].filter(value => typeof value === 'string').join('\n\n').slice(0, 4_000)
      }
    case 'file_change':
      return {
        name: 'applyPatch',
        detail: [item.fileName ?? item.title, item.diffStr].filter(Boolean).join('\n\n').slice(0, 4_000)
      }
    case 'dynamic_tool':
    case 'file_search':
    case 'web_search':
      return { name: item.toolName ?? item.title ?? item.type, detail: item.title ?? '' }
    default:
      return null
  }
}

type T3AgentTurnInput = Omit<CliAgentTurnInput, 'provider' | 'onSteerReady'> & {
  provider: AgentRunProvider
  onSteerReady?: (steer: AgentSteer | null) => void
}

function nativeRequestId(requestId: string, executionStartedAt?: string | null): string {
  return createHash('sha256').update(JSON.stringify([requestId, executionStartedAt ?? null])).digest('hex')
}

export class T3AgentRuntime {

  constructor(
    private readonly process: Pick<T3RuntimeProcess, 'request' | 'watch'>,
    readonly provider: AgentRunProvider = 'codex'
  ) {}

  async runTurn(input: T3AgentTurnInput, servers: McpServerLaunchConfig[]): Promise<CliAgentTurnResult> {
    return this.observeTurn(input, servers, false)
  }

  async recoverTurn(input: T3AgentTurnInput): Promise<CliAgentTurnResult> {
    return this.observeTurn(input, [], true)
  }

  recoverSteer(threadId: string, request: string, executionStartedAt: string | null): Promise<AgentSteerDelivery> {
    return this.observeSteer(threadId, nativeRequestId(request, executionStartedAt), 'deferred')
  }

  private async observeSteer(
    threadId: string, requestId: string, ifMissing?: 'deferred' | 'rejected'
  ): Promise<AgentSteerDelivery> {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const delivery = await this.process.request({ type: 'steer-status', threadId, requestId }, steerStatusSchema)
        .catch(() => ({ status: 'unknown' as const }))
      const { status } = delivery
      if (status === 'delivered') return { timelineOrdinal: delivery.ordinal }
      if (status === 'queued' || (status === 'missing' && ifMissing === 'deferred')) return 'deferred'
      if (status === 'cancelled') return 'cancelled'
      if (status === 'missing' && ifMissing === 'rejected') throw new Error('Agent 已结束或暂时无法接收 Steer。消息仍在队列中。')
      if (status !== 'pending') break
      await delay(250)
    }
    throw new AgentSteerDeliveryUnknown('T3 尚未确认 Steer，重新打开应用后会核对投递结果。')
  }

  private async steer(
    threadId: string, parentRequestId: string, requestId: string, prompt: string, attachments: RuntimeAttachment[]
  ): Promise<AgentSteerDelivery> {
    const accepted = await this.process.request({
      type: 'steer', threadId, parentRequestId, requestId, prompt: attachmentPrompt(prompt, attachments),
      images: attachments.filter(file => isNativeImage(file.mimeType))
    }, z.boolean()).catch(() => null)
    return this.observeSteer(threadId, requestId, accepted === false ? 'rejected' : undefined)
  }

  private async observeTurn(input: T3AgentTurnInput, servers: McpServerLaunchConfig[], recover: boolean): Promise<CliAgentTurnResult> {
    const { runId: threadId, abortController } = input
    const signal = abortController.signal
    if (!threadId || !input.requestId) throw new Error('T3 运行时需要 Chat ID 和消息请求 ID。')
    // The durable queue stamps each claim. Redelivery observes the same claim
    // and a user retry gets its own T3 execution while retaining the local row.
    const requestId = nativeRequestId(input.requestId, input.executionStartedAt)
    if (!recover && this.provider === 'codex' && input.sessionId && !input.codexSessionOwned) {
      throw new Error('旧 Codex 会话需要先完成归属迁移。')
    }
    throwIfCancelled(signal)
    input.onUpdate({ type: 'status', status: 'running', detail: '正在启动 Agent' })
    let wake: (() => void) | null = null
    let dirty = false
    const notify = (): void => {
      dirty = true
      wake?.()
    }
    const unwatch = this.process.watch(threadId, notify)
    signal.addEventListener('abort', notify)
    const seen = new Map<string, string>()
    let lastSequence = -1
    let stopAt: number | null = null
    let nativeId = input.sessionId
    let runId: string | null = null
    let inputRequestId: string | null = null
    let steerAvailable = false
    const attachments = input.attachments ?? []
    try {
      if (!recover) {
        const accepted = await this.process.request({
          type: 'send', threadId, requestId, provider: this.provider,
          title: input.title?.trim() || '新对话',
          cwd: input.workingDirectory,
          nativeId: input.sessionId,
          model: input.model ?? null,
          effort: input.reasoningEffort ?? null,
          prompt: attachmentPrompt(input.prompt, attachments),
          images: attachments.filter(file => isNativeImage(file.mimeType)),
          context: {
            instructions: buildAgentInstructions(input),
            workspaceRoots: [...new Set([input.workingDirectory, ...input.workspaceRoots, input.filesDirectory])],
            mcpServers: servers,
            nativeImages: nativeImages(attachments)
          }
        }, acceptedSchema).catch(async (error: unknown) => {
          const snapshot = await this.process.request({ type: 'snapshot', threadId, requestId }, snapshotSchema)
            .catch(() => null)
          if (!snapshot?.run) throw error
          return { runId: snapshot.run.id }
        })
        runId = accepted.runId
      }

      while (true) {
        dirty = false
        const snapshot = await this.process.request({ type: 'snapshot', threadId, requestId }, snapshotSchema)
        if (!snapshot.run || (runId !== null && snapshot.run.id !== runId)) {
          throw new Error('T3 运行时未返回对应的执行记录。')
        }
        runId = snapshot.run.id
        const { status } = snapshot.run
        const finished = terminal.has(status)
        const canSteer = snapshot.canSteer === true && !signal.aborted && !recover
        if (canSteer !== steerAvailable) {
          steerAvailable = canSteer
          input.onSteerReady?.(canSteer ? (prompt, files, request, startedAt) =>
            this.steer(threadId, requestId, nativeRequestId(request, startedAt), prompt, files) : null)
        }
        if (snapshot.sequence > lastSequence) {
          lastSequence = snapshot.sequence
          input.onActivity?.()
          const publish = (): void => {
            if (snapshot.nativeId && snapshot.nativeId !== nativeId) {
              nativeId = snapshot.nativeId
              if (this.provider === 'codex' && input.onCodexSessionReady) {
                input.onCodexSessionReady({ sessionId: nativeId, sourceSessionId: null, messages: [] })
              } else input.onSessionId(nativeId)
            }
            const lastResponseActivity = snapshot.items.findLast(item =>
              item.parentItemId === null && responseActivity.has(item.type))
            for (const item of snapshot.items) {
              this.publishItem(input, item, seen, item.id === lastResponseActivity?.id)
            }
            const inputRequest = finished ? undefined : snapshot.items.find(item =>
              item.type === 'user_input_request' && item.status === 'waiting' && item.questions?.length)
            const nextId = inputRequest?.requestId ?? null
            if (nextId !== inputRequestId) {
              inputRequestId = nextId
              const questions = inputRequest?.questions
              input.onInputRequest?.(nextId && questions ? { id: nextId, questions } : null,
                async (answers) => {
                  if (!nextId || inputRequestId !== nextId || signal.aborted) throw new Error('这条输入请求已结束。')
                  await this.process.request({ type: 'answer', threadId, requestId: nextId, answers }, z.null())
                  notify()
                })
            }
          }
          if (input.onCommittedProjection) input.onCommittedProjection(snapshot.sequence, finished, publish)
          else publish()
        }
        if (finished) {
          throwIfCancelled(signal)
          if (status !== 'completed') {
            const failure = snapshot.items.findLast(item => item.type === 'error')?.failure?.message
            throw new Error(failure || `Agent 未完成本轮执行（${status}）。`)
          }
          const replies = snapshot.items.filter(item => item.type === 'assistant_message' && item.parentItemId === null)
          const final = replies.filter(item => item.phase === 'final_answer')
          const text = (final.length ? final : replies.slice(-1)).map(item => item.text ?? '').join('\n\n').trim()
          if (!text) throw new Error('Agent 没有返回回复。')
          return { text, sessionId: snapshot.nativeId ?? nativeId }
        }
        if (signal.aborted && stopAt === null) {
          stopAt = Date.now()
          await this.process.request({ type: 'stop', threadId, requestId }, z.null())
        }
        if (stopAt !== null && Date.now() - stopAt > 30_000) {
          throw new Error('T3 运行时尚未确认 Agent 停止。')
        }
        if (dirty) continue
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 500)
          wake = () => { clearTimeout(timer); resolve() }
        })
        wake = null
      }
    } catch (error) {
      if (!runId && signal.aborted) {
        await this.process.request({ type: 'stop', threadId, requestId }, z.null()).catch(() => undefined)
      }
      throw error
    } finally {
      if (steerAvailable) input.onSteerReady?.(null)
      signal.removeEventListener('abort', notify)
      unwatch()
    }
  }

  private publishItem(
    input: T3AgentTurnInput, item: TurnItem, seen: Map<string, string>, lastResponseActivity: boolean
  ): void {
    if (item.parentItemId !== null) return
    const phase = item.type !== 'assistant_message' ? undefined
      : item.phase === 'final_answer' || (!item.phase && lastResponseActivity) ? 'final_answer' : 'commentary'
    const key = phase ? `${item.id}:${phase}` : item.id
    const previous = seen.get(key) ?? ''
    const position = item.ordinal === undefined ? {} : { timelineOrdinal: item.ordinal }
    if (item.type === 'user_input_request' && item.questions?.length) {
      if (item.status !== 'completed' && item.status !== 'cancelled') return
      if (previous === item.status) return
      seen.set(key, item.status)
      const choices = selectedQuestionOptions(item)
      input.onUpdate({ type: 'question_record', itemId: item.id, status: item.status,
        questions: item.questions.map(question => question.question), ...(choices.length && { choices }), ...position })
      return
    }
    if (item.type === 'reasoning' || item.type === 'assistant_message') {
      const text = item.text ?? ''
      if (!text.startsWith(previous) || text === previous) return
      seen.set(key, text)
      const delta = text.slice(previous.length)
      if (item.type === 'reasoning') input.onUpdate({ type: 'reasoning_delta', segmentId: `t3:${item.id}`, delta, ...position })
      else if (phase === 'commentary') input.onUpdate({ type: 'commentary_delta', messageId: item.id, delta, ...position })
      else input.onUpdate({ type: 'message_delta', messageId: item.id, phase: 'final_answer', delta, ...position })
      return
    }
    const tool = asTool(item)
    if (!tool) return
    const status = item.status === 'completed' ? 'completed'
      : ['failed', 'cancelled', 'interrupted'].includes(item.status) ? 'failed' : 'running'
    const counts = item.type === 'file_change' && item.diffStr &&
      (item.additions === undefined || item.deletions === undefined) ? diffLineCounts(item.diffStr) : undefined
    const paths = item.changes?.map(change => change.path)
    const fileChange = item.type === 'file_change' && item.fileName ? {
      path: item.fileName, diff: item.diffStr?.slice(0, 32_000),
      additions: item.additions ?? counts?.additions, deletions: item.deletions ?? counts?.deletions,
      ...(paths?.length && { paths })
    } : undefined
    const update = JSON.stringify([status, tool.detail, fileChange])
    if (previous === update) return
    seen.set(key, update)
    input.onUpdate({ type: 'tool', toolCallId: item.id, toolName: tool.name, status, detail: tool.detail,
      ...position, ...(fileChange && { fileChange }) })
    if (status !== 'running') input.onTool(tool.name, tool.detail, {
      status, engine: 't3', itemId: item.id, path: item.fileName, ...position, ...(fileChange && { fileChange })
    })
  }
}
