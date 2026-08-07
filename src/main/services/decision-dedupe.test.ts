import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DecisionItem } from '../../shared/contracts'
import { AppDatabase } from './database'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function signal(id: string, summary: string): DecisionItem {
  return {
    id,
    projectId: 'roombase',
    dedupeKey: 'roombase:onboarding:waiting-platform',
    kind: 'risk',
    title: 'Roombase 有长期等待平台处理的入驻事项',
    summary,
    impact: '影响商家上线',
    urgency: 'high',
    confidence: 1,
    suggestedActions: ['跟进最老事项'],
    evidenceRefs: [],
    status: 'inbox',
    source: '每日项目总结',
    createdAt: '2026-08-07T01:00:00.000Z'
  }
}

describe('open decision signal dedupe', () => {
  it('updates and resolves one persistent item instead of creating daily duplicates', () => {
    const directory = mkdtempSync(join(tmpdir(), 'project-agent-decision-'))
    directories.push(directory)
    const database = new AppDatabase(join(directory, 'test.sqlite'))

    const first = database.applyDecisionInspection({
      projectId: 'roombase',
      dedupeKey: 'roombase:onboarding:waiting-platform',
      observationKey: '2026-08-05:onboarding',
      state: 'active',
      observedAt: '2026-08-06T01:00:00.000Z',
      summary: '第一天等待',
      evidenceRefs: [],
      decision: signal('signal-day-1', '第一天等待')
    })
    const second = database.applyDecisionInspection({
      projectId: 'roombase',
      dedupeKey: 'roombase:onboarding:waiting-platform',
      observationKey: '2026-08-06:onboarding',
      state: 'active',
      observedAt: '2026-08-07T01:00:00.000Z',
      summary: '第二天仍在等待',
      evidenceRefs: [],
      decision: signal('signal-day-2', '第二天仍在等待')
    })

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.updated).toBe(true)
    expect(second.decision?.id).toBe('signal-day-1')
    expect(second.decision?.summary).toBe('第二天仍在等待')
    expect(second.decision?.occurrenceCount).toBe(2)
    expect(database.listDecisions().filter((item) => item.title === second.decision?.title)).toHaveLength(1)

    const resolved = database.applyDecisionInspection({
      projectId: 'roombase',
      dedupeKey: 'roombase:onboarding:waiting-platform',
      observationKey: '2026-08-07:onboarding:resolved',
      state: 'resolved',
      observedAt: '2026-08-08T01:00:00.000Z',
      summary: '已经没有等待平台处理的事项。',
      evidenceRefs: []
    })
    expect(resolved.resolved).toBe(true)
    expect(resolved.decision?.status).toBe('resolved')
    expect(resolved.decision?.resolutionSummary).toBe('已经没有等待平台处理的事项。')
    expect(database.listDecisions()).toHaveLength(1)

    database.close()
  })
})
