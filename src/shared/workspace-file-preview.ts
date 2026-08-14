export const workspaceFilePreviewScheme = 'fuddy-file'

export interface WorkspaceFilePreviewTarget {
  projectId: string | null
  relativePath: string
}

export function workspaceFilePreviewUrl(projectId: string | null, relativePath: string): string {
  const projectSegment = encodeURIComponent(projectId ?? '_shared')
  const path = relativePath.split('/').filter(Boolean).map(encodeURIComponent).join('/')
  return `${workspaceFilePreviewScheme}://workspace/${projectSegment}/${path}`
}

export function parseWorkspaceFilePreviewUrl(value: string): WorkspaceFilePreviewTarget | null {
  try {
    const url = new URL(value)
    if (url.protocol !== `${workspaceFilePreviewScheme}:` || url.hostname !== 'workspace') return null
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const projectSegment = segments.shift()
    if (!projectSegment || segments.length === 0) return null
    return {
      projectId: projectSegment === '_shared' ? null : projectSegment,
      relativePath: segments.join('/')
    }
  } catch {
    return null
  }
}
