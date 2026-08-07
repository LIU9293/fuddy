import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CliAgentRuntime } from './cli-agent-runtime'
import { AppDatabase } from './database'
import type { PiTaskHarness, PiTaskTurnInput } from './pi-task-harness'
import { TaskDispatcher } from './task-dispatcher'
import { WorkspaceFilesService } from './workspace-files'

describe('TaskDispatcher project workspaces', () => {
  it('binds a general Pi run to the primary workspace and passes every configured root', async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'project-agent-general-workspace-'))
    const primary = join(temporaryDirectory, 'app')
    const operations = join(temporaryDirectory, 'ops')
    const databasePath = join(temporaryDirectory, 'app.sqlite')
    let database = new AppDatabase(databasePath)
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
    database = new AppDatabase(databasePath)
    expect(database.getAgentRun(result.detail.run.id)).toMatchObject({
      provider: 'pi',
      workingDirectory: primary
    })
    database.close()
    rmSync(temporaryDirectory, { recursive: true, force: true })
  })
})
