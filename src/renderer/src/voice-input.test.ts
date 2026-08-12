import { describe, expect, it } from 'vitest'
import { analyzeAudioSignal, downsampleAudio, encodePcm16Wave, mergeAudioChunks, microphoneAccessError, prepareAudioForTranscription } from './voice-input'

describe('microphone permission messages', () => {
  it('continues only when macOS granted microphone access', () => {
    expect(microphoneAccessError({ granted: true, status: 'granted' })).toBeNull()
    expect(microphoneAccessError({ granted: false, status: 'denied' }))
      .toContain('系统设置')
    expect(microphoneAccessError({ granted: false, status: 'restricted' }))
      .toContain('系统限制')
  })
})

describe('voice input WAV encoding', () => {
  it('merges and downsamples microphone frames to 16 kHz', () => {
    const merged = mergeAudioChunks([new Float32Array([0, 1]), new Float32Array([-1, 0.5])])
    expect(Array.from(merged)).toEqual([0, 1, -1, 0.5])
    expect(Array.from(downsampleAudio(new Float32Array([0, 1, 0, -1]), 32_000))).toEqual([0.5, -0.5])
  })

  it('writes a mono PCM16 RIFF/WAVE file accepted by the native helper', async () => {
    const bytes = new Uint8Array(await encodePcm16Wave(new Float32Array([0, 1, -1])).arrayBuffer())
    const view = new DataView(bytes.buffer)
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF')
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe('WAVE')
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(6)
  })

  it('rejects silent microphone input instead of sending it to Whisper', () => {
    const silence = new Float32Array(16_000)
    expect(analyzeAudioSignal(silence, 16_000)).toEqual({ peak: 0, rms: 0, activeMilliseconds: 0 })
    expect(() => prepareAudioForTranscription(silence, 16_000)).toThrow('没有录到有效声音')
  })

  it('accepts and normalizes a quiet speech-like signal', () => {
    const samples = Float32Array.from({ length: 8_000 }, (_, index) => 0.02 * Math.sin(index / 4))
    const prepared = prepareAudioForTranscription(samples, 16_000)
    expect(analyzeAudioSignal(samples, 16_000).activeMilliseconds).toBeGreaterThan(120)
    expect(Math.max(...prepared)).toBeGreaterThan(0.2)
  })
})
