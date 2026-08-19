import type { RelayAdministrationBinding } from '../../relay/src/administration-contract'

export type Environment = {
  ACCOUNT_DB: D1Database
  ENVIRONMENT: string
  EMAIL_DELIVERY_MODE: string
  OTP_PEPPER: string
  SESSION_TOKEN_PEPPER: string
  RESEND_FROM: string
  RESEND_API_KEY: string
  RESEND_WEBHOOK_SECRET: string
  GOOGLE_CLIENT_IDS: string
  /** Wrangler currently emits this named RPC entrypoint as a generic Fetcher. */
  RELAY_ADMIN?: RelayAdministrationBinding | Pick<Fetcher, 'fetch'>
}

export type DeviceInput = {
  id?: string
  platform: 'macos' | 'ios'
  name: string
  publicKey: string
  appVersion: string
  protocolVersion: number
}

export type AuthenticatedUser = {
  sessionId: string
  userId: string
  deviceId: string
  email: string
  displayName: string | null
}
