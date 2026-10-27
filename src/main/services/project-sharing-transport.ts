import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { AccountProjectShare } from '../../shared/account'
import type { AgentRunArtifact } from '../../shared/contracts'
import type { ChatAttachmentInput } from '../../shared/chat-attachments'
import { maximumChatAttachments, maximumChatAttachmentBytes } from '../../shared/chat-attachments'
import { openCompanionAttachment, sealCompanionAttachment } from '../../shared/companion-crypto'
import { sharedAttachmentAssociatedData, sharedAttachmentSchema,
  type SharedAttachmentView } from '../../shared/project-sharing-attachments'
import {
  openSharedProjectBaselineChunk, openSharedProjectEvent,
  sealSharedProjectBaselineChunk, sealSharedProjectEvent,
  type SharedProjectBaseline, type SharedProjectBaselineData, type SharedProjectEncryptedEvent
} from '../../shared/project-sharing-events'
import {
  sharedChatView, sharedMessageView, sharedProjectView,
  type SharedChatView, type SharedMessageView, type SharedProjectView
} from '../../shared/project-sharing'
import type { AppDatabase } from './database'
import type { AccountService } from './account-service'
import type { ProjectSharingKeyStore } from './project-sharing-key-store'
import type { WorkspaceFilesService } from './workspace-files'

const baselineChunkBytes = 24_000
const maximumBaselineChunks = 2_000
const scanSettingPrefix = 'project-sharing.publisher-scan:'

const authorSchema = z.object({ displayName: z.string(), avatarRef: z.string().nullable() }).strict()
const projectSchema = z.object({
  id: z.string(), revision: z.number().int().nonnegative().optional(),
  name: z.string(), icon: z.string().nullable(), summary: z.string(),
  status: z.enum(['active', 'watching', 'paused']), productType: z.string(), stage: z.string()
}).strict()
const chatSchema = z.object({
  id: z.string(), projectId: z.string(), title: z.string(),
  status: z.enum(['draft', 'queued', 'running', 'idle', 'completed', 'failed', 'cancelled']),
  provider: z.enum(['pi', 'codex', 'claude', 'opencode']),
  executionHostId: z.string().optional(), createdByUserId: z.string().nullable(),
  createdBySnapshot: authorSchema.nullable(), createdAt: z.string(), updatedAt: z.string(),
  archivedAt: z.string().nullable().optional()
}).strict()
const messageSchema = z.object({
  id: z.string(), runId: z.string(), role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(), authorUserId: z.string().nullable(),
  authorSnapshot: authorSchema.nullable(), createdAt: z.string(),
  attachments: z.array(sharedAttachmentSchema).optional()
}).strict()
const baselineSchema = z.object({
  version: z.literal(1), project: projectSchema,
  chats: z.array(chatSchema), messages: z.array(messageSchema),
  artifacts: z.array(sharedAttachmentSchema).optional()
}).strict()

function combineChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const combined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return combined
}

/** The owner publishes allowlisted views; native sessions and paths never cross this boundary. */
export class ProjectSharingTransport {
  constructor(
    private readonly database: AppDatabase,
    private readonly account: AccountService,
    private readonly keys: ProjectSharingKeyStore,
    private readonly workspaceFiles?: WorkspaceFilesService
  ) {}

