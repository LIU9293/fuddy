import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ProviderSettingsService, RuntimeAsrSettings } from './provider-settings'
import { AsrService, WHISPER_MODEL_NAME } from './asr-service'

const enabled = process.env.RUN_ASR_SMOKE === '1'
const execFileAsync = promisify(execFile)
let root = ''
let audioDataUrl = ''

describe.skipIf(!enabled)('local Whisper end-to-end smoke', () => {
  beforeAll(async () => {
    const modelPath = process.env.WHISPER_MODEL_PATH
    const audioPath = process.env.WHISPER_AUDIO_PATH
    if (!modelPath || !audioPath) throw new Error('请设置 WHISPER_MODEL_PATH 和 WHISPER_AUDIO_PATH。')
    root = await mkdtemp(join(tmpdir(), 'project-agent-asr-smoke-'))
    await mkdir(join(root, 'models'))
    await symlink(modelPath, join(root, 'models', WHISPER_MODEL_NAME))
    const converted = join(root, 'input.wav')
    await execFileAsync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', audioPath, converted])
    audioDataUrl = `data:audio/wav;base64,${(await readFile(converted)).toString('base64')}`
  }, 30_000)

  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

  it('records the same WAV contract used by the UI and returns local text', async () => {
    const runtime: RuntimeAsrSettings = {
      mode: 'local-first',
      cloudBaseUrl: 'https://api.openai.com/v1',
      cloudModel: 'gpt-transcribe',
      cloudApiKey: null,
      fallbackToCloud: false
    }
    const settings = { getAsrRuntimeSettings: () => runtime } as unknown as ProviderSettingsService
    const service = new AsrService(settings, {
      modelDirectory: join(root, 'models'),
      helperPath: join(process.cwd(), '.third-party-tools', 'whisper', 'darwin-arm64', 'whisper-helper'),
      temporaryDirectory: join(root, 'temp')
    })
    const result = await service.transcribe({
      audioDataUrl,
      language: 'zh',
      prompt: 'Fuddy，项目，目标，决策收件箱，工作助理，Agent Run'
    })
    expect(result.provider).toBe('local-whisper')
    expect(result.fallbackUsed).toBe(false)
    expect(result.text.length).toBeGreaterThan(10)
  }, 120_000)
})
