import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionUpdate } from '../../shared/contracts'
import { AppDatabase } from './database'
import { GoalTrackingService } from './goal-tracking'
import type { AgentRuntime } from './pi-runtime'
import { mightRequestWorkspaceAction, WorkspaceAgentActions } from './workspace-agent-actions'
import { WorkspaceFilesService } from './workspace-files'
import { ProjectInspectionService } from './project-inspection'
import { TaskDispatcher } from './task-dispatcher'
import type { PiTaskHarness } from './pi-task-harness'
import type { CliAgentRuntime } from './cli-agent-runtime'

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

  it('creates a linked draft Run without sending, inspects project files, and archives the Run on request', async () => {
    const store = database()
    const root = directories.at(-1)!
    const vows = store.listProjects().find((project) => project.id === 'vows')!
    store.updateProject({
      ...vows,
      profile: {
        ...vows.profile,
        repoPath: root,
        workspaceRoots: [{ id: 'primary', label: 'Vows', path: root }],
        primaryWorkspaceRootId: 'primary'
      }
    })
    const runtime = new SequenceRuntime([
      JSON.stringify({ actions: [{
        type: 'create_agent_run',
        projectId: 'vows',
        goalId: null,
        milestoneId: null,
        title: 'Vows 社交媒体账号 Setup',
        draftPrompt: '检查现有 Logo 并整理小红书和抖音资料。'
      }] }),
      JSON.stringify({ actions: [{ type: 'inspect_project', projectId: 'vows', query: 'social account setup' }] }),
      JSON.stringify({ actions: [{ type: 'archive_agent_run', runId: 'placeholder' }] })
    ])
    const files = new WorkspaceFilesService(store, join(root, 'files'))
    files.write('vows', 'marketing/social-account-setup.md', '# 社交媒体资料')
    const dispatcher = new TaskDispatcher(
      store,
      {} as PiTaskHarness,
      files,
      {} as CliAgentRuntime
    )
    const actions = new WorkspaceAgentActions(
      store,
      runtime,
      new GoalTrackingService(store, runtime),
      dispatcher,
      new ProjectInspectionService(store, files)
    )

    const created = await actions.tryExecuteDetailed('为 Vows 创建一个 Agent Run，但先不要执行')
    expect(created?.proposals).toHaveLength(1)
    expect(store.listRuns()).toHaveLength(0)
    const assistantMessage = store.createBriefingMessage({
      id: 'assistant-create-run',
      briefingId: null,
      role: 'assistant',
      content: created!.content,
      attachments: [],
      taskContext: null,
      actions: created!.proposals,
      createdAt: new Date().toISOString()
    })
    const proposal = created!.proposals[0]
    const executed = actions.executeProposal({
      messageId: assistantMessage.id,
      proposalId: proposal.id,
      optionId: proposal.options[0].id
    })
    const runId = executed.navigation?.kind === 'agent-run' ? executed.navigation.id : null
    expect(runId).toBeTruthy()
    expect(store.getAgentRunDetail(runId!).run).toMatchObject({ status: 'draft', draftPrompt: expect.stringContaining('Logo') })
    expect(store.getAgentRunDetail(runId!).messages).toEqual([])

    const inspected = await actions.tryExecuteDetailed('在 Vows 项目文件里找 social account setup')
    expect(inspected?.requiresSynthesis).toBe(true)
    expect(inspected?.toolContext).toContain('marketing/social-account-setup.md')

    const archiveRuntime = new SequenceRuntime([
      JSON.stringify({ actions: [{ type: 'archive_agent_run', runId }] })
    ])
    const archiveActions = new WorkspaceAgentActions(
      store,
      archiveRuntime,
      new GoalTrackingService(store, archiveRuntime),
      dispatcher,
      new ProjectInspectionService(store, files)
    )
    const archived = await archiveActions.tryExecuteDetailed('删除这个 Agent Run')
    expect(archived?.content).toContain('已归档')
    expect(store.listRuns().some((run) => run.id === runId)).toBe(false)
    store.close()
  })

  it('offers the existing Ticket Run for a PR instead of creating a duplicate', async () => {
    const store = database()
    const root = directories.at(-1)!
    const project = store.listProjects().find((item) => item.id === 'roombase')!
    store.updateProject({
      ...project,
      profile: {
        ...project.profile,
        repoPath: root,
        workspaceRoots: [{ id: 'primary', label: 'shopmy', path: root }],
        primaryWorkspaceRootId: 'primary'
      }
    })
    const decision = store.createDecision({
      projectId: 'roombase',
      title: '平台入驻轮询需要修复',
      summary: 'PR #352 正在处理 Review 意见。'
    })
    const now = new Date().toISOString()
    store.upsertDecisionRemediation({
      id: 'remediation-pr-352',
      decisionId: decision.id,
      sourceType: 'github-pr',
      sourceRef: 'https://github.com/example/shopmy/pull/352',
      state: 'review_required',
      summary: 'PR #352 有 Review 意见',
      nextAction: '处理 Review',
      evidenceRefs: [],
      metadata: {},
      firstSeenAt: now,
      lastSeenAt: now
    })
    const files = new WorkspaceFilesService(store, join(root, 'files'))
    const dispatcher = new TaskDispatcher(store, {} as PiTaskHarness, files, {} as CliAgentRuntime)
    const existing = dispatcher.createDraft({
      projectId: 'roombase',
      decisionId: decision.id,
      provider: 'claude',
      title: '处理 · 平台入驻轮询',
      draftPrompt: '检查 PR #352'
    })
    const runtime = new SequenceRuntime([], false)
    const actions = new WorkspaceAgentActions(store, runtime, new GoalTrackingService(store, runtime), dispatcher)

    const result = await actions.tryExecuteDetailed('来处理 PR 352 的问题')

    expect(result?.proposals).toEqual([])
    expect(result?.linkedRunId).toBe(existing.run.id)
    expect(result?.content).toContain('通过下方链接直接回到这个 Run')
    expect(store.listDecisions().find((item) => item.id === decision.id)?.status).toBe('inbox')

    const legacyProposal = {
      id: 'legacy-open-proposal',
      title: '继续已有 Agent Run',
      description: '旧版本打开 Action',
      status: 'pending' as const,
      context: null,
      options: [{
        id: `open-${existing.run.id}`,
        label: '继续这个 Run',
        style: 'primary' as const,
        capability: 'agent-run.open' as const,
        payload: { runId: existing.run.id, decisionId: decision.id, draftPrompt: '继续处理 PR #352' }
      }],
      acceptedOptionId: null,
      createdAt: now,
      resolvedAt: null
    }
    const message = store.createBriefingMessage({
      id: 'assistant-open-pr-run', briefingId: null, role: 'assistant', content: result!.content,
      attachments: [], taskContext: null, actions: [legacyProposal], createdAt: now
    })
    const opened = actions.executeProposal({ messageId: message.id, proposalId: legacyProposal.id, optionId: legacyProposal.options[0].id })
    expect(opened.navigation).toMatchObject({ kind: 'agent-run', id: existing.run.id })
    expect(opened.navigation).toMatchObject({ draftPrompt: null })
    expect(opened.message.actions?.[0]).toMatchObject({ status: 'pending', acceptedOptionId: null })
    expect(store.listDecisions().find((item) => item.id === decision.id)?.status).toBe('inbox')
    expect(store.listRuns()).toHaveLength(1)
    store.close()
  })

  it('creates a project only after its proposed action is confirmed', async () => {
    const store = database()
    const runtime = new SequenceRuntime([JSON.stringify({ actions: [{
      type: 'create_project',
      input: {
        name: 'Launch Notes',
        summary: '发布内容与反馈项目',
        focus: 'Launch / Feedback',
        mission: '持续整理发布与用户反馈',
        vision: '形成可靠的发布学习闭环',
        productType: '运营项目',
        stage: '准备中',
        workspacePath: null,
        defaultAgent: 'codex'
      }
    }] })])
    const actions = new WorkspaceAgentActions(store, runtime, new GoalTrackingService(store, runtime))
    const result = await actions.tryExecuteDetailed('新建一个 Launch Notes 项目')
    expect(store.listProjects().some((item) => item.name === 'Launch Notes')).toBe(false)
    const message = store.createBriefingMessage({
      id: 'assistant-create-project', briefingId: null, role: 'assistant', content: result!.content,
      attachments: [], taskContext: null, actions: result!.proposals, createdAt: new Date().toISOString()
    })
    const proposal = result!.proposals[0]
    const executed = actions.executeProposal({ messageId: message.id, proposalId: proposal.id, optionId: proposal.options[0].id })
    expect(executed.navigation?.kind).toBe('project')
    expect(store.listProjects().some((item) => item.name === 'Launch Notes')).toBe(true)
    store.close()
  })
})
