import { ChevronRight } from 'lucide-react'
import type { Project } from '../../../shared/contracts'
import { ProjectIcon } from '../components/ProjectIcon'
import { EmptyState } from './GoalsView'

export function ProjectsView({
  projects,
  onOpen
}: {
  projects: Project[]
  onOpen: (projectId: string) => void
}): React.JSX.Element {
  return (
    <section className="projects-list-view" aria-label="项目列表">
      {projects.length ? (
        <ul className="projects-list">
          {projects.map((project) => {
            const detail = project.profile.productType || project.profile.stage || project.profile.defaultAgent
            return (
              <li key={project.id}>
                <button type="button" className="projects-list-item" onClick={() => onOpen(project.id)}>
                  <span aria-hidden="true"><ProjectIcon project={project} className="is-project-list" /></span>
                  <span className="projects-list-copy">
                    <strong title={project.name}>{project.name}</strong>
                    {project.summary && <span title={project.summary}>{project.summary}</span>}
                  </span>
                  {detail && <small className="projects-list-meta" title={detail}>{detail}</small>}
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              </li>
            )
          })}
        </ul>
      ) : <EmptyState title="还没有项目" detail="可以让工作助理创建并配置第一个项目。" />}
    </section>
  )
}
