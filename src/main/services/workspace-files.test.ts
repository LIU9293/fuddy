import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './database'
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
  const database = new AppDatabase(join(directory, 'test.sqlite'))
  const files = new WorkspaceFilesService(database, join(directory, 'files'))
  return { database, files }
}

describe('WorkspaceFilesService', () => {
  it('keeps project artifacts isolated and readable', () => {
    const { database, files } = createWorkspace()

    files.createFolder('vows', 'marketing')
    const written = files.write('vows', 'marketing/launch.md', '# Launch plan')

    expect(written.mimeType).toBe('text/markdown')
    expect(files.read('vows', 'marketing/launch.md').content).toBe('# Launch plan')
    expect(files.list('vows').map((entry) => entry.relativePath)).toEqual([
      'marketing',
      'marketing/launch.md'
    ])
    expect(files.list('roombase')).toEqual([])

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
