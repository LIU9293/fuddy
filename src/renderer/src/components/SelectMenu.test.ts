import { describe, expect, it } from 'vitest'
import { moveMenuIndex } from './SelectMenu'

describe('moveMenuIndex', () => {
  it('wraps through menu options with arrow keys', () => {
    expect(moveMenuIndex(0, 3, 'ArrowDown')).toBe(1)
    expect(moveMenuIndex(2, 3, 'ArrowDown')).toBe(0)
    expect(moveMenuIndex(0, 3, 'ArrowUp')).toBe(2)
  })

  it('moves directly to the first or last option', () => {
    expect(moveMenuIndex(2, 4, 'Home')).toBe(0)
    expect(moveMenuIndex(0, 4, 'End')).toBe(3)
  })
})
