import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './database'

let database: AppDatabase | null = null
let temporaryDirectory = ''

afterEach(() => {
  database?.close()
  database = null
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = ''
})

describe('project settings persistence', () => {
  it('keeps an edited project profile after the database is reopened', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'project-agent-settings-'))
    const path = join(temporaryDirectory, 'app.sqlite')
    database = new AppDatabase(path)
    const roombase = database.listProjects().find((project) => project.id === 'roombase')
    expect(roombase).toBeDefined()

    database.updateProject({
      ...roombase!,
      summary: '更新后的项目介绍',
      profile: {
        ...roombase!.profile,
        defaultAgent: 'opencode',
        mission: '帮助门店建立可持续的增长系统。',
        vision: '成为门店经营者每天依赖的工作平台。',
        currentState: {
          summary: '首轮获客渠道实验正在准备中。',
          facts: ['官网已经上线', '尚未建立渠道转化基线'],
          source: 'user',
          updatedAt: '2026-08-06T03:00:00.000Z'
        },
        focusAreas: ['增长实验', '客服洞察']
      }
    })
    database.close()
    database = new AppDatabase(path)

    const reopened = database.listProjects().find((project) => project.id === 'roombase')
    expect(reopened?.summary).toBe('更新后的项目介绍')
    expect(reopened?.profile.mission).toBe('帮助门店建立可持续的增长系统。')
    expect(reopened?.profile.vision).toBe('成为门店经营者每天依赖的工作平台。')
    expect(reopened?.profile.currentState).toMatchObject({
      summary: '首轮获客渠道实验正在准备中。',
      facts: ['官网已经上线', '尚未建立渠道转化基线'],
      source: 'user'
    })
    expect(reopened?.profile.focusAreas).toEqual(['增长实验', '客服洞察'])
    expect(reopened?.profile.defaultAgent).toBe('opencode')
  })

  it('persists multiple workspace roots and keeps repo compatibility on the primary root', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'project-agent-workspaces-'))
    const path = join(temporaryDirectory, 'app.sqlite')
    database = new AppDatabase(path)
    const roombase = database.listProjects().find((project) => project.id === 'roombase')!

    const updated = database.updateProject({
      ...roombase,
      profile: {
        ...roombase.profile,
        workspaceRoots: [
          { id: 'app', label: 'App', path: '/workspace/app' },
          { id: 'ops', label: 'Operations', path: '/workspace/ops' }
        ],
        primaryWorkspaceRootId: 'ops'
      }
    })

    expect(updated.profile.workspaceRoots).toHaveLength(2)
    expect(updated.profile.primaryWorkspaceRootId).toBe('ops')
    expect(updated.profile.repoPath).toBe('/workspace/ops')
    expect(database.listConnectors().find((connector) => connector.id === 'repo-roombase')?.config.repoPath).toBe('/workspace/ops')
  })
})
