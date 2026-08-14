import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { protocol } from 'electron'
import { parseWorkspaceFilePreviewUrl, workspaceFilePreviewScheme } from '../../shared/workspace-file-preview'
import type { WorkspaceFilesService } from './workspace-files'

const maximumPdfPreviewSize = 20 * 1024 * 1024

function errorResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  })
}

export function registerWorkspaceFileProtocol(workspaceFiles: WorkspaceFilesService): void {
  protocol.handle(workspaceFilePreviewScheme, (request) => {
    const target = parseWorkspaceFilePreviewUrl(request.url)
    if (!target) return errorResponse(404, '文件预览地址无效。')

    try {
      const path = workspaceFiles.resolvePath(target.projectId, target.relativePath)
      const stats = statSync(path)
      if (!stats.isFile() || extname(path).toLowerCase() !== '.pdf') {
        return errorResponse(415, '当前格式不支持使用 PDF 阅读器预览。')
      }
      if (stats.size > maximumPdfPreviewSize) return errorResponse(413, 'PDF 超过 20 MB。')

      return new Response(readFileSync(path), {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Length': String(stats.size),
          'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(basename(path))}`,
          'Cache-Control': 'no-store'
        }
      })
    } catch {
      return errorResponse(404, '文件不存在或无法读取。')
    }
  })
}
