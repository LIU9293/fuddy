import { describe, expect, it, vi } from 'vitest'
import type { CredentialVault } from '../services/credential-vault'
import { normalizeProjectAgentConfig, ProjectAgentConnector } from './project-agent-connector'

describe('ProjectAgentConnector', () => {
  it('normalizes safe endpoints and rejects embedded credentials', () => {
    expect(normalizeProjectAgentConfig({ baseUrl: 'https://agent.example.com/', statusPath: '/health', agentName: 'Vows' }))
      .toEqual({ baseUrl: 'https://agent.example.com', statusPath: '/health', agentName: 'Vows' })
    expect(() => normalizeProjectAgentConfig({ baseUrl: 'https://user:secret@agent.example.com' })).toThrow('内嵌凭证')
  })

  it('converts agent blockers into decision evidence', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'degraded', blockers: ['campaign approval'] }), { status: 200 })) as typeof fetch
    const credentials = { get: () => 'key' } as unknown as CredentialVault
    const result = await new ProjectAgentConnector(credentials, fetchImpl).collect({
      config: { baseUrl: 'https://agent.example.com', statusPath: '/status', agentName: 'Marketing Agent' },
      credentialRef: 'agent-key'
    })
    expect(result.signal).toEqual(expect.objectContaining({ fingerprint: 'agent-health', urgency: 'medium' }))
    expect(fetchImpl).toHaveBeenCalledWith('https://agent.example.com/status', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer key' })
    }))
  })
})
