import { hostname } from 'node:os'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import WebSocket from 'ws'
import type {
  CompanionCommand,
  CompanionEncryptedCommand,
  CompanionEncryptedSyncEventInput,
  CompanionCommandType,
  CompanionCommandUpdate,
  CompanionEventBatchResult,
  CompanionMacConfiguration,
  CompanionMacStatus,
  CompanionRealtimeConnectionState,
  CompanionPairingSession,
  CompanionPairingStartResult,
  CompanionSocketMessage,
  CompanionSyncEventInput,
  CompanionOutboxEvent,
  CompanionAttachmentDescriptor,
  CompanionSnapshotPayload,
  CompanionChatKind,
  CompanionChatPage,
  CompanionRelayChatPage,
  CompanionRelaySnapshotPayload,
  CompanionRelayWorkAssistantMessage
} from '../../shared/companion-sync'
import { companionProtocolVersion } from '../../shared/companion-sync'
import { companionContractFingerprint } from '../../shared/companion-contract.generated'
import type { CodingAgentProvider, DecisionStatus, WorkAssistantImageAttachment } from '../../shared/contracts'
import type { AgentRunArtifact, AgentRunMessage, BriefingMessage } from '../../shared/contracts'
import { emptyAgentModelLabels, type AgentModelLabels } from '../../shared/model-display'
import { agentToolPresentation } from '../../shared/agent-activity'
import { updateProjectSchema } from '../../shared/project-validation'
import { companionCommandSchema, companionEncryptedCommandSchema, syncEventSchema } from '../../shared/companion-schemas'
import { ZodError } from 'zod'
import { AppDatabase } from './database'
import { CredentialVault } from './credential-vault'
import { TaskDispatcher } from './task-dispatcher'
import type { WorkspaceFilesService } from './workspace-files'
import {
  compactPersistedCompanionCommandEvent,
  companionCommandResultRequiredOnIos
} from '../features/companion/companion-repository'
import {
  companionAccountKeyId,
  companionAttachmentAssociatedData,
  companionCommandAssociatedData,
  companionEventAssociatedData,
  generateCompanionAccountKey,
  openCompanionAttachment,
  openCompanionJson,
  sealCompanionAttachment,
  sealCompanionJson
} from '../../shared/companion-crypto'

const configurationKey = 'companion.mac-configuration'
export const companionFallbackSyncIntervalMs = 60_000
export const companionConnectedFallbackSyncIntervalMs = 5 * 60_000
export const companionRequestTimeoutMs = 30_000
export const companionSocketHeartbeatIntervalMs = 20_000
export const companionEventBatchMaximumCount = 100
export const companionEventBatchMaximumBytes = 512 * 1024
// Pairing snapshots are already bounded to one presentation-ready page per chat,
// but an established workspace can legitimately exceed the normal batch target.
// Keep the single baseline below the Relay's encrypted-payload ceiling instead
// of dead-lettering it and leaving a newly paired phone without canonical state.
export const companionSnapshotEventMaximumBytes = 1_900_000
export const companionToolSummaryMaximumCharacters = 600
const companionAttachmentRequestTimeoutMs = 120_000
const companionEventSyncDebounceMs = 500
const reconnectDelaysMs = [5_000, 15_000, 60_000] as const

export function companionAttachmentStorageId(artifactId: string, sha256: string): string {
  return createHash('sha256').update(`${artifactId}\0${sha256.toLowerCase()}`).digest('hex')
}

interface AuthenticatedCompanionContext {
  configuration: CompanionMacConfiguration
  token: string
  encryptionKey: string
}

export function companionReconnectDelayMs(attempt: number): number {
  return reconnectDelaysMs[Math.min(Math.max(0, attempt), reconnectDelaysMs.length - 1)]
}

export function companionSocketMessageRequestsSync(message: CompanionSocketMessage): boolean {
  return message.type === 'sync.ready' || message.type === 'command.created'
}

export function closeCompanionSocket(socket: WebSocket | null): void {
  if (!socket) return
  socket.removeAllListeners()
  // ws emits an asynchronous error when a CONNECTING handshake is aborted. Keep a no-op
  // listener attached so replacing a pairing cannot surface it as a main-process exception.
  socket.once('error', () => undefined)
  socket.terminate()
}

export function companionFallbackSyncIntervalForState(
  state: CompanionRealtimeConnectionState
): number {
  return state === 'connected' ? companionConnectedFallbackSyncIntervalMs : companionFallbackSyncIntervalMs
}

export function companionAgentMessageForRelay(message: AgentRunMessage): AgentRunMessage {
  if (message.role !== 'tool') return message
  const presentation = agentToolPresentation(message.toolName ?? 'tool', message.content, message.metadata)
  const normalized = message.content.replace(/\s+/g, ' ').trim() || message.toolName || '工具调用'
  const content = normalized.length > companionToolSummaryMaximumCharacters
    ? `${normalized.slice(0, companionToolSummaryMaximumCharacters).trimEnd()}…`
    : normalized
  const nativeStatus = message.metadata?.status
  const failed = nativeStatus === 'failed'
    || message.metadata?.isError === true
    || message.metadata?.is_error === true
  return {
    ...message,
    content,
    metadata: null,
    toolStatus: failed ? 'failed' : 'completed',
    toolKind: presentation.kind,
    toolSummary: presentation.summary
  }
}

export async function companionChatPageForRelay(
  page: CompanionChatPage,
  prepareWorkAssistantMessage: (message: BriefingMessage) => Promise<CompanionRelayWorkAssistantMessage>
): Promise<CompanionRelayChatPage> {
  return {
    ...page,
    records: await Promise.all(page.records.map(async (record) => ({
      ...record,
      assistantMessage: record.assistantMessage
        ? await prepareWorkAssistantMessage(record.assistantMessage)
        : null,
      agentMessages: record.agentMessages.map(companionAgentMessageForRelay)
    })))
  }
}

