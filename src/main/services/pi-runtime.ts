import { randomUUID } from 'node:crypto'
import type { AgentSessionUpdate, WorkAssistantImageAttachment } from '../../shared/contracts'
import { ProviderSettingsService, type RuntimeAgentEndpoint } from './provider-settings'
import { throwIfCancelled, timeoutSignal } from './cancellation'

export interface AgentRuntime {
  isConfigured(): boolean
  run(prompt: string, images?: WorkAssistantImageAttachment[], cancellationSignal?: AbortSignal): Promise<string>
  runStream(
    prompt: string,
    onUpdate: (update: AgentSessionUpdate) => void,
    images?: WorkAssistantImageAttachment[],
    cancellationSignal?: AbortSignal
  ): Promise<string>
}

const systemPrompt = `You are the user's cross-project decision assistant.
Reply in Chinese unless the user asks for another language.
Use Markdown and make every response easy to scan:
- Lead with the conclusion.
- For non-trivial questions, follow with concise evidence and concrete next steps.
- Use short headings or bullets only when they improve clarity; do not force a template onto simple answers.
- State unknowns and assumptions explicitly. Never invent project data or causes.
- Do not expose hidden chain-of-thought. Provide only useful conclusions and evidence.`

function isLoopbackEndpoint(baseUrl: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(baseUrl).hostname)
  } catch {
    return false
  }
}

function requestHeaders(apiKey: string | null): Record<string, string> {
  return apiKey
    ? { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' }
}

function ccSwitchHeaders(): Record<string, string> {
  return {
    Authorization: 'Bearer PROXY_MANAGED',
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': 'PROXY_MANAGED'
  }
}

async function providerError(response: Response, baseUrl: string): Promise<Error> {
  let detail = ''
  try {
    const body = await response.json() as { error?: { message?: string }; message?: string }
    detail = body.error?.message?.trim() || body.message?.trim() || ''
  } catch {
    // The status code is still enough for a useful, non-sensitive error.
  }
  if (response.status === 401 && isLoopbackEndpoint(baseUrl)) {
    return new Error('本地 CC Switch 尚未完成 Codex OAuth 认证，或认证已失效')
  }
  return new Error(`Agent Provider 请求失败（HTTP ${response.status}${detail ? `：${detail}` : ''}）`)
}

function responseText(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const value = body as {
    output_text?: unknown
    output?: Array<{ content?: Array<{ text?: unknown }> }>
  }
  if (typeof value.output_text === 'string' && value.output_text.trim()) {
    return value.output_text.trim()
  }
  const output = value.output
    ?.flatMap((item) => item.content ?? [])
    .map((item) => typeof item.text === 'string' ? item.text : '')
    .join('')
    .trim()
  return output || null
}

function chatCompletionText(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const value = body as {
    choices?: Array<{
      message?: {
        content?: string | Array<{ text?: string }>
      }
    }>
  }
  const content = value.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim() || null
  const output = content?.map((item) => item.text ?? '').join('').trim()
  return output || null
}

function anthropicMessageText(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const value = body as { content?: Array<{ type?: unknown; text?: unknown }> }
  const output = value.content
    ?.filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text as string)
    .join('')
    .trim()
  return output || null
}

