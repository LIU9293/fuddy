import { hostname } from 'node:os'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import WebSocket from 'ws'
import type {
  CompanionCommand,
  CompanionCommandUpdate,
  CompanionMacConfiguration,
  CompanionMacStatus,
  CompanionPairingSession,
  CompanionPairingStartResult,
  CompanionSocketMessage,
  CompanionOutboxEvent,
  CompanionAttachmentDescriptor,
  CompanionSnapshotPayload
} from '../../shared/companion-sync'
import { companionProtocolVersion } from '../../shared/companion-sync'
import type { DecisionStatus } from '../../shared/contracts'
import type { AgentRunArtifact, BriefingMessage } from '../../shared/contracts'
import { AppDatabase } from './database'
import { CredentialVault } from './credential-vault'
import { TaskDispatcher } from './task-dispatcher'

const configurationKey = 'companion.mac-configuration'
const pollIntervalMs = 2_000
const reconnectDelayMs = 2_500

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
  private configuration: CompanionMacConfiguration | null
  private state: CompanionMacStatus['state'] = 'not-configured'
  private lastConnectedAt: string | null = null
  private lastError: string | null = null
  private socket: WebSocket | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private activeSync: Promise<CompanionMacStatus> | null = null
  private syncRequested = false
  private stopped = false
  private readonly listeners = new Set<(status: CompanionMacStatus) => void>()

  constructor(
    private readonly database: AppDatabase,
    private readonly credentials: CredentialVault,
    private readonly dispatcher: TaskDispatcher,
    private readonly askWorkAssistant: (question: string) => Promise<unknown>
  ) {
    this.configuration = database.getSetting<CompanionMacConfiguration | null>(configurationKey, null)
    this.state = this.configuration ? 'disconnected' : 'not-configured'
  }

  getStatus(): CompanionMacStatus {
    return {
      configuration: this.configuration,
      state: this.state,
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.lastError,
      pendingEvents: this.database.countPendingCompanionEvents()
    }
  }

  onStatusChanged(listener: (status: CompanionMacStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(): Promise<void> {
    this.stopped = false
    if (!this.configuration) return
    this.ensureTimer()
    await this.syncNow()
    this.connectSocket()
  }

  async beginPairing(relayUrl: string, deviceName?: string): Promise<CompanionPairingSession> {
    if (this.configuration) await this.revokeRemoteAccount()
    this.closeTransports()
    const origin = normalizedRelayUrl(relayUrl)
    const macDeviceId = crypto.randomUUID()
    const response = await fetch(`${origin}/v1/pairings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        macDeviceId,
        macDeviceName: deviceName?.trim() || hostname() || 'Mac'
      })
    })
    const pairing = await responseJson<CompanionPairingStartResult>(response)
    if (pairing.protocolVersion !== companionProtocolVersion) {
      throw new Error('Companion Relay 协议版本不兼容。')
    }
    if (this.configuration) this.credentials.delete(this.tokenReference(this.configuration.accountId))
    this.configuration = {
      relayUrl: origin,
      accountId: pairing.accountId,
      macDeviceId: pairing.macDeviceId,
      pairedAt: new Date().toISOString()
    }
    this.credentials.set(this.tokenReference(pairing.accountId), pairing.macToken)
    this.database.setSetting(configurationKey, this.configuration)
    this.database.enqueueCompanionSnapshot()
    this.state = 'connecting'
    this.lastError = null
    this.emitStatus()
    this.ensureTimer()
    await this.syncNow()
    this.connectSocket()
    return {
      pairingPayload: pairing.pairingPayload,
      expiresAt: pairing.expiresAt,
      status: this.getStatus()
    }
  }

  async disconnect(): Promise<void> {
    if (this.configuration) await this.revokeRemoteAccount()
    if (this.configuration) this.credentials.delete(this.tokenReference(this.configuration.accountId))
    this.database.setSetting<CompanionMacConfiguration | null>(configurationKey, null)
    this.configuration = null
    this.state = 'not-configured'
    this.lastConnectedAt = null
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
      this.lastConnectedAt = new Date().toISOString()
      this.lastError = null
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
    for (const event of this.database.listPendingCompanionEvents()) {
      try {
        const payload = await this.prepareEventPayload(event)
        const response = await fetch(this.authenticatedUrl('/v1/events', context.configuration), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${context.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            eventId: event.eventId,
            protocolVersion: event.protocolVersion,
            type: event.type,
            entityType: event.entityType,
            entityId: event.entityId,
            revision: event.revision,
            payload,
            occurredAt: event.occurredAt
          })
        })
        await responseJson(response)
        this.database.markCompanionEventPublished(event.eventId, new Date().toISOString())
      } catch (error) {
        const message = error instanceof Error ? error.message : '事件上传失败。'
        this.database.markCompanionEventFailed(event.eventId, message)
        throw error
      }
    }
  }

  private async prepareEventPayload(event: CompanionOutboxEvent): Promise<unknown> {
    if (event.type === 'snapshot.created') {
      const snapshot = event.payload as CompanionSnapshotPayload
      const attachments = (await Promise.all(
        snapshot.runs.flatMap((detail) => detail.artifacts.map((artifact) =>
          this.prepareArtifact(artifact as AgentRunArtifact)
        ))
      )).filter((attachment): attachment is CompanionAttachmentDescriptor => attachment !== null)
      return {
        ...snapshot,
        attachments,
        workAssistantMessages: await Promise.all(
          (snapshot.workAssistantMessages ?? []).map((message) => this.prepareWorkAssistantMessage(message as BriefingMessage))
        )
      }
    }
    if (event.type === 'work-assistant-message.created') {
      return await this.prepareWorkAssistantMessage(event.payload as BriefingMessage)
    }
    if (event.type !== 'artifact.updated') return event.payload
    const artifactId = event.entityId
    const artifact = this.database.getAgentRunArtifact(artifactId)
    if (!artifact) return event.payload
    return { artifact, attachment: await this.prepareArtifact(artifact) }
  }

  private async prepareArtifact(artifact: AgentRunArtifact): Promise<CompanionAttachmentDescriptor | null> {
    const run = this.database.getAgentRun(artifact.runId)
    if (!run.workingDirectory) return null
    const filePath = resolve(run.workingDirectory, artifact.relativePath)
    const relation = relative(resolve(run.workingDirectory), filePath)
    if (isAbsolute(relation) || relation.startsWith('..') || !existsSync(filePath)) {
      return null
    }
    const file = statSync(filePath)
    if (!file.isFile() || file.size <= 0 || file.size > 100 * 1024 * 1024) {
      return null
    }
    const sha256 = await this.hashFile(filePath)
    const mimeType = artifact.mimeType ?? this.mimeTypeForPath(filePath)
    const context = this.authenticatedContext()
    const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream
    const response = await fetch(
      this.authenticatedUrl(`/v1/attachments/${encodeURIComponent(artifact.id)}`, context.configuration),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${context.token}`,
          'Content-Type': mimeType,
          'Content-Length': String(file.size),
          'X-Content-SHA256': sha256
        },
        body,
        duplex: 'half'
      } as RequestInit & { duplex: 'half' }
    )
    await responseJson(response)
    return {
      id: artifact.id,
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

  private async prepareWorkAssistantMessage(message: BriefingMessage): Promise<unknown> {
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
    const response = await fetch(
      this.authenticatedUrl(`/v1/attachments/${encodeURIComponent(attachmentId)}`, context.configuration),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${context.token}`,
          'Content-Type': mimeType,
          'Content-Length': String(bytes.byteLength),
          'X-Content-SHA256': sha256
        },
        body: bytes as unknown as BodyInit
      }
    )
    await responseJson(response)
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
    const response = await fetch(this.authenticatedUrl('/v1/commands/pending', context.configuration), {
      headers: { Authorization: `Bearer ${context.token}` }
    })
    const body = await responseJson<{ commands: CompanionCommand[] }>(response)
    for (const remoteCommand of body.commands) await this.executeCommand(remoteCommand)
  }

  private async executeCommand(remoteCommand: CompanionCommand): Promise<void> {
    const existing = this.database.getCompanionCommand(remoteCommand.commandId)
    if (existing?.status === 'completed' || existing?.status === 'failed') {
      await this.updateRemoteCommand(existing.commandId, {
        status: existing.status,
        result: existing.result,
        error: existing.error
      })
      return
    }
    this.database.upsertCompanionCommand(remoteCommand)
    this.database.updateCompanionCommand(remoteCommand.commandId, 'executing')
    await this.updateRemoteCommand(remoteCommand.commandId, { status: 'executing' })
    try {
      const payload = remoteCommand.payload as Record<string, unknown>
      let result: unknown
      switch (remoteCommand.type) {
        case 'assistant.send-message': {
          result = await this.askWorkAssistant(this.requiredString(payload, 'prompt'))
          break
        }
        case 'agent.send-message': {
          const runId = this.requiredString(payload, 'runId')
          const prompt = this.requiredString(payload, 'prompt')
          result = await this.dispatcher.sendMessage(runId, prompt)
          break
        }
        case 'agent.rename-session': {
          const runId = this.requiredString(payload, 'runId')
          result = this.database.renameAgentRun(runId, this.requiredString(payload, 'title'))
          break
        }
        case 'agent.archive-session': {
          const runId = this.requiredString(payload, 'runId')
          this.database.archiveAgentRun(runId)
          result = { runId, archived: true }
          break
        }
        case 'decision.update-status': {
          const decisionId = this.requiredString(payload, 'decisionId')
          const status = this.requiredString(payload, 'status')
          if (!['inbox', 'later', 'resolved'].includes(status)) throw new Error('Decision 状态无效。')
          result = this.database.updateDecisionStatus(decisionId, status as DecisionStatus)
          break
        }
      }
      this.database.updateCompanionCommand(remoteCommand.commandId, 'completed', result)
      await this.updateRemoteCommand(remoteCommand.commandId, { status: 'completed', result })
      await this.flushOutbox()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Mac 执行远程操作失败。'
      this.database.updateCompanionCommand(remoteCommand.commandId, 'failed', null, message)
      await this.updateRemoteCommand(remoteCommand.commandId, { status: 'failed', error: message })
    }
  }

  private async updateRemoteCommand(commandId: string, update: CompanionCommandUpdate): Promise<void> {
    const context = this.authenticatedContext()
    const response = await fetch(this.authenticatedUrl(`/v1/commands/${encodeURIComponent(commandId)}`, context.configuration), {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${context.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(update)
    })
    await responseJson(response)
  }

  private connectSocket(): void {
    if (this.socket || !this.configuration || this.stopped) return
    const context = this.authenticatedContext()
    const url = new URL(this.authenticatedUrl('/v1/connect', context.configuration))
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${context.token}` } })
    this.socket = socket
    socket.on('open', () => {
      this.state = 'connected'
      this.lastConnectedAt = new Date().toISOString()
      this.lastError = null
      this.emitStatus()
    })
    socket.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as CompanionSocketMessage
        if (message.type === 'command.created') void this.syncNow()
      } catch {
        // A malformed push frame must not interrupt periodic synchronization.
      }
    })
    socket.on('error', (error) => {
      this.lastError = error.message
      this.emitStatus()
    })
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null
      if (!this.stopped && this.configuration) {
        this.state = 'disconnected'
        this.emitStatus()
        this.reconnectTimer = setTimeout(() => this.connectSocket(), reconnectDelayMs)
        this.reconnectTimer.unref?.()
      }
    })
  }

  private authenticatedContext(): { configuration: CompanionMacConfiguration; token: string } {
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
    const context = this.authenticatedContext()
    const response = await fetch(this.authenticatedUrl('/v1/account', context.configuration), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${context.token}` }
    })
    if (response.status === 204) return
    await responseJson(response)
  }

  private tokenReference(accountId: string): string {
    return `companion.mac-token:${accountId}`
  }

  private requiredString(payload: Record<string, unknown>, key: string): string {
    const value = payload[key]
    if (typeof value !== 'string' || !value.trim()) throw new Error(`远程操作缺少 ${key}。`)
    return value.trim()
  }

  private ensureTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.syncNow(), pollIntervalMs)
    this.timer.unref?.()
  }

  private closeTransports(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.timer = null
    this.reconnectTimer = null
    const socket = this.socket
    this.socket = null
    socket?.removeAllListeners()
    socket?.terminate()
  }

  private emitStatus(): void {
    const status = this.getStatus()
    for (const listener of this.listeners) listener(status)
  }
}
