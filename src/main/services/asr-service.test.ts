import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeAsrSettings } from './provider-settings'
import type { ProviderSettingsService } from './provider-settings'
import { AsrService, WHISPER_MODEL_NAME } from './asr-service'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'project-agent-asr-test-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function settings(value: RuntimeAsrSettings): ProviderSettingsService {
  return { getAsrRuntimeSettings: () => value } as unknown as ProviderSettingsService
}

function waveDataUrl(): string {
  const buffer = Buffer.alloc(48)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(40, 4)
  buffer.write('WAVE', 8)
  return `data:audio/wav;base64,${buffer.toString('base64')}`
}

async function fixture(settingsValue: RuntimeAsrSettings, overrides: Record<string, unknown> = {}) {
  const root = await temporaryDirectory()
  const helperPath = join(root, 'whisper-helper')
  await writeFile(helperPath, '#!/bin/sh\nexit 0\n')
  await chmod(helperPath, 0o755)
  const model = Buffer.from('tiny-model-for-tests')
  return {
    root,
    model,
    service: new AsrService(settings(settingsValue), {
      modelDirectory: join(root, 'models'),
      helperPath,
      temporaryDirectory: join(root, 'temp'),
      modelBytes: model.length,
      modelSha256: createHash('sha256').update(model).digest('hex'),
      ...overrides
    })
  }
}

describe('AsrService', () => {
  it('downloads, verifies and deletes the optional local model', async () => {
    const progress = vi.fn()
    const configured = await fixture({
      mode: 'local-first', cloudBaseUrl: 'https://api.openai.com/v1', cloudModel: 'gpt-transcribe',
      fallbackToCloud: false, cloudApiKey: null
    }, {
      fetchImpl: vi.fn(async () => new Response(Buffer.from('tiny-model-for-tests'))),
      onDownloadProgress: progress
    })

    expect((await configured.service.getModelStatus()).state).toBe('not-downloaded')
    expect((await configured.service.downloadModel()).state).toBe('installed')
    expect(await readFile(join(configured.root, 'models', WHISPER_MODEL_NAME))).toEqual(configured.model)
    expect(progress).toHaveBeenCalled()
    expect((await configured.service.deleteModel()).state).toBe('not-downloaded')
  })

  it('uses the local helper when the verified model is installed', async () => {
    const runHelper = vi.fn(async () => '{"text":"本地转写结果","durationMilliseconds":42}\n')
    const configured = await fixture({
      mode: 'local-first', cloudBaseUrl: 'https://api.openai.com/v1', cloudModel: 'gpt-transcribe',
      fallbackToCloud: true, cloudApiKey: 'cloud-key'
    }, { runHelper })
    await mkdir(join(configured.root, 'models'), { recursive: true })
    await writeFile(join(configured.root, 'models', WHISPER_MODEL_NAME), configured.model)

    await expect(configured.service.transcribe({ audioDataUrl: waveDataUrl(), language: 'zh' })).resolves.toEqual({
      text: '本地转写结果', provider: 'local-whisper', fallbackUsed: false, durationMilliseconds: 42
    })
    expect(runHelper).toHaveBeenCalledOnce()
  })

  it('falls back to the cloud transcription endpoint when the model is absent', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({ Authorization: 'Bearer cloud-key' })
      expect(init?.body).toBeInstanceOf(FormData)
      return Response.json({ text: '云端转写结果' })
    })
    const configured = await fixture({
      mode: 'local-first', cloudBaseUrl: 'https://api.openai.com/v1', cloudModel: 'gpt-transcribe',
      fallbackToCloud: true, cloudApiKey: 'cloud-key'
    }, { fetchImpl })

    const result = await configured.service.transcribe({ audioDataUrl: waveDataUrl() })
    expect(result.text).toBe('云端转写结果')
    expect(result.provider).toBe('cloud')
    expect(result.fallbackUsed).toBe(true)
    expect(fetchImpl).toHaveBeenCalledWith('https://api.openai.com/v1/audio/transcriptions', expect.any(Object))
  })

  it('explains how to recover when neither local nor cloud ASR is available', async () => {
    const configured = await fixture({
      mode: 'local-first', cloudBaseUrl: 'https://api.openai.com/v1', cloudModel: 'gpt-transcribe',
      fallbackToCloud: true, cloudApiKey: null
    })
    await expect(configured.service.transcribe({ audioDataUrl: waveDataUrl() }))
      .rejects.toThrow('本地 Whisper 尚未下载')
  })
})
