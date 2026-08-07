import { describe, expect, it, vi } from 'vitest'
import type { CredentialVault } from '../services/credential-vault'
import { CloudflareConnector } from './cloudflare-connector'

function vault(): CredentialVault {
  return { get: () => 'token' } as unknown as CredentialVault
}

describe('CloudflareConnector', () => {
  it('collects Pages, Workers and R2 health through read-only APIs', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      const result = url.includes('/pages/projects')
        ? [{ name: 'site', latest_deployment: { stages: { deploy: { status: 'success' } } } }]
        : url.includes('/workers/scripts')
          ? [{ id: 'worker' }]
          : { buckets: [{ name: 'assets' }] }
      return new Response(JSON.stringify({ success: true, result }), { status: 200 })
    }) as typeof fetch
    const connector = new CloudflareConnector(vault(), fetchImpl)
    const result = await connector.collect({
      config: { accountId: 'a'.repeat(32), zoneId: '' }, credentialRef: 'cloudflare-token'
    })
    expect(result.summary).toContain('1 Pages · 1 Workers · 1 R2')
    expect(result.signal).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('raises a stable deployment failure signal', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      const result = url.includes('/pages/projects')
        ? [{ name: 'marketing', latest_deployment: { stages: { deploy: { status: 'failure' } } } }]
        : []
      return new Response(JSON.stringify({ success: true, result }), { status: 200 })
    }) as typeof fetch
    const result = await new CloudflareConnector(vault(), fetchImpl).collect({
      config: { accountId: 'b'.repeat(32), zoneId: '' }, credentialRef: 'token'
    })
    expect(result.signal).toEqual(expect.objectContaining({ fingerprint: 'pages-deployment-failures', urgency: 'high' }))
  })
})
