import {
  Bot,
  CalendarClock,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  X
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type {
  AutomationAction,
  AutomationJob,
  AutomationRun,
  AgentRunProvider,
  Project,
  SaveAutomationInput
} from '../../../shared/contracts'
import { SelectMenu } from './SelectMenu'

const actionLabels: Record<AutomationAction, string> = {
  'agent-task': 'Agent 任务',
  'run-connectors': 'Connector 巡检',
  'check-goals': '目标 Check-in',
  'generate-briefing': '生成简报'
}

const agentOptions = [
  { value: 'pi', label: 'Pi Agent' },
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude Code' },
  { value: 'opencode', label: 'OpenCode' }
]

const statusLabels: Record<AutomationJob['status'], string> = {
  idle: '等待下次运行',
  running: '运行中',
  'waiting-confirmation': '等待确认',
  paused: '已暂停',
  error: '上次运行失败'
}

const runStatusLabels: Record<AutomationRun['status'], string> = {
  'awaiting-confirmation': '等待确认',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  skipped: '已跳过'
}

function formatDate(value: string | null): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))
}

function blankInput(): SaveAutomationInput {
  return {
    projectId: null,
    name: '',
    scheduleDescription: '每天上午 09:00',
    cronExpression: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    action: 'run-connectors',
    prompt: '',
    agentProvider: 'pi',
    enabled: true,
    requiresConfirmation: false,
    maxRetries: 1,
    retryDelaySeconds: 30
  }
}

function inputFromJob(job: AutomationJob): SaveAutomationInput {
  return {
    id: job.id,
    projectId: job.projectId,
    name: job.name,
    scheduleDescription: job.scheduleDescription,
    cronExpression: job.cronExpression,
    timezone: job.timezone,
    action: job.action,
    prompt: job.prompt,
    agentProvider: job.agentProvider,
    enabled: job.enabled,
    requiresConfirmation: job.requiresConfirmation,
    maxRetries: job.maxRetries,
    retryDelaySeconds: job.retryDelaySeconds
  }
}

