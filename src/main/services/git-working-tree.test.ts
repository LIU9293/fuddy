import { describe, expect, it } from 'vitest'
import { parseGitNumstat, parseGitStatus } from './git-working-tree'

describe('Git working tree summary parsing', () => {
  it('adds text line changes and ignores binary numstat markers', () => {
    expect(parseGitNumstat('12\t3\tsrc/app.ts\n-\t-\timage.png\n4\t0\tREADME.md\n')).toEqual({
      additions: 16,
      deletions: 3
    })
  })

  it('parses NUL-delimited paths and uses the destination of a rename', () => {
    expect(parseGitStatus(' M src/app.ts\0?? notes/new file.md\0R  old.ts\0new.ts\0')).toEqual([
      { path: 'src/app.ts', status: 'M' },
      { path: 'notes/new file.md', status: '??' },
      { path: 'new.ts', status: 'R' }
    ])
  })
})
