import type { AgentRunMessage } from './contracts'

/** Native T3 ordinals describe placement even when a tool result is persisted later. */
export function orderTimelineItems<T>(items: readonly T[], ordinal: (item: T) => number | undefined): T[] {
  const projected = items.flatMap(item => {
    const position = ordinal(item)
    return position === undefined ? [] : [{ item, position }]
  }).sort((left, right) => left.position - right.position)
  let next = 0
  return items.map(item => ordinal(item) === undefined ? item : projected[next++].item)
}

export function timelineMessageOrdinal(message: AgentRunMessage): number | undefined {
  const ordinal = message.metadata?.timelineOrdinal
  return typeof ordinal === 'number' && Number.isSafeInteger(ordinal) ? ordinal : undefined
}

export function orderTimelineMessages(messages: readonly AgentRunMessage[]): AgentRunMessage[] {
  const result: AgentRunMessage[] = []
  let turn: AgentRunMessage[] = []
  for (const message of messages) {
    // A Steer belongs inside the current response, as in T3's timelineEntryStartsResponse.
    if (message.role === 'user' && message.metadata?.steered !== true) {
      result.push(...orderTimelineItems(turn, timelineMessageOrdinal), message)
      turn = []
    } else turn.push(message)
  }
  return [...result, ...orderTimelineItems(turn, timelineMessageOrdinal)]
}
