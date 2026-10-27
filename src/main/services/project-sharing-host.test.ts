import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountProjectShare, AccountState } from '../../shared/account'
import { sealSharedProjectCommand, type SharedProjectCommand } from '../../shared/project-sharing-commands'
import { generateSharedProjectKey } from '../../shared/project-sharing-events'
import { createTestDatabase } from '../test-support/project-fixtures'
import type { AccountService } from './account-service'
import type { ProjectSharingKeyStore } from './project-sharing-key-store'
import type { ProjectSharingTransport } from './project-sharing-transport'
import { ProjectSharingHost } from './project-sharing-host'
import type { TaskDispatcher } from './task-dispatcher'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('shared project execution host', () => {
  it('creates a member draft with the selected Agent and server-derived author snapshot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fuddy-shared-host-'))
    directories.push(root)
    const database = createTestDatabase(join(root, 'app.sqlite'))
    const project = database.listProjects().find((item) => item.id === 'vows')!
    const share: AccountProjectShare = { projectId: crypto.randomUUID(),
      localProjectId: project.shared!.id, role: 'owner', executionHostId: 'host-id', keyAuthorityHostId: 'host-id',
      permissionRevision: 1, keyEpoch: 1 }
    const actorUserId = crypto.randomUUID()
    const identity = { projectId: share.projectId, commandId: crypto.randomUUID(),
      type: 'create-chat' as const, runId: null, requestId: null, keyEpoch: 1, actorUserId }
    const key = generateSharedProjectKey()
    const sealed = await sealSharedProjectCommand(key, identity,
      { type: 'create-chat', title: '成员新 Chat', provider: 'codex' })
    const command: SharedProjectCommand = { ...identity, ...sealed,
      authorSnapshot: { displayName: '共享成员', avatarRef: null },
      sourceDeviceId: crypto.randomUUID(), targetHostId: 'host-id',
      permissionRevision: 1, status: 'pending', leaseExpiresAt: null,
      resultRunId: null, errorCode: null, createdAt: '', updatedAt: '' }
    const completeProjectCommand = vi.fn(async () => undefined)
    const account = {
      getState: () => ({ status: 'signed-in', user: { id: crypto.randomUUID() },
        device: { id: 'device-id', platform: 'macos', hostId: 'host-id' } }) as AccountState,
      listProjectShares: async () => [share],
      listProjectBaselines: async () => [{ sourceDeviceId: 'device-id' }],
      listHostProjectCommands: async () => [command],
      claimProjectCommand: async () => ({ ...command, status: 'claimed' }),
      renewProjectCommand: async () => '2099-01-01T00:00:00.000Z',
      completeProjectCommand
    } as unknown as AccountService
    const keys = { getReadable: async () => key,
      authorizePendingDevices: async () => 0 } as unknown as ProjectSharingKeyStore
    const transport = { publishIncremental: async () => 0 } as unknown as ProjectSharingTransport
    const createDraft = vi.fn(() => ({ run: { id: identity.commandId } }))
    const dispatcher = { createDraft } as unknown as TaskDispatcher
    const host = new ProjectSharingHost(database, account, keys, transport, dispatcher)
    await host.processOnce()
    expect(createDraft).toHaveBeenCalledWith({
      id: identity.commandId, projectId: project.id, title: '成员新 Chat', provider: 'codex'
    }, { userId: actorUserId, snapshot: command.authorSnapshot })
    expect(completeProjectCommand).toHaveBeenCalledWith(share.projectId, identity.commandId, {
      status: 'completed', resultRunId: identity.commandId, errorCode: null
    })
    database.close()
  })
})
