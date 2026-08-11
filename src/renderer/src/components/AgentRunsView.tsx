import {
  Archive,
  ArrowLeft,
  Bot,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  FileOutput,
  FileText,
  FolderGit2,
  GitBranch,
  ImageIcon,
  Ellipsis,
  LoaderCircle,
  MessageSquare,
  PanelRight,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  X,
  Wrench
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  AgentApprovalRequest,
  AgentRun,
  AgentRunArtifact,
  AgentRunArtifactPreview,
  AgentRunDetail,
  AgentRunMessage,
  AgentRunProvider,
  AgentRunStreamUpdate,
  GitWorkingTreeSummary,
  Project,
  ProjectGoal,
  WorkAssistantImageAttachment
} from '../../../shared/contracts'
import { normalizeChatMarkdown } from '../markdown'
import { maxChatImages, prepareChatImages } from '../chat-attachments'
import { ChatComposer } from './ChatComposer'
import { ConversationMessageActions } from './ConversationMessageActions'
import { ProjectIcon } from './ProjectIcon'
import { SelectMenu } from './SelectMenu'

const agentOptions = [
  { value: 'pi', label: 'Pi Agent' },
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude Code' },
  { value: 'opencode', label: 'OpenCode' }
]

const defaultAgentRunInfoWidth = 390
const minimumAgentRunInfoWidth = 300
const maximumAgentRunInfoWidth = 640
const agentRunInfoWidthStorageKey = 'project-agent.agent-run-info-sidebar-width'

function clampAgentRunInfoWidth(value: number): number {
  return Math.round(Math.min(maximumAgentRunInfoWidth, Math.max(minimumAgentRunInfoWidth, value)))
}

function initialAgentRunInfoWidth(): number {
  const stored = Number.parseFloat(window.localStorage.getItem(agentRunInfoWidthStorageKey) ?? '')
  return Number.isFinite(stored) ? clampAgentRunInfoWidth(stored) : defaultAgentRunInfoWidth
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))
}

function runIsActive(run: AgentRun): boolean {
  return run.status === 'running' || run.status === 'queued'
}

