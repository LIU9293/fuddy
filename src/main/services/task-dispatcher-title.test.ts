import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CliAgentRuntime, CliAgentTurnInput } from './cli-agent-runtime'
import type { PiTaskHarness } from './pi-task-harness'
import { createTestDatabase } from '../test-support/project-fixtures'
import { WorkspaceFilesService } from './workspace-files'
import { TaskDispatcher } from './task-dispatcher'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

function fixture(generateTitle = vi.fn(async (_prompt: string, _signal: AbortSignal): Promise<string | null> => 'Fix login redirects')) {
  const root = mkdtempSync(join(tmpdir(), 'fuddy-chat-title-'))
  const database = createTestDatabase(join(root, 'app.sqlite'))
  const runTurn = vi.fn(async (input: CliAgentTurnInput) => {
    input.onSessionId('native-session')
    return { text: '完成', sessionId: 'native-session' }
  })
  const piRunTurn = vi.fn(async () => '完成')
  const dispatcher = new TaskDispatcher(database, { runTurn: piRunTurn } as unknown as PiTaskHarness,
    new WorkspaceFilesService(database, join(root, 'files')), { runTurn } as unknown as CliAgentRuntime,
    undefined, undefined, undefined, generateTitle)
  const onUpdate = vi.fn()
  dispatcher.onRunUpdate(onUpdate)
  cleanups.push(async () => { await dispatcher.stopAndDrain(); database.close(); rmSync(root, { recursive: true, force: true }) })
  return { database, dispatcher, generateTitle, runTurn, piRunTurn, onUpdate }
}

describe('automatic Chat titles', () => {
  it.each(['codex', 'claude', 'opencode', 'pi'] as const)('uses the shared generator for %s after the first message only', async provider => {
    const { database, dispatcher, generateTitle, runTurn, piRunTurn } = fixture()
    const draft = dispatcher.createDraft({ projectId: null, provider })
    expect(draft.run).toMatchObject({ title: '新建 Chat', status: 'draft', sessionId: null })
    expect(draft.messages).toEqual([])
    expect(runTurn).not.toHaveBeenCalled()
    expect(piRunTurn).not.toHaveBeenCalled()
    expect(generateTitle).not.toHaveBeenCalled()
    await dispatcher.sendMessage(draft.run.id, 'Fix the login redirect loop')
    await vi.waitFor(() => expect(database.getAgentRun(draft.run.id).title).toBe('Fix login redirects'))
    await dispatcher.sendMessage(draft.run.id, 'Also add a regression test')
    expect(generateTitle).toHaveBeenCalledOnce()
    expect(generateTitle).toHaveBeenCalledWith('Fix the login redirect loop', expect.any(AbortSignal))
    expect(database.listPendingCompanionEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'agent-run.updated', payload: expect.objectContaining({ title: 'Fix login redirects' }) })
    ]))
  })

  it('lets the Agent finish while title generation is still pending and preserves a later manual rename', async () => {
    let resolveTitle!: (title: string) => void
    const { database, dispatcher } = fixture(vi.fn(() => new Promise(resolve => { resolveTitle = resolve })))
    const draft = dispatcher.createDraft({ projectId: null, provider: 'codex' })
    const detail = await dispatcher.sendMessage(draft.run.id, 'Fix the login redirect loop')
    expect(detail.run).toMatchObject({ title: 'Fix the login redirect loop', status: 'idle' })
    database.renameAgentRun(draft.run.id, 'My release')
    resolveTitle('Fix login redirects')
    await dispatcher.stopAndDrain()
    expect(database.getAgentRun(draft.run.id).title).toBe('My release')
  })

  it('publishes a late generated title after the reply without waiting for another turn', async () => {
    let resolveTitle!: (title: string) => void
    const { database, dispatcher, onUpdate } = fixture(vi.fn(() => new Promise(resolve => { resolveTitle = resolve })))
    const draft = dispatcher.createDraft({ projectId: null, provider: 'opencode' })
    await dispatcher.sendMessage(draft.run.id, '检查发布配置')
    resolveTitle('发布配置检查')
    await vi.waitFor(() => expect(database.getAgentRun(draft.run.id).title).toBe('发布配置检查'))
    expect(database.getAgentRun(draft.run.id).status).toBe('idle')
    expect(onUpdate).toHaveBeenCalledWith(draft.run.id, {
      type: 'updated', run: expect.objectContaining({ title: '发布配置检查', status: 'idle' })
    })
  })

  it.each(['offline', 'failure', 'malformed'])('keeps the concise first-line fallback when title generation is %s', async scenario => {
    const generateTitle = vi.fn(async () => {
      if (scenario === 'failure') throw new Error('upstream unavailable')
      return scenario === 'malformed' ? 'Explanation\nTitle' : null
    })
    const { database, dispatcher } = fixture(generateTitle)
    const draft = dispatcher.createDraft({ projectId: null, provider: 'claude', title: '新建 Chat' })
    await dispatcher.sendMessage(draft.run.id, '检查  配置\n并运行测试')
    await dispatcher.sendMessage(draft.run.id, '再检查发布')
    expect(database.getAgentRun(draft.run.id).title).toBe('检查 配置')
    expect(generateTitle).toHaveBeenCalledOnce()
  })

  it('skips the model for an explicit title and a draft manually renamed before sending', async () => {
    const { database, dispatcher, generateTitle } = fixture()
    const explicit = dispatcher.createDraft({ projectId: null, provider: 'codex', title: 'Release' })
    const renamed = dispatcher.createDraft({ projectId: null, provider: 'codex' })
    database.renameAgentRun(renamed.run.id, 'My task')
    await dispatcher.sendMessage(explicit.run.id, '检查发布')
    await dispatcher.sendMessage(renamed.run.id, '检查配置')
    expect(generateTitle).not.toHaveBeenCalled()
    expect(database.getAgentRun(explicit.run.id).title).toBe('Release')
    expect(database.getAgentRun(renamed.run.id).title).toBe('My task')
  })

  it('does not apply a result after archive', async () => {
    let resolveTitle!: (title: string) => void
    const { database, dispatcher } = fixture(vi.fn(() => new Promise(resolve => { resolveTitle = resolve })))
    const draft = dispatcher.createDraft({ projectId: null, provider: 'codex' })
    await dispatcher.sendMessage(draft.run.id, '检查发布')
    database.archiveAgentRun(draft.run.id)
    resolveTitle('发布检查')
    await dispatcher.stopAndDrain()
    expect(database.getAgentRun(draft.run.id).title).toBe('检查发布')
  })

  it('aborts pending title requests when shutting down', async () => {
    let signal!: AbortSignal
    const { dispatcher } = fixture(vi.fn((_prompt, inputSignal) => {
      signal = inputSignal
      return new Promise(resolve => inputSignal.addEventListener('abort', () => resolve(null), { once: true }))
    }))
    const draft = dispatcher.createDraft({ projectId: null, provider: 'codex' })
    await dispatcher.sendMessage(draft.run.id, '检查发布')
    await dispatcher.stopAndDrain()
    expect(signal.aborted).toBe(true)
  })
})