async function consumeEventStream(
  response: Response,
  protocol: 'responses' | 'chat-completions' | 'anthropic-messages',
  onDelta: (delta: string) => void
): Promise<string> {
  if (!response.body) throw new Error('Agent Provider 没有返回响应流。')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let output = ''

  const processFrame = (frame: string): void => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim()
    if (!data || data === '[DONE]') return

    let event: Record<string, unknown>
    try {
      event = JSON.parse(data) as Record<string, unknown>
    } catch {
      return
    }
    const eventError = event.error as { message?: unknown } | undefined
    if (eventError) {
      throw new Error(typeof eventError.message === 'string' ? eventError.message : 'Agent Provider 流式请求失败。')
    }

    let delta = ''
    if (protocol === 'responses') {
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        delta = event.delta
      } else if (event.type === 'response.failed') {
        const failed = event.response as { error?: { message?: unknown } } | undefined
        throw new Error(typeof failed?.error?.message === 'string' ? failed.error.message : 'Agent Provider 流式请求失败。')
      } else if (event.type === 'response.completed' && !output) {
        delta = responseText(event.response) ?? ''
      }
    } else if (protocol === 'chat-completions') {
      const choice = (event.choices as Array<{
        delta?: { content?: string | Array<{ text?: string }> }
      }> | undefined)?.[0]
      const content = choice?.delta?.content
      delta = typeof content === 'string'
        ? content
        : content?.map((item) => item.text ?? '').join('') ?? ''
    } else if (event.type === 'content_block_delta') {
      const anthropicDelta = event.delta as { type?: unknown; text?: unknown } | undefined
      if (anthropicDelta?.type === 'text_delta' && typeof anthropicDelta.text === 'string') {
        delta = anthropicDelta.text
      }
    } else if (event.type === 'content_block_start') {
      const block = event.content_block as { type?: unknown; text?: unknown } | undefined
      if (block?.type === 'text' && typeof block.text === 'string') delta = block.text
    }

    if (delta) {
      output += delta
      onDelta(delta)
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    let boundary = buffer.search(/\r?\n\r?\n/)
    while (boundary >= 0) {
      const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? '\n\n'
      processFrame(buffer.slice(0, boundary))
      buffer = buffer.slice(boundary + separator.length)
      boundary = buffer.search(/\r?\n\r?\n/)
    }
    if (done) break
  }
  if (buffer.trim()) processFrame(buffer)
  if (!output.trim()) throw new Error('Agent Provider 没有返回文本内容。')
  return output.trim()
}

async function consumeResponse(
  response: Response,
  protocol: 'responses' | 'chat-completions' | 'anthropic-messages',
  onDelta: (delta: string) => void
): Promise<string> {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) {
    return consumeEventStream(response, protocol, onDelta)
  }
  const body = await response.json() as unknown
  const output = protocol === 'responses'
    ? responseText(body)
    : protocol === 'chat-completions'
      ? chatCompletionText(body)
      : anthropicMessageText(body)
  if (!output) throw new Error('Agent Provider 没有返回文本内容。')
  onDelta(output)
  return output
}

export class PiAgentRuntime implements AgentRuntime {
  constructor(private readonly providerSettings?: ProviderSettingsService) {}

  isConfigured(): boolean {
    const configured = this.providerSettings?.getAgentRuntimeSettings()
    if (!configured) return false
    return this.endpointIsConfigured(configured.primary) ||
      (configured.backupEnabled && this.endpointIsConfigured(configured.backup))
  }

  run(
    prompt: string,
    images: WorkAssistantImageAttachment[] = [],
    cancellationSignal?: AbortSignal
  ): Promise<string> {
    return this.runStream(prompt, () => undefined, images, cancellationSignal)
  }

  async runStream(
    prompt: string,
    onUpdate: (update: AgentSessionUpdate) => void,
    images: WorkAssistantImageAttachment[] = [],
    cancellationSignal?: AbortSignal
  ): Promise<string> {
    throwIfCancelled(cancellationSignal)
    const configured = this.providerSettings?.getAgentRuntimeSettings()
    if (!configured) throw new Error('尚未配置模型 Provider')

    const endpoints = configured.backupEnabled
      ? [configured.primary, configured.backup]
      : [configured.primary]
    const failures: string[] = []
    for (const [index, endpoint] of endpoints.entries()) {
      const messageId = randomUUID()
      try {
        return await this.runEndpoint(prompt, images, endpoint, (text) => {
          onUpdate({
            sessionUpdate: 'agent_message_chunk',
            messageId,
            content: { type: 'text', text }
          })
        }, cancellationSignal)
      } catch (error) {
        throwIfCancelled(cancellationSignal)
        const message = error instanceof Error ? error.message : '未知错误'
        failures.push(`${index === 0 ? 'Primary' : 'Backup'}: ${message}`)
      }
    }

    throw new Error(`所有模型 Provider 均不可用。${failures.join('；')}`)
  }

