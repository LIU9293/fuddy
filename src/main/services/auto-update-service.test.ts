import { afterEach, describe, expect, it, vi } from 'vitest'

const updater = vi.hoisted(() => ({
  autoDownload: false,
  autoInstallOnAppQuit: false,
  on: vi.fn(),
  removeListener: vi.fn(),
  checkForUpdatesAndNotify: vi.fn().mockResolvedValue(null)
}))

vi.mock('electron', () => ({ app: { isPackaged: true } }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: updater } }))

import { startAutoUpdateService } from './auto-update-service'

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('auto update service', () => {
  it('does not initialize the production updater for an isolated development build', () => {
    const stop = startAutoUpdateService(vi.fn(), false)
    expect(updater.on).not.toHaveBeenCalled()
    expect(updater.checkForUpdatesAndNotify).not.toHaveBeenCalled()
    stop()
  })

  it('checks signed release metadata after startup and cleans up listeners', async () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    const stop = startAutoUpdateService(onError)
    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(true)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledOnce()
    stop()
    expect(updater.removeListener).toHaveBeenCalledWith('error', onError)
  })
})
