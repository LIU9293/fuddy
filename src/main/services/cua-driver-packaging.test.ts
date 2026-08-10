import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(import.meta.dirname, '../../..')

describe('CUA Driver packaging', () => {
  it('keeps the native library outside ASAR and applies the Electron path fix', () => {
    const packageJson = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
      build?: { asarUnpack?: string[] }
    }
    const dependencyPatch = readFileSync(
      resolve(projectRoot, 'patches/@trycua+cua-driver+0.19.0.patch'),
      'utf8'
    )

    expect(packageJson.scripts?.postinstall).toContain('patch-package')
    expect(packageJson.build?.asarUnpack).toContain('node_modules/@trycua/cua-driver-darwin-*/**/*')
    expect(dependencyPatch).toContain('app.asar.unpacked')
    expect(dependencyPatch).toContain('resolveLibPath: resolveRealLibPath')
  })
})
