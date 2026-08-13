import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentRun, AgentSessionUpdate } from '../../shared/contracts'
import { AppDatabase } from './database'
import { createTestDatabase } from '../test-support/project-fixtures'
import { GoalTrackingService } from './goal-tracking'
import type { AgentRuntime } from './pi-runtime'

class StubRuntime implements AgentRuntime {
  private index = 0

  constructor(private readonly responses: string[]) {}

  isConfigured(): boolean {
    return true
  }

  async run(): Promise<string> {
    return this.responses[this.index++] ?? '{}'
  }

  async runStream(
    _prompt: string,
    _onUpdate: (update: AgentSessionUpdate) => void
  ): Promise<string> {
    return this.run()
  }
}

describe('GoalTrackingService', () => {
  const directories: string[] = []

  afterEach(() => {
    directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
  })

  it('creates a structured goal and records an evidence check-in', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'project-agent-goal-'))
    directories.push(directory)
    const database = createTestDatabase(join(directory, 'test.sqlite'))
    const runtime = new StubRuntime([
      JSON.stringify({
        title: '让获客实验产生稳定线索',
        description: '建立基线并验证第一个渠道。',
        metric: { label: '有效线索', unit: '个/周', baseline: 0, current: 0, target: 10 },
        monitoringSources: ['渠道投放'],
        milestones: [{ title: '建立获客基线', dueAt: null }, { title: '完成首轮渠道实验', dueAt: null }]
      }),
      JSON.stringify({
        status: 'at-risk',
        progress: 0.25,
        currentValue: 2.5,
        confidence: 0.8,
        summary: '首轮渠道实验进度低于预期，需要确认渠道与素材。',
        milestoneUpdates: [{ title: '建立获客基线', status: 'completed' }]
      }),
      JSON.stringify({
        status: 'active',
        progress: 0.4,
        currentValue: 4,
        confidence: 0.85,
        summary: '最新 Connector 证据确认阻塞已经解除，渠道实验恢复推进。',
        milestoneUpdates: []
      })
    ])
    const service = new GoalTrackingService(database, runtime)

    const goal = await service.createFromPrompt('roombase', '四周内跑通一个稳定获客渠道')
    expect(goal.title).toBe('让获客实验产生稳定线索')
    expect(goal.priority).toBe('P0')
    expect(goal.status).toBe('active')
    expect(goal.metric.target).toBe(10)
    expect(goal.milestones).toHaveLength(2)
    expect(goal.checkIns).toHaveLength(1)

    const result = await service.check(goal.id)
    expect(result.goal.status).toBe('at-risk')
    expect(result.goal.progress).toBe(0.25)
    expect(result.goal.metric.current).toBe(2.5)
    expect(result.goal.milestones[0].status).toBe('completed')
    expect(result.goal.checkIns).toHaveLength(2)
    expect(result.createdSignal?.goalId).toBe(goal.id)
    expect(database.listDecisions().some((item) => item.goalId === goal.id)).toBe(true)

    const recovered = await service.check(goal.id)
    expect(recovered.goal.status).toBe('active')
    expect(recovered.message).toContain('标记为已完成')
    const goalSignals = database.listDecisions().filter((item) => item.goalId === goal.id)
    expect(goalSignals).toHaveLength(1)
    expect(goalSignals[0].status).toBe('resolved')
    expect(goalSignals[0].resolutionSummary).toContain('风险解除')
    database.close()
  })

  it('manually completes and deletes milestones while preserving linked Runs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'project-agent-milestone-actions-'))
    directories.push(directory)
    const database = createTestDatabase(join(directory, 'test.sqlite'))
    const runtime = new StubRuntime([JSON.stringify({
      title: '建立内容发布体系',
      description: '完成首轮内容生产与发布。',
      metric: { label: '发布体系', unit: '', baseline: null, current: null, target: null },
      monitoringSources: [],
      milestones: [{ title: '准备品牌资料', dueAt: null }, { title: '发布首批内容', dueAt: null }]
    })])
    const goal = await new GoalTrackingService(database, runtime).createFromPrompt('vows', '建立内容发布体系')

    const completed = database.completeGoalMilestone(goal.id, goal.milestones[0].id)
    expect(completed.milestones[0].status).toBe('completed')
    expect(completed.milestones[0].completedAt).not.toBeNull()
    expect(completed.progress).toBe(0.5)

    const linkedMilestone = completed.milestones[1]
    const now = new Date().toISOString()
    const run: AgentRun = {
      id: 'run-linked-to-deleted-milestone',
      projectId: goal.projectId,
      decisionId: null,
      goalId: goal.id,
      milestoneId: linkedMilestone.id,
      provider: 'codex',
      title: linkedMilestone.title,
      status: 'draft',
      sessionId: null,
      workingDirectory: '/tmp',
      startedAt: null,
      completedAt: null,
      summary: '等待首次消息',
      draftPrompt: null,
      createdAt: now,
      updatedAt: now
    }
    database.createAgentRun(run)

    const afterDelete = database.deleteGoalMilestone(goal.id, linkedMilestone.id)
    expect(afterDelete.milestones.map((milestone) => milestone.id)).toEqual([completed.milestones[0].id])
    expect(afterDelete.progress).toBe(1)
    expect(database.getAgentRun(run.id).milestoneId).toBeNull()
    database.close()
  })
})
