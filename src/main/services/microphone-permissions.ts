import type { MicrophoneAccessResult, MicrophoneAccessStatus } from '../../shared/contracts'

interface MicrophonePermissionAdapter {
  platform: NodeJS.Platform
  getStatus: () => MicrophoneAccessStatus
  askForAccess: () => Promise<boolean>
}

export async function requestMacMicrophoneAccess(
  adapter: MicrophonePermissionAdapter
): Promise<MicrophoneAccessResult> {
  if (adapter.platform !== 'darwin') return { granted: true, status: 'granted' }

  const current = adapter.getStatus()
  if (current === 'granted') return { granted: true, status: current }
  if (current !== 'not-determined') return { granted: false, status: current }

  const granted = await adapter.askForAccess()
  if (granted) return { granted: true, status: 'granted' }

  const resolved = adapter.getStatus()
  return {
    granted: false,
    status: resolved === 'not-determined' ? 'denied' : resolved
  }
}
