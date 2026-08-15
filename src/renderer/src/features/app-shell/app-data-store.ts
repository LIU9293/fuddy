import { useCallback, useSyncExternalStore } from 'react'
import type { AppBootstrap, AppBootstrapDataKey, AppBootstrapPatch } from '../../../../shared/contracts'

type Listener = () => void

export class AppDataStore {
  private state: AppBootstrap | null = null
  private readonly listeners = new Set<Listener>()
  private readonly readyListeners = new Set<Listener>()
  private readonly domainListeners = new Map<AppBootstrapDataKey, Set<Listener>>()

  readonly getSnapshot = (): AppBootstrap | null => this.state
  readonly getReadySnapshot = (): boolean => this.state !== null

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeReady = (listener: Listener): (() => void) => {
    this.readyListeners.add(listener)
    return () => this.readyListeners.delete(listener)
  }

  subscribeDomain(key: AppBootstrapDataKey, listener: Listener): () => void {
    const listeners = this.domainListeners.get(key) ?? new Set<Listener>()
    listeners.add(listener)
    this.domainListeners.set(key, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.domainListeners.delete(key)
    }
  }

  getDomain<TKey extends AppBootstrapDataKey>(key: TKey): AppBootstrap[TKey] | null {
    return this.state?.[key] ?? null
  }

  replace(next: AppBootstrap): void {
    const previous = this.state
    this.state = next
    this.emitChangedDomains(previous, next)
    this.emit(this.listeners)
    if (previous === null) this.emit(this.readyListeners)
  }

  patch(patch: AppBootstrapPatch): void {
    if (!this.state) return
    const previous = this.state
    const next = { ...previous, ...patch }
    this.state = next
    this.emitChangedDomains(previous, next)
    this.emit(this.listeners)
  }

  update(action: React.SetStateAction<AppBootstrap | null>): void {
    const previous = this.state
    const next = typeof action === 'function' ? action(previous) : action
    if (next === previous) return
    this.state = next
    this.emitChangedDomains(previous, next)
    this.emit(this.listeners)
    if ((previous === null) !== (next === null)) this.emit(this.readyListeners)
  }

  private emitChangedDomains(previous: AppBootstrap | null, next: AppBootstrap | null): void {
    for (const [key, listeners] of this.domainListeners) {
      if (previous?.[key] !== next?.[key]) this.emit(listeners)
    }
  }

  private emit(listeners: Set<Listener>): void {
    for (const listener of listeners) listener()
  }
}

export function useAppDataDomain<TKey extends AppBootstrapDataKey>(
  store: AppDataStore,
  key: TKey
): AppBootstrap[TKey] | null {
  const subscribe = useCallback((listener: Listener) => store.subscribeDomain(key, listener), [key, store])
  const getSnapshot = useCallback(() => store.getDomain(key), [key, store])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
