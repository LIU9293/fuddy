import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dailyInspectionJobId, defaultBriefingPrompt } from '../../shared/briefing-prompt'
import { createTestDatabase } from '../test-support/project-fixtures'
import { AppDatabase } from './database'
import { AutomationRuntime, type AutomationActions } from './automation-runtime'
import { ensureDailyInspectionAutomation } from './builtin-automations'
import { MorningBriefingService } from './morning-briefing'
import { DailyBriefingService } from './daily-briefing'
import type { AgentRuntime } from './pi-runtime'
import type { ConnectorRuntime } from '../connectors/connector-runtime'

const directories: string[] = []
const databases: AppDatabase[] = []
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'fuddy-builtin-automations-'))
  directories.push(directory)
  const path = join(directory, 'test.sqlite')
  const database = createTestDatabase(path)
  databases.push(database)
  const actions: AutomationActions = {
    runAgentTask: vi.fn(), runConnectors: vi.fn(), checkGoals: vi.fn(),
    generateBriefing: vi.fn().mockResolvedValue('巡检完成')
  }
  return { database, path, actions }
}
afterEach(() => {
  databases.splice(0).forEach((database) => database.close())
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
  vi.restoreAllMocks()
})

describe('daily inspection automation', () => {
  it('migrates the hidden schedule once and preserves edits and pause across restarts', () => {
    const { database, path, actions } = setup()
    ensureDailyInspectionAutomation(database)
    const runtime = new AutomationRuntime(database, actions)
    const initial = database.getAutomation(dailyInspectionJobId)
    expect(initial).toMatchObject({ action: 'generate-briefing', prompt: defaultBriefingPrompt, cronExpression: '0 9 * * *' })
    runtime.save({ ...initial, prompt: '优先说明阻塞和需要我决策的事项。', cronExpression: '30 10 * * *', enabled: false })
    const reopened = new AppDatabase(path)
    databases.push(reopened)
    ensureDailyInspectionAutomation(reopened)
    expect(reopened.listAutomations()).toHaveLength(1)
    expect(reopened.getAutomation(dailyInspectionJobId)).toMatchObject({
      prompt: '优先说明阻塞和需要我决策的事项。', cronExpression: '30 10 * * *', enabled: false, nextRunAt: null
    })
  })

  it('does not regenerate an already completed report during migration', () => {
    const { database } = setup()
    vi.spyOn(database, 'getMorningBriefing').mockReturnValue({ status: 'completed', generatedAt: '2026-09-16T01:00:00.000Z' } as ReturnType<AppDatabase['getMorningBriefing']>)
    ensureDailyInspectionAutomation(database, new Date('2026-09-16T02:00:00.000Z'))
    expect(database.getAutomation(dailyInspectionJobId).nextRunAt).toBe('2026-09-17T01:00:00.000Z')
  })

  it('catches up once through normal run history and honors pause', async () => {
    const { database, actions } = setup()
    ensureDailyInspectionAutomation(database, new Date(Date.now() - 60_000))
    const runtime = new AutomationRuntime(database, actions)
    await runtime.runDue()
    await runtime.runDue()
    expect(actions.generateBriefing).toHaveBeenCalledExactlyOnceWith(null, undefined, defaultBriefingPrompt)
    expect(database.listAutomationRuns(dailyInspectionJobId)).toMatchObject([{ status: 'completed', trigger: 'scheduled' }])
    runtime.setEnabled(dailyInspectionJobId, false)
    ensureDailyInspectionAutomation(database)
    await runtime.runDue(new Date(Date.now() + 86_400_000))
    expect(actions.generateBriefing).toHaveBeenCalledTimes(1)
  })

  it('keeps the built-in action and scope valid while allowing prompt edits', async () => {
    const { database, actions } = setup()
    ensureDailyInspectionAutomation(database)
    const runtime = new AutomationRuntime(database, actions)
    const job = database.getAutomation(dailyInspectionJobId)
    expect(() => runtime.save({ ...job, action: 'run-connectors' })).toThrow('保留全部项目')
    expect(() => runtime.save({ ...job, prompt: ' ' })).toThrow('填写 Prompt')
    runtime.save({ ...job, prompt: '只强调需要决策的事项。' })
    await runtime.runNow(job.id)
    expect(actions.generateBriefing).toHaveBeenCalledWith(null, undefined, '只强调需要决策的事项。')
  })

  it('does not overlap a manual inspection with its due scheduled occurrence', async () => {
    const { database, actions } = setup()
    let complete!: (summary: string) => void
    actions.generateBriefing = vi.fn(() => new Promise<string>((resolve) => { complete = resolve }))
    ensureDailyInspectionAutomation(database, new Date(Date.now() - 60_000))
    const runtime = new AutomationRuntime(database, actions)
    const manual = runtime.runNow(dailyInspectionJobId)
    expect(database.getAutomation(dailyInspectionJobId).status).toBe('running')
    expect(await runtime.runDue()).toEqual([])
    complete('巡检完成')
    await manual
    expect(actions.generateBriefing).toHaveBeenCalledTimes(1)
  })

  it('passes project-specific job instructions alongside real aggregate evidence', async () => {
    const { database } = setup()
    const projectId = database.listProjects()[0].id
    vi.spyOn(database, 'listConnectors').mockReturnValue([{ projectId, kind: 'postgres', config: {} }] as ReturnType<AppDatabase['listConnectors']>)
    const connector = { runConnector: vi.fn().mockResolvedValue({ run: { status: 'completed', data: { reportDate: '2026-09-15', metrics: { bookings: 12 } } } }) }
    const run = vi.fn().mockResolvedValue('> 今日预订 12 笔。')
    const service = new DailyBriefingService(database, connector as unknown as ConnectorRuntime, { isConfigured: () => true, run } as unknown as AgentRuntime)
    const result = await service.generate(projectId, undefined, '重点说明预订量。')
    expect(result.briefing.generation).toBe('agent')
    expect(run.mock.calls[0][0]).toContain('重点说明预订量。')
    expect(run.mock.calls[0][0]).toContain('"bookings": 12')
    expect(run.mock.calls[0][0]).toContain('相关历史事项：')
  })

  it('uses the saved prompt for direct generation and an explicit prompt for a different job', async () => {
    const { database, actions } = setup()
    ensureDailyInspectionAutomation(database)
    const runtime = new AutomationRuntime(database, actions)
    runtime.save({ ...database.getAutomation(dailyInspectionJobId), prompt: '重点报告等待我决策的事项。' })
    vi.spyOn(database, 'listConnectors').mockReturnValue([])
    const run = vi.fn().mockResolvedValue(JSON.stringify({
      headline: '已完成检查', body: database.listProjects().map((project) => project.name).join('\n'), narration: '今天需要处理项目阻塞。'
    }))
    const service = new MorningBriefingService(database, {} as DailyBriefingService, { isConfigured: () => true, run } as unknown as AgentRuntime)
    const result = await service.generate()
    expect(result.briefing.generation).toBe('agent')
    expect(run.mock.calls[0][0]).toContain('重点报告等待我决策的事项。')
    expect(run.mock.calls[0][0]).toContain('Project Pulse：')
    expect(run.mock.calls[0][0]).toContain('输出约定：')
    await service.generate(undefined, '另一项任务只总结执行进度。')
    expect(run.mock.calls[1][0]).toContain('另一项任务只总结执行进度。')
    expect(run.mock.calls[1][0]).not.toContain('重点报告等待我决策的事项。')
  })
})
