import {
  generateCompanionAccountKey, openCompanionBytes, openCompanionJson,
  sealCompanionBytes, sealCompanionJson,
  type CompanionEncryptedEnvelope
} from './companion-crypto'
import type { SharedChatView, SharedMessageView, SharedProjectView } from './project-sharing'
import type { SharedAttachmentView } from './project-sharing-attachments'

/** Ciphertext is scoped to one project and one key epoch; the service never sees plaintext. */
export interface SharedProjectEncryptedEvent {
  eventId: string
  projectId: string
  keyEpoch: number
  kind: 'snapshot' | 'chat' | 'message' | 'settings' | 'artifact'
  envelope: CompanionEncryptedEnvelope
  actorUserId: string
  sourceDeviceId: string
  sequence: number
  createdAt: string
}

export type SharedProjectEventSubmission = Pick<
  SharedProjectEncryptedEvent, 'eventId' | 'keyEpoch' | 'kind' | 'envelope'
>

/** A committed baseline replaces older events from one publishing Mac only. */
export interface SharedProjectBaseline {
  baselineId: string
  projectId: string
  sourceDeviceId: string
  keyEpoch: number
  watermark: number
  chunkCount: number
  createdAt: string
}

export interface SharedProjectBaselineChunk {
  baselineId: string
  index: number
  envelope: CompanionEncryptedEnvelope
}

export function sharedProjectBaselineAssociatedData(input: Pick<
  SharedProjectBaseline, 'projectId' | 'baselineId' | 'sourceDeviceId' | 'keyEpoch'
> & { index: number }): string {
  return `fuddy:shared-project-baseline:v1:${input.projectId}:${input.sourceDeviceId}:${input.keyEpoch}:${input.baselineId}:${input.index}`
}

export async function sealSharedProjectBaselineChunk(
  projectKey: string,
  identity: Pick<SharedProjectBaseline, 'projectId' | 'baselineId' | 'sourceDeviceId' | 'keyEpoch'> & { index: number },
  payload: Uint8Array
): Promise<SharedProjectBaselineChunk> {
  return {
    baselineId: identity.baselineId,
    index: identity.index,
    envelope: await sealCompanionBytes(projectKey, payload, sharedProjectBaselineAssociatedData(identity))
  }
}

export async function openSharedProjectBaselineChunk(
  projectKey: string,
  identity: Pick<SharedProjectBaseline, 'projectId' | 'baselineId' | 'sourceDeviceId' | 'keyEpoch'>,
  chunk: SharedProjectBaselineChunk
): Promise<Uint8Array> {
  return openCompanionBytes(
    projectKey, chunk.envelope, sharedProjectBaselineAssociatedData({ ...identity, index: chunk.index })
  )
}

export type SharedProjectEventPayload = SharedProjectView | SharedChatView | SharedMessageView | SharedAttachmentView

export interface SharedProjectBaselineData {
  version: 1
  project: SharedProjectView
  chats: SharedChatView[]
  messages: SharedMessageView[]
  artifacts?: SharedAttachmentView[]
  pendingSources?: string[]
}

export function generateSharedProjectKey(): string {
  return generateCompanionAccountKey()
}

export function sharedProjectEventAssociatedData(event: Pick<
  SharedProjectEncryptedEvent, 'projectId' | 'eventId' | 'keyEpoch' | 'kind'
>): string {
  return `fuddy:shared-project-event:v1:${event.projectId}:${event.keyEpoch}:${event.eventId}:${event.kind}`
}

export async function sealSharedProjectEvent(
  projectKey: string,
  identity: Pick<SharedProjectEncryptedEvent, 'projectId' | 'eventId' | 'keyEpoch' | 'kind'>,
  payload: SharedProjectEventPayload
): Promise<SharedProjectEventSubmission> {
  return {
    eventId: identity.eventId,
    keyEpoch: identity.keyEpoch,
    kind: identity.kind,
    envelope: await sealCompanionJson(projectKey, payload, sharedProjectEventAssociatedData(identity))
  }
}

export async function openSharedProjectEvent<T extends SharedProjectEventPayload>(
  projectKey: string,
  event: SharedProjectEncryptedEvent
): Promise<T> {
  return openCompanionJson<T>(projectKey, event.envelope, sharedProjectEventAssociatedData(event))
}
