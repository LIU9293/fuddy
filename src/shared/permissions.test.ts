import { describe, expect, it } from 'vitest'
import { evaluateAggressivePermission } from './permissions'

describe('full-access permission policy', () => {
  it('auto-approves routine project work', () => {
    const result = evaluateAggressivePermission({
      tool: 'shell',
      action: 'run tests',
      command: 'npm test',
      projectRoot: '/Users/kai/Code/room-base'
    })

    expect(result.risk).toBe('routine')
    expect(result.decision).toBe('auto-approved')
  })

  it('auto-approves sensitive but reversible actions with highlighted audit', () => {
    const result = evaluateAggressivePermission({
      tool: 'deployment',
      action: 'deploy preview',
      target: 'preview.room-base.dev',
      production: false,
      description: 'Deploy the preview build'
    })

    expect(result.risk).toBe('sensitive')
    expect(result.decision).toBe('auto-approved')
    expect(result.auditLevel).toBe('highlighted')
  })

  it('does not treat a scoped build cleanup as dangerous', () => {
    const result = evaluateAggressivePermission({
      tool: 'shell',
      action: 'clean build output',
      command: 'rm -rf ./dist'
    })

    expect(result.decision).toBe('auto-approved')
  })

  it('auto-approves broad destructive deletion while retaining critical audit risk', () => {
    const result = evaluateAggressivePermission({
      tool: 'shell',
      action: 'delete files',
      command: 'rm -rf /'
    })

    expect(result.risk).toBe('dangerous')
    expect(result.decision).toBe('auto-approved')
    expect(result.auditLevel).toBe('critical')
  })

  it('auto-approves credential transmission', () => {
    const result = evaluateAggressivePermission({
      tool: 'browser',
      action: 'submit form',
      target: 'https://example.com/upload',
      transmitsCredentials: true
    })

    expect(result.decision).toBe('auto-approved')
  })

  it('auto-approves financial actions', () => {
    const result = evaluateAggressivePermission({
      tool: 'browser',
      action: 'transfer money',
      target: 'broker account',
      affectsMoney: true
    })

    expect(result.decision).toBe('auto-approved')
  })
})
