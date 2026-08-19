import { describe, expect, it } from 'vitest'
import { getGoogleIdToken } from './google-desktop-oauth'

describe('getGoogleIdToken', () => {
  it('uses a loopback callback, state, and PKCE before returning the Google ID token', async () => {
    let authorizationUrlValue = ''
    let tokenBodyValue = ''
    const token = await getGoogleIdToken({
      clientId: 'desktop-client-id',
      timeoutMs: 2_000,
      openExternal: async (value) => {
        authorizationUrlValue = value
        const authorizationUrl = new URL(value)
        const redirectUri = authorizationUrl.searchParams.get('redirect_uri')!
        const state = authorizationUrl.searchParams.get('state')!
        queueMicrotask(() => {
          void fetch(`${redirectUri}?code=authorization-code&state=${encodeURIComponent(state)}`)
        })
      },
      fetch: async (_url, init) => {
        tokenBodyValue = String(init?.body)
        return new Response(JSON.stringify({ id_token: 'verified-google-id-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
    })

    expect(token).toBe('verified-google-id-token')
    const authorizationUrl = new URL(authorizationUrlValue)
    const tokenBody = new URLSearchParams(tokenBodyValue)
    expect(authorizationUrl.origin).toBe('https://accounts.google.com')
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(tokenBody.get('code')).toBe('authorization-code')
    expect(tokenBody.get('code_verifier')).toBeTruthy()
  })
})
