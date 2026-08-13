import { describe, expect, it } from 'vitest'
import type { DailyBriefing, DecisionItem, Project } from '../../shared/contracts'
import { buildMorningBriefingContent } from './morning-briefing'

const roombaseBriefing: DailyBriefing = {
  id: 'daily-roombase-2026-08-05',
  projectId: 'roombase',
  reportDate: '2026-08-05',
  timezone: 'Asia/Shanghai',
  status: 'completed',
  headline: '经营稳定',
  body: '',
  metrics: {
    metrics: {
      newUsers: { value: 224, vsSevenDayAveragePct: 1.4 },
      firstBookingUsers: { value: 109, vsSevenDayAveragePct: -1 },
      bookings: { value: 1173, vsSevenDayAveragePct: -0.8 },
      netPaidCny: { value: 30931.34, vsSevenDayAveragePct: 9.3 }
    }
  },
  signalIds: ['daily-roombase-2026-08-05-onboarding'],
  generatedAt: '2026-08-06T00:00:00.000Z',
  error: null,
  generation: 'deterministic'
}

const projects: Project[] = ['roombase', 'vows', 'ai-marketing'].map((id) => ({
  id,
  name: id === 'roombase' ? 'Roombase' : id === 'vows' ? 'Vows' : 'AI Marketing',
  summary: '',
  focus: '',
  status: 'active',
  accent: '#000',
  profile: {
    productType: '', stage: '', mission: '', vision: '', repoPath: '', workspaceRoots: [], primaryWorkspaceRootId: null, defaultAgent: 'codex', websiteUrl: null,
    surfaces: [], focusAreas: [], dataSources: [], nextMoves: [],
    currentState: { summary: '测试项目现状', facts: [], source: 'user', updatedAt: null }
  }
}))

const decisions: DecisionItem[] = [{
  id: 'daily-roombase-2026-08-05-onboarding',
  projectId: 'roombase',
  kind: 'risk',
  title: '入驻等待时间过长',
  summary: '4 个入驻等待平台处理，最老 70.8 天。',
  impact: '',
  urgency: 'high',
  confidence: 1,
  suggestedActions: ['先处理最老事项'],
  evidenceRefs: [],
  status: 'inbox',
  source: '每日项目总结',
  createdAt: '2026-08-06T00:00:00.000Z'
}]

describe('cross-project morning briefing', () => {
  it('compresses project evidence into one Chinese narration under three minutes', () => {
    const result = buildMorningBriefingContent({
      reportDate: '2026-08-05',
      projectBriefings: [roombaseBriefing],
      decisions,
      projects
    })

    expect(result.body).toContain('每日简报')
    expect(result.body).toContain('Vows · 待建立焦点')
    expect(result.body).toContain('AI Marketing · 待建立焦点')
    expect(result.body).toContain('今天下一步')
    expect(result.narration).toContain('跨项目简报')
    expect(result.narration.length).toBeLessThanOrEqual(620)
    expect(result.estimatedDurationSeconds).toBeLessThanOrEqual(180)
    expect(result.signalIds).toEqual(['daily-roombase-2026-08-05-onboarding'])
  })

  it('does not invent a business change when project data is unavailable', () => {
    const result = buildMorningBriefingContent({
      reportDate: '2026-08-05',
      projectBriefings: [],
      decisions: [],
      projects
    })
    expect(result.headline).toContain('建立当前焦点')
    expect(result.body).toContain('不推测业务变化')
  })
})
