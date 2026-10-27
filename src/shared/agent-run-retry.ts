import type { AgentRunMessage } from './contracts'

/** A retry reuses its user message, so feedback before the next user replaces its error. */
export function withoutSupersededRunErrors(messages: AgentRunMessage[], hasLiveFeedback = false): AgentRunMessage[] {
  let hasFeedback = hasLiveFeedback
  let hasNewerError = false
  return messages.toReversed().filter(message => {
    if (message.role === 'user') {
      hasFeedback = false
      hasNewerError = false
    } else if (message.role === 'system' && message.eventType === 'error') {
      const superseded = hasFeedback || hasNewerError
      hasNewerError = true
      return !superseded
    } else if (message.role === 'tool' || (message.role === 'assistant' && message.content.trim())) {
      hasFeedback = true
    }
    return true
  }).reverse()
}

/** Only the latest failed turn can be retried; legacy errors lack requestId. */
export function agentRunRetryTarget(messages: AgentRunMessage[]): {
  error: AgentRunMessage
  userMessage: AgentRunMessage
} | null {
  const errorIndex = messages.findLastIndex(message => message.role === 'system' && message.eventType === 'error')
  if (errorIndex < 0 || messages.slice(errorIndex + 1).some(message => message.role === 'user' || message.role === 'assistant')) return null
  const error = messages[errorIndex]
  const beforeError = messages.slice(0, errorIndex)
  const userMessage = error.requestId
    ? beforeError.findLast(message => message.role === 'user' && (message.id === error.requestId || message.requestId === error.requestId))
    : beforeError.findLast(message => message.role === 'user')
  return userMessage ? { error, userMessage } : null
}
