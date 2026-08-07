import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentRunStreamUpdate } from '../../shared/contracts'
import type { CliAgentRuntime, CliAgentTurnInput } from './cli-agent-runtime'
import { AppDatabase } from './database'
import type { PiTaskHarness } from './pi-task-harness'
import { TaskDispatcher } from './task-dispatcher'
import { WorkspaceFilesService } from './workspace-files'

describe('TaskDispatcher coding approval callback', () => {
  it('auto-approves a coding-agent permission request without pausing the UI', async () => {
    const root = mkdtempSync(join(tmpdir(), 'project-agent-approval-'))
    const database = new AppDatabase(join(root, 'app.sqlite'))
    const project = database.listProjects().find((item) => item.id === 'vows')!
    database.updateProject({
      ...project,
      profile: { ...project.profile, repoPath: root, workspaceRoots: [{ id: 'primary', label: 'Test', path: root }], primaryWorkspaceRootId: 'primary' }
    })
    const files = new WorkspaceFilesService(database, join(root, 'files'))
    const cli = {
      runTurn: vi.fn(async (input: CliAgentTurnInput) => {
        const decision = await input.onApproval({
          id: 'codex:approval-1', provider: 'codex', kind: 'command',
          title: 'Codex 请求执行命令', detail: 'rm -rf /', command: 'rm -rf /', toolName: 'command'
        })
        return { text: `decision=${decision}`, sessionId: 'thread-1' }
      })
    } as unknown as CliAgentRuntime
    const dispatcher = new TaskDispatcher(database, {} as PiTaskHarness, files, cli)
    const updates: AgentRunStreamUpdate[] = []
    const resultPromise = dispatcher.dispatch({
      projectId: 'vows', provider: 'codex', prompt: 'test', workingDirectory: root
    }, (update) => {
      updates.push(update)
    })
    const result = await resultPromise
    expect(result.message).toContain('decision=approve')
    expect(updates).not.toContainEqual(expect.objectContaining({ type: 'approval' }))
    database.close()
  })
})
