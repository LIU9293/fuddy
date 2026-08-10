import { describe, expect, it } from 'vitest'
import { updateProjectSchema } from './project-validation'

const project = {
  id: 'fuddy',
  name: 'Fuddy',
  summary: 'Project summary',
  focus: 'Product',
  status: 'active' as const,
  accent: '#327bd6',
  profile: {
    productType: 'App',
    stage: 'Development',
    mission: 'Mission',
    vision: 'Vision',
    repoPath: '',
    workspaceRoots: [],
    primaryWorkspaceRootId: null,
    defaultAgent: 'codex' as const,
    websiteUrl: null,
    surfaces: [],
    focusAreas: [],
    dataSources: [],
    nextMoves: [],
    currentState: {
      summary: 'Current state',
      facts: [],
      source: 'user' as const,
      updatedAt: null
    }
  }
}

describe('project icon validation', () => {
  it('accepts short text and supported raster image data URLs', () => {
    expect(updateProjectSchema.parse({ ...project, icon: '🧭' }).icon).toBe('🧭')
    expect(updateProjectSchema.parse({ ...project, icon: 'data:image/png;base64,iVBORw0KGgo=' }).icon)
      .toBe('data:image/png;base64,iVBORw0KGgo=')
  })

  it('rejects SVG data and long arbitrary text', () => {
    expect(() => updateProjectSchema.parse({ ...project, icon: 'data:image/svg+xml;base64,PHN2Zz4=' })).toThrow()
    expect(() => updateProjectSchema.parse({ ...project, icon: 'x'.repeat(17) })).toThrow()
  })
})
