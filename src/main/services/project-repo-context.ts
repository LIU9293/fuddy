import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_README_CHARACTERS = 18_000
const MAX_TRACKED_PATHS = 220

export interface ProjectRepoContext {
  available: boolean
  repoPath: string
  branch: string | null
  head: string | null
  recentCommits: Array<{ date: string; subject: string }>
  changedPaths: string[]
  trackedPathSample: string[]
  trackedAreaCounts: Record<string, number>
  packageScripts: string[]
  workspacePackages: string[]
  localSkills: Array<{ name: string; description: string }>
  readme: string | null
  error: string | null
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    timeout: 8_000,
    maxBuffer: 2_000_000
  })
  return result.stdout.trim()
}

async function optionalGit(repoPath: string, args: string[]): Promise<string | null> {
  try {
    return await git(repoPath, args)
  } catch {
    return null
  }
}

async function optionalText(path: string, maxCharacters: number): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).slice(0, maxCharacters)
  } catch {
    return null
  }
}

function frontmatter(value: string): { name: string; description: string } | null {
  const header = value.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!header) return null
  const name = header[1].match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? ''
  const description = header[1].match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? ''
  return name ? { name, description } : null
}

async function discoverSkills(repoPath: string): Promise<Array<{ name: string; description: string }>> {
  const roots = [join(repoPath, '.agents', 'skills'), join(repoPath, '.codex', 'skills')]
  const skills: Array<{ name: string; description: string }> = []
  for (const root of roots) {
    try {
      const entries = await readdir(root, { withFileTypes: true })
      for (const entry of entries.filter((candidate) => candidate.isDirectory()).slice(0, 20)) {
        const contents = await optionalText(join(root, entry.name, 'SKILL.md'), 4_000)
        const metadata = contents ? frontmatter(contents) : null
        if (metadata && !skills.some((skill) => skill.name === metadata.name)) skills.push(metadata)
      }
    } catch {
      // Local Skills are optional.
    }
  }
  return skills
}

async function packageContext(repoPath: string): Promise<{
  packageScripts: string[]
  workspacePackages: string[]
}> {
  const raw = await optionalText(join(repoPath, 'package.json'), 30_000)
  if (!raw) return { packageScripts: [], workspacePackages: [] }
  try {
    const value = JSON.parse(raw) as {
      scripts?: Record<string, string>
      workspaces?: string[]
    }
    return {
      packageScripts: Object.keys(value.scripts ?? {}).slice(0, 40),
      workspacePackages: Array.isArray(value.workspaces) ? value.workspaces.slice(0, 30) : []
    }
  } catch {
    return { packageScripts: [], workspacePackages: [] }
  }
}

function areaCounts(paths: string[]): Record<string, number> {
  return paths.reduce<Record<string, number>>((counts, path) => {
    const area = path.includes('/') ? path.split('/')[0] : '(root)'
    counts[area] = (counts[area] ?? 0) + 1
    return counts
  }, {})
}

function representativePaths(paths: string[]): string[] {
  const priority = paths.filter((path) =>
    /(^|\/)(readme|agents|roadmap|todo|plan|marketing|product|docs?)(\/|\.|$)/i.test(path)
  )
  const selected = [...priority, ...paths.filter((path) => !priority.includes(path))]
  return [...new Set(selected)].slice(0, MAX_TRACKED_PATHS)
}

export async function collectProjectRepoContext(repoPath: string): Promise<ProjectRepoContext> {
  const empty: ProjectRepoContext = {
    available: false,
    repoPath,
    branch: null,
    head: null,
    recentCommits: [],
    changedPaths: [],
    trackedPathSample: [],
    trackedAreaCounts: {},
    packageScripts: [],
    workspacePackages: [],
    localSkills: [],
    readme: null,
    error: null
  }
  if (!repoPath.startsWith('/')) return { ...empty, error: '项目没有配置有效的本地 Repo 路径。' }

  try {
    const [branch, head, log, status, tracked, readme, packages, localSkills] = await Promise.all([
      optionalGit(repoPath, ['branch', '--show-current']),
      optionalGit(repoPath, ['rev-parse', '--short', 'HEAD']),
      optionalGit(repoPath, ['log', '-12', '--date=short', '--pretty=format:%ad%x09%s']),
      optionalGit(repoPath, ['status', '--porcelain=v1']),
      optionalGit(repoPath, ['ls-files']),
      optionalText(join(repoPath, 'README.md'), MAX_README_CHARACTERS),
      packageContext(repoPath),
      discoverSkills(repoPath)
    ])
    const trackedPaths = tracked ? tracked.split('\n').filter(Boolean) : []
    return {
      available: Boolean(head),
      repoPath,
      branch,
      head,
      recentCommits: log
        ? log.split('\n').filter(Boolean).map((line) => {
            const [date, ...subject] = line.split('\t')
            return { date, subject: subject.join('\t') }
          })
        : [],
      changedPaths: status
        ? status.split('\n').filter(Boolean).map((line) => line.slice(2).trim()).slice(0, 80)
        : [],
      trackedPathSample: representativePaths(trackedPaths),
      trackedAreaCounts: areaCounts(trackedPaths),
      packageScripts: packages.packageScripts,
      workspacePackages: packages.workspacePackages,
      localSkills,
      readme,
      error: null
    }
  } catch (error) {
    return {
      ...empty,
      error: error instanceof Error ? error.message : '读取 Repo 上下文失败。'
    }
  }
}
