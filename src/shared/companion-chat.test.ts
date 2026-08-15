import { describe, expect, it } from 'vitest'
import type { AgentRunMessage, BriefingMessage, MorningBriefing } from './contracts'
import {
  buildAgentChatRecords,
  buildWorkAssistantChatRecords,
  paginateCompanionChatRecords,
  workAssistantChatId
} from './companion-chat'

function agentMessage(
  id: string,
  role: AgentRunMessage['role'],
  eventType: string | null,
  second: number
): AgentRunMessage {
  return {
    id,
    runId: 'run-1',
    role,
    content: id,
    eventType,
    toolName: role === 'tool' ? 'Read' : null,
    metadata: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString()
  }
}

function assistantMessage(index: number): BriefingMessage {
  return {
    id: `assistant-${index}`,
    briefingId: null,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
    attachments: [],
    taskContext: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString()
  }
}

describe('Companion chat records', () => {
  it('groups each Agent process into one stable presentation block', () => {
    const records = buildAgentChatRecords('run-1', [
      agentMessage('user-1', 'user', null, 0),
      agentMessage('reasoning-1', 'assistant', 'reasoning', 1),
      agentMessage('tool-1', 'tool', 'tool', 2),
      agentMessage('assistant-1', 'assistant', null, 3)
    ])

    expect(records.map((record) => [record.id, record.kind])).toEqual([
      ['agent-message-user-1', 'message'],
      ['process-reasoning-1', 'process'],
      ['agent-message-assistant-1', 'message']
    ])
    expect(records[1]).toMatchObject({
      completedAt: '2026-01-01T00:00:03.000Z',
      agentMessages: [{ id: 'reasoning-1' }, { id: 'tool-1' }]
    })
  })

  it('returns the newest 100 display blocks and a cursor for older history', () => {
    const records = buildWorkAssistantChatRecords(
      Array.from({ length: 125 }, (_, index) => assistantMessage(index)),
      []
    )
    const page = paginateCompanionChatRecords(workAssistantChatId, 'assistant', records)

    expect(page.records).toHaveLength(100)
    expect(page.records[0].assistantMessage?.id).toBe('assistant-25')
    expect(page.records.at(-1)?.assistantMessage?.id).toBe('assistant-124')
    expect(page).toMatchObject({ hasMore: true, nextBefore: 'assistant-message-assistant-25' })

    const older = paginateCompanionChatRecords(workAssistantChatId, 'assistant', records, {
      before: page.nextBefore,
      limit: 100
    })
    expect(older.records).toHaveLength(25)
    expect(older.hasMore).toBe(false)
  })

  it('merges completed morning briefings into the same ordered record stream', () => {
    const briefing: MorningBriefing = {
      id: 'briefing-1',
      reportDate: '2026-01-01',
      timezone: 'Asia/Shanghai',
      status: 'completed',
      headline: 'Daily',
      body: 'Body',
      narration: 'Narration',
      estimatedDurationSeconds: 60,
      sourceBriefingIds: [],
      signalIds: [],
      generatedAt: '2026-01-01T00:00:30.000Z',
      error: null,
      generation: 'agent'
    }
    const records = buildWorkAssistantChatRecords([assistantMessage(0), assistantMessage(1)], [briefing])

    expect(records.map((record) => record.kind)).toEqual(['message', 'briefing', 'message'])
  })
})
