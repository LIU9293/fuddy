import { z } from 'zod'
export {
  commandUpdateSchema,
  encryptedCommandSchema as commandSchema,
  encryptedSyncEventBatchSchema as syncEventBatchSchema,
  encryptedSyncEventSchema as syncEventSchema
} from '../../../src/shared/companion-schemas'

const identifier = z.string().trim().min(1).max(200)
const isoDate = z.string().datetime({ offset: true })

export const pairingStartSchema = z.object({
  macDeviceId: identifier,
  macDeviceName: z.string().trim().min(1).max(200),
  publicKey: z.string().trim().max(2_000).nullable().optional()
})

export const pairingClaimSchema = z.object({
  accountId: identifier,
  pairingSecret: z.string().trim().min(20).max(500),
  deviceId: identifier,
  deviceName: z.string().trim().min(1).max(200),
  publicKey: z.string().trim().max(2_000).nullable().optional()
})

export const deviceEnrollmentSchema = z.object({
  deviceId: identifier,
  deviceName: z.string().trim().min(1).max(200),
  publicKey: z.string().trim().min(16).max(2_000)
})

export const pushRegistrationSchema = z.object({
  token: z.string().regex(/^[a-fA-F0-9]{32,256}$/)
})
