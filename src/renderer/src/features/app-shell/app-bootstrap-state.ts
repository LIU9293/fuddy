import type { AppBootstrap, AppBootstrapDataKey, AppBootstrapPatch } from '../../../../shared/contracts'

export const morningBriefingBootstrapKeys = [
  'dailyBriefings',
  'morningBriefings',
  'briefingMessages',
  'goals',
  'decisions',
  'decisionRemediations'
] as const satisfies readonly AppBootstrapDataKey[]

/** Generic remote/automation work can mutate any persisted product domain. */
export const mutableBootstrapKeys = [
  'projects',
  'goals',
  'decisions',
  'decisionRemediations',
  'runs',
  'connectors',
  'connectorRuns',
  'dailyBriefings',
  'morningBriefings',
  'briefingMessages',
  'automations',
  'automationRuns'
] as const satisfies readonly AppBootstrapDataKey[]

export const automationBootstrapKeys = mutableBootstrapKeys
export const companionBootstrapKeys = mutableBootstrapKeys

export function applyAppBootstrapPatch(current: AppBootstrap, patch: AppBootstrapPatch): AppBootstrap {
  return { ...current, ...patch }
}

export function mergeBootstrapKeys(
  target: Set<AppBootstrapDataKey>,
  keys: readonly AppBootstrapDataKey[]
): void {
  for (const key of keys) target.add(key)
}
