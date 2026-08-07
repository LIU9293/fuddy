import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkAssistantImageAttachment } from '../../shared/contracts'
import type { ProviderSettingsService, RuntimeAgentSettings } from './provider-settings'
import { PiAgentRuntime } from './pi-runtime'

function settings(value: RuntimeAgentSettings): ProviderSettingsService {
  return {
    getAgentRuntimeSettings: () => value
  } as ProviderSettingsService
}

const disabledBackup = {
  mode: 'openai-compatible' as const,
  baseUrl: 'https://backup.example.com/v1',
  model: 'gpt-test',
  apiKey: null
}

const imageAttachment: WorkAssistantImageAttachment = {
  id: 'image-1',
  name: 'screen.png',
  mimeType: 'image/png',
  dataUrl: 'data:image/png;base64,aW1hZ2U='
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PiAgentRuntime transports', () => {
  it('emits ACP-style chunks from the CC Switch Codex OAuth stream', async () => {
    const stream = [
      'event: message_start',
      'data: {"type":"message_start","message":{"model":"gpt-5.6-sol"}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"**结论**："}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"先做增长实验。"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      ''
    ].join('\n')
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const runtime = new PiAgentRuntime(settings({
      primary: {
        mode: 'cc-switch-codex-oauth',
        baseUrl: 'http://127.0.0.1:15721/v1',
        model: 'gpt-5.6-sol',
        apiKey: null
      },
      backup: disabledBackup,
      backupEnabled: false
    }))
    const updates: Array<{ messageId: string; text: string }> = []

    const output = await runtime.runStream('测试', (update) => {
      if (update.sessionUpdate === 'agent_message_chunk') {
        updates.push({ messageId: update.messageId, text: update.content.text })
      }
    })

    expect(output).toBe('**结论**：先做增长实验。')
    expect(updates.map((update) => update.text)).toEqual(['**结论**：', '先做增长实验。'])
    expect(new Set(updates.map((update) => update.messageId)).size).toBe(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:15721/v1/messages')
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer PROXY_MANAGED',
      'x-api-key': 'PROXY_MANAGED'
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'gpt-5.6-sol',
      stream: true,
      messages: [{ role: 'user', content: '测试' }]
    })
  })

  it('sends image attachments as Anthropic image blocks through CC Switch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'CC Switch 图片分析结果' }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const runtime = new PiAgentRuntime(settings({
      primary: {
        mode: 'cc-switch-codex-oauth',
        baseUrl: 'http://127.0.0.1:15721/v1',
        model: 'gpt-5.6-sol',
        apiKey: null
      },
      backup: disabledBackup,
      backupEnabled: false
    }))

    await expect(runtime.run('分析这张图', [imageAttachment])).resolves.toBe('CC Switch 图片分析结果')
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: '分析这张图' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' }
        }
      ]
    }])
  })

  it('uses the Responses API for a keyless loopback proxy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output: [{ content: [{ type: 'output_text', text: '真实模型回答' }] }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const runtime = new PiAgentRuntime(settings({
      primary: {
        mode: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:18080/v1',
        model: 'gpt-5.6-sol',
        apiKey: null
      },
      backup: disabledBackup,
      backupEnabled: false
    }))

    expect(runtime.isConfigured()).toBe(true)
    await expect(runtime.run('测试')).resolves.toBe('真实模型回答')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:18080/v1/responses')
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Authorization')
  })

  it('sends image attachments as Responses API input_image content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output_text: '图片分析结果'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const runtime = new PiAgentRuntime(settings({
      primary: {
        mode: 'openai-compatible',
        baseUrl: 'https://provider.example.com/v1',
        model: 'gpt-5.6-sol',
        apiKey: 'test-key'
      },
      backup: disabledBackup,
      backupEnabled: false
    }))

    await expect(runtime.run('分析这张图', [imageAttachment])).resolves.toBe('图片分析结果')
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.input).toEqual([{
      role: 'user',
      content: [
        { type: 'input_text', text: '分析这张图' },
        { type: 'input_image', image_url: imageAttachment.dataUrl, detail: 'auto' }
      ]
    }])
  })

  it('converts image attachments for Chat Completions fallback', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '兼容视觉回答' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const runtime = new PiAgentRuntime(settings({
      primary: {
        mode: 'openai-compatible',
        baseUrl: 'https://provider.example.com/v1',
        model: 'gpt-test',
        apiKey: 'test-key'
      },
      backup: disabledBackup,
      backupEnabled: false
    }))

    await expect(runtime.run('分析这张图', [imageAttachment])).resolves.toBe('兼容视觉回答')
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
    expect(body.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '分析这张图' },
        { type: 'image_url', image_url: { url: imageAttachment.dataUrl, detail: 'auto' } }
      ]
    })
  })

  it('falls back to chat completions when Responses is unsupported', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '兼容接口回答' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const runtime = new PiAgentRuntime(settings({
      primary: {
        mode: 'openai-compatible',
        baseUrl: 'https://provider.example.com/v1',
        model: 'gpt-test',
        apiKey: 'test-key'
      },
      backup: disabledBackup,
      backupEnabled: false
    }))

    await expect(runtime.run('测试')).resolves.toBe('兼容接口回答')
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://provider.example.com/v1/responses',
      'https://provider.example.com/v1/chat/completions'
    ])
  })

  it('tries the backup provider after a primary failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'unauthorized' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ output_text: '备用模型回答' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }))
    vi.stubGlobal('fetch', fetchMock)
    const runtime = new PiAgentRuntime(settings({
      primary: {
        mode: 'cc-switch-codex-oauth',
        baseUrl: 'http://127.0.0.1:15721/v1',
        model: 'gpt-5.6-sol',
        apiKey: null
      },
      backup: {
        mode: 'openai-compatible',
        baseUrl: 'https://backup.example.com/v1',
        model: 'gpt-5.6-sol',
        apiKey: 'backup-key'
      },
      backupEnabled: true
    }))

    await expect(runtime.run('测试')).resolves.toBe('备用模型回答')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
