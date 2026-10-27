import type { AgentRun, AgentRunMessage, Project } from './contracts'
import type { SharedAttachmentView } from './project-sharing-attachments'

export type ProjectShareRole = 'owner' | 'member'
export type ProjectShareAction =
  | 'view'
  | 'create-chat'
  | 'send-message'
  | 'rename-chat'
  | 'archive-chat'
  | 'cancel-turn'
  | 'stop-turn'
  | 'edit-project'
  | 'manage-members'
  | 'set-execution-host'

export interface ChatAuthorSnapshot {
  displayName: string
  avatarRef: string | null
}

export interface ChatActor {
  userId: string
  snapshot: ChatAuthorSnapshot
}

/** Permission decisions must be repeated by the service that owns the action. */
export function canAccessSharedProject(
  role: ProjectShareRole | null,
  action: ProjectShareAction,
  actorUserId: string,
  resourceOwnerUserId?: string | null
): boolean {
  if (!role || !actorUserId) return false
  if (role === 'owner') return true
  switch (action) {
    case 'view':
    case 'create-chat':
    case 'send-message':
      return true
    case 'rename-chat':
    case 'archive-chat':
    case 'cancel-turn':
    case 'stop-turn':
      return resourceOwnerUserId === actorUserId
    case 'edit-project':
    case 'manage-members':
    case 'set-execution-host':
      return false
  }
}

// These explicit allowlists are the input to the future project-scoped relay.
// Adding a field to Project, Run, or Message cannot silently publish it.
export interface SharedProjectView {
  id: string
  revision?: number
  name: string
  icon: string | null
  summary: string
  status: Project['status']
  productType: string
  stage: string
}

export function sharedProjectView(project: Project, shareId = project.shared?.id): SharedProjectView {
  if (!project.shared?.id) throw new Error('项目尚未注册共享身份。')
  if (!shareId) throw new Error('项目云端共享身份不存在。')
  return {
    id: shareId,
    revision: project.shared.revision,
    name: project.name,
    icon: project.icon ?? null,
    summary: project.summary,
    status: project.status,
    productType: project.profile.productType,
    stage: project.profile.stage
  }
}

export interface SharedChatView {
  id: string
  projectId: string
  title: string
  status: AgentRun['status']
  provider: AgentRun['provider']
  executionHostId?: string
  createdByUserId: string | null
  createdBySnapshot: ChatAuthorSnapshot | null
  createdAt: string
  updatedAt: string
  archivedAt?: string | null
}

export function sharedChatView(run: AgentRun, sharedProjectId: string, executionHostId?: string): SharedChatView {
  if (!run.projectId) throw new Error('只有项目 Chat 可以共享。')
  if (!sharedProjectId) throw new Error('项目尚未注册共享身份。')
  if (run.visibility === 'draft') throw new Error('草稿 Chat 尚未发布。')
  return {
    id: run.id,
    projectId: sharedProjectId,
    title: run.title,
    status: run.status,
    provider: run.provider,
    ...(executionHostId ? { executionHostId } : {}),
    createdByUserId: run.createdByUserId ?? null,
    createdBySnapshot: run.createdBySnapshot ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    archivedAt: run.archivedAt ?? null
  }
}

export interface SharedMessageView {
  id: string
  runId: string
  role: AgentRunMessage['role']
  content: string
  authorUserId: string | null
  authorSnapshot: ChatAuthorSnapshot | null
  createdAt: string
  attachments?: SharedAttachmentView[]
}

export function sharedMessageView(message: AgentRunMessage): SharedMessageView | null {
  if (message.role === 'tool' || message.role === 'system' || message.eventType === 'reasoning') return null
  return {
    id: message.id,
    runId: message.runId,
    role: message.role,
    content: message.content,
    authorUserId: message.authorUserId ?? null,
    authorSnapshot: message.authorSnapshot ?? null,
    createdAt: message.createdAt
  }
}
