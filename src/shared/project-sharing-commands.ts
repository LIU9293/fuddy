import { z } from 'zod'
import { openCompanionJson, sealCompanionJson,
  type CompanionEncryptedEnvelope } from './companion-crypto'
import type { ChatAuthorSnapshot } from './project-sharing'
import { sharedAttachmentSchema } from './project-sharing-attachments'

export const sharedProjectCommandPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create-chat'), title: z.string().trim().min(1).max(200),
    provider: z.enum(['pi', 'codex', 'claude', 'opencode']).optional() }).strict(),
  z.object({ type: z.literal('send-message'), prompt: z.string().trim().min(1).max(200_000),
    attachments: z.array(sharedAttachmentSchema).max(4).optional() }).strict(),
  z.object({ type: z.literal('cancel-turn') }).strict(),
  z.object({ type: z.literal('stop-turn') }).strict(),
  z.object({ type: z.literal('rename-chat'), title: z.string().trim().min(1).max(200) }).strict(),
  z.object({ type: z.literal('archive-chat') }).strict()
])

export type SharedProjectCommandPayload = z.infer<typeof sharedProjectCommandPayloadSchema>
export type SharedProjectCommandType = SharedProjectCommandPayload['type']
export type SharedProjectCommandStatus = 'pending' | 'claimed' | 'completed'
  | 'failed' | 'cancelled' | 'interrupted'

export interface SharedProjectCommand {
  commandId: string
  projectId: string
  runId: string | null
  requestId: string | null
  type: SharedProjectCommandType
  actorUserId: string
  authorSnapshot: ChatAuthorSnapshot
  sourceDeviceId: string
  targetHostId: string
  keyEpoch: number
  permissionRevision: number
  envelope: CompanionEncryptedEnvelope
  status: SharedProjectCommandStatus
  leaseExpiresAt: string | null
  resultRunId: string | null
  errorCode: string | null
  createdAt: string
  updatedAt: string
}

export type SharedProjectCommandSubmission = Pick<SharedProjectCommand,
  'commandId' | 'type' | 'runId' | 'requestId' | 'keyEpoch' | 'envelope'>

export interface SharedProjectMemberActivity {
  drafts: Array<{ runId: string; title: string }>
  activeTurns: Array<{ commandId: string; runId: string; requestId: string }>
}

export function sharedProjectCommandAssociatedData(command: Pick<SharedProjectCommand,
  'projectId' | 'commandId' | 'type' | 'runId' | 'requestId' | 'keyEpoch' | 'actorUserId'
>): string {
  return [
    'fuddy:shared-project-command:v1', command.projectId, command.keyEpoch,
    command.commandId, command.type, command.runId ?? '-', command.requestId ?? '-',
    command.actorUserId
  ].join(':')
}

export async function sealSharedProjectCommand(
  projectKey: string,
  identity: Pick<SharedProjectCommand,
    'projectId' | 'commandId' | 'type' | 'runId' | 'requestId' | 'keyEpoch' | 'actorUserId'>,
  payload: SharedProjectCommandPayload
): Promise<SharedProjectCommandSubmission> {
  const parsed = sharedProjectCommandPayloadSchema.parse(payload)
  if (parsed.type !== identity.type) throw new Error('命令类型不匹配。')
  return {
    commandId: identity.commandId, type: identity.type, runId: identity.runId,
    requestId: identity.requestId, keyEpoch: identity.keyEpoch,
    envelope: await sealCompanionJson(projectKey, parsed, sharedProjectCommandAssociatedData(identity))
  }
}

export async function openSharedProjectCommand(
  projectKey: string, command: SharedProjectCommand
): Promise<SharedProjectCommandPayload> {
  const plaintext = await openCompanionJson<unknown>(projectKey, command.envelope,
    sharedProjectCommandAssociatedData(command))
  const payload = sharedProjectCommandPayloadSchema.parse(plaintext)
  if (payload.type !== command.type) throw new Error('命令类型不匹配。')
  return payload
}
