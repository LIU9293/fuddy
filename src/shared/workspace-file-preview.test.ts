import { describe, expect, it } from 'vitest'
import { parseWorkspaceFilePreviewUrl, workspaceFilePreviewUrl } from './workspace-file-preview'

describe('workspace file preview URLs', () => {
  it('round-trips project and shared file paths without exposing absolute paths', () => {
    expect(parseWorkspaceFilePreviewUrl(workspaceFilePreviewUrl('vows', 'reports/发布 计划.pdf'))).toEqual({
      projectId: 'vows',
      relativePath: 'reports/发布 计划.pdf'
    })
    expect(parseWorkspaceFilePreviewUrl(workspaceFilePreviewUrl(null, '共享/report.pdf'))).toEqual({
      projectId: null,
      relativePath: '共享/report.pdf'
    })
  })

  it('rejects unrelated or incomplete URLs', () => {
    expect(parseWorkspaceFilePreviewUrl('https://example.com/report.pdf')).toBeNull()
    expect(parseWorkspaceFilePreviewUrl('fuddy-file://other/vows/report.pdf')).toBeNull()
    expect(parseWorkspaceFilePreviewUrl('fuddy-file://workspace/vows')).toBeNull()
  })
})
