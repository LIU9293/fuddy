import { describe, expect, it } from 'vitest'
import type { CompanionSyncEvent } from '../../../src/shared/companion-sync'
import { agentTurnAlertRequest, agentTurnSettledPayload } from '../src/push-notifications'

function settledEvent(overrides: Partial<CompanionSyncEvent> = {}): CompanionSyncEvent {
  return {
    eventId: 'event-1',
    sequence: 42,
    protocolVersion: 1,
    type: 'agent-turn.settled',
    entityType: 'agent-run',
    entityId: 'run-1',
    revision: 1,
    payload: {
      runId: 'run-1',
      turnId: 'message-1',
      title: '分析本周的用户反馈',
      outcome: 'completed',
      summary: '完成',
      settledAt: '2026-08-12T05:00:00.000Z'
    },
    sourceDeviceId: 'mac-1',
    occurredAt: '2026-08-12T05:00:00.000Z',
    ...overrides
  }
}

describe('agent turn push notifications', () => {
  it('builds a visible APNs alert with stable routing metadata', () => {
    expect(agentTurnAlertRequest(settledEvent())).toEqual({
      collapseId: 'agent-turn-message-1',
      body: {
        aps: {
          alert: { title: 'Agent Run 已完成', body: '分析本周的用户反馈' },
          sound: 'default',
          'content-available': 1
        },
        sequence: 42,
        runId: 'run-1',
        turnId: 'message-1'
      }
    })
  })

  it('rejects malformed or mismatched terminal events', () => {
    expect(agentTurnSettledPayload(settledEvent({ entityId: 'another-run' }))).toBeNull()
    expect(agentTurnSettledPayload(settledEvent({ type: 'agent-run.updated' }))).toBeNull()
  })
})
