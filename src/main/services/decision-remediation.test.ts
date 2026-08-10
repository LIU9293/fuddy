import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRun, DecisionItem } from '../../shared/contracts'
import { AppDatabase } from './database'
import {
  DecisionRemediationService,
  extractGithubPullRequestUrls,
  type GithubPullRequestSnapshot
} from './decision-remediation'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function decision(): DecisionItem {
  return {
    id: 'decision-onboarding',
    projectId: 'roombase',
    dedupeKey: 'roombase:onboarding:waiting-platform',
    kind: 'risk',
    title: 'Roombase 有长期等待平台处理的入驻事项',
    summary: '生产仍有 4 个小程序入驻等待平台处理。',
    impact: '影响商户上线',
    urgency: 'high',
    confidence: 1,
    suggestedActions: ['检查最老事项'],
    evidenceRefs: [],
    status: 'inbox',
    source: '每日项目总结',
    createdAt: '2026-08-06T01:00:00.000Z'
  }
}

function linkedRun(): AgentRun {
  return {
    id: 'run-onboarding',
    projectId: 'roombase',
    decisionId: 'decision-onboarding',
    goalId: null,
    milestoneId: null,
    provider: 'codex',
    title: '处理 · Roombase 有长期等待平台处理的入驻事项',
    status: 'idle',
    sessionId: 'session-onboarding',
    workingDirectory: '/tmp/roombase',
    startedAt: '2026-08-08T13:42:35.268Z',
    completedAt: null,
    summary: '修复已经提交到 PR #351。',
    draftPrompt: null,
    createdAt: '2026-08-08T13:42:35.268Z',
    updatedAt: '2026-08-08T16:37:05.923Z'
  }
}

