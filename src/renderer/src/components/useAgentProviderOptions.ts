import { useEffect, useState } from 'react'
import { agentProviderOptions } from '../../../shared/agent-providers'
import type { AgentRunProvider, CodingAgentModelCatalog } from '../../../shared/contracts'

export function useAgentProviderOptions(selected?: AgentRunProvider, enabled = true): ReturnType<typeof agentProviderOptions> {
  const [catalog, setCatalog] = useState<CodingAgentModelCatalog | null>(null)
  useEffect(() => {
    if (!enabled) return
    let active = true
    void window.projectAgent.listCodingAgentModels().then(items => {
      if (active) setCatalog(items)
    }).catch(() => undefined)
    return () => { active = false }
  }, [enabled])
  return agentProviderOptions(catalog, selected)
}
