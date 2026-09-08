import { describe, expect, it, vi } from 'vitest'
import { createPreviewApi, PreviewUnavailableError } from './preview-api'

describe('Web preview isolation', () => {
  it('isolates fixture state per page and returns detached snapshots like IPC', async () => {
    const first = createPreviewApi()
    const second = createPreviewApi()
    const snapshot = await first.getBootstrap()
    snapshot.projects[0].name = 'unsaved edit'
    expect((await first.getBootstrap()).projects[0].name).toBe('Fuddy 示例项目')
    await first.updateProject(snapshot.projects[0])
    snapshot.projects[0].name = 'another edit'
    expect((await first.getBootstrapPatch(['projects'])).projects?.[0].name).toBe('unsaved edit')
    expect((await second.getBootstrap()).projects[0].name).toBe('Fuddy 示例项目')
    expect(await first.getBootstrapPatch(['runs'])).not.toHaveProperty('projects')
  })

  it('creates and edits a draft without starting a native session or sending a message', async () => {
    const api = createPreviewApi()
    const detail = await api.createAgentRunDraft({
      id: 'new-preview-run', projectId: 'preview-project', title: '预览草稿', draftPrompt: '不要发送'
    })
    expect(detail.run).toMatchObject({ status: 'draft', sessionId: null, workingDirectory: null, startedAt: null, provider: 'codex' })
    expect(detail.messages).toEqual([])
    expect(await api.createAgentRunDraft({ id: detail.run.id, projectId: null, title: '重复创建' })).toEqual(detail)
    await api.updateAgentRunDraftPrompt(detail.run.id, '新的草稿')
    await api.renameAgentRun(detail.run.id, '新的标题')
    expect((await api.getAgentRun(detail.run.id)).run).toMatchObject({ draftPrompt: '新的草稿', title: '新的标题' })
    await api.archiveAgentRun(detail.run.id)
    expect((await api.getBootstrap()).runs.some((run) => run.id === detail.run.id)).toBe(false)
    await expect(api.getAgentRun(detail.run.id)).rejects.toThrow('找不到示例数据')
  })

  it('refuses native actions without network, credentials, streams, or state changes', async () => {
    const api = createPreviewApi()
    const before = await api.getBootstrap()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network access'))
    const onUpdate = vi.fn()
    try {
      const attempts = [
        api.sendAgentRunMessage({ runId: 'preview-run', requestId: 'test', prompt: '执行任务' }, onUpdate),
        api.runAutomation('preview-automation'), api.requestMicrophoneAccess(), api.syncCompanionNow(),
        api.startEmailSignIn('preview@example.invalid'), api.revealWorkspacePath('preview-project'),
        api.configureAsrProvider({ mode: 'cloud', cloudBaseUrl: 'https://example.invalid', cloudModel: 'preview', cloudApiKey: 'test-only-value', fallbackToCloud: false })
      ]
      for (const result of await Promise.allSettled(attempts)) {
        expect(result.status).toBe('rejected')
        if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(PreviewUnavailableError)
      }
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(onUpdate).not.toHaveBeenCalled()
      expect(await api.getBootstrap()).toEqual(before)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('supports empty-state navigation and does not expose sample files through another project', async () => {
    const empty = createPreviewApi(true)
    expect((await empty.getBootstrap()).projects).toEqual([])
    expect((await empty.getBootstrap()).runs).toEqual([])
    expect((await empty.getAccountState()).onboarding?.step).toBe('complete')
    expect(await empty.listWorkspaceFiles('preview-project')).toEqual([])
    const api = createPreviewApi()
    expect(await api.listWorkspaceFiles('preview-studio')).toEqual([])
    await expect(api.readWorkspaceFile('preview-studio', 'ui-notes.md')).rejects.toThrow()
    await api.writeWorkspaceFile({ projectId: 'preview-project', relativePath: 'ui-notes.md', content: '示例修改' })
    expect((await api.readWorkspaceFile('preview-project', 'ui-notes.md')).content).toBe('示例修改')
    expect((await createPreviewApi().readWorkspaceFile('preview-project', 'ui-notes.md')).content).not.toBe('示例修改')
  })
})
