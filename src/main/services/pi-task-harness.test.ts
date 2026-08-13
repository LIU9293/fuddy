import { describe, expect, it } from 'vitest'
import { piToolResultMetadata } from './pi-task-harness'

describe('PiTaskHarness tool persistence', () => {
  it('preserves failed terminal status when persisting a Pi tool result', () => {
    expect(piToolResultMetadata(
      { details: { exitCode: 1, status: 'completed' } },
      { command: 'false' },
      true
    )).toEqual({
      exitCode: 1,
      arguments: { command: 'false' },
      status: 'failed'
    })
  })

  it('marks successful Pi tool results as completed', () => {
    expect(piToolResultMetadata(
      { details: { exitCode: 0 } },
      { command: 'true' },
      false
    )).toEqual({
      exitCode: 0,
      arguments: { command: 'true' },
      status: 'completed'
    })
  })
})
