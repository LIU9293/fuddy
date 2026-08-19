import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionUpdate } from '../../shared/contracts'
import { AppDatabase } from './database'
import { createTestDatabase } from '../test-support/project-fixtures'
import { GoalTrackingService } from './goal-tracking'
import type { AgentRuntime } from './pi-runtime'
import { WorkspaceAgentActions, type WorkspaceAgentTurnState } from './workspace-agent-actions'
import { WorkspaceFilesService } from './workspace-files'
import { TaskDispatcher } from './task-dispatcher'
import type { PiTaskHarness } from './pi-task-harness'
import type { CliAgentRuntime } from './cli-agent-runtime'

class OfflineRuntime implements AgentRuntime {
  isConfigured(): boolean { return false }
  async run(): Promise<string> { return '{}' }
  async runStream(_prompt: string, _onUpdate: (update: AgentSessionUpdate) => void): Promise<string> { return '{}' }
}

async function callTool(
  actions: WorkspaceAgentActions,
  state: WorkspaceAgentTurnState,
  name: string,
  params: Record<string, unknown>
) {
  const tool = actions.createTools(state).find((candidate) => candidate.name === name) as ToolDefinition<any> | undefined
  if (!tool) throw new Error(`Missing tool ${name}`)
  return await tool.execute('tool-call', params, undefined, undefined, {} as never)
}

