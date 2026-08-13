import type { DecisionItem } from '../../shared/contracts'
import { registerDailyBriefingStrategy } from '../services/daily-briefing'
import type { DecisionInspectionInput } from '../services/database'

interface Comparison {
  value: number
  previousValue?: number
  vsSevenDayAveragePct?: number | null
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function comparison(data: Record<string, unknown>, key: string): Comparison {
  const value = object(object(data.metrics)[key])
  return {
    value: number(value.value),
    previousValue: number(value.previousValue),
    vsSevenDayAveragePct: value.vsSevenDayAveragePct === null ? null : number(value.vsSevenDayAveragePct)
  }
}

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined) return '无可比基线'
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`
}

function cny(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    maximumFractionDigits: 2
  }).format(value)
}

export function deterministicRoombaseHeadline(data: Record<string, unknown>): string {
  const firstBookings = comparison(data, 'firstBookingUsers')
  const netPaid = comparison(data, 'netPaidCny')
  const firstWeak = (firstBookings.vsSevenDayAveragePct ?? 0) <= -15
  const revenueStrong = (netPaid.vsSevenDayAveragePct ?? 0) >= 10
  if (firstWeak && revenueStrong) return '交易基本盘高于近期均值，但首次预订用户偏弱，应优先检查激活环节。'
  if (firstWeak) return '首次预订用户低于近期基线，需要检查从注册到首次使用的激活环节。'
  if (revenueStrong) return '交易与实收高于近期基线，当前应验证增长是否可持续。'
  return '核心经营指标总体接近近期基线，今天没有出现需要升级处理的大幅变化。'
}

export function renderDeterministicRoombaseBriefing(data: Record<string, unknown>): string {
  const reportDate = String(data.reportDate ?? '未知日期')
  const newUsers = comparison(data, 'newUsers')
  const firstBookings = comparison(data, 'firstBookingUsers')
  const bookings = comparison(data, 'bookings')
  const netPaid = comparison(data, 'netPaidCny')
  const cancellation = comparison(data, 'bookingCancellationRate')
  const paymentShare = comparison(data, 'paymentSuccessShare')
  const snapshot = object(data.snapshot)
  const waitingPlatform = number(snapshot.waiting_platform_onboardings)
  const oldestWaitingDays = number(snapshot.oldest_waiting_platform_days)
  const actions: string[] = []
  if ((firstBookings.vsSevenDayAveragePct ?? 0) <= -15 && firstBookings.value >= 20) {
    actions.push('按来源和门店拆分近 7 天首次预订用户，定位激活下降集中在哪个环节；不要把它误写成同日注册转化率。')
  }
  if (waitingPlatform > 0 && oldestWaitingDays >= 14) {
    actions.push(
      `逐项清理 ${waitingPlatform} 个等待平台处理的小程序入驻，先处理已等待 ${oldestWaitingDays.toFixed(1)} 天的最老事项。`
    )
  }
  if (actions.length === 0) actions.push('维持当前观察口径，明天继续对比完整日与 7 日均值。')
  return [
    `# Roombase · ${reportDate} 项目总结`,
    '',
    `> ${deterministicRoombaseHeadline(data)}`,
    '',
    '## 关键变化',
    '',
    `- 新用户 ${newUsers.value}，较 7 日均值 ${pct(newUsers.vsSevenDayAveragePct)}。`,
    `- 首次预订用户 ${firstBookings.value}，较 7 日均值 ${pct(firstBookings.vsSevenDayAveragePct)}。`,
    `- 预订 ${bookings.value}，较 7 日均值 ${pct(bookings.vsSevenDayAveragePct)}；净实收 ${cny(netPaid.value)}，较 7 日均值 ${pct(netPaid.vsSevenDayAveragePct)}。`,
    `- 取消率 ${cancellation.value.toFixed(2)}%，前一日 ${number(cancellation.previousValue).toFixed(2)}%；支付成功占比 ${paymentShare.value.toFixed(2)}%，前一日 ${number(paymentShare.previousValue).toFixed(2)}%。`,
    '',
    '## 今天建议',
    '',
    ...actions.slice(0, 3).map((action, index) => `${index + 1}. ${action}`),
    '',
    '## 口径提醒',
    '',
    '- 数据窗口为 Asia/Shanghai 的前一个完整自然日，并与此前 7 个完整自然日比较。',
    '- 首次预订用户按 first_booking_at 统计，不代表同日注册用户的转化率。',
    '- 本简报只使用聚合数据；原因尚未由分群或用户级数据验证。'
  ].join('\n')
}

