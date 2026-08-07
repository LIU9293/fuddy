import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionUpdate } from '../../shared/contracts'
import { AppDatabase } from './database'
import { GoalTrackingService } from './goal-tracking'
import type { AgentRuntime } from './pi-runtime'
import { mightRequestWorkspaceAction, WorkspaceAgentActions } from './workspace-agent-actions'

class SequenceRuntime implements AgentRuntime {
  private index = 0

  constructor(private readonly responses: string[], private readonly configured = true) {}

  isConfigured(): boolean {
    return this.configured
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

describe('WorkspaceAgentActions', () => {
  const directories: string[] = []

  afterEach(() => {
    directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
  })

  function database(): AppDatabase {
    const directory = mkdtempSync(join(tmpdir(), 'workspace-actions-'))
    directories.push(directory)
    return new AppDatabase(join(directory, 'test.sqlite'))
  }

  it('does not mutate workspace for a question about goals', () => {
    expect(mightRequestWorkspaceAction('Vows 现在有什么目标？')).toBe(false)
    expect(mightRequestWorkspaceAction('请分析 Vows 并创建下一个目标')).toBe(true)
  })

  it('creates a goal through the deterministic route when the provider is unavailable', async () => {
    const store = database()
    const runtime = new SequenceRuntime([], false)
    const goals = new GoalTrackingService(store, runtime)
    const actions = new WorkspaceAgentActions(store, runtime, goals)

    const response = await actions.tryExecute('请分析 Vows 当前状态，并创建下一个目标')

    expect(response).toContain('已为 **Vows** 创建 P0 目标')
    expect(store.listGoals('vows')).toHaveLength(1)
    expect(store.listGoals('vows')[0].checkIns).toHaveLength(1)
    store.close()
  })

  it('lets the agent create and resolve an inbox item by id', async () => {
    const store = database()
    const runtime = new SequenceRuntime([
      JSON.stringify({
        actions: [{
          type: 'create_inbox',
          projectId: 'vows',
          goalId: null,
          title: '确认首个真实用户测试',
          summary: '需要决定测试对象和验收时间。'
        }]
      }),
      JSON.stringify({
        actions: [{
          type: 'update_inbox_status',
          decisionId: 'placeholder',
          status: 'resolved'
        }]
      })
    ])
    const goals = new GoalTrackingService(store, runtime)
    const actions = new WorkspaceAgentActions(store, runtime, goals)

    const created = await actions.tryExecute('把首个真实用户测试放进 Vows 收件箱')
    expect(created).toContain('投递到决策收件箱')
    const item = store.listDecisions()[0]

    const runtimeForResolve = new SequenceRuntime([
      JSON.stringify({
        actions: [{ type: 'update_inbox_status', decisionId: item.id, status: 'resolved' }]
      })
    ])
    const resolveActions = new WorkspaceAgentActions(
      store,
      runtimeForResolve,
      new GoalTrackingService(store, runtimeForResolve)
    )
    const resolved = await resolveActions.tryExecute('把这条收件箱事项标记完成')

    expect(resolved).toContain('已完成')
    expect(store.listDecisions()[0].status).toBe('resolved')
    store.close()
  })

  it('stores user-confirmed project state and creates a planned roadmap goal', async () => {
    const store = database()
    const runtime = new SequenceRuntime([
      JSON.stringify({
        actions: [
          {
            type: 'update_project_state',
            projectId: 'vows',
            summary: '婚礼 Event 创建流程已经打通，进入获客阶段。',
            facts: ['产品已经可以由用户正常使用', '用户自主创建婚礼 Event 的流程已打通']
          },
          {
            type: 'create_goal',
            projectId: 'vows',
            prompt: '优化婚礼模板并扩展升学宴、百日宴等场景',
            priority: 'P1',
            status: 'planned'
          }
        ]
      }),
      JSON.stringify({
        currentStateSummary: '用户确认婚礼 Event 创建流程已经打通。',
        title: '扩展婚礼及非婚礼活动模板供给',
        description: '优化现有婚礼模板，并建立升学宴、百日宴等新场景模板。',
        metric: { label: '可用活动场景', unit: '个', baseline: null, current: null, target: null },
        milestones: [{ title: '完成模板现状审计', dueAt: null }]
      })
    ])
    const actions = new WorkspaceAgentActions(store, runtime, new GoalTrackingService(store, runtime))

    const response = await actions.tryExecute('更新 Vows 项目现状，并把模板扩展作为 P1 Roadmap 目标')

    expect(response).toContain('用户确认项目现状')
    expect(response).toContain('P1 Roadmap')
    expect(store.listProjects().find((project) => project.id === 'vows')?.profile.currentState.source).toBe('user')
    expect(store.listGoals('vows')[0]).toMatchObject({ priority: 'P1', status: 'planned' })
    store.close()
  })
})