function AgentRunActionsMenu({
  disabled,
  archiveDisabled,
  onRename,
  onArchive
}: {
  disabled: boolean
  archiveDisabled: boolean
  onRename: () => void
  onArchive: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

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
    <div className={`agent-run-actions-menu ${open ? 'is-open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="agent-run-actions-trigger"
        aria-label="Session 操作"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <Ellipsis size={18} />
      </button>
      {open && (
        <div className="agent-run-actions-popover" role="menu" aria-label="Session 操作">
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onRename() }}>
            <Pencil size={14} /> Rename
          </button>
          <button type="button" role="menuitem" disabled={archiveDisabled} onClick={() => { setOpen(false); onArchive() }}>
            <Archive size={14} /> Archive
          </button>
        </div>
      )}
    </div>
  )
}

function projectStatusLabel(status: Project['status']): string {
  if (status === 'active') return '活跃'
  if (status === 'watching') return '关注中'
  return '已暂停'
}

function formatFileSize(size: number): string {
  if (size < 1_024) return `${size} B`
  if (size < 1_048_576) return `${Math.round(size / 1_024)} KB`
  return `${(size / 1_048_576).toFixed(1)} MB`
}

function normalizeArtifactPath(path: string): string {
  return path.replaceAll('\\', '/').split('/').reduce<string[]>((segments, segment) => {
    if (!segment || segment === '.') return segments
    if (segment === '..') segments.pop()
    else segments.push(segment)
    return segments
  }, []).join('/')
}

export function findArtifactForHref(artifacts: AgentRunArtifact[], href: string, baseRelativePath?: string): AgentRunArtifact | null {
  if (/^(https?:|mailto:)/i.test(href) || href.startsWith('#')) return null
  let path = href.split(/[?#]/, 1)[0]
  try {
    path = decodeURIComponent(path)
  } catch {
    // Keep the original href when it contains malformed percent escapes.
  }
  if (path.startsWith('file://')) {
    try {
      path = decodeURIComponent(new URL(path).pathname)
    } catch {
      path = path.slice('file://'.length)
    }
  }
  const isAbsolute = path.startsWith('/') || path.startsWith('file://')
  const baseDirectory = baseRelativePath?.includes('/')
    ? baseRelativePath.slice(0, baseRelativePath.lastIndexOf('/'))
    : ''
  const normalized = normalizeArtifactPath(!isAbsolute && baseDirectory ? `${baseDirectory}/${path}` : path)
  return artifacts.find((artifact) => artifact.relativePath === normalized)
    ?? artifacts.find((artifact) => normalized.endsWith(`/${artifact.relativePath}`))
    ?? artifacts.find((artifact) => !normalized.includes('/') && artifact.label === normalized)
    ?? null
}

function AgentRunInfoSidebar({
  detail,
  project,
  milestoneTitle,
  gitSummary,
  gitLoading,
  activeTab,
  selectedArtifactId,
  onRefreshGit,
  onTabChange,
  onSelectArtifact,
  onClose
}: {
  detail: AgentRunDetail
  project: Project | null | undefined
  milestoneTitle?: string
  gitSummary: GitWorkingTreeSummary | null
  gitLoading: boolean
  activeTab: 'info' | 'files'
  selectedArtifactId: string | null
  onRefreshGit: () => void
  onTabChange: (tab: 'info' | 'files') => void
  onSelectArtifact: (artifactId: string | null) => void
  onClose: () => void
}): React.JSX.Element {
  const [preview, setPreview] = useState<AgentRunArtifactPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const primaryWorkspace = project?.profile.workspaceRoots.find((root) =>
    root.id === project.profile.primaryWorkspaceRootId
  )
  const selectedArtifact = detail.artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null

  useEffect(() => {
    if (activeTab !== 'files' || !selectedArtifactId) {
      setPreview(null)
      setPreviewError(null)
      return
    }
    let cancelled = false
    setPreview(null)
    setPreviewError(null)
    setPreviewLoading(true)
    void window.projectAgent.getAgentRunArtifactPreview(detail.run.id, selectedArtifactId).then((nextPreview) => {
      if (!cancelled) setPreview(nextPreview)
    }).catch((error) => {
      if (!cancelled) setPreviewError(error instanceof Error ? error.message : '文件预览失败。')
    }).finally(() => {
      if (!cancelled) setPreviewLoading(false)
    })
    return () => { cancelled = true }
  }, [activeTab, detail.run.id, selectedArtifactId])

  const openPreviewLink = (href: string): boolean => {
    if (/^(https?:|mailto:)/i.test(href) || href.startsWith('#')) return false
    const artifact = findArtifactForHref(detail.artifacts, href, selectedArtifact?.relativePath)
    if (artifact) onSelectArtifact(artifact.id)
    return true
  }

  return (
    <aside className="agent-run-info-sidebar" aria-label="Session 信息">
      <div className="agent-run-info-header">
        <div><strong>Session 信息</strong><small>上下文与文件预览</small></div>
        <button type="button" onClick={onClose} aria-label="收起信息栏"><X size={16} /></button>
      </div>

      <div className="agent-run-info-tabs" role="tablist" aria-label="Session 信息分类">
        <button type="button" role="tab" aria-selected={activeTab === 'info'} className={activeTab === 'info' ? 'is-active' : ''} onClick={() => onTabChange('info')}>基本信息</button>
        <button type="button" role="tab" aria-selected={activeTab === 'files'} className={activeTab === 'files' ? 'is-active' : ''} onClick={() => onTabChange('files')}>文件 <small>{detail.artifacts.length}</small></button>
      </div>

      <div className="agent-run-info-scroll">
        {activeTab === 'info' ? <>
        <section className="agent-run-info-section">
          <div className="agent-run-info-section-title"><span>Git 变更</span><button type="button" onClick={onRefreshGit} disabled={gitLoading} aria-label="刷新 Git 变更"><RefreshCw size={13} className={gitLoading ? 'spin' : ''} /></button></div>
          {gitLoading && !gitSummary ? <p className="agent-run-info-empty">正在读取工作区…</p> : gitSummary?.available ? (
            <>
              <div className="agent-run-git-heading">
                <span><GitBranch size={13} /> {gitSummary.branch ?? 'detached HEAD'}</span>
                {gitSummary.head && <code>{gitSummary.head}</code>}
              </div>
              <div className="agent-run-git-stats">
                <span><strong>{gitSummary.changedFileCount}</strong><small>个文件</small></span>
                <span className="is-addition"><strong>+{gitSummary.additions}</strong><small>增加</small></span>
                <span className="is-deletion"><strong>−{gitSummary.deletions}</strong><small>删除</small></span>
              </div>
              {gitSummary.changes.length > 0 ? <div className="agent-run-change-list">
                {gitSummary.changes.map((change) => <div key={`${change.status}:${change.path}`}><code>{change.status}</code><span title={change.path}>{change.path}</span></div>)}
              </div> : <p className="agent-run-info-empty">工作区没有未提交变更。</p>}
              <small className="agent-run-info-note">行数统计不包含未跟踪文件与二进制文件。{gitSummary.changedFileCount > gitSummary.changes.length ? ` 仅展示前 ${gitSummary.changes.length} 个文件。` : ''}</small>
            </>
          ) : <p className="agent-run-info-empty">{gitSummary?.error ?? 'Git 信息暂时不可用。'}</p>}
        </section>

        <section className="agent-run-info-section">
          <div className="agent-run-info-section-title"><span>当前项目</span></div>
          {project ? <div className="agent-run-project-summary">
            <div className="agent-run-project-name"><ProjectIcon project={project} className="is-agent-run-info" /><strong>{project.name}</strong><small>{projectStatusLabel(project.status)}</small></div>
            {project.summary && <p>{project.summary}</p>}
            <dl>
              {project.profile.stage && <><dt>阶段</dt><dd>{project.profile.stage}</dd></>}
              {project.focus && <><dt>当前重点</dt><dd>{project.focus}</dd></>}
              {milestoneTitle && <><dt>Milestone</dt><dd>{milestoneTitle}</dd></>}
              <dt>默认 Agent</dt><dd>{project.profile.defaultAgent}</dd>
            </dl>
          </div> : <p className="agent-run-info-empty">这是一个共享 Session，没有关联项目。</p>}
        </section>

        <section className="agent-run-info-section">
          <div className="agent-run-info-section-title"><span>Workspace</span></div>
          <div className="agent-run-workspace-summary">
            <FolderGit2 size={14} />
            <span><strong>{primaryWorkspace?.label ?? '工作目录'}</strong><code title={detail.run.workingDirectory ?? ''}>{detail.run.workingDirectory ?? '未配置'}</code></span>
          </div>
          <div className="agent-run-meta-grid">
            <span><small>Agent</small><strong>{detail.run.provider}</strong></span>
            <span><small>状态</small><strong>{detail.run.status}</strong></span>
            <span><small>更新于</small><strong>{formatTimestamp(detail.run.updatedAt)}</strong></span>
          </div>
        </section>
        </> : selectedArtifact ? (
          <div className="agent-run-file-preview">
            <div className="agent-run-file-preview-header">
              <button type="button" onClick={() => onSelectArtifact(null)}><ArrowLeft size={14} /> 所有文件</button>
              <button type="button" title="在 Finder 中显示" aria-label="在 Finder 中显示" onClick={() => void window.projectAgent.revealWorkspacePath(selectedArtifact.projectId, selectedArtifact.relativePath)}><ExternalLink size={14} /></button>
            </div>
            <div className="agent-run-file-preview-title">
              {selectedArtifact.mimeType?.startsWith('image/') ? <ImageIcon size={17} /> : <FileText size={17} />}
              <span><strong>{selectedArtifact.label}</strong><small>{selectedArtifact.relativePath}{preview ? ` · ${formatFileSize(preview.size)}` : ''}</small></span>
            </div>
            {previewLoading && <div className="agent-run-file-preview-state"><LoaderCircle size={18} className="spin" /> 正在加载预览…</div>}
            {previewError && <div className="agent-run-file-preview-state is-error"><CircleAlert size={17} /><span>{previewError}</span></div>}
            {preview?.kind === 'markdown' && <div className="agent-run-markdown-preview"><Markdown content={preview.content ?? ''} onOpenLink={openPreviewLink} /></div>}
            {preview?.kind === 'text' && <pre className="agent-run-text-preview">{preview.content}</pre>}
            {preview?.kind === 'image' && preview.dataUrl && <div className="agent-run-image-preview"><img src={preview.dataUrl} alt={preview.artifact.label} /></div>}
            {preview?.kind === 'unsupported' && <div className="agent-run-file-preview-state"><FileOutput size={20} /><span>暂不支持在侧边栏预览这种文件，可在 Finder 中打开。</span><button type="button" onClick={() => void window.projectAgent.revealWorkspacePath(selectedArtifact.projectId, selectedArtifact.relativePath)}>在 Finder 中显示</button></div>}
          </div>
        ) : (
          <section className="agent-run-info-section agent-run-files-section">
            <div className="agent-run-info-section-title"><span>全部文件</span><small>{detail.artifacts.length}</small></div>
            {detail.artifacts.length > 0 ? <div className="agent-run-info-artifacts">
              {detail.artifacts.map((artifact) => (
                <button key={artifact.id} type="button" onClick={() => onSelectArtifact(artifact.id)}>
                  {artifact.mimeType?.startsWith('image/') ? <ImageIcon size={15} /> : <FileText size={15} />}
                  <span><strong>{artifact.label}</strong><small>{artifact.relativePath}</small></span>
                  <ChevronRight size={13} />
                </button>
              ))}
            </div> : <p className="agent-run-info-empty">这个 Session 还没有登记文件。</p>}
          </section>
        )}
      </div>
    </aside>
  )
}

type ToolActivity = {
  id: string
  name: string
  detail: string
  status: 'running' | 'completed' | 'failed'
}

type ThinkingActivity = {
  id: string
  segmentId: string | null
  content: string
  status: 'running' | 'completed'
}

export type LiveActivity =
  | { kind: 'thinking'; value: ThinkingActivity }
  | { kind: 'tool'; value: ToolActivity }

export type LiveActivityBlock =
  | { kind: 'thinking'; value: ThinkingActivity }
  | { kind: 'tool-group'; values: ToolActivity[] }

type MessageTimelineBlock =
  | { kind: 'message'; value: AgentRunMessage }
  | { kind: 'tool-group'; values: AgentRunMessage[] }
  | { kind: 'process'; values: AgentRunMessage[]; completedAt: string }

function toolSummary(detail: string): string {
  return detail.replace(/\s+/g, ' ').trim() || '正在调用工具'
}

function ToolCallItem({ tool }: { tool: ToolActivity }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const active = tool.status === 'running'

  return (
    <div className={`agent-tool-call ${active ? 'is-running' : ''} ${tool.status === 'failed' ? 'is-failed' : ''} ${expanded ? 'is-expanded' : ''}`}>
      <button
        className="agent-tool-call-summary"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        title={toolSummary(tool.detail)}
      >
        <span className="agent-tool-call-icon"><Wrench size={12} /></span>
        <strong>{tool.name}</strong>
        <span className="agent-tool-call-preview">{toolSummary(tool.detail)}</span>
        <small>{active ? '正在运行' : tool.status === 'failed' ? '失败' : '已调用'}</small>
      </button>
      {expanded && (
        <div className="agent-tool-call-detail"><pre>{tool.detail}</pre></div>
      )}
    </div>
  )
}

function ToolCallGroup({ tools }: { tools: ToolActivity[] }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const latest = tools.findLast((tool) => tool.status === 'running') ?? tools.at(-1)!
  const active = tools.some((tool) => tool.status === 'running')
  const failed = !active && tools.some((tool) => tool.status === 'failed')

  return (
    <div className={`agent-tool-call-group ${active ? 'is-running' : ''} ${failed ? 'is-failed' : ''} ${expanded ? 'is-expanded' : ''}`}>
      <button
        className="agent-tool-call-group-summary"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        title={toolSummary(latest.detail)}
      >
        <span className="agent-tool-call-icon"><Wrench size={12} /></span>
        <strong>{latest.name}</strong>
        <span className="agent-tool-call-preview">{toolSummary(latest.detail)}</span>
        <small>{active ? '正在运行' : failed ? '包含失败' : tools.length === 1 ? '已调用' : `${tools.length} 次调用`}</small>
      </button>
      {expanded && (
        <div className="agent-tool-call-group-detail">
          {tools.length === 1
            ? <pre>{tools[0].detail}</pre>
            : tools.map((tool) => <ToolCallItem key={tool.id} tool={tool} />)}
        </div>
      )}
    </div>
  )
}

function ThinkingMarker({ thinking }: { thinking: ThinkingActivity }): React.JSX.Element {
  const active = thinking.status === 'running'
  return (
    <div className={`agent-thinking-marker ${active ? 'is-running' : ''}`} role={active ? 'status' : undefined}>
      <div className="agent-thinking-marker-content">
        <strong>{active ? 'Thinking…' : 'Thinking'}</strong>
        {thinking.content && <Markdown content={thinking.content} />}
      </div>
    </div>
  )
}

function completeLiveActivities(activities: LiveActivity[]): LiveActivity[] {
  return activities.map((activity) => activity.kind === 'thinking'
    ? { ...activity, value: { ...activity.value, status: 'completed' } }
    : activity.value.status === 'running'
      ? { ...activity, value: { ...activity.value, status: 'completed' } }
      : activity)
}

export function applyAgentLiveUpdate(activities: LiveActivity[], update: AgentRunStreamUpdate): LiveActivity[] {
  if (update.type === 'reasoning_delta') {
    const segmentId = update.segmentId?.trim() || null
    const last = activities.at(-1)
    if (last?.kind === 'thinking' && last.value.status === 'running' && (!segmentId || !last.value.segmentId || last.value.segmentId === segmentId)) {
      return activities.map((activity, index) => index === activities.length - 1
        ? { ...last, value: { ...last.value, segmentId: last.value.segmentId ?? segmentId, content: last.value.content + update.delta } }
        : activity)
    }
    const completed = completeLiveActivities(activities)
    return [...completed, {
      kind: 'thinking',
      value: {
        id: `thinking-${segmentId ?? 'stream'}-${completed.length}`,
        segmentId,
        content: update.delta,
        status: 'running'
      }
    }]
  }

  if (update.type === 'tool') {
    const implicitRunningIndex = !update.toolCallId
      ? activities.findLastIndex((activity) => activity.kind === 'tool' && activity.value.name === update.toolName && activity.value.status === 'running')
      : -1
    let next = completeLiveActivities(activities)
    const explicitId = update.toolCallId?.trim() || null
    let matchingIndex = explicitId
      ? next.findIndex((activity) => activity.kind === 'tool' && activity.value.id === explicitId)
      : implicitRunningIndex
    if (matchingIndex >= 0) {
      next = next.map((activity, index) => index === matchingIndex && activity.kind === 'tool'
        ? { ...activity, value: { ...activity.value, detail: update.detail, status: update.status } }
        : activity)
      return next
    }
    return [...next, {
      kind: 'tool',
      value: {
        id: explicitId ?? `tool-${update.toolName}-${next.length}`,
        name: update.toolName,
        detail: update.detail,
        status: update.status
      }
    }]
  }

  if (update.type === 'message_delta' || update.type === 'approval' || (update.type === 'status' && update.status !== 'running')) {
    return completeLiveActivities(activities)
  }
  return activities
}

export type AgentRunLiveState = {
  busy: boolean
  streamingText: string
  activities: LiveActivity[]
  pendingApproval: AgentApprovalRequest | null
  visibleThinkingIndex: number
}

type QueuedRunMessage = {
  requestId: string
  content: string
  attachments: WorkAssistantImageAttachment[]
}

function emptyAgentRunLiveState(busy = false): AgentRunLiveState {
  return {
    busy,
    streamingText: '',
    activities: [],
    pendingApproval: null,
    visibleThinkingIndex: 0
  }
}

export function applyScopedAgentLiveUpdate(
  state: AgentRunLiveState,
  update: AgentRunStreamUpdate
): AgentRunLiveState {
  let streamingText = state.streamingText
  let activities = state.activities
  let visibleThinkingIndex = state.visibleThinkingIndex

  if (update.type === 'message_delta') streamingText += update.delta
  if (update.type === 'tool' && streamingText.trim()) {
    const content = streamingText.trim()
    const segmentId = `visible-thinking-${visibleThinkingIndex++}`
    streamingText = ''
    activities = applyAgentLiveUpdate(
      applyAgentLiveUpdate(activities, { type: 'reasoning_delta', segmentId, delta: content }),
      update
    ).slice(-16)
  } else {
    activities = applyAgentLiveUpdate(activities, update).slice(-16)
  }

  return {
    ...state,
    streamingText,
    activities,
    visibleThinkingIndex,
    pendingApproval: update.type === 'approval' ? update.request : state.pendingApproval
  }
}

export function applyAgentLiveUpdateForRun(
  states: Record<string, AgentRunLiveState>,
  runId: string,
  update: AgentRunStreamUpdate
): Record<string, AgentRunLiveState> {
  return {
    ...states,
    [runId]: applyScopedAgentLiveUpdate(states[runId] ?? emptyAgentRunLiveState(true), update)
  }
}

export function groupLiveActivities(activities: LiveActivity[]): LiveActivityBlock[] {
  return activities.reduce<LiveActivityBlock[]>((blocks, activity) => {
    if (activity.kind === 'thinking') {
      blocks.push(activity)
      return blocks
    }
    const last = blocks.at(-1)
    if (last?.kind === 'tool-group') last.values.push(activity.value)
    else blocks.push({ kind: 'tool-group', values: [activity.value] })
    return blocks
  }, [])
}

function appendOpenProcess(blocks: MessageTimelineBlock[], messages: AgentRunMessage[]): void {
  messages.forEach((message) => {
    if (message.role === 'tool') {
      const last = blocks.at(-1)
      if (last?.kind === 'tool-group') last.values.push(message)
      else blocks.push({ kind: 'tool-group', values: [message] })
      return
    }
    blocks.push({ kind: 'message', value: message })
  })
}

export function groupMessageTimeline(messages: AgentRunMessage[]): MessageTimelineBlock[] {
  const blocks: MessageTimelineBlock[] = []
  let processMessages: AgentRunMessage[] = []

  messages.forEach((message) => {
    const isProcessMessage = message.eventType === 'reasoning' || message.role === 'tool'
    if (isProcessMessage) {
      processMessages.push(message)
      return
    }

    if (processMessages.length > 0) {
      if (message.role === 'assistant') {
        blocks.push({ kind: 'process', values: processMessages, completedAt: message.createdAt })
      } else {
        appendOpenProcess(blocks, processMessages)
      }
      processMessages = []
    }
    blocks.push({ kind: 'message', value: message })
  })

  appendOpenProcess(blocks, processMessages)
  return blocks
}

export function formatAgentProcessDuration(startedAt: string, completedAt: string): string {
  const elapsedSeconds = Math.max(1, Math.round((new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1_000))
  const minutes = Math.floor(elapsedSeconds / 60)
  const seconds = elapsedSeconds % 60
  return minutes > 0 ? `耗时 ${minutes} 分 ${seconds} 秒` : `耗时 ${seconds} 秒`
}

function AgentProcessDisclosure({ messages, completedAt }: { messages: AgentRunMessage[]; completedAt: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const duration = formatAgentProcessDuration(messages[0].createdAt, completedAt)
  const blocks: MessageTimelineBlock[] = []
  appendOpenProcess(blocks, messages)

  return (
    <div className={`agent-process-disclosure ${expanded ? 'is-expanded' : ''}`}>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span>{duration}</span>
      </button>
      {expanded && (
        <div className="agent-process-detail">
          {blocks.map((block) => block.kind === 'tool-group'
            ? <ToolCallGroup
                key={`process-tool-group-${block.values[0].id}`}
                tools={block.values.map((message) => ({
                  id: message.id,
                  name: message.toolName ?? 'Tool',
                  detail: message.content,
                  status: 'completed'
                }))}
              />
            : block.kind === 'message'
              ? <ThinkingMarker key={block.value.id} thinking={{
                  id: block.value.id,
                  segmentId: typeof block.value.metadata?.segmentId === 'string' ? block.value.metadata.segmentId : null,
                  content: block.value.content,
                  status: 'completed'
                }} />
              : null)}
        </div>
      )}
    </div>
  )
}

function Markdown({ content, onOpenLink }: { content: string; onOpenLink?: (href: string) => boolean }): React.JSX.Element {
  return (
    <div className="chat-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href, ...props }) => (
            <a
              {...props}
              href={href}
              target={href && /^(https?:|mailto:)/i.test(href) ? '_blank' : undefined}
              rel={href && /^(https?:|mailto:)/i.test(href) ? 'noreferrer' : undefined}
              onClick={(event) => {
                if (href && onOpenLink?.(href)) event.preventDefault()
              }}
            >{children}</a>
          )
        }}
      >{normalizeChatMarkdown(content)}</ReactMarkdown>
    </div>
  )
}

function MessageAttachments({ metadata }: { metadata: Record<string, unknown> | null }): React.JSX.Element | null {
  const attachments = Array.isArray(metadata?.attachments)
    ? metadata.attachments.filter((item): item is { id?: string; name: string } => {
      return Boolean(item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string')
    })
    : []
  if (attachments.length === 0) return null
  return (
    <div className="chat-attachment-list" aria-label="消息附件">
      {attachments.map((attachment, index) => (
        <span key={attachment.id ?? `${attachment.name}-${index}`}><Paperclip size={12} />{attachment.name}</span>
      ))}
    </div>
  )
}

export function AgentRunsView({
  runs,
  projects,
  goals,
  selectedRunId,
  creating,
  prefill,
  onPrefillConsumed,
  onSelectRun,
  onCreatingChange,
  onRefresh,
  onNotice
}: {
  runs: AgentRun[]
  projects: Project[]
  goals: ProjectGoal[]
  selectedRunId: string | null
  creating: boolean
  prefill: { runId: string; prompt: string; requestId: string } | null
  onPrefillConsumed: () => void
  onSelectRun: (runId: string | null) => void
  onCreatingChange: (creating: boolean) => void
  onRefresh: () => Promise<void>
  onNotice: (notice: string | null) => void
}): React.JSX.Element {
  const [detail, setDetail] = useState<AgentRunDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [creatingBusy, setCreatingBusy] = useState(false)
  const [liveStateByRunId, setLiveStateByRunId] = useState<Record<string, AgentRunLiveState>>({})
  const [queuedMessagesByRunId, setQueuedMessagesByRunId] = useState<Record<string, QueuedRunMessage[]>>({})
  const [reply, setReply] = useState('')
  const [replyAttachments, setReplyAttachments] = useState<WorkAssistantImageAttachment[]>([])
  const [replyAttachmentError, setReplyAttachmentError] = useState<string | null>(null)
  const [renamingTitle, setRenamingTitle] = useState<string | null>(null)
  const [sessionActionBusy, setSessionActionBusy] = useState(false)
  const [infoSidebarOpen, setInfoSidebarOpen] = useState(false)
  const [infoSidebarWidth, setInfoSidebarWidth] = useState(initialAgentRunInfoWidth)
  const [resizingInfoSidebar, setResizingInfoSidebar] = useState(false)
  const [infoSidebarTab, setInfoSidebarTab] = useState<'info' | 'files'>('info')
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null)
  const [gitSummary, setGitSummary] = useState<GitWorkingTreeSummary | null>(null)
  const [gitSummaryLoading, setGitSummaryLoading] = useState(false)
  const [gitRefreshKey, setGitRefreshKey] = useState(0)
  const [provider, setProvider] = useState<AgentRunProvider>(projects[0]?.profile.defaultAgent ?? 'pi')
  const [projectId, setProjectId] = useState<string | null>(projects[0]?.id ?? null)
  const [milestoneValue, setMilestoneValue] = useState('')
  const [title, setTitle] = useState('')
  const threadEndRef = useRef<HTMLDivElement | null>(null)
  const previousCreatingRef = useRef(creating)
  const selectedRunIdRef = useRef(selectedRunId)
  const activeRequestIdByRunRef = useRef(new Map<string, string>())
  const persistedDraftPromptRef = useRef<{ runId: string; prompt: string } | null>(null)
  const infoSidebarResizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  const infoSidebarRunIdRef = useRef<string | null>(null)
  const selectedRunUpdatedAt = runs.find((run) => run.id === selectedRunId)?.updatedAt
  selectedRunIdRef.current = selectedRunId

  const visibleLiveState = detail ? liveStateByRunId[detail.run.id] : undefined
  const runBusy = visibleLiveState?.busy ?? false
  const queuedMessages = detail ? queuedMessagesByRunId[detail.run.id] ?? [] : []
  const runActive = Boolean(detail && (runBusy || runIsActive(detail.run) || queuedMessages.length > 0))
  const streamingText = visibleLiveState?.streamingText ?? ''
  const liveActivities = visibleLiveState?.activities ?? []
  const pendingApproval = visibleLiveState?.pendingApproval ?? null

  useEffect(() => {
    window.localStorage.setItem(agentRunInfoWidthStorageKey, String(infoSidebarWidth))
  }, [infoSidebarWidth])

  function startInfoSidebarResize(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || !infoSidebarOpen) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    infoSidebarResizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: infoSidebarWidth
    }
    setResizingInfoSidebar(true)
  }

  function moveInfoSidebarResize(event: React.PointerEvent<HTMLDivElement>): void {
    const resize = infoSidebarResizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    setInfoSidebarWidth(clampAgentRunInfoWidth(resize.startWidth + resize.startX - event.clientX))
  }

  function finishInfoSidebarResize(event: React.PointerEvent<HTMLDivElement>): void {
    if (infoSidebarResizeRef.current?.pointerId !== event.pointerId) return
    infoSidebarResizeRef.current = null
    setResizingInfoSidebar(false)
  }

  useEffect(() => {
    if (!replyAttachmentError) return
    const timer = window.setTimeout(() => setReplyAttachmentError(null), 5_000)
    return () => window.clearTimeout(timer)
  }, [replyAttachmentError])

  const milestoneOptions = useMemo(() => goals
    .filter((goal) => !projectId || goal.projectId === projectId)
    .flatMap((goal) => goal.milestones.map((milestone) => ({
      value: `${goal.id}:${milestone.id}`,
      label: milestone.title
    }))), [goals, projectId])

  useEffect(() => {
    if (!selectedRunId) {
      setDetail(null)
      setGitSummary(null)
      infoSidebarRunIdRef.current = null
      return
    }
    const selectedRunChanged = infoSidebarRunIdRef.current !== selectedRunId
    infoSidebarRunIdRef.current = selectedRunId
    let cancelled = false
    setLoadingDetail(true)
    setGitSummary(null)
    if (selectedRunChanged) {
      setInfoSidebarOpen(false)
      setInfoSidebarTab('info')
      setSelectedArtifactId(null)
    }
    setRenamingTitle(null)
    void window.projectAgent.getAgentRun(selectedRunId).then((nextDetail) => {
      if (!cancelled) {
        setDetail(nextDetail)
        persistedDraftPromptRef.current = { runId: nextDetail.run.id, prompt: nextDetail.run.draftPrompt ?? '' }
        setReply(nextDetail.messages.length === 0 ? nextDetail.run.draftPrompt ?? '' : '')
      }
    }).catch((error) => {
      if (!cancelled) onNotice(error instanceof Error ? error.message : 'Agent Run 读取失败。')
    }).finally(() => {
      if (!cancelled) setLoadingDetail(false)
    })
    return () => { cancelled = true }
  }, [selectedRunId, selectedRunUpdatedAt])

  useEffect(() => {
    if (!prefill || !detail || detail.run.id !== prefill.runId) return
    if (detail.run.status === 'running' || detail.run.status === 'queued') {
      onNotice('这个 Run 正在执行，已为你打开当前进度。')
    } else {
      setReply(prefill.prompt)
    }
    onPrefillConsumed()
  }, [prefill, detail?.run.id])

  useEffect(() => {
    if (!detail?.run.id || !infoSidebarOpen) return
    let cancelled = false
    setGitSummaryLoading(true)
    void window.projectAgent.getAgentRunGitSummary(detail.run.id).then((summary) => {
      if (!cancelled) setGitSummary(summary)
    }).catch(() => {
      if (!cancelled) setGitSummary({
        available: false,
        repoRoot: null,
        branch: null,
        head: null,
        additions: 0,
        deletions: 0,
        changedFileCount: 0,
        changes: [],
        error: 'Git 信息暂时不可用。'
      })
    }).finally(() => {
      if (!cancelled) setGitSummaryLoading(false)
    })
    return () => { cancelled = true }
  }, [detail?.run.id, detail?.run.updatedAt, infoSidebarOpen, gitRefreshKey])

  useEffect(() => {
    if (!detail || detail.run.status !== 'draft' || detail.messages.length > 0) return
    const persisted = persistedDraftPromptRef.current
    if (persisted?.runId === detail.run.id && persisted.prompt === reply) return
    const runId = detail.run.id
    const timer = window.setTimeout(() => {
      void window.projectAgent.updateAgentRunDraftPrompt(runId, reply).then((run) => {
        persistedDraftPromptRef.current = { runId, prompt: run.draftPrompt ?? '' }
        setDetail((current) => current?.run.id === runId ? { ...current, run } : current)
      }).catch((error) => {
        onNotice(error instanceof Error ? error.message : '草稿保存失败。')
      })
    }, 350)
    return () => window.clearTimeout(timer)
  }, [detail?.run.id, detail?.run.status, detail?.messages.length, reply])

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: 'end' })
  }, [detail?.messages.length, runBusy, liveActivities, streamingText])

  function appendOptimisticMessage(
    runId: string,
    requestId: string,
    content: string,
    attachments: WorkAssistantImageAttachment[]
  ): void {
    setDetail((current) => {
      if (current?.run.id !== runId || current.messages.some((message) => message.id === requestId)) return current
      return {
        ...current,
        messages: [...current.messages, {
          id: requestId,
          runId,
          role: 'user',
          content,
          eventType: null,
          toolName: null,
          metadata: { attachments: attachments.map(({ id, name, mimeType }) => ({ id, name, mimeType })) },
          createdAt: new Date().toISOString()
        }]
      }
    })
  }

  function removeQueuedMessage(runId: string, requestId: string): void {
    setQueuedMessagesByRunId((current) => ({
      ...current,
      [runId]: (current[runId] ?? []).filter((message) => message.requestId !== requestId)
    }))
  }

  function handleStream(
    runId: string,
    requestId: string,
    content: string,
    attachments: WorkAssistantImageAttachment[],
    update: AgentRunStreamUpdate
  ): void {
    if (update.type === 'status' && update.status === 'queued') return
    if (update.type === 'status' && update.status === 'running') {
      activeRequestIdByRunRef.current.set(runId, requestId)
      removeQueuedMessage(runId, requestId)
      appendOptimisticMessage(runId, requestId, content, attachments)
      setLiveStateByRunId((current) => ({ ...current, [runId]: emptyAgentRunLiveState(true) }))
      void onRefresh()
    }
    if (activeRequestIdByRunRef.current.get(runId) !== requestId) return
    setLiveStateByRunId((current) => applyAgentLiveUpdateForRun(current, runId, update))
    if (update.type === 'status') {
      setDetail((current) => current?.run.id === runId
        ? { ...current, run: { ...current.run, status: update.status, updatedAt: new Date().toISOString() } }
        : current)
    }
  }

  async function respondToApproval(decision: 'approve' | 'deny'): Promise<void> {
    if (!detail || !pendingApproval) return
    const runId = detail.run.id
    const request = pendingApproval
    setLiveStateByRunId((current) => ({
      ...current,
      [runId]: { ...(current[runId] ?? emptyAgentRunLiveState(true)), pendingApproval: null }
    }))
    try {
      await window.projectAgent.respondAgentApproval({ requestId: request.id, decision })
      onNotice(decision === 'approve' ? '已批准这一次操作。' : '已拒绝这一次操作，Agent 会继续尝试安全路径。')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '审批响应失败。')
    }
  }

  function projectDefaultAgent(nextProjectId: string | null): AgentRunProvider {
    return projects.find((project) => project.id === nextProjectId)?.profile.defaultAgent ?? 'pi'
  }

  function resetNewRun(): void {
    setDetail(null)
    setProvider(projectDefaultAgent(projectId))
    setMilestoneValue('')
    setTitle('')
  }

  useEffect(() => {
    const justStartedCreating = creating && !previousCreatingRef.current
    previousCreatingRef.current = creating
    if (justStartedCreating) resetNewRun()
  }, [creating])

  async function createRun(): Promise<void> {
    if (!title.trim() || creatingBusy) return
    const [goalId, milestoneId] = milestoneValue ? milestoneValue.split(':') : [null, null]
    setCreatingBusy(true)
    try {
      const result = await window.projectAgent.createAgentRunDraft({
        projectId,
        goalId,
        milestoneId,
        provider,
        title: title.trim()
      })
      setDetail(result)
      await onRefresh()
      onCreatingChange(false)
      onSelectRun(result.run.id)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Agent Run 创建失败。')
    } finally {
      setCreatingBusy(false)
    }
  }

  async function sendReply(): Promise<void> {
    if (!detail || (!reply.trim() && replyAttachments.length === 0)) return
    const runId = detail.run.id
    const requestId = crypto.randomUUID()
    const question = reply.trim() || '请查看附件并分析其中的内容。'
    const attachments = replyAttachments
    const queueBehindActiveTurn = runActive
    setReply('')
    setReplyAttachments([])
    setReplyAttachmentError(null)
    if (queueBehindActiveTurn) {
      setQueuedMessagesByRunId((current) => ({
        ...current,
        [runId]: [...(current[runId] ?? []), { requestId, content: question, attachments }]
      }))
    } else {
      activeRequestIdByRunRef.current.set(runId, requestId)
      setLiveStateByRunId((current) => ({ ...current, [runId]: emptyAgentRunLiveState(true) }))
      appendOptimisticMessage(runId, requestId, question, attachments)
    }
    try {
      const updated = await window.projectAgent.sendAgentRunMessage({
        requestId,
        runId,
        prompt: question,
        attachments
      }, (update) => handleStream(runId, requestId, question, attachments, update))
      if (selectedRunIdRef.current === runId && activeRequestIdByRunRef.current.get(runId) === requestId) {
        setDetail(updated)
      }
      await onRefresh()
    } catch (error) {
      removeQueuedMessage(runId, requestId)
      onNotice(error instanceof Error ? error.message : '消息发送失败。')
      const failedDetail = await window.projectAgent.getAgentRun(runId)
      if (selectedRunIdRef.current === runId && activeRequestIdByRunRef.current.get(runId) === requestId) {
        setDetail(failedDetail)
      }
    } finally {
      if (activeRequestIdByRunRef.current.get(runId) === requestId) {
        activeRequestIdByRunRef.current.delete(runId)
        setLiveStateByRunId((current) => {
          const next = { ...current }
          delete next[runId]
          return next
        })
      }
    }
  }

  async function stopCurrentReply(): Promise<void> {
    if (!detail || !runActive) return
    const runId = detail.run.id
    try {
      const updated = await window.projectAgent.stopAgentRunMessage(runId)
      if (selectedRunIdRef.current === runId && !activeRequestIdByRunRef.current.has(runId)) setDetail(updated)
      await onRefresh()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '停止当前回复失败。')
    }
  }

  async function addReplyAttachments(files: File[]): Promise<void> {
    const result = await prepareChatImages(files, replyAttachments.length)
    setReplyAttachments((current) => [...current, ...result.attachments].slice(0, maxChatImages))
    setReplyAttachmentError(result.error)
  }

  async function renameSession(): Promise<void> {
    if (!detail || !renamingTitle?.trim() || sessionActionBusy) return
    setSessionActionBusy(true)
    try {
      const run = await window.projectAgent.renameAgentRun(detail.run.id, renamingTitle.trim())
      setDetail((current) => current ? { ...current, run } : current)
      setRenamingTitle(null)
      await onRefresh()
      onNotice('Session 已重命名。')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Session 重命名失败。')
    } finally {
      setSessionActionBusy(false)
    }
  }

  async function archiveSession(): Promise<void> {
    if (!detail || sessionActionBusy || runIsActive(detail.run)) return
    setSessionActionBusy(true)
    try {
      await window.projectAgent.archiveAgentRun(detail.run.id)
      setDetail(null)
      onSelectRun(null)
      await onRefresh()
      onNotice('Session 已归档。')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Session 归档失败。')
    } finally {
      setSessionActionBusy(false)
    }
  }

  if (!selectedRunId && !creating) {
    return (
      <section className="agent-runs-view agent-run-chat-view">
        <header className="agent-run-page-header"><div><strong>Agent Runs</strong></div></header>
        <div className="agent-runs-empty">
          <MessageSquare size={28} />
          <strong>{runs.length === 0 ? '还没有 Agent Run' : '选择一个 Agent Run'}</strong>
          <button className="primary-small-button" onClick={() => onCreatingChange(true)}><Plus size={14} /> 新建 Run</button>
        </div>
      </section>
    )
  }

  if (creating) {
    return (
      <section className="agent-runs-view agent-run-chat-view">
        <header className="agent-run-page-header">
          <div><strong>创建 Agent Session</strong></div>
        </header>
        <div className="agent-run-create-shell">
          <div className="agent-run-create-form">
            <label><span>项目</span><SelectMenu value={projectId ?? ''} options={[{ value: '', label: '共享任务' }, ...projects.map((project) => ({ value: project.id, label: project.name }))]} onChange={(value) => { const nextProjectId = value || null; setProjectId(nextProjectId); setMilestoneValue(''); setProvider(projectDefaultAgent(nextProjectId)) }} ariaLabel="Run 所属项目" /></label>
            <label><span>Agent</span><SelectMenu value={provider} options={agentOptions} onChange={(value) => setProvider(value as AgentRunProvider)} ariaLabel="执行 Agent" /></label>
            <label><span>关联 Milestone（可选）</span><SelectMenu value={milestoneValue} options={[{ value: '', label: '不关联 Milestone' }, ...milestoneOptions]} onChange={setMilestoneValue} ariaLabel="关联 Milestone" /></label>
            <label><span>Session 标题</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：分析 Roombase 入驻阻塞" /></label>
            <button className="run-create-submit" onClick={() => void createRun()} disabled={!title.trim() || creatingBusy}>
              {creatingBusy ? <LoaderCircle size={15} className="spin" /> : <Bot size={15} />}
              {creatingBusy ? '正在创建…' : '创建 Session'}
            </button>
          </div>
        </div>
      </section>
    )
  }

  const detailProject = detail ? projects.find((project) => project.id === detail.run.projectId) : null
  const detailGoal = detail?.run.goalId ? goals.find((goal) => goal.id === detail.run.goalId) : null
  const detailMilestone = detailGoal?.milestones.find((milestone) => milestone.id === detail?.run.milestoneId)

  if (loadingDetail || !detail || detail.run.id !== selectedRunId) {
    return <section className="agent-runs-view agent-run-chat-view"><div className="agent-run-loading"><LoaderCircle size={20} className="spin" /> 正在读取 Session…</div></section>
  }

  const openArtifact = (artifactId: string | null): void => {
    setSelectedArtifactId(artifactId)
    setInfoSidebarTab('files')
    setInfoSidebarOpen(true)
  }

  const openMessageLink = (href: string): boolean => {
    if (/^(https?:|mailto:)/i.test(href) || href.startsWith('#')) return false
    const artifact = findArtifactForHref(detail.artifacts, href)
    if (artifact) openArtifact(artifact.id)
    else onNotice('这个文件尚未登记为当前 Session 的产物，无法在侧边栏预览。')
    return true
  }

  return (
    <section className="agent-runs-view agent-run-chat-view">
      <div
        className={`agent-run-chat-shell ${infoSidebarOpen ? 'is-info-open' : ''} ${resizingInfoSidebar ? 'is-resizing-info' : ''}`}
        style={{ '--agent-run-info-width': `${infoSidebarWidth}px` } as React.CSSProperties}
      >
      <div className="agent-run-chat-main">
      <header className="agent-run-page-header">
        <div>
          {renamingTitle === null ? <strong>{detail.run.title}</strong> : (
            <form className="agent-run-rename-form" onSubmit={(event) => { event.preventDefault(); void renameSession() }}>
              <input autoFocus value={renamingTitle} maxLength={200} onChange={(event) => setRenamingTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setRenamingTitle(null) }} aria-label="Session 标题" />
              <button type="submit" disabled={!renamingTitle.trim() || sessionActionBusy}>保存</button>
              <button type="button" disabled={sessionActionBusy} onClick={() => setRenamingTitle(null)}>取消</button>
            </form>
          )}
          <small className="agent-run-project-meta">
            {detailProject && <ProjectIcon project={detailProject} className="is-agent-run-meta" />}
            <span>{detailProject?.name ?? '共享任务'} · {detail.run.provider}</span>
          </small>
        </div>
        <div className="agent-run-header-actions">
          <button
            type="button"
            className={`agent-run-info-toggle ${infoSidebarOpen ? 'is-active' : ''}`}
            onClick={() => setInfoSidebarOpen((current) => !current)}
            aria-label={infoSidebarOpen ? '收起 Session 信息' : '展开 Session 信息'}
            aria-expanded={infoSidebarOpen}
          ><PanelRight size={17} /></button>
          <AgentRunActionsMenu
            disabled={sessionActionBusy}
            archiveDisabled={runIsActive(detail.run)}
            onRename={() => setRenamingTitle(detail.run.title)}
            onArchive={() => void archiveSession()}
          />
        </div>
      </header>
      {(detailMilestone || detail.run.workingDirectory) && (
        <div className="agent-run-context-bar">
          {detailMilestone && <span>{detailMilestone.title}</span>}
          {detail.run.workingDirectory && <code>{detail.run.workingDirectory}</code>}
        </div>
      )}
      <section className="agent-run-thread" aria-label={`${detail.run.title} 对话`}>
        <div className="agent-run-thread-inner">
          {groupMessageTimeline(detail.messages).map((block) => {
            if (block.kind === 'tool-group') {
              return <ToolCallGroup
                key={`tool-group-${block.values[0].id}`}
                tools={block.values.map((message) => ({
                  id: message.id,
                  name: message.toolName ?? 'Tool',
                  detail: message.content,
                  status: 'completed'
                }))}
              />
            }
            if (block.kind === 'process') {
              return <AgentProcessDisclosure
                key={`process-${block.values[0].id}`}
                messages={block.values}
                completedAt={block.completedAt}
              />
            }
            const message = block.value
            if (message.eventType === 'reasoning') {
              return <ThinkingMarker key={message.id} thinking={{
                id: message.id,
                segmentId: typeof message.metadata?.segmentId === 'string' ? message.metadata.segmentId : null,
                content: message.content,
                status: 'completed'
              }} />
            }
            return message.role === 'system' ? (
            <article className="agent-run-system-message" key={message.id}><CircleAlert size={14} /><Markdown content={message.content} /></article>
          ) : (
            <article className={`chat-turn is-${message.role}`} key={message.id}>
              <div className="chat-turn-content">
                <ConversationMessageActions content={message.content} createdAt={message.createdAt} />
                {message.role === 'user' && <MessageAttachments metadata={message.metadata} />}
                {message.role === 'user' ? <div className="chat-bubble"><Markdown content={message.content} onOpenLink={openMessageLink} /></div> : <Markdown content={message.content} onOpenLink={openMessageLink} />}
              </div>
            </article>
          )})}
          {runBusy && (
            <article className="chat-turn is-assistant is-pending">
              <div className="chat-turn-content">
                <div className="chat-turn-meta"><strong>{detail.run.provider}</strong><time>正在回复</time></div>
                <RunLiveActivity activities={liveActivities} streamingText={streamingText} approval={pendingApproval} onApproval={respondToApproval} />
              </div>
            </article>
          )}
          <div ref={threadEndRef} />
        </div>
      </section>
      <footer className="agent-run-composer-dock">
        {queuedMessages.length > 0 && (
          <div className="agent-run-message-queue" aria-label="已排队消息">
            {queuedMessages.map((message) => (
              <div className="agent-run-queued-message" key={message.requestId}>
                <span>{message.content}</span>
                <small>{message.attachments.length > 0 ? `${message.attachments.length} 个附件 · ` : ''}排队中</small>
              </div>
            ))}
          </div>
        )}
        <ChatComposer
          value={reply}
          onChange={setReply}
          onSubmit={sendReply}
          placeholder={`继续这个 ${detail.run.provider} Session…`}
          busy={runActive}
          allowSubmitWhileBusy
          onStop={stopCurrentReply}
          attachments={replyAttachments}
          attachmentError={replyAttachmentError}
          onAttachmentsSelected={addReplyAttachments}
          onRemoveAttachment={(id) => {
            setReplyAttachments((current) => current.filter((attachment) => attachment.id !== id))
            setReplyAttachmentError(null)
          }}
          submitAriaLabel="发送消息"
        />
      </footer>
      </div>
      <button className="agent-run-info-backdrop" type="button" aria-label="收起 Session 信息" onClick={() => setInfoSidebarOpen(false)} />
      <AgentRunInfoSidebar
        detail={detail}
        project={detailProject}
        milestoneTitle={detailMilestone?.title}
        gitSummary={gitSummary}
        gitLoading={gitSummaryLoading}
        activeTab={infoSidebarTab}
        selectedArtifactId={selectedArtifactId}
        onRefreshGit={() => setGitRefreshKey((current) => current + 1)}
        onTabChange={setInfoSidebarTab}
        onSelectArtifact={openArtifact}
        onClose={() => setInfoSidebarOpen(false)}
      />
      <div
        className="agent-run-info-resize-handle"
        role="separator"
        aria-label="调整 Session 信息栏宽度"
        aria-orientation="vertical"
        aria-valuemin={minimumAgentRunInfoWidth}
        aria-valuemax={maximumAgentRunInfoWidth}
        aria-valuenow={infoSidebarWidth}
        tabIndex={infoSidebarOpen ? 0 : -1}
        onPointerDown={startInfoSidebarResize}
        onPointerMove={moveInfoSidebarResize}
        onPointerUp={finishInfoSidebarResize}
        onPointerCancel={finishInfoSidebarResize}
        onLostPointerCapture={() => {
          infoSidebarResizeRef.current = null
          setResizingInfoSidebar(false)
        }}
        onDoubleClick={() => setInfoSidebarWidth(defaultAgentRunInfoWidth)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return
          event.preventDefault()
          setInfoSidebarWidth((current) => event.key === 'Home'
            ? defaultAgentRunInfoWidth
            : clampAgentRunInfoWidth(current + (event.key === 'ArrowLeft' ? 12 : -12)))
        }}
      />
      </div>
    </section>
  )
}

function RunLiveActivity({
  activities,
  approval,
  onApproval
}: {
  activities: LiveActivity[]
  streamingText: string
  approval: AgentApprovalRequest | null
  onApproval: (decision: 'approve' | 'deny') => Promise<void>
}): React.JSX.Element {
  return (
    <div className="agent-run-live">
      {approval && <div className="agent-run-approval">
        <ShieldCheck size={15} />
        <span><strong>{approval.title}</strong>{approval.detail}</span>
        <button onClick={() => void onApproval('deny')}>拒绝</button>
        <button className="is-primary" onClick={() => void onApproval('approve')}>仅批准这次</button>
      </div>}
      {groupLiveActivities(activities)
        .filter((block) => block.kind === 'tool-group')
        .map((block) => block.kind === 'tool-group'
          ? <ToolCallGroup key={`tool-group-${block.values[0].id}`} tools={block.values} />
          : null)}
    </div>
  )
}
