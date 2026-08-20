import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isExecutableFile, isInstalledCliBinary } from './cli-executables'
import { probeExecutable } from './capabilities'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryCommand(exitCode: number, executable: boolean): string {
  const directory = mkdtempSync(join(tmpdir(), 'fuddy-cli-detection-'))
  temporaryDirectories.push(directory)
  const command = join(directory, 'agent')
  writeFileSync(command, `#!/bin/sh\nexit ${exitCode}\n`)
  chmodSync(command, executable ? 0o755 : 0o644)
  return command
}

describe('CLI executable detection', () => {
  it('recognizes an executable absolute path as installed without requiring --version to succeed', () => {
    const command = temporaryCommand(1, true)

    expect(isExecutableFile(command)).toBe(true)
    expect(isInstalledCliBinary(command)).toBe(true)
    expect(probeExecutable(command)).toEqual({ available: true })
  })

  it('does not treat a non-executable file as an installed CLI', () => {
    const command = temporaryCommand(0, false)

    expect(isExecutableFile(command)).toBe(false)
    expect(isInstalledCliBinary(command)).toBe(false)
    expect(probeExecutable(command)).toEqual({ available: false })
  })
})
