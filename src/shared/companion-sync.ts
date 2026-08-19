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
  companionCommandPayloadDefinitions,
  companionCommandTypes,
  companionEventDefinitions,
  companionProtocol,
  type CompanionCommandType,
  type CompanionEntityType,
  type CompanionEventType
} from './companion-protocol'
import type { CompanionEncryptedEnvelope } from './companion-crypto'

export const companionProtocolVersion = companionProtocol.currentVersion
export const companionMinimumProtocolVersion = companionProtocol.minimumVersion
export const defaultCompanionRelayUrl = 'https://fuddy.ai/api/relay'
export const companionAttachmentObjectMaximumBytes = 20 * 1024 * 1024
export const companionAttachmentEnvelopeOverheadBytes = 32
export const companionAttachmentPlaintextMaximumBytes =
  companionAttachmentObjectMaximumBytes - companionAttachmentEnvelopeOverheadBytes
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
  minimumProtocolVersion: number
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
  minimumProtocolVersion: number
  protocolVersion: number
  accountId: string
  device: CompanionDevice
  deviceToken: string
}

export interface CompanionDeviceEnrollmentInput {
  deviceId: string
  deviceName: string
  publicKey?: string | null
  /** Account API enrollment generation used to fence delayed revocations. */
  grantId?: string | null
}

export type CompanionDeviceEnrollmentResult = CompanionPairingClaimResult

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
    payload: CompanionRelayEventPayloadMap[K]
  }
}[TType]

export type CompanionSyncEvent<TType extends CompanionEventType = CompanionEventType> = CompanionSyncEventInput<TType> & {
  sequence: number
  sourceDeviceId: string
}

export type CompanionEncryptedSyncEventInput<TType extends CompanionEventType = CompanionEventType> =
  Omit<CompanionSyncEventInput<TType>, 'payload'> & { payload: CompanionEncryptedEnvelope }

export type CompanionEncryptedSyncEvent<TType extends CompanionEventType = CompanionEventType> =
  CompanionEncryptedSyncEventInput<TType> & { sequence: number; sourceDeviceId: string }

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

export type CompanionEncryptedCommandInput<TType extends CompanionCommandType = CompanionCommandType> =
  Omit<CompanionCommandInput<TType>, 'payload'> & { payload: CompanionEncryptedEnvelope }

export type CompanionEncryptedCommand<TType extends CompanionCommandType = CompanionCommandType> =
  CompanionEncryptedCommandInput<TType> & {
    sourceDeviceId: string
    status: CompanionCommandStatus
    result: null
    error: null
    updatedAt: string
  }

export interface CompanionCommandUpdate {
  status: Exclude<CompanionCommandStatus, 'queued'>
  /** Local-only outcome; stripped before sending to the zero-knowledge Relay. */
  result?: unknown
  /** Local-only error; delivered to iOS inside an encrypted command.updated event. */
  error?: string | null
}

export interface CompanionEventPage {
  minimumProtocolVersion: number
  protocolVersion: number
  events: CompanionSyncEvent[]
  lastSequence: number
  presence?: CompanionPresence
}

export interface CompanionEncryptedEventPage extends Omit<CompanionEventPage, 'events'> {
  events: CompanionEncryptedSyncEvent[]
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
  | { type: 'commands.revoked'; commandIds: string[] }
  | { type: 'presence.updated'; presence: CompanionPresence }
  | { type: 'error'; message: string }

export type CompanionEncryptedSocketMessage =
  | { type: 'sync.ready'; presence: CompanionPresence; lastSequence: number }
  | { type: 'sync.available'; lastSequence: number }
  | { type: 'sync.event'; event: CompanionEncryptedSyncEvent }
  | { type: 'command.created'; command: CompanionEncryptedCommand }
  | { type: 'command.updated'; command: CompanionEncryptedCommand }
  | { type: 'commands.revoked'; commandIds: string[] }
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
  /** Fuddy account that owns this Relay identity. Absent on legacy pairings. */
  ownerUserId?: string
  /** Account sync space that owns this Relay identity. Absent on legacy pairings. */
  syncSpaceId?: string
  /** Set only after the Account API durably records this exact Relay identity. */
  accountBindingConfirmedAt?: string
  /** Key material is stored in the credential vault; only its identifier is persisted here. */
  encryptionKeyId?: string
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
  isolatedEvents: number
  /** Known only while the realtime Relay connection is active. */
  iosDevicesOnline: number | null
}

