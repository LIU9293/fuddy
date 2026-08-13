import { describe, expect, it } from 'vitest'
import type { CliAgentTurnInput } from './cli-agent-runtime'
import {
  buildCliArgs,
  buildCliEnv,
  buildCodexTurnStartParams,
  buildCodexAppServerArgs,
  claudeSdkReasoningOptions,
  codingAgentRuntimeRoots,
  codexAgentMessagePhase,
  codexAppServerToolRecord,
  codexCompletedReasoningSummaries,
  codexReasoningSegmentId,
  codexReasoningSummaryDelta,
  CODEX_APPROVAL_POLICY,
  CODEX_REASONING_SUMMARY,
  CODEX_THREAD_SANDBOX,
  CODEX_TURN_SANDBOX_POLICY,
  claudeRecord,
  codexTomlStringMap,
  opencodeRecord
} from './cli-agent-runtime'
import type { McpServerLaunchConfig } from './third-party-mcp-runtime'

const servers: McpServerLaunchConfig[] = [
  {
    name: 'browser_use', command: '/tools/uv', args: ['tool', 'run', 'browser-use', '--mcp'],
    env: { BROWSER_USE_CONFIG_DIR: '/profiles/test' }
  },
  { name: 'cua_driver', command: '/tools/cua-driver', args: ['mcp', '--embedded', '--socket', '/tmp/cua.sock'] }
]

function input(provider: CliAgentTurnInput['provider']): CliAgentTurnInput {
  return {
    projectId: 'project',
    provider,
    prompt: 'test',
    sessionId: null,
    workingDirectory: '/repo',
    workspaceRoots: ['/repo'],
    filesDirectory: '/files',
    abortController: new AbortController(),
    onUpdate: () => undefined,
    onSessionId: () => undefined,
    onTool: () => undefined,
    onApproval: async () => 'deny'
  }
}

