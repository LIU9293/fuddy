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
  CodingAgentModelCatalog,
  CodingAgentProvider,
  CodingAgentSettings,
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
import { buildAgentModelLabels } from '../../../shared/model-display'
import { agentProviderDefinitions, codingAgentProviders } from '../../../shared/agent-providers'
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

export function ProjectStatusView({
  project,
  onSaved,
  onNotice
}: {
  project: Project
  onSaved: () => Promise<void>
  onNotice: (message: string) => void
}): React.JSX.Element {
  const [mission, setMission] = useState(project.profile.mission)
  const [vision, setVision] = useState(project.profile.vision)
  const [currentStateSummary, setCurrentStateSummary] = useState(project.profile.currentState.summary)
  const [currentStateFacts, setCurrentStateFacts] = useState(project.profile.currentState.facts.join('\n'))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useAutoDismissMessage(error, () => setError(null))

  useEffect(() => {
    setMission(project.profile.mission)
    setVision(project.profile.vision)
    setCurrentStateSummary(project.profile.currentState.summary)
    setCurrentStateFacts(project.profile.currentState.facts.join('\n'))
    setError(null)
  }, [project])

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      await window.projectAgent.updateProject({
        ...project,
        profile: {
          ...project.profile,
          mission: mission.trim(),
          vision: vision.trim(),
          currentState: {
            summary: currentStateSummary.trim(),
            facts: currentStateFacts
              .split('\n')
              .map((item) => item.trim())
              .filter(Boolean),
            source: 'user',
            updatedAt: new Date().toISOString()
          }
        }
      })
      await onSaved()
      onNotice(`${project.name} 项目状态已保存。`)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '项目状态保存失败。')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="project-status-page">
      <div className="project-status-section">
        <div className="project-status-heading">
          <strong>方向</strong>
          <p>使命说明现在为什么行动，愿景描述项目长期希望抵达的位置。</p>
        </div>
        <div className="project-status-fields">
          <label>
            <span>使命</span>
            <textarea rows={3} value={mission} onChange={(event) => setMission(event.target.value)} />
          </label>
          <label>
            <span>愿景</span>
            <textarea rows={3} value={vision} onChange={(event) => setVision(event.target.value)} />
          </label>
        </div>
      </div>

      <div className="project-status-section">
        <div className="project-status-heading">
          <strong>当前现状</strong>
          <p>这里保存已经确认的事实，是工作助理判断下一步和检查目标进展的基础。</p>
        </div>
        <div className="project-status-fields">
          <label>
            <span>现状总结</span>
            <textarea
              rows={4}
              value={currentStateSummary}
              onChange={(event) => setCurrentStateSummary(event.target.value)}
            />
          </label>
          <label>
            <span>已确认事实（每行一项）</span>
            <textarea
              rows={6}
              value={currentStateFacts}
              onChange={(event) => setCurrentStateFacts(event.target.value)}
            />
          </label>
        </div>
      </div>

      {error && <p className="project-settings-error">{error}</p>}
      <div className="project-settings-actions">
        <button
          className="provider-save-button"
          onClick={() => void save()}
          disabled={saving || !mission.trim() || !vision.trim() || !currentStateSummary.trim()}
        >
          {saving ? <LoaderCircle className="spin" size={13} /> : <ShieldCheck size={13} />}
          保存项目状态
        </button>
      </div>
    </section>
  )
}

