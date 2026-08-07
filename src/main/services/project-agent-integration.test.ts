import { describe, expect, it, vi } from 'vitest'
import type { CredentialVault } from './credential-vault'
import type { AppDatabase } from './database'
import { ProjectAgentIntegrationService } from './project-agent-integration'

describe('ProjectAgentIntegrationService', () => {
  it('uses the existing AI Marketing thread and SSE chat APIs', async () => {
    const database = {
      listConnectors: () => [{
        projectId: 'ai-marketing', kind: 'project-agent', credentialRef: 'session',
        config: { baseUrl: 'https://marketing.example.com/' }
      }]
    } as unknown as AppDatabase
    const credentials = { get: () => 'session-token' } as unknown as CredentialVault
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'thread-1' }), { status: 201 }))
      .mockResolvedValueOnce(new Response([
        'event: text_delta', 'data: {"type":"text_delta","delta":"处理中"}', '',
        'event: complete', 'data: {"type":"complete","reply":{"thread":{"messages":[{"role":"assistant","content":"本周先完成首轮素材验收。"}]}}}', '', ''
      ].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    const service = new ProjectAgentIntegrationService(database, credentials, vi.fn(), fetchImpl as typeof fetch)
    const result = await service.dispatch({ requestId: 'request-1', projectId: 'ai-marketing', prompt: '检查试点状态' })
    expect(result).toEqual(expect.objectContaining({
      mode: 'http-super-agent', externalThreadId: 'thread-1', message: '本周先完成首轮素材验收。'
    }))
    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'https://marketing.example.com/api/super-agent/threads', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer session-token' })
    }))
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://marketing.example.com/api/super-agent/chat', expect.objectContaining({
      body: expect.stringContaining('"threadId":"thread-1"')
    }))
  })
})
