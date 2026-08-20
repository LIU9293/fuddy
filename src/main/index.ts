import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { app, BrowserWindow, nativeTheme, Notification, protocol, shell } from 'electron'
import * as Sentry from '@sentry/electron/main'
import { ConnectorRuntime } from './connectors/connector-runtime'
import { registerIpc } from './ipc'
import { AppDatabase } from './services/database'
import { CredentialVault } from './services/credential-vault'
import { DailyBriefingScheduler } from './services/daily-briefing-scheduler'
import { DailyBriefingService } from './services/daily-briefing'
import { PiAgentRuntime } from './services/pi-runtime'
import { MorningBriefingService } from './services/morning-briefing'
import { ProviderSettingsService } from './services/provider-settings'
import { TaskDispatcher } from './services/task-dispatcher'
import { TtsService } from './services/tts-service'
import { AsrService } from './services/asr-service'
import { GoalTrackingService } from './services/goal-tracking'
import { WorkspaceAgentActions } from './services/workspace-agent-actions'
import { DecisionRemediationService } from './services/decision-remediation'
import { WorkspaceFilesService } from './services/workspace-files'
import { ProjectInspectionService } from './services/project-inspection'
import { PiTaskHarness } from './services/pi-task-harness'
import { AutomationRuntime } from './services/automation-runtime'
import { AutomationScheduler } from './services/automation-scheduler'
import { CliAgentRuntime } from './services/cli-agent-runtime'
import { resolveThirdPartyMcpOptions, ThirdPartyMcpRuntime } from './services/third-party-mcp-runtime'
import { ProjectAgentIntegrationService } from './services/project-agent-integration'
import { SENTRY_DSN, SENTRY_PROJECT } from '../shared/sentry'
import { hydrateProcessEnvironmentFromZsh } from './services/shell-environment'
import { CompanionSyncService } from './services/companion-sync'
import { WebResearchService } from './services/web-research'
import { PiWorkAssistantAgent } from './services/work-assistant-agent'
import { agentRunNotificationContent } from './services/agent-run-notifications'
import { buildAgentModelLabels } from '../shared/model-display'
import { loadProjectAnalyticsProfiles } from './analytics/project-analytics-profiles'
import { registerBundledProjectAnalyticsProfiles } from './project-extensions/bundled-project-analytics'
import { registerBundledPostgresCollectors } from './project-extensions/bundled-postgres-collectors'
import { registerBundledDailyBriefingStrategies } from './project-extensions/roombase-daily-briefing'
import { startAutoUpdateService } from './services/auto-update-service'
import { resolveFuddyRuntimeProfile } from './runtime-profile'
import { registerWorkspaceFileProtocol } from './services/workspace-file-protocol'
import { workspaceFilePreviewScheme } from '../shared/workspace-file-preview'
import { AccountService, normalizeAccountApiUrl } from './services/account-service'
import {
  AccountEnrollmentCoordinator,
  resolveCompanionRelayUrl
} from './services/account-enrollment-coordinator'

protocol.registerSchemesAsPrivileged([{
  scheme: workspaceFilePreviewScheme,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}])

function packagedRuntimeChannel(): string | null {
  try {
    const packageMetadata = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as {
      fuddyRuntimeProfile?: unknown
    }
    return typeof packageMetadata.fuddyRuntimeProfile === 'string' ? packageMetadata.fuddyRuntimeProfile : null
  } catch {
    return null
  }
}

const runtimeProfile = resolveFuddyRuntimeProfile({
  appDataPath: app.getPath('appData'),
  appName: app.getName(),
  appExecutablePath: process.execPath,
  isPackaged: app.isPackaged,
  packagedRuntimeChannel: packagedRuntimeChannel(),
  environment: process.env
})
mkdirSync(runtimeProfile.userDataPath, { recursive: true })
// Production keeps the historical package name internally because Electron
// derives its macOS Safe Storage identity from it. The bundle and every visible
// window still use Fuddy; changing this internal name would orphan existing
// encrypted credentials. Development uses a separate name and vault identity.
if (runtimeProfile.channel === 'development') app.setName(runtimeProfile.appName)
app.setPath('userData', runtimeProfile.userDataPath)

Sentry.init({
  dsn: SENTRY_DSN,
  environment: runtimeProfile.channel,
  release: `${SENTRY_PROJECT}@${app.getVersion()}`,
  sendDefaultPii: false,
  skipOpenTelemetrySetup: true,
  debug: process.env.PROJECT_AGENT_SENTRY_TEST === '1'
})

