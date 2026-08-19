export interface RelayAdministrationBinding {
  revokeDevice(accountId: string, deviceId: string, grantId?: string): Promise<boolean>
  setAccountGeneration(accountId: string, generation: number): Promise<void>
  revokeAccount(accountId: string, generation?: number): Promise<boolean>
}
