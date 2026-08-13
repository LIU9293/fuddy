import { registerProjectAnalyticsProfile, type ProjectAnalyticsProfile } from '../analytics/project-analytics-profiles'

/** Optional first-party capability packages. They are registered at the
 * composition root and are not part of the project/domain contracts. */
export const bundledProjectAnalyticsProfiles: ProjectAnalyticsProfile[] = [
  {
    id: 'vows-growth-v1',
    version: 1,
    projectId: 'vows',
    projectName: 'Vows',
    timezone: 'Asia/Shanghai',
    objective: '验证从付费到婚礼创建、邀请发布、宾客互动的自助增长闭环。',
    funnel: ['注册', '创建支付订单', '支付成功', '创建婚礼', '邀请就绪/发布', '宾客 RSVP / 祝福'],
    metrics: [
      { key: 'newUsers', label: '新增用户', funnelStage: '注册', source: 'users.created_at', unit: 'count' },
      {
        key: 'paymentOrders',
        label: '创建支付订单',
        funnelStage: '创建支付订单',
        source: 'payment_orders.created_at',
        unit: 'count'
      },
      {
        key: 'paidOrders',
        label: '支付成功订单',
        funnelStage: '支付成功',
        source: 'payment_orders.paid_at',
        unit: 'count'
      },
      {
        key: 'paidRevenueCny',
        label: '支付金额',
        funnelStage: '支付成功',
        source: 'payment_orders.amount_total',
        unit: 'CNY'
      },
      {
        key: 'weddingsCreated',
        label: '创建婚礼',
        funnelStage: '创建婚礼',
        source: 'weddings.created_at',
        unit: 'count'
      },
      {
        key: 'publishedWeddingEvents',
        label: '已发布邀请',
        funnelStage: '邀请就绪/发布',
        source: 'wedding_events.published',
        unit: 'count'
      },
      { key: 'rsvps', label: '宾客 RSVP', funnelStage: '宾客互动', source: 'rsvps.created_at', unit: 'count' },
      { key: 'blessings', label: '宾客祝福', funnelStage: '宾客互动', source: 'blessings.created_at', unit: 'count' }
    ],
    requiredConnectors: ['postgres', 'repo', 'project-agent'],
    recommendedConnectors: ['cloudflare', 'ga4'],
    decisionRules: [
      'paid_without_wedding > 0 时创建高优先级交付风险。',
      '支付成功或婚礼创建较 7 日均值下降 30% 时提示漏斗风险。',
      '只汇总业务数据，不读取宾客姓名、祝福内容或媒体 URL。'
    ],
    agentIntegration: {
      kind: 'repo-skill',
      skillPath: '.agents/skills/wedding-promotion/SKILL.md',
      workspacePath: 'marketing/',
      provider: 'codex',
      approvalBoundary: '发布、发消息、联系合作方或花费资金前，必须取得对具体内容和目标的明确批准。'
    }
  },
  {
    id: 'ai-marketing-production-v1',
    version: 1,
    projectId: 'ai-marketing',
    projectName: 'AI Marketing',
    timezone: 'Asia/Shanghai',
    objective: '量化从创建任务到候选采纳与最终交付的素材生产效率和质量。',
    funnel: ['创建工作流', '生成任务', '候选素材', '人工评审', '候选采纳', '最终交付'],
    metrics: [
      {
        key: 'imageCreations',
        label: '图片工作流',
        funnelStage: '创建工作流',
        source: 'image_creations.created_at',
        unit: 'count'
      },
      {
        key: 'generationJobs',
        label: '生成任务',
        funnelStage: '生成任务',
        source: 'generation_jobs.created_at',
        unit: 'count'
      },
      {
        key: 'completedJobs',
        label: '完成任务',
        funnelStage: '生成任务',
        source: 'generation_jobs.status',
        unit: 'count'
      },
      {
        key: 'failedJobs',
        label: '失败任务',
        funnelStage: '生成任务',
        source: 'generation_jobs.status',
        unit: 'count'
      },
      {
        key: 'imageCandidates',
        label: '候选素材',
        funnelStage: '候选素材',
        source: 'image_candidates.created_at',
        unit: 'count'
      },
      {
        key: 'adoptedReviews',
        label: '采纳评审',
        funnelStage: '候选采纳',
        source: 'image_candidate_reviews.decision',
        unit: 'count'
      },
      {
        key: 'readyImageDeliverables',
        label: '图片交付物',
        funnelStage: '最终交付',
        source: 'image_creation_deliverables.status',
        unit: 'count'
      },
      {
        key: 'finalVideoDeliverables',
        label: '视频交付物',
        funnelStage: '最终交付',
        source: 'video_deliverables.status',
        unit: 'count'
      }
    ],
    requiredConnectors: ['postgres', 'repo', 'project-agent'],
    recommendedConnectors: ['cloudflare'],
    decisionRules: [
      '失败任务占比超过 20% 或存在停滞任务时提示生产风险。',
      '候选采纳率较 7 日均值下降 30% 时提示质量风险。',
      'Worker 心跳超过 5 分钟未更新时提示执行基础设施风险。'
    ],
    agentIntegration: {
      kind: 'http-super-agent',
      threadPath: '/api/super-agent/threads',
      chatPath: '/api/super-agent/chat',
      workspace: 'global',
      approvalBoundary: '调用现有 Super Agent；任何对外发布、投放或付费动作仍需单独批准。'
    }
  }
]

export function registerBundledProjectAnalyticsProfiles(): void {
  for (const profile of bundledProjectAnalyticsProfiles) registerProjectAnalyticsProfile(profile)
}
