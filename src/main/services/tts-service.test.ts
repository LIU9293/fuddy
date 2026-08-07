import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MorningBriefing } from '../../shared/contracts'
import type { AppDatabase } from './database'
import type { ProviderSettingsService, RuntimeTtsSettings } from './provider-settings'
import { TtsService } from './tts-service'

const briefing: MorningBriefing = {
  id: 'morning-2026-08-06',
  reportDate: '2026-08-06',
  timezone: 'Asia/Shanghai',
  status: 'completed',
  headline: '今日简报',
  body: '正文',
  narration: '这是一段跨项目中文简报。',
  estimatedDurationSeconds: 10,
  sourceBriefingIds: [],
  signalIds: [],
  generatedAt: '2026-08-06T01:00:00.000Z',
  error: null,
  generation: 'deterministic'
}

function createService(settings: RuntimeTtsSettings): TtsService {
  const database = {
    getMorningBriefingById: vi.fn(() => briefing)
  } as unknown as AppDatabase
  const providerSettings = {
    getTtsCacheKey: vi.fn(() => JSON.stringify(settings)),
    getTtsRuntimeSettings: vi.fn(() => settings)
  } as unknown as ProviderSettingsService
  return new TtsService(database, providerSettings)
}

describe('TTS provider fallback', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('switches from a failed primary OpenAI endpoint to ElevenLabs', async () => {
    const settings: RuntimeTtsSettings = {
      primary: {
        mode: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini-tts',
        voice: 'marin',
        instructions: '自然地说中文',
        apiKey: 'primary-secret'
      },
      backup: {
        mode: 'elevenlabs',
        baseUrl: 'https://api.elevenlabs.io/v1',
        model: 'eleven_multilingual_v2',
        voice: 'voice-123',
        instructions: '',
        apiKey: 'backup-secret'
      },
      backupEnabled: true
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(new Uint8Array(256), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await createService(settings).getBriefingAudio(briefing.id)

    expect(result.provider).toBe('elevenlabs')
    expect(result.fallbackUsed).toBe(true)
    expect(result.audioDataUrl).toMatch(/^data:audio\/mpeg;base64,/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/voice-123?output_format=mp3_44100_128'
    )
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      headers: {
        'xi-api-key': 'backup-secret',
        'Content-Type': 'application/json'
      }
    })
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toEqual({
      text: briefing.narration,
      model_id: 'eleven_multilingual_v2'
    })
  })

  it('does not contact the backup when the primary succeeds', async () => {
    const settings: RuntimeTtsSettings = {
      primary: {
        mode: 'openai-compatible',
        baseUrl: 'https://speech.example.com/v1',
        model: 'gpt-4o-mini-tts',
        voice: 'cedar',
        instructions: '自然地说中文',
        apiKey: 'primary-secret'
      },
      backup: {
        mode: 'system',
        baseUrl: 'https://api.openai.com/v1',
        model: '',
        voice: '',
        instructions: '',
        apiKey: null
      },
      backupEnabled: true
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array(256), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await createService(settings).testProvider()

    expect(result.provider).toBe('openai-compatible')
    expect(result.fallbackUsed).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('designs an account-owned voice and verifies it with Flash 2.5', async () => {
    const settings: RuntimeTtsSettings = {
      primary: {
        mode: 'elevenlabs',
        baseUrl: 'https://api.elevenlabs.io/v1',
        model: 'eleven_flash_v2_5',
        voice: 'library-voice',
        instructions: '',
        apiKey: 'primary-secret'
      },
      backup: {
        mode: 'system',
        baseUrl: 'https://api.openai.com/v1',
        model: '',
        voice: '',
        instructions: '',
        apiKey: null
      },
      backupEnabled: true
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ voices: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        previews: [{ generated_voice_id: 'generated-voice' }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        voice_id: 'owned-voice',
        name: 'Project Agent 中文女声'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array(256), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await createService(settings).designElevenLabsVoice()

    expect(result.voiceId).toBe('owned-voice')
    expect(result.audioDataUrl).toMatch(/^data:audio\/mpeg;base64,/)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock.mock.calls[3][0]).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/owned-voice?output_format=mp3_44100_128'
    )
    expect(JSON.parse(String(fetchMock.mock.calls[3][1].body))).toMatchObject({
      model_id: 'eleven_flash_v2_5'
    })
  })

  it('reuses a web-created account voice and verifies it with Flash 2.5', async () => {
    const settings: RuntimeTtsSettings = {
      primary: {
        mode: 'elevenlabs',
        baseUrl: 'https://api.elevenlabs.io/v1',
        model: 'eleven_flash_v2_5',
        voice: 'library-voice',
        instructions: '',
        apiKey: 'primary-secret'
      },
      backup: {
        mode: 'system',
        baseUrl: 'https://api.openai.com/v1',
        model: '',
        voice: '',
        instructions: '',
        apiKey: null
      },
      backupEnabled: true
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        voices: [{
          voice_id: 'web-owned-voice',
          name: 'Project Agent 中文女声',
          category: 'generated'
        }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array(256), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await createService(settings).designElevenLabsVoice()

    expect(result.voiceId).toBe('web-owned-voice')
    expect(result.message).toContain('已找到')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/web-owned-voice?output_format=mp3_44100_128'
    )
  })
})
