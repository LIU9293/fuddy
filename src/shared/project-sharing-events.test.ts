import { describe, expect, it } from 'vitest'
import { generateSharedProjectKey, openSharedProjectEvent, sealSharedProjectEvent } from './project-sharing-events'

describe('shared project encryption', () => {
  it('binds ciphertext to project, epoch, event and kind', async () => {
    const projectKey = generateSharedProjectKey()
    const identity = {
      projectId: crypto.randomUUID(), eventId: crypto.randomUUID(), keyEpoch: 1, kind: 'message' as const
    }
    const payload = {
      id: crypto.randomUUID(), runId: crypto.randomUUID(), role: 'user' as const,
      content: '你好', authorUserId: crypto.randomUUID(), authorSnapshot: {
        displayName: '成员', avatarRef: null
      }, createdAt: new Date().toISOString()
    }
    const submission = await sealSharedProjectEvent(projectKey, identity, payload)
    const event = { ...identity, ...submission, sequence: 1,
      actorUserId: payload.authorUserId, sourceDeviceId: crypto.randomUUID(), createdAt: payload.createdAt }
    expect(await openSharedProjectEvent(projectKey, event)).toEqual(payload)
    await expect(openSharedProjectEvent(projectKey, { ...event, projectId: crypto.randomUUID() }))
      .rejects.toThrow()
    await expect(openSharedProjectEvent(projectKey, { ...event, keyEpoch: 2 })).rejects.toThrow()
    await expect(openSharedProjectEvent(projectKey, { ...event, kind: 'chat' })).rejects.toThrow()
    await expect(openSharedProjectEvent(generateSharedProjectKey(), event)).rejects.toThrow()
  })
})
