import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentRun, AgentRunMessage } from '../../../shared/contracts'
import { createTestDatabase } from '../../test-support/project-fixtures'

function run(id: string, provider: AgentRun['provider'], createdAt: string): AgentRun {
  return {
    id,
    projectId: 'vows',
    provider,
    title: id,
    status: 'idle',
    sessionId: null,
    workingDirectory: null,
    startedAt: createdAt,
    completedAt: createdAt,
    summary: '',
    draftPrompt: null,
    createdAt,
    updatedAt: createdAt
  }
}

function reasoning(
  id: string,
  runId: string,
  segmentId: string,
  createdAt: string
): AgentRunMessage {
  return {
    id,
    runId,
    role: 'assistant',
    content: id,
    eventType: 'reasoning',
    toolName: null,
    metadata: { segmentId },
    createdAt
  }
}

describe('RunRepository reasoning visibility', () => {
  it('filters persisted Codex summaries while preserving commentary and other providers', () => {
    const root = mkdtempSync(join(tmpdir(), 'project-agent-run-repository-'))
    const database = createTestDatabase(join(root, 'app.sqlite'))
    const createdAt = '2026-08-14T00:00:00.000Z'
    try {
      database.createAgentRun(run('codex-run', 'codex', createdAt))
      database.createAgentRun(run('claude-run', 'claude', createdAt))
      database.createAgentRunMessage(reasoning('codex-summary', 'codex-run', 'reasoning-1:summary:0', createdAt))
      database.createAgentRunMessage(reasoning('codex-commentary', 'codex-run', 'visible-thinking-0', createdAt))
      database.createAgentRunMessage(reasoning('claude-summary', 'claude-run', 'reasoning-1:summary:0', createdAt))

      expect(database.listAgentRunMessages('codex-run').map((message) => message.id))
        .toEqual(['codex-commentary'])
      expect(database.getAgentRunDetail('codex-run').messages.map((message) => message.id))
        .toEqual(['codex-commentary'])
      expect(database.getCompanionChatPage('agent', 'codex-run').records.flatMap((record) =>
        record.agentMessages.map((message) => message.id)
      )).toEqual(['codex-commentary'])
      expect(database.listAgentRunMessages('claude-run').map((message) => message.id))
        .toEqual(['claude-summary'])
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
