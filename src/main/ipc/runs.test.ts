import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcContext } from './context'
import type { AgentRunStreamUpdate } from '../../shared/contracts'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  BrowserWindow: {}, dialog: {}, shell: {}, systemPreferences: {},
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) }
}))
import { registerRunIpc } from './runs'

describe('Agent Run retry IPC', () => {
  beforeEach(() => handlers.clear())

  it('accepts draft creation without a title and still validates any supplied title', () => {
    const createDraft = vi.fn(() => ({ run: { id: 'draft', title: '新建 Chat', status: 'draft' } }))
    registerRunIpc({ dispatcher: { createDraft }, accountService: { getState: () => ({ user: null }) } } as unknown as IpcContext)
    const handler = handlers.get('agent-run:create-draft')!
    expect(handler({}, { projectId: null, provider: 'codex' })).toMatchObject({ run: { title: '新建 Chat', status: 'draft' } })
    expect(createDraft).toHaveBeenCalledWith({ projectId: null, provider: 'codex' }, null)
    expect(() => handler({}, { projectId: null, title: ' ' })).toThrow()
    expect(() => handler({}, { projectId: null, title: 'a'.repeat(201) })).toThrow()
  })

  it('validates identifiers and uses the signed-in actor and correlated stream', async () => {
    const retryMessage = vi.fn(async (_run: string, _error: string, onUpdate: (update: AgentRunStreamUpdate) => void) => {
      onUpdate({ type: 'status', status: 'running' })
      return { run: { id: 'run' } }
    })
    registerRunIpc({ dispatcher: { retryMessage }, accountService: { getState: () => ({ user: { id: 'self', displayName: 'Kai' } }) } } as unknown as IpcContext)
    const handler = handlers.get('agent-run:retry')!
    const send = vi.fn()
    const event = { sender: { isDestroyed: () => false, send } }
    expect(() => handler(event, { runId: 'run', requestId: 'request', errorMessageId: '' })).toThrow()
    expect(retryMessage).not.toHaveBeenCalled()
    await handler(event, { runId: 'run', requestId: 'request', errorMessageId: 'error', authorUserId: 'forged' })
    expect(retryMessage).toHaveBeenCalledWith('run', 'error', expect.any(Function), undefined,
      { userId: 'self', snapshot: { displayName: 'Kai', avatarRef: null } })
    expect(send).toHaveBeenCalledWith('agent-run:update', { runId: 'run', requestId: 'request', update: { type: 'status', status: 'running' } })
  })

  it('routes remote retries back to the execution Mac', async () => {
    const retry = vi.fn(async () => ({ run: { id: 'remote:host:run' } }))
    const retryMessage = vi.fn()
    registerRunIpc({ dispatcher: { retryMessage }, macPeers: { retry } } as unknown as IpcContext)
    await handlers.get('agent-run:retry')!({}, { runId: 'remote:host:run', requestId: 'request', errorMessageId: 'error' })
    expect(retry).toHaveBeenCalledWith('remote:host:run', 'error', 'request')
    expect(retryMessage).not.toHaveBeenCalled()
  })
})
