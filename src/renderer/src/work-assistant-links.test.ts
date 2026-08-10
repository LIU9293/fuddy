import { describe, expect, it } from 'vitest'
import type { BriefingMessage, WorkAssistantActionProposal } from '../../shared/contracts'
import { workAssistantRunIds } from './work-assistant-links'

function message(input: Partial<BriefingMessage>): BriefingMessage {
  return {
    id: 'message',
    briefingId: null,
    role: 'assistant',
    content: '',
    attachments: [],
    taskContext: null,
    createdAt: '2026-08-10T00:00:00.000Z',
    ...input
  }
}

function createRunProposal(status: WorkAssistantActionProposal['status']): WorkAssistantActionProposal {
  return {
    id: 'proposal',
    title: '创建 Agent Run',
    description: '确认后创建',
    status,
    context: null,
    options: [{
      id: 'create',
      label: '创建并打开',
      style: 'primary',
      capability: 'agent-run.create',
      payload: {
        projectId: 'fuddy',
        decisionId: null,
        goalId: null,
        milestoneId: null,
        title: 'Fuddy 任务',
        draftPrompt: '开始任务'
      }
    }],
    acceptedOptionId: status === 'accepted' ? 'create' : null,
    createdAt: '2026-08-10T00:00:00.000Z',
    resolvedAt: status === 'accepted' ? '2026-08-10T00:01:00.000Z' : null
  }
}

describe('workAssistantRunIds', () => {
  it('不在用户消息上显示历史遗留的 Run 卡片', () => {
    expect(workAssistantRunIds(message({ role: 'user', linkedRunId: 'old-roombase-run' }))).toEqual([])
  })

  it('待确认创建 Run 时不显示历史遗留的 Run 卡片', () => {
    expect(workAssistantRunIds(message({
      linkedRunId: 'old-roombase-run',
      actions: [createRunProposal('pending')]
    }))).toEqual([])
  })

  it('仅在创建成功后显示新 Run 链接', () => {
    expect(workAssistantRunIds(message({
      linkedRunId: 'new-fuddy-run',
      actions: [createRunProposal('accepted')]
    }))).toEqual(['new-fuddy-run'])
  })

  it('保留明确找到的已有 Run 链接', () => {
    expect(workAssistantRunIds(message({ linkedRunId: 'existing-run' }))).toEqual(['existing-run'])
  })
})
