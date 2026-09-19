import { dailyInspectionJobId, defaultBriefingPrompt } from '../../shared/briefing-prompt'
import { nextCronOccurrence } from './automation-cron'
import type { AppDatabase } from './database'
import { previousCompleteShanghaiDate } from './daily-briefing-time'

// Seed once; subsequent launches must preserve the user's prompt, schedule and pause state.
export function ensureDailyInspectionAutomation(database: AppDatabase, now = new Date()): void {
  if (database.listAutomations().some((job) => job.id === dailyInspectionJobId)) return
  const existing = database.getMorningBriefing(previousCompleteShanghaiDate(now))
  const timestamp = now.toISOString()
  database.saveAutomation({
    id: dailyInspectionJobId,
    projectId: null,
    name: '每日项目巡检',
    scheduleDescription: '每天上午 09:00',
    cronExpression: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    action: 'generate-briefing',
    prompt: defaultBriefingPrompt,
    agentProvider: 'pi',
    enabled: true,
    requiresConfirmation: false,
    maxRetries: 1,
    retryDelaySeconds: 30,
    status: 'idle',
    lastRunAt: existing?.generatedAt ?? null,
    nextRunAt: existing?.status === 'completed'
      ? nextCronOccurrence('0 9 * * *', 'Asia/Shanghai', now).toISOString()
      : timestamp,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp
  })
}
