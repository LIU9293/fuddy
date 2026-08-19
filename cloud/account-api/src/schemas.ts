import { z } from 'zod'

export const deviceSchema = z.object({
  id: z.uuid().optional(),
  platform: z.enum(['macos', 'ios']),
  name: z.string().trim().min(1).max(100),
  publicKey: z.string().min(16).max(4096),
  appVersion: z.string().trim().min(1).max(50),
  protocolVersion: z.number().int().positive().max(1000)
})

export const startEmailSchema = z.object({
  email: z.email().max(254).transform((value) => value.trim().toLowerCase())
})

export const verifyEmailSchema = z.object({
  challengeId: z.uuid(),
  code: z.string().regex(/^\d{6}$/u),
  device: deviceSchema
})

export const googleSignInSchema = z.object({
  idToken: z.string().min(20),
  device: deviceSchema
})

export const googleIdentitySchema = z.object({
  idToken: z.string().min(20)
})

export const refreshSchema = z.object({
  refreshToken: z.string().min(20)
})

export const enrollmentSchema = z.object({
  deviceId: z.uuid()
})

export const completeEnrollmentSchema = z.object({
  wrappedSpaceKey: z.string().min(16).max(16384),
  keyVersion: z.number().int().positive().max(1_000_000)
})

export const relayBindingSchema = z.object({
  relayUrl: z.url().max(2048)
    .refine((value) => {
      const url = new URL(value)
      return !url.username && !url.password && !url.search && !url.hash
    }, 'Relay URL 不能包含凭证、查询参数或片段。')
    .transform((value) => {
      const url = new URL(value)
      const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/u, '')
      return `${url.origin}${pathname}`
    }),
  relayAccountId: z.string().trim().min(1).max(200),
  bindingProof: z.string().trim().min(20).max(500)
})

export const resendWebhookSchema = z.object({
  type: z.enum([
    'email.sent',
    'email.delivered',
    'email.delivery_delayed',
    'email.failed',
    'email.bounced',
    'email.complained',
    'email.suppressed'
  ]),
  created_at: z.iso.datetime({ offset: true }),
  data: z.object({
    email_id: z.string().trim().min(1).max(200)
  }).loose()
})
