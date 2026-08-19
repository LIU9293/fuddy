import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountState } from '../../shared/account'
import { AccountAuthorizationLostError } from '../services/account-service'
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

  it('stops and forgets Companion when account validation reports explicit authorization loss', async () => {
    let accountState = signedInState
    const authorizationError = new AccountAuthorizationLostError()
    let finishDrain: (() => void) | undefined
    const pauseAndDrain = vi.fn(() => new Promise<void>((resolve) => { finishDrain = resolve }))
    const coordinator = { stop: vi.fn(), pauseAndDrain }
    let finishDisconnect: (() => void) | undefined
    const disconnectAllAccountRelays = vi.fn(() => new Promise<void>((resolve) => { finishDisconnect = resolve }))
    const companionSync = { stop: vi.fn(), disconnectAllAccountRelays }
    const send = vi.fn()
    electronMocks.windows.push({ webContents: { isDestroyed: () => false, send } })

    registerAccountIpc({
      accountService: {
        getState: vi.fn(() => accountState),
        getValidatedState: vi.fn(async () => {
          accountState = signedOutState
          throw authorizationError
        })
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
    expect(companionSync.disconnectAllAccountRelays).not.toHaveBeenCalled()

    finishDrain?.()
    await vi.waitFor(() => expect(companionSync.disconnectAllAccountRelays).toHaveBeenCalledOnce())
    finishDisconnect?.()
    await vi.waitFor(() => {
      expect(pauseAndDrain).toHaveBeenCalledOnce()
      expect(disconnectAllAccountRelays).toHaveBeenCalledOnce()
    })
  })

  it('does not revoke Relay when background validation observes an overlapping normal logout', async () => {
    const coordinator = { stop: vi.fn(), pauseAndDrain: vi.fn(async () => undefined) }
    const companionSync = {
      stop: vi.fn(),
      disconnectAllAccountRelays: vi.fn(async () => undefined)
    }
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
      expect(send).toHaveBeenCalledWith('account:state-changed', signedOutState)
    })
    expect(coordinator.stop).not.toHaveBeenCalled()
    expect(companionSync.stop).not.toHaveBeenCalled()
    expect(companionSync.disconnectAllAccountRelays).not.toHaveBeenCalled()
  })

  it('reconciles a signed-out transition from an authorized account request', async () => {
    let accountState = signedInState
    const authorizationError = new AccountAuthorizationLostError()
    const coordinator = {
      stop: vi.fn(),
      pauseAndDrain: vi.fn(async () => undefined)
    }
    const companionSync = {
      stop: vi.fn(),
      disconnectAllAccountRelays: vi.fn(async () => undefined)
    }
    const send = vi.fn()
    electronMocks.windows.push({ webContents: { isDestroyed: () => false, send } })

    registerAccountIpc({
      accountService: {
        getState: vi.fn(() => accountState),
        listDevices: vi.fn(async () => {
          accountState = signedOutState
          throw authorizationError
        })
      },
      accountEnrollmentCoordinator: coordinator,
      companionSync
    } as unknown as IpcContext)

    const listDevices = electronMocks.handlers.get('account:list-devices')
    await expect(Promise.resolve(listDevices?.())).rejects.toBe(authorizationError)

    expect(coordinator.stop).toHaveBeenCalledOnce()
    expect(companionSync.stop).toHaveBeenCalledOnce()
    expect(companionSync.disconnectAllAccountRelays).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith('account:state-changed', signedOutState)
  })

  it('does not revoke Relay for a request invalidated by an overlapping normal logout', async () => {
    let accountState = signedInState
    const sessionChangedError = new Error('账户已切换，请重试。')
    const coordinator = {
      stop: vi.fn(),
      pauseAndDrain: vi.fn(async () => undefined)
    }
    const companionSync = {
      stop: vi.fn(),
      disconnectAllAccountRelays: vi.fn(async () => undefined)
    }

    registerAccountIpc({
      accountService: {
        getState: vi.fn(() => accountState),
        listDevices: vi.fn(async () => {
          accountState = signedOutState
          throw sessionChangedError
        })
      },
      accountEnrollmentCoordinator: coordinator,
      companionSync
    } as unknown as IpcContext)

    const listDevices = electronMocks.handlers.get('account:list-devices')
    await expect(Promise.resolve(listDevices?.())).rejects.toBe(sessionChangedError)

    expect(coordinator.stop).not.toHaveBeenCalled()
    expect(companionSync.stop).not.toHaveBeenCalled()
    expect(companionSync.disconnectAllAccountRelays).not.toHaveBeenCalled()
  })

  it('drains phone commands before logout-all forgets Relay credentials', async () => {
    let finishDrain: (() => void) | undefined
    let accountState = signedInState
    const stopAndDrain = vi.fn(() => new Promise<void>((resolve) => { finishDrain = resolve }))
    const forgetAccountRelays = vi.fn()
    const logoutAll = vi.fn(async () => {
      accountState = signedOutState
      return signedOutState
    })
    const coordinator = { pauseAndDrain: vi.fn(async () => undefined) }
    const send = vi.fn()
    electronMocks.windows.push({ webContents: { isDestroyed: () => false, send } })

    registerAccountIpc({
      accountService: {
        getState: vi.fn(() => accountState),
        logoutAll
      },
      accountEnrollmentCoordinator: coordinator,
      companionSync: { stopAndDrain, forgetAccountRelays }
    } as unknown as IpcContext)

    const logoutAllHandler = electronMocks.handlers.get('account:logout-all')
    const loggingOut = Promise.resolve(logoutAllHandler?.())
    await vi.waitFor(() => expect(stopAndDrain).toHaveBeenCalledOnce())
    expect(logoutAll).not.toHaveBeenCalled()
    expect(forgetAccountRelays).not.toHaveBeenCalled()

    finishDrain?.()
    await loggingOut
    expect(logoutAll).toHaveBeenCalledOnce()
    expect(forgetAccountRelays).toHaveBeenCalledWith('user-1')
    expect(send).toHaveBeenCalledWith('account:state-changed', signedOutState)
  })

  it('forgets Relay credentials after the Account API revokes the current Mac', async () => {
    const deviceId = crypto.randomUUID()
    const state = { ...signedInState, device: { ...signedInState.device!, id: deviceId } }
    const forgetAccountRelays = vi.fn()
    registerAccountIpc({
      accountService: {
        getState: vi.fn(() => state),
        revokeDevice: vi.fn(async () => undefined)
      },
      accountEnrollmentCoordinator: { pauseAndDrain: vi.fn(async () => undefined) },
      companionSync: {
        stopAndDrain: vi.fn(async () => undefined),
        forgetAccountRelays
      }
    } as unknown as IpcContext)

    const revokeDevice = electronMocks.handlers.get('account:revoke-device')
    await expect(Promise.resolve(revokeDevice?.({}, { deviceId }))).resolves.toBeUndefined()

    expect(forgetAccountRelays).toHaveBeenCalledWith('user-1')
  })

  it('revokes the account Relay after a normal logout', async () => {
    const disconnectAllAccountRelays = vi.fn(async () => undefined)
    const logout = vi.fn(async () => signedOutState)
    registerAccountIpc({
      accountService: { getState: vi.fn(() => signedInState), logout },
      accountEnrollmentCoordinator: { pauseAndDrain: vi.fn(async () => undefined) },
      companionSync: { stopAndDrain: vi.fn(async () => undefined), disconnectAllAccountRelays }
    } as unknown as IpcContext)

    const logoutHandler = electronMocks.handlers.get('account:logout')
    await expect(Promise.resolve(logoutHandler?.())).resolves.toEqual(signedOutState)

    expect(logout).toHaveBeenCalledOnce()
    expect(disconnectAllAccountRelays).toHaveBeenCalledOnce()
  })
})
