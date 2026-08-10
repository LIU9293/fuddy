import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitWorkingTreeChange, GitWorkingTreeSummary } from '../../shared/contracts'

const execFileAsync = promisify(execFile)
const MAX_CHANGED_PATHS = 80

async function git(workingDirectory: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd: workingDirectory,
    encoding: 'utf8',
    timeout: 8_000,
    maxBuffer: 2_000_000
  })
  return result.stdout
}

async function optionalGit(workingDirectory: string, args: string[]): Promise<string | null> {
  try {
    return await git(workingDirectory, args)
  } catch {
    return null
  }
}

export function parseGitNumstat(output: string): { additions: number; deletions: number } {
  return output.split('\n').reduce((total, line) => {
    const [added, deleted] = line.split('\t')
    return {
      additions: total.additions + (/^\d+$/.test(added ?? '') ? Number(added) : 0),
      deletions: total.deletions + (/^\d+$/.test(deleted ?? '') ? Number(deleted) : 0)
    }
  }, { additions: 0, deletions: 0 })
}

export function parseGitStatus(output: string): GitWorkingTreeChange[] {
  const records = output.split('\0').filter(Boolean)
  const changes: GitWorkingTreeChange[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    const code = record.slice(0, 2)
    let path = record.slice(3)
    if (code.includes('R') || code.includes('C')) {
      path = records[index + 1] ?? path
      index += 1
    }
    changes.push({ path, status: code.trim() || '?' })
  }
  return changes
}

export async function collectGitWorkingTreeSummary(workingDirectory: string): Promise<GitWorkingTreeSummary> {
  const repoRoot = (await optionalGit(workingDirectory, ['rev-parse', '--show-toplevel']))?.trim() ?? null
  if (!repoRoot) {
    return {
      available: false,
      repoRoot: null,
      branch: null,
      head: null,
      additions: 0,
      deletions: 0,
      changedFileCount: 0,
      changes: [],
      error: '当前 Workspace 不是 Git 仓库。'
    }
  }

  const [branchOutput, headOutput, statusOutput, headDiff] = await Promise.all([
    optionalGit(repoRoot, ['branch', '--show-current']),
    optionalGit(repoRoot, ['rev-parse', '--short', 'HEAD']),
    optionalGit(repoRoot, ['status', '--porcelain=v1', '-z']),
    optionalGit(repoRoot, ['diff', '--numstat', 'HEAD'])
  ])
  let stats = headDiff === null ? null : parseGitNumstat(headDiff)
  if (!stats) {
    const [unstaged, staged] = await Promise.all([
      optionalGit(repoRoot, ['diff', '--numstat']),
      optionalGit(repoRoot, ['diff', '--cached', '--numstat'])
    ])
    const workingStats = parseGitNumstat(unstaged ?? '')
    const stagedStats = parseGitNumstat(staged ?? '')
    stats = {
      additions: workingStats.additions + stagedStats.additions,
      deletions: workingStats.deletions + stagedStats.deletions
    }
  }

  const changes = parseGitStatus(statusOutput ?? '')
  return {
    available: true,
    repoRoot,
    branch: branchOutput?.trim() || null,
    head: headOutput?.trim() || null,
    additions: stats.additions,
    deletions: stats.deletions,
    changedFileCount: changes.length,
    changes: changes.slice(0, MAX_CHANGED_PATHS),
    error: null
  }
}