describe('coding CLI MCP injection', () => {
  it('preserves Claude summarized-thinking stream deltas for the live reasoning UI', () => {
    expect(claudeRecord({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: '正在检查项目数据库连接方式。' }
      }
    })).toEqual({ reasoning: '正在检查项目数据库连接方式。' })
  })

  it('forwards Codex reasoning summaries without exposing raw reasoning deltas', () => {
    expect(codexReasoningSummaryDelta('item/reasoning/summaryTextDelta', { delta: '正在检查依赖关系。' }))
      .toBe('正在检查依赖关系。')
    expect(codexReasoningSummaryDelta('item/reasoning/textDelta', { delta: 'raw chain of thought' }))
      .toBe('')
  })

  it('preserves Codex commentary and final-answer phases from app-server items', () => {
    expect(codexAgentMessagePhase({ type: 'agentMessage', phase: 'commentary' })).toBe('commentary')
    expect(codexAgentMessagePhase({ type: 'agentMessage', phase: 'final_answer' })).toBe('final_answer')
    expect(codexAgentMessagePhase({ type: 'agentMessage', phase: null })).toBeNull()
    expect(codexAgentMessagePhase({ type: 'commandExecution' })).toBeNull()
  })

  it('keeps Codex reasoning summary sections as separate timeline segments', () => {
    expect(codexReasoningSegmentId({ itemId: 'reasoning-1', summaryIndex: 2 }))
      .toBe('reasoning-1:summary:2')
    expect(codexCompletedReasoningSummaries({
      id: 'reasoning-1',
      type: 'reasoning',
      summary: ['先检查依赖。', { type: 'summary_text', text: '再运行测试。' }]
    })).toEqual([
      { segmentId: 'reasoning-1:summary:0', text: '先检查依赖。' },
      { segmentId: 'reasoning-1:summary:1', text: '再运行测试。' }
    ])
  })

  it('preserves OpenCode reasoning parts for the shared reasoning UI', () => {
    expect(opencodeRecord({
      type: 'reasoning',
      part: { id: 'reasoning-1', type: 'reasoning', text: '正在核对实现。' }
    })).toEqual({ reasoning: '正在核对实现。', reasoningSegmentId: 'reasoning-1' })
  })

  it('maps OpenCode tool lifecycle records using callID instead of the part ID', () => {
    expect(opencodeRecord({
      type: 'tool_use',
      part: {
        id: 'part-1',
        callID: 'call-1',
        type: 'tool',
        tool: 'read',
        state: { status: 'completed', input: { filePath: '/repo/package.json' }, output: 'contents' }
      }
    })).toMatchObject({
      tool: { id: 'call-1', name: 'read', status: 'completed' }
    })
  })

  it('normalizes every supported Codex app-server tool item lifecycle', () => {
    expect(codexAppServerToolRecord({
      id: 'command-1', type: 'commandExecution', command: 'npm test', status: 'inProgress'
    })).toEqual({ id: 'command-1', name: 'command', detail: 'npm test', status: 'running' })
    expect(codexAppServerToolRecord({
      id: 'file-1', type: 'fileChange', changes: [{ path: 'src/main.ts' }], status: 'completed'
    })).toMatchObject({ id: 'file-1', name: 'edit', status: 'completed' })
    expect(codexAppServerToolRecord({ type: 'agentMessage', text: 'done' })).toBeUndefined()
  })

  it('adds both stdio servers to Codex config overrides', () => {
    const rawArgs = buildCliArgs(input('codex'), servers)
    const args = rawArgs.join(' ')
    expect(args).toContain('mcp_servers.browser_use.command')
    expect(args).toContain('mcp_servers.browser_use.env')
    expect(args).toContain('mcp_servers.cua_driver.args')
    expect(args).not.toContain('Bearer')
    expect(rawArgs).toContain('mcp_servers.browser_use.env={ "BROWSER_USE_CONFIG_DIR" = "/profiles/test" }')
    expect(args).not.toContain('env={"BROWSER_USE_CONFIG_DIR":"/profiles/test"}')
    expect(rawArgs).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(rawArgs).not.toContain('workspace-write')
  })

  it('starts Codex app-server with MCP config; full access is selected in the RPC thread policy', () => {
    const rawArgs = buildCodexAppServerArgs(servers)
    const args = rawArgs.join(' ')
    expect(args).toContain('app-server --stdio')
    expect(args).toContain('mcp_servers.browser_use.command')
    expect(rawArgs).toContain('mcp_servers.browser_use.env={ "BROWSER_USE_CONFIG_DIR" = "/profiles/test" }')
    expect(args).not.toContain('dangerously-bypass')
    expect(args).not.toContain('approve-for-me')
  })

  it('uses the exact Codex app-server permission enum casing', () => {
    expect(CODEX_APPROVAL_POLICY).toBe('never')
    expect(CODEX_THREAD_SANDBOX).toBe('danger-full-access')
    expect(CODEX_TURN_SANDBOX_POLICY).toBe('dangerFullAccess')
  })

  it('binds every configured workspace root plus the project files directory', () => {
    expect(codingAgentRuntimeRoots({
      workingDirectory: '/repo-primary',
      workspaceRoots: ['/repo-primary', '/repo-secondary'],
      filesDirectory: '/files'
    })).toEqual(['/repo-primary', '/repo-secondary', '/files'])

    const claudeArgs = buildCliArgs({
      ...input('claude'),
      workingDirectory: '/repo-primary',
      workspaceRoots: ['/repo-primary', '/repo-secondary']
    }, [])
    expect(claudeArgs).toEqual(expect.arrayContaining(['--add-dir', '/repo-secondary', '--add-dir', '/files']))
  })

  it('escapes Codex MCP environment values as a TOML inline table', () => {
    expect(codexTomlStringMap({
      PATH_WITH_SPACES: '/Users/kai/Library/Application Support/app',
      QUOTED: 'say "hello"'
    })).toBe('{ "PATH_WITH_SPACES" = "/Users/kai/Library/Application Support/app", "QUOTED" = "say \\"hello\\"" }')
  })

  it('passes both stdio servers through Claude mcp-config', () => {
    const args = buildCliArgs(input('claude'), servers)
    const configIndex = args.indexOf('--mcp-config')
    const config = JSON.parse(args[configIndex + 1] ?? '{}') as { mcpServers?: Record<string, unknown> }
    expect(Object.keys(config.mcpServers ?? {})).toEqual(['browser_use', 'cua_driver'])
    expect(config.mcpServers?.browser_use).toMatchObject({ env: { BROWSER_USE_CONFIG_DIR: '/profiles/test' } })
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions']))
  })

  it('passes the parent shell environment through to Claude unchanged', () => {
    const env = buildCliEnv('claude', [], {
      PATH: '/usr/bin',
      ANTHROPIC_BASE_URL: 'https://proxy.example.com',
      ANTHROPIC_AUTH_TOKEN: 'proxy-token',
      ANTHROPIC_MODEL: 'proxy-model',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://proxy.example.com')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('proxy-token')
    expect(env.ANTHROPIC_MODEL).toBe('proxy-model')
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
  })

  it('merges local MCP servers into OpenCode config content', () => {
    const env = buildCliEnv('opencode', servers, {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: 'system', mcp: { existing: { type: 'remote', url: 'https://example.com' } } })
    })
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}') as {
      theme?: string
      permission?: string
      mcp?: Record<string, { type?: string; command?: string[] }>
    }
    expect(config.theme).toBe('system')
    expect(config.permission).toBe('allow')
    expect(config.mcp?.existing).toBeTruthy()
    expect(config.mcp?.browser_use).toEqual({
      type: 'local',
      command: ['/tools/uv', 'tool', 'run', 'browser-use', '--mcp'],
      environment: { BROWSER_USE_CONFIG_DIR: '/profiles/test' },
      enabled: true
    })
  })

  it('runs OpenCode with automatic permission approval', () => {
    const args = buildCliArgs(input('opencode'), [])
    expect(args).toContain('--auto')
    expect(args).toContain('--thinking')
  })

  it('passes an explicit default model to every coding CLI', () => {
    const codex = buildCliArgs({ ...input('codex'), model: 'gpt-codex-test' }, [])
    const claude = buildCliArgs({ ...input('claude'), model: 'claude-test' }, [])
    const opencode = buildCliArgs({ ...input('opencode'), model: 'provider/model-test' }, [])

    expect(codex).toEqual(expect.arrayContaining(['--model', 'gpt-codex-test']))
    expect(claude).toEqual(expect.arrayContaining(['--model', 'claude-test']))
    expect(opencode).toEqual(expect.arrayContaining(['--model', 'provider/model-test']))
  })

  it('passes provider-native reasoning effort arguments only when configured', () => {
    const codex = buildCliArgs({ ...input('codex'), reasoningEffort: 'high' }, [])
    const claude = buildCliArgs({ ...input('claude'), reasoningEffort: 'max' }, [])
    const opencode = buildCliArgs({ ...input('opencode'), reasoningEffort: 'medium' }, [])

    expect(codex).toEqual(expect.arrayContaining(['-c', 'model_reasoning_effort="high"']))
    expect(claude).toEqual(expect.arrayContaining(['--effort', 'max']))
    expect(opencode).toEqual(expect.arrayContaining(['--variant', 'medium']))
    expect(buildCliArgs(input('codex'), []).join(' ')).not.toContain('model_reasoning_effort')
    expect(buildCliArgs(input('claude'), [])).not.toContain('--effort')
    expect(buildCliArgs(input('opencode'), [])).not.toContain('--variant')
  })

  it('passes configured effort to the active Codex app-server turn and Claude SDK', () => {
    expect(CODEX_REASONING_SUMMARY).toBe('auto')
    expect(buildCodexTurnStartParams('thread', 'test', 'xhigh')).toMatchObject({ effort: 'xhigh', summary: 'auto' })
    expect(buildCodexTurnStartParams('thread', 'test')).not.toHaveProperty('effort')
    expect(claudeSdkReasoningOptions('max')).toEqual({ effort: 'max' })
    expect(claudeSdkReasoningOptions()).toEqual({})
  })
})
