import { describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import { agentRunProviders } from '../../shared/agent-providers'
import { createT3AgentRegistry, t3EngineBindingKey } from './t3-agent-dispatch'
import { T3AgentRuntime } from './t3-agent-runtime'
import type { McpServerLaunchConfig } from './third-party-mcp-runtime'

type TurnInput = Parameters<T3AgentRuntime['runTurn']>[0]

function turn(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    runId: 'chat-1', requestId: 'request-1', provider: 'codex', projectId: 'project-1',
    prompt: 'Check the workspace', workingDirectory: '/workspace', workspaceRoots: ['/workspace', '/library'],
    filesDirectory: '/files', sessionId: null, executionStartedAt: '2026-11-24T06:00:00.000Z',
    abortController: new AbortController(), onUpdate: vi.fn(), onTool: vi.fn(), onSessionId: vi.fn(),
    onCodexSessionReady: vi.fn(), onApproval: async () => 'deny', ...overrides
  }
}

describe('T3 agent runtime', () => {
  it.each([...agentRunProviders, 'acp-gemini' as const])('dispatches %s through T3 with the project scope', async provider => {
    const messages: object[] = []
    const migrate = vi.fn()
    const bind = vi.fn()
    const registry = createT3AgentRegistry({
      process: {
        watch: () => () => undefined,
        async request<T>(message: object, schema: z.ZodType<T>): Promise<T> {
          messages.push(message)
          return schema.parse('type' in message && message.type === 'send' ? { runId: 't3-run' } : {
            sequence: 1, run: { id: 't3-run', status: 'completed', attemptId: null },
            nativeId: 'retained-session',
            items: [{ id: 'answer', type: 'assistant_message', status: 'completed', parentItemId: null,
              phase: 'final_answer', text: 'Done.' }]
          })
        }
      },
      tools: { getLaunchConfigs: async () => [] },
      settings: { getCodingAgentDefaultModel: () => null, getCodingAgentDefaultReasoningEffort: () => null },
      codexMigration: { adoptCodexSession: migrate },
      databasePath: '/db', mcpScript: '/mcp', bind
    })
    await expect(registry.get(provider).runTurn({
      runId: 'chat-1', requestId: 'request-1', projectId: 'project-1', projectContext: 'QA project',
      prompt: 'Check the workspace', workingDirectory: '/workspace', workspaceRoots: ['/library'],
      filesDirectory: '/files', sessionId: 'retained-session', codexSessionOwned: true, history: () => [],
      abortController: new AbortController(), onUpdate: vi.fn(), onTool: vi.fn(), onSessionId: vi.fn(),
      onApproval: async () => 'deny'
    })).resolves.toEqual({ text: 'Done.', sessionId: 'retained-session' })
    expect(messages[0]).toMatchObject({
      type: 'send', provider, nativeId: 'retained-session', cwd: '/workspace', model: null,
      context: { mcpServers: [{ name: 'project_agent', env: { PROJECT_AGENT_PROJECT_ID: 'project-1' } }] }
    })
    expect(migrate).not.toHaveBeenCalled()
    expect(bind).toHaveBeenCalledWith(t3EngineBindingKey(provider, 'chat-1'))
  })

  it('uses a durable request identity, forwards public items, and returns the final message', async () => {
    const code = { id: 'cmd', type: 'command_execution', status: 'completed', parentItemId: null, input: 'pwd' }
    const file = { id: 'edit', type: 'file_change', status: 'completed', parentItemId: null, fileName: 'readme.md',
      diffStr: '--- a/readme.md\n+++ b/readme.md\n@@ -1 +1 @@\n-Old\n+New' }
    const commentary = { id: 'note', type: 'assistant_message', status: 'completed', parentItemId: null, text: 'Checking.' }
    const question = { id: 'question', type: 'user_input_request', status: 'completed', parentItemId: null, ordinal: 6,
      questions: [{ id: 'format', question: 'Which format?', options: [{ label: 'Compact' }] }],
      questionAnswer: { answers: { 'Which format?': 'Compact' } } }
    const answer = { id: 'answer', type: 'assistant_message', status: 'completed', parentItemId: null, phase: 'final_answer', text: 'Done.' }
    const history: Record<string, unknown>[] = []
    const unwatch = vi.fn()
    const runtime = new T3AgentRuntime({
      watch: () => unwatch,
      async request<T>(raw: object, schema: z.ZodType<T>): Promise<T> {
        const command = raw as Record<string, unknown>
        history.push(command)
        return schema.parse(command.type === 'send' ? { runId: 't3-run' } : {
          sequence: 1, run: { id: 't3-run', status: 'completed', attemptId: 't3-attempt' },
          nativeId: 'native-codex', items: [commentary, code, file, question, answer]
        })
      }
    })
    const input = turn()
    const servers: McpServerLaunchConfig[] = [{ name: 'project_agent', command: '/electron', args: ['/agent-mcp'] }]
    await expect(runtime.runTurn(input, servers)).resolves.toEqual({ text: 'Done.', sessionId: 'native-codex' })
    await runtime.runTurn(input, servers)
    await runtime.runTurn(turn({ executionStartedAt: '2026-11-24T06:02:00.000Z' }), servers)

    expect(history[0]).toMatchObject({
      threadId: 'chat-1', provider: 'codex', model: null, cwd: '/workspace',
      context: { workspaceRoots: ['/workspace', '/library', '/files'], mcpServers: servers }
    })
    expect(history[1].requestId).toBe(history[0].requestId)
    expect(history[2].requestId).toBe(history[0].requestId)
    expect(history[4].requestId).not.toBe(history[0].requestId)
    expect(input.onCodexSessionReady).toHaveBeenCalledWith({ sessionId: 'native-codex', sourceSessionId: null, messages: [] })
    expect(input.onUpdate).toHaveBeenCalledWith({ type: 'commentary_delta', messageId: 'note', delta: 'Checking.' })
    expect(input.onUpdate).toHaveBeenCalledWith({ type: 'question_record', itemId: 'question', status: 'completed',
      questions: ['Which format?'], choices: ['Compact'], timelineOrdinal: 6 })
    expect(input.onTool).toHaveBeenCalledWith('applyPatch', `readme.md\n\n${file.diffStr}`, { status: 'completed', engine: 't3',
      itemId: 'edit', path: 'readme.md', fileChange: { path: 'readme.md', diff: file.diffStr, additions: 1, deletions: 1 } })
    expect(unwatch).toHaveBeenCalledTimes(3)
  })

  it.each([
    [{ status: 'delivered', ordinal: 3 }, { timelineOrdinal: 3 }],
    [{ status: 'queued' }, 'deferred'],
    [{ status: 'cancelled' }, 'cancelled']
  ])('reconciles native Steer delivery %j using the same identity after restart', async (status, expected) => {
    const commands: Array<Record<string, unknown>> = []
    let notify = () => undefined
    let settled = false
    const input = turn({ onSteerReady: steer => {
      if (!steer) return
      operation = steer('New direction', [], 'follow-up', '2026-11-24T06:03:00.000Z')
      void operation.finally(() => { settled = true; notify() })
    } })
    let operation: Promise<unknown> | undefined
    const runtime = new T3AgentRuntime({
      watch: (_id, callback) => { notify = () => { callback(); return undefined }; return () => undefined },
      async request<T>(command: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
        commands.push(command)
        if (command.type === 'send') return schema.parse({ runId: 'parent' })
        if (command.type === 'steer') return schema.parse(true)
        if (command.type === 'steer-status') return schema.parse(status)
        return schema.parse({
          canSteer: !settled, sequence: settled ? 2 : 1, nativeId: 'session',
          run: { id: 'parent', status: settled ? 'completed' : 'running', attemptId: 'attempt' },
          items: settled ? [{ id: 'answer', type: 'assistant_message', status: 'completed',
            parentItemId: null, phase: 'final_answer', text: 'Done.' }] : []
        })
      }
    })
    await runtime.runTurn(input, [])
    await expect(operation).resolves.toEqual(expected)
    await expect(runtime.recoverSteer('chat-1', 'follow-up', '2026-11-24T06:03:00.000Z')).resolves.toEqual(expected)
    const submit = commands.find(command => command.type === 'steer')
    expect(submit?.parentRequestId).toBe(commands[0].requestId)
    expect(commands.filter(command => command.type === 'steer-status').map(command => command.requestId))
      .toEqual([submit?.requestId, submit?.requestId])
  })

  it('interrupts the accepted request and waits for the runtime to settle', async () => {
    const input = turn()
    const stopped = new Error('stopped')
    const methods: unknown[] = []
    let finished = false
    const runtime = new T3AgentRuntime({
      watch: () => () => undefined,
      async request<T>(raw: object, schema: z.ZodType<T>): Promise<T> {
        const command = raw as { type: string }
        methods.push(command.type)
        if (command.type === 'send') {
          input.abortController.abort(stopped)
          return schema.parse({ runId: 't3-run' })
        }
        if (command.type === 'stop') {
          finished = true
          return schema.parse(null)
        }
        return schema.parse({
          sequence: finished ? 2 : 1, nativeId: 'native-codex', items: [],
          run: { id: 't3-run', status: finished ? 'interrupted' : 'running', attemptId: 't3-attempt' }
        })
      }
    })
    await expect(runtime.runTurn(input, [])).rejects.toBe(stopped)
    expect(methods).toEqual(['send', 'snapshot', 'stop', 'snapshot'])
  })

  it('reads a committed answer after restart without sending the prompt again', async () => {
    const methods: string[] = []
    const input = turn({ onCommittedProjection: vi.fn((_sequence, _terminal, publish) => publish()) })
    const runtime = new T3AgentRuntime({
      watch: () => () => undefined,
      async request<T>(raw: object, schema: z.ZodType<T>): Promise<T> {
        methods.push((raw as { type: string }).type)
        return schema.parse({
          sequence: 15, nativeId: 'native-codex',
          run: { id: 't3-run', status: 'completed', attemptId: 't3-attempt' },
          items: [{ id: 'answer', type: 'assistant_message', status: 'completed', parentItemId: null,
            phase: 'final_answer', text: 'Already completed.' }]
        })
      }
    })
    await expect(runtime.recoverTurn(input)).resolves.toEqual({ text: 'Already completed.', sessionId: 'native-codex' })
    expect(methods).toEqual(['snapshot'])
    expect(input.onCommittedProjection).toHaveBeenCalledWith(15, true, expect.any(Function))
  })

  it('routes a waiting provider question and closes the card after replying', async () => {
    const question = { id: 'q1', question: 'Choose', options: [{ label: 'B', description: 'Second option' }] }
    const methods: string[] = []
    let replied = false
    let answer: unknown
    const input = turn({ onInputRequest: vi.fn((request, respond) => {
      if (request) void respond({ q1: 'B' })
    }) })
    const runtime = new T3AgentRuntime({
      watch: () => () => undefined,
      async request<T>(raw: object, schema: z.ZodType<T>): Promise<T> {
        const command = raw as { type: string; answers?: unknown }
        methods.push(command.type)
        if (command.type === 'send') return schema.parse({ runId: 't3-run' })
        if (command.type === 'answer') {
          replied = true
          answer = command.answers
          return schema.parse(null)
        }
        return schema.parse({
          sequence: replied ? 2 : 1, nativeId: 'native-codex',
          run: { id: 't3-run', status: replied ? 'completed' : 'waiting', attemptId: 't3-attempt' },
          items: replied ? [{ id: 'answer', type: 'assistant_message', status: 'completed', parentItemId: null,
            phase: 'final_answer', text: 'B selected.' }] : [{ id: 'question', type: 'user_input_request', status: 'waiting',
            parentItemId: null, requestId: 'native-question', questions: [question] }]
        })
      }
    })
    await expect(runtime.runTurn(input, [])).resolves.toMatchObject({ text: 'B selected.' })
    expect(answer).toEqual({ q1: 'B' })
    expect(methods).toEqual(['send', 'snapshot', 'answer', 'snapshot'])
    expect(input.onInputRequest).toHaveBeenLastCalledWith(null, expect.any(Function))
  })
})
