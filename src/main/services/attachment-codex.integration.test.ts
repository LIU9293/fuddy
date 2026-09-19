import { randomInt } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { createTestDatabase, testProject } from '../test-support/project-fixtures'
import { WorkspaceFilesService } from './workspace-files'
import { CliAgentRuntime } from './cli-agent-runtime'
import { TaskDispatcher } from './task-dispatcher'
import type { PiTaskHarness } from './pi-task-harness'

// PNG contains only pixels: the random answer is never present in a filename,
// prompt, metadata chunk or fixture that the Agent could read as plain text.
function digitImage(text: string): Buffer {
  return execFileSync('python3', ['-c', [
    'from PIL import Image, ImageDraw, ImageFont',
    'import sys',
    'image = Image.new("RGB", (840, 200), "white")',
    'ImageDraw.Draw(image).text((36, 32), " ".join(sys.argv[1]), fill="black", font=ImageFont.load_default(size=108))',
    'image.save(sys.stdout.buffer, format="PNG")'
  ].join('\n'), text])
}

it.skipIf(process.env.RUN_ATTACHMENT_CODEX_SMOKE !== '1')('reads an actual attached image in Codex, returns files, and remembers it on resume', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fuddy-dev-codex-vision-'))
  const database = createTestDatabase(join(root, 'dev.sqlite'), [testProject('vision', 'Vision test', root)])
  const files = new WorkspaceFilesService(database, join(root, 'files'))
  const runtime = new CliAgentRuntime({ getLaunchConfigs: async () => [] })
  const dispatcher = new TaskDispatcher(database, {} as PiTaskHarness, files, runtime)
  const run = dispatcher.createDraft({ projectId: 'vision', provider: 'codex', title: 'Isolated attachment smoke' }).run
  const answer = String(randomInt(100000, 1000000)), image = digitImage(answer)
  try {
    const detail = await dispatcher.sendMessage(run.id,
      '直接读取附加图片上的六位数字，第一行只回复这六位数字。然后将附图原样复制为 Workspace 中的 result.png，将数字写入 report.md，返回这两个文件的 Markdown 链接。不要使用 OCR 工具，图片已通过原生输入提供。',
      undefined, undefined, [{ id: 'input-image', name: 'input.png', mimeType: 'image/png', dataUrl: `data:image/png;base64,${image.toString('base64')}` }])
    expect(detail.run.status, detail.run.summary).toBe('idle')
    const response = detail.messages.findLast(message => message.role === 'assistant')!
    expect(response.content).toContain(answer)
    expect(response.attachments?.map(file => file.filename)).toEqual(expect.arrayContaining(['result.png', 'report.md']))
    const output = detail.artifacts.find(file => file.id === response.attachments?.find(file => file.filename === 'result.png')?.artifactId)!
    expect(readFileSync(files.resolvePath(run.projectId, output.relativePath))).toEqual(image)
    const continued = await dispatcher.sendMessage(run.id, '再重复刚才图片上的六位数字，只回复数字，不调用工具。')
    expect(continued.run.sessionId).toBe(detail.run.sessionId)
    expect(continued.messages.findLast(message => message.role === 'assistant')?.content).toContain(answer)
  } finally {
    await dispatcher.stopMessage(run.id)
    await runtime.stopAndDrain()
    database.close(); rmSync(root, { recursive: true, force: true })
  }
}, 240_000)
