import { describe, expect, it, vi } from 'vitest'
import type { AccountProjectShare, AccountState } from '../../shared/account'
import { ProjectSharingKeyStore } from './project-sharing-key-store'
import type { AccountService } from './account-service'

const share: AccountProjectShare = {
  projectId: crypto.randomUUID(), localProjectId: crypto.randomUUID(), role: 'owner',
  executionHostId: 'new-host', keyAuthorityHostId: 'old-host',
  permissionRevision: 2, keyEpoch: 1
}

describe('project sharing key authority', () => {
  it('does not generate a second key when the execution Mac changes mid-epoch', async () => {
    const values = new Map<string, string>()
    const vault = {
      get: (reference: string) => values.get(reference) ?? null,
      set: (reference: string, value: string) => { values.set(reference, value) },
      deleteByPrefix: (prefix: string) => {
        for (const reference of values.keys()) if (reference.startsWith(prefix)) values.delete(reference)
      }
    }
    let hostId = 'old-host'
    const requestGrant = vi.fn(async () => ({ status: 'pending', keyEpoch: 1 }))
    const account = {
      getState: () => ({ user: { id: 'owner' }, device: { hostId } }) as AccountState,
      listProjectBaselines: async () => [],
      listProjectEvents: async () => ({ events: [] }),
      requestProjectDeviceGrant: requestGrant
    } as unknown as AccountService
    const oldHost = new ProjectSharingKeyStore(account, vault as never)
    const firstKey = await oldHost.getReadable(share)
    expect(firstKey).toHaveLength(43)
    expect(requestGrant).not.toHaveBeenCalled()

    hostId = 'new-host'
    const newHost = new ProjectSharingKeyStore(account, {
      get: () => null, set: () => undefined, deleteByPrefix: () => undefined
    } as never)
    await expect(newHost.getReadable(share)).rejects.toThrow('等待项目密钥授权')
    expect(requestGrant).toHaveBeenCalledWith(share.projectId)

    const nextEpoch = { ...share, keyEpoch: 2, keyAuthorityHostId: 'new-host' }
    expect(await newHost.getReadable(nextEpoch)).toHaveLength(43)
    vault.set(`project-sharing.key:owner:${share.projectId}:2`, 'second-key')
    vault.set('project-sharing.key:owner:another-project:1', 'keep')
    oldHost.forgetProject(share.projectId)
    expect(vault.get(`project-sharing.key:owner:${share.projectId}:1`)).toBeNull()
    expect(vault.get(`project-sharing.key:owner:${share.projectId}:2`)).toBeNull()
    expect(vault.get('project-sharing.key:owner:another-project:1')).toBe('keep')
  })
})
