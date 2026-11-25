import { ChevronDown, ChevronLeft, ChevronRight, Square, X } from 'lucide-react'
import { useState } from 'react'
import type { AgentInputRequest, RespondAgentInput } from '../../../shared/contracts'
import { ChatMarkdown } from './ChatMarkdown'

export function AgentInputCard({ request, onRespond, modelLabel, onStop }: {
  request: AgentInputRequest
  onRespond: (answers: RespondAgentInput['answers']) => Promise<void>
  modelLabel?: string
  onStop?: () => Promise<void>
}): React.JSX.Element {
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [questionIndex, setQuestionIndex] = useState(0)
  const [expanded, setExpanded] = useState(true)
  const question = request.questions[questionIndex]
  const last = questionIndex === request.questions.length - 1
  const answers = Object.fromEntries(request.questions.flatMap(question => {
    const choice = selected[question.id] ?? []
    const text = custom[question.id]?.trim()
    const value = question.multiSelect ? [...choice, ...(text ? [text] : [])] : text || choice[0] || ''
    return value.length ? [[question.id, value]] : []
  }))
  const complete = request.questions.every(question => question.required === false || answers[question.id] !== undefined)
  if (!question) return <></>
  const choice = selected[question.id] ?? []
  const canAdvance = question.required === false || answers[question.id] !== undefined
  const allowCustom = question.allowCustomAnswer || !question.options.length

  function select(value: string): void {
    const next = question.multiSelect
      ? choice.includes(value) ? choice.filter(picked => picked !== value) : [...choice, value]
      : [value]
    setSelected(current => ({ ...current, [question.id]: next }))
    if (!question.multiSelect) setCustom(current => ({ ...current, [question.id]: '' }))
  }

  async function submit(value: RespondAgentInput['answers']): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await onRespond(value)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法提交回答。')
      setBusy(false)
    }
  }

  return (
    <form className="agent-input-card" aria-label="Agent 提问" onSubmit={event => {
      event.preventDefault()
      if (!last && canAdvance) setQuestionIndex(index => index + 1)
      else if (last && complete) void submit(answers)
    }} onKeyDown={event => {
      if (busy || !expanded || event.altKey || event.ctrlKey || event.metaKey ||
          event.target instanceof HTMLTextAreaElement || !/^[1-9]$/.test(event.key)) return
      const option = question.options[Number(event.key) - 1]
      if (!option) return
      event.preventDefault()
      select(option.value ?? option.label)
    }}>
      <div className="agent-input-banner">
        <div className="agent-input-header">
          <button type="button" className="agent-input-toggle" aria-expanded={expanded}
            onClick={() => setExpanded(open => !open)}>
            <span>{question.header || 'Agent 提问'}</span>
            {!expanded && <small>{question.question}</small>}
            {request.questions.length > 1 && <span className="agent-input-count">{questionIndex + 1}/{request.questions.length}</span>}
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          <button type="button" className="agent-input-icon-button" aria-label="跳过提问"
            title="跳过提问" disabled={busy} onClick={() => void submit(null)}><X size={15} /></button>
        </div>
        {expanded && (
          <fieldset key={question.id} disabled={busy} aria-label={question.question}>
            <ChatMarkdown content={question.question} />
            {question.options.map((option, index) => {
              const value = option.value ?? option.label
              const checked = choice.includes(value)
              return <div key={value}>
                <button className="agent-input-option" type="button" aria-pressed={checked}
                  aria-keyshortcuts={index < 9 ? String(index + 1) : undefined} onClick={() => select(value)}>
                  <span className="agent-input-option-indicator" aria-hidden="true">
                    <span className={`agent-input-option-mark ${question.multiSelect ? 'is-multiple' : ''}`} />
                  </span>
                  <span className="agent-input-option-copy">
                    <strong>{option.label}</strong>
                    {option.description && option.description !== option.label && <small>{option.description}</small>}
                  </span>
                  {index < 9 && <span className="agent-input-option-shortcut" aria-hidden="true"><kbd>{index + 1}</kbd></span>}
                </button>
                {option.preview && <ChatMarkdown content={option.preview} className="agent-input-option-preview" />}
              </div>
            })}
          </fieldset>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="agent-input-composer">
        <textarea className="composer-textarea" aria-label="输入回答" rows={1} maxLength={4000}
          disabled={busy || !allowCustom}
          placeholder={allowCustom ? '输入自己的回答，或留空使用选中的选项' : '选择选项后提交'}
          value={custom[question.id] ?? ''} onChange={event => {
            const text = event.target.value
            setCustom(current => ({ ...current, [question.id]: text }))
            if (text && !question.multiSelect) setSelected(current => ({ ...current, [question.id]: [] }))
          }}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }} />
        <div className="agent-input-actions">
          {modelLabel && <span className="composer-model-label">{modelLabel}</span>}
          {questionIndex > 0 && <button className="secondary-action-button" type="button" disabled={busy}
            onClick={() => setQuestionIndex(index => index - 1)}><ChevronLeft size={14} />上一题</button>}
          <button className="primary-small-button" type="submit" disabled={busy || (last ? !complete : !canAdvance)}>
            {busy ? '正在提交…' : last ? '提交回答' : '下一题'}
          </button>
          {onStop && <button type="button" className="send-button is-stop" aria-label="停止当前回复"
            onClick={() => void onStop()}><Square size={13} fill="currentColor" /></button>}
        </div>
      </div>
    </form>
  )
}
