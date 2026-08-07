import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveThirdPartyMcpOptions, ThirdPartyMcpRuntime } from './third-party-mcp-runtime'

const describeAgentTools = process.env.RUN_AGENT_TOOLS_SMOKE === '1' ? describe : describe.skip

describeAgentTools('Browser Use and CUA Driver real MCP smoke', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'project-agent-mcp-smoke-'))
  const projectRoot = resolve(import.meta.dirname, '../../..')
  const runtime = new ThirdPartyMcpRuntime(resolveThirdPartyMcpOptions({
    appPath: projectRoot,
    resourcesPath: projectRoot,
    userDataPath,
    packaged: false,
    hostBundleId: 'dev.ainative.projectagent.smoke'
  }))

  beforeAll(async () => {
    await runtime.start()
  }, 180_000)

  afterAll(async () => {
    await runtime.stop()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('discovers the official MCP tools', () => {
    const names = runtime.listTools().map((tool) => tool.name)
    expect(names).toContain('browser_navigate')
    expect(names).toContain('browser_get_state')
    expect(names).toContain('computer_list_apps')
    expect(names).toContain('computer_check_permissions')
  })

  it('navigates and reads a page through Browser Use', async () => {
    const navigation = await runtime.callTool('browser_navigate', { url: 'https://example.com' })
    expect(navigation.isError).not.toBe(true)
    const state = await runtime.callTool('browser_get_state', { include_screenshot: false })
    const text = state.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
    expect(text).toContain('https://example.com/')
    expect(text).toContain('Learn more')
    await runtime.callTool('browser_close_all', {})
  }, 120_000)

  it('performs read-only CUA Driver calls', async () => {
    const permissions = await runtime.callTool('computer_check_permissions', {})
    expect(permissions.isError).not.toBe(true)
    const apps = await runtime.callTool('computer_list_apps', {})
    expect(apps.isError).not.toBe(true)
  }, 30_000)
})
