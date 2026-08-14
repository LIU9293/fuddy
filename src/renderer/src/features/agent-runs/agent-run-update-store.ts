import type { AgentRunStreamEnvelope, AgentRunStreamUpdate } from '../../../../shared/contracts'

type AgentRunUpdateListener = (envelope: AgentRunStreamEnvelope) => void

export interface AgentRunUpdateStore {
  publish: (envelope: AgentRunStreamEnvelope) => void
  subscribe: (listener: AgentRunUpdateListener) => () => void
}

function isTerminalStatus(update: AgentRunStreamUpdate): boolean {
  return update.type === 'status' && update.status !== 'running' && update.status !== 'queued'
}

function appendUpdate(
  history: AgentRunStreamEnvelope[],
  envelope: AgentRunStreamEnvelope
): AgentRunStreamEnvelope[] {
  const previous = history.at(-1)
  const update = envelope.update
  if (previous?.update.type === 'message_delta' && update.type === 'message_delta'
    && previous.update.messageId === update.messageId
    && (previous.update.phase ?? null) === (update.phase ?? null)) {
    return [...history.slice(0, -1), {
      ...envelope,
      update: { ...update, delta: previous.update.delta + update.delta }
    }]
  }
  if (previous?.update.type === 'reasoning_delta' && update.type === 'reasoning_delta'
    && (previous.update.segmentId ?? null) === (update.segmentId ?? null)) {
    return [...history.slice(0, -1), {
      ...envelope,
      update: { ...update, delta: previous.update.delta + update.delta }
    }]
  }
  return [...history, envelope].slice(-128)
}

function isSameToolCall(first: AgentRunStreamUpdate, second: AgentRunStreamUpdate): boolean {
  if (first.type !== 'tool' || second.type !== 'tool') return false
  if (first.toolCallId && second.toolCallId) return first.toolCallId === second.toolCallId
  return first.toolName === second.toolName
}

function appendReplayableUpdate(
  history: AgentRunStreamEnvelope[],
  envelope: AgentRunStreamEnvelope
): AgentRunStreamEnvelope[] {
  const update = envelope.update
  if (update.type === 'status') {
    return [envelope, ...history.filter((entry) => entry.update.type !== 'status')]
  }
  if (update.type === 'tool') {
    const retained = history.filter((entry) => entry.update.type === 'status'
      || (entry.update.type === 'tool'
        && entry.update.status === 'running'
        && !isSameToolCall(entry.update, update)))
    return update.status === 'running' ? appendUpdate(retained, envelope) : retained
  }
  if (update.type === 'approval') {
    const activeStatus = history.filter((entry) => entry.update.type === 'status')
    return appendUpdate(activeStatus, envelope)
  }
  return appendUpdate(history, envelope)
}

export function createAgentRunUpdateStore(): AgentRunUpdateStore {
  const listeners = new Set<AgentRunUpdateListener>()
  const activeHistoryByRunId = new Map<string, AgentRunStreamEnvelope[]>()

  return {
    publish(envelope) {
      const { runId, update } = envelope
      if (update.type === 'status' && (update.status === 'running' || update.status === 'queued')) {
        const current = activeHistoryByRunId.get(runId)
        const previousUpdate = current?.at(-1)?.update
        const history = !current || (previousUpdate && isTerminalStatus(previousUpdate)) ? [] : current
        activeHistoryByRunId.set(runId, appendReplayableUpdate(history, envelope))
      } else if (update.type !== 'created') {
        const current = activeHistoryByRunId.get(runId)
        if (current) activeHistoryByRunId.set(runId, appendReplayableUpdate(current, envelope))
      }

      for (const listener of listeners) listener(envelope)
      if (isTerminalStatus(update)) activeHistoryByRunId.delete(runId)
    },
    subscribe(listener) {
      listeners.add(listener)
      for (const history of activeHistoryByRunId.values()) {
        for (const envelope of history) listener(envelope)
      }
      return () => listeners.delete(listener)
    }
  }
}

export const agentRunUpdateStore = createAgentRunUpdateStore()