describe('decision remediation patrol', () => {
  it('extracts canonical GitHub pull request URLs without duplicates', () => {
    expect(extractGithubPullRequestUrls([
      '查看 https://github.com/LIU9293/shopmy/pull/351',
      '重复 https://github.com/LIU9293/shopmy/pull/351',
      '忽略 https://example.com/repo/pull/1'
    ].join('\n'))).toEqual(['https://github.com/LIU9293/shopmy/pull/351'])
  })

  it('links a Run PR to its decision and uses live Review state as the next gate', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'project-agent-remediation-'))
    directories.push(directory)
    const database = new AppDatabase(join(directory, 'test.sqlite'))
    database.applyDecisionInspection({
      projectId: 'roombase',
      dedupeKey: 'roombase:onboarding:waiting-platform',
      observationKey: 'roombase:2026-08-08:onboarding',
      state: 'active',
      observedAt: '2026-08-09T00:59:59.896Z',
      summary: decision().summary,
      evidenceRefs: [],
      decision: decision()
    })
    database.createAgentRun(linkedRun())
    database.createAgentRunMessage({
      id: 'message-pr',
      runId: 'run-onboarding',
      role: 'assistant',
      content: '修复主体已经完成：https://github.com/LIU9293/shopmy/pull/351',
      eventType: null,
      toolName: null,
      metadata: null,
      createdAt: '2026-08-08T16:37:05.923Z'
    })
    const snapshot: GithubPullRequestSnapshot = {
      owner: 'LIU9293',
      repository: 'shopmy',
      number: 351,
      url: 'https://github.com/LIU9293/shopmy/pull/351',
      title: '商户号开通后直接结束小程序入驻流程',
      state: 'OPEN',
      isDraft: false,
      mergedAt: null,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      headSha: '6fc4e6ce',
      checks: 'passing',
      unresolvedReviewThreads: 2
    }
    const inspect = vi.fn(async () => snapshot)

    const result = await new DecisionRemediationService(database, inspect).sync('roombase')

    expect(result.errors).toEqual([])
    expect(inspect).toHaveBeenCalledOnce()
    expect(result.remediations).toHaveLength(1)
    expect(result.remediations[0]).toMatchObject({
      decisionId: 'decision-onboarding',
      sourceRef: snapshot.url,
      state: 'review_required'
    })
    expect(result.remediations[0].summary).toContain('2 条当前 Review 意见')
    expect(result.remediations[0].nextAction).toContain('处理 PR #351')
    expect(database.listDecisions()[0].status).toBe('in_progress')
    expect(database.listDecisions()[0].statusSummary).toContain('2 条当前 Review 意见')
    database.close()
  })

  it('waits for deployment instead of completing the decision when its linked PR is merged', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'project-agent-remediation-merged-'))
    directories.push(directory)
    const database = new AppDatabase(join(directory, 'test.sqlite'))
    database.applyDecisionInspection({
      projectId: 'roombase',
      dedupeKey: 'roombase:onboarding:waiting-platform',
      observationKey: 'roombase:2026-08-08:onboarding',
      state: 'active',
      observedAt: '2026-08-09T00:59:59.896Z',
      summary: decision().summary,
      evidenceRefs: [],
      decision: decision()
    })
    database.createAgentRun(linkedRun())
    database.createAgentRunMessage({
      id: 'message-pr-merged',
      runId: 'run-onboarding',
      role: 'assistant',
      content: '已合并：https://github.com/LIU9293/shopmy/pull/351',
      eventType: null,
      toolName: null,
      metadata: null,
      createdAt: linkedRun().updatedAt
    })
    const snapshot: GithubPullRequestSnapshot = {
      owner: 'LIU9293',
      repository: 'shopmy',
      number: 351,
      url: 'https://github.com/LIU9293/shopmy/pull/351',
      title: '商户号开通后直接结束小程序入驻流程',
      state: 'MERGED',
      isDraft: false,
      mergedAt: '2026-08-09T10:00:00.000Z',
      mergeable: 'UNKNOWN',
      mergeStateStatus: 'UNKNOWN',
      headSha: 'merged-sha',
      checks: 'passing',
      unresolvedReviewThreads: 0
    }
    const service = new DecisionRemediationService(database, async () => snapshot)

    await service.sync('roombase')
    const waiting = database.listDecisions()[0]
    expect(waiting.status).toBe('waiting')
    expect(waiting.waitingReason).toBe('deployment')
    expect(waiting.resolvedAt).toBeNull()
    expect(waiting.statusSummary).toContain('等待进入生产')
    expect(waiting.evidenceRefs).toContainEqual({ label: 'GitHub PR #351', uri: snapshot.url })

    const offlineResult = await new DecisionRemediationService(database, async () => {
      throw new Error('offline')
    }).sync('roombase')
    expect(offlineResult.errors[0]).toContain('offline')
    expect(database.listDecisions()[0].status).toBe('waiting')
    database.close()
  })

  it('keeps the last verified remediation when GitHub is temporarily unavailable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'project-agent-remediation-error-'))
    directories.push(directory)
    const database = new AppDatabase(join(directory, 'test.sqlite'))
    database.applyDecisionInspection({
      projectId: 'roombase',
      dedupeKey: 'roombase:onboarding:waiting-platform',
      observationKey: 'roombase:2026-08-08:onboarding',
      state: 'active',
      observedAt: '2026-08-09T00:59:59.896Z',
      summary: decision().summary,
      evidenceRefs: [],
      decision: decision()
    })
    database.createAgentRun(linkedRun())
    database.createAgentRunMessage({
      id: 'message-pr',
      runId: 'run-onboarding',
      role: 'assistant',
      content: 'https://github.com/LIU9293/shopmy/pull/351',
      eventType: null,
      toolName: null,
      metadata: null,
      createdAt: linkedRun().updatedAt
    })
    const first = new DecisionRemediationService(database, async (reference) => ({
      ...reference,
      title: '修复',
      state: 'OPEN',
      isDraft: false,
      mergedAt: null,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      headSha: 'abc',
      checks: 'passing',
      unresolvedReviewThreads: 0
    }))
    await first.sync('roombase')
    const failing = new DecisionRemediationService(database, async () => {
      throw new Error('offline')
    })

    const result = await failing.sync('roombase')

    expect(result.errors[0]).toContain('offline')
    expect(result.remediations[0].state).toBe('ready_to_merge')
    database.close()
  })
})
