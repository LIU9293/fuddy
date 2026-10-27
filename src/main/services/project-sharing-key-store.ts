import type { AccountProjectShare } from '../../shared/account'
import { generateSharedProjectKey } from '../../shared/project-sharing-events'
import type { CredentialVault } from './credential-vault'
import type { AccountService } from './account-service'

const projectKeyPattern = /^[A-Za-z0-9_-]{43}$/u

/** Project keys are account-scoped vault entries, never SQLite settings. */
export class ProjectSharingKeyStore {
  constructor(
    private readonly account: AccountService,
    private readonly vault: Pick<CredentialVault, 'get' | 'set' | 'deleteByPrefix'>
  ) {}

  private reference(projectId: string, keyEpoch: number): string {
    const userId = this.account.getState().user?.id
    if (!userId) throw new Error('请先登录 Fuddy 账户。')
    return `project-sharing.key:${userId}:${projectId}:${keyEpoch}`
  }

  getCached(projectId: string, keyEpoch: number): string | null {
    const key = this.vault.get(this.reference(projectId, keyEpoch))
    if (key && !projectKeyPattern.test(key)) throw new Error('本机项目密钥损坏。')
    return key
  }

  async getReadable(share: AccountProjectShare): Promise<string> {
    const cached = this.getCached(share.projectId, share.keyEpoch)
    if (cached) return cached
    if (share.role === 'owner' && this.account.getState().device?.hostId === share.keyAuthorityHostId) {
      // Only the host assigned to this epoch may create its key. Changing
      // the execution host does not transfer key authority mid-epoch.
      const [baselines, events] = await Promise.all([
        this.account.listProjectBaselines(share.projectId),
        this.account.listProjectEvents(share.projectId, 0, 1)
      ])
      if (baselines.length === 0 && events.events.length === 0) {
        const generated = generateSharedProjectKey()
        this.vault.set(this.reference(share.projectId, share.keyEpoch), generated)
        return generated
      }
    }
    const grant = await this.account.requestProjectDeviceGrant(share.projectId)
    if (grant.status !== 'active' || !grant.wrappedProjectKey) {
      throw new Error('当前设备正在等待项目密钥授权。')
    }
    if (grant.keyEpoch !== share.keyEpoch) throw new Error('项目密钥版本已变化，请重新申请授权。')
    const key = await this.account.openOwnProjectGrant(share.projectId)
    if (!key || !projectKeyPattern.test(key)) throw new Error('项目设备授权无法解密。')
    this.vault.set(this.reference(share.projectId, share.keyEpoch), key)
    return key
  }

  async authorizePendingDevices(share: AccountProjectShare): Promise<number> {
    if (share.role !== 'owner' || !this.account.getState().device?.hostId) {
      throw new Error('请在项目所有者 Mac 上授权设备。')
    }
    const projectKey = await this.getReadable(share)
    const pending = await this.account.listPendingProjectDeviceGrants(share.projectId)
    let completed = 0
    for (const grant of pending) {
      if (grant.keyEpoch !== share.keyEpoch) continue
      const wrapped = this.account.wrapProjectGrant({
        grantId: grant.id, projectId: share.projectId, deviceId: grant.deviceId,
        keyEpoch: share.keyEpoch, projectKey, recipientPublicKey: grant.publicKey
      })
      await this.account.completeProjectDeviceGrant(share.projectId, grant.id, wrapped, share.keyEpoch)
      completed += 1
    }
    return completed
  }

  forgetProject(projectId: string): void {
    const userId = this.account.getState().user?.id
    if (!userId) throw new Error('请先登录 Fuddy 账户。')
    this.vault.deleteByPrefix(`project-sharing.key:${userId}:${projectId}:`)
  }
}
