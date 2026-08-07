import { describe, expect, it, vi } from 'vitest'
import type { CredentialVault } from '../services/credential-vault'
import { Ga4Connector } from './ga4-connector'

describe('Ga4Connector', () => {
  it('compares weekly sessions and reports a material drop', async () => {
    let call = 0
    const fetchImpl = vi.fn(async () => {
      call += 1
      const values = call === 1 ? ['80', '70', '500', '4'] : call === 2 ? ['120', '110', '700', '8'] : ['70', '60']
      return new Response(JSON.stringify({ rows: [{ metricValues: values.map((value) => ({ value })) }] }), { status: 200 })
    }) as typeof fetch
    const credentials = { get: () => JSON.stringify({ accessToken: 'access' }) } as unknown as CredentialVault
    const result = await new Ga4Connector(credentials, fetchImpl).collect({
      config: { propertyId: '123456' }, credentialRef: 'ga4-oauth'
    })
    expect(result.summary).toContain('70 sessions')
    expect(result.signal).toEqual(expect.objectContaining({ fingerprint: 'weekly-session-drop' }))
  })
})
