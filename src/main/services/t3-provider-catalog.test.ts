import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { agentRunProviders } from '../../shared/agent-providers'
import { agentRunProviderSchema } from '../../shared/agent-provider-validation'
import { T3ProviderCatalog } from './t3-provider-catalog'

describe('T3 provider catalog', () => {
  it('publishes a JSON Schema for Agent IDs to the project MCP tool', () => {
    const schema = z.object({ defaultAgent: agentRunProviderSchema.optional() })
    expect(z.toJSONSchema(schema).properties?.defaultAgent).toMatchObject({
      anyOf: [{ enum: [...agentRunProviders] }, { pattern: '^acp-[a-zA-Z0-9_-]{1,60}$' }]
    })
    for (const provider of [...agentRunProviders, 'acp-gemini']) {
      expect(schema.safeParse({ defaultAgent: provider }).success).toBe(true)
    }
    expect(schema.safeParse({ defaultAgent: 'acp-/invalid' }).success).toBe(false)
  })

  it('retains built-in and registered ACP Agents and reads native reasoning options', async () => {
    const catalog = new T3ProviderCatalog({
      async request<T>(_command: object, schema: z.ZodType<T>): Promise<T> {
        return schema.parse([
          { instanceId: 'claudeAgent', displayName: 'Claude Code', installed: true, status: 'ready', models: [{
            slug: 'sonnet', name: 'Sonnet', isDefault: true, capabilities: {
              optionDescriptors: [{ id: 'effort', type: 'select', role: 'reasoning',
                options: [{ id: 'high', label: 'High', isDefault: true }] }]
            }
          }] },
          { instanceId: 'acp-gemini', displayName: 'Gemini CLI', installed: false, status: 'pending', models: [] }
        ])
      }
    })
    const entries = await catalog.list()
    expect(Object.keys(entries)).toEqual([...agentRunProviders, 'acp-gemini'])
    expect(entries.claude.defaultReasoningEffort).toBe('high')
    expect(entries.claude.models[0]?.reasoningEfforts).toEqual([{ id: 'high', label: 'High', description: null }])
    expect(entries['acp-gemini']?.label).toBe('Gemini CLI')
  })
})
