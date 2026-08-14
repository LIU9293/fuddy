import { realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export type FuddyRuntimeChannel = 'production' | 'development'

export interface FuddyRuntimeProfile {
  channel: FuddyRuntimeChannel
  appName: 'Fuddy' | 'Fuddy Dev'
  userDataPath: string
  productionUserDataPath: string
  hostBundleId: 'dev.ainative.projectagent' | 'dev.ainative.projectagent.dev'
  autoUpdatesEnabled: boolean
}

export const productionUserDataDirectoryName = 'ai-native-project-agent'
export const developmentUserDataDirectoryName = 'ai-native-project-agent-dev'

function requestedChannel(environment: NodeJS.ProcessEnv): FuddyRuntimeChannel | null {
  const value = environment.FUDDY_RUNTIME_PROFILE?.trim()
  if (!value) return null
  if (value === 'production' || value === 'development') return value
  throw new Error('FUDDY_RUNTIME_PROFILE 只支持 production 或 development。')
}

function canonicalPathIdentity(path: string, caseInsensitive: boolean): string {
  const missingSegments: string[] = []
  let existingPath = resolve(path)
  let canonicalPath: string

  while (true) {
    try {
      canonicalPath = resolve(realpathSync.native(existingPath), ...missingSegments.reverse())
      break
    } catch {
      const parent = dirname(existingPath)
      if (parent === existingPath) {
        canonicalPath = resolve(path)
        break
      }
      missingSegments.push(basename(existingPath))
      existingPath = parent
    }
  }

  const normalized = canonicalPath.normalize('NFC')
  return caseInsensitive ? normalized.toLocaleLowerCase('en-US') : normalized
}

function existingFileSystemIdentity(path: string): { device: bigint; inode: bigint } | null {
  try {
    const stats = statSync(path, { bigint: true })
    return { device: stats.dev, inode: stats.ino }
  } catch {
    return null
  }
}

function pathsReferToSameFileSystemLocation(firstPath: string, secondPath: string, caseInsensitive: boolean): boolean {
  const firstIdentity = existingFileSystemIdentity(firstPath)
  const secondIdentity = existingFileSystemIdentity(secondPath)
  if (firstIdentity && secondIdentity) {
    return firstIdentity.device === secondIdentity.device && firstIdentity.inode === secondIdentity.inode
  }
  return canonicalPathIdentity(firstPath, caseInsensitive) === canonicalPathIdentity(secondPath, caseInsensitive)
}

export function resolveFuddyRuntimeProfile(input: {
  appDataPath: string
  appName: string
  appExecutablePath?: string
  isPackaged: boolean
  packagedRuntimeChannel?: string | null
  environment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}): FuddyRuntimeProfile {
  const environment = input.environment ?? process.env
  const requested = requestedChannel(environment)
  if (!input.isPackaged && requested === 'production') {
    throw new Error('开发进程禁止使用 Fuddy production Runtime Profile。')
  }

  if (input.packagedRuntimeChannel && input.packagedRuntimeChannel !== 'production' && input.packagedRuntimeChannel !== 'development') {
    throw new Error('打包应用的 fuddyRuntimeProfile 无效。')
  }
  const developmentExecutable = input.appExecutablePath?.endsWith('/Fuddy Dev') ?? false
  const channel: FuddyRuntimeChannel = !input.isPackaged
    || input.packagedRuntimeChannel === 'development'
    || input.appName === 'Fuddy Dev'
    || developmentExecutable
    || Boolean(environment.FUDDY_DEV_USER_DATA_DIR?.trim())
    || requested === 'development'
    ? 'development'
    : 'production'
  const productionUserDataPath = resolve(input.appDataPath, productionUserDataDirectoryName)
  const requestedDevelopmentPath = environment.FUDDY_DEV_USER_DATA_DIR?.trim()
  if (requestedDevelopmentPath && !isAbsolute(requestedDevelopmentPath)) {
    throw new Error('FUDDY_DEV_USER_DATA_DIR 必须是绝对路径。')
  }
  const userDataPath = channel === 'production'
    ? productionUserDataPath
    : resolve(requestedDevelopmentPath || join(input.appDataPath, developmentUserDataDirectoryName))

  const caseInsensitivePaths = (input.platform ?? process.platform) === 'darwin'
  if (channel === 'development'
    && pathsReferToSameFileSystemLocation(userDataPath, productionUserDataPath, caseInsensitivePaths)) {
    throw new Error('Fuddy Dev 的 userData 不能指向 production 数据目录。')
  }

  return {
    channel,
    appName: channel === 'production' ? 'Fuddy' : 'Fuddy Dev',
    userDataPath,
    productionUserDataPath,
    hostBundleId: channel === 'production' ? 'dev.ainative.projectagent' : 'dev.ainative.projectagent.dev',
    autoUpdatesEnabled: channel === 'production' && input.isPackaged
  }
}