  async uploadInputs(projectId: string, runId: string, requestId: string,
    inputs: ChatAttachmentInput[]): Promise<SharedAttachmentView[]> {
    if (inputs.length > maximumChatAttachments) throw new Error('一次最多发送 4 个附件。')
    const share = await this.account.getProjectShare(projectId)
    const key = await this.keys.getReadable(share)
    const descriptors: SharedAttachmentView[] = []
    for (const input of inputs) {
      const prefix = `data:${input.mimeType};base64,`
      const encoded = input.dataUrl.slice(prefix.length)
      const bytes = Buffer.from(encoded, 'base64')
      if (!input.dataUrl.startsWith(prefix) || bytes.toString('base64') !== encoded
        || bytes.length === 0 || bytes.length > maximumChatAttachmentBytes
        || !/^[A-Za-z0-9_-]{8,128}$/u.test(input.id)) {
        throw new Error('附件数据无效或超过 20 MiB。')
      }
      const attachmentId = createHash('sha256')
        .update(`${runId}\0${requestId}\0${input.id}\0`).update(bytes).digest('hex')
      const filename = basename(input.name.replaceAll('\\', '/'))
        .replace(/[\x00-\x1f:]/gu, '_') || 'attachment'
      const descriptor = sharedAttachmentSchema.parse({
        id: attachmentId, filename, mimeType: input.mimeType,
        size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
        createdAt: new Date().toISOString(), kind: 'input', runId,
        messageId: requestId, artifactId: attachmentId, inputId: input.id
      })
      const ciphertext = await sealCompanionAttachment(key, bytes,
        sharedAttachmentAssociatedData(projectId, attachmentId, share.keyEpoch))
      await this.account.uploadProjectAttachment({ projectId, attachmentId, runId,
        requestId, kind: 'input', keyEpoch: share.keyEpoch, ciphertext })
      descriptors.push(descriptor)
    }
    return descriptors
  }

  async downloadInput(share: AccountProjectShare, descriptor: SharedAttachmentView,
    runId: string, requestId: string, actorUserId: string): Promise<ChatAttachmentInput> {
    const parsed = sharedAttachmentSchema.parse(descriptor)
    if (parsed.kind !== 'input' || parsed.runId !== runId || parsed.messageId !== requestId
      || !parsed.inputId || parsed.artifactId !== parsed.id) {
      throw new Error('附件不属于这条消息。')
    }
    const upload = await this.account.downloadProjectAttachment(share.projectId, parsed.id)
    if (upload.runId !== runId || upload.requestId !== requestId || upload.kind !== 'input'
      || upload.keyEpoch !== share.keyEpoch || upload.uploadedByUserId !== actorUserId) {
      throw new Error('附件上传者或请求范围不匹配。')
    }
    const key = await this.keys.getReadable(share)
    const bytes = Buffer.from(await openCompanionAttachment(key, upload.ciphertext,
      sharedAttachmentAssociatedData(share.projectId, parsed.id, share.keyEpoch)))
    if (bytes.length !== parsed.size
      || createHash('sha256').update(bytes).digest('hex') !== parsed.sha256
      || createHash('sha256').update(`${runId}\0${requestId}\0${parsed.inputId}\0`)
        .update(bytes).digest('hex') !== parsed.id) {
      throw new Error('附件内容校验失败。')
    }
    return { id: parsed.inputId, name: parsed.filename,
      mimeType: parsed.mimeType, dataUrl: `data:${parsed.mimeType};base64,${bytes.toString('base64')}` }
  }

  async downloadForDisplay(projectId: string, descriptor: SharedAttachmentView): Promise<{
    filename: string; mimeType: string; dataUrl: string
  }> {
    const parsed = sharedAttachmentSchema.parse(descriptor)
    const share = await this.account.getProjectShare(projectId)
    const key = await this.keys.getReadable(share)
    const download = await this.account.downloadProjectAttachment(projectId, parsed.id)
    if (download.runId !== parsed.runId || download.keyEpoch !== share.keyEpoch
      || download.kind !== parsed.kind) throw new Error('附件不属于这个 Chat。')
    const bytes = Buffer.from(await openCompanionAttachment(key, download.ciphertext,
      sharedAttachmentAssociatedData(projectId, parsed.id, share.keyEpoch)))
    if (bytes.length !== parsed.size
      || createHash('sha256').update(bytes).digest('hex') !== parsed.sha256) {
      throw new Error('共享附件内容校验失败。')
    }
    return { filename: parsed.filename, mimeType: parsed.mimeType,
      dataUrl: `data:${parsed.mimeType};base64,${bytes.toString('base64')}` }
  }

