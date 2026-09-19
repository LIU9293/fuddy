import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentRun, AgentRunMessage } from '../../../shared/contracts'
import { createTestDatabase } from '../../test-support/project-fixtures'
import { DatabaseSync } from 'node:sqlite'
import { emptyAccountContext } from '../../services/agent-account-context'

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
  it('atomically binds an independent Codex session and imports history once across restarts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fuddy-codex-binding-'))
    const path = join(directory, 'app.sqlite')
    let database = createTestDatabase(path)
    try {
      const original = database.createAgentRun({ ...run('binding', 'codex', '2026-09-16T00:00:00Z'), sessionId: 'legacy' })
      expect(database.ownsCodexSession(original.id, 'legacy')).toBe(false)
      const message: AgentRunMessage = { id: 'imported', runId: original.id, role: 'user', content: '桌面历史',
        eventType: null, toolName: null, metadata: null, createdAt: '2026-09-16T00:18:00Z' }
      const ready = { sessionId: 'independent', sourceSessionId: 'legacy', messages: [message] }
      database.bindCodexSession(original.id, ready)
      database.close()
      database = createTestDatabase(path)
      database.bindCodexSession(original.id, ready)
      expect(database.ownsCodexSession(original.id, 'independent')).toBe(true)
      expect(database.ownsCodexSession(original.id, 'legacy')).toBe(false)
      expect(database.getAgentRunDetail(original.id).messages).toHaveLength(1)
      expect(database.getAgentRun(original.id).sessionId).toBe('independent')
      expect(() => database.bindCodexSession(original.id, { sessionId: 'bad', sourceSessionId: 'independent',
        messages: [{ ...message, id: 'new' }, { ...message, id: 'wrong', runId: 'another-run' }] })).toThrow('不属于')
      expect(database.getAgentRunDetail(original.id).messages).toHaveLength(1)
      expect(database.getAgentRun(original.id).sessionId).toBe('independent')
      expect(database.ownsCodexSession(original.id, 'independent')).toBe(true)
    } finally {
      database.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('upgrades version 9 and persists account metadata independently of stale turn updates', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fuddy-account-context-'))
    const path = join(directory, 'app.sqlite')
    let database = createTestDatabase(path)
    try {
      const original = database.createAgentRun(run('account-context', 'codex', '2026-09-09T00:00:00.000Z'))
      database.close()
      const legacy = new DatabaseSync(path)
      legacy.exec('ALTER TABLE agent_runs DROP COLUMN account_context_json; PRAGMA user_version = 9')
      legacy.close()
      database = createTestDatabase(path)
      expect(database.getAgentRun(original.id).accountContext).toBeNull()
      const context = { ...emptyAccountContext('codex'), authMode: 'subscription' as const, plan: 'pro', limits: [{ name: 'weekly', usedPercent: 20 }] }
      database.updateAgentRunAccountContext(original.id, context)
      database.updateAgentRun({ ...original, status: 'completed' })
      database.close()
      database = createTestDatabase(path)
      expect(database.getAgentRunDetail(original.id).run.accountContext).toEqual(context)
      database.updateAgentRunExecutionSettings(original.id, 'claude', null, null)
      expect(database.getAgentRun(original.id).accountContext).toBeNull()
    } finally {
      database.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
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
