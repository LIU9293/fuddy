import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, extname, relative, resolve, sep } from 'node:path'
import type { AgentRunArtifact, AgentRunArtifactPreview, Project, WorkspaceFileContent, WorkspaceFileEntry } from '../../shared/contracts'
import { workspaceFilePreviewUrl } from '../../shared/workspace-file-preview'
import { AppDatabase } from './database'

const editableExtensions = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.html', '.css', '.xml', '.yaml', '.yml'
])

const maximumTextPreviewSize = 2 * 1024 * 1024
const maximumImagePreviewSize = 12 * 1024 * 1024
const maximumPdfPreviewSize = 20 * 1024 * 1024

const mimeTypes: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.html': 'text/html',
  '.css': 'text/css',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime'
}

function normalizeRelativePath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/')
}

export class WorkspaceFilesService {
  constructor(
    private readonly database: AppDatabase,
    private readonly root: string
  ) {
    mkdirSync(this.root, { recursive: true })
    this.database.listProjects().forEach((project) => this.ensureRoot(project.id))
    this.ensureRoot(null)
  }

  getRoot(projectId: string | null): string {
    this.assertProject(projectId)
    return this.ensureRoot(projectId)
  }

  list(projectId: string | null): WorkspaceFileEntry[] {
    const root = this.getRoot(projectId)
    const entries: WorkspaceFileEntry[] = []
    const visit = (directory: string): void => {
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        if (item.name === '.DS_Store') continue
        const absolutePath = resolve(directory, item.name)
        const relativePath = relative(root, absolutePath).split(sep).join('/')
        const entry = this.toEntry(projectId, root, relativePath)
        entries.push(entry)
        if (item.isDirectory() && entries.length < 2_000) visit(absolutePath)
        if (entries.length >= 2_000) return
      }
    }
    visit(root)
    return entries.sort((left, right) => {
      const leftDepth = left.relativePath.split('/').length
      const rightDepth = right.relativePath.split('/').length
      if (leftDepth !== rightDepth) return leftDepth - rightDepth
      if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
      return left.relativePath.localeCompare(right.relativePath, 'zh-CN')
    })
  }

  read(projectId: string | null, relativePath: string): WorkspaceFileContent {
    const root = this.getRoot(projectId)
    const normalized = normalizeRelativePath(relativePath)
    const absolutePath = this.resolveInside(root, normalized)
    const entry = this.toEntry(projectId, root, normalized)
    if (entry.kind !== 'file') throw new Error('请选择一个文件。')
    const extension = extname(absolutePath).toLowerCase()

    if (entry.editable) {
      if (entry.size > maximumTextPreviewSize) {
        return {
          entry,
          kind: 'unsupported',
          content: null,
          previewUrl: null,
          previewMessage: '文本文件超过 2 MB，请在 Finder 中打开。'
        }
      }
      return {
        entry,
        kind: extension === '.md' || extension === '.markdown' ? 'markdown' : 'text',
        content: readFileSync(absolutePath, 'utf8'),
        previewUrl: null,
        previewMessage: null
      }
    }

    if (entry.mimeType?.startsWith('image/')) {
      if (entry.size > maximumImagePreviewSize) {
        return {
          entry,
          kind: 'unsupported',
          content: null,
          previewUrl: null,
          previewMessage: '图片超过 12 MB，请在 Finder 中打开。'
        }
      }
      return {
        entry,
        kind: 'image',
        content: null,
        previewUrl: `data:${entry.mimeType};base64,${readFileSync(absolutePath).toString('base64')}`,
        previewMessage: null
      }
    }

    if (entry.mimeType === 'application/pdf') {
      if (entry.size > maximumPdfPreviewSize) {
        return {
          entry,
          kind: 'unsupported',
          content: null,
          previewUrl: null,
          previewMessage: 'PDF 超过 20 MB，请在 Finder 中打开。'
        }
      }
      return {
        entry,
        kind: 'pdf',
        content: null,
        previewUrl: workspaceFilePreviewUrl(projectId, normalized),
        previewMessage: null
      }
    }

    return {
      entry,
      kind: 'unsupported',
      content: null,
      previewUrl: null,
      previewMessage: `${entry.mimeType ?? '二进制文件'} · 当前格式请在外部应用中查看。`
    }
  }

  previewArtifact(artifact: AgentRunArtifact): AgentRunArtifactPreview {
    const root = this.getRoot(artifact.projectId)
    const normalized = normalizeRelativePath(artifact.relativePath)
    const absolutePath = this.resolveInside(root, normalized)
    const entry = this.toEntry(artifact.projectId, root, normalized)
    if (entry.kind !== 'file') throw new Error('产物不是文件。')

    if (entry.editable) {
      if (entry.size > maximumTextPreviewSize) throw new Error('文本文件超过 2 MB，请在 Finder 中打开。')
      const extension = extname(absolutePath).toLowerCase()
      return {
        artifact,
        kind: extension === '.md' || extension === '.markdown' ? 'markdown' : 'text',
        content: readFileSync(absolutePath, 'utf8'),
        dataUrl: null,
        size: entry.size
      }
    }

    if (entry.mimeType?.startsWith('image/')) {
      if (entry.size > maximumImagePreviewSize) throw new Error('图片超过 12 MB，请在 Finder 中打开。')
      return {
        artifact,
        kind: 'image',
        content: null,
        dataUrl: `data:${entry.mimeType};base64,${readFileSync(absolutePath).toString('base64')}`,
        size: entry.size
      }
    }

    return { artifact, kind: 'unsupported', content: null, dataUrl: null, size: entry.size }
  }

  write(projectId: string | null, relativePath: string, content: string): WorkspaceFileEntry {
    const root = this.getRoot(projectId)
    const normalized = normalizeRelativePath(relativePath)
    if (!normalized) throw new Error('请输入文件名。')
    const absolutePath = this.resolveInside(root, normalized)
    mkdirSync(dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, content, 'utf8')
    return this.toEntry(projectId, root, normalized)
  }

  writeDataUrl(projectId: string | null, relativePath: string, dataUrl: string): WorkspaceFileEntry {
    const normalized = normalizeRelativePath(relativePath)
    if (!normalized) throw new Error('请输入文件名。')
    const separator = dataUrl.indexOf(',')
    if (separator < 0 || !dataUrl.slice(0, separator).endsWith(';base64')) {
      throw new Error('附件数据格式无效。')
    }
    const absolutePath = this.resolveInside(this.getRoot(projectId), normalized)
    mkdirSync(dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, Buffer.from(dataUrl.slice(separator + 1), 'base64'))
    return this.toEntry(projectId, this.getRoot(projectId), normalized)
  }

  createFolder(projectId: string | null, relativePath: string): WorkspaceFileEntry {
    const root = this.getRoot(projectId)
    const normalized = normalizeRelativePath(relativePath)
    if (!normalized) throw new Error('请输入文件夹名称。')
    const absolutePath = this.resolveInside(root, normalized)
    mkdirSync(absolutePath, { recursive: true })
    return this.toEntry(projectId, root, normalized)
  }

  importFiles(projectId: string | null, sourcePaths: string[], targetDirectory = ''): WorkspaceFileEntry[] {
    const root = this.getRoot(projectId)
    const normalizedDirectory = normalizeRelativePath(targetDirectory)
    const targetRoot = this.resolveInside(root, normalizedDirectory)
    mkdirSync(targetRoot, { recursive: true })

    return sourcePaths.map((sourcePath) => {
      const sourceStats = statSync(sourcePath)
      if (!sourceStats.isFile()) throw new Error(`暂不支持导入文件夹：${basename(sourcePath)}`)
      const targetPath = resolve(targetRoot, basename(sourcePath))
      this.assertInside(root, targetPath)
      copyFileSync(sourcePath, targetPath)
      return this.toEntry(projectId, root, relative(root, targetPath).split(sep).join('/'))
    })
  }

  resolvePath(projectId: string | null, relativePath = ''): string {
    const root = this.getRoot(projectId)
    const normalized = normalizeRelativePath(relativePath)
    const absolutePath = this.resolveInside(root, normalized)
    if (!existsSync(absolutePath)) throw new Error('文件或文件夹不存在。')
    return absolutePath
  }

  relativePath(projectId: string | null, absolutePath: string): string | null {
    const root = this.getRoot(projectId)
    const resolved = resolve(absolutePath)
    try {
      this.assertInside(root, resolved)
      return relative(root, resolved).split(sep).join('/')
    } catch {
      return null
    }
  }

  private toEntry(projectId: string | null, root: string, relativePath: string): WorkspaceFileEntry {
    const absolutePath = this.resolveInside(root, relativePath)
    const stats = statSync(absolutePath)
    const extension = extname(absolutePath).toLowerCase()
    return {
      projectId,
      relativePath,
      name: basename(absolutePath),
      kind: stats.isDirectory() ? 'directory' : 'file',
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      mimeType: stats.isDirectory() ? null : mimeTypes[extension] ?? 'application/octet-stream',
      editable: stats.isFile() && editableExtensions.has(extension)
    }
  }

  private ensureRoot(projectId: string | null): string {
    const path = resolve(this.root, projectId ?? '_shared')
    mkdirSync(path, { recursive: true })
    return path
  }

  private assertProject(projectId: string | null): Project | null {
    if (projectId === null) return null
    const project = this.database.listProjects().find((item) => item.id === projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    return project
  }

  private resolveInside(root: string, relativePath: string): string {
    const target = resolve(root, relativePath || '.')
    this.assertInside(root, target)
    return target
  }

  private assertInside(root: string, target: string): void {
    const relativeTarget = relative(root, target)
    if (relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`) || resolve(target) === resolve(this.root)) {
      throw new Error('路径必须位于项目文件空间内。')
    }
  }
}
