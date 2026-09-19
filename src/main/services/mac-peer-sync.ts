import { createHash, randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import WebSocket from 'ws'
import type { AccountSyncSpace, ExecutionHost } from '../../shared/account'
import type { AgentRun, AgentRunArtifactPreview, AgentRunDetail, CreateAgentRunDraftInput, Project } from '../../shared/contracts'
import type { ChatAttachmentInput } from '../../shared/chat-attachments'
import type { CompanionAttachmentDescriptor, CompanionCommand, CompanionCommandType, CompanionEncryptedCommandInput, CompanionEncryptedEventPage, CompanionSyncEvent } from '../../shared/companion-sync'
import { companionProtocolVersion, companionAttachmentPlaintextMaximumBytes } from '../../shared/companion-sync'
import { commandSchema, syncEventSchema, companionAttachmentDescriptorSchema, companionChatPageSchema, companionEncryptedCommandSchema } from '../../shared/companion-schemas'
import { companionAttachmentAssociatedData, companionCommandAssociatedData, companionEventAssociatedData, openCompanionAttachment, openCompanionJson, sealCompanionAttachment, sealCompanionJson } from '../../shared/companion-crypto'
import { flattenAgentChatRecords } from '../../shared/companion-chat'
import { primaryWorkspaceRoot } from '../../shared/project-workspaces'
import type { AccountService } from './account-service'
import type { AccountRelayCredentials } from './account-device-grant'
import type { CredentialVault } from './credential-vault'
import type { AppDatabase } from './database'
import { resolveCompanionRelayUrl } from './account-enrollment-coordinator'
import type { FuddyRuntimeChannel } from '../runtime-profile'

interface PeerCache {
  sequence: number
  projects: Project[]
  goals?: import('../../shared/contracts').ProjectGoal[]
  runs: AgentRunDetail[]
  attachments: CompanionAttachmentDescriptor[]
  commands: Record<string, Pick<CompanionCommand, 'status' | 'error'>>
  history?: Record<string, { hasMore: boolean; nextBefore: string | null }>
}
interface Peer {
  space: AccountSyncSpace
  cache: PeerCache
  credentials: AccountRelayCredentials | null
  online: boolean
  lastSync: number
  error: string | null
  socket?: WebSocket
  pongAt?: number
  reading?: Promise<void>
}
const emptyCache = (): PeerCache => ({ sequence: 0, projects: [], runs: [], attachments: [], commands: {} })
const remotePrefix = 'remote:'
class PeerRequestError extends Error {
  constructor(readonly status: number) { super(`远程 Mac 同步请求失败（${status}）。`) }
}
export function remoteRunId(hostId: string, runId: string): string { return `${remotePrefix}${encodeURIComponent(hostId)}:${encodeURIComponent(runId)}` }
export function parseRemoteRunId(id: string): { hostId: string; runId: string } | null {
  if (!id.startsWith(remotePrefix)) return null
  const parts = id.slice(remotePrefix.length).split(':')
  if (parts.length !== 2) throw new Error('远程 Run 标识无效。')
  return { hostId: decodeURIComponent(parts[0]), runId: decodeURIComponent(parts[1]) }
}

/** A Mac is an encrypted Relay client of its peers, never a second writer to their databases. */
export class MacPeerSyncService {
  private peers = new Map<string, Peer>()
  private owner: string | null = null
  private timer: NodeJS.Timeout | null = null
  private active: Promise<void> | null = null
  private generation = 0
  private stopped = true
  private lastDiscovery = 0
  private discoveryError: string | null = null
  private lastNotification = ''

  constructor(
    private database: AppDatabase,
    private account: AccountService,
    private vault: Pick<CredentialVault, 'get' | 'set' | 'delete'>,
    private channel: FuddyRuntimeChannel,
    private changed: () => void = () => undefined,
    private fetchImpl: typeof fetch = fetch,
    private realtime = true
  ) {}

  start(): void {
    this.stopped = false
    if (this.timer) return
    void this.syncNow()
    this.timer = setInterval(() => void this.syncNow(), 15_000)
    this.timer.unref?.()
  }
  stop(): void {
    this.stopped = true
    this.generation++
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const peer of this.peers.values()) peer.socket?.close()
    this.peers.clear()
    this.owner = null
  }
  private key(spaceId: string): string { return `mac-peer:${this.owner}:${spaceId}` }
  private current(): boolean { return !this.stopped && this.owner !== null && this.account.getState().user?.id === this.owner }
  private notify(): void {
    const signature = JSON.stringify([this.owner, this.discoveryError, [...this.peers.values()].map((peer) => [peer.space.hostId, peer.space.hostName, peer.online, peer.error, peer.cache.sequence])])
    if (signature === this.lastNotification) return
    this.lastNotification = signature
    this.changed()
  }

  async syncNow(): Promise<void> {
    if (this.stopped) return
    if (this.active) return this.active
    this.active = this.sync().catch(() => {
      for (const peer of this.peers.values()) peer.online = false
      this.notify()
    }).finally(() => { this.active = null })
    return this.active
  }

  private async sync(): Promise<void> {
    const state = this.account.getState()
    if (state.user?.id !== this.owner || state.status !== 'signed-in') {
      this.generation++
      for (const peer of this.peers.values()) peer.socket?.close()
      this.peers.clear()
      this.owner = state.status === 'signed-in' ? state.user?.id ?? null : null
      this.lastDiscovery = 0
      if (this.owner) for (const space of this.database.getSetting<AccountSyncSpace[]>(`mac-peer:${this.owner}:spaces`, [])) {
        this.peers.set(space.hostId, { space, cache: this.database.getSetting<PeerCache>(`${this.key(space.id)}:cache`, emptyCache()), credentials: null, online: false, lastSync: 0, error: null })
      }
      this.notify()
    }
    if (!this.current()) return
    const generation = this.generation
    const projects = this.database.accountProjects(this.owner!)
    const publishedKey = `mac-peer:${this.owner}:published-identities`
    const published = this.database.getSetting<string[]>(publishedKey, [])
    const missing = projects.filter((project) => project.shared && !published.includes(project.shared.id))
    for (const project of missing) this.database.publishProjectForSync(project)
    if (missing.length) this.database.setSetting(publishedKey, [...published, ...missing.map((project) => project.shared!.id)])
    if (Date.now() - this.lastDiscovery > 15_000) {
      try {
        const spaces = await this.account.listSyncSpaces()
        if (!this.current() || generation !== this.generation) return
        this.discoveryError = null
        this.lastDiscovery = Date.now()
        const ids = new Set(spaces.map((space) => space.hostId))
        this.database.setSetting(`mac-peer:${this.owner}:spaces`, spaces.filter((space) => space.hostId !== state.device?.hostId))
        for (const [id, peer] of this.peers) if (!ids.has(id)) {
          peer.socket?.close()
          this.vault.delete(this.key(peer.space.id))
          this.peers.delete(id)
        }
        for (const space of spaces) {
          if (space.hostId === state.device?.hostId) continue
          const previous = this.peers.get(space.hostId)
          if (previous && previous.space.relayAccountId !== space.relayAccountId) {
            previous.socket?.close()
            this.vault.delete(this.key(previous.space.id))
            this.peers.delete(space.hostId)
          }
          const peer = this.peers.get(space.hostId)
          if (peer) peer.space = space
          else this.peers.set(space.hostId, {
            space, cache: this.database.getSetting<PeerCache>(`${this.key(space.id)}:cache`, emptyCache()),
            credentials: null, online: false, lastSync: 0, error: null
          })
        }
      } catch {
        this.discoveryError = '暂时无法核验其他 Mac，请检查账户连接。'
        for (const peer of this.peers.values()) peer.online = false
        this.notify()
        return
      }
    }
    await Promise.allSettled([...this.peers.values()].map(async (peer) => {
      try {
        if (!peer.space.relayBound || !peer.space.relayUrl) throw new Error('等待这台 Mac 完成同步连接。')
        const relayUrl = resolveCompanionRelayUrl(peer.space.relayUrl, this.channel)
        if (!relayUrl) throw new Error('这台 Mac 的同步服务不可用。')
        if (!peer.credentials) {
          const stored = this.vault.get(this.key(peer.space.id))
          if (stored) peer.credentials = JSON.parse(stored) as AccountRelayCredentials
          else {
            const enrollmentKey = `${this.key(peer.space.id)}:enrollment`
            const enrollmentId = this.database.getSetting<string | null>(enrollmentKey, null)
            try {
              const grant = await this.account.enrollMacPeer(peer.space.id, enrollmentId ?? undefined)
              if (!this.current() || generation !== this.generation) return
              this.database.setSetting(enrollmentKey, grant.id)
              if (!grant.credentials) { peer.error = '等待另一台 Mac 在线授权。'; return }
              peer.credentials = grant.credentials
              this.vault.set(this.key(peer.space.id), JSON.stringify(grant.credentials))
            } catch (error) {
              this.database.setSetting(enrollmentKey, null)
              throw error
            }
          }
        }
        const credentials = peer.credentials
        if (credentials.relayURL.replace(/\/$/, '') !== relayUrl || credentials.accountID !== peer.space.relayAccountId || credentials.deviceID !== state.device?.id) {
          throw new Error('Mac 授权与账户同步空间不一致。')
        }
        if (Date.now() - peer.lastSync > 60_000 || !peer.socket || peer.socket.readyState !== WebSocket.OPEN) await this.readEvents(peer)
        await this.deliverPending(peer)
        if (!this.current() || generation !== this.generation) return
        if (this.realtime) this.connect(peer)
        if (peer.socket?.readyState === WebSocket.OPEN) {
          if (peer.pongAt && Date.now() - peer.pongAt > 45_000) peer.socket.terminate()
          else peer.socket.send(JSON.stringify({ type: 'ping' }))
        }
        peer.error = null
      } catch (error) {
        peer.online = false
        peer.error = error instanceof Error ? error.message : 'Mac 连接失败。'
      }
    }))
    if (this.current()) this.notify()
  }

  private url(peer: Peer, path: string): URL {
    const url = new URL(`${peer.credentials!.relayURL.replace(/\/$/, '')}${path}`)
    url.searchParams.set('accountId', peer.credentials!.accountID)
    url.searchParams.set('deviceId', peer.credentials!.deviceID)
    return url
  }
  private async request(peer: Peer, path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.current() || !peer.credentials) throw new Error('Mac 连接已关闭。')
    const url = this.url(peer, path)
    const generation = this.generation
    const response = await this.fetchImpl(url, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { ...init.headers, Authorization: `Bearer ${peer.credentials.deviceToken}` }
    })
    if (!this.current() || generation !== this.generation) throw new Error('账户已切换。')
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.vault.delete(this.key(peer.space.id))
        this.database.setSetting(`${this.key(peer.space.id)}:enrollment`, null)
        peer.socket?.close()
        peer.credentials = null
      }
      throw new PeerRequestError(response.status)
    }
    return response
  }
  private connect(peer: Peer): void {
    if (peer.socket && peer.socket.readyState !== WebSocket.CLOSED) return
    const url = this.url(peer, '/v1/connect')
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${peer.credentials!.deviceToken}` }, handshakeTimeout: 15_000 })
    peer.socket = socket
    peer.pongAt = Date.now()
    socket.on('error', () => { peer.online = false })
    socket.on('close', () => { peer.online = false; this.notify() })
    socket.on('message', (bytes) => {
      if (!this.current() || peer.socket !== socket) return
      try {
        const message = JSON.parse(String(bytes))
        peer.pongAt = Date.now()
        if (message.presence) peer.online = message.presence.macOnline === true
        if (['sync.ready', 'sync.available', 'presence.updated'].includes(message.type)) {
          peer.lastSync = 0
          void this.syncNow()
        }
      } catch { socket.close() }
    })
  }
  private async readEvents(peer: Peer): Promise<void> {
    if (peer.reading) return peer.reading
    peer.reading = this.replay(peer).finally(() => { peer.reading = undefined })
    return peer.reading
  }
  private async replay(peer: Peer): Promise<void> {
    const generation = this.generation
    // A cursor is committed only after all decrypted, validated events were applied.
    for (let pageIndex = 0; pageIndex < 60; pageIndex++) {
      const page = await (await this.request(peer, `/v1/events?after=${peer.cache.sequence}`)).json() as CompanionEncryptedEventPage
      if (page.minimumProtocolVersion > companionProtocolVersion) throw new Error('请更新本机 Fuddy 后连接这台 Mac。')
      if (page.replayResetSequence !== undefined) peer.cache = { ...emptyCache(), sequence: page.replayResetSequence }
      for (const encrypted of page.events) {
        const payload = await openCompanionJson(peer.credentials!.encryptionKey, encrypted.payload, companionEventAssociatedData(encrypted))
        if (!this.current() || generation !== this.generation) throw new Error('账户已切换。')
        const parsed = syncEventSchema.parse({ ...encrypted, payload })
        this.apply(peer, { ...parsed, sequence: encrypted.sequence, sourceDeviceId: encrypted.sourceDeviceId } as CompanionSyncEvent)
        peer.cache.sequence = encrypted.sequence
      }
      peer.online = page.presence?.macOnline === true
      peer.lastSync = Date.now()
      this.database.setSetting(`${this.key(peer.space.id)}:cache`, peer.cache)
      // Relay's lastSequence is the last event in this page, not a global high watermark.
      // Read through an empty page before declaring the peer caught up.
      if (!page.events.length) return
    }
    peer.lastSync = 0
    throw new Error('远程 Mac 仍有积压事件，正在继续同步。')
  }
  private apply(peer: Peer, event: CompanionSyncEvent): void {
    const cache = peer.cache
    switch (event.type) {
      case 'snapshot.created':
        cache.projects = event.payload.projects
        cache.goals = event.payload.goals
        cache.runs = event.payload.runs
        cache.attachments = event.payload.attachments
        cache.history = {}
        for (const project of cache.projects) if (project.shared) this.database.mergeAccountProject(project, this.owner!)
        for (const goal of event.payload.goals) this.mergeGoal(peer, goal)
        for (const page of event.payload.chatPages ?? []) if (page.chatKind === 'agent') {
          const detail = cache.runs.find((item) => item.run.id === page.chatId)
          if (detail) detail.messages = flattenAgentChatRecords(page.records)
          cache.history[page.chatId] = { hasMore: page.hasMore, nextBefore: page.nextBefore }
        }
        break
      case 'project.created': case 'project.updated':
        cache.projects = [...cache.projects.filter((project) => project.id !== event.payload.id), event.payload]
        if (event.payload.shared) this.database.mergeAccountProject(event.payload, this.owner!)
        for (const goal of cache.goals ?? []) if (goal.projectId === event.payload.id) this.mergeGoal(peer, goal)
        break
      case 'goal.created': case 'goal.updated':
        cache.goals = [...(cache.goals ?? []).filter((goal) => goal.id !== event.payload.id), event.payload]
        this.mergeGoal(peer, event.payload)
        break
      case 'agent-run.created': case 'agent-run.updated': {
        const detail = cache.runs.find((item) => item.run.id === event.payload.id)
        if (detail) detail.run = event.payload
        else cache.runs.push({ run: event.payload, messages: [], artifacts: [] })
        break
      }
      case 'agent-run.archived': cache.runs = cache.runs.filter((item) => item.run.id !== event.payload.id); break
      case 'agent-message.created': {
        const detail = cache.runs.find((item) => item.run.id === event.payload.runId)
        if (detail) {
          detail.messages = [...detail.messages.filter((message) => message.id !== event.payload.id), event.payload]
          detail.run.updatedAt = event.occurredAt
        }
        break
      }
      case 'chat-page.updated': {
        const detail = cache.runs.find((item) => item.run.id === event.payload.chatId)
        if (detail) {
          detail.messages = [...new Map([...detail.messages, ...flattenAgentChatRecords(event.payload.records)].map((message) => [message.id, message])).values()]
          detail.run.updatedAt = event.occurredAt
          cache.history ??= {}
          cache.history[event.payload.chatId] ??= { hasMore: event.payload.hasMore, nextBefore: event.payload.nextBefore }
        }
        break
      }
      case 'artifact.updated': {
        const artifact = 'artifact' in event.payload ? event.payload.artifact : event.payload
        const detail = cache.runs.find((item) => item.run.id === artifact.runId)
        if (detail) detail.artifacts = [...detail.artifacts.filter((item) => item.id !== artifact.id), artifact]
        const attachment = 'attachment' in event.payload ? event.payload.attachment : null
        if (attachment) cache.attachments = [...cache.attachments.filter((item) => item.id !== attachment.id), attachment]
        break
      }
      case 'command.updated': {
        if (event.payload.type === 'artifact.request-upload' && event.payload.status === 'completed' && event.payload.result && typeof event.payload.result === 'object' && 'attachment' in event.payload.result) {
          const attachment = companionAttachmentDescriptorSchema.parse(event.payload.result.attachment)
          cache.attachments = [...cache.attachments.filter((item) => item.id !== attachment.id), attachment]
        }
        if (event.payload.type === 'chat.load-history' && event.payload.status === 'completed') {
          const page = companionChatPageSchema.parse(event.payload.result)
          const detail = cache.runs.find((item) => item.run.id === page.chatId)
          if (detail) {
            detail.messages = [...new Map([...flattenAgentChatRecords(page.records), ...detail.messages].map((message) => [message.id, message])).values()]
            cache.history ??= {}
            cache.history[page.chatId] = { hasMore: page.hasMore, nextBefore: page.nextBefore }
          }
        }
        cache.commands[event.payload.commandId] = { status: event.payload.status, error: event.payload.error }
        // Bound terminal status cache; commands themselves remain durably deduplicated on the owning Mac.
        const keys = Object.keys(cache.commands)
        for (const id of keys.slice(0, Math.max(0, keys.length - 1000))) delete cache.commands[id]
        break
      }
    }
  }

  private mergeGoal(peer: Peer, goal: import('../../shared/contracts').ProjectGoal): void {
    const remoteProject = peer.cache.projects.find((project) => project.id === goal.projectId)
    const local = remoteProject?.shared ? this.database.accountProjects(this.owner!).find((project) => project.shared?.id === remoteProject.shared!.id) : null
    if (local) this.database.mergeAccountGoal(goal, local.id, peer.space.hostId)
  }

  listHosts(projectId: string | null): ExecutionHost[] {
    const state = this.account.getState()
    const project = this.database.listProjects().find((item) => item.id === projectId)
    let configured = !projectId
    try { if (project) configured = statSync(primaryWorkspaceRoot(project.profile)?.path ?? '').isDirectory() } catch { configured = false }
    return [{ id: state.device?.hostId ?? 'local', name: state.device?.name ?? '这台 Mac', isCurrent: true, online: true, workspaceConfigured: configured, unavailableReason: configured ? null : '请先配置本机主文件夹' },
      ...[...this.peers.values()].filter(() => this.current()).map((peer): ExecutionHost => {
        const remoteProject = project?.shared ? peer.cache.projects.find((item) => item.shared?.id === project.shared!.id) : undefined
        const workspaceConfigured = !projectId || Boolean(remoteProject && primaryWorkspaceRoot(remoteProject.profile))
        const online = peer.online && !this.discoveryError
        return { id: peer.space.hostId, name: peer.space.hostName, isCurrent: false, online, workspaceConfigured,
          unavailableReason: !online ? peer.error ?? this.discoveryError ?? '离线' : !workspaceConfigured ? '请在这台 Mac 配置主文件夹' : null }
      })]
  }
  private locate(id: string): { peer: Peer; runId: string } {
    const remote = parseRemoteRunId(id)
    const peer = remote && this.current() ? this.peers.get(remote.hostId) : null
    if (!remote || !peer) throw new Error('执行 Mac 不可用，请检查账户连接。')
    return { peer, runId: remote.runId }
  }
  private decorate(peer: Peer, detail: AgentRunDetail): AgentRunDetail {
    const id = remoteRunId(peer.space.hostId, detail.run.id)
    const remoteProject = peer.cache.projects.find((item) => item.id === detail.run.projectId)
    const localProject = remoteProject?.shared ? this.database.accountProjects(this.owner!).find((item) => item.shared?.id === remoteProject.shared!.id) : null
    return { ...detail, remoteHistory: { hasMore: peer.cache.history?.[detail.run.id]?.hasMore ?? false }, run: { ...detail.run, id, projectId: localProject?.id ?? null,
      workingDirectory: null, executionHost: { id: peer.space.hostId, name: peer.space.hostName, online: peer.online && !this.discoveryError } },
      messages: detail.messages.map((message) => ({ ...message, runId: id })),
      artifacts: detail.artifacts.map((artifact) => ({ ...artifact, runId: id, projectId: localProject?.id ?? null })) }
  }
  listRuns(): AgentRun[] { return this.current() ? [...this.peers.values()].flatMap((peer) => peer.cache.runs.map((detail) => this.decorate(peer, detail).run)) : [] }
  getDetail(id: string): AgentRunDetail {
    const { peer, runId } = this.locate(id)
    const detail = peer.cache.runs.find((item) => item.run.id === runId)
    if (!detail) throw new Error('远程 Run 尚未同步，请稍后重试。')
    return this.decorate(peer, detail)
  }

  async loadHistory(id: string): Promise<AgentRunDetail> {
    const { peer, runId } = this.locate(id)
    const history = peer.cache.history?.[runId]
    if (history?.hasMore && history.nextBefore) await this.command(peer, 'chat.load-history', { chatKind: 'agent', chatId: runId, before: history.nextBefore, limit: 100 })
    return this.getDetail(id)
  }

  private async command(peer: Peer, type: CompanionCommandType, payload: unknown, commandId: string = randomUUID()): Promise<void> {
    await this.readEvents(peer)
    if (!peer.online || this.discoveryError) throw new Error('执行 Mac 当前离线，无法提交操作。')
    const command = commandSchema.parse({ commandId, protocolVersion: companionProtocolVersion, type, payload, createdAt: new Date().toISOString() })
    const envelope = { ...command, payload: await sealCompanionJson(peer.credentials!.encryptionKey, command.payload, companionCommandAssociatedData(command)) }
    // Persist the exact ID and encrypted request before delivery. Never generate a new ID on retry.
    const pendingKey = `${this.key(peer.space.id)}:pending`
    const pending = this.database.getSetting<Record<string, CompanionEncryptedCommandInput>>(pendingKey, {})
    if (Object.keys(pending).length >= 100) throw new Error('等待确认的远程操作过多，请先恢复 Mac 连接。')
    pending[commandId] = envelope
    this.database.setSetting(pendingKey, pending)
    let delivered = false
    const started = Date.now()
    while (this.current() && Date.now() - started < 30 * 60_000) {
      if (!delivered) {
        try {
          await this.postCommand(peer, envelope)
          delivered = true
        } catch (error) {
          if (error instanceof PeerRequestError && [400, 404, 409, 413, 422].includes(error.status)) {
            const remaining = this.database.getSetting<Record<string, CompanionEncryptedCommandInput>>(pendingKey, {})
            delete remaining[commandId]
            this.database.setSetting(pendingKey, remaining)
            throw new Error('执行 Mac 或同步服务拒绝了操作，请确认两端和 Relay 已更新。')
          }
          if (Date.now() - started > 30_000) throw new Error('操作发送状态暂时无法确认；请查看原 Run，勿重复提交。')
        }
      }
      try { await this.readEvents(peer) } catch {
        peer.online = false
        this.notify()
        throw new Error('操作已保存，但远程结果暂时无法确认；恢复连接后会以原操作 ID 继续同步，请勿重复提交。')
      }
      this.notify()
      const result = peer.cache.commands[commandId]
      if (result?.status === 'failed' || result?.status === 'completed') {
        const remaining = this.database.getSetting<Record<string, CompanionEncryptedCommandInput>>(pendingKey, {})
        delete remaining[commandId]
        this.database.setSetting(pendingKey, remaining)
        if (result.status === 'failed') throw new Error(result.error ?? '远程操作失败。')
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error('远程操作仍未确认，请回到原 Run 查看执行结果。')
  }

  private async postCommand(peer: Peer, command: CompanionEncryptedCommandInput): Promise<void> {
    const response = await this.request(peer, '/v1/commands', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command)
    })
    const receipt = companionEncryptedCommandSchema.parse(await response.json())
    if (receipt.commandId !== command.commandId || receipt.sourceDeviceId !== peer.credentials?.deviceID) throw new Error('远程操作回执不匹配。')
    // A compacted event log may no longer contain the original encrypted outcome.
    // The durable command receipt still confirms that this ID has finished.
    if (receipt.status === 'completed' || receipt.status === 'failed') {
      const previous = peer.cache.commands[command.commandId]?.status
      if (previous !== 'completed' && previous !== 'failed') peer.cache.commands[command.commandId] = {
        status: receipt.status, error: receipt.status === 'failed' ? '远程操作失败，请在执行 Mac 查看详情。' : null
      }
      this.database.setSetting(`${this.key(peer.space.id)}:cache`, peer.cache)
    }
  }

  private async deliverPending(peer: Peer): Promise<void> {
    const key = `${this.key(peer.space.id)}:pending`
    const pending = this.database.getSetting<Record<string, CompanionEncryptedCommandInput>>(key, {})
    for (const command of Object.values(pending)) {
      const status = peer.cache.commands[command.commandId]?.status
      if (status === 'completed' || status === 'failed' || Date.now() - Date.parse(command.createdAt) > 30 * 24 * 60 * 60_000) {
        const remaining = this.database.getSetting<Record<string, CompanionEncryptedCommandInput>>(key, {})
        delete remaining[command.commandId]
        this.database.setSetting(key, remaining)
      } else if (peer.online) {
        await this.postCommand(peer, command)
      }
    }
  }

  async createDraft(input: CreateAgentRunDraftInput): Promise<AgentRunDetail> {
    await this.syncNow()
    const peer = this.peers.get(input.executionHostId ?? '')
    const host = this.listHosts(input.projectId).find((item) => item.id === input.executionHostId)
    if (!peer || !host?.online || !host.workspaceConfigured) throw new Error(host?.unavailableReason ?? '执行 Mac 不可用。')
    const project = this.database.accountProjects(this.owner!).find((item) => item.id === input.projectId)
    const remoteProject = project?.shared ? peer.cache.projects.find((item) => item.shared?.id === project.shared!.id) : undefined
    if (input.projectId && !remoteProject) throw new Error('项目尚未同步到执行 Mac。')
    const runId = randomUUID()
    await this.command(peer, 'agent.create-session', { runId, projectId: remoteProject?.id, title: input.title, provider: input.provider, draftPrompt: input.draftPrompt ?? undefined, goalId: input.goalId ?? undefined, milestoneId: input.milestoneId ?? undefined })
    return this.getDetail(remoteRunId(peer.space.hostId, runId))
  }
  async mutate(id: string, type: CompanionCommandType, payload: Record<string, unknown> = {}, commandId?: string): Promise<AgentRunDetail | null> {
    const { peer, runId } = this.locate(id)
    await this.command(peer, type, { ...payload, runId }, commandId)
    return type === 'agent.archive-session' ? null : this.getDetail(id)
  }
  async send(id: string, prompt: string, attachments: ChatAttachmentInput[] = [], requestId?: string): Promise<AgentRunDetail> {
    const { peer, runId } = this.locate(id)
    const descriptors: CompanionAttachmentDescriptor[] = []
    for (const attachment of attachments) {
      const bytes = Buffer.from(attachment.dataUrl.split(',')[1] ?? '', 'base64')
      if (!bytes.length || bytes.length > companionAttachmentPlaintextMaximumBytes) throw new Error('附件大小超出远程传输限制。')
      const attachmentId = randomUUID()
      const sealed = await sealCompanionAttachment(peer.credentials!.encryptionKey, bytes, companionAttachmentAssociatedData(peer.credentials!.accountID, attachmentId))
      await this.request(peer, `/v1/attachments/${attachmentId}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': createHash('sha256').update(sealed).digest('hex'), 'X-Companion-Encryption': 'A256GCM' }, body: Buffer.from(sealed) })
      descriptors.push({ id: attachmentId, messageId: null, artifactId: null, filename: attachment.name, mimeType: attachment.mimeType, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), width: null, height: null, thumbnailAttachmentId: null, createdAt: new Date().toISOString() })
    }
    await this.command(peer, 'agent.send-message', { runId, prompt, attachments: descriptors, clientMessageId: requestId }, requestId)
    return this.getDetail(id)
  }
  async previewArtifact(id: string, artifactId: string): Promise<AgentRunArtifactPreview> {
    const { peer } = this.locate(id)
    let attachment = peer.cache.attachments.find((item) => item.artifactId === artifactId)
    if (!attachment) {
      await this.command(peer, 'artifact.request-upload', { artifactId })
      attachment = peer.cache.attachments.find((item) => item.artifactId === artifactId)
    }
    const artifact = this.getDetail(id).artifacts.find((item) => item.id === artifactId)
    if (!artifact || !attachment) throw new Error('远程附件尚未上传。')
    const response = await this.request(peer, `/v1/attachments/${encodeURIComponent(attachment.id)}`)
    const bytes = await openCompanionAttachment(peer.credentials!.encryptionKey, new Uint8Array(await response.arrayBuffer()), companionAttachmentAssociatedData(peer.credentials!.accountID, attachment.id))
    if (bytes.length !== attachment.size || createHash('sha256').update(bytes).digest('hex') !== attachment.sha256) throw new Error('远程附件校验失败。')
    const isImage = /^image\/(png|jpeg|webp|gif)$/.test(attachment.mimeType)
    const isPdf = attachment.mimeType === 'application/pdf'
    const isText = attachment.mimeType.startsWith('text/')
    return { artifact, kind: isImage ? 'image' : isPdf ? 'pdf' : isText ? attachment.mimeType.includes('markdown') ? 'markdown' : 'text' : 'unsupported',
      content: isText ? Buffer.from(bytes).toString('utf8') : null, dataUrl: isImage || isPdf ? `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString('base64')}` : null, size: bytes.length }
  }
}
