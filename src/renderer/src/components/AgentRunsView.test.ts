import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentRunMessage, AgentRunStreamUpdate } from '../../../shared/contracts'
import {
  applyAgentLiveUpdate,
  applyAgentLiveUpdateForRun,
  findArtifactForHref,
  formatAgentProcessDuration,
  groupLiveActivities,
  groupLiveActivityStages,
  groupMessageTimeline,
  RunLiveActivity,
  shouldBlockAgentRunDetailRefresh,
  type LiveActivity
} from './AgentRunsView'

function apply(updates: AgentRunStreamUpdate[]): LiveActivity[] {
  return updates.reduce(applyAgentLiveUpdate, [] as LiveActivity[])
}

function message(input: Partial<AgentRunMessage> & Pick<AgentRunMessage, 'id' | 'role' | 'createdAt'>): AgentRunMessage {
  return {
    runId: 'run-1',
    content: input.id,
    eventType: null,
    toolName: null,
    metadata: null,
    ...input
  }
}

describe('Agent Run live activity timeline', () => {
  it('keeps the current conversation mounted during background detail refreshes', () => {
    expect(shouldBlockAgentRunDetailRefresh('run-1', 'run-1')).toBe(false)
    expect(shouldBlockAgentRunDetailRefresh(null, 'run-1')).toBe(true)
    expect(shouldBlockAgentRunDetailRefresh('run-1', 'run-2')).toBe(true)
  })

  it('keeps live messages scoped to the Agent Run that emitted them', () => {
    const withFirstRun = applyAgentLiveUpdateForRun({}, 'run-1', {
      type: 'reasoning_delta',
      segmentId: 'thinking-1',
      delta: '正在检查第一个 Run。'
    })
    const withBothRuns = applyAgentLiveUpdateForRun(withFirstRun, 'run-2', {
      type: 'message_delta',
      messageId: 'message-2',
      delta: '第二个 Run 的回复'
    })

    expect(withBothRuns['run-1']).toMatchObject({
      streamingText: '',
      activities: [{ kind: 'thinking', value: { content: '正在检查第一个 Run。' } }]
    })
    expect(withBothRuns['run-2']).toMatchObject({
      streamingText: '第二个 Run 的回复',
      activities: []
    })
  })

  it('renders streamed assistant text before the final response is persisted', () => {
    const markup = renderToStaticMarkup(createElement(RunLiveActivity, {
      activities: [],
      streamingText: '正在检查 Cron 运行状态…',
      approval: null,
      onApproval: async () => undefined
    }))

    expect(markup).toContain('正在检查 Cron 运行状态…')
    expect(markup).not.toContain('正在思考…')
  })

  it('turns commentary into an activity when the final answer starts streaming', () => {
    const commentary = applyAgentLiveUpdateForRun({}, 'run-1', {
      type: 'message_delta',
      messageId: 'commentary-1',
      phase: 'commentary',
      delta: '先检查运行环境。'
    })
    const finalAnswer = applyAgentLiveUpdateForRun(commentary, 'run-1', {
      type: 'message_delta',
      messageId: 'answer-1',
      phase: 'final_answer',
      delta: '检查完成。'
    })

    expect(finalAnswer['run-1']).toMatchObject({
      streamingText: '检查完成。',
      streamingPhase: 'final_answer',
      activities: [{ kind: 'thinking', value: { content: '先检查运行环境。' } }]
    })
  })

  it('matches relative and absolute Markdown links to registered artifacts', () => {
    const artifacts = [{
      id: 'artifact-1',
      runId: 'run-1',
      projectId: 'vows',
      relativePath: 'marketing/launch plan.md',
      label: 'launch plan.md',
      mimeType: 'text/markdown',
      createdAt: '2026-08-10T00:00:00.000Z'
    }]

    expect(findArtifactForHref(artifacts, 'marketing/launch%20plan.md')?.id).toBe('artifact-1')
    expect(findArtifactForHref(artifacts, 'file:///tmp/project/marketing/launch%20plan.md')?.id).toBe('artifact-1')
    expect(findArtifactForHref(artifacts, '../launch%20plan.md', 'marketing/drafts/notes.md')?.id).toBe('artifact-1')
    expect(findArtifactForHref(artifacts, 'https://example.com')).toBeNull()
  })

  it('keeps each thinking segment beside its following tool call', () => {
    const activities = apply([
      { type: 'reasoning_delta', segmentId: 'thinking-1', delta: '先检查项目说明。' },
      { type: 'reasoning_delta', segmentId: 'thinking-1', delta: '然后读取配置。' },
      { type: 'tool', toolCallId: 'tool-1', toolName: 'Read', status: 'running', detail: '{"file":"AGENTS.md"}' },
      { type: 'tool', toolCallId: 'tool-1', toolName: 'Read', status: 'completed', detail: '项目说明内容' },
      { type: 'reasoning_delta', segmentId: 'thinking-2', delta: '接下来检查数据库连接。' },
      { type: 'tool', toolCallId: 'tool-2', toolName: 'Bash', status: 'running', detail: 'psql --version' }
    ])

    expect(activities.map((activity) => activity.kind)).toEqual(['thinking', 'tool', 'thinking', 'tool'])
    expect(activities[0]).toMatchObject({ kind: 'thinking', value: { content: '先检查项目说明。然后读取配置。', status: 'completed' } })
    expect(activities[1]).toMatchObject({ kind: 'tool', value: { id: 'tool-1', detail: '项目说明内容', status: 'completed' } })
    expect(activities[2]).toMatchObject({ kind: 'thinking', value: { content: '接下来检查数据库连接。', status: 'completed' } })
    expect(activities[3]).toMatchObject({ kind: 'tool', value: { id: 'tool-2', status: 'running' } })

    const blocks = groupLiveActivities(activities)
    expect(blocks.map((block) => block.kind)).toEqual(['thinking', 'tool-group', 'thinking', 'tool-group'])
    expect(blocks[1]).toMatchObject({ kind: 'tool-group', values: [{ id: 'tool-1' }] })
    expect(blocks[3]).toMatchObject({ kind: 'tool-group', values: [{ id: 'tool-2' }] })
  })

  it('groups only the consecutive tool calls between two thinking segments', () => {
    const activities = apply([
      { type: 'reasoning_delta', segmentId: 'thinking-1', delta: '先收集上下文。' },
      { type: 'tool', toolCallId: 'tool-1', toolName: 'Read', status: 'completed', detail: 'AGENTS.md' },
      { type: 'tool', toolCallId: 'tool-2', toolName: 'Read', status: 'completed', detail: 'package.json' },
      { type: 'reasoning_delta', segmentId: 'thinking-2', delta: '再核对实现。' },
      { type: 'tool', toolCallId: 'tool-3', toolName: 'Bash', status: 'completed', detail: 'npm test' }
    ])

    const blocks = groupLiveActivities(activities)
    expect(blocks).toHaveLength(4)
    expect(blocks[1]).toMatchObject({ kind: 'tool-group', values: [{ id: 'tool-1' }, { id: 'tool-2' }] })
    expect(blocks[3]).toMatchObject({ kind: 'tool-group', values: [{ id: 'tool-3' }] })
  })

  it.each([
    {
      provider: 'Codex',
      updates: [
        { type: 'reasoning_delta', segmentId: 'codex-summary-1', delta: '先定位数据库迁移。' },
        { type: 'tool', toolCallId: 'codex-command-1', toolName: 'command', status: 'completed', detail: 'rg schemaVersion src/main' },
        { type: 'reasoning_delta', segmentId: 'codex-summary-2', delta: '找到缺失的 v4 迁移，补测试。' },
        { type: 'tool', toolCallId: 'codex-file-1', toolName: 'edit', status: 'completed', detail: '{"path":"database-schema.ts"}' }
      ]
    },
    {
      provider: 'Claude Code',
      updates: [
        { type: 'reasoning_delta', segmentId: 'claude-thinking-0', delta: '先梳理组件边界。' },
        { type: 'tool', toolCallId: 'claude-read-1', toolName: 'Read', status: 'completed', detail: '{"file_path":"/repo/RootViews.swift"}' },
        { type: 'tool', toolCallId: 'claude-edit-1', toolName: 'Edit', status: 'completed', detail: '{"file_path":"/repo/RootViews.swift"}' },
        { type: 'reasoning_delta', segmentId: 'claude-thinking-1', delta: '再验证移动端分组。' }
      ]
    },
    {
      provider: 'OpenCode',
      updates: [
        { type: 'reasoning_delta', segmentId: 'opencode-reasoning-1', delta: '先核对依赖与审计结果。' },
        { type: 'tool', toolCallId: 'opencode-read-1', toolName: 'read', status: 'completed', detail: '{"status":"completed","input":{"filePath":"/repo/package.json"}}' },
        { type: 'tool', toolCallId: 'opencode-bash-1', toolName: 'bash', status: 'failed', detail: '{"status":"error","input":{"command":"npm audit"}}' }
      ]
    }
  ] as const)('normalizes $provider replay into the same stage structure', ({ updates }) => {
    const stages = groupLiveActivityStages(apply([...updates]))
    expect(stages.length).toBeGreaterThan(0)
    expect(stages[0].thinking?.content).toBeTruthy()
    expect(stages.flatMap((stage) => stage.tools).every((tool) => tool.label && tool.summary)).toBe(true)
    expect(stages.flatMap((stage) => stage.tools).every((tool) => !tool.summary.includes('status'))).toBe(true)
  })

  it('does not merge separate same-name tool calls without provider IDs', () => {
    const activities = apply([
      { type: 'tool', toolName: 'Read', status: 'completed', detail: 'first' },
      { type: 'tool', toolName: 'Read', status: 'completed', detail: 'second' }
    ])

    expect(activities).toHaveLength(2)
    expect(activities.map((activity) => activity.kind === 'tool' ? activity.value.detail : '')).toEqual(['first', 'second'])
  })

  it('collapses the completed thinking and tool process before a result message', () => {
    const blocks = groupMessageTimeline([
      message({ id: 'user', role: 'user', createdAt: '2026-08-09T00:00:00.000Z' }),
      message({ id: 'thinking', role: 'assistant', eventType: 'reasoning', createdAt: '2026-08-09T00:00:01.000Z' }),
      message({ id: 'tool', role: 'tool', toolName: 'Bash', createdAt: '2026-08-09T00:00:15.000Z' }),
      message({ id: 'result', role: 'assistant', createdAt: '2026-08-09T00:01:05.000Z' })
    ])

    expect(blocks.map((block) => block.kind)).toEqual(['message', 'process', 'message'])
    expect(blocks[1]).toMatchObject({ kind: 'process', values: [{ id: 'thinking' }, { id: 'tool' }] })
    expect(formatAgentProcessDuration('2026-08-09T00:00:01.000Z', '2026-08-09T00:01:05.000Z')).toBe('耗时 1 分 4 秒')
  })

  it('keeps unfinished process messages visible instead of collapsing them', () => {
    const blocks = groupMessageTimeline([
      message({ id: 'thinking', role: 'assistant', eventType: 'reasoning', createdAt: '2026-08-09T00:00:01.000Z' }),
      message({ id: 'tool', role: 'tool', toolName: 'Read', createdAt: '2026-08-09T00:00:02.000Z' })
    ])

    expect(blocks.map((block) => block.kind)).toEqual(['message', 'tool-group'])
  })
})
