import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, Notification, shell } from 'electron'
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

Sentry.init({
  dsn: SENTRY_DSN,
  environment: app.isPackaged ? 'production' : 'development',
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
  const filename = nativeTheme.shouldUseDarkColors
    ? 'fuddy-mac-icon-dark.png'
    : 'fuddy-mac-icon-light.png'
  return app.isPackaged
    ? join(process.resourcesPath, 'branding', filename)
    : join(app.getAppPath(), 'build', filename)
}

function updateMacDockIcon(): void {
  if (process.platform !== 'darwin') return
  app.dock?.setIcon(resolveMacDockIconPath())
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
    title: 'Fuddy',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  splashWindow.once('ready-to-show', () => splashWindow?.show())
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
    title: 'Project Agent',
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
    mainWindow?.show()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL
    const isLocalRenderer = rendererUrl ? url.startsWith(rendererUrl) : url.startsWith('file://')
    if (!isLocalRenderer) event.preventDefault()
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const hasLock = app.requestSingleInstanceLock()

if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    updateMacDockIcon()
    nativeTheme.on('updated', updateMacDockIcon)
    createSplashWindow()
    await hydrateProcessEnvironmentFromZsh()
    const userDataPath = app.getPath('userData')
    const databasePath = join(userDataPath, 'project-agent.sqlite')
    database = new AppDatabase(databasePath)
    const credentialVault = new CredentialVault(join(userDataPath, 'credentials.enc'))
    const providerSettings = new ProviderSettingsService(database, credentialVault)
    const connectorRuntime = new ConnectorRuntime(database, credentialVault)
    const runtime = new PiAgentRuntime(providerSettings)
    const decisionRemediationService = new DecisionRemediationService(database)
    const workspaceFiles = new WorkspaceFilesService(database, join(userDataPath, 'project-files'))
    const mcpOptions = resolveThirdPartyMcpOptions({
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      userDataPath,
      packaged: app.isPackaged,
      hostBundleId: 'dev.ainative.projectagent'
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
      async (run) => {
        await decisionRemediationService.sync(run.projectId)
      }
    )
    const dailyBriefingService = new DailyBriefingService(database, connectorRuntime, runtime)
    const projectAgentIntegration = new ProjectAgentIntegrationService(
      database,
      credentialVault,
      (input, onUpdate) => dispatcher.dispatch(input, onUpdate)
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
    const morningBriefingService = new MorningBriefingService(
      database,
      dailyBriefingService,
      runtime,
      goalTrackingService,
      workspaceAgentActions,
      decisionRemediationService
    )
    workspaceAgentActions.setMorningBriefingGenerator(() => morningBriefingService.generate())
    companionSync = new CompanionSyncService(
      database,
      credentialVault,
      dispatcher,
      (question, attachments) => morningBriefingService.ask(null, question, null, attachments),
      join(userDataPath, 'companion-uploads'),
      () => providerSettings.getPublicSettings().codingAgents.defaultAgent,
      workspaceFiles
    )
    companionSync.setWorkAssistantActionExecutor((input) => morningBriefingService.executeAction(input))
    companionSync.onStatusChanged((status) => {
      if (!mainWindow?.webContents.isDestroyed()) mainWindow?.webContents.send('companion:status-changed', status)
    })
    companionSync.onDataChanged(() => {
      if (!mainWindow?.webContents.isDestroyed()) mainWindow?.webContents.send('companion:data-changed')
    })
    const ttsService = new TtsService(database, providerSettings)
    const automationRuntime = new AutomationRuntime(database, {
      runAgentTask: async (job) => {
        const result = await dispatcher.dispatch({
          projectId: job.projectId,
          provider: job.agentProvider,
          title: `${job.name} · 自动运行`,
          prompt: job.prompt
        })
        return { summary: result.message, agentRunId: result.detail.run.id }
      },
      runConnectors: async (projectId) => {
        const result = await connectorRuntime.runConnectors(projectId)
        const remediation = await decisionRemediationService.sync(projectId)
        return `Connector 巡检完成：${result.succeeded} 成功，${result.failed} 失败；核验 ${remediation.remediations.length} 条修复进度。`
      },
      checkGoals: async (projectId) => {
        const results = await goalTrackingService.checkDueGoals(projectId ?? undefined)
        return results.length > 0 ? `已检查 ${results.length} 个到期目标。` : '当前没有到期目标。'
      },
      generateBriefing: async (projectId) => {
        if (projectId) {
          const result = await dailyBriefingService.generate(projectId)
          return result.briefing.headline
        }
        const result = await morningBriefingService.generate()
        return result.briefing.headline
      }
    })
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
        console.error('[daily-briefing-scheduler] generation failed', error instanceof Error ? error.message : 'Unknown error')
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
      ttsService,
      workspaceFiles,
      automationRuntime,
      projectAgentIntegration,
      companionSync
    )
    createWindow()
    void decisionRemediationService.sync().then(() => {
      if (!mainWindow?.webContents.isDestroyed()) mainWindow?.webContents.send('companion:data-changed')
    }).catch((error: unknown) => {
      Sentry.captureException(error, { tags: { boundary: 'decision-remediation-startup' } })
    })
    void companionSync.start()
    if (process.env.PROJECT_AGENT_SENTRY_TEST === '1') {
      setTimeout(() => {
        Sentry.captureException(new Error('Project Agent main-process Sentry integration test'))
        void Sentry.flush(5_000).then((sent) => console.info(`[sentry-test] flushed=${sent}`))
      }, 1_000)
    }
    dailyBriefingScheduler.start()
    automationScheduler.start()

    app.on('activate', () => {
      if (!mainWindow) createWindow()
    })
  }).catch(async (error: unknown) => {
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
    companionSync?.stop()
    companionSync = null
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
