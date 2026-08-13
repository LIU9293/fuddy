import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentRunStreamUpdate,
  DispatchProjectAgentInput,
  DispatchProjectAgentResult,
  DispatchTaskInput,
  DispatchTaskResult
} from '../../shared/contracts'
import { getProjectAnalyticsProfile } from '../analytics/project-analytics-profiles'
import { CredentialVault } from './credential-vault'
import { AppDatabase } from './database'

type FetchLike = typeof fetch
type DispatchLike = (
  input: DispatchTaskInput,
  onUpdate?: (update: AgentRunStreamUpdate) => void
) => Promise<DispatchTaskResult>

interface ExternalAgentConfig {
  baseUrl: string
  credentialRef: string | null
}

function parseSseComplete(body: string): Record<string, unknown> {
  for (const block of body.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = block.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data) continue
    const event = JSON.parse(data) as Record<string, unknown>
    if (event.type === 'error') throw new Error(String(event.error ?? 'Super Agent 执行失败。'))
    if (event.type === 'complete' && event.reply && typeof event.reply === 'object') {
      return event.reply as Record<string, unknown>
    }
  }
  throw new Error('Super Agent SSE 响应未包含 complete 事件。')
}

function responseMessage(reply: Record<string, unknown>): string {
  const thread = reply.thread
  if (!thread || typeof thread !== 'object') return 'Super Agent 已完成。'
  const messages = (thread as Record<string, unknown>).messages
  if (!Array.isArray(messages)) return 'Super Agent 已完成。'
  const lastAssistant = [...messages].reverse().find((message) =>
    message && typeof message === 'object' && (message as Record<string, unknown>).role === 'assistant'
  ) as Record<string, unknown> | undefined
  return typeof lastAssistant?.content === 'string' && lastAssistant.content.trim()
    ? lastAssistant.content.trim()
    : 'Super Agent 已完成。'
}

export class ProjectAgentIntegrationService {
  constructor(
    private readonly database: AppDatabase,
    private readonly credentials: CredentialVault,
    private readonly dispatchTask: DispatchLike,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async dispatch(
    input: DispatchProjectAgentInput,
    onUpdate: (update: AgentRunStreamUpdate) => void = () => undefined
  ): Promise<DispatchProjectAgentResult> {
    const profile = getProjectAnalyticsProfile(input.projectId)
    if (!profile) throw new Error(`项目 ${input.projectId} 没有 Fuddy Profile。`)
    if (profile.agentIntegration.kind === 'repo-skill') {
      const integration = profile.agentIntegration
      const project = this.database.listProjects().find((candidate) => candidate.id === profile.projectId)
      const repoPath = project?.profile.repoPath ?? ''
      const skill = join(repoPath, integration.skillPath)
      const workspace = join(repoPath, integration.workspacePath)
      if (!existsSync(skill) || !existsSync(workspace)) {
        throw new Error(`项目 Skill 或工作区不存在：${skill}`)
      }
      const result = await this.dispatchTask({
        projectId: profile.projectId,
        provider: integration.provider,
        title: `${profile.projectName} · wedding-promotion`,
        workingDirectory: repoPath,
        prompt: [
          `使用项目现有 Skill ${integration.skillPath} 完成下面的营销任务。`,
          `必须先完整读取该 Skill 及其要求的项目文件；工作产物写入 ${integration.workspacePath}。`,
          `操作边界：${integration.approvalBoundary}`,
          '',
          input.prompt
        ].join('\n')
      }, onUpdate)
      return {
        mode: 'repo-skill', projectId: profile.projectId, message: result.message,
        agentRun: result.detail, externalThreadId: null, data: null
      }
    }

    const config = this.externalConfig(profile.projectId)
    const token = config.credentialRef ? this.credentials.get(config.credentialRef) : null
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
    const threadResponse = await this.fetchImpl(`${config.baseUrl}${profile.agentIntegration.threadPath}`, {
      method: 'POST', headers,
      body: JSON.stringify({ workspace: profile.agentIntegration.workspace }),
      signal: AbortSignal.timeout(20_000)
    })
    const thread = await threadResponse.json() as Record<string, unknown>
    if (!threadResponse.ok || typeof thread.id !== 'string') {
      throw new Error(String(thread.error ?? `创建 Super Agent Thread 失败（${threadResponse.status}）。`))
    }
    const chatResponse = await this.fetchImpl(`${config.baseUrl}${profile.agentIntegration.chatPath}`, {
      method: 'POST',
      headers: { ...headers, Accept: 'text/event-stream' },
      body: JSON.stringify({
        threadId: thread.id,
        message: input.prompt,
        context: { pathname: '/', timezone: profile.timezone }
      }),
      signal: AbortSignal.timeout(120_000)
    })
    const sse = await chatResponse.text()
    if (!chatResponse.ok) throw new Error(`Super Agent 请求失败（${chatResponse.status}）。`)
    const reply = parseSseComplete(sse)
    return {
      mode: 'http-super-agent', projectId: profile.projectId, message: responseMessage(reply),
      agentRun: null, externalThreadId: thread.id, data: reply
    }
  }

  private externalConfig(projectId: string): ExternalAgentConfig {
    const connector = this.database.listConnectors().find((candidate) =>
      candidate.projectId === projectId && candidate.kind === 'project-agent'
    )
    const baseUrl = typeof connector?.config.baseUrl === 'string' ? connector.config.baseUrl.replace(/\/$/, '') : ''
    if (!connector || !baseUrl) {
      throw new Error('请先为该项目配置 Fuddy Base URL 与登录凭证。')
    }
    return { baseUrl, credentialRef: connector.credentialRef }
  }
}
