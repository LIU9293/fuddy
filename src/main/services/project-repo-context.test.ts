import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectProjectRepoContext } from './project-repo-context'

const temporaryRepos: string[] = []

afterEach(() => {
  temporaryRepos.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
})

describe('collectProjectRepoContext', () => {
  it('collects generic project evidence without project-specific paths', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'project-context-'))
    temporaryRepos.push(repoPath)
    mkdirSync(join(repoPath, '.agents', 'skills', 'promotion'), { recursive: true })
    mkdirSync(join(repoPath, 'marketing'), { recursive: true })
    writeFileSync(join(repoPath, 'README.md'), '# Example\n\nCurrent product state.')
    writeFileSync(join(repoPath, 'package.json'), JSON.stringify({
      scripts: { test: 'vitest', typecheck: 'tsc --noEmit' },
      workspaces: ['apps/*']
    }))
    writeFileSync(join(repoPath, 'marketing', 'plan.md'), '# Plan')
    writeFileSync(join(repoPath, '.agents', 'skills', 'promotion', 'SKILL.md'), [
      '---',
      'name: promotion',
      'description: Prepare truthful promotion drafts.',
      '---'
    ].join('\n'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath })
    execFileSync('git', ['config', 'user.name', 'Fuddy Test'], { cwd: repoPath })
    execFileSync('git', ['add', '.'], { cwd: repoPath })
    execFileSync('git', ['commit', '-m', 'Add project plan'], { cwd: repoPath })
    writeFileSync(join(repoPath, 'marketing', 'plan.md'), '# Updated plan')

    const context = await collectProjectRepoContext(repoPath)

    expect(context.available).toBe(true)
    expect(context.branch).toBe('main')
    expect(context.readme).toContain('Current product state')
    expect(context.packageScripts).toEqual(['test', 'typecheck'])
    expect(context.localSkills).toEqual([
      { name: 'promotion', description: 'Prepare truthful promotion drafts.' }
    ])
    expect(context.changedPaths).toContain('marketing/plan.md')
    expect(context.trackedAreaCounts.marketing).toBe(1)
    expect(context.trackedPathSample).toContain('marketing/plan.md')
  })
})
