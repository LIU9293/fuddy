import { app } from 'electron'
import electronUpdater from 'electron-updater'

// electron-updater is published as CommonJS. Electron's ESM loader does not
// expose its lazy autoUpdater getter as a reliable named export.
const { autoUpdater } = electronUpdater

const updateCheckIntervalMs = 6 * 60 * 60 * 1_000

/** Starts signed GitHub-release updates only in packaged builds. */
export function startAutoUpdateService(
  onError: (error: Error) => void,
  enabled = app.isPackaged
): () => void {
  if (!enabled) return () => undefined
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('error', onError)
  const check = (): void => {
    void autoUpdater.checkForUpdatesAndNotify().catch((error: unknown) => {
      onError(error instanceof Error ? error : new Error('自动更新检查失败。'))
    })
  }
  const initial = setTimeout(check, 15_000)
  initial.unref?.()
  const interval = setInterval(check, updateCheckIntervalMs)
  interval.unref?.()
  return () => {
    clearTimeout(initial)
    clearInterval(interval)
    autoUpdater.removeListener('error', onError)
  }
}
