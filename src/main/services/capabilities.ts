import { execFileSync } from 'node:child_process'
import { systemPreferences } from 'electron'
import type { Capability, ProviderSettings } from '../../shared/contracts'
import { resolveCliBinary } from './cli-executables'

function probeExecutable(command: string): { available: boolean; version?: string } {
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
  const effectiveAgent = providerSettings && agentEndpointReady(providerSettings.agent.primary)
    ? providerSettings.agent.primary
    : providerSettings?.agent.backupEnabled && agentEndpointReady(providerSettings.agent.backup)
      ? providerSettings.agent.backup
      : providerSettings?.agent.primary
  const agentLabel = effectiveAgent?.mode === 'cc-switch-codex-oauth'
    ? 'CC Switch · Codex OAuth'
    : 'OpenAI Compatible Provider'
  const primaryTts = providerSettings?.tts.primary
  const ttsEndpointReady = (endpoint: ProviderSettings['tts']['primary']): boolean =>
    endpoint.mode === 'system' || endpoint.apiKeyConfigured
  const hasTtsProvider = Boolean(providerSettings && (
    ttsEndpointReady(providerSettings.tts.primary) ||
    (providerSettings.tts.backupEnabled && ttsEndpointReady(providerSettings.tts.backup))
  ))
  const effectiveTts = providerSettings && ttsEndpointReady(providerSettings.tts.primary)
    ? providerSettings.tts.primary
    : providerSettings?.tts.backupEnabled && ttsEndpointReady(providerSettings.tts.backup)
      ? providerSettings.tts.backup
      : primaryTts
  const ttsLabel = effectiveTts?.mode === 'elevenlabs'
    ? 'ElevenLabs'
    : effectiveTts?.mode === 'openai-compatible' ? 'OpenAI-compatible' : '系统语音'

  return [
    {
      id: 'pi',
      label: 'Agent Runtime',
      status: hasAgentProvider ? 'ready' : 'needs-setup',
      detail: hasAgentProvider ? `已连接 ${agentLabel}` : '等待模型 Provider 配置'
    },
    {
      id: 'browser',
      label: 'Browser Use',
      status: 'ready',
      detail: 'Browser Use 0.13.7 · Headless 独立 Profile · Agent MCP'
    },
    {
      id: 'computer',
      label: 'Computer Use',
      status: screenAccess === 'granted' && accessibilityAccess ? 'ready' : 'needs-setup',
      detail:
        screenAccess === 'granted' && accessibilityAccess
          ? 'CUA Driver 0.19.0 · Embedded MCP · 后台窗口操作'
          : `屏幕录制：${screenAccess} · 辅助功能：${accessibilityAccess ? '已授权' : '未授权'}`
    },
    {
      id: 'codex',
      label: 'Codex',
      status: codex.available ? 'ready' : 'needs-setup',
      detail: codex.available ? codex.version ?? 'CLI 已检测' : '未检测到 Codex CLI'
    },
    {
      id: 'claude',
      label: 'Claude',
      status: claude.available ? 'ready' : 'needs-setup',
      detail: claude.available ? claude.version ?? 'CLI 已检测' : '未检测到 Claude CLI'
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      status: opencode.available ? 'ready' : 'needs-setup',
      detail: opencode.available ? opencode.version ?? 'CLI 已检测' : '未检测到 OpenCode CLI'
    },
    {
      id: 'tts',
      label: 'TTS',
      status: hasTtsProvider ? 'ready' : 'needs-setup',
      detail: effectiveTts && hasTtsProvider
        ? `${ttsLabel} · ${effectiveTts.mode === 'system' ? '已就绪' : effectiveTts.model}${effectiveTts !== primaryTts ? ' · Backup 可用' : providerSettings?.tts.backupEnabled ? ' · Backup 已启用' : ''}`
        : primaryTts ? `${ttsLabel} 尚未配置 API Key` : '系统中文语音已就绪；云端高质量语音可选'
    }
  ]
}
