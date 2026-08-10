import { describe, expect, it } from 'vitest'
import type { AgentRunMessage, AgentRunStreamUpdate } from '../../../shared/contracts'
import {
  applyAgentLiveUpdate,
  findArtifactForHref,
  formatAgentProcessDuration,
  groupLiveActivities,
  groupMessageTimeline,
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
