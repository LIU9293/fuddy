import { z } from 'zod'

const flowId = z.string().trim().min(1).max(200)

export const antigravitySetupInputSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.enum(['status', 'install', 'sign-in', 'open-sign-in']) }),
  z.object({ operation: z.literal('cancel-sign-in'), flowId }),
  z.object({ operation: z.literal('finish-sign-in'), flowId, callbackUrl: z.string().trim().min(1).max(16_384) })
])
export type AntigravitySetupInput = z.infer<typeof antigravitySetupInputSchema>

export const antigravitySetupStateSchema = z.object({
  installPhase: z.enum(['idle', 'downloading', 'extracting', 'verifying', 'succeeded', 'failed', 'cancelled']),
  authPhase: z.enum(['idle', 'starting', 'waiting', 'verifying', 'succeeded', 'failed', 'cancelled']),
  installed: z.boolean(),
  flowId: flowId.nullable(),
  canOpenSignIn: z.boolean()
})
export type AntigravitySetupState = z.infer<typeof antigravitySetupStateSchema>
