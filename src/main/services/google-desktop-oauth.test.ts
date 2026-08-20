import { describe, expect, it } from 'vitest'
import { getGoogleAuthorizationCode } from './google-desktop-oauth'

describe('getGoogleAuthorizationCode', () => {
  it('uses a loopback callback, state, and PKCE before returning the code exchange input', async () => {
    let authorizationUrlValue = ''
    let announcedAuthorizationUrl = ''
    let callbackPagePromise: Promise<Response> | undefined
    const authorization = await getGoogleAuthorizationCode({
      clientId: 'desktop-client-id',
      timeoutMs: 2_000,
      onAuthorizationUrl: (value) => { announcedAuthorizationUrl = value },
      openExternal: async (value) => {
        authorizationUrlValue = value
        const authorizationUrl = new URL(value)
        const redirectUri = authorizationUrl.searchParams.get('redirect_uri')!
        const state = authorizationUrl.searchParams.get('state')!
        queueMicrotask(() => {
          callbackPagePromise = fetch(`${redirectUri}?code=authorization-code&state=${encodeURIComponent(state)}`)
        })
      }
    })

    const authorizationUrl = new URL(authorizationUrlValue)
    expect(authorizationUrl.origin).toBe('https://accounts.google.com')
    expect(announcedAuthorizationUrl).toBe(authorizationUrlValue)
    expect(new URL(authorizationUrl.searchParams.get('redirect_uri')!).pathname).toBe('/')
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization).toEqual({
      authorizationCode: 'authorization-code',
      clientId: 'desktop-client-id',
      codeVerifier: expect.any(String),
      redirectUri: authorizationUrl.searchParams.get('redirect_uri')
    })
    expect(authorization.codeVerifier.length).toBeGreaterThanOrEqual(43)
    const callbackResponse = await callbackPagePromise
    const callbackHtml = await callbackResponse?.text()
    expect(callbackResponse?.headers.get('content-type')).toContain('text/html')
    expect(callbackHtml).toContain('aria-label="Fuddy"')
    expect(callbackHtml).toContain('已收到 Google 授权')
    expect(callbackHtml).toContain('关闭页面')
    expect(callbackHtml).toContain('place-items: center')
  })
})
