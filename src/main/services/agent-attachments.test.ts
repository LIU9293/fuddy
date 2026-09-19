import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, testProject } from '../test-support/project-fixtures'
import { WorkspaceFilesService } from './workspace-files'
import { TaskDispatcher } from './task-dispatcher'
import type { PiTaskHarness } from './pi-task-harness'
import type { CliAgentRuntime, CliAgentTurnInput } from './cli-agent-runtime'
import { persistInputAttachments, registerLinkedArtifacts, incomingAttachmentDirectory } from './agent-attachments'
import { AppDatabase } from './database'
import { buildAgentChatRecords, paginateCompanionChatRecords } from '../../shared/companion-chat'
import { companionChatPageSchema } from '../../shared/companion-schemas'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'fuddy-attachment-loop-')); roots.push(root)
  const database = createTestDatabase(join(root, 'test.sqlite'), [testProject('test', 'Test', root)])
  const files = new WorkspaceFilesService(database, join(root, 'files'))
  const runTurn = vi.fn<CliAgentRuntime['runTurn']>(async input => {
    input.onSessionId('native')
    writeFileSync(join(root, 'report.md'), '# Attachment result')
    return { text: '[报告](report.md)', sessionId: 'native' }
  })
  const dispatcher = new TaskDispatcher(database, {} as PiTaskHarness, files, { runTurn } as unknown as CliAgentRuntime)
  const run = dispatcher.createDraft({ projectId: 'test', provider: 'codex', title: 'Attachments' }).run
  return { root, database, files, run, runTurn, dispatcher }
}
const attachment = { id: 'phone-image', name: '截图.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,cGl4ZWw=' }

describe('attachment message persistence and output loop', () => {
  it.each(['..', '../outside', '/', '', '正常消息'])('confines temporary upload cleanup for command ID %j', commandId => {
    const directory = incomingAttachmentDirectory('/tmp/incoming', commandId)
    expect(relative('/tmp/incoming', directory)).toMatch(/^[a-f0-9]{64}$/)
    expect(directory).not.toBe('/tmp/incoming')
  })
  it('keeps image and document bytes, raw user text, native attachments and output links across reopen and history replay', async () => {
    const { root, database, files, run, runTurn, dispatcher } = setup()
    const document = { id: 'pdf', name: 'report.pdf', mimeType: 'application/pdf', dataUrl: 'data:application/pdf;base64,JVBERi0xLjc=' }
    const detail = await dispatcher.sendMessage(run.id, '看一下图片和文件', undefined, 'phone-message', [attachment, document])
    expect(runTurn.mock.calls[0][0].prompt).toBe('看一下图片和文件')
    const nativeFiles = runTurn.mock.calls[0][0].attachments!
    expect(nativeFiles.map(file => file.mimeType)).toEqual(['image/png', 'application/pdf'])
    expect(readFileSync(nativeFiles[0].path, 'utf8')).toBe('pixel')
    const user = detail.messages.find(message => message.id === 'phone-message')!
    expect(user.attachments).toHaveLength(2)
    expect(user.content).toBe('看一下图片和文件')
    const output = detail.messages.find(message => message.role === 'assistant')!
    expect(output.attachments).toHaveLength(1)
    expect(output.content).toContain('_artifacts/')
    expect(output.content).not.toContain(root)
    const outputArtifact = detail.artifacts.find(artifact => artifact.id === output.attachments![0].artifactId)!
    writeFileSync(join(root, 'report.md'), 'changed after completion')
    expect(files.previewArtifact(outputArtifact).content).toBe('# Attachment result')
    const pdf = detail.artifacts.find(artifact => artifact.id === user.attachments![1].artifactId)!
    expect(files.previewArtifact(pdf).kind).toBe('pdf')
    database.close()
    const reopened = new AppDatabase(join(root, 'test.sqlite'))
    const messages = reopened.getAgentRunDetail(run.id).messages
    expect(messages.find(message => message.id === user.id)?.attachments).toEqual(user.attachments)
    const page = paginateCompanionChatRecords(run.id, 'agent', buildAgentChatRecords(run.id, messages), { limit: 1 })
    expect(page.records[0].agentMessages[0].attachments).toEqual(output.attachments)
    expect(companionChatPageSchema.parse(page).records[0].agentMessages[0].attachments).toEqual(output.attachments)
    reopened.close()
  })

  it('validates a complete input batch before writing and rejects oversized decoded content', () => {
    const { database, files, run } = setup()
    expect(() => persistInputAttachments(database, files, run, 'bad', [attachment, { ...attachment, dataUrl: 'data:image/png;base64,bad!' }])).toThrow('附件数据无效')
    expect(database.getAgentRunDetail(run.id).artifacts).toHaveLength(0)
    const oversized = `data:image/png;base64,${Buffer.alloc(20 * 1024 * 1024).toString('base64')}`
    expect(() => persistInputAttachments(database, files, run, 'big', [{ ...attachment, dataUrl: oversized }])).toThrow('20 MiB')
    database.close()
  })

  it('does not export paths outside Workspace roots, symlink escapes or hidden credentials', () => {
    const { root, database, files, run } = setup()
    const outside = mkdtempSync(join(tmpdir(), 'fuddy-outside-')); roots.push(outside)
    writeFileSync(join(outside, 'secret.txt'), 'private')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'escape.txt'))
    writeFileSync(join(root, '.env'), 'private')
    const text = `[outside](${outside}/secret.txt) [escape](escape.txt) [env](.env)`
    expect(registerLinkedArtifacts(database, files, run, text, [root])).toBe(text)
    expect(database.getAgentRunDetail(run.id).artifacts).toHaveLength(0)
    database.close()
  })
})
