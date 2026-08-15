import type { AgentRunMessage, BriefingMessage, MorningBriefing } from './contracts'
import type { CompanionChatPage, CompanionChatRecord } from './companion-sync'

export const companionInitialChatBlockLimit = 100
export const companionMaximumChatPageLimit = 100
export const workAssistantChatId = 'work-assistant'

function compareChronologically(
  left: { createdAt: string; id: string },
  right: { createdAt: string; id: string }
): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
}

export function buildWorkAssistantChatRecords(
  messages: BriefingMessage[],
  briefings: MorningBriefing[]
): CompanionChatRecord[] {
  const messageRecords = messages.map((message): CompanionChatRecord => ({
    id: `assistant-message-${message.id}`,
    chatId: workAssistantChatId,
    chatKind: 'assistant',
    kind: 'message',
    createdAt: message.createdAt,
    completedAt: null,
    assistantMessage: message,
    agentMessages: [],
    morningBriefing: null
  }))
  const briefingRecords = briefings
    .filter((briefing) => briefing.status === 'completed')
    .map((briefing): CompanionChatRecord => ({
      id: `morning-briefing-${briefing.id}`,
      chatId: workAssistantChatId,
      chatKind: 'assistant',
      kind: 'briefing',
      createdAt: briefing.generatedAt,
      completedAt: null,
      assistantMessage: null,
      agentMessages: [],
      morningBriefing: briefing
    }))
  return [...messageRecords, ...briefingRecords].sort(compareChronologically)
}

export function buildAgentChatRecords(runId: string, messages: AgentRunMessage[]): CompanionChatRecord[] {
  const records: CompanionChatRecord[] = []
  let processMessages: AgentRunMessage[] = []

  const appendProcess = (completedAt: string | null): void => {
    if (processMessages.length === 0) return
    records.push({
      id: `process-${processMessages[0].id}`,
      chatId: runId,
      chatKind: 'agent',
      kind: 'process',
      createdAt: processMessages[0].createdAt,
      completedAt,
      assistantMessage: null,
      agentMessages: processMessages,
      morningBriefing: null
    })
    processMessages = []
  }

  for (const message of messages) {
    if (message.eventType === 'reasoning' || message.role === 'tool') {
      processMessages.push(message)
      continue
    }
    appendProcess(message.role === 'assistant' ? message.createdAt : null)
    records.push({
      id: `agent-message-${message.id}`,
      chatId: runId,
      chatKind: 'agent',
      kind: 'message',
      createdAt: message.createdAt,
      completedAt: null,
      assistantMessage: null,
      agentMessages: [message],
      morningBriefing: null
    })
  }
  appendProcess(null)
  return records
}

export function paginateCompanionChatRecords(
  chatId: string,
  chatKind: CompanionChatPage['chatKind'],
  records: CompanionChatRecord[],
  options: { before?: string | null; limit?: number } = {}
): CompanionChatPage {
  const limit = Math.min(
    companionMaximumChatPageLimit,
    Math.max(1, Math.trunc(options.limit ?? companionInitialChatBlockLimit))
  )
  const end = options.before
    ? records.findIndex((record) => record.id === options.before)
    : records.length
  if (end < 0) throw new Error('聊天历史游标已失效，请刷新后重试。')
  const start = Math.max(0, end - limit)
  const pageRecords = records.slice(start, end)
  const hasMore = start > 0
  return {
    chatId,
    chatKind,
    records: pageRecords,
    hasMore,
    nextBefore: hasMore ? pageRecords[0]?.id ?? null : null
  }
}

export function flattenAgentChatRecords(records: CompanionChatRecord[]): AgentRunMessage[] {
  return records.flatMap((record) => record.agentMessages)
}

export function workAssistantPageCollections(page: CompanionChatPage): {
  messages: BriefingMessage[]
  briefings: MorningBriefing[]
} {
  return {
    messages: page.records.flatMap((record) => record.assistantMessage ? [record.assistantMessage] : []),
    briefings: page.records.flatMap((record) => record.morningBriefing ? [record.morningBriefing] : [])
  }
}
