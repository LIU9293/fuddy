import type { AgentTurnSettledPayload } from '../../shared/companion-sync'

export interface AgentRunNotificationContent {
  id: string
  groupId: string
  title: string
  body: string
}

function concise(value: string, maximumLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maximumLength) return normalized
  return `${normalized.slice(0, maximumLength).trimEnd()}…`
}

export function agentRunNotificationContent(turn: AgentTurnSettledPayload): AgentRunNotificationContent {
  return {
    id: `agent-turn-${turn.turnId}`,
    groupId: `agent-run-${turn.runId}`,
    title: turn.outcome === 'completed' ? 'Agent Run 已完成' : 'Agent Run 执行失败',
    body: concise(turn.outcome === 'failed' && turn.summary ? `${turn.title}：${turn.summary}` : turn.title, 120)
  }
}
