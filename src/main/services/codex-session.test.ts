import { describe, expect, it, vi } from 'vitest'
import type { AgentRunMessage } from '../../shared/contracts'
import { codexSessionError, missingCodexMessages, prepareCodexSession, type CodexRequest } from './codex-session'

const time = 1_789_517_880
const turn = (id: string, prompt: string, startedAt = time) => ({
  id, status: 'completed', startedAt, completedAt: startedAt + 60,
  items: [
    { id: `${id}-user`, type: 'userMessage', content: [{ type: 'text', text: prompt }] },
    { id: `${id}-reasoning`, type: 'reasoning', text: 'private reasoning' },
    { id: `${id}-tool`, type: 'commandExecution', aggregatedOutput: 'private output' },
    { id: `${id}-commentary`, type: 'agentMessage', phase: 'commentary', text: '我会核对记录。' },
    { id: `${id}-answer`, type: 'agentMessage', phase: 'final_answer', text: '已完成核对。' }
  ]
})
const params = { cwd: '/project', sandbox: 'danger-full-access', approvalPolicy: 'never', runtimeWorkspaceRoots: ['/project', '/files'] }
function prepare(request: CodexRequest, overrides: Partial<Parameters<typeof prepareCodexSession>[0]> = {}) {
  return prepareCodexSession({ request, runId: 'run', sessionId: 'legacy', owned: false, history: [], params,
    checkCancelled: () => undefined, ...overrides })
}

describe('Fuddy Codex session ownership', () => {
  it('forks a stable completed snapshot, preserves history and never resumes the legacy ID', async () => {
    const request = vi.fn<CodexRequest>(async method => method === 'thread/read'
      ? { thread: { id: 'legacy', status: { type: 'idle' }, turns: [turn('old', '最近的交易被卡住')] } }
      : { thread: { id: 'fuddy-new', sessionId: 'legacy' } })
    const result = await prepare(request)
    expect(request.mock.calls.map(call => call[0])).toEqual(['thread/read', 'thread/fork'])
    expect(request).toHaveBeenLastCalledWith('thread/fork', {
      ...params, threadId: 'legacy', lastTurnId: 'old', threadSource: 'fuddy', deferGoalContinuation: true
    })
    // A fork's native sessionId can still refer to the original root; resume uses thread.id.
    expect(result.ready).toMatchObject({ sessionId: 'fuddy-new', sourceSessionId: 'legacy' })
    expect(result.ready?.messages.map(message => message.content)).toEqual(['最近的交易被卡住', '我会核对记录。', '已完成核对。'])
  })

  it('resumes owned IDs without rereading or forking, including after app restart', async () => {
    const request = vi.fn<CodexRequest>().mockResolvedValue({ thread: { id: 'owned' } })
    expect((await prepare(request, { sessionId: 'owned', owned: true })).ready).toBeNull()
    expect(request).toHaveBeenCalledExactlyOnceWith('thread/resume', { ...params, threadId: 'owned' })
  })

  it('creates new chats directly without forking', async () => {
    const request = vi.fn<CodexRequest>().mockResolvedValue({ thread: { id: 'new' } })
    expect((await prepare(request, { sessionId: null })).ready).toMatchObject({ sessionId: 'new', sourceSessionId: null })
    expect(request).toHaveBeenCalledExactlyOnceWith('thread/start', { ...params, serviceName: 'fuddy' })
  })

  it.each(['active', 'inProgress'])('refuses migration when the source has work in progress (%s)', async status => {
    const request = vi.fn<CodexRequest>().mockResolvedValue({ thread: { id: 'legacy', status: { type: status },
      turns: [{ ...turn('old', 'work'), status: status === 'inProgress' ? status : 'completed' }] } })
    await expect(prepare(request)).rejects.toThrow('仍有任务在运行')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('does not replace the original ID or send a turn on read/fork failure or missing history', async () => {
    const request = vi.fn<CodexRequest>().mockResolvedValue({ thread: { id: 'legacy' } })
    await expect(prepare(request)).rejects.toThrow('无法完整读取')
    request.mockReset().mockRejectedValue(new Error('read failed'))
    await expect(prepare(request)).rejects.toThrow('read failed')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('does not fork an owned session when another process takes it', async () => {
    const request = vi.fn<CodexRequest>().mockRejectedValue(new Error('thread owned already has an active writer'))
    await expect(prepare(request, { owned: true })).rejects.toThrow('active writer')
    expect(request).toHaveBeenCalledTimes(1)
    expect(codexSessionError(new Error('thread owned already has an active writer')).message).toContain('消息尚未执行')
  })

  it('stops before forking if cancelled during history reading', async () => {
    let cancelled = false
    const request = vi.fn<CodexRequest>(async () => {
      cancelled = true
      return { thread: { id: 'legacy', turns: [turn('old', 'work')] } }
    })
    await expect(prepare(request, { checkCancelled: () => { if (cancelled) throw new Error('cancelled') } })).rejects.toThrow('cancelled')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('imports only missing turns once and preserves repeated messages at different times', () => {
    const existing: AgentRunMessage[] = [{ id: 'existing', runId: 'run', role: 'user', content: '检查',
      eventType: null, toolName: null, metadata: null, createdAt: new Date(time * 1_000).toISOString() }]
    const turns = [turn('fuddy', '项目：测试\n\n用户任务：\n检查'), turn('desktop', '检查', time + 600)]
    const imported = missingCodexMessages('run', 'legacy', turns, existing)
    expect(imported).toHaveLength(3)
    expect(imported[0].createdAt).toBe(new Date((time + 600) * 1_000).toISOString())
    expect(missingCodexMessages('run', 'legacy', turns, [...existing, ...imported])).toEqual([])
    expect(imported.some(message => message.content.includes('private'))).toBe(false)
  })
})
