import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseShellEnvironment, readInteractiveZshEnvironment } from './shell-environment'

afterEach(() => {
  vi.useRealTimers()
})

describe('interactive shell environment', () => {
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