let mainWindow: BrowserWindow | null = null
let splashWindow: BrowserWindow | null = null
let database: AppDatabase | null = null
let dailyBriefingScheduler: DailyBriefingScheduler | null = null
let automationScheduler: AutomationScheduler | null = null
let agentToolsMcp: ThirdPartyMcpRuntime | null = null
let shutdownPromise: Promise<void> | null = null
let shutdownComplete = false
let companionSync: CompanionSyncService | null = null
let accountEnrollmentCoordinator: AccountEnrollmentCoordinator | null = null
let pendingAgentRunNavigationId: string | null = null
let stopAutoUpdates: (() => void) | null = null
let taskDispatcher: TaskDispatcher | null = null

app.on('render-process-gone', (_event, webContents, details) => {
  if (details.reason === 'clean-exit' || details.reason === 'killed') return
  Sentry.withScope((scope) => {
    scope.setTag('process.type', 'renderer')
    scope.setContext('renderer_crash', {
      reason: details.reason,
      exitCode: details.exitCode,
      url: webContents.getURL()
    })
    Sentry.captureMessage(`Renderer process exited unexpectedly: ${details.reason}`, 'fatal')
  })
})

app.on('child-process-gone', (_event, details) => {
  if (details.reason === 'clean-exit' || details.reason === 'killed') return
  Sentry.withScope((scope) => {
    scope.setTag('process.type', details.type)
    scope.setContext('child_process_crash', {
      name: details.name,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName
    })
    Sentry.captureMessage(`Electron child process exited unexpectedly: ${details.type}`, 'fatal')
  })
})

function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function resolveMacDockIconPath(): string {
  const filename = nativeTheme.shouldUseDarkColors ? 'fuddy-mac-icon-dark.png' : 'fuddy-mac-icon-light.png'
  return app.isPackaged ? join(process.resourcesPath, 'branding', filename) : join(app.getAppPath(), 'build', filename)
}

function updateMacDockIcon(): void {
  if (process.platform !== 'darwin') return
  const iconPath = resolveMacDockIconPath()
  if (existsSync(iconPath)) app.dock?.setIcon(iconPath)
  app.dock?.setBadge(runtimeProfile.channel === 'development' ? 'DEV' : '')
}