  private endpointIsConfigured(endpoint: RuntimeAgentEndpoint): boolean {
    return Boolean(endpoint.baseUrl && endpoint.model && (endpoint.apiKey || isLoopbackEndpoint(endpoint.baseUrl)))
  }

  private async runEndpoint(
    prompt: string,
    images: WorkAssistantImageAttachment[],
    endpoint: RuntimeAgentEndpoint,
    onDelta: (delta: string) => void,
    cancellationSignal?: AbortSignal
  ): Promise<string> {
    throwIfCancelled(cancellationSignal)
    if (!endpoint.apiKey && !isLoopbackEndpoint(endpoint.baseUrl)) {
      throw new Error('尚未配置 API Key')
    }
    return endpoint.mode === 'cc-switch-codex-oauth'
      ? this.runCcSwitchCodexOauth(prompt, images, endpoint, onDelta, cancellationSignal)
      : this.runOpenAiCompatible(prompt, images, endpoint, onDelta, cancellationSignal)
  }

  private async runCcSwitchCodexOauth(
    prompt: string,
    images: WorkAssistantImageAttachment[],
    config: { baseUrl: string; model: string },
    onDelta: (delta: string) => void,
    cancellationSignal?: AbortSignal
  ): Promise<string> {
    if (!isLoopbackEndpoint(config.baseUrl)) {
      throw new Error('CC Switch Codex OAuth 仅允许连接本机代理')
    }
    const response = await fetch(`${config.baseUrl}/messages`, {
      method: 'POST',
      headers: ccSwitchHeaders(),
      body: JSON.stringify({
        model: config.model,
        max_tokens: 4_096,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: images.length === 0
            ? prompt
            : [
                { type: 'text', text: prompt },
                ...images.map((image) => ({
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: image.mimeType,
                    data: image.dataUrl.slice(image.dataUrl.indexOf(',') + 1)
                  }
                }))
              ]
        }],
        stream: true
      }),
      signal: timeoutSignal(60_000, cancellationSignal)
    })
    if (!response.ok) throw await providerError(response, config.baseUrl)
    return consumeResponse(response, 'anthropic-messages', onDelta)
  }

  private async runOpenAiCompatible(
    prompt: string,
    images: WorkAssistantImageAttachment[],
    config: { baseUrl: string; model: string; apiKey: string | null },
    onDelta: (delta: string) => void,
    cancellationSignal?: AbortSignal
  ): Promise<string> {
    const responses = await fetch(`${config.baseUrl}/responses`, {
      method: 'POST',
      headers: requestHeaders(config.apiKey),
      body: JSON.stringify({
        model: config.model,
        instructions: systemPrompt,
        input: images.length === 0
          ? prompt
          : [{
              role: 'user',
              content: [
                { type: 'input_text', text: prompt },
                ...images.map((image) => ({
                  type: 'input_image',
                  image_url: image.dataUrl,
                  detail: 'auto'
                }))
              ]
            }],
        store: false,
        stream: true
      }),
      signal: timeoutSignal(60_000, cancellationSignal)
    })

    if (responses.ok) return consumeResponse(responses, 'responses', onDelta)
    const canTryChatCompletions = [404, 405, 501].includes(responses.status) ||
      (images.length > 0 && [400, 415, 422].includes(responses.status))
    if (!canTryChatCompletions) {
      throw await providerError(responses, config.baseUrl)
    }

    const chat = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: requestHeaders(config.apiKey),
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: images.length === 0
              ? prompt
              : [
                  { type: 'text', text: prompt },
                  ...images.map((image) => ({
                    type: 'image_url',
                    image_url: { url: image.dataUrl, detail: 'auto' }
                  }))
                ]
          }
        ],
        stream: true
      }),
      signal: timeoutSignal(60_000, cancellationSignal)
    })
    if (!chat.ok) throw await providerError(chat, config.baseUrl)
    return consumeResponse(chat, 'chat-completions', onDelta)
  }
}
