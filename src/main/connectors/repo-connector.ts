import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { EvidenceRef } from '../../shared/contracts'
import type {
  ConnectorAdapter,
  ConnectorCollection,
  ConnectorContext,
  ConnectorProbe
} from './types'

const execFileAsync = promisify(execFile)

interface RepoSnapshot {
  repoPath: string
  branch: string
  shortSha: string
  upstream: string | null
  ahead: number
  behind: number
  changedFiles: number
  lastCommitAt: string
  hasAgentInstructions: boolean
  skillCount: number
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    timeout: 8_000,
    maxBuffer: 1_000_000
  })
  return stdout.trim()
}

async function optionalGit(repoPath: string, args: string[]): Promise<string | null> {
  try {
    return await git(repoPath, args)
  } catch {
    return null
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function countSkillDirectories(repoPath: string): Promise<number> {
  const roots = [join(repoPath, '.agents', 'skills'), join(repoPath, '.codex', 'skills')]
  let count = 0

  for (const root of roots) {
    try {
      const entries = await readdir(root, { withFileTypes: true })
      count += entries.filter((entry) => entry.isDirectory()).length
    } catch {
      // A project does not need a local Skills directory.
    }
  }

  return count
}

function repoPathFrom(config: Record<string, string | number | boolean>): string {
  const repoPath = config.repoPath
  if (typeof repoPath !== 'string' || !repoPath.startsWith('/')) {
    throw new Error('Repo Connector 需要绝对路径。')
  }
  return repoPath
}

function fileEvidence(repoPath: string): EvidenceRef[] {
  return [{ label: '本地 Repo', uri: `file://${repoPath}` }]
}

export function fingerprintRepoSnapshot(snapshot: RepoSnapshot): string {
  return createHash('sha256')
    .update(JSON.stringify({
      branch: snapshot.branch,
      shortSha: snapshot.shortSha,
      upstream: snapshot.upstream,
      ahead: snapshot.ahead,
      behind: snapshot.behind,
      changedFiles: snapshot.changedFiles,
      hasAgentInstructions: snapshot.hasAgentInstructions,
      skillCount: snapshot.skillCount
    }))
    .digest('hex')
    .slice(0, 16)
}

async function snapshotRepo(repoPath: string): Promise<RepoSnapshot> {
  const pathStat = await stat(repoPath).catch(() => null)
  if (!pathStat?.isDirectory()) throw new Error('本地 Repo 目录不存在。')

  const isRepo = await git(repoPath, ['rev-parse', '--is-inside-work-tree'])
  if (isRepo !== 'true') throw new Error('目标目录不是 Git Repo。')

  const [branch, shortSha, upstream, statusOutput, lastCommitAt, hasAgentInstructions, skillCount] =
    await Promise.all([
      git(repoPath, ['branch', '--show-current']),
      git(repoPath, ['rev-parse', '--short', 'HEAD']),
      optionalGit(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
      git(repoPath, ['status', '--porcelain=v1']),
      git(repoPath, ['log', '-1', '--format=%cI']),
      exists(join(repoPath, 'AGENTS.md')),
      countSkillDirectories(repoPath)
    ])

  let ahead = 0
  let behind = 0
  if (upstream) {
    const counts = await optionalGit(repoPath, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`])
    if (counts) {
      const [aheadText, behindText] = counts.split(/\s+/)
      ahead = Number(aheadText) || 0
      behind = Number(behindText) || 0
    }
  }

  return {
    repoPath,
    branch: branch || 'detached HEAD',
    shortSha,
    upstream,
    ahead,
    behind,
    changedFiles: statusOutput ? statusOutput.split('\n').length : 0,
    lastCommitAt,
    hasAgentInstructions,
    skillCount
  }
}

function summaryFor(snapshot: RepoSnapshot): string {
  const sync = snapshot.upstream
    ? `远端：领先 ${snapshot.ahead} / 落后 ${snapshot.behind}`
    : '未配置上游分支'
  const instructions = snapshot.hasAgentInstructions ? '已发现 AGENTS.md' : '缺少 AGENTS.md'
  return `${snapshot.branch} · ${snapshot.shortSha} · ${snapshot.changedFiles} 个未提交文件 · ${sync} · ${instructions} · ${snapshot.skillCount} 个项目 Skill`
}

export class RepoConnector implements ConnectorAdapter {
  readonly kind = 'repo' as const

  async test(context: ConnectorContext): Promise<ConnectorProbe> {
    const snapshot = await snapshotRepo(repoPathFrom(context.config))
    return {
      summary: `连接正常：${summaryFor(snapshot)}`,
      evidenceRefs: fileEvidence(snapshot.repoPath)
    }
  }

  async collect(context: ConnectorContext): Promise<ConnectorCollection> {
    const snapshot = await snapshotRepo(repoPathFrom(context.config))
    return {
      summary: summaryFor(snapshot),
      evidenceRefs: fileEvidence(snapshot.repoPath),
      signal: null
    }
  }
}
