import { ArrowUp, ImagePlus, LoaderCircle, Mic2, X } from 'lucide-react'
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
  imageAttachments?: readonly WorkAssistantImageAttachment[]
  imageError?: string | null
  onImagesSelected?: (files: File[]) => void | Promise<void>
  onRemoveImage?: (id: string) => void
  showVoiceInput?: boolean
  onVoiceInput?: () => void
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
  imageAttachments = [],
  imageError = null,
  onImagesSelected,
  onRemoveImage,
  showVoiceInput = true,
  onVoiceInput,
  submitAriaLabel = '提交'
}: ChatComposerProps): React.JSX.Element {
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const submitDisabled = disabled || busy || (!value.trim() && imageAttachments.length === 0)

  return (
    <div className="composer">
      {imageAttachments.length > 0 && (
        <div className="composer-image-attachments" aria-label="待发送图片">
          {imageAttachments.map((attachment) => (
            <figure className="composer-image-attachment" key={attachment.id} title={attachment.name}>
              <img src={attachment.dataUrl} alt={attachment.name} />
              <button
                type="button"
                onClick={() => onRemoveImage?.(attachment.id)}
                aria-label={`移除图片 ${attachment.name}`}
                disabled={disabled || busy}
              >
                <X size={12} />
              </button>
            </figure>
          ))}
        </div>
      )}
      {imageError && <p className="composer-image-error">{imageError}</p>}
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
          {leftControls}
          {onImagesSelected && (
            <>
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
                  if (files.length > 0) void onImagesSelected(files)
                }}
              />
              <button
                type="button"
                className="round-icon-button composer-image-button"
                onClick={() => imageInputRef.current?.click()}
                aria-label="添加图片"
                disabled={disabled || busy}
              >
                <ImagePlus size={17} />
              </button>
            </>
          )}
        </div>
        <div className="composer-right-controls">
          {showVoiceInput && (
            <button className="round-icon-button" onClick={onVoiceInput} aria-label="语音输入" disabled={disabled || busy}>
              <Mic2 size={17} />
            </button>
          )}
          <button className="send-button" onClick={() => void onSubmit()} disabled={submitDisabled} aria-label={submitAriaLabel}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={18} strokeWidth={2.4} />}
          </button>
        </div>
      </div>
    </div>
  )
}
