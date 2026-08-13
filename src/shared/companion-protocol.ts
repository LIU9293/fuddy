export const companionProtocol = {
  minimumVersion: 2,
  currentVersion: 2
} as const

export const companionEventDefinitions = {
  'snapshot.created': 'snapshot',
  'project.created': 'project',
  'project.updated': 'project',
  'goal.created': 'goal',
  'goal.updated': 'goal',
  'decision.created': 'decision',
  'decision.updated': 'decision',
  'agent-run.created': 'agent-run',
  'agent-run.updated': 'agent-run',
  'agent-run.archived': 'agent-run',
  'agent-message.created': 'agent-message',
  'artifact.updated': 'artifact',
  'morning-briefing.updated': 'morning-briefing',
  'work-assistant-message.created': 'work-assistant-message',
  'work-assistant-message.updated': 'work-assistant-message',
  'agent-turn.settled': 'agent-run',
  'model-labels.updated': 'settings',
  'command.updated': 'command'
} as const

export const companionCommandTypes = [
  'assistant.send-message',
  'assistant.execute-action',
  'agent.send-message',
  'agent.stop-message',
  'agent.rename-session',
  'agent.update-draft-prompt',
  'agent.archive-session',
  'artifact.request-upload',
  'decision.update-status',
  'decision.handle',
  'project.update'
] as const

export type CompanionEventType = keyof typeof companionEventDefinitions
export type CompanionEntityType = (typeof companionEventDefinitions)[CompanionEventType] | 'command'
export type CompanionCommandType = (typeof companionCommandTypes)[number]

export function companionProtocolVersionIsSupported(version: number): boolean {
  return Number.isSafeInteger(version)
    && version >= companionProtocol.minimumVersion
    && version <= companionProtocol.currentVersion
}
