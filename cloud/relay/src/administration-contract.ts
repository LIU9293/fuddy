import type {
  SharedProjectBaseline, SharedProjectBaselineChunk, SharedProjectEncryptedEvent
} from '../../../src/shared/project-sharing-events'

export interface RelayAdministrationBinding {
  revokeDevice(accountId: string, deviceId: string, grantId?: string): Promise<boolean>
  claimAccountBinding(
    accountId: string,
    spaceId: string,
    bindingId: string,
    generation: number,
    proof: string
  ): Promise<boolean>
  confirmAccountBinding(accountId: string, spaceId: string, bindingId: string): Promise<boolean>
  releaseAccountBinding(accountId: string, spaceId: string, bindingId: string): Promise<boolean>
  setAccountGeneration(
    accountId: string,
    spaceId: string,
    bindingId: string | null,
    generation: number
  ): Promise<boolean>
  revokeAccount(
    accountId: string,
    spaceId: string,
    bindingId: string | null,
    generation: number
  ): Promise<boolean>
}

export interface ProjectRelayAdministrationBinding {
  appendProjectEvent(
    projectId: string,
    input: Omit<SharedProjectEncryptedEvent, 'projectId' | 'sequence' | 'createdAt'>
  ): Promise<SharedProjectEncryptedEvent | 'conflict' | 'snapshot-required'>
  listProjectEvents(projectId: string, after: number, limit: number,
    keyEpoch: number): Promise<SharedProjectEncryptedEvent[]>
  beginProjectBaseline(projectId: string, baselineId: string, sourceDeviceId: string,
    keyEpoch: number, chunkCount: number): Promise<SharedProjectBaseline | 'conflict'>
  putProjectBaselineChunk(projectId: string, sourceDeviceId: string, keyEpoch: number,
    chunk: SharedProjectBaselineChunk): Promise<'ok' | 'conflict' | 'not-found'>
  commitProjectBaseline(projectId: string, baselineId: string,
    sourceDeviceId: string, keyEpoch: number): Promise<'ok' | 'incomplete' | 'not-found'>
  listProjectBaselines(projectId: string): Promise<SharedProjectBaseline[]>
  listProjectBaselineChunks(projectId: string, baselineId: string,
    afterIndex: number, limit: number): Promise<SharedProjectBaselineChunk[]>
}
