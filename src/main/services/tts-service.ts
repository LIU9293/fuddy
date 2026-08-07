import type { BriefingAudioResult, ElevenLabsVoiceDesignResult, TtsProviderMode } from '../../shared/contracts'
import { AppDatabase } from './database'
import { ProviderSettingsService, type RuntimeTtsEndpoint } from './provider-settings'

interface CachedAudio {
  generatedAt: string
  configurationKey: string
  dataUrl: string
  provider: TtsProviderMode
  fallbackUsed: boolean
}

function providerLabel(mode: TtsProviderMode): string {
  if (mode === 'elevenlabs') return 'ElevenLabs'
  if (mode === 'openai-compatible') return 'OpenAI-compatible'
  return '系统语音'
}

function safeProviderErrorDetail(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const body = value as {
    detail?: string | { message?: string; status?: string }
    message?: string
  }
  const detail = typeof body.detail === 'string'
    ? body.detail
    : body.detail?.message ?? body.detail?.status ?? body.message ?? ''
  return detail
    .replace(/sk_[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

async function providerRequestError(label: string, response: Response): Promise<Error> {
  let detail = ''
  try {
    detail = safeProviderErrorDetail(await response.json())
  } catch {
    // Some compatible providers return an empty or non-JSON error response.
  }
  return new Error(`${label} 请求失败（HTTP ${response.status}${detail ? `：${detail}` : ''}）`)
}

export class TtsService {
  private readonly cache = new Map<string, CachedAudio>()

  constructor(
    private readonly database: AppDatabase,
    private readonly settings: ProviderSettingsService
  ) {}

  async getBriefingAudio(briefingId: string): Promise<BriefingAudioResult> {
    const briefing = this.database.getMorningBriefingById(briefingId)
    if (!briefing) throw new Error('没有找到这份每日简报。')
    const configurationKey = this.settings.getTtsCacheKey()
    const cached = this.cache.get(briefing.id)
    if (cached?.generatedAt === briefing.generatedAt && cached.configurationKey === configurationKey) {
      return {
        mode: 'cloud',
        provider: cached.provider,
        fallbackUsed: cached.fallbackUsed,
        audioDataUrl: cached.dataUrl,
        mimeType: 'audio/mpeg',
        message: `已读取缓存的 ${providerLabel(cached.provider)} AI 语音。`
      }
    }

    const result = await this.createSpeechWithFallback(briefing.narration)
    if (result.mode === 'cloud' && result.audioDataUrl) {
      this.cache.set(briefing.id, {
        generatedAt: briefing.generatedAt,
        configurationKey,
        dataUrl: result.audioDataUrl,
        provider: result.provider,
        fallbackUsed: result.fallbackUsed
      })
    }
    return result
  }

  async testProvider(): Promise<BriefingAudioResult> {
    return this.createSpeechWithFallback('你好，这是一段 Project Agent 云端语音测试。')
  }

  async designElevenLabsVoice(): Promise<ElevenLabsVoiceDesignResult> {
    const settings = this.settings.getTtsRuntimeSettings()
    const endpoint = [settings.primary, settings.backup].find(
      (candidate) => candidate.mode === 'elevenlabs' && candidate.apiKey
    )
    if (!endpoint?.apiKey) throw new Error('请先保存 ElevenLabs API Key。')

    const voiceName = 'Project Agent 中文女声'
    const voiceDescription = 'A warm, calm and intelligent Mandarin Chinese female voice in her early thirties. Clear standard pronunciation, measured pacing, trustworthy and concise, suitable for a private executive assistant delivering a morning business briefing.'
    const previewText = '早上好，这是今天的项目简报。我会先告诉你最需要关注的变化，再说明关键数据、潜在风险和建议行动。Roombase 需要关注增长和运营，Vows 正在推进产品体验，AI Marketing 继续验证品牌素材生产流程。接下来，我们从最重要的一项开始，并把今天可以完成的行动安排清楚。'
    const existingVoice = await this.findElevenLabsVoice(endpoint, voiceName)
    if (existingVoice) {
      return this.verifyElevenLabsFlashVoice(endpoint, existingVoice.voice_id, existingVoice.name)
    }

    const designResponse = await fetch(
      `${endpoint.baseUrl}/text-to-voice/design?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': endpoint.apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model_id: 'eleven_multilingual_ttv_v2',
          voice_description: voiceDescription,
          text: previewText,
          auto_generate_text: false,
          guidance_scale: 4
        }),
        signal: AbortSignal.timeout(90_000)
      }
    )
    if (!designResponse.ok) throw await providerRequestError('ElevenLabs Voice Design', designResponse)
    const design = await designResponse.json() as {
      previews?: Array<{ generated_voice_id?: string }>
    }
    const generatedVoiceId = design.previews?.[0]?.generated_voice_id
    if (!generatedVoiceId) throw new Error('ElevenLabs Voice Design 未返回可保存的声音。')

    const saveResponse = await fetch(`${endpoint.baseUrl}/text-to-voice`, {
      method: 'POST',
      headers: {
        'xi-api-key': endpoint.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        voice_name: voiceName,
        voice_description: voiceDescription,
        generated_voice_id: generatedVoiceId,
        labels: {
          language: 'zh',
          use_case: 'morning briefing'
        }
      }),
      signal: AbortSignal.timeout(45_000)
    })
    if (!saveResponse.ok) throw await providerRequestError('ElevenLabs 保存声音', saveResponse)
    const saved = await saveResponse.json() as { voice_id?: string; name?: string }
    if (!saved.voice_id) throw new Error('ElevenLabs 保存声音后未返回 Voice ID。')

    return this.verifyElevenLabsFlashVoice(endpoint, saved.voice_id, saved.name ?? voiceName)
  }

  private async findElevenLabsVoice(
    endpoint: RuntimeTtsEndpoint,
    voiceName: string
  ): Promise<{ voice_id: string; name: string } | null> {
    const response = await fetch(`${endpoint.baseUrl}/voices`, {
      headers: { 'xi-api-key': endpoint.apiKey as string },
      signal: AbortSignal.timeout(20_000)
    })
    if (!response.ok) throw await providerRequestError('ElevenLabs 获取声音列表', response)
    const body = await response.json() as {
      voices?: Array<{ voice_id?: string; name?: string; category?: string }>
    }
    const matches = (body.voices ?? []).filter(
      (voice) => voice.voice_id && voice.name?.trim() === voiceName
    )
    const match = matches.find((voice) => voice.category === 'generated') ?? matches[0]
    return match?.voice_id
      ? { voice_id: match.voice_id, name: match.name ?? voiceName }
      : null
  }

  private async verifyElevenLabsFlashVoice(
    endpoint: RuntimeTtsEndpoint,
    voiceId: string,
    voiceName: string
  ): Promise<ElevenLabsVoiceDesignResult> {
    const flashEndpoint: RuntimeTtsEndpoint = {
      ...endpoint,
      model: 'eleven_flash_v2_5',
      voice: voiceId
    }
    const audioResponse = await this.requestElevenLabs(
      '你好，我是你的项目助理。这段语音由 Eleven Flash 2.5 生成。',
      flashEndpoint
    )
    const audio = Buffer.from(await audioResponse.arrayBuffer())
    if (audio.length < 128) throw new Error('Eleven Flash 2.5 返回了无效音频。')

    return {
      voiceId,
      name: voiceName,
      audioDataUrl: `data:audio/mpeg;base64,${audio.toString('base64')}`,
      message: `已找到账户自有女声“${voiceName}”，并通过 Eleven Flash 2.5 生成试听。`
    }
  }

  private async createSpeechWithFallback(input: string): Promise<BriefingAudioResult> {
    const settings = this.settings.getTtsRuntimeSettings()
    const endpoints = settings.backupEnabled
      ? [settings.primary, settings.backup]
      : [settings.primary]
    const failures: string[] = []

    for (const [index, endpoint] of endpoints.entries()) {
      try {
        const result = await this.createSpeech(input, endpoint)
        return {
          ...result,
          fallbackUsed: index > 0,
          message: index > 0
            ? `Primary TTS 不可用，已自动切换到 ${providerLabel(endpoint.mode)}。`
            : result.message
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误'
        failures.push(`${index === 0 ? 'Primary' : 'Backup'}: ${message}`)
      }
    }

    throw new Error(`所有 TTS Provider 均不可用。${failures.join('；')}`)
  }

  private async createSpeech(input: string, endpoint: RuntimeTtsEndpoint): Promise<BriefingAudioResult> {
    if (endpoint.mode === 'system') {
      return {
        mode: 'system',
        provider: 'system',
        fallbackUsed: false,
        audioDataUrl: null,
        mimeType: null,
        message: '当前使用系统中文语音。'
      }
    }
    if (!endpoint.apiKey) throw new Error(`${providerLabel(endpoint.mode)} 尚未配置 API Key`)

    const response = endpoint.mode === 'elevenlabs'
      ? await this.requestElevenLabs(input, endpoint)
      : await this.requestOpenAiCompatible(input, endpoint)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length < 128) throw new Error(`${providerLabel(endpoint.mode)} 返回了无效音频`)
    return {
      mode: 'cloud',
      provider: endpoint.mode,
      fallbackUsed: false,
      audioDataUrl: `data:audio/mpeg;base64,${buffer.toString('base64')}`,
      mimeType: 'audio/mpeg',
      message: `${providerLabel(endpoint.mode)} AI 语音生成成功。`
    }
  }

  private async requestOpenAiCompatible(input: string, endpoint: RuntimeTtsEndpoint): Promise<Response> {
    const response = await fetch(`${endpoint.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${endpoint.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: endpoint.model,
        voice: endpoint.voice,
        input,
        instructions: endpoint.instructions,
        response_format: 'mp3'
      }),
      signal: AbortSignal.timeout(45_000)
    })
    if (!response.ok) {
      throw await providerRequestError('OpenAI-compatible', response)
    }
    return response
  }

  private async requestElevenLabs(input: string, endpoint: RuntimeTtsEndpoint): Promise<Response> {
    const voiceId = encodeURIComponent(endpoint.voice)
    const response = await fetch(
      `${endpoint.baseUrl}/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': endpoint.apiKey as string,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: input,
          model_id: endpoint.model
        }),
        signal: AbortSignal.timeout(45_000)
      }
    )
    if (!response.ok) throw await providerRequestError('ElevenLabs', response)
    return response
  }
}
