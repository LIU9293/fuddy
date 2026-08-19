import type { Capability, CreateProjectInput } from './contracts'

export type AccountServiceStatus = 'ready' | 'offline' | 'configuration-required'
export type AccountOnboardingStep = 'detect-agent' | 'add-project' | 'complete'

export interface AccountUser {
  id: string
  email: string
  displayName: string | null
}

export interface AccountDevice {
  id: string
  platform: 'macos' | 'ios'
  name: string
  hostId: string | null
  syncSpaceId: string | null
}

export interface AccountDeviceSummary {
  id: string
  platform: 'macos' | 'ios'
  name: string
  appVersion: string
  protocolVersion: number
  createdAt: string
  lastSeenAt: string
  isCurrent: boolean
}

export interface AccountIdentity {
  provider: 'email' | 'google'
  email: string
  createdAt: string
  lastUsedAt: string
}

export interface AccountOnboardingState {
  step: AccountOnboardingStep
  completedAt: string | null
}

export interface AccountState {
  status: 'signed-out' | 'signed-in'
  serviceStatus: AccountServiceStatus
  serviceMessage: string | null
  user: AccountUser | null
  device: AccountDevice | null
  onboarding: AccountOnboardingState | null
  availableProviders: {
    email: true
    google: boolean
  }
  existingProjectCount: number
}

export interface StartEmailSignInResult {
  challengeId: string
  email: string
  expiresAt: string
  retryAfterSeconds: number
  /** Only returned by an explicitly configured non-production Account API. */
  debugCode?: string
}

export interface VerifyEmailSignInInput {
  challengeId: string
  code: string
}

export interface CompleteProjectOnboardingInput {
  project: CreateProjectInput | null
}

export interface AgentDetectionResult {
  capabilities: Capability[]
  readyAgentIds: string[]
}

export interface AccountPendingEnrollment {
  id: string
  spaceId: string
  deviceId: string
  deviceName: string
  publicKey: string
  expiresAt: string
}

export interface AccountEnrollmentPage {
  syncSpace: {
    id: string
    keyVersion: number
    relayUrl: string
    relayAccountId: string
  }
  enrollments: AccountPendingEnrollment[]
  revocations?: Array<{
    id: string
    deviceId: string
  }>
}
