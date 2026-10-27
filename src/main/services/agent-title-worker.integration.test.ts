import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AccountService } from './account-service'
import { TaskDispatcher } from './task-dispatcher'
import { WorkspaceFilesService } from './workspace-files'
import { createTestDatabase } from '../test-support/project-fixtures'
import type { PiTaskHarness } from './pi-task-harness'
import type { CliAgentRuntime } from './cli-agent-runtime'
import { firstMessageTitle } from '../../shared/agent-run-title'

describe.skipIf(process.env.RUN_CLOUDFLARE_TITLE_WORKER_SMOKE !== '1')('local account Worker with real remote AI (opt-in)', () => {
  it.each(['codex', 'claude', 'opencode', 'pi'] as const)('persists and synchronizes the title independently of %s', async provider => {
    const url = new URL(process.env.FUDDY_TITLE_SMOKE_WORKER_URL ?? 'http://127.0.0.1:8799')
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)) {
      throw new Error('Worker smoke tests require an isolated local Account API with test email delivery')
    }
    const root = mkdtempSync(join(tmpdir(), 'fuddy-title-worker-'))
    const database = createTestDatabase(join(root, 'app.sqlite'))
    const values = new Map<string, string>()
    const vault = { get: (key: string) => values.get(key) ?? null,
      set: (key: string, value: string) => { values.set(key, value) },
      delete: (key: string) => { values.delete(key) },
      deleteByPrefix: (prefix: string) => { for (const key of values.keys()) if (key.startsWith(prefix)) values.delete(key) } }
    const account = new AccountService(database, vault, {
      apiUrl: url.origin, runtimeChannel: 'development', appVersion: '0.0.7', deviceName: 'Title smoke test'
    })
    // Provider turns are stubs; authentication, Worker routing, AI binding,
    // title persistence and companion events all run through real services.
    const dispatcher = new TaskDispatcher(database, { runTurn: async () => 'Done' } as unknown as PiTaskHarness,
      new WorkspaceFilesService(database, join(root, 'files')),
      { runTurn: async () => ({ text: 'Done', sessionId: 'test-session' }) } as unknown as CliAgentRuntime,
      undefined, undefined, undefined, (prompt, signal) => account.generateChatTitle(prompt, signal))
    const onUpdate = vi.fn()
    dispatcher.onRunUpdate(onUpdate)
    try {
      const challenge = await account.startEmailSignIn(`title-${randomUUID()}@example.com`)
      if (!challenge.debugCode) throw new Error('Only a local non-production account Worker may run this test')
      expect((await account.verifyEmailSignIn(challenge.challengeId, challenge.debugCode)).status).toBe('signed-in')
      const draft = dispatcher.createDraft({ projectId: null, provider })
      const english = provider === 'codex' || provider === 'pi'
      const prompt = english ? 'Fix the login redirect loop after the session expires.' : '帮我移除创建 Chat 时的标题输入，改为自动生成。'
      expect((await dispatcher.sendMessage(draft.run.id, prompt)).run.status).toBe('idle')
      await vi.waitFor(() => {
        const title = database.getAgentRun(draft.run.id).title
        expect(title).not.toBe(firstMessageTitle(prompt))
        expect(title).not.toBe('新建 Chat')
        expect(title).toMatch(english ? /^[\x20-\x7e]+$/u : /\p{Script=Han}/u)
        expect(onUpdate).toHaveBeenCalledWith(draft.run.id, {
          type: 'updated', run: expect.objectContaining({ title })
        })
        expect(database.listPendingCompanionEvents()).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'agent-run.updated', payload: expect.objectContaining({ title }) })
        ]))
      }, { timeout: 15_000 })
      console.info(JSON.stringify({ provider, title: database.getAgentRun(draft.run.id).title, status: 'persisted-and-synchronized' }))
    } finally {
      await dispatcher.stopAndDrain()
      database.close()
      values.clear()
      rmSync(root, { recursive: true, force: true })
    }
  }, 25_000)
})
