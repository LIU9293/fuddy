import { describe, expect, it } from 'vitest'
import type { CodingAgentModelCatalog } from '../../../shared/contracts'
import { buildAgentModelPickerOptions } from './AgentModelPicker'

const catalog: CodingAgentModelCatalog = {
  codex: {
    provider: 'codex',
    models: [{
      id: 'gpt-5.6-sol',
      label: '5.6 Sol',
      description: null,
      isDefault: true,
      reasoningEfforts: [
        { id: 'medium', label: 'medium', description: null },
        { id: 'xhigh', label: 'xhigh', description: null }
      ],
      defaultReasoningEffort: 'medium'
    }],
    defaultReasoningEfforts: [],
    defaultReasoningEffort: null,
    error: null
  },
  claude: {
    provider: 'claude', models: [], defaultReasoningEfforts: [], defaultReasoningEffort: null, error: null
  },
  opencode: {
    provider: 'opencode', models: [], defaultReasoningEfforts: [], defaultReasoningEffort: null, error: null
  }
}

describe('AgentModelPicker inherited settings', () => {
  it('shows the effective global model and reasoning while keeping the Run overrides empty', () => {
    const options = buildAgentModelPickerOptions({
      provider: 'codex',
      model: '',
      reasoningEffort: '',
      inheritedModel: 'gpt-5.6-sol',
      inheritedReasoningEffort: 'xhigh',
      catalog
    })

    expect(options.modelOptions[0]).toEqual({ value: '', label: '5.6 Sol · 全局默认' })
    expect(options.reasoningOptions[0]).toEqual({ value: '', label: 'XHigh · 全局默认' })
    expect(options.reasoningEfforts.map((effort) => effort.id)).toEqual(['medium', 'xhigh'])
  })
})
