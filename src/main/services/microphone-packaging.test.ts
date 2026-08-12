import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(import.meta.dirname, '../../..')

describe('macOS microphone packaging', () => {
  it('signs the app and helpers with audio-input access', () => {
    const packageJson = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8')) as {
      build?: { mac?: { entitlements?: string; entitlementsInherit?: string }; extendInfo?: unknown }
    }
    const mainEntitlements = readFileSync(resolve(projectRoot, 'resources/entitlements.mac.plist'), 'utf8')
    const inheritedEntitlements = readFileSync(resolve(projectRoot, 'resources/entitlements.mac.inherit.plist'), 'utf8')

    expect(packageJson.build?.mac?.entitlements).toBe('resources/entitlements.mac.plist')
    expect(packageJson.build?.mac?.entitlementsInherit).toBe('resources/entitlements.mac.inherit.plist')
    expect(mainEntitlements).toContain('com.apple.security.device.audio-input')
    expect(inheritedEntitlements).toContain('com.apple.security.device.audio-input')
    expect(packageJson.build).toMatchObject({
      mac: { extendInfo: { NSMicrophoneUsageDescription: expect.any(String) } }
    })
  })
})
