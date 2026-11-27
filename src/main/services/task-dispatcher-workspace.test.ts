import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CliAgentRuntime } from './cli-agent-runtime'
import { AppDatabase } from './database'
import { createTestDatabase, testProject } from '../test-support/project-fixtures'
import type { PiTaskHarness, PiTaskTurnInput } from './pi-task-harness'
import { TaskDispatcher } from './task-dispatcher'
import { WorkspaceFilesService } from './workspace-files'

describe('TaskDispatcher project workspaces', () => {
  it('sends a text-only Chat and records its output when the file space contains invalid links', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fuddy-chat-workspace-links-'))
    const database = createTestDatabase(join(directory, 'app.sqlite'), [testProject('project', 'Project', directory)])
    try {
      const files = new WorkspaceFilesService(database, join(directory, 'files'))
      const projectRoot = files.getRoot('project')
      const outside = join(directory, 'outside.md')
      writeFileSync(outside, '# Outside the project file space')
      files.write('project', 'existing.md', '# Existing file')
      symlinkSync(outside, join(projectRoot, 'outside.md'))
      symlinkSync('missing.md', join(projectRoot, 'stale-link.md'))
      symlinkSync('existing.md', join(projectRoot, 'internal.md'))

      const runTurn = vi.fn<CliAgentRuntime['runTurn']>(async () => {
        files.write('project', 'report.md', '# New report')
        return { text: 'Report ready', sessionId: 'native-session' }
      })
      const dispatcher = new TaskDispatcher(database, {} as PiTaskHarness, files, { runTurn } as unknown as CliAgentRuntime)
      const { run } = dispatcher.createDraft({ projectId: 'project', provider: 'claude', title: 'Workspace links' })

      const result = await dispatcher.sendMessage(run.id, 'Write a report')

      expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Write a report', attachments: [] }))
      expect(result.run.status).toBe('idle')
      expect(result.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', content: 'Report ready' })
      ]))
      expect(result.artifacts.map(artifact => artifact.label)).toEqual(['report.md'])
      const paths = files.list('project').map(entry => entry.relativePath)
      expect(paths).toEqual(expect.arrayContaining(['existing.md', 'internal.md']))
      expect(paths).not.toContain('outside.md')
      expect(paths).not.toContain('stale-link.md')
      expect(() => files.read('project', 'outside.md')).toThrow('路径必须位于项目文件空间内。')
    } finally {
      database.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('binds a general Pi run to the primary workspace and passes every configured root', async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'project-agent-general-workspace-'))
    const primary = join(temporaryDirectory, 'app')
    const operations = join(temporaryDirectory, 'ops')
    const databasePath = join(temporaryDirectory, 'app.sqlite')
    let database = createTestDatabase(databasePath)
    const project = database.listProjects().find((item) => item.id === 'roombase')!
    database.updateProject({
      ...project,
      profile: {
        ...project.profile,
        workspaceRoots: [
          { id: 'app', label: 'App', path: primary },
          { id: 'ops', label: 'Operations', path: operations }
        ],
        primaryWorkspaceRootId: 'app'
      }
    })
    const files = new WorkspaceFilesService(database, join(temporaryDirectory, 'files'))
    const runTurn = vi.fn(async (input: PiTaskTurnInput) => {
      input.onSessionId(join(temporaryDirectory, 'session.jsonl'))
      return 'workspace ok'
    })
    const dispatcher = new TaskDispatcher(
      database,
      { runTurn } as unknown as PiTaskHarness,
      files,
      {} as CliAgentRuntime
    )

    const result = await dispatcher.dispatch({ projectId: 'roombase', provider: 'pi', prompt: 'inspect project' })

    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({
      workingDirectory: primary,
      workspaceRoots: [primary, operations]
    }))
    expect(result.detail.run.workingDirectory).toBe(primary)
    database.close()
    database = createTestDatabase(databasePath)
    expect(database.getAgentRun(result.detail.run.id)).toMatchObject({
      provider: 'pi',
      workingDirectory: primary
    })
    database.close()
    rmSync(temporaryDirectory, { recursive: true, force: true })
  })
})
