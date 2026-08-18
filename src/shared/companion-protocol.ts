export const companionProtocol = {
  minimumVersion: 2,
  currentVersion: 4
} as const

export const companionEventDefinitions = {
  'snapshot.created': 'snapshot',
  'chat-page.updated': 'chat-page',
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
  'agent.create-session',
  'agent.rename-session',
  'agent.update-draft-prompt',
  'agent.archive-session',
  'chat.load-history',
  'artifact.request-upload',
  'decision.update-status',
  'decision.handle',
  'project.update'
] as const

export type CompanionEventType = keyof typeof companionEventDefinitions
export type CompanionEntityType = (typeof companionEventDefinitions)[CompanionEventType] | 'command'
export type CompanionCommandType = (typeof companionCommandTypes)[number]

type CompanionCommandPayloadFieldType =
  | 'string'
  | 'optional-string'
  | 'int'
  | 'attachments'
  | 'optional-attachments'
  | 'decision-status'
  | 'project'

interface CompanionCommandPayloadDefinition {
  swiftName: string
  fields: Record<string, CompanionCommandPayloadFieldType>
}

/** Language-neutral command payload shapes consumed by the Swift generator. */
export const companionCommandPayloadDefinitions = {
  'assistant.send-message': {
    swiftName: 'AssistantSendMessagePayload',
    fields: { prompt: 'string', attachments: 'optional-attachments' }
  },
  'assistant.execute-action': {
    swiftName: 'AssistantExecuteActionPayload',
    fields: { messageId: 'string', proposalId: 'string', optionId: 'string' }
  },
  'agent.send-message': {
    swiftName: 'AgentSendMessagePayload',
    fields: {
      runId: 'string',
      prompt: 'string',
      attachments: 'optional-attachments',
      clientMessageId: 'optional-string'
    }
  },
  'agent.stop-message': { swiftName: 'AgentStopMessagePayload', fields: { runId: 'string' } },
  'agent.create-session': {
    swiftName: 'AgentCreateSessionPayload',
    fields: { runId: 'string', projectId: 'optional-string', title: 'string' }
  },
  'agent.rename-session': {
    swiftName: 'AgentRenameSessionPayload',
    fields: { runId: 'string', title: 'string' }
  },
  'agent.update-draft-prompt': {
    swiftName: 'AgentUpdateDraftPromptPayload',
    fields: { runId: 'string', draftPrompt: 'string' }
  },
  'agent.archive-session': { swiftName: 'AgentArchiveSessionPayload', fields: { runId: 'string' } },
  'chat.load-history': {
    swiftName: 'ChatLoadHistoryPayload',
    fields: { chatKind: 'string', chatId: 'string', before: 'optional-string', limit: 'int' }
  },
  'artifact.request-upload': {
    swiftName: 'ArtifactRequestUploadPayload',
    fields: { artifactId: 'string' }
  },
  'decision.update-status': {
    swiftName: 'DecisionUpdateStatusPayload',
    fields: { decisionId: 'string', status: 'decision-status' }
  },
  'decision.handle': {
    swiftName: 'DecisionHandlePayload',
    fields: { decisionId: 'string', runId: 'string' }
  },
  'project.update': { swiftName: 'ProjectUpdatePayload', fields: { project: 'project' } }
} as const satisfies Record<CompanionCommandType, CompanionCommandPayloadDefinition>

type CompanionSwiftWireFieldType =
  | 'string'
  | 'optional-string'
  | 'int'
  | 'int64'
  | 'optional-json'
  | `ref:${string}`
  | `optional-ref:${string}`
  | `array:${string}`
  | `optional-array:${string}`

interface CompanionSwiftWireDefinition {
  swiftName: string
  fields: Record<string, CompanionSwiftWireFieldType>
}

/**
 * Snapshot and non-entity event payloads generated for Swift. Entity events
 * intentionally reuse the domain models they carry.
 */
export const companionSwiftWireDefinitions = {
  snapshot: {
    swiftName: 'SnapshotPayload',
    fields: {
      generatedAt: 'string',
      modelLabels: 'optional-ref:AgentModelLabels',
      projects: 'array:Project',
      goals: 'array:ProjectGoal',
      decisions: 'array:Decision',
      morningBriefings: 'optional-array:MorningBriefing',
      workAssistantMessages: 'array:WorkAssistantMessage',
      attachments: 'optional-array:AttachmentDescriptor',
      runs: 'array:RunDetail',
      chatPages: 'optional-array:CompanionChatPage'
    }
  },
  artifactEvent: {
    swiftName: 'ArtifactEventPayload',
    fields: { artifact: 'ref:AgentArtifact', attachment: 'optional-ref:AttachmentDescriptor' }
  },
  archivedRunEvent: {
    swiftName: 'AgentRunArchivedPayload',
    fields: { id: 'string', archivedAt: 'string' }
  },
  settledTurnEvent: {
    swiftName: 'AgentTurnSettledPayload',
    fields: {
      runId: 'string',
      turnId: 'string',
      title: 'string',
      outcome: 'string',
      summary: 'string',
      settledAt: 'string'
    }
  },
  commandEvent: {
    swiftName: 'CommandResult',
    fields: {
      commandId: 'string',
      type: 'optional-ref:CompanionCommandType',
      status: 'string',
      result: 'optional-json',
      error: 'optional-string'
    }
  },
  artifactUploadResult: {
    swiftName: 'ArtifactUploadResult',
    fields: { artifactId: 'string', attachment: 'ref:AttachmentDescriptor' }
  }
} as const satisfies Record<string, CompanionSwiftWireDefinition>

export function companionProtocolVersionIsSupported(version: number): boolean {
  return Number.isSafeInteger(version)
    && version >= companionProtocol.minimumVersion
    && version <= companionProtocol.currentVersion
}
