import { ArrowLeft, Plus, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AccountProjectShare } from '../../../shared/account'
import type { SharedProjectBaselineData } from '../../../shared/project-sharing-events'
import type { SharedProjectCommand } from '../../../shared/project-sharing-commands'
import type { SharedProjectMemberActivity } from '../../../shared/project-sharing-commands'
import type { ChatAttachmentInput } from '../../../shared/chat-attachments'
import { maximumChatAttachments } from '../../../shared/chat-attachments'
import type { SharedAttachmentView } from '../../../shared/project-sharing-attachments'
import { ChatComposer } from '../components/ChatComposer'
import { ConversationShell } from '../components/ConversationShell'
import { ConversationSpeaker, ConversationUserSpeaker } from '../components/ConversationSpeaker'
import { UserMessageBubble } from '../components/UserMessageBubble'
import { conversationAuthors } from '../conversation-authors'
import { normalizeChatMarkdown } from '../markdown'
import { prepareChatAttachments } from '../chat-attachments'

function sharedMarkdownUrl(url: string): string {
  return /^(https?:|mailto:)/iu.test(url) ? url : ''
}

async function awaitCommand(projectId: string, commandId: string): Promise<SharedProjectCommand> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const command = await window.projectAgent.getSharedProjectCommand(projectId, commandId)
    if (command.status === 'completed') return command
    if (['failed', 'cancelled', 'interrupted'].includes(command.status)) {
      throw new Error(command.errorCode === 'authorization_lost'
        ? '项目授权已变化，执行已停止。'
        : command.errorCode === 'execution_host_offline'
          ? '执行 Mac 已离线，这次请求没有运行。请上线后重新提交。'
        : '执行 Mac 未完成这次操作，请刷新状态后重试。')
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 1_000))
  }
  throw new Error('执行 Mac 暂未确认这次操作，请稍后刷新。')
}

