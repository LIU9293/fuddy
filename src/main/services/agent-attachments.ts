import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AgentRun, AgentRunArtifact } from '../../shared/contracts'
import type { CompanionAttachmentDescriptor } from '../../shared/companion-sync'
import { maximumChatAttachmentBytes, maximumChatAttachments, type ChatAttachmentInput, type RuntimeAttachment } from '../../shared/chat-attachments'
import type { AppDatabase } from './database'
import type { WorkspaceFilesService } from './workspace-files'

export function attachmentStorageId(artifactId: string, sha256: string): string {
  return createHash('sha256').update(`${artifactId}\0${sha256.toLowerCase()}`).digest('hex')
}

export function incomingAttachmentDirectory(root: string, commandId: string): string {
  return join(root, createHash('sha256').update(commandId).digest('hex'))
}

export function describeArtifact(artifact: AgentRunArtifact, files: WorkspaceFilesService, messageId: string | null): CompanionAttachmentDescriptor {
  const path = files.resolvePath(artifact.projectId, artifact.relativePath)
  const size = statSync(path).size
  if (size <= 0 || size > maximumChatAttachmentBytes) throw new Error('附件为空或超过 20 MiB。')
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
  return { id: attachmentStorageId(artifact.id, sha256), messageId, artifactId: artifact.id,
    filename: artifact.label, mimeType: artifact.mimeType ?? 'application/octet-stream', size, sha256,
    width: null, height: null, thumbnailAttachmentId: null, createdAt: artifact.createdAt }
}

export function persistInputAttachments(database: AppDatabase, files: WorkspaceFilesService, run: AgentRun, messageId: string, inputs: ChatAttachmentInput[]): {
  descriptors: CompanionAttachmentDescriptor[]; runtime: RuntimeAttachment[]
} {
  if (inputs.length > maximumChatAttachments) throw new Error('每条消息最多发送 4 个附件。')
  // Validate the whole batch before writing any files.
  const decoded = inputs.map(input => {
    const prefix = `data:${input.mimeType};base64,`
    const encoded = input.dataUrl.slice(prefix.length)
    const bytes = Buffer.from(encoded, 'base64')
    if (!input.dataUrl.startsWith(prefix) || bytes.toString('base64') !== encoded
      || !bytes.length || bytes.length > maximumChatAttachmentBytes) throw new Error('附件数据无效或超过 20 MiB。')
    return { input, bytes }
  })
  const descriptors: CompanionAttachmentDescriptor[] = []
  const runtime: RuntimeAttachment[] = []
  for (const { input, bytes } of decoded) {
    const id = createHash('sha256').update(`${run.id}\0${messageId}\0${input.id}\0`).update(bytes).digest('hex')
    const name = basename(input.name.replaceAll('\\', '/')).replace(/[\x00-\x1f:]/g, '_') || 'attachment'
    const relativePath = `_attachments/agent-runs/${id}/${name}`
    files.writeDataUrl(run.projectId, relativePath, input.dataUrl)
    const artifact = database.upsertAgentRunArtifact({ id, runId: run.id, projectId: run.projectId, relativePath,
      label: name, mimeType: input.mimeType, createdAt: new Date().toISOString() })
    descriptors.push(describeArtifact(artifact, files, messageId))
    runtime.push({ path: files.resolvePath(run.projectId, relativePath), name, mimeType: input.mimeType })
  }
  return { descriptors, runtime }
}

function inside(path: string, root: string): boolean {
  try {
    const relation = relative(realpathSync(root), realpathSync(path))
    return !isAbsolute(relation) && !relation.split(sep).some(segment => segment.startsWith('.'))
  } catch { return false }
}

export function snapshotOutput(database: AppDatabase, files: WorkspaceFilesService, run: AgentRun, path: string, name: string, mimeType: string | null): AgentRunArtifact {
  const size = statSync(path).size
  if (!statSync(path).isFile() || size <= 0 || size > maximumChatAttachmentBytes) throw new Error('产物为空或超过 20 MiB。')
  const bytes = readFileSync(path)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const scope = createHash('sha256').update(run.id).digest('hex').slice(0, 16)
  const relativePath = `_artifacts/${scope}/${digest}/${basename(name)}`
  const entry = files.writeDataUrl(run.projectId, relativePath, `data:application/octet-stream;base64,${bytes.toString('base64')}`)
  return database.upsertAgentRunArtifact({ id: createHash('sha256').update(`${run.id}\0${relativePath}`).digest('hex'),
    runId: run.id, projectId: run.projectId, relativePath, label: basename(name), mimeType: mimeType ?? entry.mimeType, createdAt: new Date().toISOString() })
}

/** Register explicit local output links, copying Workspace outputs into the managed file space. */
export function registerLinkedArtifacts(database: AppDatabase, files: WorkspaceFilesService, run: AgentRun, text: string, roots: string[]): string {
  const filesRoot = files.getRoot(run.projectId)
  return text.replace(/(!?\[[^\]\n]*\]\()(<[^>]+>|[^)\n]+)(\))/g, (whole, start: string, raw: string, end: string) => {
    const target = raw.startsWith('<') ? raw.slice(1, -1) : raw.replace(/\s+"[^"]*"$/, '')
    if (/^(https?:|mailto:|data:|#)/i.test(target)) return whole
    let path: string
    try { path = decodeURIComponent(target.replace(/^file:\/\//, '').replace(/^sandbox:/, '')) } catch { return whole }
    const candidates = isAbsolute(path) ? [path] : [resolve(filesRoot, path), ...roots.map(root => resolve(root, path))]
    for (const candidate of candidates) {
      try {
        if (![filesRoot, ...roots].some(root => inside(candidate, root))) continue
        const filename = basename(candidate)
        if (filename.startsWith('.') || /\.(pem|key)$/i.test(filename)) continue
        const size = statSync(candidate).size
        if (!statSync(candidate).isFile() || size <= 0 || size > maximumChatAttachmentBytes) continue
        const artifact = snapshotOutput(database, files, run, candidate, filename, null)
        return `${start}${encodeURI(artifact.relativePath).replaceAll('(', '%28').replaceAll(')', '%29')}${end}`
      } catch { /* A missing, out-of-scope or unreadable link stays plain text. */ }
    }
    return whole
  })
}
