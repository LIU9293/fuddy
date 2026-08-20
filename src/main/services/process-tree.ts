import { execFile } from 'node:child_process'

interface KillableChildProcess {
  pid?: number
  kill(signal?: NodeJS.Signals): boolean
}

export function unixDescendantProcessIds(processTable: string, rootPid: number): number[] {
  const childrenByParent = new Map<number, number[]>()
  for (const line of processTable.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/u)
    if (!match) continue
    const pid = Number(match[1])
    const parentPid = Number(match[2])
    const children = childrenByParent.get(parentPid) ?? []
    children.push(pid)
    childrenByParent.set(parentPid, children)
  }

  const descendants: number[] = []
  const visit = (parentPid: number): void => {
    for (const childPid of childrenByParent.get(parentPid) ?? []) {
      visit(childPid)
      descendants.push(childPid)
    }
  }
  visit(rootPid)
  return descendants
}

function readUnixProcessTable(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-axo', 'pid=,ppid='], {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 2 * 1024 * 1024
    }, (error, stdout) => resolve(error ? null : stdout))
  })
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // The process may already have exited while its tree was being collected.
  }
}

function signalProcessGroup(rootPid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-rootPid, signal)
  } catch {
    // The process group may already be gone or unsupported on this platform.
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function terminateProcessTree(
  child: KillableChildProcess,
  gracePeriodMs = 750
): Promise<void> {
  const rootPid = child.pid
  if (!rootPid || process.platform === 'win32') {
    child.kill()
    return
  }

  const processTable = await readUnixProcessTable()
  if (!processTable) {
    signalProcessGroup(rootPid, 'SIGTERM')
    child.kill('SIGTERM')
    return
  }

  const processIds = [...unixDescendantProcessIds(processTable, rootPid), rootPid]
  for (const pid of processIds) signalProcess(pid, 'SIGTERM')
  signalProcessGroup(rootPid, 'SIGTERM')
  const deadline = Date.now() + gracePeriodMs
  while (processIds.some(processIsRunning) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
  for (const pid of processIds) {
    if (processIsRunning(pid)) signalProcess(pid, 'SIGKILL')
  }
  signalProcessGroup(rootPid, 'SIGKILL')
}