export interface CompanionPairingSession {
  pairingPayload: string
  expiresAt: string
  status: CompanionMacStatus
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
  /** Protocol v3: one bounded, presentation-ready history window per chat. */
  chatPages?: CompanionChatPage[]
}

export type CompanionChatKind = 'assistant' | 'agent'
export type CompanionChatRecordKind = 'message' | 'process' | 'briefing'

/**
 * A stable presentation block shared by every Companion chat surface.
 * Exactly one payload family is populated for each kind/chat combination.
 */
export interface CompanionChatRecord<TAssistantMessage = BriefingMessage> {
  id: string
  chatId: string
  chatKind: CompanionChatKind
  kind: CompanionChatRecordKind
  createdAt: string
  completedAt: string | null
  assistantMessage: TAssistantMessage | null
  agentMessages: AgentRunMessage[]
  morningBriefing: MorningBriefing | null
}

export interface CompanionChatPage<TAssistantMessage = BriefingMessage> {
  chatId: string
  chatKind: CompanionChatKind
  records: Array<CompanionChatRecord<TAssistantMessage>>
  hasMore: boolean
  nextBefore: string | null
}

export interface CompanionArtifactEventPayload {
  artifact: AgentRunArtifact
  attachment: CompanionAttachmentDescriptor | null
}

export type CompanionRelayWorkAssistantMessage = Omit<BriefingMessage, 'attachments'> & {
  attachments: CompanionAttachmentDescriptor[]
}

export type CompanionRelayChatPage = CompanionChatPage<CompanionRelayWorkAssistantMessage>

export type CompanionRelaySnapshotPayload = Omit<CompanionSnapshotPayload, 'workAssistantMessages' | 'chatPages'> & {
  workAssistantMessages: CompanionRelayWorkAssistantMessage[]
  chatPages?: CompanionRelayChatPage[]
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

export interface CompanionOutboxPayloadMap {
  'snapshot.created': CompanionSnapshotPayload
  'chat-page.updated': CompanionChatPage
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

export interface CompanionRelayEventPayloadMap extends Omit<CompanionOutboxPayloadMap,
  'snapshot.created' | 'chat-page.updated' | 'artifact.updated' | 'work-assistant-message.created' | 'work-assistant-message.updated'> {
  'snapshot.created': CompanionRelaySnapshotPayload
  'chat-page.updated': CompanionRelayChatPage
  'artifact.updated': AgentRunArtifact | CompanionArtifactEventPayload
  'work-assistant-message.created': CompanionRelayWorkAssistantMessage
  'work-assistant-message.updated': CompanionRelayWorkAssistantMessage
}

export type CompanionOutboxEvent<TType extends CompanionEventType = CompanionEventType> = {
  [K in TType]: CompanionSyncEventBase & {
    type: K
    entityType: (typeof companionEventDefinitions)[K]
    payload: CompanionOutboxPayloadMap[K]
    attempts: number
    lastError: string | null
  }
}[TType]

type CompanionCommandPayloadFieldValue = {
  string: string
  'optional-string': string
  int: number
  attachments: CompanionAttachmentDescriptor[]
  'optional-attachments': CompanionAttachmentDescriptor[]
  'decision-status': DecisionStatus
  project: Project
}

type CompanionCommandPayloadFields = Record<string, keyof CompanionCommandPayloadFieldValue>
type RequiredCommandPayloadFields<TFields extends CompanionCommandPayloadFields> = {
  [TKey in keyof TFields as TFields[TKey] extends `optional-${string}` ? never : TKey]:
    CompanionCommandPayloadFieldValue[TFields[TKey]]
}
type OptionalCommandPayloadFields<TFields extends CompanionCommandPayloadFields> = {
  [TKey in keyof TFields as TFields[TKey] extends `optional-${string}` ? TKey : never]?:
    CompanionCommandPayloadFieldValue[TFields[TKey]]
}
type CompanionCommandPayload<TFields extends CompanionCommandPayloadFields> =
  RequiredCommandPayloadFields<TFields> & OptionalCommandPayloadFields<TFields>

export type CompanionCommandPayloadMap = {
  [TType in CompanionCommandType]: CompanionCommandPayload<(typeof companionCommandPayloadDefinitions)[TType]['fields']>
}
