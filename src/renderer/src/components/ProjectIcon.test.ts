import { describe, expect, it } from 'vitest'
import { isProjectImageIcon, projectIconText } from './ProjectIcon'

describe('projectIconText', () => {
  it('uses a configured icon', () => {
    expect(projectIconText({ name: 'Fuddy', icon: '🚀' })).toBe('🚀')
  })

  it('falls back to the uppercased first project-name character', () => {
    expect(projectIconText({ name: '  fuddy', icon: null })).toBe('F')
    expect(projectIconText({ name: '项目', icon: '  ' })).toBe('项')
  })

  it('recognizes raster image data without treating arbitrary text as an image', () => {
    expect(isProjectImageIcon('data:image/png;base64,iVBORw0KGgo=')).toBe(true)
    expect(isProjectImageIcon('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false)
    expect(isProjectImageIcon('🚀')).toBe(false)
  })
})
