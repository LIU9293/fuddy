import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CliAgentRuntime, type CliAgentTurnInput } from './cli-agent-runtime'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), query: vi.fn(), terminate: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocks.query }))
vi.mock('./process-tree', () => ({ terminateProcessTree: mocks.terminate }))
vi.mock('./cli-executables', () => ({ resolveCliBinary: () => '/fake/agent' }))

function input(provider: 'claude' | 'opencode', sessionId: string | null): CliAgentTurnInput {
  return {
    projectId: null, provider, sessionId, prompt: '检查 rebalance', projectContext: '项目：arb\n最新事实：交易暂停',
    workingDirectory: '/repo', workspaceRoots: ['/repo', '/ops'], filesDirectory: '/files',
    abortController: new AbortController(), onUpdate: vi.fn(), onSessionId: vi.fn(), onTool: vi.fn(), onApproval: async () => 'approve'
  }
}
const runtime = () => new CliAgentRuntime({ getLaunchConfigs: async () => [] })

beforeEach(() => { vi.clearAllMocks(); mocks.terminate.mockResolvedValue(undefined) })

describe('native instruction delivery', () => {
  it('sends structured image bytes to the actual Claude SDK entrypoint on resume', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fuddy-claude-attachment-'))
    try {
      const path = join(root, 'image.png'); writeFileSync(path, 'pixel')
      const captured: unknown[] = []
      mocks.query.mockImplementation(async function* (args) {
        captured.push((await args.prompt[Symbol.asyncIterator]().next()).value)
        yield { type: 'result', subtype: 'success', result: '完成', session_id: 'existing' }
      })
      await runtime().runTurn({ ...input('claude', 'existing'), attachments: [{ path, name: 'image.png', mimeType: 'image/png' }] })
      expect(captured).toEqual([expect.objectContaining({ session_id: 'existing', message: { role: 'user', content: [
        { type: 'text', text: expect.stringContaining(path) },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('pixel').toString('base64') } }
      ] } })])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it.each([null, 'existing'])('appends Claude rules to the native preset on session %s', async sessionId => {
    let initialMessage: unknown
    mocks.query.mockImplementation(async function* (args) {
      initialMessage = (await args.prompt[Symbol.asyncIterator]().next()).value
      yield { type: 'result', subtype: 'success', result: '完成', session_id: 'existing' }
    })
    await runtime().runTurn(input('claude', sessionId))
    const args = mocks.query.mock.calls[0][0]
    expect(initialMessage).toMatchObject({
      type: 'user', message: { content: [{ type: 'text', text: '检查 rebalance' }] }
    })
    expect(args.options.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' })
    expect(args.options.systemPrompt.append).toContain('最新事实：交易暂停')
    expect(args.options.systemPrompt.append).toContain('/files')
    expect(args.options.additionalDirectories).toEqual(['/ops', '/files'])
    expect(args.options.resume).toBe(sessionId ?? undefined)
  })

  it.each([null, 'existing'])('provides OpenCode config instructions and cleans them after session %s', async sessionId => {
    const child = Object.assign(new EventEmitter(), { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough() })
    mocks.spawn.mockReturnValue(child)
    const running = runtime().runTurn(input('opencode', sessionId))
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce())
    const [, args, options] = mocks.spawn.mock.calls[0]
    const file = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT).instructions.at(-1)
    const instructions = readFileSync(file, 'utf8')
    expect(instructions).toContain('最新事实：交易暂停')
    expect(instructions).toContain('/ops')
    expect(instructions).toContain('/files')
    expect(args.at(-1)).toBe('检查 rebalance')
    if (sessionId) expect(args).toEqual(expect.arrayContaining(['--session', sessionId]))
    child.stdout.write(`${JSON.stringify({ type: 'text', part: { type: 'text', text: '完成' }, sessionID: 'existing' })}\n`)
    child.emit('close', 0)
    await expect(running).resolves.toMatchObject({ text: '完成' })
    expect(existsSync(file)).toBe(false)
  })

  it('cleans OpenCode instructions after startup failure', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough() })
    mocks.spawn.mockReturnValue(child)
    const running = runtime().runTurn(input('opencode', 'existing'))
    const rejected = expect(running).rejects.toThrow('cannot start')
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce())
    const file = JSON.parse(mocks.spawn.mock.calls[0][2].env.OPENCODE_CONFIG_CONTENT).instructions.at(-1)
    child.emit('error', new Error('cannot start'))
    await rejected
    expect(existsSync(file)).toBe(false)
  })
})