function createSplashWindow(): void {
  splashWindow = new BrowserWindow({
    width: 720,
    height: 512,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#000000' : '#ffffff',
    title: runtimeProfile.appName,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  splashWindow.once('ready-to-show', () => splashWindow?.show())
  splashWindow.on('page-title-updated', (event) => {
    event.preventDefault()
    splashWindow?.setTitle(runtimeProfile.appName)
  })
  splashWindow.on('closed', () => {
    splashWindow = null
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void splashWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/splash.html`)
  } else {
    void splashWindow.loadFile(join(__dirname, '../renderer/splash.html'))
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    show: false,
    title: runtimeProfile.appName,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#f7f7f4',
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    splashWindow?.close()
    showMainWindow()
  })
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault()
    mainWindow?.setTitle(runtimeProfile.appName)
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details) => {
    if (webContents?.id !== mainWindow?.webContents.id || permission !== 'media') return false
    return details.mediaType === 'audio' || details.mediaType === 'unknown'
  })
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const sameWindow = webContents.id === mainWindow?.webContents.id
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : []
    const audioOnly = mediaTypes?.includes('audio') && !mediaTypes.includes('video')
    callback(Boolean(sameWindow && permission === 'media' && audioOnly))
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL
    const isLocalRenderer = rendererUrl ? url.startsWith(rendererUrl) : url.startsWith('file://')
    if (!isLocalRenderer) event.preventDefault()
  })

  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow || !pendingAgentRunNavigationId) return
    mainWindow.webContents.send('navigation:open-agent-run', pendingAgentRunNavigationId)
    pendingAgentRunNavigationId = null
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function openAgentRunFromNotification(runId: string): void {
  pendingAgentRunNavigationId = runId
  if (!mainWindow) createWindow()
  else if (!mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('navigation:open-agent-run', runId)
    pendingAgentRunNavigationId = null
  }
  showMainWindow()
}

function showAgentRunNotification(turn: import('../shared/companion-sync').AgentTurnSettledPayload): void {
  if (!Notification.isSupported()) return
  const content = agentRunNotificationContent(turn)
  const notification = new Notification({ ...content, silent: false })
  notification.on('click', () => openAgentRunFromNotification(turn.runId))
  notification.on('failed', (_event, error) => {
    console.error('[agent-run-notification] failed', error)
  })
  notification.show()
}

function showMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  if (process.platform === 'darwin') app.focus({ steal: true })
  mainWindow.focus()
}

const hasLock = app.requestSingleInstanceLock()

if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  app
    .whenReady()
    .then(async () => {
      updateMacDockIcon()
      nativeTheme.on('updated', updateMacDockIcon)
      createSplashWindow()
      await hydrateProcessEnvironmentFromZsh()
      const userDataPath = app.getPath('userData')
      const analyticsProfilePath = join(userDataPath, 'project-capabilities')
      mkdirSync(analyticsProfilePath, { recursive: true })
      registerBundledProjectAnalyticsProfiles()
      registerBundledPostgresCollectors()
      registerBundledDailyBriefingStrategies()
      loadProjectAnalyticsProfiles(analyticsProfilePath)
      const databasePath = join(userDataPath, 'project-agent.sqlite')
      database = new AppDatabase(databasePath)
      const credentialVault = new CredentialVault(join(userDataPath, 'credentials.enc'))
      const configuredAccountApiUrl = process.env.FUDDY_ACCOUNT_API_URL?.trim()
      const defaultAccountApiUrl = runtimeProfile.channel === 'development'
        ? 'http://127.0.0.1:8788'
        : 'https://fuddy.ai/api/account'
      const accountApiUrl = normalizeAccountApiUrl(
        configuredAccountApiUrl || defaultAccountApiUrl,
        runtimeProfile.channel
      )
      const accountService = new AccountService(database, credentialVault, {
        apiUrl: accountApiUrl,
        runtimeChannel: runtimeProfile.channel,
        appVersion: app.getVersion(),
        googleClientId: process.env.FUDDY_GOOGLE_CLIENT_ID?.trim()
          || (runtimeProfile.channel === 'production'
            ? '877382581311-dt2ln9r81lqe8i0d6svknfs1dfi1s889.apps.googleusercontent.com'
            : null)
      })
      const companionRelayUrl = resolveCompanionRelayUrl(
        process.env.FUDDY_COMPANION_RELAY_URL,
        runtimeProfile.channel
      )
      const providerSettings = new ProviderSettingsService(database, credentialVault)
      const whisperRoot = app.isPackaged
        ? join(process.resourcesPath, 'third-party', 'whisper')
        : join(
            app.getAppPath(),
            '.third-party-tools',
            'whisper',
            `darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
          )
      const asrService = new AsrService(providerSettings, {
        modelDirectory: join(userDataPath, 'asr-models'),
        helperPath: join(whisperRoot, 'whisper-helper'),
        temporaryDirectory: join(userDataPath, 'asr-temp'),
        onDownloadProgress: (progress) => {
          if (!mainWindow?.webContents.isDestroyed()) mainWindow?.webContents.send('asr:download-progress', progress)
        }
      })
      const connectorRuntime = new ConnectorRuntime(database, credentialVault)
      const runtime = new PiAgentRuntime(providerSettings)
      const decisionRemediationService = new DecisionRemediationService(database)
      const workspaceFiles = new WorkspaceFilesService(database, join(userDataPath, 'project-files'))
      registerWorkspaceFileProtocol(workspaceFiles)
      const mcpOptions = resolveThirdPartyMcpOptions({
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
        userDataPath,
        packaged: app.isPackaged,
        hostBundleId: runtimeProfile.hostBundleId
      })
      agentToolsMcp = new ThirdPartyMcpRuntime(mcpOptions)
      const piTaskHarness = new PiTaskHarness(
        providerSettings,
        database,
        agentToolsMcp,
        join(userDataPath, 'pi-sessions')
      )
      const dispatcher = new TaskDispatcher(
        database,
        piTaskHarness,
        workspaceFiles,
        new CliAgentRuntime(agentToolsMcp, join(__dirname, 'project-agent-mcp.js'), databasePath, providerSettings),
        undefined,
        async (run, turn) => {
          showAgentRunNotification(turn)
          if (turn.outcome === 'completed') await decisionRemediationService.sync(run.projectId)
        }
      )
      taskDispatcher = dispatcher
      dispatcher.onRunUpdate((runId, update) => {
        const targetWindow = mainWindow
        if (!targetWindow || targetWindow.webContents.isDestroyed()) return
        targetWindow.webContents.send('agent-run:broadcast', { requestId: '', runId, update })
      })
      const dailyBriefingService = new DailyBriefingService(database, connectorRuntime, runtime)
      const projectAgentIntegration = new ProjectAgentIntegrationService(database, credentialVault, (input, onUpdate) =>
        dispatcher.dispatch(input, onUpdate)
      )
      const goalTrackingService = new GoalTrackingService(database, runtime)
      const workspaceAgentActions = new WorkspaceAgentActions(
        database,
        runtime,
        goalTrackingService,
        dispatcher,
        new ProjectInspectionService(database, workspaceFiles),
        new WebResearchService()
      )
      const workAssistantAgent = new PiWorkAssistantAgent(
        providerSettings,
        database,
        workspaceAgentActions,
        join(userDataPath, 'work-assistant-pi-session'),
        userDataPath
      )
      const morningBriefingService = new MorningBriefingService(
        database,
        dailyBriefingService,
        runtime,
        goalTrackingService,
        workspaceAgentActions,
        decisionRemediationService,
        workAssistantAgent
      )
      workspaceAgentActions.setMorningBriefingGenerator((cancellationSignal) => (
        morningBriefingService.generate(cancellationSignal)
      ))
      companionSync = new CompanionSyncService(
        database,
        credentialVault,
        dispatcher,
        (question, attachments, cancellationSignal) => morningBriefingService.ask(
          null,
          question,
          null,
          attachments,
          () => undefined,
          cancellationSignal
        ),
        join(userDataPath, 'companion-uploads'),
        () => providerSettings.getPublicSettings().codingAgents.defaultAgent,
        workspaceFiles,
        () => buildAgentModelLabels(providerSettings.getPublicSettings())
      )
      accountEnrollmentCoordinator = new AccountEnrollmentCoordinator(
        accountService,
        companionSync,
        companionRelayUrl
      )
      companionSync.setWorkAssistantActionExecutor((input, cancellationSignal) => (
        morningBriefingService.executeAction(input, cancellationSignal)
      ))
      companionSync.onStatusChanged((status) => {
        if (!mainWindow?.webContents.isDestroyed()) mainWindow?.webContents.send('companion:status-changed', status)
      })
      companionSync.onDataChanged(() => {
        if (!mainWindow?.webContents.isDestroyed()) mainWindow?.webContents.send('companion:data-changed')
      })
      const ttsService = new TtsService(database, providerSettings)
      const automationRuntime = new AutomationRuntime(database, {
        runAgentTask: async (job, cancellationSignal) => {
          const result = await dispatcher.dispatch({
            projectId: job.projectId,
            provider: job.agentProvider,
            title: `${job.name} · 自动运行`,
            prompt: job.prompt
          }, () => undefined, cancellationSignal)
          return { summary: result.message, agentRunId: result.detail.run.id }
        },
        runConnectors: async (projectId, cancellationSignal) => {
          const result = await connectorRuntime.runConnectors(projectId, cancellationSignal)
          const remediation = await decisionRemediationService.sync(projectId, cancellationSignal)
          return `Connector 巡检完成：${result.succeeded} 成功，${result.failed} 失败；核验 ${remediation.remediations.length} 条修复进度。`
        },
        checkGoals: async (projectId, cancellationSignal) => {
          const results = await goalTrackingService.checkDueGoals(projectId ?? undefined, cancellationSignal)
          return results.length > 0 ? `已检查 ${results.length} 个到期目标。` : '当前没有到期目标。'
        },
        generateBriefing: async (projectId, cancellationSignal) => {
          if (projectId) {
            const result = await dailyBriefingService.generate(projectId, cancellationSignal)
            return result.briefing.headline
          }
          const result = await morningBriefingService.generate(cancellationSignal)
          return result.briefing.headline
        }
      })
      workspaceAgentActions.setAutomationRuntime(automationRuntime)
      automationRuntime.onChanged(() => {
        if (!mainWindow?.webContents.isDestroyed()) mainWindow?.webContents.send('automation:changed')
      })
      automationScheduler = new AutomationScheduler(database, automationRuntime)
      dailyBriefingScheduler = new DailyBriefingScheduler(
        database,
        morningBriefingService,
        (headline) => {
          mainWindow?.webContents.send('briefing:morning-ready')
          if (Notification.isSupported()) {
            const notification = new Notification({
              title: '每日简报已送达',
              body: headline,
              silent: false
            })
            notification.on('click', () => {
              if (!mainWindow) createWindow()
              if (mainWindow?.isMinimized()) mainWindow.restore()
              mainWindow?.show()
              mainWindow?.focus()
            })
            notification.show()
          }
        },
        (error) => {
          Sentry.captureException(error, { tags: { boundary: 'daily-briefing-scheduler' } })
          console.error(
            '[daily-briefing-scheduler] generation failed',
            error instanceof Error ? error.message : 'Unknown error'
          )
        }
      )
      registerIpc(
        database,
        dispatcher,
        connectorRuntime,
        decisionRemediationService,
        credentialVault,
        dailyBriefingService,
        morningBriefingService,
        goalTrackingService,
        providerSettings,
        asrService,
        ttsService,
        workspaceFiles,
        automationRuntime,
        projectAgentIntegration,
        companionSync,
        accountService,
        accountEnrollmentCoordinator
      )
      createWindow()
      const updateConfigurationExists = existsSync(join(process.resourcesPath, 'app-update.yml'))
      stopAutoUpdates = startAutoUpdateService((error) => {
        Sentry.captureException(error, { tags: { boundary: 'auto-update' } })
      }, runtimeProfile.autoUpdatesEnabled && updateConfigurationExists)
      void decisionRemediationService
        .sync()
        .then(() => {
          if (!mainWindow?.webContents.isDestroyed()) mainWindow?.webContents.send('companion:data-changed')
        })
        .catch((error: unknown) => {
          Sentry.captureException(error, { tags: { boundary: 'decision-remediation-startup' } })
        })
      const accountState = accountService.getState()
      if (accountState.status === 'signed-in' && accountState.user) {
        const activeCompanionSync = companionSync
        const activeEnrollmentCoordinator = accountEnrollmentCoordinator
        void activeCompanionSync.activateAccountRelay(
          accountState.user.id,
          accountState.device?.syncSpaceId ?? undefined
        ).then(() => {
          activeEnrollmentCoordinator.start()
        }).catch((error: unknown) => {
          Sentry.captureException(error, { tags: { boundary: 'account-relay-startup' } })
        })
      } else if (companionSync.hasAccountRelayIdentity()) {
        // A cached Account session may expire while Fuddy is closed. Account-owned
        // Relay state must not survive that signed-out bootstrap path.
        void companionSync.disconnectAllAccountRelays().catch((error: unknown) => {
          Sentry.captureException(error, { tags: { boundary: 'account-relay-startup-revocation' } })
        })
      }
      if (process.env.PROJECT_AGENT_SENTRY_TEST === '1') {
        setTimeout(() => {
          Sentry.captureException(new Error('Fuddy main-process Sentry integration test'))
          void Sentry.flush(5_000).then((sent) => console.info(`[sentry-test] flushed=${sent}`))
        }, 1_000)
      }
      dailyBriefingScheduler.start()
      automationScheduler.start()

      app.on('activate', () => {
        if (!mainWindow) createWindow()
        else showMainWindow()
      })
    })
    .catch(async (error: unknown) => {
      splashWindow?.close()
      Sentry.captureException(error, { tags: { boundary: 'app.whenReady' } })
      await Sentry.flush(2_000)
      app.quit()
    })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

async function shutdown(): Promise<void> {
  if (shutdownPromise) return await shutdownPromise
  shutdownPromise = (async () => {
    nativeTheme.removeListener('updated', updateMacDockIcon)
    dailyBriefingScheduler?.stop()
    dailyBriefingScheduler = null
    automationScheduler?.stop()
    automationScheduler = null
    stopAutoUpdates?.()
    stopAutoUpdates = null
    const activeEnrollmentCoordinator = accountEnrollmentCoordinator
    accountEnrollmentCoordinator = null
    activeEnrollmentCoordinator?.stop()
    await activeEnrollmentCoordinator?.pauseAndDrain()
    const activeCompanionSync = companionSync
    companionSync = null
    await activeCompanionSync?.stopAndDrain()
    const activeTaskDispatcher = taskDispatcher
    taskDispatcher = null
    await activeTaskDispatcher?.stopAndDrain()
    await agentToolsMcp?.stop()
    agentToolsMcp = null
    database?.close()
    database = null
  })()
  return await shutdownPromise
}

app.on('before-quit', (event) => {
  if (shutdownComplete) return
  event.preventDefault()
  void shutdown().finally(() => {
    shutdownComplete = true
    app.quit()
  })
})
