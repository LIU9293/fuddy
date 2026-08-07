import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CliAgentRuntime, type CliAgentTurnInput } from './cli-agent-runtime'

const enabled = process.env.RUN_CODING_CLI_SMOKE === '1'
const integration = enabled ? describe : describe.skip

integration('coding CLI end-to-end smoke', () => {
  const runtime = new CliAgentRuntime({ getLaunchConfigs: async () => [] })

  function input(
    provider: 'codex' | 'claude',
    marker: string,
    onApproval: CliAgentTurnInput['onApproval'] = async () => 'deny'
  ): CliAgentTurnInput {
    const directory = mkdtempSync(join(tmpdir(), `project-agent-${provider}-`))
    return {
      projectId: 'test-project',
      provider,
      prompt: `Reply with exactly ${marker}. Do not call tools.`,
      sessionId: null,
      workingDirectory: directory,
      workspaceRoots: [directory],
      filesDirectory: directory,
      abortController: new AbortController(),
      onUpdate: () => undefined,
      onSessionId: () => undefined,
      onTool: () => undefined,
      onApproval
    }
  }

  it('runs Codex through app-server and receives a resumable thread id', async () => {
    const result = await runtime.runTurn(input('codex', 'PROJECT_AGENT_CODEX_OK'))
    expect(result.text).toContain('PROJECT_AGENT_CODEX_OK')
    expect(result.sessionId).toBeTruthy()
  }, 180_000)

  it('runs Claude through the Agent SDK and receives a resumable session id', async () => {
    const result = await runtime.runTurn(input('claude', 'PROJECT_AGENT_CLAUDE_OK'))
    expect(result.text).toContain('PROJECT_AGENT_CLAUDE_OK')
    expect(result.sessionId).toBeTruthy()
  }, 180_000)

  it('runs Codex tools with full access without a host approval callback', async () => {
    let approvals = 0
    const turn = input('codex', 'unused', async () => { approvals += 1; return 'deny' })
    const marker = join(turn.workingDirectory, 'codex-full-access-ok')
    turn.prompt = `Use a shell command to create the empty file ${marker}, then reply CODEX_FULL_ACCESS_OK.`
    const result = await runtime.runTurn(turn)
    expect(approvals).toBe(0)
    expect(existsSync(marker)).toBe(true)
    expect(result.text).toContain('CODEX_FULL_ACCESS_OK')
  }, 180_000)

  it('runs Claude tools with bypassPermissions without a host approval callback', async () => {
    let approvals = 0
    const turn = input('claude', 'unused', async () => { approvals += 1; return 'deny' })
    const marker = join(turn.workingDirectory, 'claude-full-access-ok')
    turn.prompt = `Use Bash to create the empty file ${marker}, then reply CLAUDE_FULL_ACCESS_OK.`
    const result = await runtime.runTurn(turn)
    expect(approvals).toBe(0)
    expect(existsSync(marker)).toBe(true)
    expect(result.text).toContain('CLAUDE_FULL_ACCESS_OK')
  }, 180_000)
})
