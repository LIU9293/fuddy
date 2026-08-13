import { ArrowUp, LoaderCircle, Mic, Paperclip, Square, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { WorkAssistantImageAttachment } from '../../../shared/contracts'
import { blobToDataUrl, downsampleAudio, encodePcm16Wave, mergeAudioChunks, microphoneAccessError, prepareAudioForTranscription } from '../voice-input'

interface ChatComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void | Promise<void>
  placeholder: string
  busy?: boolean
  allowSubmitWhileBusy?: boolean
  onStop?: () => void | Promise<void>
  disabled?: boolean
  leftControls?: ReactNode
  attachments?: readonly WorkAssistantImageAttachment[]
  attachmentError?: string | null
  onAttachmentsSelected: (files: File[]) => void | Promise<void>
  onRemoveAttachment: (id: string) => void
  submitAriaLabel?: string
  voicePrompt?: string
  modelLabel?: string
  modelControl?: ReactNode
}

interface ActiveRecording {
  context: AudioContext
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  processor: ScriptProcessorNode
  chunks: Float32Array[]
  timeoutId: number
}

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  placeholder,
  busy = false,
  allowSubmitWhileBusy = false,
  onStop,
  disabled = false,
  leftControls,
  attachments = [],
  attachmentError = null,
  onAttachmentsSelected,
  onRemoveAttachment,
  submitAriaLabel = '提交',
  voicePrompt = 'Fuddy，项目，目标，决策收件箱，工作助理，Agent Run',
  modelLabel,
  modelControl
}: ChatComposerProps): React.JSX.Element {
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const recordingRef = useRef<ActiveRecording | null>(null)
  const currentValueRef = useRef(value)
  const [voiceState, setVoiceState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [voiceError, setVoiceError] = useState<string | null>(null)
  currentValueRef.current = value

  useEffect(() => {
    if (!voiceError) return
    const timeout = window.setTimeout(() => setVoiceError(null), 5_000)
    return () => window.clearTimeout(timeout)
  }, [voiceError])

  useEffect(() => () => {
    const recording = recordingRef.current
    recording?.processor.disconnect()
    recording?.source.disconnect()
    recording?.stream.getTracks().forEach((track) => track.stop())
    if (recording) window.clearTimeout(recording.timeoutId)
    void recording?.context.close()
  }, [])

  const startVoiceInput = async (): Promise<void> => {
    setVoiceError(null)
    try {
      const access = await window.projectAgent.requestMicrophoneAccess()
      const permissionError = microphoneAccessError(access)
      if (permissionError) {
        if (access.status === 'denied' || access.status === 'restricted') {
          await window.projectAgent.openMicrophoneSettings()
        }
        throw new Error(permissionError)
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      })
      const context = new AudioContext()
      const source = context.createMediaStreamSource(stream)
      const processor = context.createScriptProcessor(4096, 1, 1)
      const chunks: Float32Array[] = []
      processor.onaudioprocess = (event) => chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
      source.connect(processor)
      processor.connect(context.destination)
      if (context.state === 'suspended') await context.resume()
      const recording = { context, stream, source, processor, chunks, timeoutId: 0 }
      recording.timeoutId = window.setTimeout(() => {
        if (recordingRef.current === recording) void stopVoiceInput()
      }, 5 * 60 * 1_000)
      recordingRef.current = recording
      setVoiceState('recording')
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : '无法访问麦克风。')
      setVoiceState('idle')
    }
  }

  const stopVoiceInput = async (): Promise<void> => {
    const recording = recordingRef.current
    if (!recording) return
    recordingRef.current = null
    recording.processor.disconnect()
    recording.source.disconnect()
    recording.stream.getTracks().forEach((track) => track.stop())
    window.clearTimeout(recording.timeoutId)
    await recording.context.close()
    setVoiceState('transcribing')
    try {
      const merged = mergeAudioChunks(recording.chunks)
      if (merged.length < recording.context.sampleRate * 0.25) throw new Error('录音太短，请再说一次。')
      const prepared = prepareAudioForTranscription(merged, recording.context.sampleRate)
      const wav = encodePcm16Wave(downsampleAudio(prepared, recording.context.sampleRate))
      const result = await window.projectAgent.transcribeAudio({
        audioDataUrl: await blobToDataUrl(wav),
        language: 'zh',
        prompt: voicePrompt
      })
      const prefix = currentValueRef.current.trim() ? `${currentValueRef.current.trimEnd()} ` : ''
      onChange(`${prefix}${result.text}`)
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : '语音转写失败。')
    } finally {
      setVoiceState('idle')
    }
  }
  const hasMessage = Boolean(value.trim()) || attachments.length > 0
  const canStop = busy && !hasMessage && Boolean(onStop)
  const submitDisabled = disabled || (!canStop && (!hasMessage || (busy && !allowSubmitWhileBusy)))
  const submitOrStop = (): void => {
    if (canStop) void onStop?.()
    else void onSubmit()
  }

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
                disabled={disabled || (busy && !allowSubmitWhileBusy)}
              >
                <X size={12} />
              </button>
            </figure>
          ))}
        </div>
      )}
      {(attachmentError || voiceError) && <p className="composer-image-error">{attachmentError ?? voiceError}</p>}
      <textarea
        className="composer-textarea"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            if (!submitDisabled) submitOrStop()
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
            disabled={disabled || (busy && !allowSubmitWhileBusy)}
          >
            <Paperclip size={17} />
          </button>
          {leftControls}
        </div>
        <div className="composer-right-controls">
          {modelControl ?? (modelLabel && <span className="composer-model-label" title={modelLabel}>{modelLabel}</span>)}
          <button
            type="button"
            className={`round-icon-button composer-voice-button ${voiceState === 'recording' ? 'is-recording' : ''}`}
            onClick={() => void (voiceState === 'recording' ? stopVoiceInput() : startVoiceInput())}
            disabled={disabled || voiceState === 'transcribing' || (busy && !allowSubmitWhileBusy)}
            aria-label={voiceState === 'recording' ? '停止录音并转写' : voiceState === 'transcribing' ? '正在转写' : '语音输入'}
            title={voiceState === 'recording' ? '停止并转写' : '语音输入'}
          >
            {voiceState === 'transcribing'
              ? <LoaderCircle className="spin" size={17} />
              : voiceState === 'recording'
                ? <Square size={12} fill="currentColor" />
                : <Mic size={17} />}
          </button>
          <button className={`send-button ${canStop ? 'is-stop' : ''}`} onClick={submitOrStop} disabled={submitDisabled} aria-label={canStop ? '停止当前回复' : submitAriaLabel}>
            {canStop
              ? <Square size={13} fill="currentColor" />
              : busy && !allowSubmitWhileBusy
                ? <LoaderCircle className="spin" size={17} />
                : <ArrowUp size={18} strokeWidth={2.4} />}
          </button>
        </div>
      </div>
    </div>
  )
}