  private async publishArtifact(share: AccountProjectShare,
    artifact: AgentRunArtifact): Promise<SharedAttachmentView> {
    if (!this.workspaceFiles || !artifact.projectId) {
      throw new Error(`共享附件原文件不可用：${artifact.label}`)
    }
    let path: string
    try { path = this.workspaceFiles.resolvePath(artifact.projectId, artifact.relativePath) }
    catch {
      const run = this.database.getAgentRun(artifact.runId)
      if (!run.workingDirectory) throw new Error(`共享附件路径不可用：${artifact.label}`)
      const root = await realpath(run.workingDirectory)
      path = await realpath(resolve(root, artifact.relativePath))
      const relation = relative(root, path)
      if (isAbsolute(relation) || relation === '..' || relation.startsWith(`..${sep}`)) {
        throw new Error(`共享附件路径不在 Chat 工作目录内：${artifact.label}`)
      }
    }
    const information = await stat(path).catch(() => null)
    if (!information?.isFile() || information.size <= 0
      || information.size > maximumChatAttachmentBytes) {
      throw new Error(`共享附件原文件不存在或超过 20 MiB：${artifact.label}`)
    }
    const bytes = await readFile(path)
    const key = await this.keys.getReadable(share)
    const existing = await this.account.downloadProjectAttachment(share.projectId, artifact.id)
      .catch(() => null)
    if (existing) {
      const previous = await openCompanionAttachment(key, existing.ciphertext,
        sharedAttachmentAssociatedData(share.projectId, artifact.id, share.keyEpoch))
      if (previous.byteLength !== bytes.byteLength
        || createHash('sha256').update(previous).digest('hex') !== createHash('sha256').update(bytes).digest('hex')) {
        throw new Error('共享附件 ID 对应了不同内容。')
      }
    } else {
      const ciphertext = await sealCompanionAttachment(key, bytes,
        sharedAttachmentAssociatedData(share.projectId, artifact.id, share.keyEpoch))
      await this.account.uploadProjectAttachment({ projectId: share.projectId,
        attachmentId: artifact.id, runId: artifact.runId, requestId: null,
        kind: 'artifact', keyEpoch: share.keyEpoch, ciphertext })
    }
    return sharedAttachmentSchema.parse({
      id: artifact.id, filename: artifact.label, mimeType: artifact.mimeType ?? 'application/octet-stream',
      size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      createdAt: artifact.createdAt, kind: existing?.kind === 'input' ? 'input' : 'artifact',
      runId: artifact.runId, messageId: existing?.requestId ?? null, artifactId: artifact.id,
      inputId: null
    })
  }

  private localProject(share: AccountProjectShare) {
    if (share.role !== 'owner' || !share.localProjectId) throw new Error('需要项目所有者权限。')
    const project = this.database.listProjects().find((item) => item.shared?.id === share.localProjectId)
    if (!project) throw new Error('本机尚未同步这个项目。')
    return project
  }

  private sourceDeviceId(): string {
    const state = this.account.getState()
    if (!state.device?.id || state.device.platform !== 'macos') throw new Error('需要已登录的 Mac 设备。')
    return state.device.id
  }

  private async snapshot(share: AccountProjectShare): Promise<SharedProjectBaselineData> {
    const project = this.localProject(share)
    const hostId = this.account.getState().device?.hostId
    const runs = this.database.listRunsIncludingArchived().filter((run) =>
      run.projectId === project.id && run.visibility !== 'draft')
    const artifacts: SharedAttachmentView[] = []
    for (const run of runs) {
      await this.account.registerSharedChat(share.projectId, run.id, run.createdByUserId ?? null)
      for (const artifact of this.database.listAgentRunArtifacts(run.id)) {
        const view = await this.publishArtifact(share, artifact)
        artifacts.push(view)
      }
    }
    const artifactViews = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
    return {
      version: 1,
      project: sharedProjectView(project, share.projectId),
      chats: runs.map((run) => sharedChatView(run, share.projectId, hostId ?? undefined)),
      messages: runs.flatMap((run) => this.database.listAgentRunMessages(run.id)
        .map((message) => {
          const view = sharedMessageView(message)
          if (!view) return null
          const attached = (message.attachments ?? [])
            .map((attachment) => attachment.artifactId
              ? artifactViews.get(attachment.artifactId) : undefined)
            .filter((item): item is SharedAttachmentView => Boolean(item))
          return attached.length ? { ...view, attachments: attached } : view
        }).filter((message): message is SharedMessageView => message !== null)),
      artifacts
    }
  }

