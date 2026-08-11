import { describe, expect, it } from 'vitest'
import { parseCodexModels, parseOpenCodeModels, parseOpenCodeVerboseModels } from './coding-agent-models'

describe('coding agent model discovery', () => {
  it('maps the Codex app-server model catalog to picker options', () => {
    expect(parseCodexModels({
      data: [
        {
          id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', isDefault: true,
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Fast' },
            { reasoningEffort: 'high', description: 'Deep' }
          ],
          defaultReasoningEffort: 'low'
        },
        { id: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', isDefault: false }
      ]
    })).toEqual([
      {
        id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', description: null, isDefault: true,
        reasoningEfforts: [
          { id: 'low', label: 'low', description: 'Fast' },
          { id: 'high', label: 'high', description: 'Deep' }
        ],
        defaultReasoningEffort: 'low'
      },
      {
        id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', description: null, isDefault: false,
        reasoningEfforts: [], defaultReasoningEffort: null
      }
    ])
  })

  it('parses and deduplicates OpenCode provider/model output', () => {
    expect(parseOpenCodeModels([
      'openai/gpt-5.6-sol',
      'anthropic/claude-opus-5',
      'openai/gpt-5.6-sol',
      '[debug] ignored'
    ].join('\n'))).toEqual([
      {
        id: 'openai/gpt-5.6-sol', label: 'openai/gpt-5.6-sol', description: null, isDefault: false,
        reasoningEfforts: [], defaultReasoningEffort: null
      },
      {
        id: 'anthropic/claude-opus-5', label: 'anthropic/claude-opus-5', description: null, isDefault: false,
        reasoningEfforts: [], defaultReasoningEffort: null
      }
    ])
  })

  it('reads OpenCode model variants as supported reasoning efforts', () => {
    expect(parseOpenCodeVerboseModels(`openai/gpt-5.6-sol
{
  "name": "GPT-5.6-Sol",
  "capabilities": { "reasoning": true },
  "variants": {
    "none": { "reasoningEffort": "none" },
    "high": { "reasoningEffort": "high" },
    "max": { "reasoningEffort": "max" }
  }
}`)).toEqual([{
      id: 'openai/gpt-5.6-sol',
      label: 'GPT-5.6-Sol',
      description: null,
      isDefault: false,
      reasoningEfforts: [
        { id: 'none', label: 'none', description: null },
        { id: 'high', label: 'high', description: null },
        { id: 'max', label: 'max', description: null }
      ],
      defaultReasoningEffort: null
    }])
  })
})
