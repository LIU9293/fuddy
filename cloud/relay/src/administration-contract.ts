export interface RelayAdministrationBinding {
  revokeDevice(accountId: string, deviceId: string, grantId?: string): Promise<boolean>
  revokeAccount(accountId: string): Promise<void>
}
