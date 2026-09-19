import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CliAgentRuntime, type CliAgentTurnInput } from './cli-agent-runtime'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), terminate: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('./process-tree', () => ({ terminateProcessTree: mocks.terminate }))
vi.mock('./cli-executables', () => ({ resolveCliBinary: () => '/fake/codex' }))

type Rpc = { id: number; method: string; params: Record<string, unknown> }
function server(respond: (rpc: Rpc) => Record<string, unknown> | undefined) {
  const requests: Rpc[] = []
  const stdout = new PassThrough()
  const notify = (method: string, params: Record<string, unknown>) => stdout.write(`${JSON.stringify({ method, params })}\n`)
  const child = Object.assign(new EventEmitter(), {
    pid: 12345, stdout, stderr: new PassThrough(),
    stdin: new Writable({ write(chunk, _encoding, done) {
      const rpc = JSON.parse(chunk.toString()) as Rpc
      if (typeof rpc.id === 'number') {
        requests.push(rpc)
        queueMicrotask(() => {
          const response = respond(rpc)
          if (response) stdout.write(`${JSON.stringify({ id: rpc.id, ...response })}\n`)
        })
      }
      done()
    } })
  })
  mocks.spawn.mockReturnValue(child)
  return { requests, notify, child }
}

const input = (): CliAgentTurnInput => ({
  runId: 'run', projectId: null, provider: 'codex', prompt: '新任务', sessionId: 'legacy', workingDirectory: '/project',
  workspaceRoots: ['/project'], filesDirectory: '/files', abortController: new AbortController(),
  onUpdate: vi.fn(), onSessionId: vi.fn(), onCodexSessionReady: vi.fn(), onTool: vi.fn(), onApproval: async () => 'approve'
})
const runtime = () => new CliAgentRuntime({ getLaunchConfigs: async () => [] })
const oldThread = { id: 'legacy', status: { type: 'notLoaded' }, turns: [{ id: 'old-turn', status: 'completed',
  startedAt: 1000, completedAt: 1010, items: [{ type: 'userMessage', id: 'old-user', content: [{ type: 'text', text: '旧任务' }] }] }] }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.terminate.mockResolvedValue(undefined)
})

describe('Codex app-server lifecycle', () => {
  it.each([null, 'owned'])('injects current instructions separately when starting/resuming %s', async sessionId => {
    const turnInput = { ...input(), sessionId, codexSessionOwned: true, projectContext: '最新事实：交易暂停' }
    const { requests, notify } = server(rpc => ({ result: rpc.method.startsWith('thread/') ? { thread: { id: sessionId ?? 'new' } } : {} }))
    const running = runtime().runTurn(turnInput)
    await vi.waitFor(() => expect(requests.some(rpc => rpc.method === 'turn/start')).toBe(true))
    const thread = requests.find(rpc => rpc.method === (sessionId ? 'thread/resume' : 'thread/start'))!
    expect(thread.params.developerInstructions).toContain('最新事实：交易暂停')
    expect(thread.params.developerInstructions).toContain('/files')
    expect(thread.params.developerInstructions).not.toContain('/project')
    expect(thread.params.runtimeWorkspaceRoots).toEqual(['/project', '/files'])
    expect(requests.find(rpc => rpc.method === 'turn/start')!.params.input).toEqual([{ type: 'text', text: '新任务' }])
    notify('item/completed', { item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: '完成' } })
    notify('turn/completed', { turn: { status: 'completed' } })
    await running
  })

  it('persists the independent ID before sending exactly one turn, and waits for process exit before resolving', async () => {
    const turnInput = input()
    let release!: () => void
    mocks.terminate.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    const { requests, notify } = server(rpc => {
      if (rpc.method === 'thread/read') return { result: { thread: oldThread } }
      if (rpc.method === 'thread/fork') return { result: { thread: { id: 'independent' } } }
      if (rpc.method === 'turn/start') {
        expect(turnInput.onCodexSessionReady).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'independent' }))
        expect(rpc.params.threadId).toBe('independent')
      }
      return { result: {} }
    })
    let done = false
    const running = runtime().runTurn(turnInput).then(value => { done = true; return value })
    await vi.waitFor(() => expect(requests.filter(rpc => rpc.method === 'turn/start')).toHaveLength(1))
    notify('item/completed', { item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: '完成' } })
    notify('turn/completed', { turn: { status: 'completed' } })
    expect(done).toBe(false)
    release()
    await expect(running).resolves.toMatchObject({ text: '完成', sessionId: 'independent' })
    expect(requests.some(rpc => rpc.method === 'thread/resume')).toBe(false)
  })

  it('never sends a turn if persisting the fork fails', async () => {
    const turnInput = input()
    turnInput.onCodexSessionReady = () => { throw new Error('database full') }
    const { requests } = server(rpc => ({ result: { thread: rpc.method === 'thread/read' ? oldThread : { id: 'new' } } }))
    await expect(runtime().runTurn(turnInput)).rejects.toThrow('database full')
    expect(requests.some(rpc => rpc.method === 'turn/start')).toBe(false)
    expect(mocks.terminate).toHaveBeenCalledTimes(1)
  })

  it('returns a readable busy error without forking or starting a turn for an owned ID', async () => {
    const turnInput = { ...input(), codexSessionOwned: true }
    const { requests } = server(rpc => rpc.method === 'thread/resume'
      ? { error: { code: -32603, message: 'thread legacy already has an active writer' } } : { result: {} })
    await expect(runtime().runTurn(turnInput)).rejects.toThrow('消息尚未执行')
    expect(requests.some(rpc => ['thread/fork', 'turn/start'].includes(rpc.method))).toBe(false)
  })

  it('waits for cleanup on abort and never continues a pending startup request', async () => {
    const turnInput = input()
    let release!: () => void
    mocks.terminate.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    const { requests } = server(() => undefined)
    const running = runtime().runTurn(turnInput)
    let settled = false
    const result = running.catch(error => { settled = true; return error })
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    turnInput.abortController.abort(new Error('停止'))
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    expect((await result).message).toBe('停止')
    expect(requests).toHaveLength(1)
  })
})
