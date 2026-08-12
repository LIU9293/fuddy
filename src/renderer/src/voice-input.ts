import type { MicrophoneAccessResult } from '../../shared/contracts'

export function microphoneAccessError(access: MicrophoneAccessResult): string | null {
  if (access.granted) return null
  if (access.status === 'denied') {
    return '麦克风权限未开启。请在系统设置中允许 Project Agent 使用麦克风，然后重启 App。'
  }
  if (access.status === 'restricted') {
    return '麦克风访问受到系统限制。请检查“隐私与安全性 → 麦克风”或设备管理设置。'
  }
  return '无法获得麦克风权限，请检查 macOS 麦克风设置后重试。'
}

export function downsampleAudio(input: Float32Array, inputRate: number, outputRate = 16_000): Float32Array {
  if (outputRate > inputRate) throw new Error('不支持将录音升采样。')
  if (outputRate === inputRate) return input
  const ratio = inputRate / outputRate
  const output = new Float32Array(Math.floor(input.length / ratio))
  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio)
    const end = Math.min(input.length, Math.floor((index + 1) * ratio))
    let sum = 0
    for (let cursor = start; cursor < end; cursor += 1) sum += input[cursor]
    output[index] = end > start ? sum / (end - start) : input[start] ?? 0
  }
  return output
}

export function mergeAudioChunks(chunks: readonly Float32Array[]): Float32Array {
  const output = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

export interface AudioSignalAnalysis {
  peak: number
  rms: number
  activeMilliseconds: number
}

export function analyzeAudioSignal(input: Float32Array, sampleRate: number): AudioSignalAnalysis {
  if (input.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return { peak: 0, rms: 0, activeMilliseconds: 0 }
  }
  let mean = 0
  for (const sample of input) mean += sample
  mean /= input.length
  let peak = 0
  let squareSum = 0
  let activeWindows = 0
  const windowSize = Math.max(1, Math.floor(sampleRate * 0.02))
  for (let offset = 0; offset < input.length; offset += windowSize) {
    const end = Math.min(input.length, offset + windowSize)
    let windowSquareSum = 0
    for (let index = offset; index < end; index += 1) {
      const centered = input[index] - mean
      peak = Math.max(peak, Math.abs(centered))
      squareSum += centered * centered
      windowSquareSum += centered * centered
    }
    if (Math.sqrt(windowSquareSum / (end - offset)) >= 0.003) activeWindows += 1
  }
  return {
    peak,
    rms: Math.sqrt(squareSum / input.length),
    activeMilliseconds: activeWindows * 20
  }
}

export function prepareAudioForTranscription(input: Float32Array, sampleRate: number): Float32Array {
  const analysis = analyzeAudioSignal(input, sampleRate)
  if (analysis.peak < 0.01 || analysis.activeMilliseconds < 120) {
    throw new Error('没有录到有效声音，请检查系统麦克风输入后再试。')
  }
  let mean = 0
  for (const sample of input) mean += sample
  mean /= input.length
  const gain = Math.min(12, 0.8 / analysis.peak)
  const output = new Float32Array(input.length)
  for (let index = 0; index < input.length; index += 1) {
    output[index] = Math.max(-1, Math.min(1, (input[index] - mean) * gain))
  }
  return output
}

export function encodePcm16Wave(samples: Float32Array, sampleRate = 16_000): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeText = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]))
    view.setInt16(44 + index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('无法读取录音。'))
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取录音。'))
    reader.readAsDataURL(blob)
  })
}
