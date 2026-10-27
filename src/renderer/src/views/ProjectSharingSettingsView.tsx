import { useEffect, useState } from 'react'
import type { AgentRun, Project } from '../../../shared/contracts'
import type { AccountProjectSharingOverview, ExecutionHost } from '../../../shared/account'

export function ProjectSharingSettingsView({ project, runs }: { project: Project; runs: AgentRun[] }): React.JSX.Element {
  const [overview, setOverview] = useState<AccountProjectSharingOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [newToken, setNewToken] = useState<string | null>(null)
  const [hosts, setHosts] = useState<ExecutionHost[]>([])
  const projectId = project.shared?.id ?? project.id
  const publishedChats = runs.filter((run) => run.projectId === project.id && run.visibility !== 'draft')

  async function refresh(): Promise<void> {
    setLoading(true)
    try {
      const [nextOverview, nextHosts] = await Promise.all([
        window.projectAgent.getProjectSharingOverview(projectId),
        window.projectAgent.listExecutionHosts(project.id)
      ])
      setOverview(nextOverview)
      setHosts(nextHosts)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '共享状态读取失败。')
    } finally { setLoading(false) }
  }
  useEffect(() => { void refresh() }, [projectId])
  useEffect(() => {
    if (!status) return
    const timer = window.setTimeout(() => setStatus(null), 5_000)
    return () => window.clearTimeout(timer)
  }, [status])

  async function act(action: () => Promise<void>, success: string): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
      setStatus(success)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败。')
    } finally { setBusy(false) }
  }

  return <section className="project-settings-page project-sharing-settings" aria-label="项目共享">
    <div className="project-setting-section">
      <div className="project-setting-heading">
        <div><h2>项目共享</h2><p>成员可查看已发布的 Chat 和允许共享的项目设置，也可新建 Chat、发送消息。</p></div>
      </div>
      <div className="project-setting-fields">
        {loading && <div className="project-setting-field" role="status"><span>状态</span><span>正在读取共享状态…</span></div>}
        {error && <div className="project-setting-field" role="alert"><span>状态</span><span className="project-settings-error">{error}</span></div>}
        {status && <div className="project-setting-field" role="status"><span>提示</span><span>{status}</span></div>}
        {!loading && overview && !overview.share && <>
          <div className="project-setting-field">
            <span>历史预览</span><span>将发布本机 {publishedChats.length} 个已发送的 Chat，包括归档 Chat。草稿不会发布。</span>
          </div>
          {publishedChats.slice(0, 10).map((run) => <div className="project-setting-field" key={run.id}>
            <span>Chat</span><span>{run.title}</span>
          </div>)}
          {publishedChats.length > 10 && <div className="project-setting-field"><span>更多</span><span>另有 {publishedChats.length - 10} 个 Chat</span></div>}
          <div className="project-setting-field"><span>执行权限</span><span>成员的消息会使用你的执行 Mac、Agent 账户和额度；当前 Agent 为 Full Access。</span></div>
          <div className="project-setting-field"><span>附件</span><span>已发送 Chat 的附件和产物也会共享；原文件缺失时同步会失败。</span></div>
          <div className="project-setting-field"><span>操作</span><button type="button" disabled={busy}
            onClick={() => void act(async () => { await window.projectAgent.activateProjectSharing(project.id) },
              '共享项目已登记，历史内容已发布。')}>开启共享并发布历史</button></div>
        </>}
        {!loading && overview?.share && <>
          <div className="project-setting-field" role="status">
            <span>状态</span><span>已开启 · 密钥版本 {overview.share.keyEpoch}</span>
          </div>
          <div className="project-setting-field">
            <span>新 Chat 执行 Mac</span><select value={overview.share.executionHostId} disabled={busy}
              aria-label="新 Chat 执行 Mac" onChange={(event) => void act(async () => {
                await window.projectAgent.setProjectSharingHost(overview.share!.projectId, event.target.value)
              }, '新 Chat 的执行 Mac 已更新。')}>
              {hosts.map((host) => <option key={host.id} value={host.id}
                disabled={!host.online || !host.workspaceConfigured}>
                {host.name}{host.id === overview.share!.executionHostId ? ' · 当前' : ''}
                {!host.online ? ' · 离线' : !host.workspaceConfigured ? ' · 未配置目录' : ''}
              </option>)}
              {!hosts.some((host) => host.id === overview.share!.executionHostId) &&
                <option value={overview.share.executionHostId}>当前执行 Mac · 暂不可见</option>}
            </select>
          </div>
          <div className="project-setting-field">
            <span>历史同步</span><button type="button" disabled={busy}
              onClick={() => void act(async () => { await window.projectAgent.syncProjectSharing(overview.share!.projectId) },
                '本机共享历史已更新。')}>立即同步</button>
          </div>
          <div className="project-setting-field">
            <span>设备授权</span><button type="button" disabled={busy}
              onClick={() => void act(async () => {
                await window.projectAgent.authorizeProjectDevices(overview.share!.projectId)
              }, '待加入设备已检查。')}>授权待加入设备</button>
          </div>
          <div className="project-setting-field">
            <span>邀请成员</span><span className="project-sharing-invite-controls">
              <input value={email} type="email" placeholder="成员邮箱" aria-label="成员邮箱"
                onChange={(event) => setEmail(event.target.value)} />
              <button type="button" disabled={busy || !email.trim()} onClick={() => void act(async () => {
                const invitation = await window.projectAgent.inviteProjectMember(overview.share!.projectId, email.trim())
                setNewToken(invitation.token ?? null)
                setEmail('')
              }, '邀请已创建，请安全地将令牌发给受邀者。')}>创建邀请</button>
            </span>
          </div>
          {newToken && <div className="project-setting-field">
            <span>一次性令牌</span><span className="project-sharing-invite-controls">
              <input aria-label="一次性邀请令牌" readOnly value={newToken} onFocus={(event) => event.currentTarget.select()} />
              <button type="button" onClick={() => void navigator.clipboard.writeText(newToken)
                .then(() => setStatus('令牌已复制。'))
                .catch(() => setError('复制失败，请手动选择令牌。'))}>复制令牌</button>
            </span>
          </div>}
          {overview.members.map((member) => <div className="project-setting-field" key={member.userId}>
            <span>成员</span><span>{member.displayName?.trim() || '用户 ' + member.userId.slice(0, 6)}</span>
            <button type="button" disabled={busy} onClick={() => {
              if (!window.confirm('移除此成员并轮换共享密钥？已下载内容无法收回。')) return
              void act(() => window.projectAgent.removeProjectMember(overview.share!.projectId, member.userId),
                '成员已移除，请等待其他设备获取新密钥。')
            }}>移除</button>
          </div>)}
          {overview.invitations.filter((invitation) => invitation.status === 'pending').map((invitation) =>
            <div className="project-setting-field" key={invitation.id}>
              <span>待接受邀请</span><span>{invitation.email}</span>
              <button type="button" disabled={busy} onClick={() => void act(() =>
                window.projectAgent.revokeProjectInvitation(overview.share!.projectId, invitation.id),
              '邀请已撤销。')}>撤销</button>
            </div>)}
          <div className="project-setting-field">
            <span>关闭共享</span><button type="button" disabled={busy} onClick={() => {
              if (!window.confirm('关闭项目共享？所有成员将失去访问权，正在执行的成员请求会停止。')) return
              void act(() => window.projectAgent.closeProjectSharing(overview.share!.projectId),
                '项目共享已关闭。')
            }}>关闭项目共享</button>
          </div>
        </>}
      </div>
    </div>
  </section>
}