export function SharedProjectsView({ currentUserId, currentUserDisplayName }: {
  currentUserId: string | null
  currentUserDisplayName?: string | null
}): React.JSX.Element {
  const [shares, setShares] = useState<AccountProjectShare[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [data, setData] = useState<SharedProjectBaselineData | null>(null)
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<SharedProjectMemberActivity['drafts']>([])
  const [activeTurns, setActiveTurns] = useState<SharedProjectMemberActivity['activeTurns']>([])
  const [invitationToken, setInvitationToken] = useState('')
  const [message, setMessage] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachmentInput[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const loadActivity = useCallback(async (projectId: string): Promise<void> => {
    try {
      const activity = await window.projectAgent.listSharedProjectActivity(projectId)
      setDrafts(activity.drafts)
      setActiveTurns(activity.activeTurns)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Chat 状态读取失败。')
    }
  }, [])

  const refreshShares = useCallback(async (): Promise<void> => {
    try { setShares(await window.projectAgent.listSharedProjects()) }
    catch (error) { setStatus(error instanceof Error ? error.message : '共享项目读取失败。') }
  }, [])
  const refreshData = useCallback(async (projectId: string): Promise<void> => {
    try {
      setData(await window.projectAgent.readSharedProject(projectId))
      setStatus(null)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '共享内容读取失败。')
    }
  }, [])

  useEffect(() => { void refreshShares() }, [refreshShares])
  useEffect(() => {
    setData(null)
    setSelectedChatId(null)
    setDrafts([])
    setActiveTurns([])
    setAttachments([])
    if (selectedProjectId) {
      void refreshData(selectedProjectId)
      void loadActivity(selectedProjectId)
    }
  }, [selectedProjectId, refreshData, loadActivity])

  useEffect(() => {
    setAttachments([])
    setAttachmentError(null)
  }, [selectedChatId])

  useEffect(() => {
    if (!selectedProjectId) return
    let active = true
    const timer = window.setInterval(() => {
      void window.projectAgent.readSharedProject(selectedProjectId)
        .then((updated) => { if (active) setData(updated) })
        .catch(() => undefined)
    }, 15_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [selectedProjectId])

  useEffect(() => {
    if (!selectedProjectId || activeTurns.length === 0) return
    const timer = window.setInterval(() => {
      void Promise.all(activeTurns.map(async (turn) => {
        try {
          const command = await window.projectAgent.getSharedProjectCommand(selectedProjectId, turn.commandId)
          if (['completed', 'failed', 'cancelled', 'interrupted'].includes(command.status)) {
            setActiveTurns((current) => current.filter((item) => item.commandId !== turn.commandId))
            await refreshData(selectedProjectId)
            if (command.status !== 'completed') setStatus(command.errorCode === 'execution_host_offline'
              ? '执行 Mac 已离线，这次请求没有运行。请上线后重新提交。'
              : '这次执行未完成，请检查 Chat 状态。')
          }
        } catch (error) {
          setStatus(error instanceof Error ? error.message : '执行状态读取失败。')
        }
      }))
    }, 3_000)
    return () => window.clearInterval(timer)
  }, [selectedProjectId, activeTurns, refreshData])

  const activeChat = data?.chats.find((chat) => chat.id === selectedChatId) ?? null
  const localDraft = drafts.find((draft) => draft.runId === selectedChatId) ?? null
  const currentTurn = activeTurns.find((turn) => turn.runId === selectedChatId) ?? null
  const chatTitle = activeChat?.title ?? localDraft?.title ?? null
  const messages = data?.messages.filter((item) => item.runId === selectedChatId) ?? []
  const authors = conversationAuthors(messages, { id: currentUserId, displayName: currentUserDisplayName }, {
    userId: activeChat?.createdByUserId, snapshot: activeChat?.createdBySnapshot
  })

  async function acceptInvitation(): Promise<void> {
    if (!invitationToken.trim() || busy) return
    setBusy(true)
    try {
      const projectId = await window.projectAgent.acceptProjectInvitation(invitationToken.trim())
      setInvitationToken('')
      await refreshShares()
      setSelectedProjectId(projectId)
      setStatus('邀请已接受，正在等待项目所有者授权这台设备。')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法接受邀请。')
    } finally { setBusy(false) }
  }

  async function createChat(): Promise<void> {
    if (!selectedProjectId || busy) return
    const title = '新建 Chat'
    setBusy(true)
    try {
      const submitted = await window.projectAgent.submitSharedProjectCommand({
        projectId: selectedProjectId, runId: null, requestId: null,
        payload: { type: 'create-chat', title }
      })
      const completed = await awaitCommand(selectedProjectId, submitted.commandId)
      if (!completed.resultRunId) throw new Error('执行 Mac 未返回 Chat ID。')
      setDrafts((current) => [{ runId: completed.resultRunId!, title }, ...current])
      setSelectedChatId(completed.resultRunId)
      setStatus('草稿已建立。发送第一条消息后其他成员才能看到。')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '新建 Chat 失败。')
    } finally { setBusy(false) }
  }

  async function sendMessage(): Promise<void> {
    if (!selectedProjectId || !selectedChatId || (!message.trim() && attachments.length === 0) || busy) return
    const prompt = message.trim() || '请查看附件'
    const requestId = crypto.randomUUID()
    setBusy(true)
    try {
      const uploaded = attachments.length ? await window.projectAgent.uploadSharedProjectAttachments({
        projectId: selectedProjectId, runId: selectedChatId, requestId, attachments
      }) : []
      const submitted = await window.projectAgent.submitSharedProjectCommand({
        projectId: selectedProjectId, runId: selectedChatId, requestId,
        payload: { type: 'send-message', prompt, ...(uploaded.length ? { attachments: uploaded } : {}) }
      })
      setMessage('')
      setAttachments([])
      setAttachmentError(null)
      setStatus('请求已提交，等待执行 Mac 确认。')
      setActiveTurns((current) => [...current, { commandId: submitted.commandId,
        runId: selectedChatId, requestId }])
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '消息发送失败。')
    } finally {
      setBusy(false)
    }
  }

  async function addAttachments(files: File[]): Promise<void> {
    const result = await prepareChatAttachments(files, attachments.length)
    setAttachments((current) => [...current, ...result.attachments].slice(0, maximumChatAttachments))
    setAttachmentError(result.error)
  }

  async function downloadAttachment(descriptor: SharedAttachmentView): Promise<void> {
    if (!selectedProjectId) return
    try {
      const file = await window.projectAgent.downloadSharedProjectAttachment(selectedProjectId, descriptor)
      const blob = await (await fetch(file.dataUrl)).blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = file.filename
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '附件下载失败。')
    }
  }

  async function stopTurn(): Promise<void> {
    if (!selectedProjectId || !currentTurn) return
    try {
      const submitted = await window.projectAgent.submitSharedProjectCommand({
        projectId: selectedProjectId, runId: currentTurn.runId,
        requestId: currentTurn.requestId, payload: { type: 'stop-turn' }
      })
      await awaitCommand(selectedProjectId, submitted.commandId)
      setStatus('停止请求已由执行 Mac 确认。')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '停止请求失败。')
    }
  }

  async function manageChat(payload: { type: 'rename-chat'; title: string } | { type: 'archive-chat' }): Promise<void> {
    if (!selectedProjectId || !activeChat || busy || activeChat.createdByUserId !== currentUserId) return
    setBusy(true)
    try {
      const submitted = await window.projectAgent.submitSharedProjectCommand({
        projectId: selectedProjectId, runId: activeChat.id, requestId: null, payload
      })
      await awaitCommand(selectedProjectId, submitted.commandId)
      await refreshData(selectedProjectId)
      setStatus(payload.type === 'archive-chat' ? 'Chat 已归档。' : 'Chat 已重命名。')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Chat 操作失败。')
    } finally { setBusy(false) }
  }

  async function leaveProject(): Promise<void> {
    if (!selectedProjectId || busy || !window.confirm('退出后，这台设备将无法继续读取此项目。')) return
    setBusy(true)
    try {
      await window.projectAgent.leaveSharedProject(selectedProjectId)
      setSelectedProjectId(null)
      setData(null)
      setDrafts([])
      setActiveTurns([])
      await refreshShares()
      setStatus('已退出共享项目。')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '退出项目失败。')
    } finally { setBusy(false) }
  }

  if (!selectedProjectId) return <section className="shared-projects-page" aria-label="与我共享">
    <div className="shared-projects-content">
      {status && <p className="shared-projects-status" role="status">{status}</p>}
      <div className="project-setting-section">
        <div className="project-setting-heading"><div><h2>接受项目邀请</h2><p>加入后可查看已发布的 Chat 和附件、新建 Chat 并发送消息；获得设备授权后显示项目名称。</p></div></div>
        <div className="shared-projects-invite-row">
          <input value={invitationToken} onChange={(event) => setInvitationToken(event.target.value)} aria-label="项目邀请令牌" placeholder="fuddy_invite_…" />
          <button type="button" onClick={() => void acceptInvitation()} disabled={busy || !invitationToken.trim()}>接受邀请</button>
        </div>
      </div>
      <div className="project-setting-section">
        <div className="project-setting-heading"><div><h2>与我共享</h2><p>项目 Chat 由所有者指定的 Mac 执行。</p></div></div>
        {shares.map((share) => <button type="button" className="shared-projects-row" key={share.projectId}
          onClick={() => setSelectedProjectId(share.projectId)}>共享项目 · {share.projectId.slice(0, 8)}</button>)}
        {shares.length === 0 && <p>还没有与你共享的项目。</p>}
      </div>
    </div>
  </section>

  return <section className="shared-projects-page shared-project-detail" aria-label="共享项目">
    <div className="shared-projects-chat-list">
      <div className="shared-projects-list-header">
        <button type="button" onClick={() => setSelectedProjectId(null)} aria-label="返回与我共享"><ArrowLeft size={17} /></button>
        <strong>{data?.project.name || '共享项目'}</strong>
        <button type="button" onClick={() => void refreshData(selectedProjectId)} aria-label="刷新共享内容"><RefreshCw size={15} /></button>
      </div>
      {data && <div className="shared-projects-project-info" aria-label="项目设置（只读）">
        <strong>{data.project.name}</strong>
        <span>{data.project.summary}</span>
        <small>{data.project.productType} · {data.project.stage} · {data.project.status}</small>
      </div>}
      {status && <p className="shared-projects-status" role="status">{status}</p>}
      {data?.pendingSources && data.pendingSources.length > 0 &&
        <p className="shared-projects-status" role="status">部分历史尚未同步：{data.pendingSources.join('、')}</p>}
      <button type="button" className="shared-projects-new-chat" onClick={() => void createChat()} disabled={busy || !data}>
        <Plus size={15} /> 新建 Chat
      </button>
      {data?.chats.map((chat) => <button type="button" key={chat.id}
        className={'shared-projects-chat-row ' + (selectedChatId === chat.id ? 'is-active' : '')}
        onClick={() => setSelectedChatId(chat.id)}>
        <strong>{chat.title}</strong><small>{chat.archivedAt ? '已归档 · ' : ''}{chat.createdBySnapshot?.displayName ?? '历史用户'}</small>
      </button>)}
      {drafts.filter((draft) => !data?.chats.some((chat) => chat.id === draft.runId)).map((draft) =>
        <button type="button" key={draft.runId} className={'shared-projects-chat-row ' +
          (selectedChatId === draft.runId ? 'is-active' : '')}
          onClick={() => setSelectedChatId(draft.runId)}><strong>{draft.title}</strong><small>草稿 · 仅你可见</small></button>)}
      {!data && status && <button type="button" onClick={() => {
        void window.projectAgent.requestProjectDeviceGrant(selectedProjectId).then(() =>
          setStatus('已申请设备授权，请项目所有者打开项目共享设置。'))
          .catch((error: unknown) => setStatus(error instanceof Error ? error.message : '设备授权申请失败。'))
      }}>申请设备授权</button>}
      <button type="button" className="shared-projects-leave" onClick={() => void leaveProject()} disabled={busy}>退出共享项目</button>
    </div>
    {chatTitle ? <div className="shared-projects-chat-main">
      <div className="shared-projects-chat-title"><strong>{chatTitle}</strong>
        {activeChat?.createdByUserId === currentUserId && !activeChat.archivedAt && <span className="shared-projects-chat-actions">
          <button type="button" disabled={busy} onClick={() => {
            const title = window.prompt('Chat 新标题', activeChat.title)?.trim()
            if (title && title !== activeChat.title) void manageChat({ type: 'rename-chat', title })
          }}>重命名</button>
          <button type="button" disabled={busy} onClick={() => {
            if (window.confirm('归档这个 Chat？')) void manageChat({ type: 'archive-chat' })
          }}>归档</button>
        </span>}
      </div>
      <ConversationShell ariaLabel={chatTitle + ' 对话'} resetKey={selectedChatId}
        composer={<ChatComposer value={message} onChange={setMessage} onSubmit={sendMessage}
          onStop={stopTurn} busy={busy || Boolean(currentTurn)} disabled={Boolean(activeChat?.archivedAt)}
          attachments={attachments} attachmentError={attachmentError} allowAttachments imageOnly={false}
          onAttachmentsSelected={addAttachments}
          onRemoveAttachment={(id) => setAttachments((current) => current.filter((item) => item.id !== id))}
          placeholder={activeChat?.archivedAt ? '这个 Chat 已归档' : '发送消息给项目 Agent…'} submitAriaLabel="发送消息" />}>
        {messages.map((item) =>
          <article className={'chat-turn is-' + item.role} key={item.id}><div className="chat-turn-content">
            {item.role === 'user'
              ? <ConversationUserSpeaker message={item} authors={authors} />
              : <ConversationSpeaker label="Agent" />}
            {item.role === 'user'
              ? <UserMessageBubble content={item.content} />
              : <div className="chat-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}
                urlTransform={sharedMarkdownUrl}>{normalizeChatMarkdown(item.content)}</ReactMarkdown></div>}
            {item.attachments?.map((attachment) => <button type="button" key={attachment.id}
              onClick={() => void downloadAttachment(attachment)}>{attachment.filename}</button>)}
          </div></article>)}
        {data?.artifacts?.filter((artifact) => artifact.runId === selectedChatId && artifact.kind === 'artifact')
          .map((artifact) => <button type="button" key={artifact.id}
            onClick={() => void downloadAttachment(artifact)}>下载产物：{artifact.filename}</button>)}
        {localDraft && !activeChat && <p className="agent-run-draft-empty">草稿 · 发送第一条消息后才会发布。</p>}
      </ConversationShell>
    </div> : <div className="shared-projects-empty-chat">选择一个 Chat 查看共享对话。</div>}
  </section>
}
