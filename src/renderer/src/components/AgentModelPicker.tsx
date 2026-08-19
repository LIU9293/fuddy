import { ChevronUp } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type {
  AgentRunProvider,
  CodingAgentModelCatalog
} from '../../../shared/contracts'
import { compactModelName, formatAgentModelLabel } from '../../../shared/model-display'
import { SelectMenu } from './SelectMenu'

const codingProviderOptions = [
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude Code' },
  { value: 'opencode', label: 'OpenCode' }
] as const

const allProviderOptions = [
  { value: 'pi', label: 'Pi Agent' },
  ...codingProviderOptions
] as const

export function buildAgentModelPickerOptions({
  provider,
  model,
  reasoningEffort,
  inheritedModel = '',
  inheritedReasoningEffort = '',
  catalog
}: {
  provider: AgentRunProvider
  model: string
  reasoningEffort: string
  inheritedModel?: string
  inheritedReasoningEffort?: string
  catalog: CodingAgentModelCatalog | null
}): {
  modelOptions: Array<{ value: string; label: string }>
  reasoningOptions: Array<{ value: string; label: string }>
  reasoningEfforts: NonNullable<CodingAgentModelCatalog['codex']>['defaultReasoningEfforts']
} {
  if (provider === 'pi') return { modelOptions: [], reasoningOptions: [], reasoningEfforts: [] }
  const providerCatalog = catalog?.[provider]
  const discoveredModels = providerCatalog?.models ?? []
  const effectiveModel = model || inheritedModel
  const selectedModel = discoveredModels.find((option) => option.id === effectiveModel)
  const reasoningEfforts = effectiveModel
    ? (selectedModel?.reasoningEfforts ?? [])
    : (providerCatalog?.defaultReasoningEfforts ?? [])
  const providerLabel = codingProviderOptions.find((option) => option.value === provider)?.label ?? provider
  const inheritedModelLabel = compactModelName(inheritedModel)
  const inheritedReasoningLabel = formatAgentModelLabel('', inheritedReasoningEffort, '')
  const modelOptions = [
    {
      value: '',
      label: inheritedModelLabel
        ? `${inheritedModelLabel} · 全局默认`
        : `使用 ${providerLabel} 默认模型`
    },
    ...discoveredModels.map((option) => ({
      value: option.id,
      label: `${option.label === option.id ? option.id : `${option.label} · ${option.id}`}${option.isDefault ? ' · Agent 推荐' : ''}`
    })),
    ...(model && !discoveredModels.some((option) => option.id === model)
      ? [{ value: model, label: `${model} · 当前配置` }]
      : [])
  ]
  const reasoningOptions = [
    {
      value: '',
      label: inheritedReasoningLabel
        ? `${inheritedReasoningLabel} · 全局默认`
        : '使用 Agent 默认思考深度'
    },
    ...reasoningEfforts.map((effort) => ({ value: effort.id, label: effort.label })),
    ...(reasoningEffort && !reasoningEfforts.some((effort) => effort.id === reasoningEffort)
      ? [{ value: reasoningEffort, label: `${reasoningEffort} · 当前配置` }]
      : [])
  ]
  return { modelOptions, reasoningOptions, reasoningEfforts }
}

export function AgentModelPicker({
  provider,
  model,
  reasoningEffort,
  inheritedModel = '',
  inheritedReasoningEffort = '',
  label,
  catalog,
  allowPi = false,
  disabled = false,
  status,
  onChange
}: {
  provider: AgentRunProvider
  model: string
  reasoningEffort: string
  inheritedModel?: string
  inheritedReasoningEffort?: string
  label: string
  catalog: CodingAgentModelCatalog | null
  allowPi?: boolean
  disabled?: boolean
  status: string
  onChange: (provider: AgentRunProvider, model: string, reasoningEffort: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const providerCatalog = provider === 'pi' ? null : catalog?.[provider]
  const discoveredModels = providerCatalog?.models ?? []
  const { modelOptions, reasoningOptions, reasoningEfforts } = buildAgentModelPickerOptions({
    provider,
    model,
    reasoningEffort,
    inheritedModel,
    inheritedReasoningEffort,
    catalog
  })

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return (
    <div className="composer-model-picker" ref={rootRef}>
      <button
        type="button"
        className="composer-model-picker-trigger"
        title={label}
        aria-label={`Agent 配置：${label}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      ><span>{label}</span><ChevronUp size={11} /></button>
      {open && (
        <div className="composer-model-picker-popover" role="dialog" aria-label="选择 Agent、模型和思考深度">
          <label>
            <span>Agent</span>
            <SelectMenu
              value={provider}
              options={allowPi ? allProviderOptions : codingProviderOptions}
              onChange={(value) => onChange(value as AgentRunProvider, '', '')}
              ariaLabel="选择 Agent"
            />
          </label>
          {provider !== 'pi' && (
            <>
              <label>
                <span>模型</span>
                <SelectMenu
                  value={model}
                  options={modelOptions}
                  position="up"
                  onChange={(value) => {
                    const nextEfforts = value
                      ? (discoveredModels.find((option) => option.id === value)?.reasoningEfforts ?? [])
                      : (providerCatalog?.defaultReasoningEfforts ?? [])
                    const nextReasoning = !reasoningEffort || nextEfforts.some((effort) => effort.id === reasoningEffort)
                      ? reasoningEffort
                      : ''
                    onChange(provider, value, nextReasoning)
                  }}
                  ariaLabel="选择模型"
                />
              </label>
              <label>
                <span>思考深度</span>
                <SelectMenu
                  value={reasoningEffort}
                  options={reasoningOptions}
                  position="up"
                  onChange={(value) => onChange(provider, model, value)}
                  ariaLabel="选择思考深度"
                  disabled={reasoningEfforts.length === 0 && !reasoningEffort && !inheritedReasoningEffort}
                />
              </label>
              <p className="composer-model-picker-status">{providerCatalog?.error ?? status}</p>
            </>
          )}
          {provider === 'pi' && (
            <p className="composer-model-picker-status">Fuddy Agent 使用内置模型，无需选择模型或思考深度。</p>
          )}
        </div>
      )}
    </div>
  )
}
