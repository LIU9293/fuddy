import { describe, expect, it } from 'vitest'
import { projectNameFromPath } from './AccountOnboarding'

describe('projectNameFromPath', () => {
  it('uses the selected folder name for the first project', () => {
    expect(projectNameFromPath('/Users/kai/Code/Fuddy/')).toBe('Fuddy')
  })
})
