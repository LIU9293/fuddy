import type { ChatAuthorSnapshot } from '../../shared/project-sharing'

export interface ConversationAuthorRecord {
  role: string
  authorUserId?: string | null
  authorSnapshot?: ChatAuthorSnapshot | null
}

export interface ConversationAuthors {
  showSpeakers: boolean
  speaker: (message: ConversationAuthorRecord) => { label: string; isSelf: boolean }
}

export function conversationAuthors(
  messages: readonly ConversationAuthorRecord[],
  currentUser: { id?: string | null; displayName?: string | null },
  creator?: { userId?: string | null; snapshot?: ChatAuthorSnapshot | null }
): ConversationAuthors {
  const participants = new Set<string>()
  const names = new Map<string, string>()
  if (creator?.userId && creator.snapshot?.displayName.trim()) {
    names.set(creator.userId, creator.snapshot.displayName.trim())
  }
  for (const message of messages) {
    if (message.role !== 'user') continue
    const name = message.authorSnapshot?.displayName.trim()
    if (message.authorUserId) {
      participants.add(`user:${message.authorUserId}`)
      if (name) names.set(message.authorUserId, name)
    } else if (name) {
      participants.add(`name:${name}`)
    }
    // Legacy messages without identity are not evidence of another participant.
    // Keep them unattributed rather than assigning them to the signed-in user.
  }
  return {
    showSpeakers: participants.size > 1,
    speaker(message) {
      const isSelf = Boolean(currentUser.id && message.authorUserId === currentUser.id)
      const label = message.authorSnapshot?.displayName.trim()
        || (message.authorUserId ? names.get(message.authorUserId) : undefined)
        || (isSelf ? currentUser.displayName?.trim() : undefined)
        || (message.authorUserId ? `用户 ${message.authorUserId.slice(0, 6)}` : '未记录发送者')
      return { label, isSelf }
    }
  }
}
