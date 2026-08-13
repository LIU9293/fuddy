import type { Project } from '../../shared/contracts'
import { AppDatabase } from '../services/database'

/**
 * Historical product data belongs in tests, not in the production database
 * bootstrap path. Tests that need a populated portfolio opt in explicitly.
 */
export const testProjects: Project[] = [
  testProject('roombase', 'Roombase', '/Users/kai/Code/shopmy'),
  testProject('vows', 'Vows', '/Users/kai/Code/wedding-app'),
  testProject('ai-marketing', 'AI Marketing', '/Users/kai/Code/marketing-tool')
]

export function createTestDatabase(path: string, projects: Project[] = testProjects): AppDatabase {
  return new AppDatabase(path, { initialProjects: projects })
}

export function testProject(id: string, name: string, repoPath = ''): Project {
  return {
    id,
    name,
    icon: null,
    summary: `${name} test project`,
    focus: 'Product / Delivery',
    status: 'active',
    accent: '#327bd6',
    profile: {
      productType: '测试项目',
      stage: '验证',
      mission: `${name} mission`,
      vision: `${name} vision`,
      repoPath,
      workspaceRoots: repoPath ? [{ id: 'primary', label: name, path: repoPath }] : [],
      primaryWorkspaceRootId: repoPath ? 'primary' : null,
      defaultAgent: 'codex',
      websiteUrl: null,
      surfaces: [],
      focusAreas: [],
      dataSources: [],
      nextMoves: [],
      currentState: {
        summary: `${name} test state`,
        facts: [],
        source: 'user',
        updatedAt: null
      }
    }
  }
}
