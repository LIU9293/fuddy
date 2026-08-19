import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { AppBootstrap, AppBootstrapDataKey } from '../../../../shared/contracts'
import { agentRunUpdateStore } from '../agent-runs/agent-run-update-store'
import {
  agentRunStatusBootstrapKeys,
  automationBootstrapKeys,
  companionBootstrapKeys,
  mergeBootstrapKeys,
  morningBriefingBootstrapKeys
} from './app-bootstrap-state'
import { AppDataStore } from './app-data-store'

interface UseAppBootstrapOptions {
  enabled: boolean
  onOpenAgentRun: (runId: string) => void
  onError: (message: string) => void
}

export interface AppBootstrapController {
  ready: boolean
  store: AppDataStore
  setBootstrap: React.Dispatch<React.SetStateAction<AppBootstrap | null>>
  refresh: () => Promise<void>
  refreshDomains: (keys: readonly AppBootstrapDataKey[]) => Promise<void>
}

export function useAppBootstrap(options: UseAppBootstrapOptions): AppBootstrapController {
  const storeRef = useRef<AppDataStore | null>(null)
  if (!storeRef.current) storeRef.current = new AppDataStore()
  const store = storeRef.current
  const ready = useSyncExternalStore(store.subscribeReady, store.getReadySnapshot, store.getReadySnapshot)
  const setBootstrap = useCallback<React.Dispatch<React.SetStateAction<AppBootstrap | null>>>(
    (action) => store.update(action),
    [store]
  )
  const callbacks = useRef(options)
  const mounted = useRef(true)
  const refreshQueue = useRef<Promise<void>>(Promise.resolve())
  const pendingPatchKeys = useRef<Set<AppBootstrapDataKey>>(new Set())
  const patchScheduled = useRef(false)
  callbacks.current = options

  const enqueueRefresh = useCallback((operation: () => Promise<void>): Promise<void> => {
    const next = refreshQueue.current.then(operation, operation)
    refreshQueue.current = next.catch(() => undefined)
    return next
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    if (!options.enabled) return
    await enqueueRefresh(async () => {
      const nextBootstrap = await window.projectAgent.getBootstrap()
      if (mounted.current) store.replace(nextBootstrap)
    })
  }, [enqueueRefresh, options.enabled, store])

  const refreshDomains = useCallback(async (keys: readonly AppBootstrapDataKey[]): Promise<void> => {
    if (!options.enabled || keys.length === 0) return
    await enqueueRefresh(async () => {
      const patch = await window.projectAgent.getBootstrapPatch([...new Set(keys)])
      if (mounted.current) store.patch(patch)
    })
  }, [enqueueRefresh, options.enabled, store])

  const refreshPatch = useCallback((keys: readonly AppBootstrapDataKey[]): void => {
    mergeBootstrapKeys(pendingPatchKeys.current, keys)
    if (patchScheduled.current) return
    patchScheduled.current = true
    queueMicrotask(() => {
      patchScheduled.current = false
      const requestedKeys = [...pendingPatchKeys.current]
      pendingPatchKeys.current.clear()
      if (requestedKeys.length === 0) return
      void refreshDomains(requestedKeys).catch((error: unknown) => {
        if (!mounted.current) return
        callbacks.current.onError(error instanceof Error ? error.message : '应用数据刷新失败。')
      })
    })
  }, [refreshDomains])

  useEffect(() => {
    if (!options.enabled) return
    mounted.current = true
    let active = true
    let retryTimer: number | null = null
    let consecutiveFailures = 0
    const refreshFromMain = (): void => {
      void enqueueRefresh(async () => {
        const nextBootstrap = await window.projectAgent.getBootstrap()
        if (active) {
          consecutiveFailures = 0
          store.replace(nextBootstrap)
        }
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
    const stopBriefings = window.projectAgent.onMorningBriefingReady(() => refreshPatch(morningBriefingBootstrapKeys))
    const stopAutomations = window.projectAgent.onAutomationsChanged(() => refreshPatch(automationBootstrapKeys))
    const stopCompanionData = window.projectAgent.onCompanionDataChanged(() => refreshPatch(companionBootstrapKeys))
    const stopOpenAgentRun = window.projectAgent.onOpenAgentRun((runId) => {
      refreshPatch(['runs'])
      callbacks.current.onOpenAgentRun(runId)
    })
    const stopAgentRuns = window.projectAgent.onAgentRunUpdate((envelope) => {
      agentRunUpdateStore.publish(envelope)
      if (envelope.update.type === 'created') refreshPatch(['runs'])
      if (envelope.update.type === 'status') refreshPatch(agentRunStatusBootstrapKeys)
    })
    return () => {
      mounted.current = false
      active = false
      if (retryTimer !== null) window.clearTimeout(retryTimer)
      stopBriefings()
      stopAutomations()
      stopCompanionData()
      stopOpenAgentRun()
      stopAgentRuns()
    }
  }, [enqueueRefresh, options.enabled, refreshPatch, store])

  return { ready, store, setBootstrap, refresh, refreshDomains }
}
