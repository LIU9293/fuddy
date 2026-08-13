import { describe, expect, it, vi } from 'vitest'
import type { AgentRunMessage } from '../../shared/contracts'
import type { CliAgentRuntime } from './cli-agent-runtime'
import type { PiTaskHarness } from './pi-task-harness'
import {
  AgentProviderRegistry,
  codingAgentContinuationContext,
  createDefaultAgentProviderRegistry,
  type AgentProviderTurnInput
} from './agent-provider-registry'

function turnInput(): AgentProviderTurnInput {
  return {
    runId: 'run-1',
    projectId: 'project-1',
    projectContext: 'project context',
    prompt: 'do work',
    history: () => [],
    sessionId: 'session-1',
    workingDirectory: '/tmp/project',
    workspaceRoots: ['/tmp/project'],
    filesDirectory: '/tmp/files',
    abortController: new AbortController(),
    onUpdate: () => undefined,
    onTool: () => undefined,
    onSessionId: () => undefined,
    onApproval: async () => 'approve'
  }
}

describe('AgentProviderRegistry', () => {
  it('builds continuation context from persisted user and assistant messages only', () => {
    expect(codingAgentContinuationContext([
      { id: 'user-1', runId: 'run-1', role: 'user', content: '先检查数据库', eventType: null, toolName: null, metadata: null, createdAt: '2026-01-01' },
      { id: 'tool-1', runId: 'run-1', role: 'tool', content: 'secret tool output', eventType: 'tool', toolName: 'read', metadata: null, createdAt: '2026-01-01' },
      { id: 'assistant-1', runId: 'run-1', role: 'assistant', content: '数据库检查完成', eventType: null, toolName: null, metadata: null, createdAt: '2026-01-01' }
    ])).toBe('用户：先检查数据库\n\nAgent：数据库检查完成')
  })

  it('rejects duplicate and missing provider registrations', () => {
    const adapter = {
      provider: 'pi' as const,
      capabilities: { nativeSessions: true, modelSelection: false, reasoningSummaries: true, toolCalls: true, approvals: true },
      runTurn: vi.fn(async () => ({ text: 'ok', sessionId: null }))
    }
    const registry = new AgentProviderRegistry([adapter])
    expect(() => registry.register(adapter)).toThrow('already registered')
    expect(() => registry.get('codex')).toThrow('is not registered')
  })

  it('routes every built-in provider through its adapter', async () => {
    const piRunTurn = vi.fn(async () => 'pi result')
    const cliRunTurn = vi.fn(async (input: { provider: string }) => ({ text: `${input.provider} result`, sessionId: 'native-session' }))
    const registry = createDefaultAgentProviderRegistry(
      { runTurn: piRunTurn } as unknown as PiTaskHarness,
      { runTurn: cliRunTurn } as unknown as CliAgentRuntime
    )

    expect(registry.list().map((adapter) => adapter.provider)).toEqual(['pi', 'codex', 'claude', 'opencode'])
    const piInput = turnInput()
    piInput.history = vi.fn(() => [])
    await expect(registry.runTurn('pi', piInput)).resolves.toMatchObject({ text: 'pi result' })
    expect(piInput.history).toHaveBeenCalledOnce()
    const cliInput = turnInput()
    cliInput.model = 'gpt-test'
    cliInput.reasoningEffort = 'high'
    cliInput.history = vi.fn(() => [])
    await expect(registry.runTurn('codex', cliInput)).resolves.toEqual({ text: 'codex result', sessionId: 'native-session' })
    expect(cliInput.history).not.toHaveBeenCalled()
    expect(cliRunTurn).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'codex',
      model: 'gpt-test',
      reasoningEffort: 'high',
      prompt: 'project context\n\n用户任务：\ndo work'
    }))
  })

  it('seeds a replacement coding session with persisted conversation history', async () => {
    const cliRunTurn = vi.fn(async () => ({ text: 'continued', sessionId: 'replacement-session' }))
    const registry = createDefaultAgentProviderRegistry(
      { runTurn: vi.fn() } as unknown as PiTaskHarness,
      { runTurn: cliRunTurn } as unknown as CliAgentRuntime
    )
    const input = turnInput()
    input.sessionId = null
    const history: AgentRunMessage[] = [
      { id: 'user-1', runId: 'run-1', role: 'user', content: '之前的需求', eventType: null, toolName: null, metadata: null, createdAt: '2026-01-01' },
      { id: 'assistant-1', runId: 'run-1', role: 'assistant', content: '之前的结果', eventType: null, toolName: null, metadata: null, createdAt: '2026-01-01' }
    ]
    input.history = vi.fn(() => history)

    await registry.runTurn('claude', input)

    expect(input.history).toHaveBeenCalledOnce()
    expect(cliRunTurn).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'claude',
      sessionId: null,
      prompt: expect.stringContaining('用户：之前的需求\n\nAgent：之前的结果')
    }))
  })
})
