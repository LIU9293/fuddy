import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import type { CredentialStorageStatus } from '../../shared/contracts'

type CredentialMap = Record<string, string>

export class CredentialVault {
  constructor(private readonly path: string) {}

  getStatus(): CredentialStorageStatus {
    const available = safeStorage.isEncryptionAvailable()
    return {
      available,
      backend: available
        ? process.platform === 'darwin'
          ? 'macos-keychain'
          : 'os-encryption'
        : 'unavailable',
      detail: available
        ? process.platform === 'darwin'
          ? '凭证由 macOS Keychain 保护；SQLite 和日志只保存引用。'
          : '凭证由操作系统加密服务保护；SQLite 和日志只保存引用。'
        : '操作系统安全存储当前不可用，禁止保存第三方凭证。'
    }
  }

  set(reference: string, secret: string): void {
    if (!this.getStatus().available) throw new Error('操作系统安全存储不可用。')
    const credentials = this.readAll()
    credentials[reference] = secret
    this.writeAll(credentials)
  }

  get(reference: string): string | null {
    return this.readAll()[reference] ?? null
  }

  delete(reference: string): void {
    const credentials = this.readAll()
    if (!(reference in credentials)) return
    delete credentials[reference]
    this.writeAll(credentials)
  }

  private readAll(): CredentialMap {
    if (!existsSync(this.path)) return {}
    if (!this.getStatus().available) return {}

    try {
      const encrypted = readFileSync(this.path)
      return JSON.parse(safeStorage.decryptString(encrypted)) as CredentialMap
    } catch {
      throw new Error('安全凭证库无法解密；没有向 Agent 暴露任何内容。')
    }
  }

  private writeAll(credentials: CredentialMap): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const encrypted = safeStorage.encryptString(JSON.stringify(credentials))
    const temporaryPath = `${this.path}.tmp`
    writeFileSync(temporaryPath, encrypted, { mode: 0o600 })
    renameSync(temporaryPath, this.path)
  }
}
