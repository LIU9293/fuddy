import { describe, expect, it } from 'vitest'
import { downsampleAudio, encodePcm16Wave, mergeAudioChunks } from './voice-input'

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
})
