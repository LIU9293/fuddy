import type { AgentModelLabels } from './model-display'
import type {
  AgentRun,
  AgentRunArtifact,
  AgentRunMessage,
  BriefingMessage,
  DecisionStatus,
  DecisionItem,
  MorningBriefing,
  Project,
  ProjectGoal
} from './contracts'
import {
  companionCommandTypes,
  companionEventDefinitions,
  companionProtocol,
  type CompanionCommandType,
  type CompanionEntityType,
  type CompanionEventType
} from './companion-protocol'

export const companionProtocolVersion = companionProtocol.currentVersion
export const companionMinimumProtocolVersion = companionProtocol.minimumVersion
export const defaultCompanionRelayUrl = 'https://project-agent-companion-relay.moghub.workers.dev'
export { companionCommandTypes, companionEventDefinitions }
export type { CompanionCommandType, CompanionEntityType, CompanionEventType }

export type CompanionDeviceRole = 'mac' | 'ios'
export type CompanionDevicePlatform = 'macos' | 'ios'

export interface CompanionDevice {
  id: string
  role: CompanionDeviceRole
  platform: CompanionDevicePlatform
  name: string
  publicKey: string | null
  createdAt: string
  lastSeenAt: string | null
}

export interface CompanionPairingStartInput {
  macDeviceId: string
  macDeviceName: string
  publicKey?: string | null
}

export interface CompanionPairingStartResult {
  protocolVersion: number
  accountId: string
  macDeviceId: string
  macToken: string
  pairingSecret: string
  pairingPayload: string
  expiresAt: string
}

export interface CompanionPairingClaimInput {
  accountId: string
  pairingSecret: string
  deviceId: string
  deviceName: string
  publicKey?: string | null
}

export interface CompanionPairingClaimResult {
  protocolVersion: number
  accountId: string
  device: CompanionDevice
  deviceToken: string
}

interface CompanionSyncEventBase {
  eventId: string
  protocolVersion: number
  entityId: string
  revision: number
  occurredAt: string
}

export type CompanionSyncEventInput<TType extends CompanionEventType = CompanionEventType> = {
  [K in TType]: CompanionSyncEventBase & {
    type: K
    entityType: (typeof companionEventDefinitions)[K]
    payload: CompanionEventPayloadMap[K]
  }
}[TType]

export type CompanionSyncEvent<TType extends CompanionEventType = CompanionEventType> = CompanionSyncEventInput<TType> & {
  sequence: number
  sourceDeviceId: string
}

export type AgentTurnOutcome = 'completed' | 'failed'

export interface AgentTurnSettledPayload {
  runId: string
  turnId: string
  title: string
  outcome: AgentTurnOutcome
  summary: string
  settledAt: string
}

export type CompanionCommandStatus = 'queued' | 'delivered' | 'executing' | 'completed' | 'failed'

interface CompanionCommandBase {
  commandId: string
  protocolVersion: number
  createdAt: string
}

export type CompanionCommandInput<TType extends CompanionCommandType = CompanionCommandType> = {
  [K in TType]: CompanionCommandBase & { type: K; payload: CompanionCommandPayloadMap[K] }
}[TType]

export type CompanionCommand<TType extends CompanionCommandType = CompanionCommandType> = CompanionCommandInput<TType> & {
  sourceDeviceId: string
  status: CompanionCommandStatus
  result: unknown | null
  error: string | null
  updatedAt: string
}

export interface CompanionCommandUpdate {
  status: Exclude<CompanionCommandStatus, 'queued'>
  result?: unknown
  error?: string | null
}

export interface CompanionEventPage {
  events: CompanionSyncEvent[]
  lastSequence: number
  presence?: CompanionPresence
}

export interface CompanionEventBatchResult {
  accepted: Array<{ eventId: string; sequence: number }>
  lastSequence: number
}

export interface CompanionPresence {
  macOnline: boolean
  iosDevicesOnline: number
  updatedAt: string
}

