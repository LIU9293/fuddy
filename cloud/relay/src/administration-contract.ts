export interface RelayAdministrationBinding {
  revokeDevice(accountId: string, deviceId: string): Promise<boolean>
  revokeAccount(accountId: string): Promise<void>
}
