import type {
  AgentTurnSettledPayload,
  CompanionSyncEvent
} from '../../../src/shared/companion-sync'

const notificationBodyMaximumLength = 120

function normalizedText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function truncatedText(value: string, maximumLength = notificationBodyMaximumLength): string {
  const normalized = normalizedText(value)
  if (normalized.length <= maximumLength) return normalized
  return `${normalized.slice(0, maximumLength - 1).trimEnd()}…`
}

export function agentTurnSettledPayload(event: CompanionSyncEvent): AgentTurnSettledPayload | null {
  if (event.type !== 'agent-turn.settled' || event.entityType !== 'agent-run') return null
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return null
  const payload = event.payload as Partial<AgentTurnSettledPayload>
  if (
    typeof payload.runId !== 'string'
    || payload.runId !== event.entityId
    || typeof payload.turnId !== 'string'
    || typeof payload.title !== 'string'
    || (payload.outcome !== 'completed' && payload.outcome !== 'failed')
    || typeof payload.summary !== 'string'
    || typeof payload.settledAt !== 'string'
  ) return null
  return payload as AgentTurnSettledPayload
}

export function agentTurnAlertRequest(event: CompanionSyncEvent): {
  collapseId: string
  body: Record<string, unknown>
} | null {
  const payload = agentTurnSettledPayload(event)
  if (!payload) return null
  const fallbackBody = payload.outcome === 'completed' ? 'Agent Run 已完成' : 'Agent Run 执行失败'
  return {
    collapseId: `agent-turn-${payload.turnId}`.slice(0, 64),
    body: {
      aps: {
        alert: {
          title: fallbackBody,
          body: truncatedText(payload.title) || fallbackBody
        },
        sound: 'default',
        'content-available': 1
      },
      sequence: event.sequence,
      runId: payload.runId,
      turnId: payload.turnId
    }
  }
}
