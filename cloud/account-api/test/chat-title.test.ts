import { env, SELF } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { generateChatTitle } from '../src/chat-title'
import type { Environment } from '../src/types'
import { hmac } from '../src/crypto'
import { chatTitleInputLimit, chatTitleModel } from '../../../src/shared/agent-run-title'

afterEach(() => vi.useRealTimers())

async function signIn(): Promise<{ token: string; userId: string }> {
  const start = await SELF.fetch('https://account.test/v1/auth/email/start', {
    method: 'POST', body: JSON.stringify({ email: 'titles@example.com' })
  })
  const challenge = await start.json<{ challengeId: string; debugCode: string }>()
  const verify = await SELF.fetch('https://account.test/v1/auth/email/verify', {
    method: 'POST', body: JSON.stringify({ challengeId: challenge.challengeId, code: challenge.debugCode,
      device: { platform: 'macos', name: 'Test Mac', publicKey: 'test-public-key-material', appVersion: '0.0.7', protocolVersion: 1 } })
  })
  const payload = await verify.json<{ session: { accessToken: string }; user: { id: string } }>()
  expect(verify.status).toBe(200)
  return { token: payload.session.accessToken, userId: payload.user.id }
}

function request(body: unknown, token?: string): Request {
  return new Request('https://account.test/api/account/v1/chat-titles', {
    method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body)
  })
}

describe('authenticated Cloudflare Chat titles', () => {
  it('requires a valid account and accepts only bounded prompt input', async () => {
    const run = vi.fn(async () => ({ response: 'Fix login redirects' }))
    const testEnv = { ...env, AI: { run } } as unknown as Environment
    expect((await worker.fetch(request({ prompt: 'Fix login' }), testEnv)).status).toBe(401)
    const { token } = await signIn()
    for (const body of [{ prompt: '' }, { prompt: 'x'.repeat(chatTitleInputLimit + 1) }, { prompt: 'Fix login', model: 'other' }]) {
      expect((await worker.fetch(request(body, token), testEnv)).status).toBe(400)
    }
    expect(run).not.toHaveBeenCalled()
  })

  it('returns a title through the AI binding without exposing model metadata or credentials', async () => {
    const { token } = await signIn()
    const run = vi.fn(async () => ({ choices: [{ message: { content: 'Fix login redirects', reasoning_content: 'unused' } }], usage: { total_tokens: 100 } }))
    const response = await worker.fetch(request({ prompt: 'Fix the login redirect loop' }, token),
      { ...env, AI: { run } } as unknown as Environment)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ title: 'Fix login redirects' })
    expect(run).toHaveBeenCalledWith(chatTitleModel, expect.objectContaining({
      max_tokens: 64, temperature: 0.1, messages: expect.arrayContaining([{ role: 'user', content: 'Fix the login redirect loop' }])
    }))
  })

  it.each(['missing', 'failure', 'invalid'])('returns a quiet unavailable response for %s inference', async scenario => {
    const { token } = await signIn()
    const run = vi.fn(async () => {
      if (scenario === 'failure') throw new Error('sensitive upstream prompt')
      return { response: 'Explanation\nTitle' }
    })
    const response = await worker.fetch(request({ prompt: 'Fix login' }, token),
      { ...env, AI: scenario === 'missing' ? undefined : { run } } as unknown as Environment)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'title_unavailable', message: '标题生成暂时不可用。' } })
  })

  it('rate limits model calls per authenticated account using an atomic counter', async () => {
    const { token, userId } = await signIn()
    const now = new Date()
    const window = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000).toISOString()
    await env.ACCOUNT_DB.prepare('INSERT INTO auth_rate_limits (key_hash, window_start, count, updated_at) VALUES (?, ?, 60, ?)')
      .bind(await hmac(`chat-title:${userId}`, env.OTP_PEPPER), window, now.toISOString()).run()
    const run = vi.fn()
    expect((await worker.fetch(request({ prompt: 'Fix login' }, token),
      { ...env, AI: { run } } as unknown as Environment)).status).toBe(429)
    expect(run).not.toHaveBeenCalled()
  })

  it('bounds inference time when the upstream does not respond', async () => {
    vi.useFakeTimers()
    const promise = generateChatTitle({ run: vi.fn(() => new Promise(() => undefined)) } as unknown as Pick<Ai, 'run'>, 'Fix login')
    const rejected = expect(promise).rejects.toThrow('title_timeout')
    await vi.advanceTimersByTimeAsync(10_000)
    await rejected
  })
})
