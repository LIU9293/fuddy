import { readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { extname, relative, resolve, sep } from 'node:path'
import { normalizeWorkspaceRoots } from '../../shared/project-workspaces'
import type { Project, WorkspaceFileEntry } from '../../shared/contracts'
import { AppDatabase } from './database'
import { WorkspaceFilesService } from './workspace-files'

const ignoredDirectories = new Set([
  '.git', '.next', '.turbo', '.cache', 'node_modules', 'dist', 'build', 'coverage', 'DerivedData',
  '.swiftpm', 'Pods', 'vendor'
])
const readableExtensions = new Set([
  '', '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.html', '.css', '.scss',
  '.less', '.xml', '.yaml', '.yml', '.toml', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.swift',
  '.kt', '.kts', '.java', '.py', '.rb', '.go', '.rs', '.php', '.sh', '.zsh', '.sql', '.graphql',
  '.vue', '.svelte', '.env.example'
])

export interface ProjectFileMatch {
  space: 'project-files' | 'workspace'
  rootLabel: string
  relativePath: string
  mimeType: string | null
  excerpt: string | null
}

export interface ProjectInspectionResult {
  project: Project
  goals: Array<{ id: string; title: string; status: string; milestones: Array<{ id: string; title: string; status: string }> }>
  runs: Array<{ id: string; title: string; status: string; provider: string; summary: string; updatedAt: string }>
  projectFiles: WorkspaceFileEntry[]
  matches: ProjectFileMatch[]
}

function searchTerms(query: string): string[] {
  const ascii = query.toLocaleLowerCase().match(/[a-z0-9_.\/-]{2,}/g) ?? []
  const chinese = query.match(/[\u3400-\u9fff]{2,}/g) ?? []
  const semantic: string[] = []
  if (/(?:宣传|营销|社交媒体|小红书|抖音)/.test(query)) semantic.push('marketing', 'social', '宣传', '营销', '小红书', '抖音')
  if (/(?:素材|资源|图片|图标)/.test(query)) semantic.push('asset', 'assets', '素材', 'image', 'icon')
  if (/(?:品牌|标志)/.test(query)) semantic.push('brand', 'logo', '品牌')
  if (/(?:说明|文档|介绍)/.test(query)) semantic.push('readme', '.md', '文档')
  const ignored = new Set(['项目里面', '项目文件', '文件里面', '看一下', '找一下', '搜索一下', '有没有', '在哪里', '是什么', '当前项目'])
  return [...new Set([...ascii, ...chinese, ...semantic].map((value) => value.trim()).filter((value) => value && !ignored.has(value)))]
}

function matchesTerms(value: string, terms: string[]): boolean {
  if (terms.length === 0) return true
  const normalized = value.toLocaleLowerCase()
  return terms.some((term) => normalized.includes(term.toLocaleLowerCase()))
}

function excerpt(content: string, terms: string[], maxLength = 1_600): string {
  if (content.length <= maxLength) return content
  const normalized = content.toLocaleLowerCase()
  const indices = terms.map((term) => normalized.indexOf(term.toLocaleLowerCase())).filter((index) => index >= 0)
  const center = indices.length > 0 ? Math.min(...indices) : 0
  const start = Math.max(0, center - Math.floor(maxLength / 3))
  return `${start > 0 ? '…' : ''}${content.slice(start, start + maxLength)}${start + maxLength < content.length ? '…' : ''}`
}

export class ProjectInspectionService {
  constructor(
    private readonly database: AppDatabase,
    private readonly workspaceFiles: WorkspaceFilesService
  ) {}

  inspect(projectId: string, query = ''): ProjectInspectionResult {
    const project = this.database.listProjects().find((item) => item.id === projectId)
    if (!project) throw new Error('没有找到要检查的项目。')
    const terms = searchTerms(query)
    const projectFiles = this.workspaceFiles.list(projectId)
    const matches = [
      ...this.searchProjectFiles(projectId, projectFiles, terms),
      ...this.searchWorkspaces(project, terms)
    ].slice(0, 24)
    return {
      project,
      goals: this.database.listGoals(projectId).map((goal) => ({
        id: goal.id,
        title: goal.title,
        status: goal.status,
        milestones: goal.milestones.map((milestone) => ({
          id: milestone.id,
          title: milestone.title,
          status: milestone.status
        }))
      })),
      runs: this.database.listRuns().filter((run) => run.projectId === projectId).slice(0, 12).map((run) => ({
        id: run.id,
        title: run.title,
        status: run.status,
        provider: run.provider,
        summary: run.summary,
        updatedAt: run.updatedAt
      })),
      projectFiles: projectFiles.slice(0, 200),
      matches
    }
  }

  private searchProjectFiles(
    projectId: string,
    entries: WorkspaceFileEntry[],
    terms: string[]
  ): ProjectFileMatch[] {
    const results: ProjectFileMatch[] = []
    for (const entry of entries) {
      if (entry.kind !== 'file') continue
      let content: string | null = null
      if (entry.editable && entry.size <= 512 * 1024) {
        try { content = this.workspaceFiles.read(projectId, entry.relativePath).content } catch { content = null }
      }
      if (!matchesTerms(entry.relativePath, terms) && !(content && matchesTerms(content, terms))) continue
      results.push({
        space: 'project-files',
        rootLabel: '项目文件空间',
        relativePath: entry.relativePath,
        mimeType: entry.mimeType,
        excerpt: content ? excerpt(content, terms) : null
      })
      if (results.length >= 12) break
    }
    return results
  }

  private searchWorkspaces(project: Project, terms: string[]): ProjectFileMatch[] {
    const results: ProjectFileMatch[] = []
    let visited = 0
    for (const root of normalizeWorkspaceRoots(project.profile).workspaceRoots) {
      const rootPath = resolve(root.path)
      const visit = (directory: string): void => {
        if (results.length >= 16 || visited >= 4_000) return
        let items: Dirent<string>[]
        try { items = readdirSync(directory, { withFileTypes: true, encoding: 'utf8' }) } catch { return }
        for (const item of items) {
          if (results.length >= 16 || visited++ >= 4_000) return
          if (item.name === '.DS_Store' || (item.isDirectory() && ignoredDirectories.has(item.name))) continue
          const absolutePath = resolve(directory, item.name)
          const relativePath = relative(rootPath, absolutePath).split(sep).join('/')
          if (relativePath.startsWith('../')) continue
          if (item.isDirectory()) {
            visit(absolutePath)
            continue
          }
          if (!item.isFile()) continue
          let content: string | null = null
          const extension = extname(item.name).toLocaleLowerCase()
          try {
            const stats = statSync(absolutePath)
            if (stats.size <= 512 * 1024 && readableExtensions.has(extension)) {
              content = readFileSync(absolutePath, 'utf8')
            }
          } catch {
            content = null
          }
          if (!matchesTerms(relativePath, terms) && !(content && matchesTerms(content, terms))) continue
          results.push({
            space: 'workspace',
            rootLabel: root.label,
            relativePath,
            mimeType: null,
            excerpt: content ? excerpt(content, terms) : null
          })
        }
      }
      visit(rootPath)
    }
    return results
  }
}
