export const companionProtocolVersion = 1
export const defaultCompanionRelayUrl = 'https://project-agent-companion-relay.moghub.workers.dev'

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

export type CompanionEntityType =
  | 'command'
  | 'snapshot'
  | 'project'
  | 'goal'
  | 'decision'
  | 'agent-run'
  | 'agent-message'
  | 'artifact'
  | 'morning-briefing'
  | 'work-assistant-message'

export interface CompanionSyncEventInput<TPayload = unknown> {
  eventId: string
  protocolVersion: number
  type: string
  entityType: CompanionEntityType
  entityId: string
  revision: number
  payload: TPayload
  occurredAt: string
}

export interface CompanionSyncEvent<TPayload = unknown> extends CompanionSyncEventInput<TPayload> {
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

export type CompanionCommandType =
  | 'assistant.send-message'
  | 'assistant.execute-action'
  | 'agent.send-message'
  | 'agent.stop-message'
  | 'agent.rename-session'
  | 'agent.update-draft-prompt'
  | 'agent.archive-session'
  | 'artifact.request-upload'
  | 'decision.update-status'
  | 'decision.handle'
  | 'project.update'

export type CompanionCommandStatus = 'queued' | 'delivered' | 'executing' | 'completed' | 'failed'

export interface CompanionCommandInput<TPayload = unknown> {
  commandId: string
  protocolVersion: number
  type: CompanionCommandType
  payload: TPayload
  createdAt: string
}

export interface CompanionCommand<TPayload = unknown> extends CompanionCommandInput<TPayload> {
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

export interface CompanionOutboxEvent extends CompanionSyncEventInput {
  attempts: number
  lastError: string | null
}

export interface CompanionSnapshotPayload {
  generatedAt: string
  projects: unknown[]
  goals: unknown[]
  decisions: unknown[]
  morningBriefings: unknown[]
  workAssistantMessages: unknown[]
  attachments: CompanionAttachmentDescriptor[]
  runs: Array<{
    run: unknown
    messages: unknown[]
    artifacts: unknown[]
  }>
}