  async publishBaseline(projectId: string): Promise<SharedProjectBaseline> {
    const share = await this.account.getProjectShare(projectId)
    this.localProject(share)
    const sourceDeviceId = this.sourceDeviceId()
    const projectKey = await this.keys.getReadable(share)
    await this.account.registerProjectPublisher(projectId)
    // This time precedes the local scan. Changes made during network upload
    // are subsequently sent as incrementals, even if the baseline omitted them.
    const scanStartedAt = new Date().toISOString()
    const snapshot = await this.snapshot(share)
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot))
    const chunkCount = Math.max(1, Math.ceil(bytes.byteLength / baselineChunkBytes))
    if (chunkCount > maximumBaselineChunks) throw new Error('共享历史过大，无法建立恢复快照。')
    const baselineId = randomUUID()
    const baseline = await this.account.beginProjectBaseline(projectId, baselineId, share.keyEpoch, chunkCount)
    if (baseline.sourceDeviceId !== sourceDeviceId || baseline.keyEpoch !== share.keyEpoch) {
      throw new Error('共享快照来源或密钥版本不匹配。')
    }
    for (let index = 0; index < chunkCount; index += 1) {
      const payload = bytes.slice(index * baselineChunkBytes, (index + 1) * baselineChunkBytes)
      const chunk = await sealSharedProjectBaselineChunk(projectKey, {
        projectId, baselineId, sourceDeviceId, keyEpoch: share.keyEpoch, index
      }, payload)
      await this.account.putProjectBaselineChunk(projectId, chunk)
    }
    await this.account.commitProjectBaseline(projectId, baselineId)
    await this.publishIncremental(projectId, scanStartedAt)
    return baseline
  }

  async publishIncremental(projectId: string, since?: string): Promise<number> {
    const share = await this.account.getProjectShare(projectId)
    const project = this.localProject(share)
    const projectKey = await this.keys.getReadable(share)
    const sourceDeviceId = this.sourceDeviceId()
    const cursorKey = `${scanSettingPrefix}${this.account.getState().user?.id}:${projectId}:${sourceDeviceId}`
    const revisionKey = `${cursorKey}:project-revision`
    const cursor = since ?? this.database.getSetting<string | null>(cursorKey, null)
    if (!cursor) return 0
    const scanFinishedAt = new Date().toISOString()
    const publish = async (kind: SharedProjectEncryptedEvent['kind'],
      payload: SharedProjectView | SharedChatView | SharedMessageView | SharedAttachmentView): Promise<void> => {
      const eventId = randomUUID()
      const event = await sealSharedProjectEvent(projectKey,
        { projectId, eventId, keyEpoch: share.keyEpoch, kind }, payload)
      await this.account.publishProjectEvent(projectId, event)
    }
    let published = 0
    const previousRevision = this.database.getSetting<number | null>(revisionKey, null)
    if (previousRevision !== project.shared?.revision) {
      await publish('settings', sharedProjectView(project, projectId))
      published += 1
    }
    for (const run of this.database.listRunsIncludingArchived().filter((item) =>
      item.projectId === project.id && item.visibility !== 'draft')) {
      if (run.updatedAt >= cursor) {
        await this.account.registerSharedChat(projectId, run.id, run.createdByUserId ?? null)
        await publish('chat', sharedChatView(run, projectId,
          this.account.getState().device?.hostId ?? undefined))
        published += 1
      }
      const artifactViews = new Map<string, SharedAttachmentView>()
      const localArtifacts = this.database.listAgentRunArtifacts(run.id)
      for (const artifact of localArtifacts.filter((item) => item.createdAt >= cursor)) {
        const view = await this.publishArtifact(share, artifact)
        artifactViews.set(view.id, view)
        await publish('artifact', view)
        published += 1
      }
      for (const message of this.database.listAgentRunMessages(run.id)) {
        if (message.createdAt < cursor) continue
        const view = sharedMessageView(message)
        if (!view) continue
        const attached: SharedAttachmentView[] = []
        for (const attachment of message.attachments ?? []) {
          let artifactView = attachment.artifactId
            ? artifactViews.get(attachment.artifactId) : undefined
          if (!artifactView) {
            const artifact = localArtifacts.find((item) => item.id === attachment.artifactId)
            if (artifact) artifactView = await this.publishArtifact(share, artifact)
          }
          if (artifactView) attached.push(artifactView)
        }
        await publish('message', attached.length ? { ...view, attachments: attached } : view)
        published += 1
      }
    }
    this.database.setSetting(cursorKey, scanFinishedAt)
    this.database.setSetting(revisionKey, project.shared?.revision ?? null)
    return published
  }

  async readProject(projectId: string): Promise<SharedProjectBaselineData> {
    const share = await this.account.getProjectShare(projectId)
    const key = await this.keys.getReadable(share)
    const [baselines, publishers] = await Promise.all([
      this.account.listProjectBaselines(projectId), this.account.listProjectPublishers(projectId)
    ])
    if (baselines.length === 0) throw new Error('共享历史尚未从执行 Mac 同步。')
    const assembled: SharedProjectBaselineData = {
      version: 1, project: { id: projectId, name: '', icon: null, summary: '',
        status: 'active', productType: '', stage: '' }, chats: [], messages: [], artifacts: []
    }
    const chats = new Map<string, SharedChatView>()
    const messages = new Map<string, SharedMessageView>()
    const artifacts = new Map<string, SharedAttachmentView>()
    const watermarks = new Map<string, number>()
    for (const baseline of baselines) {
      if (baseline.keyEpoch !== share.keyEpoch || baseline.projectId !== projectId) continue
      const parts: Uint8Array[] = []
      let afterIndex = -1
      while (parts.length < baseline.chunkCount) {
        const page = await this.account.listProjectBaselineChunks(projectId, baseline.baselineId, afterIndex)
        if (page.chunks.length === 0) throw new Error('共享历史快照缺少分片。')
        for (const chunk of page.chunks) {
          if (parts.length >= baseline.chunkCount || chunk.index !== parts.length) {
            throw new Error('共享历史快照分片顺序错误。')
          }
          parts.push(await openSharedProjectBaselineChunk(key, baseline, chunk))
        }
        afterIndex = page.nextIndex
      }
      const decoded = baselineSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true })
        .decode(combineChunks(parts)))) as SharedProjectBaselineData
      if (decoded.project.id !== projectId) throw new Error('共享历史项目身份不匹配。')
      if (decoded.project.name && (decoded.project.revision ?? 0) >= (assembled.project.revision ?? 0)) {
        assembled.project = decoded.project
      }
      for (const chat of decoded.chats) chats.set(chat.id, chat)
      for (const message of decoded.messages) messages.set(message.id, message)
      for (const artifact of decoded.artifacts ?? []) artifacts.set(artifact.id, artifact)
      watermarks.set(baseline.sourceDeviceId, baseline.watermark)
    }
    let after = 0
    for (;;) {
      const page = await this.account.listProjectEvents(projectId, after)
      for (const event of page.events) {
        if (event.keyEpoch !== share.keyEpoch || event.sequence <= (watermarks.get(event.sourceDeviceId) ?? 0)) continue
        const decoded = await openSharedProjectEvent(key, event)
        if (event.kind === 'settings') {
          const project = projectSchema.parse(decoded)
          if (project.id !== projectId) throw new Error('共享项目身份不匹配。')
          if ((project.revision ?? 0) >= (assembled.project.revision ?? 0)) assembled.project = project
        }
        else if (event.kind === 'chat') {
          const chat = chatSchema.parse(decoded)
          if (chat.projectId === projectId) chats.set(chat.id, chat)
        } else if (event.kind === 'message') {
          const message = messageSchema.parse(decoded)
          messages.set(message.id, message)
        } else if (event.kind === 'artifact') {
          const artifact = sharedAttachmentSchema.parse(decoded)
          artifacts.set(artifact.id, artifact)
        }
      }
      if (page.events.length < 100) break
      if (page.nextCursor <= after) throw new Error('共享事件游标没有前进。')
      after = page.nextCursor
    }
    assembled.chats = [...chats.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    assembled.messages = [...messages.values()].filter((message) => chats.has(message.runId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    assembled.artifacts = [...artifacts.values()].filter((artifact) => chats.has(artifact.runId))
    assembled.pendingSources = publishers
      .filter((publisher) => !watermarks.has(publisher.sourceDeviceId))
      .map((publisher) => publisher.hostName)
    return assembled
  }
}
