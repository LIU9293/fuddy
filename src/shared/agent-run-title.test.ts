import { describe, expect, it } from 'vitest'
import { firstMessageTitle, parseChatTitleModelResult, parseGeneratedChatTitle } from './agent-run-title'

describe('Chat title validation', () => {
  it('uses the first nonempty line as a concise Unicode-safe fallback', () => {
    expect(firstMessageTitle('\n检查  配置\n运行测试')).toBe('检查 配置')
    expect(firstMessageTitle('😀'.repeat(49))).toBe('😀'.repeat(48) + '…')
    expect(firstMessageTitle('Short English request')).toBe('Short English request')
  })
  it.each(['Fix login redirects', '修复登录失败', 'ログイン後の白い画面', 'إصلاح تسجيل الدخول'])('keeps the generated language: %s', title => {
    expect(parseGeneratedChatTitle(`  "${title}"  `)).toBe(title)
  })
  it.each([null, {}, '', 'Explanation\nTitle', '```Title```', '<think>private</think>', 'x'.repeat(81)])('rejects invalid output %j', value => {
    expect(parseGeneratedChatTitle(value)).toBeNull()
  })
  it('supports both actual Cloudflare response shapes and only reads visible content', () => {
    expect(parseChatTitleModelResult({ response: 'Fix login' })).toBe('Fix login')
    expect(parseChatTitleModelResult({ choices: [{ message: { content: 'Fix login', reasoning_content: 'unused' } }] })).toBe('Fix login')
    expect(parseChatTitleModelResult({ choices: [{ message: { reasoning_content: 'unused' } }] })).toBeNull()
  })
})
