import { createHash } from 'node:crypto'
import type { AgentRunMessage } from '../../shared/contracts'

type RecordValue = Record<string, unknown>
export type CodexRequest = (method: string, params: RecordValue) => Promise<RecordValue>
export interface CodexSessionBinding {
  version: 1
  sessionId: string
  sourceSessionId: string | null
}
export interface CodexSessionReady {
  sessionId: string
  sourceSessionId: string | null
  messages: AgentRunMessage[]
}

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' ? value as RecordValue : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function userText(item: RecordValue): string {
  if (!Array.isArray(item.content)) return ''
  const content = item.content.map(part => record(part).type === 'text' ? text(record(part).text) : '').filter(Boolean).join('\n')
  // Earlier Fuddy turns included project context before the actual user input.
  const marker = '用户任务：\n'
  const index = content.lastIndexOf(marker)
  return (index < 0 || !content.startsWith('项目：') ? content : content.slice(index + marker.length)).trim()
}

/** Import visible conversation only; never import reasoning or tool payloads. */
export function missingCodexMessages(
  runId: string, sourceSessionId: string, turns: RecordValue[], existing: AgentRunMessage[]
): AgentRunMessage[] {
  const messages: AgentRunMessage[] = []
  const used = new Set<string>()
  for (const turn of turns) {
    if (!Array.isArray(turn.items)) throw new Error('旧 Codex 会话的历史不完整，暂未迁移，请稍后重试。')
    const items = turn.items.map(record)
    const users = items.filter(item => item.type === 'userMessage')
    const prompt = users.map(userText).filter(Boolean).join('\n')
    const started = typeof turn.startedAt === 'number' ? turn.startedAt * 1_000 : NaN
    const completed = typeof turn.completedAt === 'number' ? turn.completedAt * 1_000 : started
    if (!prompt) continue
    if (!Number.isFinite(started) || !text(turn.id)) throw new Error('旧 Codex 会话缺少历史时间或标识，暂未迁移。')
    const match = existing.find(message => message.role === 'user' && !used.has(message.id)
      && message.content.trim() === prompt
      && Math.abs(Date.parse(message.createdAt) - started) < 120_000)
    if (match) {
      used.add(match.id)
      continue
    }
    const visible = [
      { id: `user-${text(turn.id)}`, role: 'user' as const, content: prompt, phase: '', time: started },
      ...items.filter(item => item.type === 'agentMessage' && text(item.text).trim()
        && (item.phase == null || item.phase === 'commentary' || item.phase === 'final_answer'))
        .map(item => ({ id: text(item.id), role: 'assistant' as const, content: text(item.text),
          phase: text(item.phase), time: item.phase === 'commentary' ? started : completed }))
    ]
    for (const item of visible) {
      const id = `codex-import-${createHash('sha256').update(`${runId}:${sourceSessionId}:${turn.id}:${item.id}`).digest('hex')}`
      if (existing.some(message => message.id === id)) continue
      messages.push({ id, runId, role: item.role, content: item.content,
        eventType: item.phase === 'commentary' ? 'reasoning' : null, toolName: null,
        metadata: { source: 'codex-session-migration', sourceSessionId, sourceTurnId: turn.id },
        createdAt: new Date(item.time).toISOString() })
    }
  }
  return messages
}

export function codexSessionError(error: Error): Error {
  if (/already has an active writer/i.test(error.message)) {
    return new Error('这个 Codex 会话正被其他进程占用。消息尚未执行，请等待占用释放后重新发送；Fuddy 不会强制停止其他应用。')
  }
  return error
}

/** Old IDs are forked once, never resumed. Owned IDs always resume, never auto-fork on failure. */
export async function prepareCodexSession(input: {
  request: CodexRequest
  runId: string
  sessionId: string | null
  owned: boolean
  history: AgentRunMessage[]
  params: RecordValue
  checkCancelled: () => void
}): Promise<{ result: RecordValue; ready: CodexSessionReady | null }> {
  const { request, sessionId, params, checkCancelled } = input
  checkCancelled()
  if (sessionId && input.owned) {
    return { result: await request('thread/resume', { ...params, threadId: sessionId }), ready: null }
  }
  let messages: AgentRunMessage[] = []
  let result: RecordValue
  if (sessionId) {
    const read = await request('thread/read', { threadId: sessionId, includeTurns: true })
    checkCancelled()
    const thread = record(read.thread)
    if (!Array.isArray(thread.turns) || thread.id !== sessionId) throw new Error('无法完整读取旧 Codex 会话，暂未迁移，请重试。')
    const turns = thread.turns.map(record)
    if (record(thread.status).type === 'active' || turns.some(turn => turn.status === 'inProgress')) {
      throw new Error('旧 Codex 会话仍有任务在运行。请等待任务结束后重新发送，Fuddy 再迁移历史并独立继续。')
    }
    const lastTurnId = text(turns.at(-1)?.id)
    if (!lastTurnId) throw new Error('旧 Codex 会话没有可确认的历史轮次，暂未迁移。')
    messages = missingCodexMessages(input.runId, sessionId, turns, input.history)
    result = await request('thread/fork', {
      ...params, threadId: sessionId, lastTurnId, threadSource: 'fuddy', deferGoalContinuation: true
    })
  } else {
    result = await request('thread/start', { ...params, serviceName: 'fuddy' })
  }
  const found = text(record(result.thread).id)
  if (!found || found === sessionId) throw new Error('Codex 没有创建独立会话，消息尚未执行。')
  // Persistence is deliberately before turn/start. A cancelled first turn can resume this ID.
  return { result, ready: { sessionId: found, sourceSessionId: sessionId, messages } }
}
