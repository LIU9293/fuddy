import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { AgentRunProvider } from '../../shared/contracts'

type CliProvider = Exclude<AgentRunProvider, 'pi'>

export function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function isInstalledCliBinary(command: string): boolean {
  return isAbsolute(command) && isExecutableFile(command)
}

function nvmCandidates(binary: string): string[] {
  const home = process.env.HOME ?? ''
  const versionsRoot = join(home, '.nvm', 'versions', 'node')
  if (!existsSync(versionsRoot)) return []
  try {
    return readdirSync(versionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      .map((version) => join(versionsRoot, version, 'bin', binary))
  } catch {
    return []
  }
}

export function cliBinaryCandidates(provider: CliProvider): string[] {
  const home = process.env.HOME ?? ''
  if (provider === 'codex') {
    return [
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      `${home}/.local/bin/codex`,
      ...nvmCandidates('codex'),
      'codex'
    ]
  }
  const binary = provider === 'claude' ? 'claude' : 'opencode'
  return [
    `/opt/homebrew/bin/${binary}`,
    `/usr/local/bin/${binary}`,
    `${home}/.local/bin/${binary}`,
    ...nvmCandidates(binary),
    binary
  ]
}

export function resolveCliBinary(provider: CliProvider): string {
  const candidates = cliBinaryCandidates(provider)
  return candidates.find((candidate) => isAbsolute(candidate) && isExecutableFile(candidate))
    ?? candidates.at(-1) as string
}