export type CompanionSocketMessage =
  | { type: 'sync.ready'; presence: CompanionPresence; lastSequence: number }
  | { type: 'sync.available'; lastSequence: number }
  | { type: 'sync.event'; event: CompanionSyncEvent }
  | { type: 'command.created'; command: CompanionCommand }
  | { type: 'command.updated'; command: CompanionCommand }
  | { type: 'presence.updated'; presence: CompanionPresence }
  | { type: 'error'; message: string }

export interface CompanionAttachmentDescriptor {
  id: string
  messageId: string | null
  artifactId: string | null
  filename: string
  mimeType: string
  size: number
  sha256: string
  width: number | null
  height: number | null
  thumbnailAttachmentId: string | null
  createdAt: string
}

export interface CompanionPushRegistrationInput {
  token: string
}

export interface CompanionMacConfiguration {
  relayUrl: string
  accountId: string
  macDeviceId: string
  pairedAt: string
}

export type CompanionConnectionState = 'not-configured' | 'connecting' | 'connected' | 'disconnected' | 'error'
export type CompanionRealtimeConnectionState = 'disconnected' | 'connecting' | 'connected'

export interface CompanionMacStatus {
  configuration: CompanionMacConfiguration | null
  state: CompanionConnectionState
  realtimeState: CompanionRealtimeConnectionState
  lastConnectedAt: string | null
  lastSyncedAt: string | null
  lastError: string | null
  pendingEvents: number
}

export interface CompanionPairingSession {
  pairingPayload: string
  expiresAt: string
  status: CompanionMacStatus
}

export type CompanionOutboxEvent<TType extends CompanionEventType = CompanionEventType> = CompanionSyncEventInput<TType> & {
  attempts: number
  lastError: string | null
}

export interface CompanionSnapshotPayload {
  generatedAt: string
  modelLabels: AgentModelLabels
  projects: Project[]
  goals: ProjectGoal[]
  decisions: DecisionItem[]
  morningBriefings: MorningBriefing[]
  workAssistantMessages: BriefingMessage[]
  attachments: CompanionAttachmentDescriptor[]
  runs: Array<{
    run: AgentRun
    messages: AgentRunMessage[]
    artifacts: AgentRunArtifact[]
  }>
}

export interface CompanionArtifactEventPayload {
  artifact: AgentRunArtifact
  attachment: CompanionAttachmentDescriptor | null
}

export interface CompanionCommandRecord {
  commandId: string
  protocolVersion: number
  type: CompanionCommandType
  payload: unknown
  sourceDeviceId: string
  status: CompanionCommandStatus
  result: unknown | null
  error: string | null
  createdAt: string
  updatedAt: string
}

export interface CompanionEventPayloadMap {
  'snapshot.created': CompanionSnapshotPayload
  'project.created': Project
  'project.updated': Project
  'goal.created': ProjectGoal
  'goal.updated': ProjectGoal
  'decision.created': DecisionItem
  'decision.updated': DecisionItem
  'agent-run.created': AgentRun
  'agent-run.updated': AgentRun
  'agent-run.archived': { id: string; archivedAt: string }
  'agent-message.created': AgentRunMessage
  'artifact.updated': AgentRunArtifact | CompanionArtifactEventPayload
  'morning-briefing.updated': MorningBriefing
  'work-assistant-message.created': BriefingMessage
  'work-assistant-message.updated': BriefingMessage
  'agent-turn.settled': AgentTurnSettledPayload
  'model-labels.updated': AgentModelLabels
  'command.updated': CompanionCommandRecord
}

export interface CompanionCommandPayloadMap {
  'assistant.send-message': { prompt: string; attachments?: CompanionAttachmentDescriptor[] }
  'assistant.execute-action': { messageId: string; proposalId: string; optionId: string }
  'agent.send-message': { runId: string; prompt: string; attachments?: CompanionAttachmentDescriptor[]; clientMessageId?: string }
  'agent.stop-message': { runId: string }
  'agent.rename-session': { runId: string; title: string }
  'agent.update-draft-prompt': { runId: string; draftPrompt: string }
  'agent.archive-session': { runId: string }
  'artifact.request-upload': { artifactId: string }
  'decision.update-status': { decisionId: string; status: DecisionStatus }
  'decision.handle': { decisionId: string; runId: string }
  'project.update': { project: Project }
}
