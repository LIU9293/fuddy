import { describe, expect, it, vi } from 'vitest'
import { createAgentRunUpdateStore } from './agent-run-update-store'

describe('Agent Run update store', () => {
  it('replays the active background turn to a view that subscribes late', () => {
    const store = createAgentRunUpdateStore()
    store.publish({ requestId: '', runId: 'run-1', update: { type: 'status', status: 'running' } })
    store.publish({
      requestId: '',
      runId: 'run-1',
      update: { type: 'message_delta', messageId: 'commentary-1', phase: 'commentary', delta: '正在' }
    })
    store.publish({
      requestId: '',
      runId: 'run-1',
      update: { type: 'message_delta', messageId: 'commentary-1', phase: 'commentary', delta: '检查。' }
    })
    const listener = vi.fn()

    store.subscribe(listener)

    expect(listener.mock.calls.map(([envelope]) => envelope.update)).toEqual([
      { type: 'status', status: 'running' },
      { type: 'message_delta', messageId: 'commentary-1', phase: 'commentary', delta: '正在检查。' }
    ])
  })

  it('does not replay a completed turn', () => {
    const store = createAgentRunUpdateStore()
    store.publish({ requestId: '', runId: 'run-1', update: { type: 'status', status: 'running' } })
    store.publish({ requestId: '', runId: 'run-1', update: { type: 'status', status: 'idle' } })
    const listener = vi.fn()

    store.subscribe(listener)

    expect(listener).not.toHaveBeenCalled()
  })

  it('replays only the unpersisted tail after a tool boundary', () => {
    const store = createAgentRunUpdateStore()
    store.publish({ requestId: '', runId: 'run-1', update: { type: 'status', status: 'running' } })
    store.publish({
      requestId: '',
      runId: 'run-1',
      update: { type: 'message_delta', messageId: 'commentary-1', phase: 'commentary', delta: '先读取文件。' }
    })
    store.publish({
      requestId: '',
      runId: 'run-1',
      update: { type: 'tool', toolCallId: 'tool-1', toolName: 'Read', status: 'running', detail: 'README.md' }
    })
    store.publish({
      requestId: '',
      runId: 'run-1',
      update: { type: 'tool', toolCallId: 'tool-1', toolName: 'Read', status: 'completed', detail: 'README.md' }
    })
    store.publish({
      requestId: '',
      runId: 'run-1',
      update: { type: 'reasoning_delta', segmentId: 'thinking-2', delta: '继续检查配置。' }
    })
    const listener = vi.fn()

    store.subscribe(listener)

    expect(listener.mock.calls.map(([envelope]) => envelope.update)).toEqual([
      { type: 'status', status: 'running' },
      { type: 'reasoning_delta', segmentId: 'thinking-2', delta: '继续检查配置。' }
    ])
  })

  it('keeps an active tool but drops commentary persisted at its boundary', () => {
    const store = createAgentRunUpdateStore()
    store.publish({ requestId: '', runId: 'run-1', update: { type: 'status', status: 'running' } })
    store.publish({
      requestId: '',
      runId: 'run-1',
      update: { type: 'message_delta', messageId: 'commentary-1', phase: 'commentary', delta: '准备读取。' }
    })
    store.publish({
      requestId: '',
      runId: 'run-1',
      update: { type: 'tool', toolCallId: 'tool-1', toolName: 'Read', status: 'running', detail: 'README.md' }
    })
    const listener = vi.fn()

    store.subscribe(listener)

    expect(listener.mock.calls.map(([envelope]) => envelope.update)).toEqual([
      { type: 'status', status: 'running' },
      { type: 'tool', toolCallId: 'tool-1', toolName: 'Read', status: 'running', detail: 'README.md' }
    ])
  })
})
