import { LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import type { AgentRun } from '../../shared/contracts'
import fuddyWordmark from './assets/fuddy-wordmark.png'
import { AppRouteOutlet } from './features/app-shell/AppRouteOutlet'
import { AppSidebarData } from './features/app-shell/AppSidebar'
import { useAppNavigation } from './features/app-shell/app-route'
import { useAppBootstrap } from './features/app-shell/useAppBootstrap'
import { useSidebarLayout } from './features/app-shell/useSidebarLayout'
import { useAutoDismissMessage } from './views/shared'

export default function App(): React.JSX.Element {
  const navigation = useAppNavigation()
  const sidebarLayout = useSidebarLayout()
  const [notice, setNotice] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<AgentRun | null>(null)
  const [renameTitle, setRenameTitle] = useState('')
  const [runActionBusy, setRunActionBusy] = useState(false)
  const { ready, store, setBootstrap, refresh, refreshDomains } = useAppBootstrap({
    onError: setNotice,
    onOpenAgentRun: navigation.openRun
  })
  useAutoDismissMessage(notice, () => setNotice(null))

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
