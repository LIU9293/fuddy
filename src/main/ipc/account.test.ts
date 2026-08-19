import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountState } from '../../shared/account'
import type { IpcContext } from './context'

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  windows: [] as Array<{ webContents: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> } }>
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(),
    getAllWindows: () => electronMocks.windows
  },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      electronMocks.handlers.set(channel, handler)
    })
  },
  shell: { openExternal: vi.fn() }
}))

import { registerAccountIpc } from './account'

const signedInState: AccountState = {
  status: 'signed-in',
  serviceStatus: 'ready',
  serviceMessage: null,
  user: { id: 'user-1', email: 'kai@example.com', displayName: 'Kai' },
  device: {
    id: 'mac-1',
    platform: 'macos',
    name: 'Test Mac',
    hostId: 'host-1',
    syncSpaceId: 'space-1'
  },
  onboarding: { step: 'complete', completedAt: '2026-08-19T00:00:00.000Z' },
  availableProviders: { email: true, google: true },
  existingProjectCount: 1
}

const signedOutState: AccountState = {
  ...signedInState,
  status: 'signed-out',
  serviceMessage: '登录状态已失效，请重新登录。',
  user: null,
  device: null,
  onboarding: null
}

describe('account IPC lifecycle', () => {
  beforeEach(() => {
    electronMocks.handlers.clear()
    electronMocks.windows.length = 0
  })

  it('stops and forgets Companion when account validation signs out', async () => {
    let finishDrain: (() => void) | undefined
    const pauseAndDrain = vi.fn(() => new Promise<void>((resolve) => { finishDrain = resolve }))
    const coordinator = { stop: vi.fn(), pauseAndDrain }
    let finishDisconnect: (() => void) | undefined
    const disconnect = vi.fn(() => new Promise<void>((resolve) => { finishDisconnect = resolve }))
    const companionSync = { stop: vi.fn(), disconnect }
    const send = vi.fn()
    electronMocks.windows.push({ webContents: { isDestroyed: () => false, send } })

    registerAccountIpc({
      accountService: {
        getState: vi.fn(() => signedInState),
        getValidatedState: vi.fn(async () => signedOutState)
      },
      accountEnrollmentCoordinator: coordinator,
      companionSync
    } as unknown as IpcContext)

    const getState = electronMocks.handlers.get('account:get-state')
    expect(getState?.()).toEqual(signedInState)

    await vi.waitFor(() => {
      expect(coordinator.stop).toHaveBeenCalledOnce()
      expect(companionSync.stop).toHaveBeenCalledOnce()
      expect(send).toHaveBeenCalledWith('account:state-changed', signedOutState)
    })
    expect(companionSync.disconnect).not.toHaveBeenCalled()

    finishDrain?.()
    await vi.waitFor(() => expect(companionSync.disconnect).toHaveBeenCalledOnce())
    finishDisconnect?.()
    await vi.waitFor(() => {
      expect(pauseAndDrain).toHaveBeenCalledOnce()
      expect(disconnect).toHaveBeenCalledOnce()
    })
  })
})
