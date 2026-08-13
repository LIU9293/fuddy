import { describe, expect, it } from 'vitest'
import { resolveThirdPartyMcpOptions } from './third-party-mcp-runtime'

describe('third-party MCP launch config', () => {
  it('resolves development binaries from pinned npm packages', () => {
    const options = resolveThirdPartyMcpOptions({
      appPath: '/workspace',
      resourcesPath: '/resources',
      userDataPath: '/user-data',
      packaged: false,
      hostBundleId: 'dev.test.project-agent',
      platform: 'darwin',
      arch: 'arm64'
    })
    expect(options.browserUse.name).toBe('browser_use')
    expect(options.browserUse.command).toBe('/workspace/.third-party-tools/uv/darwin-arm64/uv')
    expect(options.browserUse.args).toContain('browser-use==0.13.7')
    expect(options.browserUse.args.at(-1)).toBe('--mcp')
    expect(options.browserUse.env?.UV_CACHE_DIR).toBe('/user-data/agent-tools/uv-cache')
    expect(options.cuaDriverBinary).toBe('/workspace/.third-party-tools/cua-driver/darwin-universal/cua-driver')
    expect(options.hostBundleId).toBe('dev.test.project-agent')
  })

  it('resolves packaged binaries outside the asar archive', () => {
    const options = resolveThirdPartyMcpOptions({
      appPath: '/Applications/Fuddy.app/Contents/Resources/app.asar',
      resourcesPath: '/Applications/Fuddy.app/Contents/Resources',
      userDataPath: '/Users/test/Library/Application Support/Fuddy',
      packaged: true,
      hostBundleId: 'dev.test.project-agent',
      platform: 'darwin',
      arch: 'x64'
    })
    expect(options.browserUse.command).toBe('/Applications/Fuddy.app/Contents/Resources/third-party/uv/uv')
    expect(options.cuaDriverBinary).toBe('/Applications/Fuddy.app/Contents/Resources/third-party/cua-driver/cua-driver')
  })
})
