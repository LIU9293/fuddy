import { describe, expect, it } from 'vitest'
import { agentToolGroupSummary, agentToolKind, agentToolPresentation } from './agent-activity'

describe('agent activity presentation', () => {
  it('normalizes provider-specific tool names into stable product categories', () => {
    expect(agentToolKind('Read')).toBe('read')
    expect(agentToolKind('command')).toBe('command')
    expect(agentToolKind('apply_patch')).toBe('edit')
    expect(agentToolKind('mcp__browser_use__navigate')).toBe('browser')
  })

  it('summarizes Claude Code inputs without showing file contents', () => {
    expect(agentToolPresentation('Read', JSON.stringify({ file_path: '/repo/src/main.ts', limit: 40 })))
      .toEqual({ kind: 'read', label: '读取文件', summary: 'main.ts' })
  })

  it('summarizes OpenCode state records from their nested input', () => {
    expect(agentToolPresentation('read', JSON.stringify({
      status: 'completed',
      input: { filePath: '/repo/package.json' },
      output: 'very long file contents'
    }))).toEqual({ kind: 'read', label: '读取文件', summary: 'package.json' })
  })

  it('summarizes Codex command metadata and groups mixed operations', () => {
    const command = agentToolPresentation('command', 'npm test\n208 tests passed', { command: 'npm test' })
    expect(command).toEqual({ kind: 'command', label: '运行命令', summary: 'npm test' })
    expect(agentToolGroupSummary([
      agentToolPresentation('Read', '{"file_path":"/repo/AGENTS.md"}'),
      agentToolPresentation('Read', '{"file_path":"/repo/package.json"}'),
      command
    ])).toBe('读取 2 次 · 运行 1 次')
  })

  it('supports legacy tool metadata with arguments', () => {
    expect(agentToolPresentation('Bash', 'raw output', {
      arguments: { command: 'npm test' }
    })).toEqual({ kind: 'command', label: '运行命令', summary: 'npm test' })
  })
})
