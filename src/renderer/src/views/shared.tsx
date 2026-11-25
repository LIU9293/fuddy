import {
  Bot,
  Headphones,
  Settings2,
  ShieldCheck
} from 'lucide-react'
import { useEffect, useRef } from 'react'
import type {
  AgentRun,
  ConnectorInstance
} from '../../../shared/contracts'

export type Navigation = 'briefing' | 'project' | 'projects' | 'shared-projects' | 'files' | 'runs' | 'automations' | 'settings'
export type ProjectSection = 'status' | 'goals' | 'settings'
export type SidebarSelection = Exclude<Navigation, 'project' | 'settings'>
export type SettingsSection = 'general' | 'models' | 'voice' | 'connectors' | 'permissions'

export const settingsSectionTitles: Record<SettingsSection, string> = {
  general: '通用',
  models: '模型',
  voice: '语音与 TTS',
  connectors: '连接器',
  permissions: '权限与安全'
}

export const settingsNavigationItems = [
  { id: 'general', label: '通用', icon: Settings2 },
  { id: 'models', label: '模型', icon: Bot },
  { id: 'voice', label: '语音与 TTS', icon: Headphones },
  { id: 'permissions', label: '权限与安全', icon: ShieldCheck }
] satisfies Array<{ id: Exclude<SettingsSection, 'connectors'>; label: string; icon: typeof Settings2 }>

export const connectorStatusLabels: Record<ConnectorInstance['status'], string> = {
  connected: '已连接',
  'needs-setup': '等待首次巡检',
  running: '巡检中',
  error: '需要处理',
  disabled: '已停用'
}

export const agentRunStatusLabels: Record<AgentRun['status'], string> = {
  draft: '草稿',
  queued: '等待中',
  running: '运行中',
  completed: '已完成',
  idle: '已完成',
  failed: '失败',
  cancelled: '已取消'
}

export function formatRelativeTime(value: string): string {
  const diffMinutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000))
  if (diffMinutes < 1) return '刚刚'
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`
  const hours = Math.round(diffMinutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

export function formatExpiryLabel(value: string): string {
  const diffMinutes = Math.ceil((new Date(value).getTime() - Date.now()) / 60_000)
  if (diffMinutes <= 0) return '二维码已经失效'
  if (diffMinutes < 60) return `二维码将在 ${diffMinutes} 分钟后失效`
  const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
  return `二维码将在 ${time} 失效`
}

export function useAutoDismissMessage(message: string | null | undefined, onDismiss: () => void, delay = 5_000): void {
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss
  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => onDismissRef.current(), delay)
    return () => window.clearTimeout(timer)
  }, [message, delay])
}
