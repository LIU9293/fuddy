import { describe, expect, it } from 'vitest'
import { parseCodexModels, parseOpenCodeModels } from './coding-agent-models'

describe('coding agent model discovery', () => {
  it('maps the Codex app-server model catalog to picker options', () => {
    expect(parseCodexModels({
      data: [
        { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', isDefault: true },
        { id: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', isDefault: false }
      ]
    })).toEqual([
      { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', description: null, isDefault: true },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', description: null, isDefault: false }
    ])
  })

  it('parses and deduplicates OpenCode provider/model output', () => {
    expect(parseOpenCodeModels([
      'openai/gpt-5.6-sol',
      'anthropic/claude-opus-5',
      'openai/gpt-5.6-sol',
      '[debug] ignored'
    ].join('\n'))).toEqual([
      { id: 'openai/gpt-5.6-sol', label: 'openai/gpt-5.6-sol', description: null, isDefault: false },
      { id: 'anthropic/claude-opus-5', label: 'anthropic/claude-opus-5', description: null, isDefault: false }
    ])
  })
})