export function buildRoombaseDailyInspections(
  data: Record<string, unknown>,
  observedAt = new Date().toISOString()
): DecisionInspectionInput[] {
  const reportDate = String(data.reportDate)
  const evidenceRefs = [{ label: `Roombase ${reportDate} 只读聚合`, uri: 'postgres://analytics/roombase-daily-v0' }]
  const inspections: DecisionInspectionInput[] = []
  const firstBookings = comparison(data, 'firstBookingUsers')
  const firstBookingActive = (firstBookings.vsSevenDayAveragePct ?? 0) <= -15 && firstBookings.value >= 20
  const firstBookingSummary = firstBookingActive
    ? `${reportDate} 有 ${firstBookings.value} 位用户完成首次预订，较此前 7 日均值 ${pct(firstBookings.vsSevenDayAveragePct)}。`
    : `${reportDate} 首次预订用户未触发“低于 7 日基线 15% 且绝对量不少于 20”的风险条件。`
  inspections.push({
    projectId: 'roombase',
    dedupeKey: 'roombase:activation:first-booking-below-7d',
    observationKey: `roombase:${reportDate}:first-booking`,
    state: firstBookingActive ? 'active' : 'resolved',
    observedAt,
    summary: firstBookingSummary,
    evidenceRefs,
    decision: firstBookingActive
      ? {
          id: `daily-roombase-${reportDate}-first-booking`,
          projectId: 'roombase',
          dedupeKey: 'roombase:activation:first-booking-below-7d',
          kind: 'risk',
          title: 'Roombase 首次预订用户低于 7 日基线',
          summary: firstBookingSummary,
          impact: '新增用户到首次使用的激活量走弱，若持续会影响后续预订与付费的新增供给。',
          urgency: 'high',
          confidence: 1,
          suggestedActions: ['按来源和门店拆分首次预订变化', '检查注册后到首次预订的关键路径'],
          evidenceRefs,
          status: 'inbox',
          source: '每日项目总结',
          createdAt: observedAt
        }
      : undefined
  })
  const snapshot = object(data.snapshot)
  const waitingPlatform = number(snapshot.waiting_platform_onboardings)
  const oldestWaitingDays = number(snapshot.oldest_waiting_platform_days)
  const onboardingActive = waitingPlatform > 0 && oldestWaitingDays >= 14
  const onboardingSummary = onboardingActive
    ? `当前 ${waitingPlatform} 个小程序入驻等待平台处理，最老一项已等待 ${oldestWaitingDays.toFixed(1)} 天。`
    : waitingPlatform === 0
      ? `${reportDate} 已无等待平台处理的小程序入驻事项。`
      : `${reportDate} 仍有 ${waitingPlatform} 个等待平台处理的入驻事项，但最长等待 ${oldestWaitingDays.toFixed(1)} 天，已低于 14 天风险阈值。`
  inspections.push({
    projectId: 'roombase',
    dedupeKey: 'roombase:onboarding:waiting-platform',
    observationKey: `roombase:${reportDate}:onboarding-waiting-platform`,
    state: onboardingActive ? 'active' : 'resolved',
    observedAt,
    summary: onboardingSummary,
    evidenceRefs,
    decision: onboardingActive
      ? {
          id: `daily-roombase-${reportDate}-onboarding-waiting-platform`,
          projectId: 'roombase',
          dedupeKey: 'roombase:onboarding:waiting-platform',
          kind: 'risk',
          title: 'Roombase 有长期等待平台处理的入驻事项',
          summary: onboardingSummary,
          impact: '长时间未完成入驻会延迟商家上线，也可能暴露缺少责任人或升级机制。',
          urgency: oldestWaitingDays >= 30 ? 'high' : 'medium',
          confidence: 1,
          suggestedActions: ['检查最老入驻事项的阻塞原因'],
          evidenceRefs,
          status: 'inbox',
          source: '每日项目总结',
          createdAt: observedAt
        }
      : undefined
  })
  return inspections
}

export function buildRoombaseDailySignals(
  data: Record<string, unknown>,
  createdAt = new Date().toISOString()
): DecisionItem[] {
  return buildRoombaseDailyInspections(data, createdAt).flatMap((inspection) =>
    inspection.state === 'active' && inspection.decision ? [inspection.decision] : []
  )
}

export function registerBundledDailyBriefingStrategies(): void {
  registerDailyBriefingStrategy({
    analyticsProfile: 'roombase-daily-v0',
    headline: deterministicRoombaseHeadline,
    render: renderDeterministicRoombaseBriefing,
    inspections: buildRoombaseDailyInspections
  })
}
