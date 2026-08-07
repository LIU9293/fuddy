import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { EmbeddedCuaDriverHostLike } from '@trycua/cua-driver'

export type McpServerName = 'browser_use' | 'cua_driver' | 'project_agent'

export interface McpServerLaunchConfig {
  name: McpServerName
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface ThirdPartyMcpRuntimeOptions {
  browserUse: McpServerLaunchConfig
  browserConfigRoot: string
  cuaDriverBinary: string
  hostBundleId: string
}

export interface AgentMcpTool {
  name: string
  description: string
  inputSchema: Tool['inputSchema']
  serverName: McpServerName
  remoteName: string
}

interface ActiveMcpServer {
  config: McpServerLaunchConfig
  client: Client
  transport: StdioClientTransport
}

type DestroyableCuaHost = EmbeddedCuaDriverHostLike & { uniffiDestroy?: () => void }

function safeScope(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return normalized.slice(0, 80) || 'agent-run'
}

function cloneLaunchConfig(config: McpServerLaunchConfig): McpServerLaunchConfig {
  return {
    ...config,
    args: [...config.args],
    ...(config.env ? { env: { ...config.env } } : {})
  }
}

export function resolveThirdPartyMcpOptions(input: {
  appPath: string
  resourcesPath: string
  userDataPath: string
  packaged: boolean
  hostBundleId: string
  platform?: NodeJS.Platform
  arch?: string
}): ThirdPartyMcpRuntimeOptions {
  const platform = input.platform ?? process.platform
  const arch = input.arch ?? process.arch
  if (platform !== 'darwin') throw new Error('当前桌面发行版只配置了 macOS Agent 工具。')

  const uv = input.packaged
    ? join(input.resourcesPath, 'third-party', 'uv', 'uv')
    : join(input.appPath, '.third-party-tools', 'uv', `darwin-${arch}`, 'uv')
  const cuaDriverBinary = input.packaged
    ? join(input.resourcesPath, 'third-party', 'cua-driver', 'cua-driver')
    : join(input.appPath, '.third-party-tools', 'cua-driver', 'darwin-universal', 'cua-driver')
  const runtimeRoot = join(input.userDataPath, 'agent-tools')

  return {
    browserUse: {
      name: 'browser_use',
      command: uv,
      args: [
        'tool', 'run', '--python', '3.12', '--managed-python',
        '--from', 'browser-use==0.13.7', 'browser-use', '--mcp'
      ],
      env: {
        UV_CACHE_DIR: join(runtimeRoot, 'uv-cache'),
        UV_PYTHON_INSTALL_DIR: join(runtimeRoot, 'python'),
        BROWSER_USE_HEADLESS: 'true',
        BROWSER_USE_VERSION_CHECK: 'false'
      }
    },
    browserConfigRoot: join(runtimeRoot, 'browser-use'),
    cuaDriverBinary,
    hostBundleId: input.hostBundleId
  }
}

export class ThirdPartyMcpRuntime {
  private readonly servers = new Map<McpServerName, ActiveMcpServer>()
  private tools: AgentMcpTool[] = []
  private cuaHost: DestroyableCuaHost | null = null
  private cuaConfig: McpServerLaunchConfig | null = null
  private cuaStartPromise: Promise<McpServerLaunchConfig> | null = null
  private startPromise: Promise<void> | null = null

  constructor(private readonly options: ThirdPartyMcpRuntimeOptions) {}

  async start(): Promise<void> {
    if (this.servers.size > 0) return
    if (this.startPromise) return await this.startPromise
    this.startPromise = this.startInternal()
    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  private async startInternal(): Promise<void> {
    const configs = await this.getLaunchConfigs('pi-harness')
    const active: ActiveMcpServer[] = []
    try {
      for (const config of configs) {
        accessSync(config.command, constants.X_OK)
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: config.env,
          stderr: 'pipe'
        })
        transport.stderr?.on('data', () => undefined)
        const client = new Client({ name: 'project-agent', version: '0.1.0' })
        await client.connect(transport)
        const server = { config, client, transport }
        active.push(server)
        this.servers.set(config.name, server)
      }
      const discovered: AgentMcpTool[] = []
      for (const server of active) {
        const result = await server.client.listTools()
        for (const tool of result.tools) {
          discovered.push({
            name: server.config.name === 'cua_driver' ? `computer_${tool.name}` : tool.name,
            description: tool.description ?? `${server.config.name} MCP tool`,
            inputSchema: tool.inputSchema,
            serverName: server.config.name,
            remoteName: tool.name
          })
        }
      }
      this.tools = discovered
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  private async ensureCuaConfig(): Promise<McpServerLaunchConfig> {
    if (this.cuaConfig) return cloneLaunchConfig(this.cuaConfig)
    if (this.cuaStartPromise) return cloneLaunchConfig(await this.cuaStartPromise)
    this.cuaStartPromise = (async () => {
      accessSync(this.options.cuaDriverBinary, constants.X_OK)
      const { EmbeddedCuaDriverHost } = await import('@trycua/cua-driver')
      const host = new EmbeddedCuaDriverHost(this.options.cuaDriverBinary, this.options.hostBundleId) as DestroyableCuaHost
      try {
        const connection = await host.start()
        this.cuaHost = host
        this.cuaConfig = {
          name: 'cua_driver',
          command: connection.mcp.command,
          args: [...connection.mcp.args],
          env: Object.fromEntries(connection.mcp.environment.map((item) => [item.name, item.value]))
        }
        return cloneLaunchConfig(this.cuaConfig)
      } catch (error) {
        host.uniffiDestroy?.()
        throw error
      }
    })()
    try {
      return await this.cuaStartPromise
    } finally {
      this.cuaStartPromise = null
    }
  }

  listTools(): AgentMcpTool[] {
    return this.tools.map((tool) => ({ ...tool, inputSchema: structuredClone(tool.inputSchema) }))
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const tool = this.tools.find((item) => item.name === name)
    if (!tool) throw new Error(`MCP Tool 不存在：${name}`)
    const server = this.servers.get(tool.serverName)
    if (!server) throw new Error(`MCP Server 未启动：${tool.serverName}`)
    return await server.client.callTool(
      { name: tool.remoteName, arguments: args },
      undefined,
      { timeout: 120_000, maxTotalTimeout: 180_000 }
    ) as CallToolResult
  }

  async getLaunchConfigs(scope = 'agent-run'): Promise<McpServerLaunchConfig[]> {
    const browser = cloneLaunchConfig(this.options.browserUse)
    browser.env = {
      ...browser.env,
      BROWSER_USE_CONFIG_DIR: join(this.options.browserConfigRoot, safeScope(scope))
    }
    return [browser, await this.ensureCuaConfig()]
  }

  private async stopClients(): Promise<void> {
    const servers = [...this.servers.values()]
    this.servers.clear()
    this.tools = []
    await Promise.allSettled(servers.map((server) => server.client.close()))
  }

  async stop(): Promise<void> {
    await this.stopClients()
    const host = this.cuaHost
    this.cuaHost = null
    this.cuaConfig = null
    if (host) {
      await host.stop().catch(() => undefined)
      host.uniffiDestroy?.()
    }
  }
}
