import { describe, expect, it } from 'vitest'
import { generateSharedProjectKey } from './project-sharing-events'
import { openSharedProjectCommand, sealSharedProjectCommand, sharedProjectCommandPayloadSchema,
  type SharedProjectCommand } from './project-sharing-commands'

describe('shared project command encryption', () => {
  it('accepts an optional supported Agent when creating a Chat', () => {
    expect(sharedProjectCommandPayloadSchema.safeParse({ type: 'create-chat', title: 'Chat' }).success).toBe(true)
    expect(sharedProjectCommandPayloadSchema.safeParse({ type: 'create-chat', title: 'Chat', provider: 'claude' }).success).toBe(true)
    expect(sharedProjectCommandPayloadSchema.safeParse({ type: 'create-chat', title: 'Chat', provider: 'other' }).success).toBe(false)
  })

  it('binds ciphertext to the server-authenticated actor and target operation', async () => {
    const key = generateSharedProjectKey()
    const identity = {
      projectId: crypto.randomUUID(), commandId: crypto.randomUUID(),
      type: 'send-message' as const, runId: crypto.randomUUID(),
      requestId: crypto.randomUUID(), keyEpoch: 1, actorUserId: crypto.randomUUID()
    }
    const sealed = await sealSharedProjectCommand(key, identity,
      { type: 'send-message', prompt: '协作消息' })
    const command = { ...identity, ...sealed, authorSnapshot: { displayName: '成员', avatarRef: null },
      sourceDeviceId: crypto.randomUUID(), targetHostId: crypto.randomUUID(),
      permissionRevision: 2, status: 'claimed' as const, leaseExpiresAt: null,
      resultRunId: null, errorCode: null, createdAt: '', updatedAt: '' } satisfies SharedProjectCommand
    expect(await openSharedProjectCommand(key, command)).toEqual({ type: 'send-message', prompt: '协作消息' })
    await expect(openSharedProjectCommand(key, { ...command, actorUserId: crypto.randomUUID() }))
      .rejects.toThrow()
    await expect(openSharedProjectCommand(key, { ...command, runId: crypto.randomUUID() }))
      .rejects.toThrow()
    await expect(openSharedProjectCommand(key, { ...command, keyEpoch: 2 }))
      .rejects.toThrow()
  })
})
