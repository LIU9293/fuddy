import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants as fsConstants, createReadStream } from 'node:fs'
import { access, mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type {
  AsrDownloadProgress,
  AsrModelStatus,
  TranscribeAudioInput,
  TranscriptionResult
} from '../../shared/contracts'
import { ProviderSettingsService } from './provider-settings'

export const WHISPER_MODEL_NAME = 'ggml-large-v3-turbo-q5_0.bin'
export const WHISPER_MODEL_BYTES = 574_041_195
export const WHISPER_MODEL_SHA256 = '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'
export const WHISPER_MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${WHISPER_MODEL_NAME}`

const execFileAsync = promisify(execFile)
const maxCloudAudioBytes = 25 * 1024 * 1024

interface AsrServiceOptions {
  modelDirectory: string
  helperPath: string
  temporaryDirectory: string
  fetchImpl?: typeof fetch
  modelUrl?: string
  modelBytes?: number
  modelSha256?: string
  onDownloadProgress?: (progress: AsrDownloadProgress) => void
  runHelper?: (arguments_: string[]) => Promise<string>
}

function safeCloudError(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const body = value as { error?: { message?: string }; detail?: string; message?: string }
  return (body.error?.message ?? body.detail ?? body.message ?? '')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

function decodeWaveDataUrl(dataUrl: string): Buffer {
  const match = /^data:audio\/(?:wav|wave|x-wav);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!match) throw new Error('语音格式无效，仅支持 WAV。')
  const buffer = Buffer.from(match[1], 'base64')
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('语音文件不是有效的 WAV。')
  }
  if (buffer.length > maxCloudAudioBytes) throw new Error('单段语音不能超过 25 MB。')
  validateWaveContainsSpeech(buffer)
  return buffer
}

function validateWaveContainsSpeech(buffer: Buffer): void {
  let format: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null
  let data: Buffer | null = null
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const start = offset + 8
    const end = start + size
    if (end > buffer.length) throw new Error('语音 WAV 区块长度无效。')
    if (id === 'fmt ' && size >= 16) {
      format = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14)
      }
    } else if (id === 'data') {
      data = buffer.subarray(start, end)
    }
    offset = end + (size % 2)
  }
  if (!format || !data || format.audioFormat !== 1 || format.channels !== 1 || format.sampleRate !== 16_000 || format.bitsPerSample !== 16) {
    throw new Error('语音 WAV 必须是 16 kHz 单声道 PCM16。')
  }
  const sampleCount = Math.floor(data.length / 2)
  if (sampleCount < 4_000) throw new Error('录音太短，请再说一次。')
  const windowSize = 320
  let peak = 0
  let activeWindows = 0
  for (let offset = 0; offset < sampleCount; offset += windowSize) {
    const end = Math.min(sampleCount, offset + windowSize)
    let squareSum = 0
    for (let index = offset; index < end; index += 1) {
      const sample = data.readInt16LE(index * 2) / 32_768
      peak = Math.max(peak, Math.abs(sample))
      squareSum += sample * sample
    }
    if (Math.sqrt(squareSum / (end - offset)) >= 0.003) activeWindows += 1
  }
  if (peak < 0.01 || activeWindows * 20 < 120) {
    throw new Error('没有录到有效声音，请检查系统麦克风输入后再试。')
  }
}

export class AsrService {
  private readonly modelPath: string
  private readonly partialModelPath: string
  private readonly fetchImpl: typeof fetch
  private readonly modelUrl: string
  private readonly modelBytes: number
  private readonly modelSha256: string
  private downloadPromise: Promise<AsrModelStatus> | null = null
  private downloadError: string | null = null

  constructor(
    private readonly settings: ProviderSettingsService,
    private readonly options: AsrServiceOptions
  ) {
    this.modelPath = join(options.modelDirectory, WHISPER_MODEL_NAME)
    this.partialModelPath = `${this.modelPath}.partial`
    this.fetchImpl = options.fetchImpl ?? fetch
    this.modelUrl = options.modelUrl ?? WHISPER_MODEL_URL
    this.modelBytes = options.modelBytes ?? WHISPER_MODEL_BYTES
    this.modelSha256 = options.modelSha256 ?? WHISPER_MODEL_SHA256
  }

  async getModelStatus(): Promise<AsrModelStatus> {
    if (this.downloadPromise) {
      const downloaded = await this.fileSize(this.partialModelPath)
      return this.status('downloading', downloaded, null)
    }
    const installed = await this.isValidModel()
    if (installed) return this.status('installed', this.modelBytes, null)
    const partial = await this.fileSize(this.partialModelPath)
    return this.status(this.downloadError ? 'error' : 'not-downloaded', partial, this.downloadError)
  }

  downloadModel(): Promise<AsrModelStatus> {
    if (this.downloadPromise) return this.downloadPromise
    this.downloadError = null
    this.downloadPromise = this.performDownload().finally(() => { this.downloadPromise = null })
    return this.downloadPromise
  }

  async deleteModel(): Promise<AsrModelStatus> {
    if (this.downloadPromise) throw new Error('模型正在下载，请等待下载完成后再删除。')
    await Promise.all([
      rm(this.modelPath, { force: true }),
      rm(this.partialModelPath, { force: true })
    ])
    this.downloadError = null
    return this.status('not-downloaded', 0, null)
  }

  async transcribe(input: TranscribeAudioInput): Promise<TranscriptionResult> {
    const audio = decodeWaveDataUrl(input.audioDataUrl)
    const settings = this.settings.getAsrRuntimeSettings()
    const started = Date.now()

    if (settings.mode === 'local-first') {
      if (await this.isValidModel()) {
        try {
          const result = await this.transcribeLocal(audio, input)
          return { ...result, fallbackUsed: false }
        } catch (error) {
          if (error instanceof Error && error.message.includes('没有识别到清晰语音')) throw error
          if (!settings.fallbackToCloud || !settings.cloudApiKey) throw error
        }
      } else if (!settings.fallbackToCloud || !settings.cloudApiKey) {
        throw new Error('本地 Whisper 尚未下载；请下载模型，或配置云端 ASR。')
      }
      const text = await this.transcribeCloud(audio, input)
      return { text, provider: 'cloud', fallbackUsed: true, durationMilliseconds: Date.now() - started }
    }

    const text = await this.transcribeCloud(audio, input)
    return { text, provider: 'cloud', fallbackUsed: false, durationMilliseconds: Date.now() - started }
  }

  private async transcribeLocal(
    audio: Buffer,
    input: TranscribeAudioInput
  ): Promise<Omit<TranscriptionResult, 'fallbackUsed'>> {
    await access(this.options.helperPath, fsConstants.X_OK).catch(() => {
      throw new Error('本地 Whisper 运行组件缺失，请重新安装应用。')
    })
    await mkdir(this.options.temporaryDirectory, { recursive: true })
    const inputPath = join(this.options.temporaryDirectory, `${randomUUID()}.wav`)
    await writeFile(inputPath, audio, { mode: 0o600 })
    try {
      const arguments_ = [
        '--model', this.modelPath,
        '--input', inputPath,
        '--language', input.language?.trim() || 'auto'
      ]
      if (input.prompt?.trim()) arguments_.push('--prompt', input.prompt.trim())
      let stdout: string
      try {
        stdout = this.options.runHelper
          ? await this.options.runHelper(arguments_)
          : (await execFileAsync(this.options.helperPath, arguments_, {
              timeout: 120_000,
              maxBuffer: 2 * 1024 * 1024
            })).stdout
      } catch (error) {
        const stderr = error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
          ? error.stderr.trim()
          : ''
        if (stderr.includes('没有识别到清晰语音')) throw new Error('没有识别到清晰语音，请检查麦克风输入后再试。')
        throw new Error('本地 Whisper 转写失败，请重试。')
      }
      const line = stdout.trim().split('\n').at(-1)
      if (!line) throw new Error('本地 Whisper 未返回转写结果。')
      const result = JSON.parse(line) as { text?: unknown; durationMilliseconds?: unknown }
      if (typeof result.text !== 'string') throw new Error('本地 Whisper 返回格式无效。')
      return {
        text: result.text.trim(),
        provider: 'local-whisper',
        durationMilliseconds: typeof result.durationMilliseconds === 'number' ? result.durationMilliseconds : 0
      }
    } finally {
      await rm(inputPath, { force: true })
    }
  }

  private async transcribeCloud(audio: Buffer, input: TranscribeAudioInput): Promise<string> {
    const settings = this.settings.getAsrRuntimeSettings()
    if (!settings.cloudApiKey) throw new Error('请先在语音设置中保存云端 ASR API Key。')
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'recording.wav')
    form.append('model', settings.cloudModel)
    if (input.language?.trim() && input.language !== 'auto') form.append('language', input.language.trim())
    if (input.prompt?.trim()) form.append('prompt', input.prompt.trim())
    const response = await this.fetchImpl(`${settings.cloudBaseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.cloudApiKey}` },
      body: form,
      signal: AbortSignal.timeout(120_000)
    })
    if (!response.ok) {
      let detail = ''
      try { detail = safeCloudError(await response.json()) } catch { /* non-JSON provider response */ }
      throw new Error(`云端 ASR 请求失败（HTTP ${response.status}${detail ? `：${detail}` : ''}）。`)
    }
    const result = await response.json() as { text?: unknown }
    if (typeof result.text !== 'string') throw new Error('云端 ASR 未返回文本。')
    return result.text.trim()
  }

  private async performDownload(): Promise<AsrModelStatus> {
    await mkdir(this.options.modelDirectory, { recursive: true })
    await rm(this.partialModelPath, { force: true })
    try {
      const response = await this.fetchImpl(this.modelUrl, { redirect: 'follow' })
      if (!response.ok || !response.body) throw new Error(`模型下载失败（HTTP ${response.status}）。`)
      const reader = response.body.getReader()
      const output = await open(this.partialModelPath, 'w', 0o600)
      const hash = createHash('sha256')
      let downloaded = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          await output.write(value)
          hash.update(value)
          downloaded += value.byteLength
          this.options.onDownloadProgress?.({ bytesDownloaded: downloaded, totalBytes: this.modelBytes })
        }
      } finally {
        await output.close()
      }
      const digest = hash.digest('hex')
      if (downloaded !== this.modelBytes || digest !== this.modelSha256) {
        throw new Error('模型文件校验失败，请重新下载。')
      }
      await rename(this.partialModelPath, this.modelPath)
      this.options.onDownloadProgress?.({ bytesDownloaded: this.modelBytes, totalBytes: this.modelBytes })
      return this.status('installed', this.modelBytes, null)
    } catch (error) {
      await rm(this.partialModelPath, { force: true })
      this.downloadError = error instanceof Error ? error.message : '模型下载失败。'
      throw error
    }
  }

  private async isValidModel(): Promise<boolean> {
    try {
      const info = await stat(this.modelPath)
      if (info.size !== this.modelBytes) return false
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(this.modelPath)) hash.update(chunk)
      const digest = hash.digest('hex')
      return digest === this.modelSha256
    } catch {
      return false
    }
  }

  private async fileSize(path: string): Promise<number> {
    try { return (await stat(path)).size } catch { return 0 }
  }

  private status(state: AsrModelStatus['state'], bytesDownloaded: number, error: string | null): AsrModelStatus {
    return {
      state,
      model: 'large-v3-turbo-q5_0',
      bytesDownloaded,
      totalBytes: this.modelBytes,
      error
    }
  }
}
