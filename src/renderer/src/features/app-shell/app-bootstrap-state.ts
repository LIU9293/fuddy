import type { AppBootstrap, AppBootstrapDataKey, AppBootstrapPatch } from '../../../../shared/contracts'

/** Generic remote/automation work can mutate any persisted product domain. */
export const mutableBootstrapKeys = [
  'projects',
  'runs',
  'connectors',
  'connectorRuns',
  'automations',
  'automationRuns'
] as const satisfies readonly AppBootstrapDataKey[]

export const automationBootstrapKeys = mutableBootstrapKeys
export const companionBootstrapKeys = mutableBootstrapKeys
/** A settled Run may have updated project configuration through the project MCP tool. */
export const agentRunStatusBootstrapKeys = ['runs', 'projects'] as const satisfies readonly AppBootstrapDataKey[]

export function applyAppBootstrapPatch(current: AppBootstrap, patch: AppBootstrapPatch): AppBootstrap {
  return { ...current, ...patch }
}

export function mergeBootstrapKeys(
  target: Set<AppBootstrapDataKey>,
  keys: readonly AppBootstrapDataKey[]
): void {
  for (const key of keys) target.add(key)
}
