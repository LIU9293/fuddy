import { describe, expect, it } from 'vitest'
import { agentRunNotificationContent } from './agent-run-notifications'

describe('Agent Run notifications', () => {
  it('builds a stable notification for a completed turn', () => {
    expect(agentRunNotificationContent({
      runId: 'run-1',
      turnId: 'turn-1',
      title: '整理产品数据',
      outcome: 'completed',
      summary: '已完成。',
      settledAt: '2026-08-12T12:00:00.000Z'
    })).toEqual({
      id: 'agent-turn-turn-1',
      groupId: 'agent-run-run-1',
      title: 'Agent Run 已完成',
      body: '整理产品数据'
    })
  })

  it('includes a concise failure reason', () => {
    const content = agentRunNotificationContent({
      runId: 'run-1',
      turnId: 'turn-2',
      title: '发布内容',
      outcome: 'failed',
      summary: `连接失败 ${'x'.repeat(200)}`,
      settledAt: '2026-08-12T12:00:00.000Z'
    })
    expect(content.title).toBe('Agent Run 执行失败')
    expect(content.body.length).toBeLessThanOrEqual(121)
    expect(content.body).toMatch(/^发布内容：连接失败/)
  })
})
