import { ArrowUp, LoaderCircle, Paperclip, X } from 'lucide-react'
import { useRef, type ReactNode } from 'react'
import type { WorkAssistantImageAttachment } from '../../../shared/contracts'

interface ChatComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void | Promise<void>
  placeholder: string
  busy?: boolean
  disabled?: boolean
  leftControls?: ReactNode
  attachments?: readonly WorkAssistantImageAttachment[]
  attachmentError?: string | null
  onAttachmentsSelected: (files: File[]) => void | Promise<void>
  onRemoveAttachment: (id: string) => void
  submitAriaLabel?: string
}

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  placeholder,
  busy = false,
  disabled = false,
  leftControls,
  attachments = [],
  attachmentError = null,
  onAttachmentsSelected,
  onRemoveAttachment,
  submitAriaLabel = '提交'
}: ChatComposerProps): React.JSX.Element {
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const submitDisabled = disabled || busy || (!value.trim() && attachments.length === 0)

  return (
    <div className="composer">
      {attachments.length > 0 && (
        <div className="composer-image-attachments" aria-label="待发送图片">
          {attachments.map((attachment) => (
            <figure className="composer-image-attachment" key={attachment.id} title={attachment.name}>
              <img src={attachment.dataUrl} alt={attachment.name} />
              <button
                type="button"
                onClick={() => onRemoveAttachment(attachment.id)}
                aria-label={`移除图片 ${attachment.name}`}
                disabled={disabled || busy}
              >
                <X size={12} />
              </button>
            </figure>
          ))}
        </div>
      )}
      {attachmentError && <p className="composer-image-error">{attachmentError}</p>}
      <textarea
        className="composer-textarea"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            if (!submitDisabled) void onSubmit()
          }
        }}
        placeholder={placeholder}
        rows={1}
        disabled={disabled}
      />
      <div className="composer-controls">
        <div className="composer-left-controls">
          <input
            ref={imageInputRef}
            className="composer-image-input"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            tabIndex={-1}
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? [])
              event.currentTarget.value = ''
              if (files.length > 0) void onAttachmentsSelected(files)
            }}
          />
          <button
            type="button"
            className="round-icon-button composer-image-button"
            onClick={() => imageInputRef.current?.click()}
            aria-label="添加附件"
            title="添加附件"
            disabled={disabled || busy}
          >
            <Paperclip size={17} />
          </button>
          {leftControls}
        </div>
        <div className="composer-right-controls">
          <button className="send-button" onClick={() => void onSubmit()} disabled={submitDisabled} aria-label={submitAriaLabel}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={18} strokeWidth={2.4} />}
          </button>
        </div>
      </div>
    </div>
  )
}