export function AutomationsView({
  automations,
  runs,
  projects,
  onRefresh,
  onNotice
}: {
  automations: AutomationJob[]
  runs: AutomationRun[]
  projects: Project[]
  onRefresh: () => Promise<void>
  onNotice: (notice: string | null) => void
}): React.JSX.Element {
  const [drawer, setDrawer] = useState<'form' | 'detail' | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<SaveAutomationInput>(blankInput)
  const [busy, setBusy] = useState<string | null>(null)
  const selected = automations.find((job) => job.id === selectedId) ?? null
  const selectedRuns = useMemo(
    () => runs.filter((run) => run.automationId === selectedId),
    [runs, selectedId]
  )

  function openCreate(): void {
    setDraft(blankInput())
    setSelectedId(null)
    setDrawer('form')
  }

  function openEdit(job: AutomationJob): void {
    setDraft(inputFromJob(job))
    setSelectedId(job.id)
    setDrawer('form')
  }

  function openDetail(job: AutomationJob): void {
    setSelectedId(job.id)
    setDrawer('detail')
  }

  async function save(): Promise<void> {
    if (!draft.name.trim() || busy) return
    setBusy('save')
    try {
      await window.projectAgent.saveAutomation(draft)
      await onRefresh()
      setDrawer(null)
      onNotice(draft.id ? '自动任务已更新。' : '自动任务已创建并进入调度。')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '自动任务保存失败。')
    } finally {
      setBusy(null)
    }
  }

  async function toggle(job: AutomationJob): Promise<void> {
    setBusy(`toggle:${job.id}`)
    try {
      await window.projectAgent.setAutomationEnabled(job.id, !job.enabled)
      await onRefresh()
      onNotice(job.enabled ? '自动任务已暂停。' : '自动任务已启用，并重新计算下次运行时间。')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '自动任务启停失败。')
    } finally {
      setBusy(null)
    }
  }

  async function runNow(job: AutomationJob): Promise<void> {
    setBusy(`run:${job.id}`)
    try {
      const result = await window.projectAgent.runAutomation(job.id)
      await onRefresh()
      onNotice(result.run.status === 'completed' ? `“${job.name}”运行完成。` : result.run.error ?? '自动任务运行失败。')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '自动任务运行失败。')
    } finally {
      setBusy(null)
    }
  }

  async function approve(run: AutomationRun): Promise<void> {
    setBusy(`approve:${run.id}`)
    try {
      const result = await window.projectAgent.approveAutomationRun(run.id)
      await onRefresh()
      onNotice(result.run.status === 'completed' ? '已确认并完成运行。' : result.run.error ?? '确认后的运行失败。')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '自动任务确认失败。')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="automations-view">
      <div className="automations-toolbar">
        <div>
          <strong>{automations.length} 个自动任务</strong>
          <span>按 Cron 计划运行 Agent、Connector、目标检查和简报。</span>
        </div>
        <button className="primary-small-button" onClick={openCreate}><Plus size={14} /> 新建自动任务</button>
      </div>

      <div className="automation-list">
        {automations.length === 0 ? (
          <div className="automation-empty">
            <CalendarClock size={30} />
            <strong>还没有自动任务</strong>
            <span>创建第一个 Cron Job，让项目巡检和 Agent 工作按计划自动发生。</span>
            <button className="primary-small-button" onClick={openCreate}><Plus size={14} /> 新建自动任务</button>
          </div>
        ) : automations.map((job) => {
          const project = projects.find((item) => item.id === job.projectId)
          const isRunning = busy === `run:${job.id}` || job.status === 'running'
          return (
            <article className="automation-row" key={job.id}>
              <button className="automation-row-main" onClick={() => openDetail(job)}>
                <span className={`automation-status status-${job.status}`}>
                  {job.status === 'running' ? <LoaderCircle size={15} className="spin" /> : job.status === 'error' ? <CircleAlert size={15} /> : job.enabled ? <CalendarClock size={15} /> : <Pause size={15} />}
                </span>
                <span className="automation-copy">
                  <span><strong>{job.name}</strong><i>{statusLabels[job.status]}</i></span>
                  <small>{project?.name ?? '全部项目'} · {actionLabels[job.action]} · {job.scheduleDescription}</small>
                  <code>{job.cronExpression} · {job.timezone}</code>
                </span>
                <span className="automation-next"><small>下次运行</small><strong>{formatDate(job.nextRunAt)}</strong></span>
                <ChevronRight size={15} />
              </button>
              <div className="automation-actions">
                <button onClick={() => void toggle(job)} disabled={Boolean(busy) || job.status === 'running'}>
                  {busy === `toggle:${job.id}` ? <LoaderCircle size={13} className="spin" /> : job.enabled ? <Pause size={13} /> : <Play size={13} />}
                  {job.enabled ? '暂停' : '启用'}
                </button>
                <button onClick={() => void runNow(job)} disabled={Boolean(busy) || job.status === 'running'}>
                  {isRunning ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />} 立即运行
                </button>
              </div>
            </article>
          )
        })}
      </div>

      {drawer && <div className="automation-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) setDrawer(null) }}>
        <aside className="automation-drawer">
          <div className="automation-drawer-header">
            <div><span>{drawer === 'form' ? draft.id ? 'EDIT AUTOMATION' : 'NEW AUTOMATION' : 'AUTOMATION DETAIL'}</span><strong>{drawer === 'form' ? draft.id ? '编辑自动任务' : '创建自动任务' : selected?.name}</strong></div>
            <button className="round-icon-button" onClick={() => { if (!busy) setDrawer(null) }} aria-label="关闭"><X size={16} /></button>
          </div>

          {drawer === 'form' ? (
            <div className="automation-form">
              <label><span>任务名称</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：每日项目巡检" /></label>
              <label><span>所属项目</span><SelectMenu value={draft.projectId ?? ''} options={[{ value: '', label: '全部项目' }, ...projects.map((project) => ({ value: project.id, label: project.name }))]} onChange={(value) => { const projectId = value || null; setDraft({ ...draft, projectId, agentProvider: projects.find((project) => project.id === projectId)?.profile.defaultAgent ?? 'pi' }) }} ariaLabel="自动任务所属项目" /></label>
              <label><span>执行动作</span><SelectMenu value={draft.action} options={Object.entries(actionLabels).map(([value, label]) => ({ value, label }))} onChange={(value) => setDraft({ ...draft, action: value as AutomationAction })} ariaLabel="自动任务动作" /></label>
              {draft.action === 'agent-task' && <>
                <label><span>Agent</span><SelectMenu value={draft.agentProvider} options={agentOptions} onChange={(value) => setDraft({ ...draft, agentProvider: value as AgentRunProvider })} ariaLabel="执行 Agent" /></label>
                <label><span>任务指令</span><textarea rows={7} value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} placeholder="描述每次计划触发时 Agent 要完成的工作和验收标准…" /></label>
              </>}
              <div className="automation-form-grid">
                <label><span>自然语言计划</span><input value={draft.scheduleDescription} onChange={(event) => setDraft({ ...draft, scheduleDescription: event.target.value })} /></label>
                <label><span>时区</span><input value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })} /></label>
              </div>
              <label><span>Cron Expression</span><input className="automation-cron-input" value={draft.cronExpression} onChange={(event) => setDraft({ ...draft, cronExpression: event.target.value })} placeholder="0 9 * * *" /><small>标准 5 段格式：分 时 日 月 周；支持列表、范围和 */步长。</small></label>
              <div className="automation-form-grid">
                <label><span>失败重试次数</span><input type="number" min={0} max={5} value={draft.maxRetries} onChange={(event) => setDraft({ ...draft, maxRetries: Number(event.target.value) })} /></label>
                <label><span>重试间隔（秒）</span><input type="number" min={0} max={3600} value={draft.retryDelaySeconds} onChange={(event) => setDraft({ ...draft, retryDelaySeconds: Number(event.target.value) })} /></label>
              </div>
              <label className="automation-checkbox"><input type="checkbox" checked={draft.requiresConfirmation} onChange={(event) => setDraft({ ...draft, requiresConfirmation: event.target.checked })} /><span><strong>计划触发后需要人工确认</strong><small>触发时先进入等待确认，不会直接执行动作。</small></span></label>
              <label className="automation-checkbox"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /><span><strong>保存后立即启用</strong><small>启用后自动计算下次运行时间。</small></span></label>
              <button className="automation-submit" onClick={() => void save()} disabled={!draft.name.trim() || !draft.scheduleDescription.trim() || !draft.cronExpression.trim() || Boolean(busy)}>{busy === 'save' ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{busy === 'save' ? '正在保存…' : '保存自动任务'}</button>
            </div>
          ) : selected ? (
            <div className="automation-detail">
              <div className="automation-detail-summary">
                <span className={`automation-status status-${selected.status}`}><CalendarClock size={16} /></span>
                <div><strong>{statusLabels[selected.status]}</strong><span>{selected.scheduleDescription} · {selected.cronExpression}</span></div>
                <button onClick={() => openEdit(selected)}>编辑</button>
              </div>
              <dl>
                <div><dt>执行动作</dt><dd>{actionLabels[selected.action]}</dd></div>
                <div><dt>所属项目</dt><dd>{projects.find((item) => item.id === selected.projectId)?.name ?? '全部项目'}</dd></div>
                <div><dt>上次运行</dt><dd>{formatDate(selected.lastRunAt)}</dd></div>
                <div><dt>下次运行</dt><dd>{formatDate(selected.nextRunAt)}</dd></div>
                <div><dt>失败策略</dt><dd>最多重试 {selected.maxRetries} 次，间隔 {selected.retryDelaySeconds} 秒</dd></div>
                <div><dt>确认门</dt><dd>{selected.requiresConfirmation ? '需要人工确认' : '自动执行'}</dd></div>
              </dl>
              {selected.lastError && <div className="automation-error"><CircleAlert size={14} /><span>{selected.lastError}</span></div>}
              <div className="automation-history-heading"><strong>运行记录</strong><span>{selectedRuns.length} 次</span></div>
              <div className="automation-history">
                {selectedRuns.length === 0 ? <p>还没有运行记录。</p> : selectedRuns.map((run) => (
                  <article key={run.id} className={`automation-history-row run-${run.status}`}>
                    <span>{run.status === 'completed' ? <Check size={13} /> : run.status === 'failed' ? <CircleAlert size={13} /> : run.status === 'awaiting-confirmation' ? <ShieldCheck size={13} /> : <Clock3 size={13} />}</span>
                    <div><strong>{runStatusLabels[run.status]} · {run.trigger === 'manual' ? '手动' : '计划'}</strong><small>{run.summary}</small>{run.error && <i>{run.error}</i>}</div>
                    <time>{formatDate(run.startedAt)}</time>
                    {run.status === 'awaiting-confirmation' && <button onClick={() => void approve(run)} disabled={Boolean(busy)}>{busy === `approve:${run.id}` ? <LoaderCircle size={12} className="spin" /> : <Play size={12} />} 确认运行</button>}
                  </article>
                ))}
              </div>
              <button className="automation-detail-run" onClick={() => void runNow(selected)} disabled={Boolean(busy) || selected.status === 'running'}>{busy === `run:${selected.id}` ? <LoaderCircle size={14} className="spin" /> : <Bot size={14} />} 立即运行</button>
            </div>
          ) : null}
        </aside>
      </div>}
    </section>
  )
}
