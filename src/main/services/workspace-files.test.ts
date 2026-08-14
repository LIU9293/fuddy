import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './database'
import { createTestDatabase } from '../test-support/project-fixtures'
import { WorkspaceFilesService } from './workspace-files'

const temporaryDirectories: string[] = []

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
})

function createWorkspace(): { database: AppDatabase; files: WorkspaceFilesService } {
  const directory = mkdtempSync(join(tmpdir(), 'project-agent-files-'))
  temporaryDirectories.push(directory)
  const database = createTestDatabase(join(directory, 'test.sqlite'))
  const files = new WorkspaceFilesService(database, join(directory, 'files'))
  return { database, files }
}

describe('WorkspaceFilesService', () => {
  it('keeps project artifacts isolated and readable', () => {
    const { database, files } = createWorkspace()

    files.createFolder('vows', 'marketing')
    const written = files.write('vows', 'marketing/launch.md', '# Launch plan')

    expect(written.mimeType).toBe('text/markdown')
    expect(files.read('vows', 'marketing/launch.md')).toMatchObject({
      kind: 'markdown',
      content: '# Launch plan',
      previewUrl: null,
      previewMessage: null
    })
    expect(files.list('vows').map((entry) => entry.relativePath)).toEqual([
      'marketing',
      'marketing/launch.md'
    ])
    expect(files.list('roombase')).toEqual([])

    database.close()
  })

  it('returns inline file-page previews for images and PDFs', () => {
    const { database, files } = createWorkspace()

    files.writeDataUrl('vows', 'cover.png', 'data:image/png;base64,aW1hZ2U=')
    files.writeDataUrl('vows', 'launch.pdf', 'data:application/pdf;base64,cGRm')

    expect(files.read('vows', 'cover.png')).toMatchObject({
      kind: 'image',
      content: null,
      previewUrl: 'data:image/png;base64,aW1hZ2U=',
      previewMessage: null
    })
    expect(files.read('vows', 'launch.pdf')).toMatchObject({
      kind: 'pdf',
      content: null,
      previewUrl: 'fuddy-file://workspace/vows/launch.pdf',
      previewMessage: null
    })

    database.close()
  })

  it('returns renderable previews for Markdown and images', () => {
    const { database, files } = createWorkspace()

    files.write('vows', 'launch.md', '# Launch plan')
    files.writeDataUrl('vows', 'cover.png', 'data:image/png;base64,aW1hZ2U=')

    const markdown = files.previewArtifact({
      id: 'artifact-markdown',
      runId: 'run-1',
      projectId: 'vows',
      relativePath: 'launch.md',
      label: 'launch.md',
      mimeType: 'text/markdown',
      createdAt: '2026-08-10T00:00:00.000Z'
    })
    const image = files.previewArtifact({
      id: 'artifact-image',
      runId: 'run-1',
      projectId: 'vows',
      relativePath: 'cover.png',
      label: 'cover.png',
      mimeType: 'image/png',
      createdAt: '2026-08-10T00:00:00.000Z'
    })

    expect(markdown).toMatchObject({ kind: 'markdown', content: '# Launch plan', dataUrl: null })
    expect(image).toMatchObject({ kind: 'image', content: null, dataUrl: 'data:image/png;base64,aW1hZ2U=' })

    database.close()
  })

  it('rejects paths outside the project file space', () => {
    const { database, files } = createWorkspace()

    expect(() => files.write('vows', '../outside.md', 'unsafe')).toThrow(
      '路径必须位于项目文件空间内。'
    )

    database.close()
  })
})
