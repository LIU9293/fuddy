import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url')
}

export async function getGoogleIdToken(input: {
  clientId: string
  openExternal: (url: string) => Promise<unknown>
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}): Promise<string> {
  const verifier = base64Url(randomBytes(48))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  const state = base64Url(randomBytes(24))
  const fetchImpl = input.fetch ?? globalThis.fetch

  const callback = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    let settled = false
    const server = createServer((request, response) => {
      const address = server.address() as AddressInfo | null
      const redirectUri = address ? `http://127.0.0.1:${address.port}/oauth/google/callback` : ''
      const url = new URL(request.url ?? '/', redirectUri || 'http://127.0.0.1')
      if (url.pathname !== '/oauth/google/callback') {
        response.writeHead(404).end()
        return
      }
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      if (error || !code || url.searchParams.get('state') !== state) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('Fuddy 登录没有完成，可以关闭这个页面并返回应用重试。')
        if (!settled) {
          settled = true
          reject(new Error(error === 'access_denied' ? '你取消了 Google 登录。' : 'Google 登录回调无效，请重试。'))
        }
        server.close()
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Fuddy 登录已完成，可以关闭这个页面并返回应用。')
      if (!settled) {
        settled = true
        resolve({ code, redirectUri })
      }
      server.close()
    })
    server.on('error', (error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      const redirectUri = `http://127.0.0.1:${address.port}/oauth/google/callback`
      const authorizationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      authorizationUrl.search = new URLSearchParams({
        client_id: input.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        prompt: 'select_account'
      }).toString()
      void input.openExternal(authorizationUrl.toString()).catch((error) => {
        if (!settled) {
          settled = true
          reject(error)
        }
        server.close()
      })
    })
    setTimeout(() => {
      if (settled) return
      settled = true
      server.close()
      reject(new Error('Google 登录等待超时，请重试。'))
    }, input.timeoutMs ?? 120_000).unref()
  })

  const tokenResponse = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: input.clientId,
      code: callback.code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: callback.redirectUri
    })
  })
  if (!tokenResponse.ok) throw new Error('Google 登录凭证交换失败，请重试。')
  const tokenPayload = await tokenResponse.json() as { id_token?: unknown }
  if (typeof tokenPayload.id_token !== 'string') throw new Error('Google 没有返回可验证的登录凭证。')
  return tokenPayload.id_token
}
