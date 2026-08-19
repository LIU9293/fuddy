import { describe, expect, it } from 'vitest'
import { userFacingErrorMessage } from './user-facing-error'

describe('userFacingErrorMessage', () => {
  it('removes Electron IPC implementation details', () => {
    expect(userFacingErrorMessage(
      new Error("Error invoking remote method 'account:list-identities': Error: 暂时无法登录，请检查网络后重试。"),
      '读取失败。'
    )).toBe('暂时无法登录，请检查网络后重试。')
  })

  it('uses the fallback when there is no useful Error message', () => {
    expect(userFacingErrorMessage('network failed', '读取失败。')).toBe('读取失败。')
    expect(userFacingErrorMessage(new Error(''), '读取失败。')).toBe('读取失败。')
  })
})
