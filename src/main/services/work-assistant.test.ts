import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionUpdate, WorkAssistantImageAttachment } from '../../shared/contracts'
import { AppDatabase } from './database'
import { createTestDatabase } from '../test-support/project-fixtures'
import type { DailyBriefingService } from './daily-briefing'
import { GoalTrackingService } from './goal-tracking'
import { MorningBriefingService } from './morning-briefing'
import type { AgentRuntime } from './pi-runtime'
import type {
  WorkAssistantAgentRuntime,
  WorkAssistantAgentTurnInput,
  WorkAssistantAgentTurnResult
} from './work-assistant-agent'

class OfflineRuntime implements AgentRuntime {
  isConfigured(): boolean {
    return false
  }

  async run(): Promise<string> {
    return '{}'
  }

  async runStream(
    _prompt: string,
    _onUpdate: (update: AgentSessionUpdate) => void
  ): Promise<string> {
    return '{}'
  }
}

class TestWorkAssistantAgent implements WorkAssistantAgentRuntime {
  inputs: WorkAssistantAgentTurnInput[] = []

  constructor(private readonly respond: (input: WorkAssistantAgentTurnInput) => WorkAssistantAgentTurnResult = () => ({
    content: '已处理。', proposals: [], linkedRunId: null
  })) {}

  isConfigured(): boolean { return true }

  async runTurn(input: WorkAssistantAgentTurnInput): Promise<WorkAssistantAgentTurnResult> {
    this.inputs.push(input)
    return this.respond(input)
  }
}

describe('Work Assistant task handoff', () => {
  const directories: string[] = []

  afterEach(() => {
    directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
  })

  it('starts a milestone conversation without requiring a daily briefing or completing it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'work-assistant-'))
    directories.push(directory)
    const database = createTestDatabase(join(directory, 'test.sqlite'))
    const runtime = new OfflineRuntime()
    const goal = await new GoalTrackingService(database, runtime).createFromPrompt('vows', '建立社交媒体账号')
    const milestone = goal.milestones[0]
    const agent = new TestWorkAssistantAgent((input) => ({
      content: input.taskContext
        ? '我会先确认完成标准。开始任务不会自动把里程碑标记为完成。'
        : '我仍记得之前的任务上下文。',
      proposals: [],
      linkedRunId: null
    }))
    const service = new MorningBriefingService(
      database,
      {} as DailyBriefingService,
      runtime,
      undefined,
      undefined,
      undefined,
      agent
    )

    const result = await service.ask(null, '我想开始这项任务。', {
      projectId: 'vows',
      goalId: goal.id,
      milestoneId: milestone.id
    })

    expect(result.userMessage.briefingId).toBeNull()
    expect(result.userMessage.taskContext?.milestoneTitle).toBe(milestone.title)
    expect(result.assistantMessage.content).toContain('开始任务不会自动把里程碑标记为完成')
    expect(database.getGoal(goal.id).milestones[0].status).toBe('pending')
    expect(database.listBriefingMessages()).toHaveLength(2)

    const followUp = await service.ask(null, '那先找一下现有素材。')
    expect(followUp.userMessage.taskContext).toBeNull()
    expect(agent.inputs[1].history.at(-1)?.content).toContain('开始任务不会自动把里程碑标记为完成')

    const switched = await service.ask(null, 'Roombase 现在最重要的事情是什么？')
    expect(switched.userMessage.taskContext).toBeNull()
    database.close()
  })

  it('persists image attachments and forwards them to the agent runtime', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'work-assistant-image-'))
    directories.push(directory)
    const database = createTestDatabase(join(directory, 'test.sqlite'))
    const runtime = new OfflineRuntime()
    const agent = new TestWorkAssistantAgent(() => ({ content: '已分析图片', proposals: [], linkedRunId: null }))
    const service = new MorningBriefingService(
      database,
      {} as DailyBriefingService,
      runtime,
      undefined,
      undefined,
      undefined,
      agent
    )
    const attachment: WorkAssistantImageAttachment = {
      id: 'image-1',
      name: 'reference.png',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,aW1hZ2U='
    }

    const result = await service.ask(null, '请分析这张图。', null, [attachment])

    expect(agent.inputs[0].attachments).toEqual([attachment])
    expect(result.userMessage.attachments).toEqual([attachment])
    expect(database.listBriefingMessages()[0]?.attachments).toEqual([attachment])
    expect(result.assistantMessage.attachments).toEqual([])
    database.close()
  })

  it('does not copy a previous Run link onto later conversation messages', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'work-assistant-run-link-'))
    directories.push(directory)
    const database = createTestDatabase(join(directory, 'test.sqlite'))
    const runtime = new OfflineRuntime()
    const now = '2026-08-10T00:00:00.000Z'
    database.createAgentRun({
      id: 'old-roombase-run',
      projectId: 'roombase',
      decisionId: null,
      goalId: null,
      milestoneId: null,
      provider: 'claude',
      title: '处理 Roombase 入驻事项',
      status: 'idle',
      sessionId: null,
      workingDirectory: null,
      startedAt: now,
      completedAt: null,
      summary: '',
      draftPrompt: null,
      createdAt: now,
      updatedAt: now
    })
    database.createBriefingMessage({
      id: 'old-assistant-message',
      briefingId: null,
      role: 'assistant',
      content: '可以通过下方链接打开。',
      attachments: [],
      taskContext: null,
      linkedRunId: 'old-roombase-run',
      actions: [],
      createdAt: now
    })
    const agent = new TestWorkAssistantAgent(() => ({ content: '已准备新的 Action。', proposals: [], linkedRunId: null }))
    const service = new MorningBriefingService(
      database, {} as DailyBriefingService, runtime, undefined, undefined, undefined, agent
    )

    const result = await service.ask(null, '创建一个 Fuddy 的 Agent Run')

    expect(result.userMessage.linkedRunId).toBeNull()
    expect(result.assistantMessage.linkedRunId).toBeNull()
    database.close()
  })

  it('passes “跑一次每日总结” directly to the Agent and persists its ask_user buttons', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'work-assistant-briefing-confirm-'))
    directories.push(directory)
    const database = createTestDatabase(join(directory, 'test.sqlite'))
    const runtime = new OfflineRuntime()
    const agent = new TestWorkAssistantAgent((input) => ({
      content: '可以，我先请你确认。',
      linkedRunId: null,
      proposals: [{
        id: 'confirm-generate-briefing',
        title: '运行一次每日总结',
        description: '巡检全部项目并生成新的每日简报。',
        status: 'pending',
        context: null,
        options: [{ id: 'generate', label: '开始生成', style: 'primary', capability: 'briefing.generate', payload: {} }],
        acceptedOptionId: null,
        createdAt: '2026-08-10T10:00:00.000Z',
        resolvedAt: null
      }]
    }))
    const service = new MorningBriefingService(
      database, {} as DailyBriefingService, runtime, undefined, undefined, undefined, agent
    )

    const result = await service.ask(null, '跑一次每日总结')

    expect(agent.inputs[0].question).toBe('跑一次每日总结')
    expect(result.assistantMessage.actions).toEqual([
      expect.objectContaining({ title: '运行一次每日总结', status: 'pending' })
    ])
    database.close()
  })
})
