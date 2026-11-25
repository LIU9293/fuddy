import { z } from 'zod'
import { builtInAgentProviders } from './agent-providers'

export const agentRunProviderSchema = z.union([
  z.enum(builtInAgentProviders),
  z.templateLiteral(['acp-', z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/u)])
], '未知 Agent')
