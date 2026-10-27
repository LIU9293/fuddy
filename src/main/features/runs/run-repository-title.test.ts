import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { AgentRun } from '../../../shared/contracts'
import { createTestDatabase } from '../../test-support/project-fixtures'

function run(id: string): AgentRun {
  return { id, projectId: null, provider: 'codex', title: '新建 Chat', status: 'draft',
    sessionId: null, workingDirectory: null, startedAt: null, completedAt: null,
    draftPrompt: null, summary: '', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z' }
}

describe('Chat title persistence', () => {
  it('upgrades version 12 while protecting existing titles and persists automatic-title ownership across restarts', () => {
    const root = mkdtempSync(join(tmpdir(), 'fuddy-title-migration-'))
    const path = join(root, 'app.sqlite')
    let database = createTestDatabase(path)
    try {
      database.createAgentRun({ ...run('legacy'), title: '已有任务标题' })
      database.close()
      const legacy = new DatabaseSync(path)
      legacy.exec('ALTER TABLE agent_runs DROP COLUMN automatic_title; PRAGMA user_version = 12')
      legacy.close()
      database = createTestDatabase(path)
      expect(database.updateAutomaticAgentRunTitle('legacy', '自动标题').title).toBe('已有任务标题')
      const stale = database.createAgentRun(run('automatic'), true)
      database.updateAutomaticAgentRunTitle(stale.id, '自动标题')
      database.updateAgentRun({ ...stale, status: 'idle' })
      expect(database.getAgentRun(stale.id).title).toBe('自动标题')
      database.close()
      database = createTestDatabase(path)
      expect(database.updateAutomaticAgentRunTitle(stale.id, '更新后的自动标题').title).toBe('更新后的自动标题')
      database.renameAgentRun(stale.id, '新建 Chat')
      database.close()
      database = createTestDatabase(path)
      expect(database.updateAutomaticAgentRunTitle(stale.id, '不能覆盖').title).toBe('新建 Chat')
      expect(database.updateAutomaticAgentRunTitle(stale.id, '   ').title).toBe('新建 Chat')
    } finally { database.close(); rmSync(root, { recursive: true, force: true }) }
  })
})
