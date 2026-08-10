import type { BriefingMessage } from '../../shared/contracts'

function acceptedCreateRun(message: BriefingMessage): boolean {
  return (message.actions ?? []).some((proposal) => {
    if (proposal.status !== 'accepted' || !proposal.acceptedOptionId) return false
    return proposal.options.find((option) => option.id === proposal.acceptedOptionId)?.capability === 'agent-run.create'
  })
}

export function workAssistantRunIds(message: BriefingMessage): string[] {
  if (message.role !== 'assistant') return []

  const runIds = new Set<string>()
  const actions = message.actions ?? []
  if (message.linkedRunId && (actions.length === 0 || acceptedCreateRun(message))) {
    runIds.add(message.linkedRunId)
  }
  for (const proposal of actions) {
    for (const option of proposal.options) {
      if (option.capability === 'agent-run.open') runIds.add(option.payload.runId)
    }
  }
  return [...runIds]
}
