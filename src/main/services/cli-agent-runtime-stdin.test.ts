import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { CliAgentRuntime } from './cli-agent-runtime'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('./cli-executables', () => ({ resolveCliBinary: (provider: string) => `/fake/${provider}` }))

it('signals stdin EOF so OpenCode emits its response without waiting for interactive input', async () => {
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
    child.stdin.on('finish', () => queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ type: 'text', sessionID: 'opencode-session', part: { type: 'text', text: '完成' } }) + '\n')
      child.emit('close', 0)
    }))
    return child
  })
  await expect(new CliAgentRuntime({ getLaunchConfigs: async () => [] }).runTurn({
    provider: 'opencode', projectId: null, prompt: '检查上线阻塞', sessionId: null, workingDirectory: '/project',
    workspaceRoots: ['/project'], filesDirectory: '/files', abortController: new AbortController(),
    onUpdate: vi.fn(), onSessionId: vi.fn(), onTool: vi.fn(), onApproval: async () => 'approve'
  })).resolves.toEqual({ text: '完成', sessionId: 'opencode-session' })
})
