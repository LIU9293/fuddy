import { SELF, env, evictDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

const envelope = {
  algorithm: 'A256GCM' as const,
  keyId: 'keyidentifier123',
  nonce: '0123456789abcdef',
  ciphertext: 'opaque_ciphertext_AQID'
}

describe('isolated project relay', () => {
  it('keeps each project in a distinct Durable Object with ordered, idempotent events', async () => {
    const projectId = crypto.randomUUID()
    const otherProjectId = crypto.randomUUID()
    const relay = env.PROJECT_RELAY.getByName(projectId)
    const event = {
      eventId: crypto.randomUUID(), keyEpoch: 1, kind: 'chat' as const, envelope,
      actorUserId: crypto.randomUUID(), sourceDeviceId: crypto.randomUUID()
    }
    const first = await relay.appendEvent(projectId, event)
    expect(first).toMatchObject({ ...event, projectId, sequence: 1 })
    expect(await relay.appendEvent(projectId, event)).toEqual(first)
    expect(await relay.appendEvent(projectId, { ...event, kind: 'message' })).toBe('conflict')
    const second = await relay.appendEvent(projectId, { ...event, eventId: crypto.randomUUID() })
    expect(second).toMatchObject({ sequence: 2 })
    await evictDurableObject(relay)
    expect(await relay.listEvents(projectId, 1, 10)).toEqual([second])
    expect(await env.PROJECT_RELAY.getByName(otherProjectId).listEvents(otherProjectId, 0, 10)).toEqual([])
  })

  it('does not expose a public project event route on the Relay worker', async () => {
    const response = await SELF.fetch('https://relay.test/v1/project-events')
    expect(response.status).toBe(404)
  })

  it('commits a paged baseline before compacting only that Mac’s earlier events', async () => {
    const projectId = crypto.randomUUID()
    const relay = env.PROJECT_RELAY.getByName(projectId)
    const sourceDeviceId = crypto.randomUUID()
    const otherDeviceId = crypto.randomUUID()
    const event = (source: string) => ({
      eventId: crypto.randomUUID(), keyEpoch: 1, kind: 'message' as const,
      envelope, actorUserId: crypto.randomUUID(), sourceDeviceId: source
    })
    await relay.appendEvent(projectId, event(sourceDeviceId))
    await relay.appendEvent(projectId, event(otherDeviceId))
    const baselineId = crypto.randomUUID()
    const baseline = await relay.beginBaseline(projectId, baselineId, sourceDeviceId, 1, 2)
    expect(baseline).toMatchObject({ baselineId, watermark: 1, chunkCount: 2 })
    const later = await relay.appendEvent(projectId, event(sourceDeviceId))
    const chunk0 = { baselineId, index: 0, envelope }
    expect(await relay.putBaselineChunk(projectId, sourceDeviceId, 1, chunk0)).toBe('ok')
    expect(await relay.putBaselineChunk(projectId, sourceDeviceId, 1, chunk0)).toBe('ok')
    expect(await relay.putBaselineChunk(projectId, sourceDeviceId, 1, {
      ...chunk0, envelope: { ...envelope, ciphertext: 'different' }
    })).toBe('conflict')
    expect(await relay.commitBaseline(projectId, baselineId, sourceDeviceId, 1)).toBe('incomplete')
    expect(await relay.putBaselineChunk(projectId, sourceDeviceId, 1,
      { baselineId, index: 1, envelope })).toBe('ok')
    expect(await relay.commitBaseline(projectId, baselineId, sourceDeviceId, 1)).toBe('ok')
    expect(await relay.commitBaseline(projectId, baselineId, sourceDeviceId, 1)).toBe('ok')
    await evictDurableObject(relay)
    expect(await relay.listBaselines(projectId)).toEqual([baseline])
    expect(await relay.listBaselineChunks(projectId, baselineId, -1, 1)).toEqual([chunk0])
    expect(await relay.listBaselineChunks(projectId, baselineId, 0, 10)).toEqual([
      { baselineId, index: 1, envelope }
    ])
    expect((await relay.listEvents(projectId, 0, 10)).map((item) => item.sequence))
      .toEqual([2, (later as { sequence: number }).sequence])

    const nextId = crypto.randomUUID()
    await relay.beginBaseline(projectId, nextId, sourceDeviceId, 2, 1)
    expect(await relay.putBaselineChunk(projectId, sourceDeviceId, 1,
      { baselineId: nextId, index: 0, envelope })).toBe('not-found')
    expect(await relay.commitBaseline(projectId, nextId, sourceDeviceId, 1)).toBe('not-found')
    expect(await relay.listBaselines(projectId)).toEqual([baseline])
  })
})
