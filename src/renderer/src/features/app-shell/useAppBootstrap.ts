import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppBootstrap } from '../../../../shared/contracts'
import { agentRunUpdateStore } from '../agent-runs/agent-run-update-store'

interface UseAppBootstrapOptions {
  onOpenAgentRun: (runId: string) => void
  onError: (message: string) => void
}

export interface AppBootstrapController {
  bootstrap: AppBootstrap | null
  setBootstrap: React.Dispatch<React.SetStateAction<AppBootstrap | null>>
  refresh: () => Promise<void>
}

export function useAppBootstrap(options: UseAppBootstrapOptions): AppBootstrapController {
  const [bootstrap, setBootstrap] = useState<AppBootstrap | null>(null)
  const callbacks = useRef(options)
  callbacks.current = options

  const refresh = useCallback(async (): Promise<void> => {
    setBootstrap(await window.projectAgent.getBootstrap())
  }, [])

  useEffect(() => {
    let active = true
    let retryTimer: number | null = null
    let consecutiveFailures = 0
    const refreshFromMain = (): void => {
      void window.projectAgent.getBootstrap()
        .then((nextBootstrap) => {
          if (!active) return
          consecutiveFailures = 0
          setBootstrap(nextBootstrap)
        })
        .catch((error: unknown) => {
          if (!active) return
          consecutiveFailures += 1
          if (consecutiveFailures <= 5) {
            retryTimer = window.setTimeout(refreshFromMain, 400)
            return
          }
          callbacks.current.onError(error instanceof Error ? error.message : '无法读取应用数据，请重新启动。')
        })
    }
    refreshFromMain()
    const stopBriefings = window.projectAgent.onMorningBriefingReady(refreshFromMain)
    const stopAutomations = window.projectAgent.onAutomationsChanged(refreshFromMain)
    const stopCompanionData = window.projectAgent.onCompanionDataChanged(refreshFromMain)
    const stopOpenAgentRun = window.projectAgent.onOpenAgentRun((runId) => {
      refreshFromMain()
      callbacks.current.onOpenAgentRun(runId)
    })
    const stopAgentRuns = window.projectAgent.onAgentRunUpdate((envelope) => {
      agentRunUpdateStore.publish(envelope)
      if (envelope.update.type === 'created' || envelope.update.type === 'status') refreshFromMain()
    })
    return () => {
      active = false
      if (retryTimer !== null) window.clearTimeout(retryTimer)
      stopBriefings()
      stopAutomations()
      stopCompanionData()
      stopOpenAgentRun()
      stopAgentRuns()
    }
  }, [])

  return { bootstrap, setBootstrap, refresh }
}
