import {
  ArchiveX,
  ArrowDown,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Clock3,
  Database,
  Folder,
  GitBranch,
  Headphones,
  Inbox,
  Lightbulb,
  LayoutGrid,
  Laptop,
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
  Smartphone,
  Square,
  Target,
  Workflow,
  X,
  Trash2,
  UserRound
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
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
import type { CompanionMacStatus } from '../../../shared/companion-sync'
import { buildAgentModelLabels } from '../../../shared/model-display'
import { agentProviderDefinitions, codingAgentProviders } from '../../../shared/agent-providers'
import type { AccountDeviceSummary, AccountIdentity, AccountState } from '../../../shared/account'
import { userFacingErrorMessage } from '../user-facing-error'
import {
  codingAgentOptions,
  connectorStatusLabels,
  decisionWaitingReasonLabels,
  formatDecisionSource,
  formatRelativeTime,
  kindIcons,
  kindLabels,
  settingsNavigationItems,
  settingsSectionTitles,
  useAutoDismissMessage,
  type SettingsSection
} from './shared'

export function SettingsView({
  bootstrap,
  section,
  projectId,
  projectLocked = false,
  onProjectChange,
  onRefresh,
  onNotice
}: {
  bootstrap: AppBootstrap
  section: SettingsSection
  projectId: string | null
  projectLocked?: boolean
  onProjectChange: (projectId: string | null) => void
  onRefresh: () => Promise<void>
  onNotice: (message: string) => void
}): React.JSX.Element {
  const [busyConnectors, setBusyConnectors] = useState<Set<string>>(new Set())
  const [runningAll, setRunningAll] = useState(false)
  const [postgresFormOpen, setPostgresFormOpen] = useState(false)
  const [postgresConnection, setPostgresConnection] = useState('')
  const [postgresMetricView, setPostgresMetricView] = useState('')
  const [postgresAnalyticsProfile, setPostgresAnalyticsProfile] = useState('')
  const [postgresError, setPostgresError] = useState<string | null>(null)
  const [savingPostgres, setSavingPostgres] = useState(false)
  const [connectorFormKind, setConnectorFormKind] = useState<Exclude<ConnectorKind, 'repo' | 'postgres'> | null>(null)
  const [connectorFields, setConnectorFields] = useState<Record<string, string>>({})
  const [connectorSetupError, setConnectorSetupError] = useState<string | null>(null)
  const [savingConnector, setSavingConnector] = useState(false)
  const [agentPrimary, setAgentPrimary] = useState(bootstrap.providerSettings.agent.primary)
  const [agentBackup, setAgentBackup] = useState(bootstrap.providerSettings.agent.backup)
  const [agentBackupEnabled, setAgentBackupEnabled] = useState(bootstrap.providerSettings.agent.backupEnabled)
  const [agentApiKeys, setAgentApiKeys] = useState({ primary: '', backup: '' })
  const [codingAgents, setCodingAgents] = useState<CodingAgentSettings>(bootstrap.providerSettings.codingAgents)
  const [codingAgentModels, setCodingAgentModels] = useState<CodingAgentModelCatalog | null>(null)
  const [codingModelsLoading, setCodingModelsLoading] = useState(false)
  const [asrSettings, setAsrSettings] = useState(bootstrap.providerSettings.asr)
  const [asrApiKey, setAsrApiKey] = useState('')
  const [asrModelStatus, setAsrModelStatus] = useState<AsrModelStatus | null>(null)
  const [ttsPrimary, setTtsPrimary] = useState(bootstrap.providerSettings.tts.primary)
  const [ttsBackup, setTtsBackup] = useState(bootstrap.providerSettings.tts.backup)
  const [ttsBackupEnabled, setTtsBackupEnabled] = useState(bootstrap.providerSettings.tts.backupEnabled)
  const [ttsApiKeys, setTtsApiKeys] = useState({ primary: '', backup: '' })
  const [providerBusy, setProviderBusy] = useState<
    | 'agent'
    | 'coding-agents'
    | 'coding-detect'
    | 'asr'
    | 'asr-download'
    | 'asr-delete'
    | 'tts'
    | 'tts-test'
    | null
  >(null)
  const [providerError, setProviderError] = useState<string | null>(null)
  const [requestingComputerPermissions, setRequestingComputerPermissions] = useState(false)
  const [projectAgentBusy, setProjectAgentBusy] = useState<string | null>(null)
  const [companionStatus, setCompanionStatus] = useState<CompanionMacStatus | null>(null)
  const [companionRelayAvailable, setCompanionRelayAvailable] = useState(false)
  const [companionBusy, setCompanionBusy] = useState<'sync' | null>(null)
  const [companionError, setCompanionError] = useState<string | null>(null)
  const [accountState, setAccountState] = useState<AccountState | null>(null)
  const [accountIdentities, setAccountIdentities] = useState<AccountIdentity[]>([])
  const [accountDevices, setAccountDevices] = useState<AccountDeviceSummary[]>([])
  const [accountBusy, setAccountBusy] = useState(false)
  const [accountError, setAccountError] = useState<string | null>(null)
  const [modelSettingsTab, setModelSettingsTab] = useState<'assistant' | 'coding'>('assistant')
  const [editingAgentSlot, setEditingAgentSlot] = useState<'primary' | 'backup' | null>(null)
  const [expandedCodingAgent, setExpandedCodingAgent] = useState<CodingAgentProvider | null>(null)
  const [voiceSettingsTab, setVoiceSettingsTab] = useState<'input' | 'output'>('input')
  const [voiceAdvancedOpen, setVoiceAdvancedOpen] = useState(false)
  const [microphoneTesting, setMicrophoneTesting] = useState(false)
  useAutoDismissMessage(postgresError, () => setPostgresError(null))
  useAutoDismissMessage(connectorSetupError, () => setConnectorSetupError(null))
  useAutoDismissMessage(providerError, () => setProviderError(null))
  useAutoDismissMessage(companionError, () => setCompanionError(null))
  useAutoDismissMessage(accountError, () => setAccountError(null))
  const visibleConnectors = bootstrap.connectors.filter((connector) => !projectId || connector.projectId === projectId)
  const catalogConnectors = bootstrap.connectorCatalog.filter(
    (item) => item.kind !== 'repo' && (item.kind === 'postgres' || item.availability === 'built-in')
  )
  const selectedProject = bootstrap.projects.find((project) => project.id === projectId)
  const selectedPostgres = bootstrap.connectors.find(
    (connector) => connector.projectId === projectId && connector.kind === 'postgres'
  )

  useEffect(() => {
    if (section !== 'general') return
    let active = true
    void window.projectAgent.getAccountState().then(async (state) => {
      if (!active) return
      setAccountState(state)
      if (state.status !== 'signed-in') return
      try {
        const [identities, devices] = await Promise.all([
          window.projectAgent.listAccountIdentities(),
          window.projectAgent.listAccountDevices()
        ])
        if (!active) return
        setAccountIdentities(identities)
        setAccountDevices(devices)
      } catch (error) {
        if (active) setAccountError(userFacingErrorMessage(error, '无法读取账户设备。'))
      }
    })
    return () => { active = false }
  }, [section])

  useEffect(() => {
    setAgentPrimary(bootstrap.providerSettings.agent.primary)
    setAgentBackup(bootstrap.providerSettings.agent.backup)
    setAgentBackupEnabled(bootstrap.providerSettings.agent.backupEnabled)
    setCodingAgents(bootstrap.providerSettings.codingAgents)
    setAsrSettings(bootstrap.providerSettings.asr)
    setTtsPrimary(bootstrap.providerSettings.tts.primary)
    setTtsBackup(bootstrap.providerSettings.tts.backup)
    setTtsBackupEnabled(bootstrap.providerSettings.tts.backupEnabled)
  }, [bootstrap.providerSettings])

  async function logoutAccount(): Promise<void> {
    if (accountBusy) return
    setAccountBusy(true)
    setAccountError(null)
    try {
      setAccountState(await window.projectAgent.logoutAccount())
    } catch (error) {
      setAccountError(userFacingErrorMessage(error, '退出账户失败。'))
    } finally {
      setAccountBusy(false)
    }
  }

  async function logoutAllAccounts(): Promise<void> {
    if (accountBusy) return
    setAccountBusy(true)
    setAccountError(null)
    try {
      setAccountState(await window.projectAgent.logoutAllAccounts())
    } catch (error) {
      setAccountError(userFacingErrorMessage(error, '退出所有设备失败。'))
    } finally {
      setAccountBusy(false)
    }
  }

  async function toggleGoogleIdentity(): Promise<void> {
    if (accountBusy) return
    setAccountBusy(true)
    setAccountError(null)
    try {
      const linked = accountIdentities.some((identity) => identity.provider === 'google')
      setAccountIdentities(
        linked
          ? await window.projectAgent.unlinkGoogleAccount()
          : await window.projectAgent.linkGoogleAccount()
      )
    } catch (error) {
      setAccountError(userFacingErrorMessage(error, 'Google 账户连接失败。'))
    } finally {
      setAccountBusy(false)
    }
  }

  async function revokeAccountDevice(deviceId: string): Promise<void> {
    if (accountBusy) return
    setAccountBusy(true)
    setAccountError(null)
    try {
      await window.projectAgent.revokeAccountDevice(deviceId)
      setAccountDevices(await window.projectAgent.listAccountDevices())
      onNotice('设备访问已撤销。')
    } catch (error) {
      setAccountError(userFacingErrorMessage(error, '设备撤销失败。'))
    } finally {
      setAccountBusy(false)
    }
  }

  async function retryAccountDetails(): Promise<void> {
    if (accountBusy) return
    setAccountBusy(true)
    setAccountError(null)
    try {
      const state = await window.projectAgent.getAccountState()
      setAccountState(state)
      if (state.status !== 'signed-in') return
      const [identities, devices] = await Promise.all([
        window.projectAgent.listAccountIdentities(),
        window.projectAgent.listAccountDevices()
      ])
      setAccountIdentities(identities)
      setAccountDevices(devices)
    } catch (error) {
      setAccountError(userFacingErrorMessage(error, '暂时无法读取账户信息。'))
    } finally {
      setAccountBusy(false)
    }
  }

  useEffect(() => {
    if (section !== 'voice') return
    let active = true
    void window.projectAgent
      .getAsrModelStatus()
      .then((status) => {
        if (active) setAsrModelStatus(status)
      })
      .catch((error: unknown) => {
        if (active) setProviderError(error instanceof Error ? error.message : '无法读取 Whisper 模型状态。')
      })
    const unsubscribe = window.projectAgent.onAsrDownloadProgress((progress) => {
      if (!active) return
      setAsrModelStatus({
        state: 'downloading',
        model: 'large-v3-turbo-q5_0',
        bytesDownloaded: progress.bytesDownloaded,
        totalBytes: progress.totalBytes,
        error: null
      })
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [section])

  useEffect(() => {
    let active = true
    void Promise.all([
      window.projectAgent.getCompanionStatus(),
      window.projectAgent.getCompanionRelayConfiguration()
    ])
      .then(([status, relay]) => {
        if (!active) return
        setCompanionStatus(status)
        setCompanionRelayAvailable(relay.available)
      })
      .catch((error: unknown) => {
        if (active) setCompanionError(error instanceof Error ? error.message : '无法读取 iPhone Companion 状态。')
      })
    const unsubscribe = window.projectAgent.onCompanionStatusChanged((status) => {
      if (active) setCompanionStatus(status)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (section !== 'models') return
    let active = true
    setCodingModelsLoading(true)
    void window.projectAgent
      .listCodingAgentModels()
      .then((catalog) => {
        if (active) setCodingAgentModels(catalog)
      })
      .catch((error: unknown) => {
        if (active) setProviderError(error instanceof Error ? error.message : 'Coding Agent 模型读取失败。')
      })
      .finally(() => {
        if (active) setCodingModelsLoading(false)
      })
    return () => {
      active = false
    }
  }, [section])

  function updateAgentEndpoint(slot: 'primary' | 'backup', patch: Partial<AgentEndpointSettings>): void {
    const setter = slot === 'primary' ? setAgentPrimary : setAgentBackup
    setter((current) => ({ ...current, ...patch }))
  }

  function changeAgentMode(slot: 'primary' | 'backup', mode: AgentProviderMode): void {
    const current = slot === 'primary' ? agentPrimary : agentBackup
    if (current.mode === mode) return
    updateAgentEndpoint(slot, {
      mode,
      baseUrl: current.mode === 'cc-switch-codex-oauth' ? 'https://api.openai.com/v1' : current.baseUrl
    })
  }

  function updateTtsEndpoint(slot: 'primary' | 'backup', patch: Partial<TtsEndpointSettings>): void {
    const setter = slot === 'primary' ? setTtsPrimary : setTtsBackup
    setter((current) => ({ ...current, ...patch }))
  }

  function changeTtsMode(slot: 'primary' | 'backup', mode: TtsProviderMode): void {
    const current = slot === 'primary' ? ttsPrimary : ttsBackup
    if (current.mode === mode) return
    if (mode === 'elevenlabs') {
      updateTtsEndpoint(slot, {
        mode,
        baseUrl: 'https://api.elevenlabs.io/v1',
        model: 'eleven_multilingual_v2',
        voice: '',
        instructions: ''
      })
      return
    }
    if (mode === 'openai-compatible') {
      updateTtsEndpoint(slot, {
        mode,
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini-tts',
        voice: 'marin',
        instructions: '使用自然、清晰、克制的中文语气，像一位熟悉业务的项目助理。'
      })
      return
    }
    updateTtsEndpoint(slot, { mode })
  }

  function latestRunFor(connectorId: string): ConnectorRun | undefined {
    return bootstrap.connectorRuns.find((run) => run.connectorId === connectorId)
  }

  async function runConnector(connector: ConnectorInstance): Promise<void> {
    setBusyConnectors((current) => new Set(current).add(connector.id))
    try {
      const result = await window.projectAgent.runConnector(connector.id)
      onNotice(result.message)
      await onRefresh()
    } finally {
      setBusyConnectors((current) => {
        const next = new Set(current)
        next.delete(connector.id)
        return next
      })
    }
  }

  async function runAll(): Promise<void> {
    setRunningAll(true)
    try {
      const result = await window.projectAgent.runConnectors(projectId)
      const decisions = result.results.filter((item) => item.decision).length
      onNotice(`巡检完成：${result.succeeded} 个成功，${result.failed} 个失败，新增 ${decisions} 条决策项。`)
      await onRefresh()
    } finally {
      setRunningAll(false)
    }
  }

  async function toggleConnector(connector: ConnectorInstance): Promise<void> {
    await window.projectAgent.setConnectorEnabled(connector.id, !connector.enabled)
    onNotice(`${connector.name} 已${connector.enabled ? '停用' : '启用'}。`)
    await onRefresh()
  }

  function openPostgresForm(): void {
    if (!projectId) return
    if (selectedPostgres?.config.credentialSource === 'env-file') {
      onNotice('该生产分析连接由项目 Analytics Profile 管理，不在 UI 中展开凭证。')
      return
    }
    if (selectedPostgres) {
      const { host, port, database, user, sslMode, metricView } = selectedPostgres.config
      setPostgresConnection(
        `postgresql://${encodeURIComponent(String(user))}@${String(host)}:${String(port)}/${encodeURIComponent(String(database))}?sslmode=${String(sslMode)}`
      )
      setPostgresMetricView(typeof metricView === 'string' ? metricView : '')
      setPostgresAnalyticsProfile(
        typeof selectedPostgres.config.analyticsProfile === 'string' ? selectedPostgres.config.analyticsProfile : ''
      )
    } else {
      setPostgresConnection('')
      setPostgresMetricView('')
      setPostgresAnalyticsProfile(
        bootstrap.analyticsProfiles.find((profile) => profile.projectId === projectId)?.id ?? ''
      )
    }
    setPostgresError(null)
    setPostgresFormOpen(true)
  }

  function closePostgresForm(): void {
    setPostgresFormOpen(false)
    setPostgresConnection('')
    setPostgresMetricView('')
    setPostgresAnalyticsProfile('')
    setPostgresError(null)
  }

  async function configurePostgres(): Promise<void> {
    if (!projectId || !postgresConnection.trim()) return
    setSavingPostgres(true)
    setPostgresError(null)
    try {
      const result = await window.projectAgent.configurePostgres({
        projectId,
        connectionString: postgresConnection.trim(),
        metricView: postgresMetricView.trim() || undefined,
        analyticsProfile: postgresAnalyticsProfile || undefined
      })
      if (result.run.status === 'failed') {
        setPostgresError(result.message)
      } else {
        setPostgresFormOpen(false)
        setPostgresConnection('')
        onNotice(`${selectedProject?.name ?? '项目'} PostgreSQL 已保存并通过只读连接测试。`)
      }
      await onRefresh()
    } catch (error) {
      setPostgresError(error instanceof Error ? error.message : 'PostgreSQL 配置失败。')
    } finally {
      setSavingPostgres(false)
    }
  }

  async function requestComputerPermissions(): Promise<void> {
    if (requestingComputerPermissions) return
    setRequestingComputerPermissions(true)
    try {
      const capabilities = await window.projectAgent.requestComputerUsePermissions()
      const computer = capabilities.find((item) => item.id === 'computer')
      await onRefresh()
      onNotice(
        computer?.status === 'ready'
          ? '操作 Mac 应用所需的权限已开启。'
          : '已打开 macOS 系统设置。完成授权后，请重新打开 Fuddy。'
      )
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '无法打开权限设置，请稍后重试。')
    } finally {
      setRequestingComputerPermissions(false)
    }
  }

  async function testMicrophone(): Promise<void> {
    if (microphoneTesting) return
    setMicrophoneTesting(true)
    setProviderError(null)
    let stream: MediaStream | null = null
    try {
      const access = await window.projectAgent.requestMicrophoneAccess()
      const permissionError = microphoneAccessError(access)
      if (permissionError) {
        if (access.status === 'denied' || access.status === 'restricted') {
          await window.projectAgent.openMicrophoneSettings()
        }
        throw new Error(permissionError)
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      await new Promise((resolve) => window.setTimeout(resolve, 1_500))
      onNotice('麦克风工作正常。')
    } catch (error) {
      setProviderError(error instanceof Error ? error.message : '无法测试麦克风。')
    } finally {
      stream?.getTracks().forEach((track) => track.stop())
      setMicrophoneTesting(false)
    }
  }

  async function syncCompanionNow(): Promise<void> {
    if (companionBusy) return
    setCompanionBusy('sync')
    setCompanionError(null)
    try {
      setCompanionStatus(await window.projectAgent.syncCompanionNow())
      onNotice('已检查 iPhone 同步状态。')
    } catch (error) {
      setCompanionError(error instanceof Error ? error.message : '同步失败。')
    } finally {
      setCompanionBusy(null)
    }
  }

  async function runProjectAgent(projectProfileId: string): Promise<void> {
    const profile = bootstrap.analyticsProfiles.find((candidate) => candidate.id === projectProfileId)
    if (!profile) return
    setProjectAgentBusy(profile.id)
    try {
      const result = await window.projectAgent.dispatchProjectAgent(
        {
          requestId: crypto.randomUUID(),
          projectId: profile.projectId,
          prompt: `围绕当前目标“${profile.objective}”检查最新状态，给出本周最小可执行动作；先产出草案，不执行任何需要批准的外部动作。`
        },
        () => undefined
      )
      onNotice(
        result.mode === 'repo-skill'
          ? `已创建 ${profile.projectName} Agent Run。`
          : `${profile.projectName} Super Agent 已返回：${result.message.slice(0, 120)}`
      )
      await onRefresh()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Fuddy 启动失败。')
    } finally {
      setProjectAgentBusy(null)
    }
  }

  function openConnectorForm(kind: Exclude<ConnectorKind, 'repo' | 'postgres'>): void {
    if (!projectId) return
    const existing = bootstrap.connectors.find(
      (connector) => connector.projectId === projectId && connector.kind === kind
    )
    if (kind === 'cloudflare') {
      setConnectorFields({
        accountId: String(existing?.config.accountId ?? ''),
        zoneId: String(existing?.config.zoneId ?? ''),
        apiToken: ''
      })
    } else if (kind === 'ga4') {
      setConnectorFields({
        propertyId: String(existing?.config.propertyId ?? ''),
        accessToken: '',
        refreshToken: '',
        clientId: '',
        clientSecret: ''
      })
    } else {
      setConnectorFields({
        agentName: String(existing?.config.agentName ?? `${selectedProject?.name ?? 'Project'} Agent`),
        baseUrl: String(existing?.config.baseUrl ?? ''),
        statusPath: String(existing?.config.statusPath ?? '/status'),
        apiKey: ''
      })
    }
    setConnectorSetupError(null)
    setConnectorFormKind(kind)
  }

  async function configureConnector(): Promise<void> {
    if (!projectId || !connectorFormKind) return
    setSavingConnector(true)
    setConnectorSetupError(null)
    try {
      const result =
        connectorFormKind === 'cloudflare'
          ? await window.projectAgent.configureConnector({
              kind: 'cloudflare',
              projectId,
              accountId: connectorFields.accountId?.trim() ?? '',
              zoneId: connectorFields.zoneId?.trim() || undefined,
              apiToken: connectorFields.apiToken?.trim() || undefined
            })
          : connectorFormKind === 'ga4'
            ? await window.projectAgent.configureConnector({
                kind: 'ga4',
                projectId,
                propertyId: connectorFields.propertyId?.trim() ?? '',
                accessToken: connectorFields.accessToken?.trim() || undefined,
                refreshToken: connectorFields.refreshToken?.trim() || undefined,
                clientId: connectorFields.clientId?.trim() || undefined,
                clientSecret: connectorFields.clientSecret?.trim() || undefined
              })
            : await window.projectAgent.configureConnector({
                kind: 'project-agent',
                projectId,
                agentName: connectorFields.agentName?.trim() ?? '',
                baseUrl: connectorFields.baseUrl?.trim() ?? '',
                statusPath: connectorFields.statusPath?.trim() || undefined,
                apiKey: connectorFields.apiKey?.trim() || undefined
              })
      if (result.run.status === 'failed') setConnectorSetupError(result.message)
      else {
        onNotice(`${result.connector.name} 已保存并通过连接测试。`)
        setConnectorFormKind(null)
        setConnectorFields({})
      }
      await onRefresh()
    } catch (error) {
      setConnectorSetupError(error instanceof Error ? error.message : 'Connector 配置失败。')
    } finally {
      setSavingConnector(false)
    }
  }

  async function saveAgentProvider(): Promise<void> {
    setProviderBusy('agent')
    setProviderError(null)
    try {
      await window.projectAgent.configureAgentProvider({
        primary: {
          mode: agentPrimary.mode,
          baseUrl: agentPrimary.baseUrl,
          model: agentPrimary.model,
          apiKey: agentApiKeys.primary.trim() || undefined
        },
        backup: {
          mode: agentBackup.mode,
          baseUrl: agentBackup.baseUrl,
          model: agentBackup.model,
          apiKey: agentApiKeys.backup.trim() || undefined
        },
        backupEnabled: agentBackupEnabled
      })
      setAgentApiKeys({ primary: '', backup: '' })
      onNotice('模型配置已保存；默认配置失败时会自动切换到备用配置。')
      await onRefresh()
    } catch (error) {
      setProviderError(error instanceof Error ? error.message : '模型设置保存失败。')
    } finally {
      setProviderBusy(null)
    }
  }

  async function saveCodingAgents(): Promise<void> {
    setProviderBusy('coding-agents')
    setProviderError(null)
    try {
      await window.projectAgent.configureCodingAgents(codingAgents)
      onNotice('默认 Coding Agent、模型与思考深度已保存。')
      await onRefresh()
    } catch (error) {
      setProviderError(error instanceof Error ? error.message : 'Coding Agent 设置保存失败。')
    } finally {
      setProviderBusy(null)
    }
  }

  async function detectCodingAgents(): Promise<void> {
    setProviderBusy('coding-detect')
    setProviderError(null)
    try {
      const [, catalog] = await Promise.all([onRefresh(), window.projectAgent.listCodingAgentModels()])
      setCodingAgentModels(catalog)
      onNotice('已重新检查 Coding Agent，并更新了可用模型和思考深度。')
    } catch (error) {
      setProviderError(error instanceof Error ? error.message : '无法检查 Coding Agent，请重试。')
    } finally {
      setProviderBusy(null)
    }
  }

  async function saveTtsProvider(testAfterSave = false): Promise<void> {
    setProviderBusy(testAfterSave ? 'tts-test' : 'tts')
    setProviderError(null)
    try {
      await window.projectAgent.configureTtsProvider({
        primary: {
          mode: ttsPrimary.mode,
          baseUrl: ttsPrimary.baseUrl,
          model: ttsPrimary.model,
          voice: ttsPrimary.voice,
          instructions: ttsPrimary.instructions,
          apiKey: ttsApiKeys.primary.trim() || undefined
        },
        backup: {
          mode: ttsBackup.mode,
          baseUrl: ttsBackup.baseUrl,
          model: ttsBackup.model,
          voice: ttsBackup.voice,
          instructions: ttsBackup.instructions,
          apiKey: ttsApiKeys.backup.trim() || undefined
        },
        backupEnabled: ttsBackupEnabled
      })
      setTtsApiKeys({ primary: '', backup: '' })
      if (testAfterSave) {
        const result = await window.projectAgent.testTtsProvider()
        if (result.audioDataUrl) await new Audio(result.audioDataUrl).play()
        onNotice(result.message)
      } else {
        onNotice('语音配置已保存；默认配置失败时会自动切换到备用配置。')
      }
      await onRefresh()
    } catch (error) {
      setProviderError(error instanceof Error ? error.message : '语音输出设置没有完成，请重试。')
    } finally {
      setProviderBusy(null)
    }
  }

  async function saveAsrProvider(): Promise<void> {
    setProviderBusy('asr')
    setProviderError(null)
    try {
      await window.projectAgent.configureAsrProvider({
        mode: asrSettings.mode,
        cloudBaseUrl: asrSettings.cloudBaseUrl,
        cloudModel: asrSettings.cloudModel,
        cloudApiKey: asrApiKey.trim() || undefined,
        fallbackToCloud: asrSettings.fallbackToCloud
      })
      setAsrApiKey('')
      onNotice('语音输入配置已保存。')
      await onRefresh()
    } catch (error) {
      setProviderError(error instanceof Error ? error.message : '语音输入设置没有保存，请重试。')
    } finally {
      setProviderBusy(null)
    }
  }

  async function downloadAsrModel(): Promise<void> {
    setProviderBusy('asr-download')
    setProviderError(null)
    try {
      setAsrModelStatus(await window.projectAgent.downloadAsrModel())
      onNotice('Whisper large-v3-turbo Q5 已下载，可离线使用。')
    } catch (error) {
      setProviderError(error instanceof Error ? error.message : 'Whisper 模型下载失败。')
      setAsrModelStatus(await window.projectAgent.getAsrModelStatus())
    } finally {
      setProviderBusy(null)
    }
  }

  async function deleteAsrModel(): Promise<void> {
    setProviderBusy('asr-delete')
    setProviderError(null)
    try {
      setAsrModelStatus(await window.projectAgent.deleteAsrModel())
      onNotice('本地 Whisper 模型已删除。')
    } catch (error) {
      setProviderError(error instanceof Error ? error.message : 'Whisper 模型删除失败。')
    } finally {
      setProviderBusy(null)
    }
  }

  function isLoopbackEndpoint(baseUrl: string): boolean {
    try {
      return ['localhost', '127.0.0.1', '::1'].includes(new URL(baseUrl).hostname)
    } catch {
      return false
    }
  }

  function agentEndpointReady(endpoint: AgentEndpointSettings): boolean {
    if (endpoint.mode === 'cc-switch-codex-oauth') return isLoopbackEndpoint(endpoint.baseUrl)
    return endpoint.apiKeyConfigured || isLoopbackEndpoint(endpoint.baseUrl)
  }

  function agentEndpointStatus(endpoint: AgentEndpointSettings): string {
    if (endpoint.mode === 'cc-switch-codex-oauth') return '本地订阅'
    if (isLoopbackEndpoint(endpoint.baseUrl) && !endpoint.apiKeyConfigured) return '本地代理'
    return endpoint.apiKeyConfigured ? '已配置' : '缺少 Key'
  }

  function endpointStatus(mode: TtsProviderMode, configured: boolean): string {
    if (mode === 'system') return '系统语音'
    return configured ? '已配置' : '缺少 Key'
  }

  function renderAgentEndpoint(slot: 'primary' | 'backup', endpoint: AgentEndpointSettings): React.JSX.Element {
    const apiKey = agentApiKeys[slot]
    return (
      <div className="provider-fields">
        <div className="provider-field">
          <span>API 协议</span>
          <SelectMenu
            value={endpoint.mode}
            options={[{ value: 'openai-compatible', label: 'OpenAI Compatible API' }]}
            onChange={(mode) => changeAgentMode(slot, mode)}
            ariaLabel={`${slot === 'primary' ? '默认' : '备用'}模型协议`}
          />
        </div>
        <label>
          <span>Base URL</span>
          <input
            value={endpoint.baseUrl}
            onChange={(event) => updateAgentEndpoint(slot, { baseUrl: event.target.value })}
            placeholder="https://api.openai.com/v1"
          />
        </label>
        <label>
          <span>Model</span>
          <input
            value={endpoint.model}
            onChange={(event) => updateAgentEndpoint(slot, { model: event.target.value })}
            placeholder="gpt-5.6-sol"
          />
        </label>
        {endpoint.mode === 'openai-compatible' && (
          <label>
            <span>API Key</span>
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setAgentApiKeys((current) => ({ ...current, [slot]: event.target.value }))}
              placeholder={
                endpoint.apiKeyConfigured
                  ? '已保存；留空保持不变'
                  : isLoopbackEndpoint(endpoint.baseUrl)
                    ? '本地代理可留空'
                    : '输入 API Key'
              }
            />
          </label>
        )}
      </div>
    )
  }

  function renderTtsEndpoint(slot: 'primary' | 'backup', endpoint: TtsEndpointSettings): React.JSX.Element {
    const apiKey = ttsApiKeys[slot]
    return (
      <div className="provider-fields">
        <div className="provider-field">
          <span>语音服务</span>
          <SelectMenu
            value={endpoint.mode}
            options={[
              { value: 'system', label: 'macOS 系统中文语音' },
              { value: 'openai-compatible', label: 'OpenAI Compatible Speech API' },
              { value: 'elevenlabs', label: 'ElevenLabs' }
            ]}
            onChange={(mode) => changeTtsMode(slot, mode)}
            ariaLabel={`${slot === 'primary' ? '默认' : '备用'}语音服务`}
          />
        </div>
        {endpoint.mode === 'system' ? (
          <p className="provider-inline-note">无需 API Key，使用系统语音在本机播放。</p>
        ) : (
          <>
            <label>
              <span>Base URL</span>
              <input
                value={endpoint.baseUrl}
                onChange={(event) => updateTtsEndpoint(slot, { baseUrl: event.target.value })}
                placeholder={
                  endpoint.mode === 'elevenlabs' ? 'https://api.elevenlabs.io/v1' : 'https://api.openai.com/v1'
                }
              />
            </label>
            <label>
              <span>Model</span>
              {endpoint.mode === 'elevenlabs' ? (
                <SuggestionInput
                  value={endpoint.model}
                  suggestions={['eleven_flash_v2_5', 'eleven_multilingual_v2', 'eleven_v3']}
                  onChange={(model) => updateTtsEndpoint(slot, { model })}
                  ariaLabel="ElevenLabs 模型"
                  placeholder="eleven_flash_v2_5"
                />
              ) : (
                <input
                  value={endpoint.model}
                  onChange={(event) => updateTtsEndpoint(slot, { model: event.target.value })}
                  placeholder="gpt-4o-mini-tts"
                />
              )}
            </label>
            <label>
              <span>{endpoint.mode === 'elevenlabs' ? 'Voice ID' : 'Voice'}</span>
              {endpoint.mode === 'openai-compatible' ? (
                <SuggestionInput
                  value={endpoint.voice}
                  suggestions={['marin', 'cedar', 'coral', 'nova', 'alloy']}
                  onChange={(voice) => updateTtsEndpoint(slot, { voice })}
                  ariaLabel="OpenAI 语音"
                  placeholder="marin"
                />
              ) : (
                <input
                  value={endpoint.voice}
                  onChange={(event) => updateTtsEndpoint(slot, { voice: event.target.value })}
                  placeholder="粘贴 ElevenLabs Voice ID"
                />
              )}
            </label>
            {endpoint.mode === 'openai-compatible' && (
              <label>
                <span>声音指令</span>
                <textarea
                  rows={3}
                  value={endpoint.instructions}
                  onChange={(event) => updateTtsEndpoint(slot, { instructions: event.target.value })}
                />
              </label>
            )}
            <label>
              <span>API Key</span>
              <input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setTtsApiKeys((current) => ({ ...current, [slot]: event.target.value }))}
                placeholder={endpoint.apiKeyConfigured ? '已保存；留空保持不变' : '输入 API Key'}
              />
            </label>
          </>
        )}
      </div>
    )
  }

  const companionIssue = companionError ?? companionStatus?.lastError ?? null
  const companionPhoneCount = companionStatus?.iosDevicesOnline ?? 0
  const companionStatusLabel = !companionStatus?.configuration
    ? companionRelayAvailable ? '正在准备' : '暂不可用'
    : companionPhoneCount > 0
      ? `${companionPhoneCount} 台已连接`
      : companionStatus.realtimeState === 'connecting'
        ? '正在连接'
        : companionStatus.realtimeState === 'connected' || companionStatus.state === 'connected'
          ? '等待 iPhone'
          : '暂时离线'
  const asrModelLabel =
    asrModelStatus?.state === 'installed'
      ? '已下载 · 547 MiB'
      : asrModelStatus?.state === 'downloading'
        ? '正在下载'
        : '未下载 · 547 MiB'
  const googleIdentity = accountIdentities.find((identity) => identity.provider === 'google')
  const canUnlinkGoogle = Boolean(googleIdentity) && accountIdentities.length > 1

  return (
    <div className={`settings-view settings-view-${section}`}>
      {section !== 'connectors' && (
        <header className="settings-page-intro">
          <h1>{settingsSectionTitles[section]}</h1>
          <p>
            {section === 'general'
              ? '管理账户、登录设备和这台 Mac 可以使用的功能。'
              : section === 'models'
                ? '选择工作助理与 Coding Agent 使用的模型。'
                : section === 'voice'
                  ? '管理语音输入、输出与本机语音能力。'
                  : '查看 Agent 权限、系统授权与本机数据策略。'}
          </p>
        </header>
      )}

      {section === 'general' && (
        <section className="settings-list-page">
          <h2 className="settings-group-label">账户</h2>
          <div className="settings-flat-list">
            <article>
              <div className="settings-row-main">
                <span className="settings-row-icon is-accent"><UserRound size={16} /></span>
                <div className="settings-row-copy">
                  <strong>{accountState?.user?.email ?? 'Fuddy 账户'}</strong>
                  <p>管理登录方式和已登录设备。</p>
                </div>
              </div>
              <button className="settings-row-link-action is-warning" type="button" disabled={accountBusy} onClick={() => void logoutAccount()}>
                {accountBusy && <LoaderCircle className="spin" size={13} />} 退出
              </button>
            </article>
            {(accountState?.availableProviders.google || googleIdentity) && <article>
              <div className="settings-row-main">
                <span className="settings-row-icon is-accent"><ShieldCheck size={16} /></span>
                <div className="settings-row-copy">
                  <strong>Google</strong>
                  <p>
                    {googleIdentity
                      ? `已连接 ${googleIdentity.email}`
                      : '连接后可直接使用 Google 登录同一个 Fuddy 账户。'}
                  </p>
                </div>
              </div>
              <button
                className={`settings-row-link-action ${googleIdentity ? 'is-warning' : ''}`}
                type="button"
                disabled={accountBusy || (!googleIdentity && !accountState?.availableProviders.google) || (Boolean(googleIdentity) && !canUnlinkGoogle)}
                title={googleIdentity && !canUnlinkGoogle ? '请先验证邮箱，再断开唯一登录方式' : undefined}
                onClick={() => void toggleGoogleIdentity()}
              >
                {googleIdentity ? '断开' : '连接'}
              </button>
            </article>}
            <article>
              <div className="settings-row-main">
                <span className="settings-row-icon"><ShieldCheck size={16} /></span>
                <div className="settings-row-copy">
                  <strong>退出所有设备</strong>
                  <p>撤销这个账户的全部登录状态与手机授权，本机也会退出。</p>
                </div>
              </div>
              <button className="settings-row-link-action is-warning" type="button" disabled={accountBusy} onClick={() => void logoutAllAccounts()}>
                全部退出
              </button>
            </article>
          </div>

          <h2 className="settings-group-label">登录设备</h2>
          <div className="settings-flat-list">
            {accountDevices.map((device) => (
              <article key={device.id}>
                <div className="settings-row-main">
                  <span className="settings-row-icon is-accent">
                    {device.platform === 'ios' ? <Smartphone size={16} /> : <Laptop size={16} />}
                  </span>
                  <div className="settings-row-copy">
                    <strong>{device.name}{device.isCurrent ? ' · 当前设备' : ''}</strong>
                    <p>{device.platform === 'ios' ? 'iPhone' : 'Mac'} · Fuddy {device.appVersion} · {formatRelativeTime(device.lastSeenAt)}</p>
                  </div>
                </div>
                {device.isCurrent ? (
                  <span className="settings-value-pill is-ready">当前</span>
                ) : (
                  <button className="settings-row-link-action is-warning" type="button" disabled={accountBusy} onClick={() => void revokeAccountDevice(device.id)}>
                    撤销
                  </button>
                )}
              </article>
            ))}
            {accountDevices.length === 0 && (
              <article>
                <div className="settings-row-copy"><p>暂时无法读取设备列表。</p></div>
                <button className="settings-row-link-action" type="button" disabled={accountBusy} onClick={() => void retryAccountDetails()}>
                  {accountBusy && <LoaderCircle className="spin" size={13} />} 重试
                </button>
              </article>
            )}
            <article className="settings-summary-row">
              <div className="settings-row-main">
                <span className="settings-row-icon is-accent"><Smartphone size={17} /></span>
                <div className="settings-row-copy">
                  <strong>iPhone 自动同步</strong>
                  <p>
                    {!companionStatus?.configuration && !companionRelayAvailable
                      ? '暂时无法连接 iPhone，服务恢复后会自动重试。'
                      : '在 iPhone 登录同一账户，即可安全连接这台 Mac。'}
                  </p>
                </div>
              </div>
              <div className="settings-heading-actions">
                <span
                  className={`settings-value-pill ${companionStatus?.realtimeState === 'connected' ? 'is-ready' : ''}`}
                >
                  {companionStatusLabel}
                </span>
              </div>
            </article>

            {companionStatus?.configuration ? (
              <article>
                <div className="settings-row-main">
                  <span className="settings-row-icon"><RefreshCw size={16} /></span>
                  <div className="settings-row-copy">
                    <strong>同步状态</strong>
                    <p>
                      {companionStatus.pendingEvents > 0
                        ? `${companionStatus.pendingEvents} 条待同步`
                        : companionStatus.isolatedEvents > 0
                          ? `${companionStatus.isolatedEvents} 条需要处理`
                          : '已同步'}
                      {companionStatus.lastSyncedAt
                        ? ` · 最近同步 ${formatRelativeTime(companionStatus.lastSyncedAt)}`
                        : ''}
                    </p>
                  </div>
                </div>
                <button
                  className="settings-row-link-action"
                  onClick={() => void syncCompanionNow()}
                  disabled={Boolean(companionBusy)}
                >
                  {companionBusy === 'sync' ? <LoaderCircle className="spin" size={13} /> : null}
                  同步
                </button>
              </article>
            ) : null}

            {companionIssue && (
              <article className="settings-alert-row" role="alert">
                <div className="settings-row-main">
                  <span className="settings-row-icon is-warning"><CircleAlert size={17} /></span>
                  <div className="settings-row-copy">
                    <strong>部分内容暂未同步</strong>
                    <p>
                      {companionStatus?.isolatedEvents
                        ? `有 ${companionStatus.isolatedEvents} 条内容发送失败，其他内容仍在正常同步。`
                        : companionStatus?.pendingEvents
                        ? `有 ${companionStatus.pendingEvents} 条内容仍在等待发送，稍后会自动重试。`
                        : '同步服务遇到问题，请重试。'}
                    </p>
                  </div>
                </div>
                <div className="settings-row-trailing">
                  <button
                    className="settings-row-link-action is-warning"
                    onClick={() => void syncCompanionNow()}
                    disabled={Boolean(companionBusy)}
                  >
                    {companionBusy === 'sync' ? <LoaderCircle className="spin" size={13} /> : null}
                    重试
                  </button>
                </div>
              </article>
            )}
          </div>
          {accountError && <p className="settings-inline-error" role="alert">{accountError}</p>}

          <h2 className="settings-group-label">这台 Mac 可以做什么</h2>
          <div className="settings-flat-list">
            {bootstrap.capabilities
              .filter((item) => item.id === 'browser' || item.id === 'computer')
              .map((capability) => (
                <article key={capability.id}>
                  <div className="settings-row-main">
                    <span className="settings-row-icon is-accent">
                      {capability.id === 'browser' ? <LayoutGrid size={16} /> : <Square size={16} />}
                    </span>
                    <div className="settings-row-copy">
                      <strong>{capability.label}</strong>
                      <p>{capability.detail}</p>
                    </div>
                  </div>
                  <span className={`settings-row-status is-${capability.status}`}>
                    {capability.status === 'ready'
                      ? '可用'
                      : capability.status === 'needs-setup'
                        ? '需要配置'
                        : capability.status === 'scaffolded'
                          ? '准备中'
                          : '不可用'}
                  </span>
                  {capability.id === 'computer' && capability.status !== 'ready' && (
                    <button
                      className="settings-row-button"
                      onClick={() => void requestComputerPermissions()}
                      disabled={requestingComputerPermissions}
                    >
                      {requestingComputerPermissions ? (
                        <LoaderCircle className="spin" size={13} />
                      ) : (
                        <ShieldCheck size={13} />
                      )}
                      配置权限
                    </button>
                  )}
                </article>
              ))}
          </div>
        </section>
      )}

      {section === 'models' && (
        <section className="settings-list-page">
          <div className="settings-segmented-control" role="tablist" aria-label="模型设置">
            <button
              role="tab"
              aria-selected={modelSettingsTab === 'assistant'}
              className={modelSettingsTab === 'assistant' ? 'is-active' : ''}
              onClick={() => setModelSettingsTab('assistant')}
            >
              工作助理
            </button>
            <button
              role="tab"
              aria-selected={modelSettingsTab === 'coding'}
              className={modelSettingsTab === 'coding' ? 'is-active' : ''}
              onClick={() => setModelSettingsTab('coding')}
            >
              Coding Agents
            </button>
          </div>

          {modelSettingsTab === 'assistant' ? (
            <>
              <div className="settings-list-section-heading">
                <div>
                  <h2>工作助理模型</h2>
                  <p>默认模型不可用时，助理会自动尝试备用配置。</p>
                </div>
              </div>
              <div className="settings-flat-list settings-editable-list">
                <article className={editingAgentSlot === 'primary' ? 'is-expanded' : ''}>
                  <div>
                    <strong>默认模型</strong>
                    <p>
                      {agentPrimary.model || '未选择模型'} · {agentEndpointStatus(agentPrimary)}
                    </p>
                  </div>
                  <span
                    className={`settings-row-status ${agentEndpointReady(agentPrimary) ? 'is-ready' : 'is-needs-setup'}`}
                  >
                    {agentEndpointStatus(agentPrimary)}
                  </span>
                  <button
                    className="settings-row-button"
                    onClick={() => setEditingAgentSlot((current) => (current === 'primary' ? null : 'primary'))}
                  >
                    {editingAgentSlot === 'primary' ? '收起' : '编辑'}
                  </button>
                  {editingAgentSlot === 'primary' && (
                    <div className="settings-edit-panel">{renderAgentEndpoint('primary', agentPrimary)}</div>
                  )}
                </article>
                <article className={editingAgentSlot === 'backup' ? 'is-expanded' : ''}>
                  <div>
                    <strong>备用模型</strong>
                    <p>
                      {agentBackupEnabled ? `${agentBackup.model || '未选择模型'} · 默认模型失败时自动重试` : '未启用'}
                    </p>
                  </div>
                  <label className="provider-toggle">
                    <input
                      type="checkbox"
                      checked={agentBackupEnabled}
                      onChange={(event) => setAgentBackupEnabled(event.target.checked)}
                    />
                    <i />
                    <span>{agentBackupEnabled ? '已启用' : '未启用'}</span>
                  </label>
                  {agentBackupEnabled && (
                    <button
                      className="settings-row-button"
                      onClick={() => setEditingAgentSlot((current) => (current === 'backup' ? null : 'backup'))}
                    >
                      {editingAgentSlot === 'backup' ? '收起' : '编辑'}
                    </button>
                  )}
                  {agentBackupEnabled && editingAgentSlot === 'backup' && (
                    <div className="settings-edit-panel">{renderAgentEndpoint('backup', agentBackup)}</div>
                  )}
                </article>
              </div>
              {providerError && <p className="provider-settings-error">{providerError}</p>}
              <div className="provider-page-actions">
                <span className="provider-security-note">
                  <ShieldCheck size={12} /> API Key 仅保存在 macOS Keychain 中。
                </span>
                <button
                  className="provider-save-button"
                  onClick={() => void saveAgentProvider()}
                  disabled={providerBusy !== null}
                >
                  {providerBusy === 'agent' ? <LoaderCircle className="spin" size={13} /> : <ShieldCheck size={13} />}{' '}
                  保存模型配置
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="settings-list-section-heading">
                <div>
                  <h2>Coding Agents</h2>
                  <p>选择默认 Agent，并按需设置模型和思考深度。</p>
                </div>
                <button
                  className="settings-row-button"
                  onClick={() => void detectCodingAgents()}
                  disabled={providerBusy !== null}
                >
                  {providerBusy === 'coding-detect' ? (
                    <LoaderCircle className="spin" size={13} />
                  ) : (
                    <RefreshCw size={13} />
                  )}{' '}
                  重新检测
                </button>
              </div>
              <div className="settings-flat-list settings-editable-list">
                <article>
                  <div>
                    <strong>默认 Coding Agent</strong>
                    <p>“去处理”等未手动选择 Agent 的入口会使用它。</p>
                  </div>
                  <div className="settings-row-control">
                    <SelectMenu
                      value={codingAgents.defaultAgent}
                      options={codingAgentOptions.map((option) => ({ value: option.id, label: option.label }))}
                      onChange={(value) =>
                        setCodingAgents((current) => ({ ...current, defaultAgent: value as CodingAgentProvider }))
                      }
                      ariaLabel="默认 Coding Agent"
                    />
                  </div>
                </article>
                {codingAgentOptions.map((option) => {
                  const capability = bootstrap.capabilities.find((item) => item.id === option.id)
                  const installed = capability?.status === 'ready'
                  const catalog = codingAgentModels?.[option.id]
                  const savedSettings = codingAgents[option.id]
                  const savedModel = savedSettings.defaultModel
                  const savedReasoningEffort = savedSettings.defaultReasoningEffort
                  const discoveredModels = catalog?.models ?? []
                  const savedModelWasDiscovered = discoveredModels.some((model) => model.id === savedModel)
                  const modelOptions = [
                    { value: '', label: `使用 ${option.label} 默认模型` },
                    ...discoveredModels.map((model) => ({
                      value: model.id,
                      label: `${model.label === model.id ? model.id : `${model.label} · ${model.id}`}${model.isDefault ? ' · Agent 推荐' : ''}`
                    })),
                    ...(savedModel && !savedModelWasDiscovered
                      ? [{ value: savedModel, label: `${savedModel} · 已保存，当前未返回` }]
                      : [])
                  ]
                  const selectedModel = discoveredModels.find((model) => model.id === savedModel)
                  const reasoningEfforts = savedModel
                    ? (selectedModel?.reasoningEfforts ?? [])
                    : (catalog?.defaultReasoningEfforts ?? [])
                  const defaultReasoningEffort = savedModel
                    ? (selectedModel?.defaultReasoningEffort ?? null)
                    : (catalog?.defaultReasoningEffort ?? null)
                  const savedReasoningEffortWasDiscovered = reasoningEfforts.some(
                    (effort) => effort.id === savedReasoningEffort
                  )
                  const reasoningEffortOptions = [
                    { value: '', label: `使用 ${option.label} 默认思考深度` },
                    ...reasoningEfforts.map((effort) => ({
                      value: effort.id,
                      label: `${effort.label}${effort.id === defaultReasoningEffort ? ' · Agent 推荐' : ''}`
                    })),
                    ...(savedReasoningEffort && !savedReasoningEffortWasDiscovered
                      ? [{ value: savedReasoningEffort, label: `${savedReasoningEffort} · 已保存，当前未返回` }]
                      : [])
                  ]
                  return (
                    <article className={expandedCodingAgent === option.id ? 'is-expanded' : ''} key={option.id}>
                      <div>
                        <strong>{option.label}</strong>
                        <p>
                          {savedModel || `使用 ${option.label} 默认模型`}
                          {savedReasoningEffort ? ` · ${savedReasoningEffort}` : ''}
                        </p>
                      </div>
                      <span className={`settings-row-status ${installed ? 'is-ready' : 'is-needs-setup'}`}>
                        {installed ? '已安装' : '未安装'}
                      </span>
                      <button
                        className="settings-row-button"
                        onClick={() => setExpandedCodingAgent((current) => (current === option.id ? null : option.id))}
                      >
                        {expandedCodingAgent === option.id ? '收起' : '编辑'}
                      </button>
                      {expandedCodingAgent === option.id && (
                        <div className="settings-edit-panel coding-agent-inline-editor">
                          <label>
                            <span>默认模型</span>
                            <SelectMenu
                              value={savedModel}
                              options={modelOptions}
                              onChange={(value) => {
                                const nextReasoningEfforts = value
                                  ? (discoveredModels.find((model) => model.id === value)?.reasoningEfforts ?? [])
                                  : (catalog?.defaultReasoningEfforts ?? [])
                                setCodingAgents((current) => {
                                  const currentSettings = current[option.id]
                                  const keepReasoningEffort =
                                    !currentSettings.defaultReasoningEffort ||
                                    nextReasoningEfforts.some(
                                      (effort) => effort.id === currentSettings.defaultReasoningEffort
                                    )
                                  return {
                                    ...current,
                                    [option.id]: {
                                      ...currentSettings,
                                      defaultModel: value,
                                      defaultReasoningEffort: keepReasoningEffort
                                        ? currentSettings.defaultReasoningEffort
                                        : ''
                                    }
                                  }
                                })
                              }}
                              ariaLabel={`${option.label} 默认模型`}
                              disabled={codingModelsLoading && !catalog}
                            />
                          </label>
                          <label>
                            <span>思考深度</span>
                            <SelectMenu
                              value={savedReasoningEffort}
                              options={reasoningEffortOptions}
                              onChange={(value) =>
                                setCodingAgents((current) => ({
                                  ...current,
                                  [option.id]: { ...current[option.id], defaultReasoningEffort: value }
                                }))
                              }
                              ariaLabel={`${option.label} 思考深度`}
                              disabled={
                                (codingModelsLoading && !catalog) ||
                                (reasoningEfforts.length === 0 && !savedReasoningEffort)
                              }
                            />
                          </label>
                          <p className={catalog?.error ? 'is-error' : ''}>
                            {catalog?.error ?? capability?.detail ?? '留空时使用 Agent 自己的默认配置。'}
                          </p>
                        </div>
                      )}
                    </article>
                  )
                })}
              </div>
              {providerError && <p className="provider-settings-error">{providerError}</p>}
              <div className="provider-page-actions">
                <button
                  className="provider-save-button"
                  onClick={() => void saveCodingAgents()}
                  disabled={providerBusy !== null}
                >
                  {providerBusy === 'coding-agents' ? (
                    <LoaderCircle className="spin" size={13} />
                  ) : (
                    <ShieldCheck size={13} />
                  )}{' '}
                  保存 Coding Agent 配置
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {section === 'voice' && (
        <section className="settings-list-page">
          <div className="settings-segmented-control" role="tablist" aria-label="语音设置">
            <button
              role="tab"
              aria-selected={voiceSettingsTab === 'input'}
              className={voiceSettingsTab === 'input' ? 'is-active' : ''}
              onClick={() => {
                setVoiceSettingsTab('input')
                setVoiceAdvancedOpen(false)
              }}
            >
              语音输入
            </button>
            <button
              role="tab"
              aria-selected={voiceSettingsTab === 'output'}
              className={voiceSettingsTab === 'output' ? 'is-active' : ''}
              onClick={() => {
                setVoiceSettingsTab('output')
                setVoiceAdvancedOpen(false)
              }}
            >
              语音输出
            </button>
          </div>

          {voiceSettingsTab === 'input' ? (
            <>
              <div className="settings-list-section-heading">
                <div>
                  <h2>语音识别</h2>
                  <p>优先在 Mac 本地转写，需要时再回退到云端。</p>
                </div>
              </div>
              <div className="settings-flat-list settings-editable-list">
                <article>
                  <div>
                    <strong>本地 Whisper</strong>
                    <p>large-v3-turbo Q5 · {asrModelLabel}</p>
                  </div>
                  <span
                    className={`settings-row-status ${asrModelStatus?.state === 'installed' ? 'is-ready' : 'is-needs-setup'}`}
                  >
                    {asrModelLabel}
                  </span>
                  {asrModelStatus?.state === 'installed' ? (
                    <ActionMenu
                      ariaLabel="管理 Whisper 模型"
                      trigger={<MoreHorizontal size={16} />}
                      options={[{ value: 'delete', label: '删除本地模型', icon: <Trash2 size={13} />, danger: true }]}
                      onSelect={() => void deleteAsrModel()}
                    />
                  ) : (
                    <button
                      className="settings-row-button"
                      onClick={() => void downloadAsrModel()}
                      disabled={providerBusy !== null}
                    >
                      {providerBusy === 'asr-download' ? (
                        <LoaderCircle className="spin" size={13} />
                      ) : (
                        <RefreshCw size={13} />
                      )}{' '}
                      下载模型
                    </button>
                  )}
                  {asrModelStatus?.state === 'downloading' && (
                    <div className="asr-download-progress">
                      <i
                        style={{
                          width: `${Math.min(100, (asrModelStatus.bytesDownloaded / asrModelStatus.totalBytes) * 100)}%`
                        }}
                      />
                    </div>
                  )}
                </article>
                <article>
                  <div>
                    <strong>输入方式</strong>
                    <p>{asrSettings.mode === 'local-first' ? '本地优先，失败时回退云端' : '仅使用云端 ASR'}</p>
                  </div>
                  <div className="settings-row-control">
                    <SelectMenu
                      value={asrSettings.mode}
                      options={[
                        { value: 'local-first', label: '本地优先，失败时回退云端' },
                        { value: 'cloud', label: '仅使用云端 ASR' }
                      ]}
                      onChange={(mode) =>
                        setAsrSettings((current) => ({ ...current, mode: mode as typeof current.mode }))
                      }
                      ariaLabel="语音输入方式"
                    />
                  </div>
                </article>
                <article>
                  <div>
                    <strong>隐私</strong>
                    <p>{asrSettings.mode === 'local-first' ? '录音默认不离开设备' : '录音会发送到已配置的云端服务'}</p>
                  </div>
                  <span className="settings-row-status">
                    {asrSettings.mode === 'local-first' ? '本地优先' : '云端处理'}
                  </span>
                </article>
                <article className="microphone-test-row">
                  <div>
                    <strong>测试麦克风</strong>
                    <p>确认 Fuddy 可以接收当前系统输入。</p>
                  </div>
                  <button
                    className="provider-save-button"
                    onClick={() => void testMicrophone()}
                    disabled={microphoneTesting}
                  >
                    {microphoneTesting ? <LoaderCircle className="spin" size={13} /> : <Mic2 size={13} />}
                    {microphoneTesting ? '正在测试…' : '开始测试'}
                  </button>
                </article>
                <article className={voiceAdvancedOpen ? 'is-expanded' : ''}>
                  <button
                    className="settings-disclosure-button"
                    onClick={() => setVoiceAdvancedOpen((value) => !value)}
                    aria-expanded={voiceAdvancedOpen}
                  >
                    <span>
                      <strong>高级配置</strong>
                      <small>API 地址、模型参数与回退设置</small>
                    </span>
                    <ChevronDown size={16} />
                  </button>
                  {voiceAdvancedOpen && (
                    <div className="settings-edit-panel">
                      <div className="provider-fields">
                        <label>
                          <span>Cloud Base URL</span>
                          <input
                            value={asrSettings.cloudBaseUrl}
                            onChange={(event) =>
                              setAsrSettings((current) => ({ ...current, cloudBaseUrl: event.target.value }))
                            }
                            placeholder="https://api.openai.com/v1"
                          />
                        </label>
                        <label>
                          <span>Cloud Model</span>
                          <input
                            value={asrSettings.cloudModel}
                            onChange={(event) =>
                              setAsrSettings((current) => ({ ...current, cloudModel: event.target.value }))
                            }
                            placeholder="gpt-transcribe"
                          />
                        </label>
                        <label>
                          <span>Cloud API Key</span>
                          <input
                            type="password"
                            autoComplete="off"
                            value={asrApiKey}
                            onChange={(event) => setAsrApiKey(event.target.value)}
                            placeholder={
                              asrSettings.cloudApiKeyConfigured ? '已保存；留空保持不变' : '使用云端或回退时需要'
                            }
                          />
                        </label>
                        {asrSettings.mode === 'local-first' && (
                          <div className="provider-field">
                            <span>自动回退</span>
                            <label className="provider-toggle">
                              <input
                                type="checkbox"
                                checked={asrSettings.fallbackToCloud}
                                onChange={(event) =>
                                  setAsrSettings((current) => ({ ...current, fallbackToCloud: event.target.checked }))
                                }
                              />
                              <i />
                              <span>{asrSettings.fallbackToCloud ? '已启用' : '未启用'}</span>
                            </label>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </article>
              </div>
              {providerError && <p className="provider-settings-error">{providerError}</p>}
              <div className="provider-page-actions">
                <button
                  className="provider-save-button"
                  onClick={() => void saveAsrProvider()}
                  disabled={providerBusy !== null}
                >
                  {providerBusy === 'asr' ? <LoaderCircle className="spin" size={13} /> : <ShieldCheck size={13} />}{' '}
                  保存语音输入配置
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="settings-list-section-heading">
                <div>
                  <h2>语音输出</h2>
                  <p>选择默认声音，并在不可用时自动切换到备用声音。</p>
                </div>
              </div>
              <div className="settings-flat-list settings-editable-list">
                <article>
                  <div>
                    <strong>默认语音</strong>
                    <p>
                      {ttsPrimary.mode === 'system'
                        ? 'macOS 系统中文语音'
                        : `${ttsPrimary.mode} · ${ttsPrimary.voice || '未选择声音'}`}
                    </p>
                  </div>
                  <span
                    className={`settings-row-status ${ttsPrimary.mode === 'system' || ttsPrimary.apiKeyConfigured ? 'is-ready' : 'is-needs-setup'}`}
                  >
                    {endpointStatus(ttsPrimary.mode, ttsPrimary.apiKeyConfigured)}
                  </span>
                  <button className="settings-row-button" onClick={() => setVoiceAdvancedOpen((value) => !value)}>
                    {voiceAdvancedOpen ? '收起' : '编辑'}
                  </button>
                </article>
                <article>
                  <div>
                    <strong>备用语音</strong>
                    <p>
                      {ttsBackupEnabled
                        ? `${ttsBackup.mode} · ${ttsBackup.voice || '默认声音'}`
                        : '默认语音失败时不自动切换'}
                    </p>
                  </div>
                  <label className="provider-toggle">
                    <input
                      type="checkbox"
                      checked={ttsBackupEnabled}
                      onChange={(event) => setTtsBackupEnabled(event.target.checked)}
                    />
                    <i />
                    <span>{ttsBackupEnabled ? '已启用' : '未启用'}</span>
                  </label>
                </article>
                {voiceAdvancedOpen && (
                  <article className="is-expanded voice-output-editor">
                    <div className="settings-edit-panel">
                      <div className="settings-inline-editor-heading">
                        <strong>默认语音</strong>
                        <span>服务、声音和凭证</span>
                      </div>
                      {renderTtsEndpoint('primary', ttsPrimary)}
                      {ttsBackupEnabled && (
                        <>
                          <div className="settings-inline-editor-heading is-secondary">
                            <strong>备用语音</strong>
                            <span>默认语音失败时使用</span>
                          </div>
                          {renderTtsEndpoint('backup', ttsBackup)}
                        </>
                      )}
                    </div>
                  </article>
                )}
              </div>
              {providerError && <p className="provider-settings-error">{providerError}</p>}
              <div className="provider-page-actions">
                <button
                  className="settings-row-button"
                  onClick={() => void saveTtsProvider(false)}
                  disabled={providerBusy !== null}
                >
                  {providerBusy === 'tts' ? <LoaderCircle className="spin" size={13} /> : <ShieldCheck size={13} />}{' '}
                  保存
                </button>
                <button
                  className="provider-save-button"
                  onClick={() => void saveTtsProvider(true)}
                  disabled={providerBusy !== null || ttsPrimary.mode === 'system'}
                >
                  {providerBusy === 'tts-test' ? (
                    <LoaderCircle className="spin" size={13} />
                  ) : (
                    <Play size={12} fill="currentColor" />
                  )}{' '}
                  保存并试听
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {section === 'permissions' && (
        <section className="settings-list-page">
          <div className="settings-risk-banner">
            <CircleAlert size={22} />
            <div>
              <strong>当前策略：完全访问</strong>
              <p>Agent 可读写项目文件、运行命令并操作已授权的本机应用。执行前请确认项目来源可信。</p>
            </div>
            <span>高权限模式</span>
          </div>

          <div className="settings-list-section-heading settings-list-section-spacing">
            <div>
              <h2>Agent 权限</h2>
              <p>以下策略由当前版本统一管理，不提供不可生效的开关。</p>
            </div>
          </div>
          <div className="settings-flat-list permissions-list">
            <article>
              <div>
                <strong>文件与命令</strong>
                <p>可访问项目工作区并运行终端命令</p>
              </div>
              <span className="settings-row-status">完全访问</span>
            </article>
            <article>
              <div>
                <strong>网络与浏览器</strong>
                <p>可以查找和读取网页</p>
              </div>
              <span className="settings-row-status">已允许</span>
            </article>
            <article>
              <div>
                <strong>应用操作</strong>
                <p>可以操作已允许的 Mac 应用</p>
              </div>
              <span className="settings-row-status">需系统授权</span>
            </article>
            <article>
              <div>
                <strong>操作确认</strong>
                <p>当前自动批准 Agent 操作，不逐次弹出确认</p>
              </div>
              <span className="settings-row-status is-warning">自动批准</span>
            </article>
          </div>

          <div className="settings-list-section-heading settings-list-section-spacing">
            <div>
              <h2>数据与凭证</h2>
              <p>凭证、运行记录和系统权限的实际存储位置。</p>
            </div>
          </div>
          <div className="settings-flat-list permissions-list">
            <article>
              <div>
                <strong>账户凭证</strong>
                <p>{bootstrap.credentialStorage.detail}</p>
              </div>
              <span
                className={`settings-row-status ${bootstrap.credentialStorage.available ? 'is-ready' : 'is-needs-setup'}`}
              >
                {bootstrap.credentialStorage.available ? 'macOS 钥匙串' : '不可用'}
              </span>
            </article>
            <article>
              <div>
                <strong>运行记录</strong>
                <p>保存 Agent Run 的消息、工具调用与结果</p>
              </div>
              <span className="settings-row-status">保留于本机</span>
            </article>
            <article>
              <div>
                <strong>系统权限</strong>
                <p>麦克风、辅助功能与屏幕录制由 macOS 管理</p>
              </div>
              <button
                className="settings-row-button"
                onClick={() => void requestComputerPermissions()}
                disabled={requestingComputerPermissions}
              >
                {requestingComputerPermissions ? <LoaderCircle className="spin" size={13} /> : <Settings2 size={13} />}{' '}
                打开系统设置
              </button>
            </article>
          </div>
          <p className="settings-policy-footnote">权限策略由当前版本统一管理，暂不支持单独调整。</p>
        </section>
      )}

      {section === 'connectors' && (
        <>
          {!projectLocked && (
            <div className="settings-project-scope">
              <div>
                <strong>项目范围</strong>
                <small>选择一个项目可配置它的 PostgreSQL 数据连接。</small>
              </div>
              <SelectMenu
                className="project-scope-select"
                value={projectId ?? ''}
                options={[
                  { value: '', label: '全部项目' },
                  ...bootstrap.projects.map((project) => ({ value: project.id, label: project.name }))
                ]}
                onChange={(value) => onProjectChange(value || null)}
                ariaLabel="Connector 项目范围"
              />
            </div>
          )}
          <section className="settings-section">
            <div className="settings-section-header">
              <div>
                <span className="settings-kicker">连接与数据</span>
                <h2>已配置的 Connectors</h2>
                <p>Connector 负责取证；变化经过指纹去重后回投决策收件箱。</p>
              </div>
              <button className="secondary-action-button" onClick={() => void runAll()} disabled={runningAll}>
                <RefreshCw size={14} className={runningAll ? 'spin' : ''} />
                {projectId ? '巡检当前项目' : '巡检全部项目'}
              </button>
            </div>

            <div className="connector-list">
              {visibleConnectors.map((connector) => {
                const project = bootstrap.projects.find((candidate) => candidate.id === connector.projectId)
                const latestRun = latestRunFor(connector.id)
                const busy = busyConnectors.has(connector.id) || connector.status === 'running'
                const isRepo = connector.kind === 'repo'
                const connectorLocation = isRepo
                  ? String(connector.config.repoPath ?? '')
                  : connector.config.analyticsProfile
                    ? `Analytics Profile · ${String(connector.config.analyticsProfile)}`
                    : connector.kind === 'postgres'
                      ? `${String(connector.config.user ?? '')}@${String(connector.config.host ?? '')}:${String(connector.config.port ?? '')}/${String(connector.config.database ?? '')}`
                      : connector.kind === 'cloudflare'
                        ? `Account ${String(connector.config.accountId ?? '')}${connector.config.zoneId ? ` · Zone ${String(connector.config.zoneId)}` : ''}`
                        : connector.kind === 'ga4'
                          ? `Property ${String(connector.config.propertyId ?? '')}`
                          : `${String(connector.config.baseUrl ?? '')}${String(connector.config.statusPath ?? '')}`
                return (
                  <article className="connector-row" key={connector.id}>
                    <span className="connector-kind-icon">
                      {isRepo ? <GitBranch size={17} /> : <Database size={17} />}
                    </span>
                    <div className="connector-main">
                      <div className="connector-title-row">
                        <strong>{connector.name}</strong>
                        <span className={`connector-status connector-status-${connector.status}`}>
                          {connectorStatusLabels[connector.status]}
                        </span>
                      </div>
                      <span className="connector-project">
                        {project?.name} ·{' '}
                        {isRepo
                          ? 'Local Repo'
                          : bootstrap.connectorCatalog.find((item) => item.kind === connector.kind)?.label}
                      </span>
                      <code>{connectorLocation}</code>
                      {!isRepo && typeof connector.config.metricView === 'string' && connector.config.metricView && (
                        <span className="metric-view-label">指标 View · {connector.config.metricView}</span>
                      )}
                      {latestRun && (
                        <p className={latestRun.status === 'failed' ? 'connector-error' : ''}>{latestRun.summary}</p>
                      )}
                      {!latestRun && <p>尚未巡检。首次运行会验证路径并读取 Git 元数据。</p>}
                      <span className="connector-footnote">
                        {connector.lastSyncAt
                          ? `上次运行于 ${formatRelativeTime(connector.lastSyncAt)}`
                          : '还没有运行记录'}
                        {' · '}
                        {isRepo
                          ? '不读取源码与敏感文件'
                          : connector.config.credentialSource === 'env-file'
                            ? '只读事务 · 引用项目现有环境配置'
                            : `${connector.kind === 'postgres' ? '只读事务' : '只读 API'} · 凭证保存在 Keychain`}
                      </span>
                    </div>
                    <div className="connector-actions">
                      <button
                        className={`connector-toggle ${connector.enabled ? 'is-on' : ''}`}
                        role="switch"
                        aria-checked={connector.enabled}
                        aria-label={`${connector.enabled ? '停用' : '启用'} ${connector.name}`}
                        onClick={() => void toggleConnector(connector)}
                      >
                        <span />
                      </button>
                      <button
                        className="secondary-action-button"
                        onClick={() => void runConnector(connector)}
                        disabled={!connector.enabled || busy}
                      >
                        <RefreshCw size={13} className={busy ? 'spin' : ''} />
                        立即巡检
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          </section>

          {bootstrap.analyticsProfiles.some((profile) => !projectId || profile.projectId === projectId) && (
            <section className="settings-section">
              <div className="settings-section-header">
                <div>
                  <span className="settings-kicker">项目分析与 Agent</span>
                  <h2>Analytics Profiles</h2>
                  <p>漏斗定义、固定聚合指标与项目现有 Agent 的调用方式统一版本化。</p>
                </div>
              </div>
              <div className="connector-list">
                {bootstrap.analyticsProfiles
                  .filter((profile) => !projectId || profile.projectId === projectId)
                  .map((profile) => (
                    <article className="connector-row" key={profile.id}>
                      <span className="connector-kind-icon">
                        <Workflow size={17} />
                      </span>
                      <div className="connector-main">
                        <div className="connector-title-row">
                          <strong>
                            {profile.projectName} · v{profile.version}
                          </strong>
                          <span className="connector-status connector-status-ready">ready</span>
                        </div>
                        <span className="connector-project">{profile.id}</span>
                        <p>{profile.objective}</p>
                        <code>{profile.funnel.join(' → ')}</code>
                        <span className="connector-footnote">
                          {profile.agentLabel} · {profile.approvalBoundary}
                        </span>
                      </div>
                      <div className="connector-actions">
                        <button
                          className="secondary-action-button"
                          disabled={projectAgentBusy === profile.id}
                          onClick={() => void runProjectAgent(profile.id)}
                        >
                          {projectAgentBusy === profile.id ? (
                            <LoaderCircle className="spin" size={13} />
                          ) : (
                            <Play size={13} />
                          )}
                          启动项目 Agent
                        </button>
                      </div>
                    </article>
                  ))}
              </div>
            </section>
          )}

          <section className="settings-section planned-section">
            <div className="settings-section-header">
              <div>
                <span className="settings-kicker">能力目录</span>
                <h2>Connector Catalog</h2>
                <p>这些能力将复用相同的凭证、健康状态、运行记录和证据协议。</p>
              </div>
            </div>
            {postgresFormOpen && projectId && (
              <div className="postgres-setup-panel">
                <div className="postgres-setup-heading">
                  <span className="connector-kind-icon">
                    <Database size={17} />
                  </span>
                  <div>
                    <strong>{selectedProject?.name} PostgreSQL</strong>
                    <p>连接信息写入项目配置，密码单独加密保存到 macOS Keychain。</p>
                  </div>
                  <button className="round-icon-button" onClick={closePostgresForm} aria-label="关闭 PostgreSQL 配置">
                    <X size={15} />
                  </button>
                </div>
                <label>
                  <span>Connection URL</span>
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={postgresConnection}
                    onChange={(event) => setPostgresConnection(event.target.value)}
                    placeholder="postgresql://user:password@host:5432/database?sslmode=require"
                  />
                  <small>编辑已有连接时可省略密码，应用会继续使用 Keychain 中的凭证。</small>
                </label>
                <label>
                  <span>Analytics Profile</span>
                  <SelectMenu
                    value={postgresAnalyticsProfile}
                    options={[
                      { value: '', label: '通用指标 View' },
                      ...bootstrap.analyticsProfiles
                        .filter((profile) => profile.projectId === projectId)
                        .map((profile) => ({
                          value: profile.id,
                          label: `${profile.projectName} · v${profile.version}`
                        }))
                    ]}
                    onChange={(value) => {
                      setPostgresAnalyticsProfile(value)
                      if (value) setPostgresMetricView('')
                    }}
                    ariaLabel="PostgreSQL Analytics Profile"
                  />
                  <small>内置 Profile 使用固定的只读聚合 SQL，并且不读取用户级内容。</small>
                </label>
                <label>
                  <span>指标 View（可选）</span>
                  <input
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={postgresMetricView}
                    onChange={(event) => setPostgresMetricView(event.target.value)}
                    disabled={Boolean(postgresAnalyticsProfile)}
                    placeholder="project_agent.metrics"
                  />
                  <small>
                    只接受 schema.view；View 需提供 metric_key、metric_value、status、summary、observed_at。
                  </small>
                </label>
                {postgresError && <p className="postgres-setup-error">{postgresError}</p>}
                <div className="postgres-setup-actions">
                  <button className="quiet-action" onClick={closePostgresForm}>
                    取消
                  </button>
                  <button
                    className="briefing-button"
                    onClick={() => void configurePostgres()}
                    disabled={!postgresConnection.trim() || savingPostgres}
                  >
                    {savingPostgres ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />}
                    保存并测试只读连接
                  </button>
                </div>
              </div>
            )}
            {connectorFormKind && projectId && (
              <div className="postgres-setup-panel">
                <div className="postgres-setup-heading">
                  <span className="connector-kind-icon">
                    <Plug size={17} />
                  </span>
                  <div>
                    <strong>{bootstrap.connectorCatalog.find((item) => item.kind === connectorFormKind)?.label}</strong>
                    <p>非敏感配置写入项目数据库；Token、OAuth 凭证和 API Key 单独加密保存。</p>
                  </div>
                  <button
                    className="round-icon-button"
                    onClick={() => setConnectorFormKind(null)}
                    aria-label="关闭 Connector 配置"
                  >
                    <X size={15} />
                  </button>
                </div>
                {(connectorFormKind === 'cloudflare'
                  ? [
                      ['accountId', 'Account ID', '32 位 Cloudflare account ID', 'text'],
                      ['zoneId', 'Zone ID（可选）', '配置后读取 Web Analytics', 'text'],
                      ['apiToken', 'API Token', '编辑时留空可沿用 Keychain 凭证', 'password']
                    ]
                  : connectorFormKind === 'ga4'
                    ? [
                        ['propertyId', 'GA4 Property ID', '纯数字 Property ID', 'text'],
                        ['accessToken', 'OAuth Access Token', '编辑时留空可沿用现有凭证', 'password'],
                        ['refreshToken', 'Refresh Token（可选）', '用于自动续期', 'password'],
                        ['clientId', 'OAuth Client ID（可选）', '与 Refresh Token 一起使用', 'text'],
                        ['clientSecret', 'OAuth Client Secret（可选）', '与 Refresh Token 一起使用', 'password']
                      ]
                    : [
                        ['agentName', 'Agent 名称', '例如 Growth Agent', 'text'],
                        ['baseUrl', 'Base URL', 'https://agent.example.com', 'text'],
                        ['statusPath', 'Status Path', '/status', 'text'],
                        ['apiKey', 'API Key（可选）', '编辑时留空可沿用现有凭证', 'password']
                      ]
                ).map(([key, label, placeholder, type]) => (
                  <label key={key}>
                    <span>{label}</span>
                    <input
                      type={type}
                      autoComplete="off"
                      spellCheck={false}
                      value={connectorFields[key] ?? ''}
                      onChange={(event) => setConnectorFields((current) => ({ ...current, [key]: event.target.value }))}
                      placeholder={placeholder}
                    />
                  </label>
                ))}
                {connectorSetupError && <p className="postgres-setup-error">{connectorSetupError}</p>}
                <div className="postgres-setup-actions">
                  <button className="quiet-action" onClick={() => setConnectorFormKind(null)}>
                    取消
                  </button>
                  <button
                    className="briefing-button"
                    onClick={() => void configureConnector()}
                    disabled={savingConnector}
                  >
                    {savingConnector ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />}
                    保存并测试连接
                  </button>
                </div>
              </div>
            )}
            <div className="catalog-grid">
              {catalogConnectors.map((item) => (
                <article key={item.kind}>
                  <span className="catalog-icon">
                    {item.kind === 'postgres' ? (
                      <Database size={16} />
                    ) : item.kind === 'project-agent' ? (
                      <Workflow size={16} />
                    ) : (
                      <Plug size={16} />
                    )}
                  </span>
                  <div>
                    <strong>{item.label}</strong>
                    <p>{item.description}</p>
                    <span>{item.capabilities.join(' · ')}</span>
                  </div>
                  {item.kind === 'postgres' ? (
                    <button disabled={!projectId} onClick={openPostgresForm}>
                      {!projectId ? '先选择项目' : selectedPostgres ? '编辑连接' : '配置'}
                    </button>
                  ) : (
                    <button
                      disabled={!projectId}
                      onClick={() => openConnectorForm(item.kind as Exclude<ConnectorKind, 'repo' | 'postgres'>)}
                    >
                      {!projectId
                        ? '先选择项目'
                        : bootstrap.connectors.some(
                              (connector) => connector.projectId === projectId && connector.kind === item.kind
                            )
                          ? '编辑连接'
                          : '配置'}
                    </button>
                  )}
                </article>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
