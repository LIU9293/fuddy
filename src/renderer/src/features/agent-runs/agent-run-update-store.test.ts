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
})
