import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  developmentUserDataDirectoryName,
  productionUserDataDirectoryName,
  resolveFuddyRuntimeProfile
} from './runtime-profile'

const appDataPath = '/Users/test/Library/Application Support'

describe('Fuddy runtime profile', () => {
  it('isolates an unpackaged development process from production state', () => {
    expect(resolveFuddyRuntimeProfile({ appDataPath, appName: 'ai-native-project-agent', isPackaged: false, environment: {} })).toEqual({
      channel: 'development',
      appName: 'Fuddy Dev',
      userDataPath: `${appDataPath}/${developmentUserDataDirectoryName}`,
      productionUserDataPath: `${appDataPath}/${productionUserDataDirectoryName}`,
      hostBundleId: 'dev.ainative.projectagent.dev',
      autoUpdatesEnabled: false
    })
  })

  it('keeps packaged production builds on the legacy production data path', () => {
    expect(resolveFuddyRuntimeProfile({ appDataPath, appName: 'Fuddy', isPackaged: true, environment: {} })).toMatchObject({
      channel: 'production',
      appName: 'Fuddy',
      userDataPath: `${appDataPath}/${productionUserDataDirectoryName}`,
      hostBundleId: 'dev.ainative.projectagent',
      autoUpdatesEnabled: true
    })
  })

  it('recognizes a packaged Fuddy Dev build and keeps updates disabled', () => {
    expect(resolveFuddyRuntimeProfile({
      appDataPath,
      appName: 'ai-native-project-agent',
      appExecutablePath: '/Applications/Fuddy Dev.app/Contents/MacOS/Fuddy Dev',
      isPackaged: true,
      packagedRuntimeChannel: 'development',
      environment: {}
    })).toMatchObject({
      channel: 'development',
      appName: 'Fuddy Dev',
      userDataPath: `${appDataPath}/${developmentUserDataDirectoryName}`,
      hostBundleId: 'dev.ainative.projectagent.dev',
      autoUpdatesEnabled: false
    })
  })

  it('supports a temporary absolute development data path for smoke tests', () => {
    expect(resolveFuddyRuntimeProfile({
      appDataPath,
      appName: 'ai-native-project-agent',
      isPackaged: true,
      packagedRuntimeChannel: 'development',
      environment: { FUDDY_DEV_USER_DATA_DIR: '/tmp/fuddy-package-smoke' }
    }).userDataPath).toBe('/tmp/fuddy-package-smoke')
  })

  it('rejects every attempt to point a development process at production data', () => {
    expect(() => resolveFuddyRuntimeProfile({
      appDataPath,
      appName: 'ai-native-project-agent',
      isPackaged: true,
      packagedRuntimeChannel: 'development',
      environment: { FUDDY_DEV_USER_DATA_DIR: `${appDataPath}/${productionUserDataDirectoryName}` }
    })).toThrow('不能指向 production')
    expect(() => resolveFuddyRuntimeProfile({
      appDataPath,
      appName: 'Fuddy',
      isPackaged: false,
      environment: { FUDDY_RUNTIME_PROFILE: 'production' }
    })).toThrow('开发进程禁止使用')
  })

  it('rejects a case-only alias of the production data directory on macOS', () => {
    expect(() => resolveFuddyRuntimeProfile({
      appDataPath,
      appName: 'Fuddy Dev',
      isPackaged: true,
      packagedRuntimeChannel: 'development',
      environment: {
        FUDDY_DEV_USER_DATA_DIR: `${appDataPath}/${productionUserDataDirectoryName.toUpperCase()}`
      },
      platform: 'darwin'
    })).toThrow('不能指向 production')
  })

  it('rejects a symlink alias of an existing production data directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'fuddy-runtime-profile-'))
    const productionPath = join(root, productionUserDataDirectoryName)
    const aliasPath = join(root, 'fuddy-dev-alias')
    try {
      mkdirSync(productionPath)
      symlinkSync(productionPath, aliasPath, 'dir')

      expect(() => resolveFuddyRuntimeProfile({
        appDataPath: root,
        appName: 'Fuddy Dev',
        isPackaged: true,
        packagedRuntimeChannel: 'development',
        environment: { FUDDY_DEV_USER_DATA_DIR: aliasPath }
      })).toThrow('不能指向 production')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
