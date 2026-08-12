import { describe, expect, it, vi } from 'vitest'
import { requestMacMicrophoneAccess } from './microphone-permissions'

describe('macOS microphone permissions', () => {
  it('does not prompt again after access was granted', async () => {
    const askForAccess = vi.fn(async () => true)
    await expect(requestMacMicrophoneAccess({
      platform: 'darwin',
      getStatus: () => 'granted',
      askForAccess
    })).resolves.toEqual({ granted: true, status: 'granted' })
    expect(askForAccess).not.toHaveBeenCalled()
  })

  it('prompts when access has not been determined', async () => {
    const askForAccess = vi.fn(async () => true)
    await expect(requestMacMicrophoneAccess({
      platform: 'darwin',
      getStatus: () => 'not-determined',
      askForAccess
    })).resolves.toEqual({ granted: true, status: 'granted' })
    expect(askForAccess).toHaveBeenCalledOnce()
  })

  it('returns denied without prompting again when the user already refused access', async () => {
    const askForAccess = vi.fn(async () => true)
    await expect(requestMacMicrophoneAccess({
      platform: 'darwin',
      getStatus: () => 'denied',
      askForAccess
    })).resolves.toEqual({ granted: false, status: 'denied' })
    expect(askForAccess).not.toHaveBeenCalled()
  })

  it('treats non-macOS platforms as already authorized', async () => {
    const askForAccess = vi.fn(async () => false)
    await expect(requestMacMicrophoneAccess({
      platform: 'linux',
      getStatus: () => 'unknown',
      askForAccess
    })).resolves.toEqual({ granted: true, status: 'granted' })
    expect(askForAccess).not.toHaveBeenCalled()
  })
})
