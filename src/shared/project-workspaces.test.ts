import { describe, expect, it } from 'vitest'
import { normalizeWorkspaceRoots } from './project-workspaces'

describe('project workspace normalization', () => {
  it('migrates a legacy repo path into a primary workspace', () => {
    expect(normalizeWorkspaceRoots({ repoPath: '/code/legacy' })).toEqual({
      repoPath: '/code/legacy',
      primaryWorkspaceRootId: 'primary',
      workspaceRoots: [{ id: 'primary', label: 'legacy', path: '/code/legacy' }]
    })
  })

  it('deduplicates roots and repairs an invalid primary id', () => {
    const result = normalizeWorkspaceRoots({
      repoPath: '/ignored',
      primaryWorkspaceRootId: 'missing',
      workspaceRoots: [
        { id: 'app', label: 'App', path: '/code/app' },
        { id: 'app', label: 'Duplicate id', path: '/code/ops' },
        { id: 'duplicate-path', label: 'Duplicate path', path: '/code/app' }
      ]
    })
    expect(result.primaryWorkspaceRootId).toBe('app')
    expect(result.repoPath).toBe('/code/app')
    expect(result.workspaceRoots.map((root) => root.id)).toEqual(['app', 'app-2'])
  })
})
