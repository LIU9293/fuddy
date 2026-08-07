import {
  Archive,
  ArrowLeft,
  Bot,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileOutput,
  Ellipsis,
  LoaderCircle,
  MessageSquare,
  PanelLeft,
  Pencil,
  Plus,
  ShieldCheck,
  Wrench
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  AgentApprovalRequest,
  AgentRun,
  AgentRunDetail,
  AgentRunMessage,
  AgentRunProvider,
  AgentRunStreamUpdate,
  Project,
  ProjectGoal
} from '../../../shared/contracts'
import { normalizeChatMarkdown } from '../markdown'
import { ChatComposer } from './ChatComposer'
import { SelectMenu } from './SelectMenu'

const agentOptions = [
  { value: 'pi', label: 'Pi Agent' },
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude Code' },
  { value: 'opencode', label: 'OpenCode' }
]

function runTime(run: AgentRun): string {
  const value = run.updatedAt || run.startedAt || run.createdAt
  const diffMinutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000))
  if (diffMinutes < 1) return '刚刚'
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`
  if (diffMinutes < 1_440) return `${Math.round(diffMinutes / 60)} 小时前`
  return `${Math.round(diffMinutes / 1_440)} 天前`
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

type ToolActivity = {
  id?: string
  name: string
  detail: string
  status: 'running' | 'completed' | 'failed'
}

function toolSummary(detail: string): string {
  return detail.replace(/\s+/g, ' ').trim() || '正在调用工具'
}

function ToolCallChain({ tools }: { tools: ToolActivity[] }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const latest = tools.at(-1)
  if (!latest) return null
  const active = latest.status === 'running'

  return (
    <div className={`agent-tool-chain ${active ? 'is-running' : ''} ${expanded ? 'is-expanded' : ''}`}>
      <button
        className="agent-tool-chain-summary"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        title={toolSummary(latest.detail)}
      >
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="agent-tool-chain-icon"><Wrench size={12} /></span>
        <strong>{latest.name}</strong>
        <span className="agent-tool-chain-preview">{toolSummary(latest.detail)}</span>
        <small>{active ? '正在运行' : tools.length > 1 ? `${tools.length} 次调用` : '已调用'}</small>
      </button>
      {expanded && (
        <div className="agent-tool-chain-detail">
          {tools.map((tool, index) => (
            <article className={tool.status === 'running' ? 'is-running' : ''} key={tool.id ?? `${tool.name}-${index}`}>
              <div>
                <span className="agent-tool-chain-step">{index + 1}</span>
                <strong>{tool.name}</strong>
                {tool.status === 'running' && <LoaderCircle size={11} className="spin" />}
              </div>
              <pre>{tool.detail}</pre>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}

function Markdown({ content }: { content: string }): React.JSX.Element {
  return (
    <div className="chat-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{normalizeChatMarkdown(content)}</ReactMarkdown>
    </div>
  )
}

export function AgentRunsSidebar({
  runs,
  projects,
  selectedRunId,
  onSelectRun,
  onNewRun,
  onBack,
  onCollapse
}: {
  runs: AgentRun[]
  projects: Project[]
  selectedRunId: string | null
  onSelectRun: (runId: string) => void
  onNewRun: () => void
  onBack: () => void
  onCollapse: () => void
}): React.JSX.Element {
  return (
    <>
      <div className="agent-runs-sidebar-header">
        <button onClick={onBack} aria-label="返回 Agent Runs 概览"><ArrowLeft size={17} /></button>
        <strong>Agent Runs</strong>
        <button onClick={onCollapse} aria-label="收起侧边栏"><PanelLeft size={17} /></button>
      </div>
      <button className="agent-runs-sidebar-new" onClick={onNewRun}><Plus size={15} /> 新建 Run</button>
      <div className="agent-runs-sidebar-label"><span>Sessions</span><small>{runs.length}</small></div>
      <nav className="agent-runs-sidebar-list" aria-label="Agent Run Sessions">
        {runs.map((run) => {
          const project = projects.find((item) => item.id === run.projectId)
          return (
            <button
              className={`${run.id === selectedRunId ? 'is-active' : ''} ${runIsActive(run) ? 'has-running-status' : ''}`.trim()}
              key={run.id}
              onClick={() => onSelectRun(run.id)}
            >
              {runIsActive(run) && <span className="run-status run-running"><LoaderCircle size={15} className="spin" /></span>}
              <span className="agent-runs-sidebar-copy">
                <strong>{run.title}</strong>
                <small>{runTime(run)} · {project?.name ?? '共享'} · {run.provider}</small>
              </span>
            </button>
          )
        })}
        {runs.length === 0 && <p>还没有 Agent Run</p>}
      </nav>
    </>
  )
}

export function AgentRunsView({
  runs,
  projects,
  goals,
  selectedRunId,
  creating,
  handoff,
  onHandoffConsumed,
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
  handoff: { id: string; projectId: string | null; title: string; prompt: string } | null
  onHandoffConsumed: () => void
  onSelectRun: (runId: string | null) => void
  onCreatingChange: (creating: boolean) => void
  onRefresh: () => Promise<void>
  onNotice: (notice: string | null) => void
}): React.JSX.Element {
  const [detail, setDetail] = useState<AgentRunDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [busy, setBusy] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [toolActivity, setToolActivity] = useState<ToolActivity[]>([])
  const [pendingApproval, setPendingApproval] = useState<AgentApprovalRequest | null>(null)
  const [reply, setReply] = useState('')
  const [renamingTitle, setRenamingTitle] = useState<string | null>(null)
  const [listRenameTarget, setListRenameTarget] = useState<AgentRun | null>(null)
  const [listRenameTitle, setListRenameTitle] = useState('')
  const [sessionActionBusy, setSessionActionBusy] = useState(false)
  const [provider, setProvider] = useState<AgentRunProvider>(projects[0]?.profile.defaultAgent ?? 'pi')
  const [projectId, setProjectId] = useState<string | null>(projects[0]?.id ?? null)
  const [milestoneValue, setMilestoneValue] = useState('')
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const threadEndRef = useRef<HTMLDivElement | null>(null)
  const handledHandoffRef = useRef<string | null>(null)
  const previousCreatingRef = useRef(creating)
  const selectedRunUpdatedAt = runs.find((run) => run.id === selectedRunId)?.updatedAt

  const milestoneOptions = useMemo(() => goals
    .filter((goal) => !projectId || goal.projectId === projectId)
    .flatMap((goal) => goal.milestones.map((milestone) => ({
      value: `${goal.id}:${milestone.id}`,
      label: milestone.title
    }))), [goals, projectId])

  useEffect(() => {
    if (!selectedRunId) {
      setDetail(null)
      return
    }
    let cancelled = false
    setLoadingDetail(true)
    setStreamingText('')
    setToolActivity([])
    setPendingApproval(null)
    setRenamingTitle(null)
    void window.projectAgent.getAgentRun(selectedRunId).then((nextDetail) => {
      if (!cancelled) setDetail(nextDetail)
    }).catch((error) => {
      if (!cancelled) onNotice(error instanceof Error ? error.message : 'Agent Run 读取失败。')
    }).finally(() => {
      if (!cancelled) setLoadingDetail(false)
    })
    return () => { cancelled = true }
  }, [selectedRunId, selectedRunUpdatedAt])

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: 'end' })
  }, [detail?.messages.length, busy, streamingText])

  function handleStream(update: AgentRunStreamUpdate): void {
    if (update.type === 'message_delta') setStreamingText((current) => current + update.delta)
    if (update.type === 'tool') {
      setToolActivity((current) => [
        ...current.filter((item) => item.name !== update.toolName || item.status === 'completed'),
        { name: update.toolName, detail: update.detail, status: update.status }
      ].slice(-8))
    }
    if (update.type === 'approval') setPendingApproval(update.request)
  }

  useEffect(() => {
    if (!handoff || handledHandoffRef.current === handoff.id) return
    handledHandoffRef.current = handoff.id
    onHandoffConsumed()
    setDetail(null)
    setStreamingText('')
    setToolActivity([])
    setPendingApproval(null)
    setProjectId(handoff.projectId)
    setProvider(projectDefaultAgent(handoff.projectId))
    setMilestoneValue('')
    setTitle(handoff.title)
    setPrompt(handoff.prompt)
    onCreatingChange(true)
  }, [handoff])

  async function respondToApproval(decision: 'approve' | 'deny'): Promise<void> {
    if (!pendingApproval) return
    const request = pendingApproval
    setPendingApproval(null)
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
    setStreamingText('')
    setToolActivity([])
    setPendingApproval(null)
    setProvider(projectDefaultAgent(projectId))
    setMilestoneValue('')
    setTitle('')
    setPrompt('')
  }

  useEffect(() => {
    const justStartedCreating = creating && !previousCreatingRef.current
    previousCreatingRef.current = creating
    if (justStartedCreating && !handoff) resetNewRun()
  }, [creating, handoff])

  async function createRun(): Promise<void> {
    if (!prompt.trim() || busy) return
    const [goalId, milestoneId] = milestoneValue ? milestoneValue.split(':') : [null, null]
    setBusy(true)
    setStreamingText('')
    setToolActivity([])
    try {
      const result = await window.projectAgent.dispatchTask({
        requestId: crypto.randomUUID(),
        projectId,
        goalId,
        milestoneId,
        provider,
        title: title.trim() || undefined,
        prompt: prompt.trim()
      }, handleStream)
      setDetail(result.detail)
      await onRefresh()
      onCreatingChange(false)
      onSelectRun(result.detail.run.id)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Agent Run 创建失败。')
    } finally {
      setBusy(false)
      setStreamingText('')
      setToolActivity([])
    }
  }

  async function sendReply(): Promise<void> {
    if (!detail || !reply.trim() || busy) return
    const question = reply.trim()
    setReply('')
    setBusy(true)
    setStreamingText('')
    setToolActivity([])
    setDetail((current) => current ? {
      ...current,
      messages: [...current.messages, {
        id: `optimistic-${Date.now()}`,
        runId: current.run.id,
        role: 'user',
        content: question,
        eventType: null,
        toolName: null,
        metadata: null,
        createdAt: new Date().toISOString()
      }]
    } : current)
    try {
      const updated = await window.projectAgent.sendAgentRunMessage({
        requestId: crypto.randomUUID(),
        runId: detail.run.id,
        prompt: question
      }, handleStream)
      setDetail(updated)
      await onRefresh()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '消息发送失败。')
      setDetail(await window.projectAgent.getAgentRun(detail.run.id))
    } finally {
      setBusy(false)
      setStreamingText('')
      setToolActivity([])
    }
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

  async function renameListedSession(): Promise<void> {
    if (!listRenameTarget || !listRenameTitle.trim() || sessionActionBusy) return
    setSessionActionBusy(true)
    try {
      await window.projectAgent.renameAgentRun(listRenameTarget.id, listRenameTitle.trim())
      setListRenameTarget(null)
      setListRenameTitle('')
      await onRefresh()
      onNotice('Session 已重命名。')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Session 重命名失败。')
    } finally {
      setSessionActionBusy(false)
    }
  }

  async function archiveListedSession(run: AgentRun): Promise<void> {
    if (sessionActionBusy || runIsActive(run)) return
    setSessionActionBusy(true)
    try {
      await window.projectAgent.archiveAgentRun(run.id)
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
      <section className="agent-runs-view agent-runs-overview">
        <div className="agent-runs-toolbar">
          <div><strong>{runs.length} 个 Session</strong><span>选择一个 Session，在完整聊天视图中继续工作。</span></div>
          <button className="primary-small-button" onClick={() => onCreatingChange(true)}><Plus size={14} /> 新建 Run</button>
        </div>
        <div className="agent-session-list">
          {runs.length === 0 ? (
            <div className="agent-runs-empty">
              <MessageSquare size={28} />
              <strong>还没有 Agent Run</strong>
              <span>选择项目和 Agent，创建一个可以持续对话的 Session。</span>
              <button className="primary-small-button" onClick={() => onCreatingChange(true)}><Plus size={14} /> 新建第一个 Run</button>
            </div>
          ) : runs.map((run) => {
            const project = projects.find((item) => item.id === run.projectId)
            const goal = goals.find((item) => item.id === run.goalId)
            const milestone = goal?.milestones.find((item) => item.id === run.milestoneId)
            return (
              <div className={`agent-session-row ${runIsActive(run) ? 'has-running-status' : ''}`} key={run.id}>
                <button className="agent-session-row-open" type="button" onClick={() => onSelectRun(run.id)}>
                  {runIsActive(run) && <span className="run-status run-running"><LoaderCircle size={15} className="spin" /></span>}
                  <span className="agent-session-main">
                    <span className="agent-session-title"><strong>{run.title}</strong></span>
                    <span>{project?.name ?? '共享'} · {run.provider}</span>
                    {milestone && <small>{milestone.title}</small>}
                  </span>
                  <span className="agent-session-summary">{run.summary}</span>
                  <span className="agent-session-time">{runTime(run)}</span>
                </button>
                <AgentRunActionsMenu
                  disabled={sessionActionBusy}
                  archiveDisabled={runIsActive(run)}
                  onRename={() => { setListRenameTarget(run); setListRenameTitle(run.title) }}
                  onArchive={() => void archiveListedSession(run)}
                />
              </div>
            )
          })}
        </div>
        {listRenameTarget && (
          <div className="agent-session-rename-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target && !sessionActionBusy) setListRenameTarget(null) }}>
            <form className="agent-session-rename-dialog" onSubmit={(event) => { event.preventDefault(); void renameListedSession() }}>
              <strong>Rename Session</strong>
              <input autoFocus value={listRenameTitle} maxLength={200} onChange={(event) => setListRenameTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape' && !sessionActionBusy) setListRenameTarget(null) }} aria-label="Session 新标题" />
              <div>
                <button type="button" disabled={sessionActionBusy} onClick={() => setListRenameTarget(null)}>取消</button>
                <button type="submit" disabled={!listRenameTitle.trim() || sessionActionBusy}>保存</button>
              </div>
            </form>
          </div>
        )}
      </section>
    )
  }

  if (creating) {
    return (
      <section className="agent-runs-view agent-run-chat-view">
        <header className="agent-run-page-header">
          <div><strong>创建 Agent Session</strong><small>选择项目和 Agent，然后直接开始对话</small></div>
        </header>
        <div className="agent-run-create-shell">
          <div className="agent-run-create-form">
            <label><span>项目</span><SelectMenu value={projectId ?? ''} options={[{ value: '', label: '共享任务' }, ...projects.map((project) => ({ value: project.id, label: project.name }))]} onChange={(value) => { const nextProjectId = value || null; setProjectId(nextProjectId); setMilestoneValue(''); setProvider(projectDefaultAgent(nextProjectId)) }} ariaLabel="Run 所属项目" /></label>
            <label><span>Agent</span><SelectMenu value={provider} options={agentOptions} onChange={(value) => setProvider(value as AgentRunProvider)} ariaLabel="执行 Agent" /></label>
            <label><span>关联 Milestone（可选）</span><SelectMenu value={milestoneValue} options={[{ value: '', label: '不关联 Milestone' }, ...milestoneOptions]} onChange={setMilestoneValue} ariaLabel="关联 Milestone" /></label>
            <label><span>Session 标题</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="可留空，自动使用任务第一行" /></label>
            <label className="run-prompt-field"><span>首次任务</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="描述要完成的工作、背景和验收标准…" rows={7} /></label>
            <p className="run-create-note">已带入项目的默认 Agent，也可以为本次 Run 覆盖。内容只会在你点击下方按钮后发送；所有 Agent 默认拥有完整本机访问权限并自动批准工具调用。</p>
            {busy && <RunLiveActivity streamingText={streamingText} tools={toolActivity} approval={pendingApproval} onApproval={respondToApproval} />}
            <button className="run-create-submit" onClick={() => void createRun()} disabled={!prompt.trim() || busy}>
              {busy ? <LoaderCircle size={15} className="spin" /> : <Bot size={15} />}
              {busy ? '正在创建并执行…' : '创建并开始运行'}
            </button>
          </div>
        </div>
      </section>
    )
  }

  const detailProject = detail ? projects.find((project) => project.id === detail.run.projectId) : null
  const detailGoal = detail?.run.goalId ? goals.find((goal) => goal.id === detail.run.goalId) : null
  const detailMilestone = detailGoal?.milestones.find((milestone) => milestone.id === detail?.run.milestoneId)

  if (loadingDetail || !detail) {
    return <section className="agent-runs-view agent-run-chat-view"><div className="agent-run-loading"><LoaderCircle size={20} className="spin" /> 正在读取 Session…</div></section>
  }

  return (
    <section className="agent-runs-view agent-run-chat-view">
      <header className="agent-run-page-header">
        <div>
          {renamingTitle === null ? <strong>{detail.run.title}</strong> : (
            <form className="agent-run-rename-form" onSubmit={(event) => { event.preventDefault(); void renameSession() }}>
              <input autoFocus value={renamingTitle} maxLength={200} onChange={(event) => setRenamingTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setRenamingTitle(null) }} aria-label="Session 标题" />
              <button type="submit" disabled={!renamingTitle.trim() || sessionActionBusy}>保存</button>
              <button type="button" disabled={sessionActionBusy} onClick={() => setRenamingTitle(null)}>取消</button>
            </form>
          )}
          <small>{detailProject?.name ?? '共享任务'} · {detail.run.provider}</small>
        </div>
        <AgentRunActionsMenu
          disabled={sessionActionBusy}
          archiveDisabled={runIsActive(detail.run)}
          onRename={() => setRenamingTitle(detail.run.title)}
          onArchive={() => void archiveSession()}
        />
      </header>
      {(detailMilestone || detail.run.workingDirectory) && (
        <div className="agent-run-context-bar">
          {detailMilestone && <span>{detailMilestone.title}</span>}
          {detail.run.workingDirectory && <code>{detail.run.workingDirectory}</code>}
        </div>
      )}
      <section className="agent-run-thread" aria-label={`${detail.run.title} 对话`}>
        <div className="agent-run-thread-inner">
          {detail.messages.map((message, messageIndex) => {
            if (message.role === 'tool') {
              if (detail.messages[messageIndex - 1]?.role === 'tool') return null
              const chain: AgentRunMessage[] = []
              for (let index = messageIndex; detail.messages[index]?.role === 'tool'; index += 1) {
                chain.push(detail.messages[index])
              }
              return <ToolCallChain key={`tool-chain-${message.id}`} tools={chain.map((tool) => ({
                id: tool.id,
                name: tool.toolName ?? 'Tool',
                detail: tool.content,
                status: 'completed'
              }))} />
            }
            return message.role === 'system' ? (
            <article className="agent-run-system-message" key={message.id}><CircleAlert size={14} /><Markdown content={message.content} /></article>
          ) : (
            <article className={`chat-turn is-${message.role}`} key={message.id}>
              <div className="chat-turn-content">
                <div className="chat-turn-meta"><strong>{message.role === 'user' ? '你' : detail.run.provider}</strong><time>{formatTimestamp(message.createdAt)}</time></div>
                {message.role === 'user' ? <div className="chat-bubble"><Markdown content={message.content} /></div> : <Markdown content={message.content} />}
              </div>
            </article>
          )})}
          {busy && (
            <article className="chat-turn is-assistant is-pending">
              <div className="chat-turn-content">
                <div className="chat-turn-meta"><strong>{detail.run.provider}</strong><time>正在回复</time></div>
                <RunLiveActivity streamingText={streamingText} tools={toolActivity} approval={pendingApproval} onApproval={respondToApproval} />
              </div>
            </article>
          )}
          {detail.artifacts.length > 0 && <div className="agent-run-artifacts">
            <strong>产物</strong>
            {detail.artifacts.map((artifact) => <button key={artifact.id} onClick={() => void window.projectAgent.revealWorkspacePath(artifact.projectId, artifact.relativePath)}><FileOutput size={14} /><span>{artifact.label}<small>{artifact.relativePath}</small></span></button>)}
          </div>}
          <div ref={threadEndRef} />
        </div>
      </section>
      <footer className="agent-run-composer-dock">
        <ChatComposer
          value={reply}
          onChange={setReply}
          onSubmit={sendReply}
          placeholder={`继续这个 ${detail.run.provider} Session…`}
          busy={busy}
          showVoiceInput={false}
          submitAriaLabel="发送消息"
        />
      </footer>
    </section>
  )
}

function RunLiveActivity({
  streamingText,
  tools,
  approval,
  onApproval
}: {
  streamingText: string
  tools: ToolActivity[]
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
      {tools.length > 0 && <ToolCallChain tools={tools} />}
      {streamingText && <Markdown content={streamingText} />}
      {!approval && !streamingText && tools.length === 0 && <div className="agent-run-live-idle"><LoaderCircle size={13} className="spin" /><span>Agent 正在处理…</span></div>}
    </div>
  )
}
