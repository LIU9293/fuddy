import { z } from 'zod'

/** Display metadata only. Never store raw account responses, identities or credentials. */
export const agentAccountContextSchema = z.object({
  provider: z.enum(['codex', 'claude', 'opencode']),
  observedAt: z.string().datetime(),
  authMode: z.enum(['subscription', 'api', 'unknown']),
  plan: z.string().max(80).optional(),
  apiProvider: z.string().max(80).optional(),
  model: z.string().max(160).optional(),
  limits: z.array(z.object({
    name: z.string().max(100),
    usedPercent: z.number().min(0).max(100).optional(),
    windowMinutes: z.number().positive().optional(),
    resetsAt: z.string().datetime().optional(),
    status: z.enum(['allowed', 'allowed_warning', 'rejected']).optional()
  })).max(32),
  turnUsage: z.object({
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    estimatedCostUsd: z.number().nonnegative().optional()
  }).optional()
})

export type AgentAccountContext = z.infer<typeof agentAccountContextSchema>
