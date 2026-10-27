import { describe, expect, it, vi } from 'vitest'
import { CliAgentRuntime, type CliAgentTurnInput } from './cli-agent-runtime'

const mocks = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocks.query }))
vi.mock('./cli-executables', () => ({ resolveCliBinary: () => '/fake/claude' }))

describe('Claude live Steer input', () => {
  it('passes a new user message to the active streaming query', async () => {
    let steer: ((prompt: string, attachments: [], requestId: string) => Promise<void>) | null = null
    let received: unknown[] = []
    const close = vi.fn()
    mocks.query.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => ({
      close,
      async *[Symbol.asyncIterator]() {
        const iterator = prompt[Symbol.asyncIterator]()
        received = [(await iterator.next()).value]
        yield { type: 'system', subtype: 'init', session_id: 'claude-session' }
        received.push((await iterator.next()).value)
        yield { type: 'result', result: '已按新方向完成', session_id: 'claude-session' }
      }
    }))
    const input: CliAgentTurnInput = {
      provider: 'claude', projectId: null, prompt: '原任务', sessionId: null,
      workingDirectory: '/project', workspaceRoots: ['/project'], filesDirectory: '/files',
      abortController: new AbortController(), onUpdate: vi.fn(), onSessionId: vi.fn(),
      onTool: vi.fn(), onApproval: async () => 'approve',
      onSteerReady: (value) => { steer = value as typeof steer }
    }
    const running = new CliAgentRuntime({ getLaunchConfigs: async () => [] }).runTurn(input)
    await vi.waitFor(() => expect(steer).not.toBeNull())
    await steer!('新方向', [], 'message-2')
    expect(await running).toMatchObject({ text: '已按新方向完成', sessionId: 'claude-session' })
    expect(received).toMatchObject([
      { type: 'user', message: { content: [{ type: 'text', text: '原任务' }] } },
      { type: 'user', priority: 'now', message: { content: [{ type: 'text', text: '新方向' }] } }
    ])
    expect(steer).toBeNull()
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects Steer when the active query finishes before consuming it', async () => {
    let steer: ((prompt: string, attachments: [], requestId: string) => Promise<void>) | null = null
    let finish = (): void => undefined
    const finishGate = new Promise<void>((resolve) => { finish = resolve })
    mocks.query.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => ({
      close: vi.fn(),
      async *[Symbol.asyncIterator]() {
        await prompt[Symbol.asyncIterator]().next()
        yield { type: 'system', subtype: 'init' }
        await finishGate
        yield { type: 'result', result: '原任务完成' }
      }
    }))
    const input: CliAgentTurnInput = {
      provider: 'claude', projectId: null, prompt: '原任务', sessionId: null,
      workingDirectory: '/project', workspaceRoots: ['/project'], filesDirectory: '/files',
      abortController: new AbortController(), onUpdate: vi.fn(), onSessionId: vi.fn(),
      onTool: vi.fn(), onApproval: async () => 'approve',
      onSteerReady: (value) => { steer = value as typeof steer }
    }
    const running = new CliAgentRuntime({ getLaunchConfigs: async () => [] }).runTurn(input)
    await vi.waitFor(() => expect(steer).not.toBeNull())
    const steering = steer!('新方向', [], 'message-2')
    finish()
    await expect(steering).rejects.toThrow('已结束')
    await expect(running).resolves.toMatchObject({ text: '原任务完成' })
  })

  it('keeps the Claude query open for background subagent follow-up turns until idle', async () => {
    const close = vi.fn()
    let options: Record<string, unknown> = {}
    mocks.query.mockImplementation(({ prompt, options: queryOptions }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
      options = queryOptions
      return {
        close,
        async *[Symbol.asyncIterator]() {
          await prompt[Symbol.asyncIterator]().next()
          yield { type: 'system', subtype: 'session_state_changed', state: 'running' }
          yield { type: 'system', subtype: 'init', session_id: 'claude-session' }
          yield { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'task-1', task_type: 'local_agent', description: '调研' }] }
          yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '已启动' } } }
          yield { type: 'result', result: '已启动', session_id: 'claude-session' }
          yield { type: 'stream_event', parent_tool_use_id: 'agent-tool', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '子代理内部输出' } } }
          yield { type: 'system', subtype: 'background_tasks_changed', tasks: [] }
          yield { type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed' }
          yield { type: 'system', subtype: 'init', session_id: 'claude-session' }
          yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '调研结果' } } }
          yield { type: 'result', result: '调研结果', session_id: 'claude-session' }
          yield { type: 'system', subtype: 'session_state_changed', state: 'idle' }
          yield { type: 'result', result: '不应读取', session_id: 'claude-session' }
        }
      }
    })
    const onUpdate = vi.fn()
    const input: CliAgentTurnInput = {
      provider: 'claude', projectId: null, prompt: '后台调研', sessionId: null,
      workingDirectory: '/project', workspaceRoots: ['/project'], filesDirectory: '/files',
      abortController: new AbortController(), onUpdate, onSessionId: vi.fn(),
      onTool: vi.fn(), onApproval: async () => 'approve'
    }
    await expect(new CliAgentRuntime({ getLaunchConfigs: async () => [] }).runTurn(input))
      .resolves.toMatchObject({ text: '调研结果', sessionId: 'claude-session' })
    expect((options.env as Record<string, string>).CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe('1')
    const deltas = onUpdate.mock.calls.map(([update]) => update).filter(update => update.type === 'message_delta')
    expect(deltas).toEqual([
      { type: 'message_delta', messageId: 'stream-claude-session', delta: '已启动' },
      { type: 'message_delta', messageId: 'stream-claude-session-1', delta: '调研结果' }
    ])
    expect(close).toHaveBeenCalledOnce()
  })

  it('shows a running background wait while a subagent is silent', async () => {
    vi.useFakeTimers()
    try {
      let release = (): void => undefined
      const gate = new Promise<void>((resolve) => { release = resolve })
      mocks.query.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => ({
        close: vi.fn(),
        async *[Symbol.asyncIterator]() {
          await prompt[Symbol.asyncIterator]().next()
          yield { type: 'system', subtype: 'session_state_changed', state: 'running' }
          yield { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'task-1', description: '调研' }] }
          yield { type: 'result', result: '已启动', session_id: 'claude-session' }
          await gate
          yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '完成' } } }
          yield { type: 'result', result: '完成', session_id: 'claude-session' }
          yield { type: 'system', subtype: 'session_state_changed', state: 'idle' }
        }
      }))
      const onUpdate = vi.fn()
      const input: CliAgentTurnInput = {
        provider: 'claude', projectId: null, prompt: '后台调研', sessionId: null,
        workingDirectory: '/project', workspaceRoots: ['/project'], filesDirectory: '/files',
        abortController: new AbortController(), onUpdate, onSessionId: vi.fn(),
        onTool: vi.fn(), onApproval: async () => 'approve'
      }
      const running = new CliAgentRuntime({ getLaunchConfigs: async () => [] }).runTurn(input)
      await vi.advanceTimersByTimeAsync(2_000)
      const waits = (): unknown[] => onUpdate.mock.calls.map(([update]) => update).filter(update => update.toolName === '后台任务')
      expect(waits()).toMatchObject([{ type: 'tool', status: 'running', detail: '等待完成：调研' }])
      release()
      await expect(running).resolves.toMatchObject({ text: '完成' })
      expect(waits()).toMatchObject([{ status: 'running' }, { status: 'completed' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends at the first result when the Claude CLI does not report session state', async () => {
    mocks.query.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => ({
      close: vi.fn(),
      async *[Symbol.asyncIterator]() {
        await prompt[Symbol.asyncIterator]().next()
        yield { type: 'result', result: '旧版完成', session_id: 'claude-session' }
        throw new Error('stream should be closed after the first result')
      }
    }))
    const input: CliAgentTurnInput = {
      provider: 'claude', projectId: null, prompt: '任务', sessionId: null,
      workingDirectory: '/project', workspaceRoots: ['/project'], filesDirectory: '/files',
      abortController: new AbortController(), onUpdate: vi.fn(), onSessionId: vi.fn(),
      onTool: vi.fn(), onApproval: async () => 'approve'
    }
    await expect(new CliAgentRuntime({ getLaunchConfigs: async () => [] }).runTurn(input))
      .resolves.toMatchObject({ text: '旧版完成' })
  })
})
