import { execFileSync } from 'node:child_process'
import { systemPreferences } from 'electron'
import type { Capability, ProviderSettings } from '../../shared/contracts'
import { isInstalledCliBinary, resolveCliBinary } from './cli-executables'

export function probeExecutable(command: string): { available: boolean; version?: string } {
  // An absolute, executable candidate is installed even if its version command
  // is slow or depends on configuration that is not available during onboarding.
  if (isInstalledCliBinary(command)) return { available: true }

  try {
    const version = execFileSync(command, ['--version'], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()

    return { available: true, version: version.split('\n')[0] }
  } catch {
    return { available: false }
  }
}

export function getCapabilities(providerSettings?: ProviderSettings): Capability[] {
  const codex = probeExecutable(resolveCliBinary('codex'))
  const claude = probeExecutable(resolveCliBinary('claude'))
  const opencode = probeExecutable(resolveCliBinary('opencode'))
  const screenAccess =
    process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'unknown'
  const accessibilityAccess =
    process.platform === 'darwin'
      ? systemPreferences.isTrustedAccessibilityClient(false)
      : false
  const isLoopback = (baseUrl: string): boolean => {
    try {
      return ['localhost', '127.0.0.1', '::1'].includes(new URL(baseUrl).hostname)
    } catch {
      return false
    }
  }
  const agentEndpointReady = (endpoint: ProviderSettings['agent']['primary']): boolean =>
    endpoint.apiKeyConfigured || isLoopback(endpoint.baseUrl)
  const hasAgentProvider = Boolean(providerSettings && (
    agentEndpointReady(providerSettings.agent.primary) ||
    (providerSettings.agent.backupEnabled && agentEndpointReady(providerSettings.agent.backup))
  ))
  return [
    {
      id: 'pi',
      label: '项目简报模型',
      status: hasAgentProvider ? 'ready' : 'needs-setup',
      detail: hasAgentProvider ? '已连接，可生成项目简报' : '选择一个可用模型后即可使用'
    },
    {
      id: 'browser',
      label: '浏览网页',
      status: 'ready',
      detail: '可以在独立浏览器中查找和读取网页'
    },
    {
      id: 'computer',
      label: '操作 Mac 应用',
      status: screenAccess === 'granted' && accessibilityAccess ? 'ready' : 'needs-setup',
      detail:
        screenAccess === 'granted' && accessibilityAccess
          ? '可以操作已允许的 Mac 应用'
          : '需要开启屏幕录制与辅助功能权限'
    },
    {
      id: 'codex',
      label: 'Codex',
      status: codex.available ? 'ready' : 'needs-setup',
      detail: codex.available ? '已安装' : '未安装'
    },
    {
      id: 'claude',
      label: 'Claude',
      status: claude.available ? 'ready' : 'needs-setup',
      detail: claude.available ? '已安装' : '未安装'
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      status: opencode.available ? 'ready' : 'needs-setup',
      detail: opencode.available ? '已安装' : '未安装'
    }
  ]
}
