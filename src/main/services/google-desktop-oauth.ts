import { createHash, randomBytes } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url')
}

type CallbackPageStatus = 'authorized' | 'error'

function callbackPage(status: CallbackPageStatus): string {
  const authorized = status === 'authorized'
  const title = authorized ? '已收到 Google 授权' : '登录未完成'
  const message = authorized
    ? '请返回 Fuddy，应用正在完成登录。'
    : '请返回 Fuddy 后重新发起登录。'

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title} · Fuddy</title>
    <style>
      :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-width: 320px; background: #f5f5f3; color: #171717; }
      main { min-height: 100vh; display: grid; place-items: center; padding: 32px 20px; }
      section { width: min(100%, 420px); display: flex; flex-direction: column; align-items: center; text-align: center; }
      .logo { display: block; width: 132px; height: auto; margin-bottom: 42px; color: currentColor; }
      h1 { margin: 0; font-size: 24px; line-height: 1.25; letter-spacing: -0.02em; font-weight: 650; }
      p { margin: 12px 0 28px; color: #696966; font-size: 15px; line-height: 1.6; }
      button { min-width: 148px; height: 44px; border: 0; border-radius: 12px; padding: 0 24px; background: #181817; color: #fff; font: inherit; font-weight: 600; cursor: pointer; box-shadow: 0 1px 2px rgb(0 0 0 / 12%); }
      button:hover { background: #30302e; }
      button:focus-visible { outline: 3px solid rgb(47 128 237 / 35%); outline-offset: 3px; }
      @media (prefers-color-scheme: dark) {
        body { background: #191918; color: #f5f5f2; }
        p { color: #aaa9a4; }
        button { background: #f3f3ef; color: #171717; }
        button:hover { background: #fff; }
      }
    </style>
  </head>
  <body>
    <main>
      <section aria-labelledby="status-title">
        <svg class="logo" viewBox="0 0 160 48" role="img" aria-label="Fuddy">
          <text x="80" y="37" text-anchor="middle" fill="currentColor" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif" font-size="42" font-weight="760" letter-spacing="-2.4">Fuddy</text>
        </svg>
        <h1 id="status-title">${title}</h1>
        <p>${message}</p>
        <button type="button" onclick="window.close()">关闭页面</button>
      </section>
    </main>
  </body>
</html>`
}

function respondWithCallbackPage(response: ServerResponse, status: CallbackPageStatus): void {
  response.writeHead(status === 'authorized' ? 200 : 400, {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'content-type': 'text/html; charset=utf-8',
    'x-content-type-options': 'nosniff'
  })
  response.end(callbackPage(status))
}

export interface GoogleAuthorizationCode {
  authorizationCode: string
  clientId: string
  codeVerifier: string
  redirectUri: string
}

export async function getGoogleAuthorizationCode(input: {
  clientId: string
  openExternal: (url: string) => Promise<unknown>
  onAuthorizationUrl?: (url: string) => void
  timeoutMs?: number
}): Promise<GoogleAuthorizationCode> {
  const verifier = base64Url(randomBytes(48))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  const state = base64Url(randomBytes(24))

  const callback = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    let settled = false
    const server = createServer((request, response) => {
      const address = server.address() as AddressInfo | null
      const redirectUri = address ? `http://127.0.0.1:${address.port}` : ''
      const url = new URL(request.url ?? '/', redirectUri || 'http://127.0.0.1')
      if (url.pathname !== '/') {
        response.writeHead(404).end()
        return
      }
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      if (error || !code || url.searchParams.get('state') !== state) {
        respondWithCallbackPage(response, 'error')
        if (!settled) {
          settled = true
          reject(new Error(error === 'access_denied' ? '你取消了 Google 登录。' : 'Google 登录回调无效，请重试。'))
        }
        server.close()
        return
      }
      respondWithCallbackPage(response, 'authorized')
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
      const redirectUri = `http://127.0.0.1:${address.port}`
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
      const authorizationUrlValue = authorizationUrl.toString()
      input.onAuthorizationUrl?.(authorizationUrlValue)
      void input.openExternal(authorizationUrlValue).catch((error) => {
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

  return {
    authorizationCode: callback.code,
    clientId: input.clientId,
    codeVerifier: verifier,
    redirectUri: callback.redirectUri
  }
}