export function partitionCompanionEventBatches<T extends CompanionSyncEventInput | CompanionEncryptedSyncEventInput>(events: T[]): T[][] {
  const batches: T[][] = []
  let current: T[] = []
  for (const event of events) {
    const candidate = [...current, event]
    const candidateBytes = Buffer.byteLength(JSON.stringify({ events: candidate }), 'utf8')
    if (current.length > 0 && (
      candidate.length > companionEventBatchMaximumCount
      || candidateBytes > companionEventBatchMaximumBytes
    )) {
      batches.push(current)
      current = [event]
    } else {
      current = candidate
    }
  }
  if (current.length > 0) batches.push(current)
  return batches
}

export function companionEventFitsTransportLimit(
  event: CompanionSyncEventInput | CompanionEncryptedSyncEventInput,
  maximumBytes = companionEventBatchMaximumBytes
): boolean {
  return Buffer.byteLength(JSON.stringify({ events: [event] }), 'utf8') <= maximumBytes
}

export function compactCompanionPairingSnapshot(
  snapshot: CompanionRelaySnapshotPayload
): CompanionRelaySnapshotPayload {
  return {
    ...snapshot,
    morningBriefings: [],
    workAssistantMessages: [],
    runs: snapshot.runs.map((detail) => ({ ...detail, messages: [] })),
    chatPages: snapshot.chatPages?.map((page) => ({
      ...page,
      records: [],
      hasMore: page.hasMore || page.records.length > 0,
      nextBefore: null
    }))
  }
}

export function companionSocketHeartbeatShouldReconnect(awaitingPong: boolean): boolean {
  return awaitingPong
}

export function companionCommandRecovery(
  status: CompanionCommand['status'] | null
): 'execute' | 'fail-interrupted' | 'ack-terminal' {
  if (status === 'completed' || status === 'failed') return 'ack-terminal'
  if (status === 'executing') return 'fail-interrupted'
  return 'execute'
}

export function companionCommandUpdateForRelay(
  _commandType: CompanionCommandType,
  update: CompanionCommandUpdate
): CompanionCommandUpdate {
  return { status: update.status }
}

function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = companionRequestTimeoutMs
): Promise<Response> {
  return fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) })
}

function normalizedRelayUrl(value: string): string {
  const url = new URL(value.trim())
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('Companion Relay 必须使用 HTTPS。')
  }
  return url.origin
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(body.error ?? `Companion Relay 请求失败（${response.status}）。`)
  return body as T
}

export class CompanionSyncService {
  private executeWorkAssistantAction: ((input: { messageId: string; proposalId: string; optionId: string }) => unknown) | null = null
  private configuration: CompanionMacConfiguration | null
  private state: CompanionMacStatus['state'] = 'not-configured'
  private realtimeState: CompanionRealtimeConnectionState = 'disconnected'
  private lastConnectedAt: string | null = null
  private lastSyncedAt: string | null = null
  private lastError: string | null = null
  private socket: WebSocket | null = null
  private socketHeartbeatTimer: ReturnType<typeof setInterval> | null = null
  private awaitingSocketPong = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private eventSyncTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private activeSync: Promise<CompanionMacStatus> | null = null
  private readonly activeCommands = new Map<string, Promise<void>>()
  private readonly activeRunCreations = new Map<string, Promise<void>>()
  private syncRequested = false
  private stopped = false
  private readonly listeners = new Set<(status: CompanionMacStatus) => void>()
  private readonly dataChangedListeners = new Set<() => void>()

  constructor(
    private readonly database: AppDatabase,
    private readonly credentials: CredentialVault,
    private readonly dispatcher: TaskDispatcher,
    private readonly askWorkAssistant: (question: string, attachments: WorkAssistantImageAttachment[]) => Promise<unknown>,
    private readonly incomingAttachmentsRoot = resolve(process.cwd(), '.companion-uploads'),
    private readonly defaultCodingAgent: () => CodingAgentProvider = () => 'codex',
    private readonly workspaceFiles?: WorkspaceFilesService,
    private readonly modelLabels: () => AgentModelLabels = () => emptyAgentModelLabels
  ) {
    this.configuration = database.getSetting<CompanionMacConfiguration | null>(configurationKey, null)
    this.state = this.configuration ? 'disconnected' : 'not-configured'
    database.onCompanionEventEnqueued(() => this.scheduleEventSync())
  }

  getStatus(): CompanionMacStatus {
    return {
      configuration: this.configuration,
      state: this.state,
      realtimeState: this.realtimeState,
      lastConnectedAt: this.lastConnectedAt,
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError,
      pendingEvents: this.database.countPendingCompanionEvents(),
      isolatedEvents: this.database.countDeadLetterCompanionEvents()
    }
  }

