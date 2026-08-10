import { describe, expect, it } from 'vitest'
import type { AgentRun, AgentRunArtifact, DecisionItem, DecisionRemediation, Project, ProjectGoal } from '../../shared/contracts'
import { buildProjectPulses } from './project-pulse'

function project(id: string, name: string, nextMove: string): Project {
  return {
    id,
    name,
    summary: '',
    focus: '',
    status: 'active',
    accent: '#000',
    profile: {
      productType: '',
      stage: '',
      mission: '',
      vision: '',
      repoPath: '',
      workspaceRoots: [],
      primaryWorkspaceRootId: null,
      defaultAgent: 'codex',
      websiteUrl: null,
      surfaces: [],
      focusAreas: [],
      dataSources: [],
      nextMoves: [nextMove],
      currentState: { summary: `${name} 当前现状`, facts: [], source: 'user', updatedAt: null }
    }
  }
}

const vowsGoal: ProjectGoal = {
  id: 'goal-vows-social',
  projectId: 'vows',
  title: '建立 Vows 的社交媒体获客与内容发布体系',
  description: '',
  status: 'active',
  priority: 'P0',
  metric: { label: '有效 Event 创建数', unit: '个', baseline: null, current: null, target: 10 },
  deadline: null,
  nextCheckInAt: '2026-08-13T00:00:00.000Z',
  progress: 0,
  confidence: 0.6,
  agentSummary: '目标已经建立，等待执行。',
  monitoringSources: [],
  milestones: [{
    id: 'milestone-1',
    goalId: 'goal-vows-social',
    title: '完成首批社交媒体账号 Setup 与统一品牌资料',
    status: 'pending',
    dueAt: null,
    evidenceRefs: [],
    sortOrder: 0,
    createdAt: '2026-08-06T09:00:00.000Z',
    updatedAt: '2026-08-06T09:00:00.000Z',
    completedAt: null
  }],
  checkIns: [],
  createdBy: 'user',
  createdAt: '2026-08-06T09:00:00.000Z',
  updatedAt: '2026-08-06T09:00:00.000Z',
  completedAt: null
}

const vowsRun: AgentRun = {
  id: 'run-vows',
  projectId: 'vows',
  goalId: vowsGoal.id,
  milestoneId: vowsGoal.milestones[0].id,
  provider: 'pi',
  title: 'Vows 社交媒体账号资料包',
  status: 'idle',
  sessionId: 'session-vows',
  workingDirectory: null,
  startedAt: '2026-08-06T12:00:00.000Z',
  completedAt: null,
  summary: '已生成第一版资料包。',
  draftPrompt: null,
  createdAt: '2026-08-06T12:00:00.000Z',
  updatedAt: '2026-08-06T13:00:00.000Z'
}

const artifact: AgentRunArtifact = {
  id: 'artifact-vows',
  runId: vowsRun.id,
  projectId: 'vows',
  relativePath: 'marketing/social-account-setup.md',
  label: 'social-account-setup.md',
  mimeType: 'text/markdown',
  createdAt: '2026-08-06T13:00:00.000Z'
}

const roombaseDecision: DecisionItem = {
  id: 'decision-roombase',
  projectId: 'roombase',
  kind: 'risk',
  title: 'Roombase 有长期等待平台处理的入驻事项',
  summary: '仍有入驻等待平台处理。',
  impact: '',
  urgency: 'high',
  confidence: 1,
  suggestedActions: ['跟进最老的一条入驻事项并记录平台工单号'],
  evidenceRefs: [],
  status: 'inbox',
  source: '每日项目总结',
  createdAt: '2026-08-06T01:00:00.000Z'
}

describe('project pulse', () => {
  it('turns goals, unresolved work, runs and artifacts into one next step per project', () => {
    const pulses = buildProjectPulses({
      projects: [
        project('roombase', 'Roombase', '建立获客漏斗基线'),
        project('vows', 'Vows', '接入现有营销 Agent'),
        project('ai-marketing', 'AI Marketing', '定义试点验收指标')
      ],
      goals: [vowsGoal],
      decisions: [roombaseDecision],
      runs: [vowsRun],
      artifacts: [artifact],
      projectBriefings: [],
      reportDate: '2026-08-06',
      generatedAt: '2026-08-07T01:00:00.000Z',
      executionWindowStartAt: '2026-08-06T01:00:00.000Z'
    })

    const roombase = pulses.find((pulse) => pulse.projectId === 'roombase')
    const vows = pulses.find((pulse) => pulse.projectId === 'vows')
    const marketing = pulses.find((pulse) => pulse.projectId === 'ai-marketing')

    expect(roombase?.status).toBe('attention')
    expect(roombase?.pendingItems[0]).toContain('已待处理 1 天')
    expect(roombase?.nextAction).toContain('平台工单号')
    expect(vows?.status).toBe('moving')
    expect(vows?.verifiedChanges.join('')).toContain('marketing/social-account-setup.md')
    expect(vows?.nextAction).toContain('完成首批社交媒体账号 Setup')
    expect(marketing?.status).toBe('setup')
    expect(marketing?.nextAction).toBe('定义试点验收指标')
  })

  it('reports a linked PR gate instead of repeating the original investigation action', () => {
    const remediation: DecisionRemediation = {
      id: 'remediation-pr-351',
      decisionId: roombaseDecision.id,
      sourceType: 'github-pr',
      sourceRef: 'https://github.com/LIU9293/shopmy/pull/351',
      state: 'review_required',
      summary: 'PR #351 已提交，CI 已通过；仍有 2 条当前 Review 意见待处理。',
      nextAction: '处理 PR #351 的 2 条当前 Review 意见，然后重新确认 CI 与可合并状态。',
      evidenceRefs: [],
      metadata: {},
      firstSeenAt: '2026-08-08T16:37:05.923Z',
      lastSeenAt: '2026-08-09T01:00:00.000Z'
    }
    const run: AgentRun = {
      ...vowsRun,
      id: 'run-roombase',
      projectId: 'roombase',
      decisionId: roombaseDecision.id,
      goalId: null,
      milestoneId: null,
      title: '处理 · Roombase 有长期等待平台处理的入驻事项',
      updatedAt: '2026-08-08T16:37:05.923Z'
    }

    const [pulse] = buildProjectPulses({
      projects: [project('roombase', 'Roombase', '建立获客漏斗基线')],
      goals: [],
      decisions: [roombaseDecision],
      remediations: [remediation],
      runs: [run],
      artifacts: [],
      projectBriefings: [],
      reportDate: '2026-08-08',
      generatedAt: '2026-08-09T01:00:00.000Z',
      executionWindowStartAt: '2026-08-08T01:00:00.000Z'
    })

    expect(pulse.status).toBe('attention')
    expect(pulse.verifiedChanges.join('')).toContain('PR #351')
    expect(pulse.pendingItems[0]).toContain('生产问题仍未解除')
    expect(pulse.nextAction).toBe(remediation.nextAction)
    expect(pulse.nextAction).not.toContain('平台工单号')
  })
})
