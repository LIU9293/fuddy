import { useState } from 'react'
import type { DesktopApi } from '../../../shared/contracts'

type AcpAgent = Awaited<ReturnType<DesktopApi['searchAcpAgents']>>[number]

export function AcpAgentSettings({ onAdded }: { onAdded: (id: `acp-${string}`) => Promise<void> }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<AcpAgent[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(operation: () => Promise<void>): Promise<void> {
    setBusy(true)
    setError(null)
    try { await operation() } catch (error) {
      setError(error instanceof Error ? error.message : 'ACP Registry 暂时不可用。')
    } finally { setBusy(false) }
  }

  return <section className="settings-list-section-spacing" aria-labelledby="acp-agent-heading">
    <h2 className="settings-group-label" id="acp-agent-heading">ACP Registry</h2>
    <form className="settings-setup-row" onSubmit={event => {
      event.preventDefault()
      void run(async () => setResults(await window.projectAgent.searchAcpAgents(query)))
    }}>
      <label htmlFor="acp-agent-query">搜索 Agent</label>
      <input id="acp-agent-query" value={query} maxLength={120} onChange={event => setQuery(event.target.value)} />
      <button className="settings-row-button" type="submit" disabled={busy}>搜索</button>
    </form>
    {error && <p className="settings-inline-error" role="alert">{error}</p>}
    {results?.length === 0 && <p role="status">没有找到匹配的 Agent。</p>}
    {results && results.length > 0 && <div className="settings-flat-list">
      {results.map(agent => <article key={agent.id}>
        <div><strong>{agent.name}</strong>{agent.description && <p>{agent.description}</p>}</div>
        <button className="settings-row-button" disabled={busy} onClick={() => void run(async () => {
          await onAdded(await window.projectAgent.addAcpAgent(agent.id))
          setResults(current => current?.filter(item => item.id !== agent.id) ?? null)
        })}>添加</button>
      </article>)}
    </div>}
  </section>
}
