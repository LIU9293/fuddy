import { describe, expect, it } from 'vitest'
import type { CliAgentTurnInput } from './cli-agent-runtime'
import { buildCliArgs, buildCliEnv, buildCodexAppServerArgs, codexTomlStringMap } from './cli-agent-runtime'
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
    expect(buildCliArgs(input('opencode'), [])).toContain('--auto')
  })

  it('passes an explicit default model to every coding CLI', () => {
    const codex = buildCliArgs({ ...input('codex'), model: 'gpt-codex-test' }, [])
    const claude = buildCliArgs({ ...input('claude'), model: 'claude-test' }, [])
    const opencode = buildCliArgs({ ...input('opencode'), model: 'provider/model-test' }, [])

    expect(codex).toEqual(expect.arrayContaining(['--model', 'gpt-codex-test']))
    expect(claude).toEqual(expect.arrayContaining(['--model', 'claude-test']))
    expect(opencode).toEqual(expect.arrayContaining(['--model', 'provider/model-test']))
  })
})
