import {
  ArchiveX,
  ArrowDown,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Copy,
  Clock3,
  Database,
  Folder,
  GitBranch,
  Headphones,
  Inbox,
  Lightbulb,
  LayoutGrid,
  LoaderCircle,
  Mic2,
  MoreHorizontal,
  PanelLeft,
  Pause,
  Pencil,
  Play,
  Plus,
  Plug,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Smartphone,
  Square,
  Target,
  Workflow,
  X,
  Trash2
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { QRCodeSVG } from 'qrcode.react'
import { ChatComposer } from '../components/ChatComposer'
import { AgentRunsView } from '../components/AgentRunsView'
import { ConversationMessageActions } from '../components/ConversationMessageActions'
import { isProjectImageIcon, ProjectIcon } from '../components/ProjectIcon'
import { ActionMenu, SelectMenu, SuggestionInput } from '../components/SelectMenu'
import { WorkspaceFilesView } from '../components/WorkspaceFilesView'
import { AutomationsView } from '../components/AutomationsView'
import { normalizeChatMarkdown } from '../markdown'
import { maxChatImages, prepareChatImages } from '../chat-attachments'
import { workAssistantRunIds } from '../work-assistant-links'
import { chatIsAtLatest } from '../chat-scroll'
import { microphoneAccessError } from '../voice-input'
import fuddyWordmark from '../assets/fuddy-wordmark.png'
import type {
  AgentPlanEntry,
  AgentRun,
  AgentProviderMode,
  AgentSessionUpdate,
  AgentEndpointSettings,
  AppBootstrap,
  AsrModelStatus,
  Capability,
  ConnectorInstance,
  ConnectorKind,
  ConnectorRun,
  BriefingMessage,
  DecisionItem,
  DecisionKind,
  DecisionStatus,
  DecisionWaitingReason,
  GoalMilestone,
  GoalPriority,
  GoalStatus,
  MorningBriefing,
  Project,
  ProjectGoal,
  TtsEndpointSettings,
  TtsProviderMode,
  UpdateProjectInput,
  WorkAssistantImageAttachment,
  WorkAssistantActionProposal,
  WorkAssistantTaskContext,
  WorkAssistantTaskReference
} from '../../../shared/contracts'
import { normalizeWorkspaceRoots } from '../../../shared/project-workspaces'
import type { CompanionMacStatus, CompanionPairingSession } from '../../../shared/companion-sync'
import { defaultCompanionRelayUrl } from '../../../shared/companion-sync'
import { formatAgentProviderName } from '../../../shared/model-display'
import {
  codingAgentOptions,
  connectorStatusLabels,
  decisionWaitingReasonLabels,
  formatDecisionSource,
  formatExpiryLabel,
  formatRelativeTime,
  kindIcons,
  kindLabels,
  settingsNavigationItems,
  settingsSectionTitles,
  useAutoDismissMessage,
  type SettingsSection
} from './shared'

export function MarkdownMessage({
  content,
  streaming = false
}: {
  content: string
  streaming?: boolean
}): React.JSX.Element {
  return (
    <div className={`chat-markdown ${streaming ? 'is-streaming' : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">
              {children}
            </a>
          )
        }}
      >
        {normalizeChatMarkdown(content)}
      </ReactMarkdown>
      {streaming && <span className="streaming-caret" aria-hidden="true" />}
    </div>
  )
}

export function TaskContextBadge({ context }: { context: WorkAssistantTaskContext }): React.JSX.Element {
  return (
    <div className="work-task-context">
      <Play size={11} fill="currentColor" />
      <span>{context.projectName}</span>
      <i>·</i>
      <strong>{context.milestoneTitle}</strong>
    </div>
  )
}

export function BriefingTranscript({ body }: { body: string }): React.JSX.Element {
  return (
    <div className="briefing-card-transcript">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">
              {children}
            </a>
          )
        }}
      >
        {normalizeChatMarkdown(body)}
      </ReactMarkdown>
    </div>
  )
}

export function AudioBriefingCard({
  briefing,
  ttsMode,
  generating,
  canRegenerate,
  onGenerate
}: {
  briefing: MorningBriefing
  ttsMode: TtsProviderMode
  generating: boolean
  canRegenerate: boolean
  onGenerate: () => Promise<void>
}): React.JSX.Element {
  const [speaking, setSpeaking] = useState(false)
  const [paused, setPaused] = useState(false)
  const [loadingAudio, setLoadingAudio] = useState(false)
  const [audioError, setAudioError] = useState('')
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const speechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window
  useAutoDismissMessage(audioError, () => setAudioError(''))

  useEffect(() => {
    return () => {
      window.speechSynthesis?.cancel()
      audioRef.current?.pause()
      audioRef.current = null
    }
  }, [briefing?.id])

  function startSystemSpeech(): void {
    if (!briefing || !speechSupported) return
    if (speaking && paused) {
      window.speechSynthesis.resume()
      setPaused(false)
      return
    }
    if (speaking) {
      window.speechSynthesis.pause()
      setPaused(true)
      return
    }
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(briefing.narration)
    utterance.lang = 'zh-CN'
    utterance.rate = 1.02
    utterance.pitch = 0.98
    const voices = window.speechSynthesis.getVoices()
    utterance.voice =
      voices.find(
        (voice) => voice.lang.toLowerCase().startsWith('zh') && /tingting|meijia|sin-ji|普通话/i.test(voice.name)
      ) ??
      voices.find((voice) => voice.lang.toLowerCase().startsWith('zh')) ??
      null
    utterance.onend = () => {
      setSpeaking(false)
      setPaused(false)
    }
    utterance.onerror = () => {
      setSpeaking(false)
      setPaused(false)
    }
    setSpeaking(true)
    setPaused(false)
    window.speechSynthesis.speak(utterance)
  }

  async function toggleAudio(): Promise<void> {
    if (!briefing) return
    setAudioError('')
    if (ttsMode === 'system') {
      startSystemSpeech()
      return
    }
    const current = audioRef.current
    if (current && speaking) {
      if (paused) {
        await current.play()
        setPaused(false)
      } else {
        current.pause()
        setPaused(true)
      }
      return
    }
    setLoadingAudio(true)
    try {
      const result = await window.projectAgent.getMorningBriefingAudio(briefing.id)
      if (result.mode === 'system' || !result.audioDataUrl) {
        startSystemSpeech()
        return
      }
      const audio = new Audio(result.audioDataUrl)
      audioRef.current = audio
      audio.onended = () => {
        setSpeaking(false)
        setPaused(false)
        audioRef.current = null
      }
      audio.onerror = () => {
        setSpeaking(false)
        setPaused(false)
        audioRef.current = null
      }
      setSpeaking(true)
      setPaused(false)
      await audio.play()
    } catch (error) {
      setSpeaking(false)
      setPaused(false)
      audioRef.current = null
      setAudioError(error instanceof Error ? error.message : '云端语音生成失败，请检查 TTS 配置。')
    } finally {
      setLoadingAudio(false)
    }
  }

  function stopSpeech(): void {
    window.speechSynthesis?.cancel()
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
      audioRef.current = null
    }
    setSpeaking(false)
    setPaused(false)
  }

  const minutes = Math.max(1, Math.ceil(briefing.estimatedDurationSeconds / 60))
  return (
    <div className={`audio-briefing-card ${transcriptOpen ? 'is-expanded' : ''}`}>
      <div className="audio-briefing-topline">
        <span>{briefing.reportDate} · 全部项目</span>
        <span className="audio-briefing-actions">
          <span>约 {minutes} 分钟 · 中文</span>
          {canRegenerate && (
            <button onClick={() => void onGenerate()} disabled={generating} aria-label="重新生成今日简报">
              {generating ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
            </button>
          )}
        </span>
      </div>
      <h2>{briefing.headline}</h2>
      <div className={`audio-wave ${speaking && !paused ? 'is-playing' : ''}`} aria-hidden="true">
        {Array.from({ length: 34 }).map((_, index) => (
          <i key={index} style={{ height: `${8 + ((index * 13) % 25)}px` }} />
        ))}
      </div>
      <div className="audio-controls">
        <button
          className="audio-play-button"
          onClick={() => void toggleAudio()}
          disabled={loadingAudio || (ttsMode === 'system' && !speechSupported)}
        >
          {loadingAudio ? (
            <LoaderCircle className="spin" size={16} />
          ) : speaking && !paused ? (
            <Pause size={16} fill="currentColor" />
          ) : (
            <Play size={16} fill="currentColor" />
          )}
          {loadingAudio ? '正在生成' : speaking && !paused ? '暂停' : paused ? '继续播放' : '播放简报'}
        </button>
        {speaking && (
          <button className="audio-stop-button" onClick={stopSpeech} aria-label="停止播放">
            <Square size={11} fill="currentColor" />
          </button>
        )}
        <button className="briefing-read-button" onClick={() => setTranscriptOpen((value) => !value)}>
          {transcriptOpen ? '收起全文' : '阅读全文'}
          <ChevronDown className={transcriptOpen ? 'is-expanded' : ''} size={14} />
        </button>
      </div>
      {audioError && <p className="audio-error">{audioError}</p>}
      {transcriptOpen && <BriefingTranscript body={briefing.body} />}
    </div>
  )
}

export function MessageImageAttachments({
  attachments
}: {
  attachments: readonly WorkAssistantImageAttachment[]
}): React.JSX.Element | null {
  if (attachments.length === 0) return null
  return (
    <div className="chat-image-attachments">
      {attachments.map((attachment) => (
        <img
          key={attachment.id}
          src={attachment.dataUrl}
          alt={attachment.name}
          title={attachment.name}
          loading="lazy"
        />
      ))}
    </div>
  )
}

export function WorkAssistantActionCard({
  messageId,
  proposal,
  busy,
  onExecute
}: {
  messageId: string
  proposal: WorkAssistantActionProposal
  busy: boolean
  onExecute: (messageId: string, proposalId: string, optionId: string) => Promise<void>
}): React.JSX.Element | null {
  const acceptedOption = proposal.options.find((option) => option.id === proposal.acceptedOptionId)
  const options = proposal.options.filter((option) => option.capability !== 'agent-run.open')
  if (options.length === 0 || acceptedOption?.capability === 'agent-run.open') return null
  const accepted = proposal.status === 'accepted'
  const dismissed = proposal.status === 'dismissed'
  const includesLegacyRunLink = options.length !== proposal.options.length
  return (
    <section
      className={`work-assistant-action-card is-${proposal.status}`}
      aria-label={includesLegacyRunLink ? '创建新的 Agent Run' : proposal.title}
    >
      <div className="work-assistant-action-heading">
        <span>{accepted ? <CircleCheck size={17} /> : <Bot size={17} />}</span>
        <div>
          <strong>{includesLegacyRunLink ? '创建新的 Agent Run' : proposal.title}</strong>
          {proposal.context && <small>{proposal.context}</small>}
        </div>
      </div>
      <p>{includesLegacyRunLink ? '如果不继续已有 Run，也可以确认后创建一个新的 Draft Run。' : proposal.description}</p>
      {proposal.status === 'pending' ? (
        <div className="work-assistant-action-options">
          {options.map((option) => (
            <button
              type="button"
              key={option.id}
              className={`is-${option.style}`}
              disabled={busy}
              onClick={() => void onExecute(messageId, proposal.id, option.id)}
            >
              {busy ? (
                <LoaderCircle className="spin" size={13} />
              ) : option.capability === 'agent-run.create' ? (
                <Plus size={13} />
              ) : null}
              {option.label}
            </button>
          ))}
        </div>
      ) : (
        <small className="work-assistant-action-result">
          <Check size={13} /> {dismissed ? '已取消' : `已确认：${acceptedOption?.label ?? '已处理'}`}
        </small>
      )}
    </section>
  )
}

export function workAssistantMessageContent(message: BriefingMessage): string {
  if (!message.actions?.some((proposal) => proposal.options.some((option) => option.capability === 'agent-run.open'))) {
    return message.content
  }
  return message.content
    .replace('确认后会打开它并预填建议消息，不会自动发送。', '可以通过下方链接直接回到这个 Run。')
    .replace('确认后会打开这个 Run 并预填建议消息，不会自动发送。', '可以通过下方链接直接打开这个 Run。')
    .replace('确认后会打开这个 Run，不会追加或发送消息。', '可以通过下方链接直接打开这个 Run。')
    .replace('请确认后打开。', '可以通过下方链接直接打开。')
}

export function WorkAssistantRunLink({ run, onOpen }: { run: AgentRun; onOpen: () => void }): React.JSX.Element {
  return (
    <button className="work-assistant-run-card" type="button" onClick={onOpen}>
      <Bot size={17} />
      <span>
        <strong>{run.title}</strong>
        <small>{run.status === 'draft' ? '草稿 · 首条消息尚未发送' : `${formatAgentProviderName(run.provider)} · ${run.status}`}</small>
      </span>
      <ChevronRight size={16} />
    </button>
  )
}

export function WorkAssistantView({
  briefings,
  messages,
  ttsMode,
  generating,
  runs,
  onOpenRun,
  onExecuteAction,
  onGenerate,
  onAsk
}: {
  briefings: MorningBriefing[]
  messages: BriefingMessage[]
  ttsMode: TtsProviderMode
  generating: boolean
  runs: AgentRun[]
  onOpenRun: (runId: string) => void
  onExecuteAction: (messageId: string, proposalId: string, optionId: string) => Promise<void>
  onGenerate: () => Promise<void>
  onAsk: (
    briefingId: string | null,
    question: string,
    taskContext: WorkAssistantTaskReference | null,
    attachments: WorkAssistantImageAttachment[],
    onUpdate: (update: AgentSessionUpdate) => void
  ) => Promise<void>
}): React.JSX.Element {
  const [question, setQuestion] = useState('')
  const [imageAttachments, setImageAttachments] = useState<WorkAssistantImageAttachment[]>([])
  const [imageError, setImageError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [executingActionId, setExecutingActionId] = useState<string | null>(null)
  const [pendingTurn, setPendingTurn] = useState<{
    userMessage: BriefingMessage
    assistantContent: string
    assistantMessageId: string | null
    plan: AgentPlanEntry[]
  } | null>(null)
  const threadRef = useRef<HTMLElement | null>(null)
  const threadEndRef = useRef<HTMLDivElement | null>(null)
  const isAtLatestMessageRef = useRef(true)
  const [isAtLatestMessage, setIsAtLatestMessage] = useState(true)
  useAutoDismissMessage(imageError, () => setImageError(null))
  const completedBriefings = briefings.filter((briefing) => briefing.status === 'completed')
  const latestBriefing = completedBriefings[0]
  const timeline = [
    ...completedBriefings.map((briefing) => ({
      id: briefing.id,
      type: 'briefing' as const,
      createdAt: briefing.generatedAt,
      briefing
    })),
    ...messages.map((message) => ({
      id: message.id,
      type: 'message' as const,
      createdAt: message.createdAt,
      message
    }))
  ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

  useEffect(() => {
    if (!isAtLatestMessageRef.current) return
    threadEndRef.current?.scrollIntoView({ block: 'end' })
  }, [timeline.length, asking, pendingTurn?.assistantContent])

  function updateLatestMessagePosition(): void {
    const thread = threadRef.current
    if (!thread) return
    const atLatest = chatIsAtLatest(thread)
    isAtLatestMessageRef.current = atLatest
    setIsAtLatestMessage(atLatest)
  }

  function scrollToLatestMessage(): void {
    isAtLatestMessageRef.current = true
    setIsAtLatestMessage(true)
    threadEndRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }

  async function submitQuestion(
    value = question,
    taskContext: WorkAssistantTaskContext | null = null,
    attachments = imageAttachments
  ): Promise<void> {
    const prompt =
      value.trim() || (attachments.length > 0 ? '请分析这些图片，告诉我关键结论、需要注意的问题和建议的下一步。' : '')
    if (!prompt || asking) return
    setAsking(true)
    setQuestion('')
    setImageAttachments([])
    setImageError(null)
    setPendingTurn({
      userMessage: {
        id: `pending-user-${crypto.randomUUID()}`,
        briefingId: latestBriefing?.id ?? null,
        role: 'user',
        content: prompt,
        attachments,
        taskContext,
        createdAt: new Date().toISOString()
      },
      assistantContent: '',
      assistantMessageId: null,
      plan: []
    })
    try {
      await onAsk(
        latestBriefing?.id ?? null,
        prompt,
        taskContext
          ? {
              projectId: taskContext.projectId,
              goalId: taskContext.goalId,
              milestoneId: taskContext.milestoneId
            }
          : null,
        attachments,
        (update) => {
          setPendingTurn((current) => {
            if (!current) return current
            if (update.sessionUpdate === 'plan') return { ...current, plan: update.entries }
            const sameMessage = current.assistantMessageId === update.messageId
            return {
              ...current,
              assistantMessageId: update.messageId,
              assistantContent: sameMessage ? `${current.assistantContent}${update.content.text}` : update.content.text
            }
          })
        }
      )
      setPendingTurn(null)
    } catch (error) {
      setPendingTurn((current) =>
        current
          ? {
              ...current,
              assistantContent: `**请求失败**\n\n${error instanceof Error ? error.message : 'Agent 暂时不可用。'}`
            }
          : current
      )
    } finally {
      setAsking(false)
    }
  }

  async function addImages(files: File[]): Promise<void> {
    const result = await prepareChatImages(files, imageAttachments.length)
    setImageAttachments((current) => [...current, ...result.attachments].slice(0, maxChatImages))
    setImageError(result.error)
  }

  async function executeAction(messageId: string, proposalId: string, optionId: string): Promise<void> {
    if (executingActionId) return
    setExecutingActionId(proposalId)
    try {
      await onExecuteAction(messageId, proposalId, optionId)
    } finally {
      setExecutingActionId(null)
    }
  }

  return (
    <div className="briefing-conversation">
      <section
        className="briefing-thread"
        aria-label="与工作助理的对话"
        ref={threadRef}
        onScroll={updateLatestMessagePosition}
      >
        <div className="briefing-thread-inner">
          {timeline.length === 0 ? (
            <div className="morning-empty">
              <span className="morning-empty-icon">
                <Headphones size={28} />
              </span>
              <strong>工作助理已经准备好</strong>
              <p>你可以直接开始项目任务；每天上午 09:00 的三分钟简报也会发送到这里。</p>
              <button className="briefing-button" onClick={() => void onGenerate()} disabled={generating}>
                {generating ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}
                现在生成
              </button>
            </div>
          ) : (
            timeline.map((item) =>
              item.type === 'briefing' ? (
                <article className="chat-turn is-assistant is-briefing" key={item.id}>
                  <div className="chat-turn-content">
                    <ConversationMessageActions
                      content={`${item.briefing.headline}\n\n${item.briefing.body}`}
                      createdAt={item.createdAt}
                    />
                    <p className="briefing-delivery-copy">早上好，这是今天值得关注的项目变化。</p>
                    <AudioBriefingCard
                      briefing={item.briefing}
                      ttsMode={ttsMode}
                      generating={generating}
                      canRegenerate={item.briefing.id === latestBriefing?.id}
                      onGenerate={onGenerate}
                    />
                  </div>
                </article>
              ) : (
                <article className={`chat-turn is-${item.message.role}`} key={item.id}>
                  <div className="chat-turn-content">
                    <ConversationMessageActions
                      content={workAssistantMessageContent(item.message)}
                      createdAt={item.createdAt}
                    />
                    {item.message.role === 'user' && item.message.taskContext && (
                      <TaskContextBadge context={item.message.taskContext} />
                    )}
                    {item.message.role === 'user' && <MessageImageAttachments attachments={item.message.attachments} />}
                    {item.message.role === 'assistant' ? (
                      <MarkdownMessage content={workAssistantMessageContent(item.message)} />
                    ) : (
                      <p className="chat-bubble">{workAssistantMessageContent(item.message)}</p>
                    )}
                    {item.message.actions?.map((proposal) => (
                      <WorkAssistantActionCard
                        key={proposal.id}
                        messageId={item.message.id}
                        proposal={proposal}
                        busy={executingActionId === proposal.id}
                        onExecute={executeAction}
                      />
                    ))}
                    {workAssistantRunIds(item.message).map((runId) => {
                      const run = runs.find((candidate) => candidate.id === runId)
                      return run ? (
                        <WorkAssistantRunLink key={run.id} run={run} onOpen={() => onOpenRun(run.id)} />
                      ) : null
                    })}
                  </div>
                </article>
              )
            )
          )}
          {pendingTurn && (
            <>
              <article className="chat-turn is-user is-pending">
                <div className="chat-turn-content">
                  <ConversationMessageActions
                    content={pendingTurn.userMessage.content}
                    createdAt={pendingTurn.userMessage.createdAt}
                  />
                  {pendingTurn.userMessage.taskContext && (
                    <TaskContextBadge context={pendingTurn.userMessage.taskContext} />
                  )}
                  <MessageImageAttachments attachments={pendingTurn.userMessage.attachments} />
                  <p className="chat-bubble">{pendingTurn.userMessage.content}</p>
                </div>
              </article>
              <article className="chat-turn is-assistant is-pending">
                <div className="chat-turn-content">
                  {pendingTurn.plan.length > 0 && (
                    <div className="agent-plan" aria-label="Agent 计划">
                      {pendingTurn.plan.map((entry, index) => (
                        <span className={`is-${entry.status}`} key={`${entry.content}-${index}`}>
                          <i />
                          {entry.content}
                        </span>
                      ))}
                    </div>
                  )}
                  {pendingTurn.assistantContent ? (
                    <MarkdownMessage content={pendingTurn.assistantContent} streaming={asking} />
                  ) : (
                    <div className="briefing-thinking">
                      <LoaderCircle className="spin" size={14} /> 正在处理你的请求…
                    </div>
                  )}
                </div>
              </article>
            </>
          )}
          <div ref={threadEndRef} />
        </div>
      </section>

      <footer className="briefing-composer-dock">
        {!isAtLatestMessage && (
          <button
            type="button"
            className="chat-scroll-to-latest"
            onClick={scrollToLatestMessage}
            aria-label="回到最新消息"
            title="回到最新消息"
          >
            <ArrowDown size={17} strokeWidth={2.2} />
          </button>
        )}
        <ChatComposer
          value={question}
          onChange={setQuestion}
          onSubmit={submitQuestion}
          placeholder="和工作助理讨论任务、目标或项目问题…"
          busy={asking}
          attachments={imageAttachments}
          attachmentError={imageError}
          onAttachmentsSelected={addImages}
          onRemoveAttachment={(id) => {
            setImageAttachments((current) => current.filter((attachment) => attachment.id !== id))
            setImageError(null)
          }}
          submitAriaLabel="发送问题"
        />
      </footer>
    </div>
  )
}