  onStatusChanged(listener: (status: CompanionMacStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onDataChanged(listener: () => void): () => void {
    this.dataChangedListeners.add(listener)
    return () => this.dataChangedListeners.delete(listener)
  }

  publishModelLabels(): void {
    if (!this.configuration) return
    this.database.enqueueCompanionModelLabels(this.modelLabels())
  }

  setWorkAssistantActionExecutor(
    executor: (input: { messageId: string; proposalId: string; optionId: string }) => unknown
  ): void {
    this.executeWorkAssistantAction = executor
  }

  async start(): Promise<void> {
    this.stopped = false
    if (!this.configuration) return
    this.publishModelLabels()
    this.ensureTimer()
    await this.syncNow()
    this.connectSocket()
  }

  async beginPairing(relayUrl: string, deviceName?: string): Promise<CompanionPairingSession> {
    const previousConfiguration = this.configuration
    const origin = normalizedRelayUrl(relayUrl)
    const macDeviceId = crypto.randomUUID()
    const response = await fetchWithTimeout(`${origin}/v1/pairings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        macDeviceId,
        macDeviceName: deviceName?.trim() || hostname() || 'Mac'
      })
    })
    const pairing = await responseJson<CompanionPairingStartResult>(response)
    if (pairing.protocolVersion !== companionProtocolVersion) {
      await this.revokePairingAccount(origin, pairing).catch(() => {
        // Preserve the compatibility error if the incompatible Relay cannot clean up the provisional account.
      })
      throw new Error('Companion Relay 协议版本不兼容。')
    }
    if (previousConfiguration) await this.revokeRemoteAccount()
    this.closeTransports()
    if (previousConfiguration) {
      this.credentials.delete(this.tokenReference(previousConfiguration.accountId))
      this.credentials.delete(this.encryptionKeyReference(previousConfiguration.accountId))
    }
    const encryptionKey = generateCompanionAccountKey()
    const encryptionKeyId = await companionAccountKeyId(encryptionKey)
    this.configuration = {
      relayUrl: origin,
      accountId: pairing.accountId,
      macDeviceId: pairing.macDeviceId,
      pairedAt: new Date().toISOString(),
      encryptionKeyId
    }
    this.credentials.set(this.tokenReference(pairing.accountId), pairing.macToken)
    this.credentials.set(this.encryptionKeyReference(pairing.accountId), encryptionKey)
    this.database.setSetting(configurationKey, this.configuration)
    this.database.enqueueCompanionPairingSnapshot(this.modelLabels())
    this.state = 'connecting'
    this.lastError = null
    this.emitStatus()
    this.ensureTimer()
    this.connectSocket()
    void this.syncNow()
    return {
      pairingPayload: JSON.stringify({
        ...(JSON.parse(pairing.pairingPayload) as Record<string, unknown>),
        contractFingerprint: companionContractFingerprint,
        encryptionKey,
        encryptionKeyId
      }),
      expiresAt: pairing.expiresAt,
      status: this.getStatus()
    }
  }

  async disconnect(): Promise<void> {
    if (this.configuration) await this.revokeRemoteAccount()
    if (this.configuration) this.credentials.delete(this.tokenReference(this.configuration.accountId))
    if (this.configuration) this.credentials.delete(this.encryptionKeyReference(this.configuration.accountId))
    this.database.setSetting<CompanionMacConfiguration | null>(configurationKey, null)
    this.configuration = null
    this.state = 'not-configured'
    this.realtimeState = 'disconnected'
    this.lastConnectedAt = null
    this.lastSyncedAt = null
    this.lastError = null
    this.closeTransports()
    this.emitStatus()
  }

  async syncNow(): Promise<CompanionMacStatus> {
    if (!this.configuration || this.stopped) return this.getStatus()
    if (this.activeSync) {
      this.syncRequested = true
      await this.activeSync
      return this.getStatus()
    }
    const operation = this.performSyncLoop()
    this.activeSync = operation
    try {
      return await operation
    } finally {
      if (this.activeSync === operation) this.activeSync = null
    }
  }

  private async performSyncLoop(): Promise<CompanionMacStatus> {
    let status = this.getStatus()
    do {
      this.syncRequested = false
      status = await this.performSync()
    } while (this.syncRequested && this.configuration && !this.stopped)
    return status
  }

  private async performSync(): Promise<CompanionMacStatus> {
    if (this.state !== 'connected') this.state = 'connecting'
    this.emitStatus()
    try {
      await this.flushOutbox()
      await this.processPendingCommands()
      this.state = 'connected'
      this.lastSyncedAt = new Date().toISOString()
      const isolatedEvents = this.database.countDeadLetterCompanionEvents()
      this.lastError = isolatedEvents > 0
        ? `已隔离 ${isolatedEvents} 条无法安全发送的 Companion 事件；其余事件已继续同步。`
        : null
    } catch (error) {
      this.state = 'error'
      this.lastError = error instanceof Error ? error.message : 'Companion 同步失败。'
    } finally {
      this.emitStatus()
    }
    return this.getStatus()
  }

  stop(): void {
    this.stopped = true
    this.closeTransports()
  }

  private async flushOutbox(): Promise<void> {
    const context = this.authenticatedContext()
    while (true) {
      const pending = this.database.listPendingCompanionEvents(companionEventBatchMaximumCount)
      if (pending.length === 0) return
      const prepared: CompanionEncryptedSyncEventInput[] = []
      for (const event of pending) {
        const payload = await this.prepareEventPayload(event)
        let plaintext: CompanionSyncEventInput
        try {
          plaintext = syncEventSchema.parse({
            eventId: event.eventId,
            protocolVersion: event.protocolVersion,
            type: event.type,
            entityType: event.entityType,
            entityId: event.entityId,
            revision: event.revision,
            payload,
            occurredAt: event.occurredAt
          })
        } catch (error) {
          if (!(error instanceof ZodError)) throw error
          this.database.markCompanionEventDeadLettered(
            event.eventId,
            `Companion 事件契约无效，已隔离：${error.issues[0]?.message ?? '未知格式错误'}`
          )
          continue
        }
        let encrypted = {
          ...plaintext,
          payload: await sealCompanionJson(
            context.encryptionKey,
            plaintext.payload,
            companionEventAssociatedData(plaintext)
          )
        } as CompanionEncryptedSyncEventInput
        if (!companionEventFitsTransportLimit(encrypted, companionSnapshotEventMaximumBytes)
          && event.type === 'snapshot.created') {
          const compactPlaintext = syncEventSchema.parse({
            ...plaintext,
            payload: compactCompanionPairingSnapshot(plaintext.payload as CompanionRelaySnapshotPayload)
          })
          encrypted = {
            ...compactPlaintext,
            payload: await sealCompanionJson(
              context.encryptionKey,
              compactPlaintext.payload,
              companionEventAssociatedData(compactPlaintext)
            )
          } as CompanionEncryptedSyncEventInput
        }
        if (!companionEventFitsTransportLimit(encrypted) && event.type === 'command.updated') {
          const compact = compactPersistedCompanionCommandEvent(event.payload) as Record<string, unknown>
          const type = compact.type as CompanionCommandType
          const compactStatus = compact.status === 'completed' && companionCommandResultRequiredOnIos(type)
            ? 'failed'
            : compact.status
          const fallbackPlaintext = syncEventSchema.parse({
            ...plaintext,
            payload: {
              ...compact,
              status: compactStatus,
              result: null,
              error: companionCommandResultRequiredOnIos(type)
                ? 'Mac 返回的命令结果过大，无法安全同步到 iPhone。请缩小请求范围后重试。'
                : compact.error
            }
          })
          encrypted = {
            ...fallbackPlaintext,
            payload: await sealCompanionJson(
              context.encryptionKey,
              fallbackPlaintext.payload,
              companionEventAssociatedData(fallbackPlaintext)
            )
          } as CompanionEncryptedSyncEventInput
        }
        const maximumEventBytes = event.type === 'snapshot.created'
          ? companionSnapshotEventMaximumBytes
          : companionEventBatchMaximumBytes
        if (!companionEventFitsTransportLimit(encrypted, maximumEventBytes)) {
          this.database.markCompanionEventDeadLettered(
            event.eventId,
            `Companion ${event.type} 事件超过 ${maximumEventBytes} 字节传输上限，已隔离以继续同步后续事件。`
          )
          continue
        }
        prepared.push(encrypted)
      }
      for (const batch of partitionCompanionEventBatches(prepared)) {
        try {
          await this.publishEventBatch(batch, context)
        } catch (error) {
          const message = error instanceof Error ? error.message : '事件上传失败。'
          for (const event of batch) this.database.markCompanionEventFailed(event.eventId, message)
          throw error
        }
      }
    }
  }

  private async publishEventBatch(
    events: CompanionEncryptedSyncEventInput[],
    context: AuthenticatedCompanionContext
  ): Promise<void> {
    const headers = {
      Authorization: `Bearer ${context.token}`,
      'Content-Type': 'application/json'
    }
    const response = await fetchWithTimeout(this.authenticatedUrl('/v1/events/batch', context.configuration), {
      method: 'POST',
      headers,
      body: JSON.stringify({ events })
    })
    if (response.status === 404 || response.status === 405) {
      for (const event of events) {
        const fallback = await fetchWithTimeout(this.authenticatedUrl('/v1/events', context.configuration), {
          method: 'POST',
          headers,
          body: JSON.stringify(event)
        })
        await responseJson(fallback)
        this.database.markCompanionEventPublished(event.eventId, new Date().toISOString())
      }
      return
    }
    await responseJson<CompanionEventBatchResult>(response)
    const publishedAt = new Date().toISOString()
    for (const event of events) this.database.markCompanionEventPublished(event.eventId, publishedAt)
  }

  private async prepareEventPayload(event: CompanionOutboxEvent): Promise<unknown> {
    if (event.type === 'snapshot.created') {
      const snapshot = event.payload as CompanionSnapshotPayload
      const preparedWorkAssistantMessages = new Map<string, Promise<CompanionRelayWorkAssistantMessage>>()
      const prepareWorkAssistantMessage = (message: BriefingMessage): Promise<CompanionRelayWorkAssistantMessage> => {
        const existing = preparedWorkAssistantMessages.get(message.id)
        if (existing) return existing
        const prepared = this.prepareWorkAssistantMessage(message)
        preparedWorkAssistantMessages.set(message.id, prepared)
        return prepared
      }
      const attachments = (await Promise.all(
        snapshot.runs.flatMap((detail) => detail.artifacts.map((artifact) =>
          this.prepareArtifact(artifact as AgentRunArtifact)
        ))
      )).filter((attachment): attachment is CompanionAttachmentDescriptor => attachment !== null)
      return {
        ...snapshot,
        attachments,
        runs: snapshot.runs.map((detail) => ({
          ...detail,
          messages: detail.messages.map((message) => companionAgentMessageForRelay(message as AgentRunMessage))
        })),
        workAssistantMessages: await Promise.all(
          (snapshot.workAssistantMessages ?? []).map((message) => prepareWorkAssistantMessage(message as BriefingMessage))
        ),
        chatPages: snapshot.chatPages
          ? await Promise.all(snapshot.chatPages.map((page) => companionChatPageForRelay(page, prepareWorkAssistantMessage)))
          : undefined
      }
    }
    if (event.type === 'agent-message.created') {
      return companionAgentMessageForRelay(event.payload as AgentRunMessage)
    }
    if (event.type === 'work-assistant-message.created' || event.type === 'work-assistant-message.updated') {
      return await this.prepareWorkAssistantMessage(event.payload as BriefingMessage)
    }
    if (event.type !== 'artifact.updated') return event.payload
    const artifactId = event.entityId
    const artifact = this.database.getAgentRunArtifact(artifactId)
    if (!artifact) return event.payload
    return { artifact, attachment: await this.prepareArtifact(artifact) }
  }

  private async prepareArtifact(artifact: AgentRunArtifact): Promise<CompanionAttachmentDescriptor | null> {
    const filePath = this.resolveArtifactPath(artifact)
    if (!filePath) return null
    const file = statSync(filePath)
    if (!file.isFile() || file.size <= 0 || file.size > 100 * 1024 * 1024) {
      return null
    }
    const sha256 = await this.hashFile(filePath)
    const attachmentId = companionAttachmentStorageId(artifact.id, sha256)
    const mimeType = artifact.mimeType ?? this.mimeTypeForPath(filePath)
    const context = this.authenticatedContext()
    const plaintext = await readFile(filePath)
    const sealed = await sealCompanionAttachment(
      context.encryptionKey,
      plaintext,
      companionAttachmentAssociatedData(context.configuration.accountId, attachmentId)
    )
    const encryptedSha256 = createHash('sha256').update(sealed).digest('hex')
    const response = await fetchWithTimeout(
      this.authenticatedUrl(`/v1/attachments/${attachmentId}`, context.configuration),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${context.token}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(sealed.byteLength),
          'X-Content-SHA256': encryptedSha256,
          'X-Companion-Encryption': 'A256GCM'
        },
        body: sealed as unknown as BodyInit
      },
      companionAttachmentRequestTimeoutMs
    )
    if (response.status !== 409 || !await this.existingAttachmentMatches(
      context,
      attachmentId,
      file.size,
      sha256
    )) {
      await responseJson(response)
    }
    return {
      id: attachmentId,
      messageId: null,
      artifactId: artifact.id,
      filename: artifact.label,
      mimeType,
      size: file.size,
      sha256,
      width: null,
      height: null,
      thumbnailAttachmentId: null,
      createdAt: artifact.createdAt
    }
  }

  private async existingAttachmentMatches(
    context: AuthenticatedCompanionContext,
    attachmentId: string,
    expectedSize: number,
    expectedSha256: string
  ): Promise<boolean> {
    const response = await fetchWithTimeout(
      this.authenticatedUrl(`/v1/attachments/${attachmentId}`, context.configuration),
      { headers: { Authorization: `Bearer ${context.token}` } },
      companionAttachmentRequestTimeoutMs
    )
    if (!response.ok) return false
    try {
      const sealed = new Uint8Array(await response.arrayBuffer())
      const plaintext = await openCompanionAttachment(
        context.encryptionKey,
        sealed,
        companionAttachmentAssociatedData(context.configuration.accountId, attachmentId)
      )
      return plaintext.byteLength === expectedSize
        && createHash('sha256').update(plaintext).digest('hex') === expectedSha256
    } catch {
      return false
    }
  }

  private resolveArtifactPath(artifact: AgentRunArtifact): string | null {
    if (this.workspaceFiles) {
      try {
        return this.workspaceFiles.resolvePath(artifact.projectId, artifact.relativePath)
      } catch {
        // Some coding Agents report artifacts relative to the Run workspace instead.
      }
    }
    const run = this.database.getAgentRun(artifact.runId)
    if (!run.workingDirectory) return null
    const root = resolve(run.workingDirectory)
    const filePath = resolve(root, artifact.relativePath)
    const relation = relative(root, filePath)
    if (isAbsolute(relation) || relation === '..' || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      return null
    }
    return existsSync(filePath) ? filePath : null
  }

  private async prepareWorkAssistantMessage(message: BriefingMessage): Promise<CompanionRelayWorkAssistantMessage> {
    const attachments: CompanionAttachmentDescriptor[] = []
    for (const image of message.attachments) {
      const marker = ';base64,'
      const markerIndex = image.dataUrl.indexOf(marker)
      if (!image.dataUrl.startsWith(`data:${image.mimeType}`) || markerIndex < 0) continue
      const bytes = Buffer.from(image.dataUrl.slice(markerIndex + marker.length), 'base64')
      if (bytes.byteLength <= 0 || bytes.byteLength > 5 * 1024 * 1024) continue
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      await this.uploadAttachmentBytes(image.id, image.mimeType, bytes, sha256)
      attachments.push({
        id: image.id,
        messageId: message.id,
        artifactId: null,
        filename: image.name,
        mimeType: image.mimeType,
        size: bytes.byteLength,
        sha256,
        width: null,
        height: null,
        thumbnailAttachmentId: null,
        createdAt: message.createdAt
      })
    }
    return { ...message, attachments }
  }

  private async uploadAttachmentBytes(
    attachmentId: string,
    mimeType: string,
    bytes: Buffer,
    sha256: string
  ): Promise<void> {
    const context = this.authenticatedContext()
    const sealed = await sealCompanionAttachment(
      context.encryptionKey,
      bytes,
      companionAttachmentAssociatedData(context.configuration.accountId, attachmentId)
    )
    const encryptedSha256 = createHash('sha256').update(sealed).digest('hex')
    const response = await fetchWithTimeout(
      this.authenticatedUrl(`/v1/attachments/${encodeURIComponent(attachmentId)}`, context.configuration),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${context.token}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(sealed.byteLength),
          'X-Content-SHA256': encryptedSha256,
          'X-Companion-Encryption': 'A256GCM'
        },
        body: sealed as unknown as BodyInit
      },
      companionAttachmentRequestTimeoutMs
    )
    if (response.status !== 409 || !await this.existingAttachmentMatches(
      context,
      attachmentId,
      bytes.byteLength,
      sha256
    )) {
      await responseJson(response)
    }
  }

  private async hashFile(path: string): Promise<string> {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex')
  }

  private mimeTypeForPath(path: string): string {
    switch (extname(path).toLowerCase()) {
      case '.png': return 'image/png'
      case '.jpg':
      case '.jpeg': return 'image/jpeg'
      case '.gif': return 'image/gif'
      case '.webp': return 'image/webp'
      case '.pdf': return 'application/pdf'
      case '.json': return 'application/json'
      case '.txt':
      case '.md': return 'text/plain'
      case '.mp4': return 'video/mp4'
      default: return 'application/octet-stream'
    }
  }

  private async processPendingCommands(): Promise<void> {
    const context = this.authenticatedContext()
    const response = await fetchWithTimeout(this.authenticatedUrl('/v1/commands/pending', context.configuration), {
      headers: { Authorization: `Bearer ${context.token}` }
    })
    const body = await responseJson<{ commands: unknown[] }>(response)
    const commands = await Promise.all(body.commands.map(async (value) => {
      const encrypted = companionEncryptedCommandSchema.parse(value)
      const payload = await openCompanionJson(
        context.encryptionKey,
        encrypted.payload,
        companionCommandAssociatedData(encrypted)
      )
      return companionCommandSchema.parse({ ...encrypted, payload })
    }))
    const createCommands = commands.filter((command) => command.type === 'agent.create-session')
    await Promise.all(createCommands.map((command) => this.scheduleCommand(command)))
    for (const remoteCommand of commands) {
      if (remoteCommand.type === 'agent.create-session') continue
      const runId = this.commandRunId(remoteCommand)
      const activeCreation = runId ? this.activeRunCreations.get(runId) : null
      if (activeCreation) await activeCreation
      this.scheduleCommand(remoteCommand)
    }
    if (commands.length >= 100) this.scheduleEventSync()
  }

  private scheduleCommand(remoteCommand: CompanionCommand): Promise<void> {
    const active = this.activeCommands.get(remoteCommand.commandId)
    if (active) return active
    const createdRunId = remoteCommand.type === 'agent.create-session'
      ? this.commandRunId(remoteCommand)
      : null
    const operation = this.executeCommand(remoteCommand)
      .catch((error) => {
        this.lastError = error instanceof Error ? error.message : 'Mac 执行远程操作失败。'
        this.emitStatus()
      })
      .finally(() => {
        this.activeCommands.delete(remoteCommand.commandId)
        if (createdRunId && this.activeRunCreations.get(createdRunId) === operation) {
          this.activeRunCreations.delete(createdRunId)
        }
        this.scheduleEventSync()
      })
    this.activeCommands.set(remoteCommand.commandId, operation)
    if (createdRunId) this.activeRunCreations.set(createdRunId, operation)
    return operation
  }

  private async executeCommand(remoteCommand: CompanionCommand): Promise<void> {
    const existing = this.database.getCompanionCommand(remoteCommand.commandId)
    const recovery = companionCommandRecovery(existing?.status ?? null)
    if (recovery === 'ack-terminal' && existing) {
      await this.updateRemoteCommand(existing.commandId, existing.type, {
        status: existing.status === 'completed' ? 'completed' : 'failed',
        result: existing.result,
        error: existing.error
      })
      return
    }
    if (recovery === 'fail-interrupted') {
      if (remoteCommand.type === 'agent.create-session') {
        const runId = this.commandRunId(remoteCommand)
        const canonicalRun = runId ? this.database.listRuns().find((run) => run.id === runId) : null
        if (canonicalRun) {
          const updated = this.database.updateCompanionCommand(
            remoteCommand.commandId,
            'completed',
            this.database.getAgentRunDetail(canonicalRun.id)
          )
          this.database.enqueueCompanionCommandUpdate(updated)
          this.emitDataChanged()
          await this.updateRemoteCommand(remoteCommand.commandId, remoteCommand.type, {
            status: 'completed',
            result: updated.result
          })
          return
        }
      }
      const error = 'Mac 在执行远程操作期间中断；为避免重复执行，请确认结果后重新操作。'
      const updated = this.database.updateCompanionCommand(remoteCommand.commandId, 'failed', null, error)
      this.database.enqueueCompanionCommandUpdate(updated)
      this.emitDataChanged()
      await this.updateRemoteCommand(remoteCommand.commandId, remoteCommand.type, { status: 'failed', error })
      return
    }
    this.database.upsertCompanionCommand(remoteCommand)
    const executing = this.database.updateCompanionCommand(remoteCommand.commandId, 'executing')
    this.database.enqueueCompanionCommandUpdate(executing)
    await this.updateRemoteCommand(remoteCommand.commandId, remoteCommand.type, { status: 'executing' })
    let result: unknown
    try {
      result = await this.performCommand(remoteCommand)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Mac 执行远程操作失败。'
      const updated = this.database.updateCompanionCommand(remoteCommand.commandId, 'failed', null, message)
      this.database.enqueueCompanionCommandUpdate(updated)
      this.emitDataChanged()
      await this.updateRemoteCommand(remoteCommand.commandId, remoteCommand.type, { status: 'failed', error: message })
      return
    }
    const updated = this.database.updateCompanionCommand(remoteCommand.commandId, 'completed', result)
    this.database.enqueueCompanionCommandUpdate(updated)
    this.emitDataChanged()
    await this.updateRemoteCommand(remoteCommand.commandId, remoteCommand.type, { status: 'completed', result })
    this.scheduleEventSync()
  }

  private commandRunId(command: CompanionCommand): string | null {
    if (!command.payload || typeof command.payload !== 'object') return null
    const runId = (command.payload as Record<string, unknown>).runId
    return typeof runId === 'string' && runId.trim() ? runId.trim() : null
  }

  private async performCommand(remoteCommand: CompanionCommand): Promise<unknown> {
    const payload = remoteCommand.payload as Record<string, unknown>
    switch (remoteCommand.type) {
      case 'assistant.send-message': {
        const attachments = await this.materializeIncomingAttachments(remoteCommand.commandId, payload)
        const images = attachments
          .filter((attachment) => ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(attachment.descriptor.mimeType))
          .map((attachment): WorkAssistantImageAttachment => ({
            id: attachment.descriptor.id,
            name: attachment.descriptor.filename,
            mimeType: attachment.descriptor.mimeType as WorkAssistantImageAttachment['mimeType'],
            dataUrl: `data:${attachment.descriptor.mimeType};base64,${attachment.bytes.toString('base64')}`
          }))
        if (images.length !== attachments.length) throw new Error('工作助理当前只支持图片附件。')
        return await this.askWorkAssistant(this.requiredString(payload, 'prompt'), images)
      }
      case 'assistant.execute-action': {
        if (!this.executeWorkAssistantAction) throw new Error('工作助理 Action 能力尚未初始化。')
        return this.executeWorkAssistantAction({
          messageId: this.requiredString(payload, 'messageId'),
          proposalId: this.requiredString(payload, 'proposalId'),
          optionId: this.requiredString(payload, 'optionId')
        })
      }
      case 'agent.send-message': {
        const runId = this.requiredString(payload, 'runId')
        const clientMessageId = typeof payload.clientMessageId === 'string' && payload.clientMessageId.trim()
          ? payload.clientMessageId.trim()
          : undefined
        const attachments = await this.materializeIncomingAttachments(remoteCommand.commandId, payload)
        const attachmentContext = attachments.length > 0
          ? `\n\n用户从 iPhone 附加了以下本机文件，请按需读取：\n${attachments.map((attachment) => `- ${attachment.path}`).join('\n')}`
          : ''
        return await this.dispatcher.sendMessage(
          runId,
          `${this.requiredString(payload, 'prompt')}${attachmentContext}`,
          () => this.scheduleEventSync(),
          clientMessageId
        )
      }
      case 'agent.stop-message':
        return await this.dispatcher.stopMessage(this.requiredString(payload, 'runId'))
      case 'agent.create-session': {
        const projectId = typeof payload.projectId === 'string' && payload.projectId.trim()
          ? payload.projectId.trim()
          : null
        if (projectId && !this.database.listProjects().some((project) => project.id === projectId)) {
          throw new Error('没有找到所选项目。')
        }
        return this.dispatcher.createDraft({
          id: this.requiredString(payload, 'runId'),
          projectId,
          title: this.requiredString(payload, 'title')
        })
      }
      case 'agent.rename-session':
        return this.database.renameAgentRun(
          this.requiredString(payload, 'runId'),
          this.requiredString(payload, 'title')
        )
      case 'agent.update-draft-prompt':
        return this.database.updateAgentRunDraftPrompt(
          this.requiredString(payload, 'runId'),
          typeof payload.draftPrompt === 'string' ? payload.draftPrompt : ''
        )
      case 'agent.archive-session': {
        const runId = this.requiredString(payload, 'runId')
        this.database.archiveAgentRun(runId)
        return { runId, archived: true }
      }
      case 'chat.load-history': {
        const chatKind = this.requiredString(payload, 'chatKind')
        if (chatKind !== 'assistant' && chatKind !== 'agent') throw new Error('聊天类型无效。')
        const limit = Number(payload.limit)
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('聊天历史分页大小无效。')
        const page = this.database.getCompanionChatPage(
          chatKind as CompanionChatKind,
          this.requiredString(payload, 'chatId'),
          typeof payload.before === 'string' ? payload.before : null,
          limit
        )
        return await companionChatPageForRelay(page, (message) => this.prepareWorkAssistantMessage(message))
      }
      case 'artifact.request-upload': {
        const artifactId = this.requiredString(payload, 'artifactId')
        const artifact = this.database.getAgentRunArtifact(artifactId)
        if (!artifact) throw new Error('没有找到这个附件。')
        const attachment = await this.prepareArtifact(artifact)
        if (!attachment) throw new Error('附件文件不存在、不可访问或超过 100 MiB。')
        return { artifactId, attachment }
      }
      case 'decision.update-status': {
        const decisionId = this.requiredString(payload, 'decisionId')
        const status = this.requiredString(payload, 'status')
        if (!['inbox', 'in_progress', 'waiting', 'resolved', 'ignored'].includes(status)) throw new Error('Decision 状态无效。')
        return this.database.updateDecisionStatus(decisionId, status as DecisionStatus)
      }
      case 'decision.handle': {
        const decisionId = this.requiredString(payload, 'decisionId')
        const runId = this.requiredString(payload, 'runId')
        const decision = this.database.listDecisions().find((item) => item.id === decisionId)
        if (!decision) throw new Error('没有找到这个收件箱事项。')
        const existingRun = this.database.listRuns().find((item) => item.id === runId)
        const detail = existingRun ? this.database.getAgentRunDetail(runId) : await this.dispatcher.createDraft({
          id: runId,
          projectId: decision.projectId,
          decisionId: decision.id,
          provider: this.defaultCodingAgent(),
          title: `处理 · ${decision.title}`,
          draftPrompt: decision.summary
        })
        this.database.updateDecisionStatus(decision.id, 'in_progress')
        return detail
      }
      case 'project.update':
        return this.database.updateProject(updateProjectSchema.parse(payload.project))
    }
  }

  private async materializeIncomingAttachments(
    commandId: string,
    payload: Record<string, unknown>
  ): Promise<Array<{ descriptor: CompanionAttachmentDescriptor; path: string; bytes: Buffer }>> {
    if (!Array.isArray(payload.attachments) || payload.attachments.length === 0) return []
    if (payload.attachments.length > 4) throw new Error('一次最多发送 4 个附件。')
    const directory = join(this.incomingAttachmentsRoot, commandId.replace(/[^A-Za-z0-9._-]/g, '_'))
    mkdirSync(directory, { recursive: true })
    const context = this.authenticatedContext()
    const results: Array<{ descriptor: CompanionAttachmentDescriptor; path: string; bytes: Buffer }> = []
    for (const raw of payload.attachments) {
      if (!raw || typeof raw !== 'object') throw new Error('附件描述无效。')
      const value = raw as Record<string, unknown>
      const descriptor: CompanionAttachmentDescriptor = {
        id: this.requiredString(value, 'id'),
        messageId: null,
        artifactId: null,
        filename: basename(this.requiredString(value, 'filename')),
        mimeType: this.requiredString(value, 'mimeType'),
        size: Number(value.size),
        sha256: this.requiredString(value, 'sha256'),
        width: typeof value.width === 'number' ? value.width : null,
        height: typeof value.height === 'number' ? value.height : null,
        thumbnailAttachmentId: null,
        createdAt: this.requiredString(value, 'createdAt')
      }
      if (!Number.isInteger(descriptor.size) || descriptor.size <= 0 || descriptor.size > 20 * 1024 * 1024) {
        throw new Error('附件大小无效或超过 20 MiB。')
      }
      const response = await fetchWithTimeout(
        this.authenticatedUrl(`/v1/attachments/${encodeURIComponent(descriptor.id)}`, context.configuration),
        { headers: { Authorization: `Bearer ${context.token}` } },
        companionAttachmentRequestTimeoutMs
      )
      if (!response.ok) throw new Error(`附件下载失败（${response.status}）。`)
      const sealed = new Uint8Array(await response.arrayBuffer())
      const bytes = Buffer.from(await openCompanionAttachment(
        context.encryptionKey,
        sealed,
        companionAttachmentAssociatedData(context.configuration.accountId, descriptor.id)
      ))
      if (bytes.byteLength !== descriptor.size) throw new Error('附件大小校验失败。')
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      if (sha256.toLowerCase() !== descriptor.sha256.toLowerCase()) throw new Error('附件哈希校验失败。')
      const filePath = join(directory, `${descriptor.id}-${descriptor.filename}`)
      await writeFile(filePath, bytes)
      results.push({ descriptor, path: filePath, bytes })
    }
    return results
  }

  private async updateRemoteCommand(
    commandId: string,
    commandType: CompanionCommandType,
    update: CompanionCommandUpdate
  ): Promise<void> {
    const context = this.authenticatedContext()
    const response = await fetchWithTimeout(this.authenticatedUrl(`/v1/commands/${encodeURIComponent(commandId)}`, context.configuration), {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${context.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(companionCommandUpdateForRelay(commandType, update))
    })
    await responseJson(response)
  }

  private connectSocket(): void {
    if (this.socket || !this.configuration || this.stopped) return
    this.realtimeState = 'connecting'
    this.emitStatus()
    const context = this.authenticatedContext()
    const url = new URL(this.authenticatedUrl('/v1/connect', context.configuration))
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${context.token}` },
      handshakeTimeout: companionRequestTimeoutMs
    })
    this.socket = socket
    socket.on('open', () => {
      this.state = 'connected'
      this.realtimeState = 'connected'
      this.lastConnectedAt = new Date().toISOString()
      this.lastError = null
      this.reconnectAttempt = 0
      this.startSocketHeartbeat(socket)
      this.resetFallbackTimer()
      this.emitStatus()
    })
    socket.on('message', (data) => {
      if (this.socket !== socket) return
      const payload = data.toString()
      this.awaitingSocketPong = false
      this.lastConnectedAt = new Date().toISOString()
      if (payload === 'pong') {
        this.reconnectAttempt = 0
        this.emitStatus()
        return
      }
      try {
        const message = JSON.parse(payload) as CompanionSocketMessage
        this.reconnectAttempt = 0
        if (companionSocketMessageRequestsSync(message)) void this.syncNow()
      } catch {
        // A malformed push frame must not interrupt periodic synchronization.
      }
    })
    socket.on('error', (error) => {
      this.lastError = error.message
      this.emitStatus()
    })
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      this.stopSocketHeartbeat()
      if (!this.stopped && this.configuration) {
        this.realtimeState = 'disconnected'
        this.state = 'disconnected'
        this.resetFallbackTimer()
        this.emitStatus()
        const delay = companionReconnectDelayMs(this.reconnectAttempt)
        this.reconnectAttempt += 1
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null
          this.connectSocket()
        }, delay)
        this.reconnectTimer.unref?.()
      }
    })
  }

  private startSocketHeartbeat(socket: WebSocket): void {
    this.stopSocketHeartbeat()
    const heartbeat = (): void => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return
      if (companionSocketHeartbeatShouldReconnect(this.awaitingSocketPong)) {
        this.lastError = 'Companion 实时连接心跳超时，正在重连。'
        socket.terminate()
        return
      }
      this.awaitingSocketPong = true
      socket.send('ping', (error) => {
        if (!error || this.socket !== socket) return
        this.lastError = error.message
        socket.terminate()
      })
    }
    heartbeat()
    this.socketHeartbeatTimer = setInterval(heartbeat, companionSocketHeartbeatIntervalMs)
    this.socketHeartbeatTimer.unref?.()
  }

  private stopSocketHeartbeat(): void {
    if (this.socketHeartbeatTimer) clearInterval(this.socketHeartbeatTimer)
    this.socketHeartbeatTimer = null
    this.awaitingSocketPong = false
  }

  private authenticatedContext(): AuthenticatedCompanionContext {
    const { configuration, token } = this.authenticatedTokenContext()
    const encryptionKey = this.credentials.get(this.encryptionKeyReference(configuration.accountId))
    if (!encryptionKey || !configuration.encryptionKeyId) {
      throw new Error('Companion 端到端加密密钥不存在，请重新配对。')
    }
    return { configuration, token, encryptionKey }
  }

  private authenticatedTokenContext(): Omit<AuthenticatedCompanionContext, 'encryptionKey'> {
    if (!this.configuration) throw new Error('尚未配置 iPhone Companion。')
    const token = this.credentials.get(this.tokenReference(this.configuration.accountId))
    if (!token) throw new Error('Mac Companion 凭证不存在，请重新配对。')
    return { configuration: this.configuration, token }
  }

  private authenticatedUrl(path: string, configuration: CompanionMacConfiguration): string {
    const url = new URL(path, configuration.relayUrl)
    url.searchParams.set('accountId', configuration.accountId)
    url.searchParams.set('deviceId', configuration.macDeviceId)
    return url.toString()
  }

  private async revokeRemoteAccount(): Promise<void> {
    const context = this.authenticatedTokenContext()
    const response = await fetchWithTimeout(this.authenticatedUrl('/v1/account', context.configuration), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${context.token}` }
    })
    if (response.status === 204) return
    await responseJson(response)
  }

  private async revokePairingAccount(
    relayUrl: string,
    pairing: Pick<CompanionPairingStartResult, 'accountId' | 'macDeviceId' | 'macToken'>
  ): Promise<void> {
    const configuration: CompanionMacConfiguration = {
      relayUrl,
      accountId: pairing.accountId,
      macDeviceId: pairing.macDeviceId,
      pairedAt: new Date().toISOString()
    }
    const response = await fetchWithTimeout(this.authenticatedUrl('/v1/account', configuration), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${pairing.macToken}` }
    })
    if (response.status === 204) return
    await responseJson(response)
  }

  private tokenReference(accountId: string): string {
    return `companion.mac-token:${accountId}`
  }

  private encryptionKeyReference(accountId: string): string {
    return `companion.account-key:${accountId}`
  }

  private requiredString(payload: Record<string, unknown>, key: string): string {
    const value = payload[key]
    if (typeof value !== 'string' || !value.trim()) throw new Error(`远程操作缺少 ${key}。`)
    return value.trim()
  }

  private ensureTimer(): void {
    if (this.timer || !this.configuration || this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.syncNow().finally(() => this.ensureTimer())
    }, companionFallbackSyncIntervalForState(this.realtimeState))
    this.timer.unref?.()
  }

  private resetFallbackTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.ensureTimer()
  }

  private scheduleEventSync(): void {
    if (!this.configuration || this.stopped || this.eventSyncTimer) return
    this.eventSyncTimer = setTimeout(() => {
      this.eventSyncTimer = null
      void this.syncNow()
    }, companionEventSyncDebounceMs)
    this.eventSyncTimer.unref?.()
  }

  private closeTransports(): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.eventSyncTimer) clearTimeout(this.eventSyncTimer)
    this.timer = null
    this.reconnectTimer = null
    this.eventSyncTimer = null
    this.reconnectAttempt = 0
    this.stopSocketHeartbeat()
    this.realtimeState = 'disconnected'
    const socket = this.socket
    this.socket = null
    closeCompanionSocket(socket)
  }

  private emitStatus(): void {
    const status = this.getStatus()
    for (const listener of this.listeners) listener(status)
  }

  private emitDataChanged(): void {
    for (const listener of this.dataChangedListeners) listener()
  }
}
