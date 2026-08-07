import type { ProjectProfile, ProjectWorkspaceRoot } from './contracts'

function basename(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '').split('/').pop() ?? ''
}

function slug(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return normalized || 'workspace'
}

export function normalizeWorkspaceRoots(input: {
  workspaceRoots?: ProjectWorkspaceRoot[] | null
  primaryWorkspaceRootId?: string | null
  repoPath?: string | null
}): { workspaceRoots: ProjectWorkspaceRoot[]; primaryWorkspaceRootId: string | null; repoPath: string } {
  const usedIds = new Set<string>()
  const usedPaths = new Set<string>()
  const workspaceRoots = (input.workspaceRoots ?? []).flatMap<ProjectWorkspaceRoot>((root, index) => {
    const path = root.path.trim()
    if (!path || usedPaths.has(path)) return []
    usedPaths.add(path)
    const baseId = slug(root.id || root.label || basename(path))
    let id = baseId
    let suffix = 2
    while (usedIds.has(id)) id = `${baseId}-${suffix++}`
    usedIds.add(id)
    return [{ id, label: root.label.trim() || basename(path) || `Workspace ${index + 1}`, path }]
  })

  const legacyPath = input.repoPath?.trim() ?? ''
  if (workspaceRoots.length === 0 && legacyPath) {
    workspaceRoots.push({ id: 'primary', label: basename(legacyPath) || 'Primary workspace', path: legacyPath })
  }
  const requestedPrimary = input.primaryWorkspaceRootId?.trim() || null
  const primaryWorkspaceRootId = workspaceRoots.some((root) => root.id === requestedPrimary)
    ? requestedPrimary
    : workspaceRoots[0]?.id ?? null
  const repoPath = workspaceRoots.find((root) => root.id === primaryWorkspaceRootId)?.path ?? ''
  return { workspaceRoots, primaryWorkspaceRootId, repoPath }
}

export function primaryWorkspaceRoot(profile: Pick<ProjectProfile, 'workspaceRoots' | 'primaryWorkspaceRootId' | 'repoPath'>): ProjectWorkspaceRoot | null {
  const normalized = normalizeWorkspaceRoots(profile)
  return normalized.workspaceRoots.find((root) => root.id === normalized.primaryWorkspaceRootId) ?? null
}