describe('WorkspaceAgentActions native tools', () => {
  const directories: string[] = []

  afterEach(() => {
    directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
  })

  function setup() {
    const directory = mkdtempSync(join(tmpdir(), 'workspace-agent-tools-'))
    directories.push(directory)
    const database = createTestDatabase(join(directory, 'test.sqlite'))
    const runtime = new OfflineRuntime()
    const files = new WorkspaceFilesService(database, join(directory, 'files'))
    const dispatcher = new TaskDispatcher(database, {} as PiTaskHarness, files, {} as CliAgentRuntime)
    const actions = new WorkspaceAgentActions(database, runtime, new GoalTrackingService(database, runtime), dispatcher)
    return { database, actions, dispatcher }
  }

  it('exposes native tools on every turn without a keyword gate', () => {
    const { database, actions } = setup()
    const names = actions.createTools(actions.createTurnState()).map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining([
      'get_workspace_context',
      'inspect_project',
      'inspect_project_files',
      'inspect_agent_run',
      'open_agent_run',
      'search_web',
      'read_web',
      'read_latest_briefing',
      'ask_user'
    ]))
    database.close()
  })

  it('ask_user creates a persistent confirmation proposal without executing it', async () => {
    const { database, actions } = setup()
    const generate = vi.fn(async () => ({ briefing: { reportDate: '2026-08-09', headline: '新的每日简报' } }))
    actions.setMorningBriefingGenerator(generate)
    const state = actions.createTurnState()

    await callTool(actions, state, 'ask_user', {
      title: '运行一次每日总结',
      description: '将巡检全部项目并生成新的每日简报。',
      context: 'Roombase、Vows、AI Marketing、Fuddy',
      options: [
        { id: 'generate', label: '开始生成', style: 'primary', capability: 'briefing.generate', payload: {} },
        { id: 'cancel', label: '取消', style: 'quiet', capability: 'assistant.dismiss', payload: {} }
      ]
    })

    expect(generate).not.toHaveBeenCalled()
    expect(state.proposals).toHaveLength(1)
    expect(state.proposals[0]).toMatchObject({
      title: '运行一次每日总结',
      status: 'pending',
      options: [
        expect.objectContaining({ capability: 'briefing.generate' }),
        expect.objectContaining({ capability: 'assistant.dismiss' })
      ]
    })
    database.close()
  })

  it('dismisses a proposal without executing its protected action', async () => {
    const { database, actions } = setup()
    const generate = vi.fn(async () => ({ briefing: { reportDate: '2026-08-09', headline: '不应生成' } }))
    actions.setMorningBriefingGenerator(generate)
    const state = actions.createTurnState()
    await callTool(actions, state, 'ask_user', {
      title: '运行一次每日总结',
      description: '巡检全部项目并生成简报。',
      options: [
        { id: 'generate', label: '开始生成', style: 'primary', capability: 'briefing.generate', payload: {} },
        { id: 'cancel', label: '取消', style: 'quiet', capability: 'assistant.dismiss', payload: {} }
      ]
    })
    const message = database.createBriefingMessage({
      id: 'assistant-dismiss-briefing', briefingId: null, role: 'assistant', content: '请确认。', attachments: [],
      taskContext: null, actions: state.proposals, createdAt: new Date().toISOString()
    })

    const result = await actions.executeProposal({
      messageId: message.id, proposalId: state.proposals[0].id, optionId: 'cancel'
    })

    expect(generate).not.toHaveBeenCalled()
    expect(result.notice).toBe('已取消。')
    expect(result.message.actions?.[0].status).toBe('dismissed')
    database.close()
  })

  it('executes an action from a message older than the 200-message display window', async () => {
    const { database, actions } = setup()
    const state = actions.createTurnState()
    await callTool(actions, state, 'ask_user', {
      title: '保留的历史 Action',
      description: '这条 Action 位于分页历史中。',
      options: [{ id: 'cancel', label: '取消', style: 'quiet', capability: 'assistant.dismiss', payload: {} }]
    })
    const base = Date.UTC(2026, 0, 1)
    const historical = database.createBriefingMessage({
      id: 'historical-action-message',
      briefingId: null,
      role: 'assistant',
      content: '历史确认。',
      attachments: [],
      taskContext: null,
      actions: state.proposals,
      createdAt: new Date(base).toISOString()
    })
    for (let index = 0; index < 201; index += 1) {
      database.createBriefingMessage({
        id: `newer-message-${index}`,
        briefingId: null,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `newer ${index}`,
        attachments: [],
        taskContext: null,
        createdAt: new Date(base + (index + 1) * 1_000).toISOString()
      })
    }
    expect(database.listBriefingMessages().some((message) => message.id === historical.id)).toBe(false)

    const result = await actions.executeProposal({
      messageId: historical.id,
      proposalId: state.proposals[0].id,
      optionId: 'cancel'
    })

    expect(result.notice).toBe('已取消。')
    expect(result.message.actions?.[0]).toMatchObject({ status: 'dismissed', acceptedOptionId: 'cancel' })
    expect(database.getBriefingMessage(historical.id)?.actions?.[0].status).toBe('dismissed')
    database.close()
  })

  it('executes briefing.generate only after the user presses its button', async () => {
    const { database, actions } = setup()
    const recordAudit = vi.spyOn(database, 'recordPermissionEvaluation')
    const updateAudit = vi.spyOn(database, 'updateAuditOutcome')
    const generate = vi.fn(async () => ({ briefing: { reportDate: '2026-08-09', headline: '新的每日简报' } }))
    actions.setMorningBriefingGenerator(generate)
    const state = actions.createTurnState()
    await callTool(actions, state, 'ask_user', {
      title: '运行一次每日总结',
      description: '巡检全部项目并生成简报。',
      options: [{ id: 'generate', label: '开始生成', style: 'primary', capability: 'briefing.generate', payload: {} }]
    })
    const message = database.createBriefingMessage({
      id: 'assistant-confirm-briefing',
      briefingId: null,
      role: 'assistant',
      content: '请确认。',
      attachments: [],
      taskContext: null,
      actions: state.proposals,
      createdAt: new Date().toISOString()
    })

    const result = await actions.executeProposal({
      messageId: message.id,
      proposalId: state.proposals[0].id,
      optionId: 'generate'
    })

    expect(generate).toHaveBeenCalledOnce()
    expect(result.notice).toContain('新的每日简报')
    expect(result.message.actions?.[0]).toMatchObject({ status: 'accepted', acceptedOptionId: 'generate' })
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'workspace-agent', action: 'briefing.generate' }),
      expect.objectContaining({ decision: 'auto-approved' })
    )
    expect(updateAudit).toHaveBeenCalledWith(expect.any(String), 'completed')
    database.close()
  })

  it('creates a draft Agent Run only after confirmation and never sends its prompt', async () => {
    const { database, actions } = setup()
    const decision = database.createDecision({ projectId: 'vows', title: '整理宣传素材', summary: '需要建立 Run。' })
    const state = actions.createTurnState()
    await callTool(actions, state, 'ask_user', {
      title: '创建 Vows Agent Run',
      description: '创建 Draft 并预填任务说明。',
      options: [{
        id: 'create',
        label: '创建并打开',
        style: 'primary',
        capability: 'agent-run.create',
        payload: {
          projectId: 'vows',
          decisionId: decision.id,
          goalId: null,
          milestoneId: null,
          title: 'Vows 宣传素材',
          draftPrompt: '整理现有宣传素材。'
        }
      }]
    })
    expect(database.listRuns()).toHaveLength(0)
    const message = database.createBriefingMessage({
      id: 'assistant-confirm-run', briefingId: null, role: 'assistant', content: '请确认。', attachments: [],
      taskContext: null, actions: state.proposals, createdAt: new Date().toISOString()
    })

    const result = await actions.executeProposal({ messageId: message.id, proposalId: state.proposals[0].id, optionId: 'create' })
    expect(result.navigation).toMatchObject({ kind: 'agent-run' })
    const runId = result.navigation?.id as string
    expect(database.getAgentRunDetail(runId).run).toMatchObject({ status: 'draft', draftPrompt: '整理现有宣传素材。' })
    expect(database.getAgentRunDetail(runId).messages).toEqual([])
    expect(database.listDecisions().find((item) => item.id === decision.id)?.status).toBe('in_progress')
    database.close()
  })

  it('reuses a matching recent Agent Run when executing a delayed proposal', async () => {
    const { database, actions, dispatcher } = setup()
    const state = actions.createTurnState()
    await callTool(actions, state, 'ask_user', {
      title: '创建 Vows Agent Run',
      description: '创建 Draft 并预填任务说明。',
      options: [{
        id: 'create',
        label: '创建并打开',
        style: 'primary',
        capability: 'agent-run.create',
        payload: {
          projectId: 'vows',
          decisionId: null,
          goalId: null,
          milestoneId: null,
          title: 'Vows 宣传素材',
          draftPrompt: '整理现有宣传素材。'
        }
      }]
    })
    const existing = dispatcher.createDraft({
      projectId: 'vows',
      title: 'Vows 宣传素材',
      draftPrompt: '整理现有宣传素材。'
    })
    const message = database.createBriefingMessage({
      id: 'assistant-reuse-run', briefingId: null, role: 'assistant', content: '请确认。', attachments: [],
      taskContext: null, actions: state.proposals, createdAt: new Date().toISOString()
    })

    const result = await actions.executeProposal({ messageId: message.id, proposalId: state.proposals[0].id, optionId: 'create' })

    expect(result.navigation).toMatchObject({ kind: 'agent-run', id: existing.run.id })
    expect(result.notice).toContain('避免重复创建')
    expect(database.listRuns()).toHaveLength(1)
    database.close()
  })

  it('cancels a confirmed Agent Run send when the phone command stops', async () => {
    const { database, actions, dispatcher } = setup()
    const run = dispatcher.createDraft({
      projectId: 'vows',
      title: '可取消的 Run',
      draftPrompt: '等待确认。'
    })
    let receivedSignal: AbortSignal | undefined
    vi.spyOn(dispatcher, 'sendMessage').mockImplementation(async (...args) => {
      receivedSignal = args[5]
      await new Promise<void>((_resolve, reject) => {
        receivedSignal?.addEventListener('abort', () => reject(receivedSignal?.reason), { once: true })
      })
      return run
    })
    const state = actions.createTurnState()
    await callTool(actions, state, 'ask_user', {
      title: '继续 Agent Run',
      description: '向已有 Run 发送消息。',
      options: [{
        id: 'send',
        label: '发送',
        style: 'primary',
        capability: 'agent-run.send',
        payload: { runId: run.run.id, prompt: '继续处理。' }
      }]
    })
    const message = database.createBriefingMessage({
      id: 'assistant-cancel-run-send', briefingId: null, role: 'assistant', content: '请确认。', attachments: [],
      taskContext: null, actions: state.proposals, createdAt: new Date().toISOString()
    })
    const cancellationController = new AbortController()

    const executing = actions.executeProposal({
      messageId: message.id,
      proposalId: state.proposals[0].id,
      optionId: 'send'
    }, cancellationController.signal)
    await vi.waitFor(() => expect(receivedSignal).toBe(cancellationController.signal))
    cancellationController.abort(new Error('账户连接已停止，这次手机操作未继续执行。'))

    await expect(executing).rejects.toThrow('账户连接已停止')
    expect(database.getBriefingMessage(message.id)?.actions?.[0].status).toBe('pending')
    database.close()
  })

  it('open_agent_run only attaches a link and does not change Run or inbox state', async () => {
    const { database, actions, dispatcher } = setup()
    const decision = database.createDecision({ projectId: 'roombase', title: '处理 PR #352', summary: 'Review 待处理。' })
    const detail = dispatcher.createDraft({
      projectId: 'roombase', decisionId: decision.id, title: '处理 PR #352', draftPrompt: '检查 Review。'
    })
    const state = actions.createTurnState()

    await callTool(actions, state, 'open_agent_run', { runId: detail.run.id })

    expect(state.linkedRunId).toBe(detail.run.id)
    expect(database.getAgentRun(detail.run.id).status).toBe('draft')
    expect(database.listDecisions().find((item) => item.id === decision.id)?.status).toBe('inbox')
    database.close()
  })
})
