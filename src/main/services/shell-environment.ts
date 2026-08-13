import { execFile } from 'node:child_process'

const environmentMarker = '__PROJECT_AGENT_SHELL_ENVIRONMENT__'
const environmentCommand = `printf '\\0${environmentMarker}\\0'; /usr/bin/env -0`
const shellEnvironmentDeadlineMs = 10_000

interface ShellEnvironmentProcess {
  kill(): unknown
}

interface ShellEnvironmentReadOptions {
  deadlineMs?: number
  launch?: (
    onComplete: (error: Error | null, stdout: string) => void
  ) => ShellEnvironmentProcess
}

export function parseShellEnvironment(output: string): NodeJS.ProcessEnv {
  const marker = `\0${environmentMarker}\0`
  const markerIndex = output.indexOf(marker)
  if (markerIndex < 0) return {}

  const environment: NodeJS.ProcessEnv = {}
  const payload = output.slice(markerIndex + marker.length)
  for (const entry of payload.split('\0')) {
    const separator = entry.indexOf('=')
    if (separator <= 0) continue
    const key = entry.slice(0, separator)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    environment[key] = entry.slice(separator + 1)
  }
  return environment
}

export function readInteractiveZshEnvironment(
  baseEnvironment: NodeJS.ProcessEnv = process.env,
  options: ShellEnvironmentReadOptions = {}
): Promise<NodeJS.ProcessEnv> {
  return new Promise((resolve) => {
    let settled = false
    let processHandle: ShellEnvironmentProcess | null = null
    const settle = (environment: NodeJS.ProcessEnv): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      resolve(environment)
    }
    const onComplete = (error: Error | null, stdout: string): void => {
      if (error) {
        settle({})
        return
      }
      settle(parseShellEnvironment(stdout))
    }
    const deadline = setTimeout(() => {
      processHandle?.kill()
      settle({})
    }, options.deadlineMs ?? shellEnvironmentDeadlineMs)

    try {
      processHandle = options.launch
        ? options.launch(onComplete)
        : execFile('/bin/zsh', ['-ic', environmentCommand], {
            encoding: 'utf8',
            env: { ...baseEnvironment },
            timeout: shellEnvironmentDeadlineMs - 500,
            maxBuffer: 2 * 1024 * 1024
          }, onComplete)
    } catch {
      settle({})
    }
  })
}

/**
 * GUI apps on macOS do not normally inherit variables exported by an
 * interactive .zshrc. Hydrate the main process once so every coding agent
 * receives the same unfiltered environment as the user's terminal.
 */
export async function hydrateProcessEnvironmentFromZsh(): Promise<void> {
  const interactiveEnvironment = await readInteractiveZshEnvironment(process.env)
  Object.assign(process.env, interactiveEnvironment)
}
