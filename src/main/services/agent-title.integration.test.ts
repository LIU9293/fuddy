import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chatTitleModel, chatTitleMessages, parseChatTitleModelResult } from '../../shared/agent-run-title'

const enabled = process.env.RUN_CLOUDFLARE_TITLE_SMOKE === '1'
const samples = [
  { language: 'zh', prompt: '帮我移除创建 Chat 时的标题输入，改为首条消息自动生成标题。', script: /\p{Script=Han}/u },
  { language: 'en', prompt: 'Fix the login redirect loop after the session expires.', script: /^[\x20-\x7e]+$/u },
  { language: 'ja', prompt: 'ログイン後に画面が真っ白になる問題を修正してください。', script: /[\p{Script=Hiragana}\p{Script=Katakana}]/u },
  { language: 'es', prompt: 'Quiero simplificar la creación de chats y generar el título automáticamente.', script: /título|creación|generación/iu },
  { language: 'ar', prompt: 'أريد إصلاح مشكلة تسجيل الدخول في التطبيق.', script: /\p{Script=Arabic}/u },
  { language: 'mixed', prompt: '帮我修复 React 页面中的 session timeout 问题。', script: /\p{Script=Han}/u },
  { language: 'ko', prompt: '앱에서 로그인 오류를 수정해주세요.', script: /\p{Script=Hangul}/u },
  { language: 'fr', prompt: 'Corrige le problème de connexion après expiration de la session.', script: /connexion|session/iu },
  { language: 'de', prompt: 'Behebe die Anmeldeschleife nach Ablauf der Sitzung.', script: /Anmelde|Sitzung/iu },
  { language: 'ru', prompt: 'Исправь ошибку входа после истечения сессии.', script: /\p{Script=Cyrillic}/u }
]

describe.skipIf(!enabled)('Cloudflare multilingual Chat titles (live, opt-in)', () => {
  let token: string
  async function authorization(): Promise<string> {
    if (token) return token
    if (process.env.CLOUDFLARE_API_TOKEN) return token = process.env.CLOUDFLARE_API_TOKEN
    // Capture credentials in memory only; never print command output or errors.
    try {
      const result = await promisify(execFile)('node', ['node_modules/wrangler/bin/wrangler.js', 'auth', 'token', '--json'], {
        cwd: resolve('cloud/account-api'), timeout: 15_000
      })
      token = (JSON.parse(result.stdout) as { token: string }).token
      if (!token) throw new Error()
      return token
    } catch { throw new Error('Cloudflare smoke test requires an authenticated Wrangler or CLOUDFLARE_API_TOKEN') }
  }

  for (const model of (process.env.FUDDY_TITLE_SMOKE_COMPARE === '1'
    ? [chatTitleModel, '@cf/meta/llama-3.2-1b-instruct', '@cf/ibm-granite/granite-4.0-h-micro'] : [chatTitleModel])) {
    for (const sample of samples) {
      it(`${model}: ${sample.language}`, async () => {
        const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
        if (!accountId) throw new Error('Set CLOUDFLARE_ACCOUNT_ID for the opt-in smoke test')
        const started = Date.now()
        const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
          method: 'POST', headers: { authorization: `Bearer ${await authorization()}`, 'content-type': 'application/json' },
          body: JSON.stringify({ messages: chatTitleMessages(sample.prompt), max_tokens: 64, temperature: 0.1 }),
          signal: AbortSignal.timeout(25_000)
        })
        expect(response.status).toBe(200)
        const payload = await response.json() as { success: boolean; result: { response: unknown; usage?: unknown } }
        expect(payload.success).toBe(true)
        const title = parseChatTitleModelResult(payload.result)
        const report = { model, language: sample.language, prompt: sample.prompt, title,
          elapsedMs: Date.now() - started, usage: payload.result.usage }
        const directory = process.env.FUDDY_TITLE_SMOKE_REPORT_DIR
        if (directory) {
          mkdirSync(directory, { recursive: true })
          writeFileSync(join(directory, `${model.split('/').at(-1)}-${sample.language}.json`), JSON.stringify(report, null, 2))
        }
        console.info(JSON.stringify(report))
        expect(title).not.toBeNull()
        expect(title).toMatch(sample.script)
      }, 30_000)
    }
  }
})
