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
