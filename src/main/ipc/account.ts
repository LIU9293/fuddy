import { BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import { z } from 'zod'
import { createProjectSchema } from '../../shared/project-validation'
import { getCapabilities } from '../services/capabilities'
import { AccountAuthorizationLostError } from '../services/account-service'
import type { IpcContext } from './context'

export function registerAccountIpc(context: IpcContext): void {
  const { accountService, accountEnrollmentCoordinator, companionSync, database, providerSettings } = context
  const broadcastAccountState = (state = accountService.getState()): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) window.webContents.send('account:state-changed', state)
    }
  }

  const reconcileAccountAuthorizationLoss = async (): Promise<void> => {
    const state = accountService.getState()
    if (state.status !== 'signed-out') {
      broadcastAccountState(state)
      return
    }

    // Validation can revoke the local account after Companion has already
    // started during bootstrap. Stop both producers immediately, publish the
    // signed-out state, then remove the now-unauthorized Relay identity only
    // after in-flight work has settled and remote access is revoked. A failed
    // revoke preserves the local credentials so a later sign-in can retry.
    accountEnrollmentCoordinator.stop()
    companionSync.stop()
    broadcastAccountState(state)
    await accountEnrollmentCoordinator.pauseAndDrain()
    await companionSync.disconnectAllAccountRelays()
  }

  const runAuthorizedAccountOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof AccountAuthorizationLostError) {
        await reconcileAccountAuthorizationLoss().catch(() => undefined)
      }
      throw error
    }
  }

  ipcMain.handle('account:get-state', () => {
    const local = accountService.getState()
    if (local.status === 'signed-in') {
      void accountService.getValidatedState()
        .then((state) => broadcastAccountState(state))
        .catch((error) => {
          if (error instanceof AccountAuthorizationLostError) {
            void reconcileAccountAuthorizationLoss().catch(() => undefined)
          }
        })
    }
    return local
  })

  ipcMain.handle('account:start-email-sign-in', (_event, rawInput: unknown) => {
    const input = z.object({ email: z.email().max(254) }).parse(rawInput)
    return accountService.startEmailSignIn(input.email)
  })

  ipcMain.handle('account:verify-email-sign-in', async (_event, rawInput: unknown) => {
    const input = z.object({
      challengeId: z.string().uuid(),
      code: z.string().regex(/^\d{6}$/u)
    }).parse(rawInput)
    const state = await accountService.verifyEmailSignIn(input.challengeId, input.code)
    if (state.user) await companionSync.activateAccountRelay(
      state.user.id,
      state.device?.syncSpaceId ?? undefined
    )
    accountEnrollmentCoordinator.start()
    return state
  })

  ipcMain.handle('account:sign-in-google', async () => {
    const state = await accountService.signInWithGoogle((url) => shell.openExternal(url))
    if (state.user) await companionSync.activateAccountRelay(
      state.user.id,
      state.device?.syncSpaceId ?? undefined
    )
    accountEnrollmentCoordinator.start()
    return state
  })

  ipcMain.handle('account:list-identities', () => (
    runAuthorizedAccountOperation(() => accountService.listIdentities())
  ))

  ipcMain.handle('account:link-google', () => (
    runAuthorizedAccountOperation(() => accountService.linkGoogle((url) => shell.openExternal(url)))
  ))

  ipcMain.handle('account:unlink-google', () => (
    runAuthorizedAccountOperation(() => accountService.unlinkGoogle())
  ))

  ipcMain.handle('account:list-devices', () => (
    runAuthorizedAccountOperation(() => accountService.listDevices())
  ))

  ipcMain.handle('account:revoke-device', async (_event, rawInput: unknown) => {
    const input = z.object({ deviceId: z.string().uuid() }).parse(rawInput)
    const currentState = accountService.getState()
    const isCurrentDevice = currentState.device?.id === input.deviceId
    const ownerUserId = currentState.user?.id
    if (isCurrentDevice) {
      await accountEnrollmentCoordinator.pauseAndDrain()
      await companionSync.stopAndDrain()
    }
    try {
      await accountService.revokeDevice(input.deviceId)
    } catch (error) {
      if (error instanceof AccountAuthorizationLostError) {
        await reconcileAccountAuthorizationLoss().catch(() => undefined)
      } else if (isCurrentDevice) {
        await companionSync.start().catch(() => undefined)
        accountEnrollmentCoordinator.start()
      }
      throw error
    }
    if (!isCurrentDevice) return
    if (ownerUserId) companionSync.forgetAccountRelays(ownerUserId)
    broadcastAccountState()
  })

  ipcMain.handle('account:logout', async () => {
    await accountEnrollmentCoordinator.pauseAndDrain()
    await companionSync.stopAndDrain()
    const state = await accountService.logout()
    broadcastAccountState()
    await companionSync.disconnectAllAccountRelays().catch(() => undefined)
    return state
  })

  ipcMain.handle('account:logout-all', async () => {
    const ownerUserId = accountService.getState().user?.id
    await accountEnrollmentCoordinator.pauseAndDrain()
    await companionSync.stopAndDrain()
    let state: Awaited<ReturnType<typeof accountService.logoutAll>>
    try {
      state = await accountService.logoutAll()
    } catch (error) {
      if (error instanceof AccountAuthorizationLostError) {
        await reconcileAccountAuthorizationLoss().catch(() => undefined)
      } else if (accountService.getState().status === 'signed-in') {
        await companionSync.start().catch(() => undefined)
        accountEnrollmentCoordinator.start()
      }
      throw error
    }
    if (ownerUserId) companionSync.forgetAccountRelays(ownerUserId)
    broadcastAccountState()
    return state
  })

  ipcMain.handle('onboarding:detect-coding-agents', () => {
    const capabilities = getCapabilities(providerSettings.getPublicSettings())
    return {
      capabilities,
      readyAgentIds: capabilities
        .filter((capability) => ['pi', 'codex', 'claude', 'opencode'].includes(capability.id) && capability.status === 'ready')
        .map((capability) => capability.id)
    }
  })

  ipcMain.handle('onboarding:complete-agent-detection', () => accountService.setOnboardingStep('add-project'))

  ipcMain.handle('onboarding:select-project-folder', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options: OpenDialogOptions = {
      title: '选择第一个项目文件夹',
      buttonLabel: '选择文件夹',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  ipcMain.handle('onboarding:complete-project', (_event, rawInput: unknown) => {
    const input = z.object({ project: createProjectSchema.nullable() }).parse(rawInput)
    const project = input.project ? database.createProject(input.project) : null
    void accountEnrollmentCoordinator.processOnce().catch(() => undefined)
    const account = accountService.setOnboardingStep('complete')
    return { account, project }
  })
}
