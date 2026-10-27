import { BrowserWindow, clipboard, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createProjectSchema } from '../../shared/project-validation'
import { getCapabilities } from '../services/capabilities'
import { AccountAuthorizationLostError } from '../services/account-service'
import { ProjectSharingKeyStore } from '../services/project-sharing-key-store'
import { ProjectSharingTransport } from '../services/project-sharing-transport'
import { openSharedProjectCommand, sealSharedProjectCommand, sharedProjectCommandPayloadSchema,
  type SharedProjectMemberActivity } from '../../shared/project-sharing-commands'
import { sharedAttachmentSchema } from '../../shared/project-sharing-attachments'
import type { IpcContext } from './context'

export function registerAccountIpc(context: IpcContext): void {
  const { accountService, accountEnrollmentCoordinator, companionSync, database, providerSettings } = context
  const projectKeys = new ProjectSharingKeyStore(accountService, context.credentialVault)
  const projectSharing = new ProjectSharingTransport(database, accountService, projectKeys,
    context.workspaceFiles)
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
    } else {
      // A settings view can request state after a background task already signed out.
      // Also update the root renderer, which otherwise keeps its cached signed-in state.
      broadcastAccountState(local)
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

  ipcMain.handle('account:sign-in-google', async (event) => {
    const state = await accountService.signInWithGoogle(
      (url) => shell.openExternal(url, { activate: true }),
      (url) => {
        if (!event.sender.isDestroyed()) event.sender.send('account:google-authorization-url', url)
      }
    )
    if (state.user) await companionSync.activateAccountRelay(
      state.user.id,
      state.device?.syncSpaceId ?? undefined
    )
    accountEnrollmentCoordinator.start()
    return state
  })

  ipcMain.handle('account:copy-google-authorization-url', (_event, rawInput: unknown) => {
    const input = z.object({
      url: z.url().max(4_096).refine((value) => {
        const parsed = new URL(value)
        return parsed.origin === 'https://accounts.google.com'
          && parsed.pathname === '/o/oauth2/v2/auth'
      }, 'Google 登录链接无效。')
    }).parse(rawInput)
    clipboard.writeText(input.url)
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

  ipcMain.handle('account:project-sharing-overview', (_event, rawProjectId: unknown) => {
    const projectId = z.string().uuid().parse(rawProjectId)
    const localProject = database.listProjects().find((project) =>
      project.id === projectId || project.shared?.id === projectId)
    if (!localProject) throw new Error('本机没有这个项目。')
    return runAuthorizedAccountOperation(async () => {
      const share = (await accountService.listProjectShares()).find((item) =>
        item.role === 'owner' && item.localProjectId === localProject.shared?.id)
      if (!share) return { share: null, members: [], invitations: [] }
      const [members, invitations] = await Promise.all([
        accountService.listProjectMembers(share.projectId),
        accountService.listProjectInvitations(share.projectId)
      ])
      return { share, members, invitations }
    })
  })

  ipcMain.handle('account:activate-project-sharing', (_event, rawProjectId: unknown) => {
    const localProjectId = z.string().uuid().parse(rawProjectId)
    const project = database.listProjects().find((item) => item.id === localProjectId)
    if (!project?.shared?.id) throw new Error('本机项目尚未建立同步身份。')
    const hostId = accountService.getState().device?.hostId
    if (!hostId) throw new Error('请在已登录的 Mac 上开启项目共享。')
    return runAuthorizedAccountOperation(async () => {
      const share = await accountService.registerProjectShare(project.shared!.id, hostId)
      await projectSharing.publishBaseline(share.projectId)
      return share
    })
  })

  ipcMain.handle('account:sync-project-sharing', (_event, rawShareId: unknown) => {
    const shareId = z.string().uuid().parse(rawShareId)
    return runAuthorizedAccountOperation(() => projectSharing.publishBaseline(shareId))
  })

  ipcMain.handle('account:set-project-sharing-host', (_event, rawInput: unknown) => {
    const input = z.object({ projectId: z.uuid(), executionHostId: z.uuid() }).strict().parse(rawInput)
    return runAuthorizedAccountOperation(async () => {
      const share = await accountService.getProjectShare(input.projectId)
      if (share.role !== 'owner' || !share.localProjectId) throw new Error('需要项目所有者权限。')
      const local = database.listProjects().find((item) => item.shared?.id === share.localProjectId)
      if (!local) throw new Error('本机没有这个项目。')
      const hosts = context.macPeers?.listHosts(local.id) ?? []
      if (!hosts.some((host) => host.id === input.executionHostId
        && host.online && host.workspaceConfigured)) {
        throw new Error('请选择在线且已配置项目主文件夹的执行 Mac。')
      }
      return accountService.setProjectExecutionHost(input.projectId, input.executionHostId)
    })
  })

  ipcMain.handle('account:invite-project-member', (_event, rawInput: unknown) => {
    const input = z.object({ projectId: z.uuid(), email: z.email().max(254) }).strict().parse(rawInput)
    return runAuthorizedAccountOperation(async () => {
      const share = await accountService.getProjectShare(input.projectId)
      if (share.role !== 'owner' || !share.localProjectId
        || !database.listProjects().some((item) => item.shared?.id === share.localProjectId)) {
        throw new Error('本机没有这个所有者项目。')
      }
      if ((await accountService.listProjectBaselines(input.projectId)).length === 0) {
        throw new Error('请先完成共享历史同步。')
      }
      return accountService.createProjectInvitation(input.projectId, input.email)
    })
  })

  ipcMain.handle('account:accept-project-invitation', (_event, rawToken: unknown) => {
    const token = z.string().regex(/^fuddy_invite_[A-Za-z0-9_-]{43}$/u).parse(rawToken)
    return runAuthorizedAccountOperation(async () => {
      const projectId = await accountService.acceptProjectInvitation(token)
      const state = accountService.setOnboardingStep('complete')
      broadcastAccountState(state)
      await accountService.requestProjectDeviceGrant(projectId).catch(() => undefined)
      return projectId
    })
  })

  ipcMain.handle('account:list-shared-projects', () => {
    return runAuthorizedAccountOperation(async () =>
      (await accountService.listProjectShares()).filter((share) => share.role === 'member'))
  })

  ipcMain.handle('account:read-shared-project', (_event, rawShareId: unknown) => {
    const shareId = z.string().uuid().parse(rawShareId)
    return runAuthorizedAccountOperation(async () => {
      const share = await accountService.getProjectShare(shareId)
      if (share.role !== 'member') throw new Error('请选择与我共享的项目。')
      return projectSharing.readProject(shareId)
    })
  })

  ipcMain.handle('account:request-project-device-grant', (_event, rawShareId: unknown) => {
    const shareId = z.string().uuid().parse(rawShareId)
    return runAuthorizedAccountOperation(() => accountService.requestProjectDeviceGrant(shareId))
  })

  ipcMain.handle('account:authorize-project-devices', (_event, rawShareId: unknown) => {
    const shareId = z.string().uuid().parse(rawShareId)
    return runAuthorizedAccountOperation(async () => {
      const share = await accountService.getProjectShare(shareId)
      return projectKeys.authorizePendingDevices(share)
    })
  })

  ipcMain.handle('account:remove-project-member', (_event, rawInput: unknown) => {
    const input = z.object({ projectId: z.uuid(), userId: z.uuid() }).strict().parse(rawInput)
    return runAuthorizedAccountOperation(() => accountService.removeProjectMember(input.projectId, input.userId))
  })

  ipcMain.handle('account:revoke-project-invitation', (_event, rawInput: unknown) => {
    const input = z.object({ projectId: z.uuid(), invitationId: z.uuid() }).strict().parse(rawInput)
    return runAuthorizedAccountOperation(() => accountService.revokeProjectInvitation(input.projectId, input.invitationId))
  })

  ipcMain.handle('account:close-project-sharing', (_event, rawProjectId: unknown) => {
    const projectId = z.uuid().parse(rawProjectId)
    return runAuthorizedAccountOperation(async () => {
      const share = await accountService.getProjectShare(projectId)
      if (share.role !== 'owner' || !share.localProjectId
        || !database.listProjects().some((item) => item.shared?.id === share.localProjectId)) {
        throw new Error('本机没有这个所有者项目。')
      }
      await accountService.closeProjectShare(projectId)
      projectKeys.forgetProject(projectId)
    })
  })

  ipcMain.handle('account:submit-shared-project-command', (_event, rawInput: unknown) => {
    const input = z.object({
      projectId: z.uuid(), runId: z.uuid().nullable(), requestId: z.uuid().nullable(),
      payload: sharedProjectCommandPayloadSchema
    }).strict().parse(rawInput)
    return runAuthorizedAccountOperation(async () => {
      const share = await accountService.getProjectShare(input.projectId)
      if (share.role !== 'member') throw new Error('请选择与我共享的项目。')
      const actorUserId = accountService.getState().user?.id
      if (!actorUserId) throw new Error('请先登录。')
      const key = await projectKeys.getReadable(share)
      const submission = await sealSharedProjectCommand(key, {
        projectId: input.projectId, commandId: randomUUID(), type: input.payload.type,
        runId: input.runId, requestId: input.requestId,
        keyEpoch: share.keyEpoch, actorUserId
      }, input.payload)
      return accountService.submitProjectCommand(input.projectId, submission)
    })
  })

  ipcMain.handle('account:upload-shared-project-attachments', (_event, rawInput: unknown) => {
    const input = z.object({
      projectId: z.uuid(), runId: z.uuid(), requestId: z.uuid(),
      attachments: z.array(z.object({
        id: z.uuid(), name: z.string().min(1).max(255), mimeType: z.string().min(1).max(128),
        dataUrl: z.string().max(28_000_000)
      }).strict()).max(4)
    }).strict().parse(rawInput)
    return runAuthorizedAccountOperation(async () => {
      const share = await accountService.getProjectShare(input.projectId)
      if (share.role !== 'member') throw new Error('请选择与我共享的项目。')
      return projectSharing.uploadInputs(input.projectId, input.runId,
        input.requestId, input.attachments)
    })
  })

  ipcMain.handle('account:download-shared-project-attachment', (_event, rawInput: unknown) => {
    const input = z.object({ projectId: z.uuid(), descriptor: sharedAttachmentSchema }).strict()
      .parse(rawInput)
    return runAuthorizedAccountOperation(() =>
      projectSharing.downloadForDisplay(input.projectId, input.descriptor))
  })

  ipcMain.handle('account:get-shared-project-command', (_event, rawInput: unknown) => {
    const input = z.object({ projectId: z.uuid(), commandId: z.uuid() }).strict().parse(rawInput)
    return runAuthorizedAccountOperation(() =>
      accountService.getProjectCommand(input.projectId, input.commandId))
  })

  ipcMain.handle('account:list-shared-project-activity', (_event, rawProjectId: unknown) => {
    const projectId = z.uuid().parse(rawProjectId)
    return runAuthorizedAccountOperation(async (): Promise<SharedProjectMemberActivity> => {
      const share = await accountService.getProjectShare(projectId)
      if (share.role !== 'member') throw new Error('请选择与我共享的项目。')
      const commands = await accountService.listOwnProjectCommands(projectId)
      const activity: SharedProjectMemberActivity = { drafts: [], activeTurns: [] }
      for (const command of commands) {
        if (command.type === 'create-chat' && command.status === 'completed' && command.resultRunId) {
          let title = '旧版本草稿'
          const key = projectKeys.getCached(projectId, command.keyEpoch)
            ?? (command.keyEpoch === share.keyEpoch ? await projectKeys.getReadable(share) : null)
          if (key) {
            const payload = await openSharedProjectCommand(key, command)
            if (payload.type === 'create-chat') title = payload.title
          }
          activity.drafts.push({ runId: command.resultRunId, title })
        }
        if (command.type === 'send-message' && command.keyEpoch === share.keyEpoch
          && ['pending', 'claimed'].includes(command.status)
          && command.runId && command.requestId) {
          activity.activeTurns.push({ commandId: command.commandId,
            runId: command.runId, requestId: command.requestId })
        }
      }
      return activity
    })
  })

  ipcMain.handle('account:leave-shared-project', (_event, rawProjectId: unknown) => {
    const projectId = z.uuid().parse(rawProjectId)
    return runAuthorizedAccountOperation(async () => {
      const share = await accountService.getProjectShare(projectId)
      if (share.role !== 'member') throw new Error('项目所有者不能退出自己的共享。')
      const userId = accountService.getState().user?.id
      if (!userId) throw new Error('请先登录。')
      await accountService.removeProjectMember(projectId, userId)
      projectKeys.forgetProject(projectId)
    })
  })

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
        .filter((capability) => ['codex', 'claude', 'opencode'].includes(capability.id) && capability.status === 'ready')
        .map((capability) => capability.id)
    }
  })

  ipcMain.handle('onboarding:complete-agent-detection', () => accountService.setOnboardingStep('add-project'))

  ipcMain.handle('project:select-folder', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options: OpenDialogOptions = {
      title: '选择项目文件夹',
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
