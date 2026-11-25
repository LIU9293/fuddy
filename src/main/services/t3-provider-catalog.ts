import { z } from 'zod'
import { agentProviderLabel, agentRunProviders, isAgentRunProvider } from '../../shared/agent-providers'
import type { AgentRunProvider, CodingAgentModelCatalog, CodingAgentModelCatalogEntry } from '../../shared/contracts'
import type { T3RuntimeProcess } from './t3-runtime-process'
import { antigravitySetupStateSchema, type AntigravitySetupInput } from '../../shared/antigravity-setup'

const providerSnapshots = z.array(z.object({
  instanceId: z.string(), displayName: z.string().optional(), installed: z.boolean(),
  status: z.string(), message: z.string().optional(),
  models: z.array(z.object({
    slug: z.string(), name: z.string(), isDefault: z.boolean().optional(),
    capabilities: z.object({ optionDescriptors: z.array(z.object({
      role: z.string().optional(), type: z.string(),
      options: z.array(z.object({ id: z.string(), label: z.string(), description: z.string().optional(), isDefault: z.boolean().optional() })).optional()
    })).optional() }).nullable()
  }))
}))

const acpSearchResults = z.array(z.object({ id: z.string(), name: z.string(), description: z.string() }))
const acpInstance = z.custom<`acp-${string}`>(id => isAgentRunProvider(id) && id.startsWith('acp-'))

function emptyProvider(provider: AgentRunProvider, error: string | null = null): CodingAgentModelCatalogEntry {
  return { provider, label: agentProviderLabel(provider), models: [], error, defaultReasoningEffort: null, defaultReasoningEfforts: [] }
}

export class T3ProviderCatalog {
  constructor(private readonly sidecar: Pick<T3RuntimeProcess, 'request'>) {}

  async list(refresh = false): Promise<CodingAgentModelCatalog> {
    const rows = await this.sidecar.request({ type: 'providers', refresh }, providerSnapshots)
    const catalog = Object.fromEntries(agentRunProviders.map(provider => [provider, emptyProvider(provider, '等待 T3 检测。')])) as CodingAgentModelCatalog
    for (const row of rows) {
      const provider = row.instanceId === 'claudeAgent' ? 'claude' : row.instanceId
      if (!isAgentRunProvider(provider)) continue
      const models = row.models.map(model => {
        const reasoning = model.capabilities?.optionDescriptors?.find(option => option.type === 'select' && option.role === 'reasoning')
        return { id: model.slug, label: model.name, description: null, isDefault: model.isDefault === true,
          defaultReasoningEffort: reasoning?.options?.find(option => option.isDefault)?.id ?? null,
          reasoningEfforts: (reasoning?.options ?? []).map(option => ({
            id: option.id, label: option.label, description: option.description ?? null
          })) }
      })
      catalog[provider] = {
        ...emptyProvider(provider, row.status === 'ready' ? null : row.message ?? (!row.installed ? 'Agent 尚未安装。' : 'Agent 尚未就绪。')),
        label: row.displayName ?? agentProviderLabel(provider), models,
        defaultReasoningEfforts: models.find(model => model.isDefault)?.reasoningEfforts ?? [],
        defaultReasoningEffort: models.find(model => model.isDefault)?.defaultReasoningEffort ?? null
      }
    }
    return catalog
  }

  searchAcp(query: string): Promise<z.infer<typeof acpSearchResults>> {
    return this.sidecar.request({ type: 'acp-search', query }, acpSearchResults)
  }

  addAcp(agentId: string): Promise<`acp-${string}`> {
    return this.sidecar.request({ type: 'acp-add', agentId }, acpInstance)
  }

  manageAntigravity(input: AntigravitySetupInput) {
    return this.sidecar.request({
      type: 'antigravity-setup',
      ...input, operation: input.operation === 'open-sign-in' ? 'status' : input.operation
    }, antigravitySetupStateSchema.omit({ canOpenSignIn: true }).extend({ authorizationUrl: z.string().nullable() }))
  }
}
