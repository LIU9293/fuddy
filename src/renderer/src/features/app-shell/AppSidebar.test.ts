import { describe, expect, it } from 'vitest'
import type { AgentRun, Project } from '../../../../shared/contracts'
import { groupSidebarRuns } from './AppSidebar'

function run(id: string, projectId: string | null): AgentRun {
  return { id, projectId, title: id } as AgentRun
}

describe('Agent Run sidebar grouping', () => {
  it('groups Runs by configured project order and keeps shared Runs separate', () => {
    const projects = [
      { id: 'project-b', name: 'Project B' },
      { id: 'project-a', name: 'Project A' }
    ] as Project[]
    const groups = groupSidebarRuns([
      run('a-1', 'project-a'),
      run('shared-1', null),
      run('b-1', 'project-b'),
      run('orphaned-1', 'removed-project')
    ], projects)

    expect(groups.map((group) => [group.title, group.projectId, group.runs.map((item) => item.id)])).toEqual([
      ['Project B', 'project-b', ['b-1']],
      ['Project A', 'project-a', ['a-1']],
      ['共享任务', null, ['shared-1', 'orphaned-1']]
    ])
  })
})
