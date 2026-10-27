import type { ChatAttachmentInput } from './chat-attachments'
import type { ChatAuthorSnapshot } from './project-sharing'

export type AgentTurnQueueStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export interface AgentTurnQueueItem {
  requestId: string
  runId: string
  prompt: string
  attachments: ChatAttachmentInput[]
  requestedByUserId: string | null
  authorSnapshot: ChatAuthorSnapshot | null
  status: AgentTurnQueueStatus
  enqueuedAt: string
  startedAt: string | null
  settledAt: string | null
}

export type AgentTurnQueueSummary = Pick<AgentTurnQueueItem,
  'requestId' | 'runId' | 'prompt' | 'requestedByUserId' | 'authorSnapshot' | 'status' | 'enqueuedAt'> & {
    attachmentCount: number
  }
