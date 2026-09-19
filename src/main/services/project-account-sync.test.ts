import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './database'
import type { ProjectGoal } from '../../shared/contracts'

const directories: string[] = []
const databases: AppDatabase[] = []
function database(): { db: AppDatabase; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'fuddy-account-project-'))
  directories.push(directory)
  const path = join(directory, 'app.sqlite')
  const db = new AppDatabase(path)
  databases.push(db)
  return { db, path }
}
const input = { name: '同名项目', summary: '项目简介', focus: '开发', mission: '完成产品', vision: '产品愿景', stage: '开发中', productType: '软件', workspacePath: '/mac-a/main' }
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('account project metadata and Mac-local workspaces', () => {
  it('assigns a new project to the signed-in account before the next peer sync', () => {
    const db = database().db
    db.setSetting('account.cached-state', { user: { id: 'account-a' } })
    const project = db.createProject(input)
    db.setSetting('account.cached-state', { user: { id: 'account-b' } })
    expect(db.accountProjects('account-b')).toEqual([])
    expect(db.listProjects()).toEqual([])
    db.setSetting('account.cached-state', { user: { id: 'account-a' } })
    expect(db.listProjects()[0].id).toBe(project.id)
  })
  it('shares goals and milestones while keeping scheduled check-ins on the originating Mac', () => {
    const a = database().db
    const b = database().db
    a.setSetting('account.cached-state', { user: { id: 'user' }, device: { hostId: 'mac-a' } })
    b.setSetting('account.cached-state', { user: { id: 'user' }, device: { hostId: 'mac-b' } })
    const project = a.createProject(input)
    const imported = b.mergeAccountProject(project, 'user')
    const now = '2020-01-01T00:00:00.000Z'
    const goal: ProjectGoal = { id: 'goal-one', projectId: project.id, title: '共同目标', description: '验证两台 Mac', status: 'active', priority: 'P1', metric: { label: '完成度', unit: '%', baseline: null, current: null, target: null }, deadline: null, nextCheckInAt: now, progress: 0, confidence: 0, agentSummary: '', monitoringSources: [], createdBy: 'user', createdAt: now, updatedAt: now, completedAt: null, checkIns: [],
      milestones: [{ id: 'milestone-one', goalId: 'goal-one', title: '第一步', status: 'pending', dueAt: null, evidenceRefs: [], sortOrder: 0, createdAt: now, updatedAt: now, completedAt: null }] }
    a.createGoal(goal)
    b.mergeAccountGoal(a.listGoals()[0], imported.id, 'mac-a')
    expect(b.listGoals()[0]).toMatchObject({ id: goal.id, projectId: imported.id, executionHostId: 'mac-a' })
    expect(b.canScheduleGoalHere(b.listGoals()[0])).toBe(false)
    expect(a.canScheduleGoalHere(a.listGoals()[0])).toBe(true)
    b.deleteGoalMilestone(goal.id, 'milestone-one')
    a.mergeAccountGoal(b.listGoals()[0], project.id, 'mac-b')
    expect(a.listGoals()[0].milestones).toEqual([])
    expect(a.listGoals()[0].executionHostId).toBe('mac-a')
  })
  it('shares identity and metadata while preserving each Mac’s primary and additional folders', () => {
    const a = database().db
    const b = database().db
    const first = a.createProject(input)
    const imported = b.mergeAccountProject(first, 'account-one')
    expect(imported.shared).toEqual(first.shared)
    expect(imported.profile.repoPath).toBe('')
    expect(imported.profile.workspaceRoots).toEqual([])
    const configured = b.updateProject({ ...imported, profile: { ...imported.profile,
      workspaceRoots: [{ id: 'main', label: '主目录', path: '/mac-b/main' }, { id: 'docs', label: '文档', path: '/mac-b/docs' }], primaryWorkspaceRootId: 'main' } })
    expect(configured.shared).toEqual(imported.shared)
    expect(a.mergeAccountProject(configured, 'account-one').profile.repoPath).toBe('/mac-a/main')
    const updated = a.updateProject({ ...first, summary: '新的共享简介' })
    const merged = b.mergeAccountProject(updated, 'account-one')
    expect(merged.summary).toBe('新的共享简介')
    expect(merged.profile.repoPath).toBe('/mac-b/main')
    expect(merged.profile.workspaceRoots).toHaveLength(2)
    expect(() => b.updateProject({ ...configured, summary: '过期页面的编辑' })).toThrow('另一台 Mac')
  })

  it('keeps local paths out of persisted shared profiles and preserves settings after reopening', () => {
    const { db, path } = database()
    const project = db.createProject(input)
    const sql = new DatabaseSync(path)
    const profile = JSON.parse(String(sql.prepare('SELECT profile_json FROM projects WHERE id=?').get(project.id)!.profile_json))
    expect(profile.repoPath).toBeUndefined()
    expect(profile.workspaceRoots).toBeUndefined()
    expect(String(sql.prepare('SELECT configuration_json FROM project_local_workspaces WHERE project_id=?').get(project.id)!.configuration_json)).toContain('/mac-a/main')
    sql.close()
    const reopened = new AppDatabase(path)
    databases.push(reopened)
    expect(reopened.listProjects()[0]).toEqual(project)
  })

  it('converges concurrent metadata edits without merging independent projects by name', () => {
    const a = database().db
    const b = database().db
    const first = a.createProject(input)
    const independent = b.createProject(input)
    const imported = b.mergeAccountProject(first, 'account-one')
    expect(imported.id).not.toBe(independent.id)
    expect(independent.shared?.id).not.toBe(first.shared?.id)
    const editA = a.updateProject({ ...first, summary: 'A 的编辑' })
    const editB = b.updateProject({ ...imported, summary: 'B 的编辑' })
    expect(a.mergeAccountProject(editB, 'account-one').summary).toBe(b.mergeAccountProject(editA, 'account-one').summary)
    expect(b.accountProjects('account-two')).toEqual([])
    expect(b.mergeAccountProject(first, 'account-one').profile.repoPath).toBe('')
    b.setSetting('account.cached-state', { user: { id: 'account-two' } })
    expect(b.listProjects()).toEqual([])
  })

  it.each([undefined, null, { user: { id: 'account-a' } }])('migrates a version 8 project with account cache %j without changing its local identity', (accountCache) => {
    const { db, path } = database()
    const project = db.createProject(input)
    if (accountCache !== undefined) db.setSetting('account.cached-state', accountCache)
    const profile = { ...project.profile, workspaceRoots: [
      { id: 'main', label: '主目录', path: '/legacy/main' },
      { id: 'extra', label: '附加目录', path: '/legacy/extra' }
    ], primaryWorkspaceRootId: 'extra', repoPath: '/legacy/extra' }
    const sql = new DatabaseSync(path)
    sql.prepare('UPDATE projects SET profile_json=? WHERE id=?').run(JSON.stringify(profile), project.id)
    sql.exec('DROP TABLE project_local_workspaces; PRAGMA user_version=8')
    sql.close()
    const upgraded = new AppDatabase(path)
    databases.push(upgraded)
    const migrated = upgraded.listProjects()[0]
    expect(migrated.id).toBe(project.id)
    expect(migrated.profile.workspaceRoots).toEqual(profile.workspaceRoots)
    expect(migrated.profile.repoPath).toBe('/legacy/extra')
    expect(migrated.profile.primaryWorkspaceRootId).toBe('extra')
    expect(migrated.shared?.id).toBeTruthy()
    upgraded.setSetting('account.cached-state', null)
    expect(upgraded.createProject({ ...input, name: '退出账户后的项目' }).name).toBe('退出账户后的项目')
  })
})
