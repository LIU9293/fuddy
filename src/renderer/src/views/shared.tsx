import {
  Bot,
  CircleAlert,
  CircleCheck,
  Headphones,
  Inbox,
  Lightbulb,
  Settings2,
  ShieldCheck,
  Sparkles
} from 'lucide-react'
import { useEffect, useRef } from 'react'
import type {
  CodingAgentProvider,
  ConnectorInstance,
  DecisionItem,
  DecisionKind,
  DecisionWaitingReason
} from '../../../shared/contracts'
import { agentProviderDefinitions, codingAgentProviders } from '../../../shared/agent-providers'

export type Navigation = 'briefing' | 'inbox' | 'projects' | 'files' | 'runs' | 'automations' | 'settings'
export type ProjectSection = 'inbox' | 'status' | 'goals' | 'settings'
export type SidebarSelection = 'briefing' | 'inbox' | 'projects' | 'files' | 'runs' | 'automations'
export type SettingsSection = 'general' | 'models' | 'voice' | 'connectors' | 'permissions'

export const decisionWaitingReasonLabels: Record<DecisionWaitingReason, string> = {
  deployment: '等待部署',
  verification: '等待验证',
  external: '等待外部处理',
  measurement: '等待指标',
  user: '等待用户',
  scheduled: '等待复查'
}

export const codingAgentOptions: Array<{ id: CodingAgentProvider; label: string }> = codingAgentProviders.map((id) => ({
  id,
  label: agentProviderDefinitions[id].label
}))

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

export const kindLabels: Record<DecisionKind, string> = {
  risk: '风险',
  opportunity: '机会',
  decision: '待决策',
  result: '结果',
  info: '信息'
}

export const kindIcons: Record<DecisionKind, typeof CircleAlert> = {
  risk: CircleAlert,
  opportunity: Lightbulb,
  decision: Sparkles,
  result: CircleCheck,
  info: Inbox
}

export const connectorStatusLabels: Record<ConnectorInstance['status'], string> = {
  connected: '已连接',
  'needs-setup': '等待首次巡检',
  running: '巡检中',
  error: '需要处理',
  disabled: '已停用'
}

export function formatRelativeTime(value: string): string {
  const diffMinutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000))
  if (diffMinutes < 1) return '刚刚'
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`
  const hours = Math.round(diffMinutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

export function formatDecisionSource(item: DecisionItem): string {
  const explicitDate = [item.source, ...item.evidenceRefs.map((evidence) => evidence.label)]
    .join(' ')
    .match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  const date = explicitDate
    ? `${explicitDate[1]}年${Number(explicitDate[2])}月${Number(explicitDate[3])}日`
    : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(
        new Date(item.lastSeenAt ?? item.createdAt)
      )
  const source = item.source.trim()
  if (/用户|手动/.test(source)) return `用户消息 · ${date}`
  if (/每日项目总结|每日巡检|巡检/.test(source)) return `${date}巡检`
  return source ? `${source} · ${date}` : date
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
