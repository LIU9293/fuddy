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
  hasVisibleRunFeedback,
  RunLiveActivity,
  shouldBlockAgentRunDetailRefresh,
  visibleLiveActivities,
  visibleRunMessages,
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

  it('keeps every operation and progress segment visible past sixteen activities', () => {
    let states = applyAgentLiveUpdateForRun({}, 'run-1', { type: 'status', status: 'running' })
    for (let index = 0; index < 24; index += 1) {
      states = applyAgentLiveUpdateForRun(states, 'run-1', {
        type: 'reasoning_delta', segmentId: `progress-${index}`, delta: `检查第 ${index + 1} 个文件。`
      })
      for (const status of ['running', 'completed'] as const) {
        states = applyAgentLiveUpdateForRun(states, 'run-1', {
          type: 'tool', toolCallId: `read-${index}`, toolName: 'Read', status, detail: `file-${index}.ts`
        })
      }
    }

    const stages = groupLiveActivityStages(states['run-1'].activities)
    expect(stages).toHaveLength(24)
    expect(stages[0]).toMatchObject({ thinking: { content: '检查第 1 个文件。' }, tools: [{ id: 'read-0' }] })
    expect(stages.at(-1)).toMatchObject({ thinking: { content: '检查第 24 个文件。' }, tools: [{ id: 'read-23' }] })
  })

  it('keeps parallel tools running until their own terminal update', () => {
    const running = apply([
      { type: 'tool', toolCallId: 'read-1', toolName: 'Read', status: 'running', detail: 'first.ts' },
      { type: 'tool', toolCallId: 'read-2', toolName: 'Read', status: 'running', detail: 'second.ts' },
      { type: 'message_delta', messageId: 'progress', delta: '正在读取两个文件。' }
    ])
    expect(running.filter(activity => activity.kind === 'tool').map(activity => activity.value.status))
      .toEqual(['running', 'running'])
    const oneFinished = applyAgentLiveUpdate(running, {
      type: 'tool', toolCallId: 'read-1', toolName: 'Read', status: 'completed', detail: 'first.ts'
    })
    expect(oneFinished.filter(activity => activity.kind === 'tool').map(activity => activity.value.status))
      .toEqual(['completed', 'running'])
    const failed = applyAgentLiveUpdate(oneFinished, {
      type: 'tool', toolCallId: 'read-2', toolName: 'Read', status: 'failed', detail: 'second.ts'
    })
    expect(failed.filter(activity => activity.kind === 'tool').map(activity => activity.value.status))
      .toEqual(['completed', 'failed'])
    expect(applyAgentLiveUpdate(running, { type: 'status', status: 'idle' })
      .filter(activity => activity.kind === 'tool').map(activity => activity.value.status)).toEqual(['completed', 'completed'])
  })

  it('refreshes a tool summary as its details arrive', () => {
    const activities = apply([
      { type: 'tool', toolCallId: 'read-1', toolName: 'Read', status: 'running', detail: '{}' },
      { type: 'tool', toolCallId: 'read-1', toolName: 'Read', status: 'running', detail: '{"file_path":"src/main.ts"}' }
    ])
    expect(activities).toHaveLength(1)
    expect(activities[0]).toMatchObject({ kind: 'tool', value: { summary: expect.stringContaining('main.ts'), status: 'running' } })
    const completed = applyAgentLiveUpdate(activities, {
      type: 'tool', toolCallId: 'read-1', toolName: 'Read', status: 'completed',
      detail: '{"file_path":"src/main.ts"}\n\nconst outputShouldStayCollapsed = true'
    })
    expect(completed[0]).toMatchObject({ kind: 'tool', value: { summary: 'main.ts', status: 'completed' } })
  })

  it('does not duplicate the sending turn after switching Chats and reloading persisted operations', () => {
    const saved = [
      message({ id: 'previous-user', role: 'user', createdAt: '1' }),
      message({ id: 'previous-tool', role: 'tool', createdAt: '2' }),
      message({ id: 'previous-answer', role: 'assistant', createdAt: '3' }),
      message({ id: 'current-user', role: 'user', createdAt: '4' }),
      message({ id: 'current-progress', role: 'assistant', eventType: 'reasoning', createdAt: '5' }),
      message({ id: 'current-tool', role: 'tool', createdAt: '6' }),
      message({ id: 'steer-user', role: 'user', createdAt: '7' })
    ]
    expect(visibleRunMessages('claude', saved, true, 'current-user').map(item => item.id))
      .toEqual(['previous-user', 'previous-tool', 'previous-answer', 'current-user', 'steer-user'])
    expect(visibleRunMessages('claude', saved)).toEqual(saved)
    expect(visibleRunMessages('claude', saved, true, 'unrelated-request')).toEqual(saved)
    expect(saved).toHaveLength(7)
  })

  it('keeps the original retry input and removes its persisted retry process from the live timeline', () => {
    const saved = [
      message({ id: 'retry-user', role: 'user', createdAt: '1' }),
      message({ id: 'retry-error', role: 'system', eventType: 'error', createdAt: '2' }),
      message({ id: 'retry-tool', role: 'tool', createdAt: '3' })
    ]
    expect(visibleRunMessages('claude', saved, true, 'retry-user').map(item => item.id)).toEqual(['retry-user'])
    expect(visibleRunMessages('claude', saved).map(item => item.id)).toEqual(['retry-user', 'retry-tool'])
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

  it('renders the initial thinking state as a compact progress row', () => {
    const markup = renderToStaticMarkup(createElement(RunLiveActivity, {
      activities: [],
      streamingText: '',
      approval: null,
      onApproval: async () => undefined
    }))

    expect(markup).toContain('agent-run-live-idle')
    expect(markup).toContain('spin')
    expect(markup).toContain('<span>正在思考…</span>')
  })

  it('hides only Claude SDK thinking in live and saved timelines', () => {
    const saved = [
      message({ id: 'thinking', role: 'assistant', eventType: 'reasoning', content: 'Long English summary', metadata: { segmentId: 'claude-thinking-0' }, createdAt: '2026-09-29T00:00:00.000Z' }),
      message({ id: 'progress', role: 'assistant', eventType: 'reasoning', content: '先读取项目说明。', metadata: { segmentId: 'visible-thinking-0' }, createdAt: '2026-09-29T00:00:01.000Z' }),
      message({ id: 'tool', role: 'tool', eventType: 'tool', toolName: 'Read', createdAt: '2026-09-29T00:00:02.000Z' }),
      message({ id: 'answer', role: 'assistant', content: '检查完成。', createdAt: '2026-09-29T00:00:03.000Z' })
    ]
    const live = apply([
      { type: 'reasoning_delta', segmentId: 'claude-thinking-0', delta: 'Long English summary' },
      { type: 'tool', toolCallId: 'read-1', toolName: 'Read', status: 'completed', detail: 'README.md' },
      { type: 'reasoning_delta', segmentId: 'visible-thinking-0', delta: '先读取项目说明。' }
    ])

    expect(visibleRunMessages('claude', saved).map(({ id }) => id)).toEqual(['progress', 'tool', 'answer'])
    expect(visibleLiveActivities('claude', live).map(({ kind }) => kind)).toEqual(['tool', 'thinking'])
    expect(visibleRunMessages('codex', saved)).toEqual(saved)
    expect(visibleLiveActivities('codex', live)).toEqual(live)
  })

  it('keeps the retry error while waiting and removes it on visible streamed feedback', () => {
    const saved = [
      message({ id: 'user', role: 'user', createdAt: '1' }),
      message({ id: 'error', role: 'system', eventType: 'error', createdAt: '2' })
    ]
    const hiddenThinking = apply([{ type: 'reasoning_delta', segmentId: 'claude-thinking-0', delta: 'SDK fixture' }])
    expect(hasVisibleRunFeedback('claude', [], '  ', null)).toBe(false)
    expect(hasVisibleRunFeedback('claude', hiddenThinking, '', null)).toBe(false)
    expect(visibleRunMessages('claude', saved)).toEqual(saved)
    const tool = apply([{ type: 'tool', toolCallId: 'read-1', toolName: 'Read', status: 'running', detail: 'README.md' }])
    const feedback = hasVisibleRunFeedback('claude', tool, '', null)
    expect(feedback).toBe(true)
    expect(hasVisibleRunFeedback('claude', [], '正在读取文件', null)).toBe(true)
    expect(hasVisibleRunFeedback('claude', apply([{ type: 'reasoning_delta', delta: '检查项目说明' }]), '', null)).toBe(true)
    expect(visibleRunMessages('claude', saved, feedback).map(item => item.id)).toEqual(['user'])
    expect(saved.map(item => item.id)).toEqual(['user', 'error'])
  })

  it('removes the retry error in saved history after a tool, progress or final reply', () => {
    const saved = [
      message({ id: 'user', role: 'user', createdAt: '1' }),
      message({ id: 'error', role: 'system', eventType: 'error', createdAt: '2' })
    ]
    for (const provider of ['claude', 'codex', 'opencode', 'pi'] as const) {
      for (const response of [
        message({ id: 'response', role: 'tool', eventType: 'tool', createdAt: '3' }),
        message({ id: 'response', role: 'assistant', eventType: 'reasoning', createdAt: '3' }),
        message({ id: 'response', role: 'assistant', createdAt: '3' })
      ]) {
        expect(visibleRunMessages(provider, [...saved, response]).map(item => item.id)).toEqual(['user', 'response'])
      }
    }
  })

  it('shows only the new retry failure and preserves failed turns before a new user message', () => {
    const saved = [
      message({ id: 'user', role: 'user', createdAt: '1' }),
      message({ id: 'error', role: 'system', eventType: 'error', createdAt: '2' })
    ]
    const nextError = message({ id: 'next-error', role: 'system', eventType: 'error', createdAt: '4' })
    expect(visibleRunMessages('claude', [...saved, nextError]).map(item => item.id)).toEqual(['user', 'next-error'])
    const tool = message({ id: 'tool', role: 'tool', eventType: 'tool', createdAt: '3' })
    expect(visibleRunMessages('claude', [...saved, tool, nextError]).map(item => item.id)).toEqual(['user', 'tool', 'next-error'])
    const newUser = message({ id: 'new-user', role: 'user', createdAt: '3' })
    expect(visibleRunMessages('claude', [...saved, newUser], true).map(item => item.id)).toEqual(['user', 'error', 'new-user'])
    expect(visibleRunMessages('claude', [...saved, newUser, nextError]).map(item => item.id)).toEqual(['user', 'error', 'new-user', 'next-error'])
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

  it('shows a trailing disclosure chevron on collapsed tool groups', () => {
    const markup = renderToStaticMarkup(createElement(RunLiveActivity, {
      activities: apply([{ type: 'tool', toolCallId: 'tool-1', toolName: 'Bash', status: 'completed', detail: 'A long command summary' }]),
      streamingText: '',
      approval: null,
      onApproval: async () => undefined
    }))

    expect(markup).toContain('agent-tool-call-group-summary')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('agent-tool-call-chevron')
    expect(markup).toContain('lucide-chevron-right')
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
