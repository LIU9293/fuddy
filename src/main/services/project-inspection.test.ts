import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './database'
import { createTestDatabase } from '../test-support/project-fixtures'
import { ProjectInspectionService } from './project-inspection'
import { WorkspaceFilesService } from './workspace-files'

describe('ProjectInspectionService', () => {
  const directories: string[] = []

  afterEach(() => {
    directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
  })

  it('searches configured workspace roots and the managed project file space without scanning outside them', () => {
    const root = mkdtempSync(join(tmpdir(), 'project-inspection-'))
    directories.push(root)
    const repository = join(root, 'repo')
    mkdirSync(join(repository, 'assets'), { recursive: true })
    writeFileSync(join(repository, 'README.md'), '# Vows\n微信小程序婚礼产品。')
    writeFileSync(join(repository, 'assets', 'vows-logo.svg'), '<svg aria-label="Vows logo" />')
    const database = createTestDatabase(join(root, 'app.sqlite'))
    const vows = database.listProjects().find((project) => project.id === 'vows')!
    database.updateProject({
      ...vows,
      profile: {
        ...vows.profile,
        repoPath: repository,
        workspaceRoots: [{ id: 'primary', label: 'Vows App', path: repository }],
        primaryWorkspaceRootId: 'primary'
      }
    })
    const files = new WorkspaceFilesService(database, join(root, 'project-files'))
    files.write('vows', 'marketing/social-account-setup.md', '# 小红书与抖音账号资料')

    const result = new ProjectInspectionService(database, files).inspect('vows', '找一下 logo 和宣传素材')

    expect(result.project.profile.repoPath).toBe(repository)
    expect(result.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ space: 'workspace', relativePath: 'assets/vows-logo.svg' })
    ]))
    expect(result.projectFiles.map((entry) => entry.relativePath)).toContain('marketing/social-account-setup.md')
    database.close()
  })
})