export function ProjectSettingsView({
  project,
  onSaved,
  onNotice
}: {
  project: Project
  onSaved: () => Promise<void>
  onNotice: (message: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<UpdateProjectInput>(structuredClone(project))
  const [listFields, setListFields] = useState({
    surfaces: project.profile.surfaces.join('\n'),
    focusAreas: project.profile.focusAreas.join('\n'),
    dataSources: project.profile.dataSources.join('\n'),
    nextMoves: project.profile.nextMoves.join('\n')
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useAutoDismissMessage(error, () => setError(null))

  useEffect(() => {
    setDraft(structuredClone(project))
    setListFields({
      surfaces: project.profile.surfaces.join('\n'),
      focusAreas: project.profile.focusAreas.join('\n'),
      dataSources: project.profile.dataSources.join('\n'),
      nextMoves: project.profile.nextMoves.join('\n')
    })
    setError(null)
  }, [project])

  function updateProfile(patch: Partial<Project['profile']>): void {
    setDraft((current) => ({
      ...current,
      profile: { ...current.profile, ...patch }
    }))
  }

  function lines(value: string): string[] {
    return value
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean)
  }

  function updateWorkspaceRoot(id: string, patch: { label?: string; path?: string }): void {
    updateProfile({
      workspaceRoots: draft.profile.workspaceRoots.map((root) => (root.id === id ? { ...root, ...patch } : root))
    })
  }

  function addWorkspaceRoot(): void {
    const id = `workspace-${Date.now()}`
    updateProfile({
      workspaceRoots: [...draft.profile.workspaceRoots, { id, label: 'New workspace', path: '' }],
      primaryWorkspaceRootId: draft.profile.primaryWorkspaceRootId ?? id
    })
  }

  function removeWorkspaceRoot(id: string): void {
    const workspaceRoots = draft.profile.workspaceRoots.filter((root) => root.id !== id)
    updateProfile({
      workspaceRoots,
      primaryWorkspaceRootId:
        draft.profile.primaryWorkspaceRootId === id
          ? (workspaceRoots[0]?.id ?? null)
          : draft.profile.primaryWorkspaceRootId
    })
  }

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      const workspaces = normalizeWorkspaceRoots(draft.profile)
      await window.projectAgent.updateProject({
        ...draft,
        name: draft.name.trim(),
        summary: draft.summary.trim(),
        focus: draft.focus.trim(),
        profile: {
          ...draft.profile,
          productType: draft.profile.productType.trim(),
          stage: draft.profile.stage.trim(),
          ...workspaces,
          websiteUrl: draft.profile.websiteUrl?.trim() || null,
          surfaces: lines(listFields.surfaces),
          focusAreas: lines(listFields.focusAreas),
          dataSources: lines(listFields.dataSources),
          nextMoves: lines(listFields.nextMoves)
        }
      })
      await onSaved()
      onNotice(`${draft.name.trim()} 项目设置已保存。`)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '项目设置保存失败。')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="project-settings-page">
      <div className="project-setting-section">
        <div className="project-setting-heading">
          <h2>基本信息</h2>
          <p>项目在侧边栏、简报和 Agent 上下文中的身份。</p>
        </div>
        <div className="project-setting-fields">
          <label>
            <span>项目名称</span>
            <input
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            />
          </label>
          <label>
            <span>项目图标</span>
            <span className="project-icon-field">
              <ProjectIcon project={draft} className="is-preview" />
              {isProjectImageIcon(draft.icon) ? (
                <>
                  <span className="project-icon-image-label">当前使用项目 Logo</span>
                  <button
                    type="button"
                    className="project-icon-remove"
                    onClick={() => setDraft((current) => ({ ...current, icon: null }))}
                  >
                    移除
                  </button>
                </>
              ) : (
                <input
                  value={draft.icon ?? ''}
                  maxLength={16}
                  onChange={(event) => setDraft((current) => ({ ...current, icon: event.target.value || null }))}
                  placeholder="Emoji 或文字；留空使用项目名首字"
                  aria-label="项目图标"
                />
              )}
            </span>
          </label>
          <div className="project-setting-field">
            <span>状态</span>
            <SelectMenu
              value={draft.status}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'watching', label: 'Watching' },
                { value: 'paused', label: 'Paused' }
              ]}
              onChange={(status) => setDraft((current) => ({ ...current, status }))}
              ariaLabel="项目状态"
            />
          </div>
          <label>
            <span>一句话介绍</span>
            <textarea
              rows={2}
              value={draft.summary}
              onChange={(event) => setDraft((current) => ({ ...current, summary: event.target.value }))}
            />
          </label>
          <label>
            <span>Agent 分析视角</span>
            <input
              value={draft.focus}
              onChange={(event) => setDraft((current) => ({ ...current, focus: event.target.value }))}
              placeholder="Growth / Data / Operations"
            />
          </label>
        </div>
      </div>

      <div className="project-setting-section">
        <div className="project-setting-heading">
          <h2>产品上下文</h2>
          <p>帮助 Agent 理解项目形态、阶段和当前工作范围。</p>
        </div>
        <div className="project-setting-fields">
          <label>
            <span>产品类型</span>
            <input
              value={draft.profile.productType}
              onChange={(event) => updateProfile({ productType: event.target.value })}
            />
          </label>
          <label>
            <span>当前阶段</span>
            <input value={draft.profile.stage} onChange={(event) => updateProfile({ stage: event.target.value })} />
          </label>
          <label>
            <span>产品形态（每行一项）</span>
            <textarea
              rows={3}
              value={listFields.surfaces}
              onChange={(event) => setListFields((current) => ({ ...current, surfaces: event.target.value }))}
            />
          </label>
          <label>
            <span>重点领域（每行一项）</span>
            <textarea
              rows={4}
              value={listFields.focusAreas}
              onChange={(event) => setListFields((current) => ({ ...current, focusAreas: event.target.value }))}
            />
          </label>
        </div>
      </div>

      <div className="project-setting-section">
        <div className="project-setting-heading">
          <h2>代码与入口</h2>
          <p>普通 Run 和 Coding Run 都从主 Workspace 启动，并可访问此处列出的项目目录。</p>
        </div>
        <div className="project-setting-fields">
          <div className="project-setting-field workspace-roots-field">
            <span>Workspace Roots</span>
            <div className="workspace-root-editor">
              {draft.profile.workspaceRoots.map((root) => (
                <div className="workspace-root-row" key={root.id}>
                  <input
                    aria-label="Workspace 名称"
                    value={root.label}
                    onChange={(event) => updateWorkspaceRoot(root.id, { label: event.target.value })}
                    placeholder="名称"
                  />
                  <input
                    aria-label="Workspace 路径"
                    value={root.path}
                    onChange={(event) => updateWorkspaceRoot(root.id, { path: event.target.value })}
                    placeholder="/Users/name/Code/project"
                  />
                  <button type="button" onClick={() => removeWorkspaceRoot(root.id)} aria-label={`移除 ${root.label}`}>
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              <button type="button" className="workspace-root-add" onClick={addWorkspaceRoot}>
                <Plus size={13} /> 添加 Workspace
              </button>
            </div>
          </div>
          <div className="project-setting-field">
            <span>主 Workspace</span>
            <SelectMenu
              value={draft.profile.primaryWorkspaceRootId ?? ''}
              options={draft.profile.workspaceRoots.map((root) => ({
                value: root.id,
                label: root.label || root.path || root.id
              }))}
              onChange={(primaryWorkspaceRootId) => updateProfile({ primaryWorkspaceRootId })}
              ariaLabel="主 Workspace"
            />
          </div>
          <div className="project-setting-field">
            <span>默认 Agent</span>
            <SelectMenu
              value={draft.profile.defaultAgent}
              options={[
                { value: 'pi', label: 'Pi Agent' },
                { value: 'codex', label: 'Codex' },
                { value: 'claude', label: 'Claude Code' },
                { value: 'opencode', label: 'OpenCode' }
              ]}
              onChange={(defaultAgent) =>
                updateProfile({ defaultAgent: defaultAgent as Project['profile']['defaultAgent'] })
              }
              ariaLabel="默认 Agent"
            />
          </div>
          <label>
            <span>官网</span>
            <input
              type="url"
              value={draft.profile.websiteUrl ?? ''}
              onChange={(event) => updateProfile({ websiteUrl: event.target.value || null })}
              placeholder="https://example.com"
            />
          </label>
        </div>
      </div>

      <div className="project-setting-section">
        <div className="project-setting-heading">
          <h2>数据与下一步</h2>
          <p>定义项目自己的证据来源和当前优先事项。</p>
        </div>
        <div className="project-setting-fields">
          <label>
            <span>数据源（每行一项）</span>
            <textarea
              rows={5}
              value={listFields.dataSources}
              onChange={(event) => setListFields((current) => ({ ...current, dataSources: event.target.value }))}
            />
          </label>
          <label>
            <span>建议下一步（每行一项）</span>
            <textarea
              rows={5}
              value={listFields.nextMoves}
              onChange={(event) => setListFields((current) => ({ ...current, nextMoves: event.target.value }))}
            />
          </label>
        </div>
      </div>

      {error && <p className="project-settings-error">{error}</p>}
      <div className="project-settings-actions">
        <button
          className="provider-save-button"
          onClick={() => void save()}
          disabled={saving || !draft.name.trim() || !draft.summary.trim()}
        >
          {saving ? <LoaderCircle className="spin" size={13} /> : <ShieldCheck size={13} />}
          保存项目设置
        </button>
      </div>
    </section>
  )
}
