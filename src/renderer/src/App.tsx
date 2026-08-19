import { LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AgentRun } from '../../shared/contracts'
import type { AccountState } from '../../shared/account'
import fuddyWordmark from './assets/fuddy-wordmark.png'
import { AppRouteOutlet } from './features/app-shell/AppRouteOutlet'
import { AppSidebarData } from './features/app-shell/AppSidebar'
import { useAppNavigation } from './features/app-shell/app-route'
import { useAppBootstrap } from './features/app-shell/useAppBootstrap'
import { useSidebarLayout } from './features/app-shell/useSidebarLayout'
import { useAutoDismissMessage } from './views/shared'
import { AccountOnboarding } from './features/onboarding/AccountOnboarding'

export default function App(): React.JSX.Element {
  const navigation = useAppNavigation()
  const sidebarLayout = useSidebarLayout()
  const [notice, setNotice] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<AgentRun | null>(null)
  const [renameTitle, setRenameTitle] = useState('')
  const [runActionBusy, setRunActionBusy] = useState(false)
  const [accountState, setAccountState] = useState<AccountState | null>(null)
  const accountReady = accountState?.status === 'signed-in' && accountState.onboarding?.step === 'complete'
  const { ready, store, setBootstrap, refresh, refreshDomains } = useAppBootstrap({
    enabled: accountReady,
    onError: setNotice,
    onOpenAgentRun: navigation.openRun
  })
  useAutoDismissMessage(notice, () => setNotice(null))

  useEffect(() => {
    let active = true
    const unsubscribe = window.projectAgent.onAccountStateChanged((state) => {
      if (active) setAccountState(state)
    })
    void window.projectAgent.getAccountState()
      .then((state) => { if (active) setAccountState(state) })
      .catch((error: unknown) => {
        if (active) setNotice(error instanceof Error ? error.message : '无法读取账户状态。')
      })
    return () => { active = false; unsubscribe() }
  }, [])

  async function renameSidebarRun(): Promise<void> {
    if (!renameTarget || !renameTitle.trim() || runActionBusy) return
    setRunActionBusy(true)
    try {
      await window.projectAgent.renameAgentRun(renameTarget.id, renameTitle.trim())
      setRenameTarget(null)
      setRenameTitle('')
      await refreshDomains(['runs'])
      setNotice('Agent Run 已重命名。')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Agent Run 重命名失败。')
    } finally {
      setRunActionBusy(false)
    }
  }

  async function archiveSidebarRun(run: AgentRun): Promise<void> {
    if (runActionBusy || run.status === 'running' || run.status === 'queued') return
    setRunActionBusy(true)
    try {
      await window.projectAgent.archiveAgentRun(run.id)
      if (navigation.selectedAgentRunId === run.id) navigation.openRuns()
      await refreshDomains(['runs'])
      setNotice('Agent Run 已归档。')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Agent Run 归档失败。')
    } finally {
      setRunActionBusy(false)
    }
  }

  if (!accountState) {
    return (
      <main className="loading-screen">
        <img className="loading-wordmark" src={fuddyWordmark} alt="Fuddy" />
        <LoaderCircle className="spin" size={20} />
      </main>
    )
  }

  if (!accountReady) return <AccountOnboarding state={accountState} onStateChange={setAccountState} />

  if (!ready) {
    return (
      <main className="loading-screen">
        <img className="loading-wordmark" src={fuddyWordmark} alt="Fuddy" />
        <LoaderCircle className="spin" size={20} />
      </main>
    )
  }

  return (
    <div
      className={`app-shell ${sidebarLayout.open ? '' : 'sidebar-collapsed'} ${sidebarLayout.resizing ? 'is-resizing-sidebar' : ''}`}
      style={sidebarLayout.shellStyle}
    >
      <AppSidebarData
        store={store}
        navigation={navigation.navigation}
        sidebarSelection={navigation.sidebarSelection}
        settingsSection={navigation.settingsSection}
        selectedRunId={navigation.selectedAgentRunId}
        layout={sidebarLayout}
        onCloseSettings={navigation.closeSettings}
        onSettingsSection={navigation.setSettingsSection}
        onBriefing={navigation.openBriefing}
        onInbox={navigation.openInbox}
        onFiles={navigation.openFiles}
        onProjects={navigation.openProjects}
        onAutomations={navigation.openAutomations}
        onCreateRun={navigation.createRun}
        onOpenRun={navigation.openRun}
        onRenameRun={(run) => {
          setRenameTarget(run)
          setRenameTitle(run.title)
        }}
        onArchiveRun={(run) => void archiveSidebarRun(run)}
        onOpenSettings={navigation.openSettings}
      />

      <AppRouteOutlet
        store={store}
        setBootstrap={setBootstrap}
        refresh={refresh}
        refreshDomains={refreshDomains}
        navigation={navigation}
        sidebarOpen={sidebarLayout.open}
        onExpandSidebar={sidebarLayout.expand}
        notice={notice}
        onNotice={setNotice}
      />

      {renameTarget && (
        <div
          className="agent-session-rename-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target && !runActionBusy) setRenameTarget(null)
          }}
        >
          <form
            className="agent-session-rename-dialog"
            onSubmit={(event) => {
              event.preventDefault()
              void renameSidebarRun()
            }}
          >
            <strong>重命名 Agent Run</strong>
            <input
              autoFocus
              value={renameTitle}
              maxLength={200}
              onChange={(event) => setRenameTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && !runActionBusy) setRenameTarget(null)
              }}
              aria-label="Agent Run 新标题"
            />
            <div>
              <button type="button" disabled={runActionBusy} onClick={() => setRenameTarget(null)}>取消</button>
              <button type="submit" disabled={!renameTitle.trim() || runActionBusy}>保存</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
