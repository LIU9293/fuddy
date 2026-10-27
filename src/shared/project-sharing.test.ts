import { describe, expect, it } from 'vitest'
import { testProject } from '../main/test-support/project-fixtures'
import type { AgentRun, AgentRunMessage } from './contracts'
import { canAccessSharedProject, sharedChatView, sharedMessageView, sharedProjectView } from './project-sharing'

describe('project sharing contract', () => {
  it('keeps member actions scoped to their own chats and turns', () => {
    expect(canAccessSharedProject('member', 'create-chat', 'member')).toBe(true)
    expect(canAccessSharedProject('member', 'send-message', 'member')).toBe(true)
    expect(canAccessSharedProject('member', 'rename-chat', 'member', 'member')).toBe(true)
    expect(canAccessSharedProject('member', 'stop-turn', 'member', 'owner')).toBe(false)
    expect(canAccessSharedProject('member', 'archive-chat', 'member', null)).toBe(false)
    expect(canAccessSharedProject('member', 'edit-project', 'member')).toBe(false)
    expect(canAccessSharedProject('member', 'manage-members', 'member')).toBe(false)
    expect(canAccessSharedProject(null, 'view', 'outsider')).toBe(false)
    expect(canAccessSharedProject('owner', 'stop-turn', 'owner', 'member')).toBe(true)
  })

  it('publishes only explicit project, chat, and message fields', () => {
    const project = testProject('private-id', 'Shared project', '/private/source')
    project.shared = { id: 'shared-id', revision: 1, author: 'owner' }
    project.profile.dataSources = ['private-production']
    expect(sharedProjectView(project)).toEqual({
      id: 'shared-id', revision: 1, name: 'Shared project', icon: null, summary: project.summary,
      status: 'active', productType: '测试项目', stage: '验证'
    })
    const run: AgentRun = {
      id: 'run', projectId: 'private-id', provider: 'codex', title: 'Discussion',
      status: 'idle', sessionId: 'secret-native-session', workingDirectory: '/private/source',
      startedAt: null, completedAt: null, summary: '', draftPrompt: null,
      createdAt: '2026-09-23T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z',
      createdByUserId: 'member', createdBySnapshot: { displayName: 'Kai', avatarRef: null },
      visibility: 'published'
    }
    expect(sharedChatView(run, 'shared-id')).toEqual({
      id: 'run', projectId: 'shared-id', title: 'Discussion', status: 'idle', provider: 'codex',
      createdByUserId: 'member', createdBySnapshot: { displayName: 'Kai', avatarRef: null },
      createdAt: run.createdAt, updatedAt: run.updatedAt, archivedAt: null
    })
    expect(() => sharedChatView({ ...run, visibility: 'draft' }, 'shared-id')).toThrow('草稿')
    const message: AgentRunMessage = {
      id: 'message', runId: 'run', role: 'user', content: 'Help', eventType: null,
      toolName: null, metadata: { rawToolInput: 'secret' }, createdAt: run.createdAt,
      authorUserId: 'member', authorSnapshot: { displayName: 'Kai', avatarRef: null }
    }
    expect(sharedMessageView(message)).toEqual({
      id: 'message', runId: 'run', role: 'user', content: 'Help', authorUserId: 'member',
      authorSnapshot: { displayName: 'Kai', avatarRef: null }, createdAt: run.createdAt
    })
    expect(sharedMessageView({ ...message, role: 'tool' })).toBeNull()
    expect(sharedMessageView({ ...message, role: 'assistant', eventType: 'reasoning' })).toBeNull()
  })
})
