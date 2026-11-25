import { ChevronRight, CircleCheck, FolderOpen, Plus } from 'lucide-react'
import { useState } from 'react'
import type { Project } from '../../../shared/contracts'
import { ProjectIcon } from '../components/ProjectIcon'
import { projectNameFromPath } from './shared'

export function ProjectsView({
  projects,
  onOpen,
  onCreated,
  onNotice
}: {
  projects: Project[]
  onOpen: (projectId: string) => void
  onCreated: (projectId: string) => Promise<void>
  onNotice: (message: string) => void
}): React.JSX.Element {
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  async function chooseFolder(): Promise<void> {
    try {
      const path = await window.projectAgent.selectProjectFolder()
      if (!path) return
      setWorkspacePath(path)
      setName(projectNameFromPath(path))
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '选择项目文件夹失败。')
    }
  }

  async function createProject(): Promise<void> {
    if (busy || !workspacePath || !name.trim()) return
    setBusy(true)
    try {
      const project = await window.projectAgent.createProject({
        name: name.trim(),
        summary: '待补充项目简介',
        focus: '完成项目初始设置',
        mission: '待补充项目使命',
        vision: '待补充项目愿景',
        productType: '未设置',
        stage: '未设置',
        workspacePath
      })
      setWorkspacePath(null)
      await onCreated(project.id)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '项目添加失败。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="projects-list-view" aria-label="项目列表">
      <div className="projects-list-actions">
        <button type="button" className="settings-row-button" onClick={() => void chooseFolder()} disabled={busy}>
          {workspacePath ? <FolderOpen size={15} /> : <Plus size={15} />}
          {workspacePath ? '更换文件夹' : '添加项目'}
        </button>
      </div>
      {workspacePath && (
        <form className="project-create-form" onSubmit={(event) => { event.preventDefault(); void createProject() }}>
          <label>项目名称<input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} required disabled={busy} /></label>
          <small title={workspacePath}>{workspacePath}</small>
          <div className="projects-list-actions">
            <button type="button" className="settings-row-button" disabled={busy} onClick={() => setWorkspacePath(null)}>取消</button>
            <button type="submit" className="provider-save-button" disabled={busy || !name.trim()}>{busy ? '添加中…' : '确认添加'}</button>
          </div>
        </form>
      )}
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
      ) : (
        <div className="empty-state">
          <CircleCheck size={32} strokeWidth={1.4} />
          <strong>还没有项目</strong>
          <span>选择项目文件夹即可添加。</span>
        </div>
      )}
    </section>
  )
}
