import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hydrateProcessEnvironmentFromZsh, parseShellEnvironment, readInteractiveZshEnvironment } from './shell-environment'

afterEach(() => {
  vi.useRealTimers()
})

describe('interactive shell environment', () => {
  it('loads login and interactive exports and honors login unsets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fuddy-shell-login-'))
    try {
      writeFileSync(join(root, '.zprofile'), 'export FUDDY_TEST_LOGIN=login\nunset ANTHROPIC_API_KEY\n')
      writeFileSync(join(root, '.zshrc'), 'export FUDDY_TEST_INTERACTIVE=interactive\n')
      const environment: NodeJS.ProcessEnv = { ...process.env, ZDOTDIR: root, ANTHROPIC_API_KEY: 'stale-test-key' }
      await hydrateProcessEnvironmentFromZsh(environment)
      expect(environment.FUDDY_TEST_LOGIN).toBe('login')
      expect(environment.FUDDY_TEST_INTERACTIVE).toBe('interactive')
      expect(environment.ANTHROPIC_API_KEY).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves the GUI environment when shell startup fails', async () => {
    const environment = { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: 'test-token' }
    await hydrateProcessEnvironmentFromZsh(environment, {
      launch: (onComplete) => {
        onComplete(new Error('startup failed'), '')
        return { kill: vi.fn() }
      }
    })
    expect(environment).toEqual({ PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: 'test-token' })
  })
  it('ignores zsh startup output and parses the null-separated environment after the marker', () => {
    const output = [
      'zsh startup message',
      '\0__PROJECT_AGENT_SHELL_ENVIRONMENT__\0',
      'PATH=/opt/homebrew/bin:/usr/bin\0',
      'ANTHROPIC_AUTH_TOKEN=token-with=equals\0',
      'EMPTY=\0'
    ].join('')

    expect(parseShellEnvironment(output)).toEqual({
      PATH: '/opt/homebrew/bin:/usr/bin',
      ANTHROPIC_AUTH_TOKEN: 'token-with=equals',
      EMPTY: ''
    })
  })

  it('returns an empty environment when the marker is missing', () => {
    expect(parseShellEnvironment('PATH=/usr/bin\0')).toEqual({})
  })

  it('loads inherited variables through an interactive zsh', async () => {
    const environment = await readInteractiveZshEnvironment({
      ...process.env,
      PROJECT_AGENT_SHELL_ENV_TEST: 'inherited'
    })
    expect(environment.PROJECT_AGENT_SHELL_ENV_TEST).toBe('inherited')
    expect(environment.PATH).toBeTruthy()
  })

  it('does not block app startup when a shell descendant keeps the output pipe open', async () => {
    vi.useFakeTimers()
    const kill = vi.fn()
    const environmentPromise = readInteractiveZshEnvironment({}, {
      deadlineMs: 100,
      launch: () => ({ kill })
    })

    await vi.advanceTimersByTimeAsync(100)

    await expect(environmentPromise).resolves.toEqual({})
    expect(kill).toHaveBeenCalledOnce()
  })
})
