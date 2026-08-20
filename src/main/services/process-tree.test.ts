import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { terminateProcessTree, unixDescendantProcessIds } from './process-tree'

describe('unixDescendantProcessIds', () => {
  it('returns every descendant leaf-first without including unrelated processes', () => {
    const table = [
      ' 100 1',
      ' 110 100',
      ' 120 100',
      ' 111 110',
      ' 121 120',
      ' 999 1'
    ].join('\n')

    expect(unixDescendantProcessIds(table, 100)).toEqual([111, 110, 121, 120])
  })

  it.runIf(process.platform !== 'win32')('terminates an isolated process group and its descendants', async () => {
    const child = spawn('/bin/sh', ['-c', 'sleep 30 & wait'], {
      detached: true,
      stdio: 'ignore'
    })
    await once(child, 'spawn')
    const closed = once(child, 'close')

    await terminateProcessTree(child, 250)
    await closed

    expect(() => process.kill(child.pid!, 0)).toThrow()
  })
})
