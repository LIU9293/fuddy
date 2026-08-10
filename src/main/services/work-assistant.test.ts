import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionUpdate, WorkAssistantImageAttachment } from '../../shared/contracts'
import { AppDatabase } from './database'
import type { DailyBriefingService } from './daily-briefing'
import { GoalTrackingService } from './goal-tracking'
import { MorningBriefingService } from './morning-briefing'
import type { AgentRuntime } from './pi-runtime'

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

class VisionRuntime implements AgentRuntime {
  receivedImages: WorkAssistantImageAttachment[] = []

  isConfigured(): boolean {
    return true
  }

  async run(): Promise<string> {
    return '已分析图片'
  }

  async runStream(
    _prompt: string,
    onUpdate: (update: AgentSessionUpdate) => void,
    images: WorkAssistantImageAttachment[] = []
  ): Promise<string> {
    this.receivedImages = images
    onUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'vision-response',
      content: { type: 'text', text: '已分析图片' }
    })
    return '已分析图片'
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
    const database = new AppDatabase(join(directory, 'test.sqlite'))
    const runtime = new OfflineRuntime()
    const goal = await new GoalTrackingService(database, runtime).createFromPrompt('vows', '建立社交媒体账号')
    const milestone = goal.milestones[0]
    const service = new MorningBriefingService(
      database,
      {} as DailyBriefingService,
      runtime
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
    expect(followUp.userMessage.taskContext?.milestoneId).toBe(milestone.id)
    expect(followUp.assistantMessage.taskContext?.projectId).toBe('vows')

    const switched = await service.ask(null, 'Roombase 现在最重要的事情是什么？')
    expect(switched.userMessage.taskContext).toBeNull()
    database.close()
  })

  it('persists image attachments and forwards them to the agent runtime', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'work-assistant-image-'))
    directories.push(directory)
    const database = new AppDatabase(join(directory, 'test.sqlite'))
    const runtime = new VisionRuntime()
    const service = new MorningBriefingService(
      database,
      {} as DailyBriefingService,
      runtime
    )
    const attachment: WorkAssistantImageAttachment = {
      id: 'image-1',
      name: 'reference.png',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,aW1hZ2U='
    }

    const result = await service.ask(null, '请分析这张图。', null, [attachment])

    expect(runtime.receivedImages).toEqual([attachment])
    expect(result.userMessage.attachments).toEqual([attachment])
    expect(database.listBriefingMessages()[0]?.attachments).toEqual([attachment])
    expect(result.assistantMessage.attachments).toEqual([])
    database.close()
  })
})
