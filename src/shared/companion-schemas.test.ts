import { describe, expect, it } from 'vitest'
import { testProject } from '../main/test-support/project-fixtures'
import { companionProtocolVersion } from './companion-sync'
import { syncEventSchema } from './companion-schemas'

function projectEvent(payload: unknown): Record<string, unknown> {
  return {
    eventId: 'event-1',
    protocolVersion: companionProtocolVersion,
    type: 'project.created',
    entityType: 'project',
    entityId: 'project-1',
    revision: 1,
    occurredAt: '2026-08-14T15:00:00.000Z',
    payload
  }
}

describe('Companion wire schemas', () => {
  it('validates the complete nested project contract', () => {
    const project = testProject('project-1', 'Project One')
    const parsed = syncEventSchema.safeParse(projectEvent(project))
    expect(parsed.success).toBe(true)

    const invalid = structuredClone(project) as unknown as Record<string, unknown>
    const profile = invalid.profile as Record<string, unknown>
    delete profile.currentState
    const rejected = syncEventSchema.safeParse(projectEvent(invalid))
    expect(rejected.success).toBe(false)
    if (!rejected.success) {
      expect(rejected.error.issues[0]?.path).toEqual(['payload', 'profile', 'currentState'])
    }
  })

  it('normalizes unknown fields out of known payload versions', () => {
    const parsed = syncEventSchema.parse(projectEvent({
      ...testProject('project-1', 'Project One'),
      accidentalSecret: 'must-not-cross-the-wire'
    }))

    expect(parsed.payload).not.toHaveProperty('accidentalSecret')
  })
})
