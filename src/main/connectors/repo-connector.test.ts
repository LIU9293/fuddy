import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RepoConnector } from './repo-connector'

const temporaryRepos: string[] = []

function createRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'project-agent-repo-'))
  temporaryRepos.push(repoPath)
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath })
  execFileSync('git', ['config', 'user.name', 'Fuddy Test'], { cwd: repoPath })
  writeFileSync(join(repoPath, 'README.md'), '# Test Repo\n')
  writeFileSync(join(repoPath, 'AGENTS.md'), '# Test instructions\n')
  execFileSync('git', ['add', 'README.md', 'AGENTS.md'], { cwd: repoPath })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath })
  return repoPath
}

afterEach(() => {
  for (const repoPath of temporaryRepos.splice(0)) {
    rmSync(repoPath, { recursive: true, force: true })
  }
})

describe('RepoConnector', () => {
  it('returns a healthy snapshot without reading file contents', async () => {
    const repoPath = createRepo()
    const connector = new RepoConnector()

    const result = await connector.collect({ config: { repoPath }, credentialRef: null })

    expect(result.summary).toContain('main')
    expect(result.summary).toContain('0 个未提交文件')
    expect(result.summary).toContain('已发现 AGENTS.md')
    expect(result.signal).toBeNull()
  })

  it('keeps ordinary worktree changes in connector status without creating inbox noise', async () => {
    const repoPath = createRepo()
    const connector = new RepoConnector()
    writeFileSync(join(repoPath, 'README.md'), '# Changed without any secret scanning\n')

    const result = await connector.collect({ config: { repoPath }, credentialRef: null })

    expect(result.summary).toContain('1 个未提交文件')
    expect(result.signal).toBeNull()
  })

  it('rejects relative paths', async () => {
    const connector = new RepoConnector()
    await expect(
      connector.collect({ config: { repoPath: '../somewhere' }, credentialRef: null })
    ).rejects.toThrow('绝对路径')
  })
})
