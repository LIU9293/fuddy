import { randomUUID } from 'node:crypto'
import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import type {
  CreateProjectInput,
  DecisionStatus,
  ExecuteWorkAssistantActionInput,
  ExecuteWorkAssistantActionResult,
  GoalPriority,
  GoalStatus,
  Project,
  WorkAssistantActionOption,
  WorkAssistantActionProposal,
  WorkAssistantCapabilityId
} from '../../shared/contracts'
import { evaluateAggressivePermission } from '../../shared/permissions'
import { AppDatabase } from './database'
import type { GoalTrackingService } from './goal-tracking'
import type { AgentRuntime } from './pi-runtime'
import type { ProjectInspectionService } from './project-inspection'
import type { TaskDispatcher } from './task-dispatcher'
import type { WebResearchService } from './web-research'
import type { AutomationRuntime } from './automation-runtime'

export interface WorkspaceAgentTurnState {
  proposals: WorkAssistantActionProposal[]
  linkedRunId: string | null
  toolResults: Array<{ tool: string; result: unknown }>
}

const confirmableCapabilities = [
  'project.create',
  'project.update',
  'project.pause',
  'agent-run.create',
  'agent-run.update',
  'agent-run.archive',
  'agent-run.send',
  'goal.manage',
  'inbox.manage',
  'briefing.generate',
  'automation.manage'
] as const satisfies readonly WorkAssistantCapabilityId[]

type ConfirmableCapability = typeof confirmableCapabilities[number]
type AskUserCapability = ConfirmableCapability | 'assistant.dismiss'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function text(value: unknown, maxLength = 4_000): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function nullableText(value: unknown, maxLength = 4_000): string | null {
  return value === null || value === undefined ? null : text(value, maxLength) || null
}

function stringList(value: unknown, maxItems = 30, maxLength = 500): string[] {
  return Array.isArray(value)
    ? value.map((item) => text(item, maxLength)).filter(Boolean).slice(0, maxItems)
    : []
}

function toolResult(message: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text' as const, text: message }],
    details
  }
}

function requireProject(database: AppDatabase, projectId: string): Project {
  const project = database.listProjects().find((item) => item.id === projectId)
  if (!project) throw new Error('Agent 引用了不存在的项目。')
  return project
}

function createProjectInput(value: unknown): CreateProjectInput {
  const input = record(value)
  const required = {
    name: text(input.name, 200),
    summary: text(input.summary, 2_000),
    focus: text(input.focus, 500),
    mission: text(input.mission, 2_000),
    vision: text(input.vision, 2_000),
    productType: text(input.productType, 200),
    stage: text(input.stage, 200)
  }
  if (Object.values(required).some((item) => !item)) throw new Error('创建项目所需资料不完整。')
  const defaultAgent = ['pi', 'codex', 'claude', 'opencode'].includes(String(input.defaultAgent))
    ? input.defaultAgent as CreateProjectInput['defaultAgent']
    : 'codex'
  return {
    ...required,
    websiteUrl: nullableText(input.websiteUrl, 2_000),
    workspacePath: nullableText(input.workspacePath, 2_000),
    defaultAgent
  }
}

function capabilitySchema() {
  return Type.Union([
    ...confirmableCapabilities.map((capability) => Type.Literal(capability)),
    Type.Literal('assistant.dismiss')
  ])
}

const askUserGuidelines = `可确认 Action 的 payload：
- briefing.generate：{}。
- project.create：{name,summary,focus,mission,vision,productType,stage,websiteUrl,workspacePath,defaultAgent}。
- project.update：{operation:"update_state",projectId,summary,facts[]}。
- project.pause：{projectId}。
- agent-run.create：{projectId,decisionId,goalId,milestoneId,title,draftPrompt}；只创建 Draft，不发送。
- agent-run.update：{operation:"rename"|"update_draft",runId,title? ,draftPrompt?}。
- agent-run.archive：{runId}。
- agent-run.send：{runId,prompt}；这会真正开始或继续执行。
- goal.manage：{operation:"create"|"check"|"update_status"|"update_priority",projectId?,goalId?,prompt?,priority?,status?}。
- inbox.manage：{operation:"create"|"update_status",projectId?,goalId?,decisionId?,title?,summary?,status?}。
- automation.manage：{operation:"set_enabled"|"run_now",automationId,enabled?}。
- 取消按钮使用 assistant.dismiss，payload 为 {}，它只关闭本次提案，绝不能复用待执行能力。
只使用其他工具返回的真实 ID。不要把自然语言确认伪装成按钮；需要用户选择时必须调用 ask_user。`

export class WorkspaceAgentActions {
  private generateMorningBriefing: (() => Promise<{ briefing: { reportDate: string; headline: string } }>) | null = null
  private automationRuntime: AutomationRuntime | null = null

  constructor(
    private readonly database: AppDatabase,
    _agentRuntime: AgentRuntime,
    private readonly goalTrackingService: GoalTrackingService,
    private readonly dispatcher?: TaskDispatcher,
    private readonly projectInspection?: ProjectInspectionService,
    private readonly webResearch?: WebResearchService
  ) {}

  setMorningBriefingGenerator(generator: () => Promise<{ briefing: { reportDate: string; headline: string } }>): void {
    this.generateMorningBriefing = generator
  }

  setAutomationRuntime(runtime: AutomationRuntime): void {
    this.automationRuntime = runtime
  }

  createTurnState(): WorkspaceAgentTurnState {
    return { proposals: [], linkedRunId: null, toolResults: [] }
  }

  createTools(state: WorkspaceAgentTurnState): ToolDefinition[] {
    const capture = (tool: string, result: unknown): void => {
      state.toolResults.push({ tool, result })
    }

    const getContext = defineTool({
      name: 'get_workspace_context',
      label: 'Get workspace context',
      description: '读取工作助理可管理的项目、目标、收件箱、Agent Run、自动化和最近 Action 状态。先用它找到真实 ID，不要猜测。',
      promptSnippet: 'Inspect projects, goals, inbox items, Agent Runs, automations, and recent action state',
      parameters: Type.Object({}),
      execute: async () => {
        const context = {
          projects: this.database.listProjects().map((item) => ({ id: item.id, name: item.name, status: item.status, focus: item.focus })),
          goals: this.database.listGoals().map((item) => ({ id: item.id, projectId: item.projectId, title: item.title, status: item.status, priority: item.priority, progress: item.progress })),
          inbox: this.database.listDecisions().slice(0, 60).map((item) => ({ id: item.id, projectId: item.projectId, goalId: item.goalId, title: item.title, status: item.status, summary: item.summary })),
          runs: this.database.listRuns().slice(0, 60).map((item) => ({ id: item.id, projectId: item.projectId, goalId: item.goalId, milestoneId: item.milestoneId, decisionId: item.decisionId, title: item.title, status: item.status, summary: item.summary })),
          automations: this.database.listAutomations().map((item) => ({ id: item.id, name: item.name, projectId: item.projectId, enabled: item.enabled, action: item.action })),
          recentActions: this.database.listBriefingMessages().slice(-12).flatMap((message) => (message.actions ?? []).map((action) => ({ messageId: message.id, ...action })))
        }
        capture('get_workspace_context', context)
        return toolResult(JSON.stringify(context, null, 2), { count: context.projects.length })
      }
    })

    const inspectProject = defineTool({
      name: 'inspect_project',
      label: 'Inspect project',
      description: '读取一个项目的配置、当前状态、目标、收件箱和 Agent Run。',
      promptSnippet: 'Inspect one project and its operational state',
      parameters: Type.Object({ projectId: Type.String() }),
      execute: async (_id, params) => {
        const project = requireProject(this.database, params.projectId)
        const result = {
          project,
          goals: this.database.listGoals(project.id),
          inbox: this.database.listDecisions().filter((item) => item.projectId === project.id),
          runs: this.database.listRuns().filter((run) => run.projectId === project.id)
        }
        capture('inspect_project', result)
        return toolResult(JSON.stringify(result, null, 2), { projectId: project.id })
      }
    })

    const inspectProjectFiles = defineTool({
      name: 'inspect_project_files',
      label: 'Inspect project files',
      description: '在项目文件空间和已配置的 Workspace Roots 中查找代码、文档、素材或 Logo。不会读取项目范围外的磁盘。',
      promptSnippet: 'Search configured project files and workspace roots',
      parameters: Type.Object({ projectId: Type.String(), query: Type.String() }),
      execute: async (_id, params) => {
        if (!this.projectInspection) throw new Error('工作助理的项目文件能力尚未初始化。')
        const inspection = this.projectInspection.inspect(params.projectId, params.query)
        capture('inspect_project_files', inspection)
        return toolResult(JSON.stringify(inspection, null, 2), { projectId: inspection.project.id })
      }
    })

    const inspectAgentRun = defineTool({
      name: 'inspect_agent_run',
      label: 'Inspect Agent Run',
      description: '读取一个 Agent Run 的状态、消息、工具记录和产物。',
      promptSnippet: 'Inspect a persistent Agent Run',
      parameters: Type.Object({ runId: Type.String() }),
      execute: async (_id, params) => {
        const detail = this.database.getAgentRunDetail(params.runId)
        capture('inspect_agent_run', detail)
        return toolResult(JSON.stringify(detail, null, 2), { runId: detail.run.id })
      }
    })

    const openAgentRun = defineTool({
      name: 'open_agent_run',
      label: 'Open Agent Run',
      description: '把一个已有 Agent Run 作为普通链接附到回复中，供用户跳转。只导航，不修改任何状态，也不需要确认。',
      promptSnippet: 'Attach a link that opens an existing Agent Run without changing state',
      parameters: Type.Object({ runId: Type.String() }),
      execute: async (_id, params) => {
        const run = this.database.getAgentRun(params.runId)
        state.linkedRunId = run.id
        capture('open_agent_run', { runId: run.id })
        return toolResult(`已附加 Agent Run“${run.title}”的跳转链接。`, { runId: run.id })
      }
    })

    const searchWeb = defineTool({
      name: 'search_web',
      label: 'Search web',
      description: '搜索公开互联网，不限制本机或私有网络之外的目标；返回来源 URL。',
      promptSnippet: 'Search the web and return source URLs',
      parameters: Type.Object({ query: Type.String() }),
      execute: async (_id, params) => {
        if (!this.webResearch) throw new Error('工作助理的联网搜索能力尚未初始化。')
        const research = await this.webResearch.search(params.query)
        capture('search_web', research)
        return toolResult(JSON.stringify(research, null, 2), { sourceCount: research.sources.length })
      }
    })

    const readWeb = defineTool({
      name: 'read_web',
      label: 'Read web page',
      description: '读取 HTTP/HTTPS 页面，包括本机与私有网络服务。',
      promptSnippet: 'Read an HTTP or HTTPS page',
      parameters: Type.Object({ url: Type.String() }),
      execute: async (_id, params) => {
        if (!this.webResearch) throw new Error('工作助理的网页读取能力尚未初始化。')
        const research = await this.webResearch.read(params.url)
        capture('read_web', research)
        return toolResult(JSON.stringify(research, null, 2), { sourceCount: research.sources.length })
      }
    })

    const readBriefing = defineTool({
      name: 'read_latest_briefing',
      label: 'Read latest briefing',
      description: '读取最近一份已完成的跨项目每日简报。',
      promptSnippet: 'Read the latest completed daily briefing',
      parameters: Type.Object({}),
      execute: async () => {
        const briefing = this.database.listMorningBriefings().find((item) => item.status === 'completed') ?? null
        capture('read_latest_briefing', briefing)
        return toolResult(briefing ? JSON.stringify(briefing, null, 2) : '当前还没有已完成的每日简报。')
      }
    })

    const askUser = defineTool({
      name: 'ask_user',
      label: 'Ask user',
      description: `向用户发送真正可点击的确认或选择按钮，并持久保存每个按钮对应的 Action。这个工具不会执行 Action；调用后应停止本轮并等待用户选择。\n\n${askUserGuidelines}`,
      promptSnippet: 'Ask the user with persistent buttons before any confirm or explicit action',
      promptGuidelines: [
        'Any capability marked confirm or explicit must be proposed with ask_user before execution.',
        'After ask_user succeeds, do not claim the action ran and do not render a fake textual confirmation.'
      ],
      executionMode: 'sequential',
      parameters: Type.Object({
        title: Type.String(),
        description: Type.String(),
        context: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        options: Type.Array(Type.Object({
          id: Type.String(),
          label: Type.String(),
          style: Type.Union([Type.Literal('primary'), Type.Literal('secondary'), Type.Literal('quiet')]),
          capability: capabilitySchema(),
          payload: Type.Record(Type.String(), Type.Any())
        }), { minItems: 1, maxItems: 4 })
      }),
      execute: async (_id, params) => {
        const now = new Date().toISOString()
        const options: WorkAssistantActionOption[] = params.options.map((option) => ({
          id: option.id.trim().slice(0, 200) || randomUUID(),
          label: option.label.trim().slice(0, 100),
          style: option.style,
          capability: option.capability as AskUserCapability,
          payload: record(option.payload)
        }))
        if (options.some((option) => !option.label)) throw new Error('ask_user 的按钮文案不能为空。')
        const proposal: WorkAssistantActionProposal = {
          id: randomUUID(),
          title: params.title.trim().slice(0, 200),
          description: params.description.trim().slice(0, 2_000),
          status: 'pending',
          context: params.context?.trim().slice(0, 500) || null,
          options,
          acceptedOptionId: null,
          createdAt: now,
          resolvedAt: null
        }
        if (!proposal.title || !proposal.description) throw new Error('ask_user 需要清晰的标题和说明。')
        state.proposals.push(proposal)
        capture('ask_user', proposal)
        return toolResult('确认按钮已发送给用户。Action 尚未执行；请结束本轮并等待用户选择。', { proposalId: proposal.id })
      }
    })

    return [getContext, inspectProject, inspectProjectFiles, inspectAgentRun, openAgentRun, searchWeb, readWeb, readBriefing, askUser]
  }

  async executeProposal(input: ExecuteWorkAssistantActionInput): Promise<ExecuteWorkAssistantActionResult> {
    const message = this.database.getBriefingMessage(input.messageId)
    if (!message || message.role !== 'assistant') throw new Error('没有找到这条工作助理 Action。')
    const actions = message.actions ?? []
    const proposal = actions.find((item) => item.id === input.proposalId)
    if (!proposal) throw new Error('这个 Action 已不存在。')
    if (proposal.status !== 'pending') throw new Error('这个 Action 已经处理过。')
    const option = proposal.options.find((item) => item.id === input.optionId)
    if (!option) throw new Error('没有找到这个 Action 选项。')

    if (option.capability === 'agent-run.open') {
      const runId = text(option.payload.runId, 200)
      const run = this.database.listRuns().find((item) => item.id === runId)
      if (!run) throw new Error('这个 Agent Run 已归档或不存在，请重新查找。')
      return { message, navigation: { kind: 'agent-run', id: run.id, draftPrompt: null }, notice: `已打开“${run.title}”。` }
    }

    let navigation: ExecuteWorkAssistantActionResult['navigation'] = null
    let linkedRunId: string | null | undefined
    let notice = ''
    const payload = record(option.payload)
    const auditIntent = {
      tool: 'workspace-agent',
      action: option.capability,
      target: text(payload.runId ?? payload.projectId ?? payload.goalId ?? payload.decisionId ?? payload.automationId, 200) || undefined,
      description: `用户确认工作助理 Action：${proposal.title}`
    }
    const audit = option.capability === 'assistant.dismiss'
      ? null
      : this.database.recordPermissionEvaluation(auditIntent, evaluateAggressivePermission(auditIntent))

    try {
    if (option.capability === 'assistant.dismiss') {
      notice = '已取消。'
    } else if (option.capability === 'briefing.generate') {
      if (!this.generateMorningBriefing) throw new Error('工作助理的每日简报生成能力尚未初始化。')
      const generated = await this.generateMorningBriefing()
      notice = `已生成 ${generated.briefing.reportDate} 每日简报：“${generated.briefing.headline}”。`
    } else if (option.capability === 'project.create') {
      const project = this.database.createProject(createProjectInput(payload))
      navigation = { kind: 'project', id: project.id }
      notice = `已创建项目“${project.name}”。`
    } else if (option.capability === 'project.pause') {
      const project = requireProject(this.database, text(payload.projectId, 200))
      this.database.updateProject({ ...project, status: 'paused' })
      notice = `已暂停项目“${project.name}”。`
    } else if (option.capability === 'project.update') {
      const project = requireProject(this.database, text(payload.projectId, 200))
      if (payload.operation !== 'update_state') throw new Error('不支持的项目更新操作。')
      const summary = text(payload.summary, 2_000)
      if (!summary) throw new Error('项目现状摘要不能为空。')
      this.database.updateProject({
        ...project,
        profile: { ...project.profile, currentState: { summary, facts: stringList(payload.facts), source: 'user', updatedAt: new Date().toISOString() } }
      })
      notice = `已更新“${project.name}”的用户确认项目现状。`
    } else if (option.capability === 'agent-run.create') {
      if (!this.dispatcher) throw new Error('工作助理的 Agent Run 管理能力尚未初始化。')
      const projectId = nullableText(payload.projectId, 200)
      if (projectId) requireProject(this.database, projectId)
      const decisionId = nullableText(payload.decisionId, 200)
      const title = text(payload.title, 200)
      const draftPrompt = text(payload.draftPrompt, 20_000)
      if (!title || !draftPrompt) throw new Error('Agent Run 标题和任务说明不能为空。')
      const existing = this.database.listRuns().find((run) =>
        run.status !== 'completed'
        && run.status !== 'cancelled'
        && ((decisionId && run.decisionId === decisionId)
          || (!decisionId && run.projectId === projectId && run.title === title && run.createdAt >= proposal.createdAt))
      )
      const detail = existing ? this.database.getAgentRunDetail(existing.id) : this.dispatcher.createDraft({
          projectId,
          decisionId,
          goalId: nullableText(payload.goalId, 200),
          milestoneId: nullableText(payload.milestoneId, 200),
          title,
          draftPrompt
        })
      if (decisionId) {
        this.database.updateDecisionStatus(decisionId, 'in_progress', {
          actor: 'agent',
          reason: `已交由 Agent Run“${detail.run.title}”处理。`
        })
      }
      linkedRunId = detail.run.id
      navigation = { kind: 'agent-run', id: detail.run.id, draftPrompt: detail.run.draftPrompt }
      notice = existing
        ? `检测到刚刚创建的“${detail.run.title}”，已直接打开，避免重复创建。`
        : `已创建草稿“${detail.run.title}”，首条消息尚未发送。`
    } else if (option.capability === 'agent-run.update') {
      const runId = text(payload.runId, 200)
      if (payload.operation === 'rename') {
        const run = this.database.renameAgentRun(runId, text(payload.title, 200))
        linkedRunId = run.id
        notice = `Agent Run 已重命名为“${run.title}”。`
      } else if (payload.operation === 'update_draft') {
        const run = this.database.updateAgentRunDraftPrompt(runId, text(payload.draftPrompt, 20_000))
        linkedRunId = run.id
        notice = `已更新“${run.title}”的预填任务说明，仍未发送。`
      } else {
        throw new Error('不支持的 Agent Run 更新操作。')
      }
    } else if (option.capability === 'agent-run.archive') {
      const runId = text(payload.runId, 200)
      const run = this.database.getAgentRun(runId)
      this.database.archiveAgentRun(runId)
      notice = `已归档 Agent Run“${run.title}”。`
    } else if (option.capability === 'agent-run.send') {
      if (!this.dispatcher) throw new Error('工作助理的 Agent Run 管理能力尚未初始化。')
      const detail = await this.dispatcher.sendMessage(text(payload.runId, 200), text(payload.prompt, 20_000))
      linkedRunId = detail.run.id
      notice = `已把消息发送给 Agent Run“${detail.run.title}”。`
    } else if (option.capability === 'goal.manage') {
      notice = await this.executeGoalAction(payload)
    } else if (option.capability === 'inbox.manage') {
      notice = this.executeInboxAction(payload)
    } else if (option.capability === 'automation.manage') {
      if (!this.automationRuntime) throw new Error('工作助理的自动化管理能力尚未初始化。')
      const automationId = text(payload.automationId, 200)
      if (payload.operation === 'set_enabled') {
        const job = this.automationRuntime.setEnabled(automationId, payload.enabled === true)
        notice = `自动化“${job.name}”已${job.enabled ? '启用' : '暂停'}。`
      } else if (payload.operation === 'run_now') {
        const result = await this.automationRuntime.runNow(automationId)
        notice = `自动化“${result.job.name}”运行${result.run.status === 'completed' ? '完成' : `结束（${result.run.status}）`}：${result.run.summary}`
      } else {
        throw new Error('不支持的自动化操作。')
      }
    } else {
      throw new Error(`当前不支持执行 ${option.capability}。`)
    }

    const now = new Date().toISOString()
    const updatedActions = actions.map((item) => item.id === proposal.id ? {
      ...item,
      status: option.capability === 'assistant.dismiss' ? 'dismissed' as const : 'accepted' as const,
      acceptedOptionId: option.id,
      resolvedAt: now
    } : item)
    const updatedMessage = this.database.updateBriefingMessageActions(message.id, updatedActions, linkedRunId)
    if (audit) this.database.updateAuditOutcome(audit.id, 'completed')
    return { message: updatedMessage, notice, navigation }
    } catch (error) {
      if (audit) this.database.updateAuditOutcome(audit.id, 'failed')
      throw error
    }
  }

  private async executeGoalAction(payload: Record<string, unknown>): Promise<string> {
    const operation = text(payload.operation, 100)
    if (operation === 'create') {
      const projectId = text(payload.projectId, 200)
      requireProject(this.database, projectId)
      const priority = payload.priority as GoalPriority
      const status = payload.status as Extract<GoalStatus, 'planned' | 'active'>
      if (!['P0', 'P1', 'P2'].includes(priority) || !['planned', 'active'].includes(status)) throw new Error('目标优先级或状态无效。')
      const goal = await this.goalTrackingService.createFromPrompt(projectId, text(payload.prompt, 4_000), { priority, status })
      return `已创建 ${goal.priority} 目标“${goal.title}”。`
    }
    const goalId = text(payload.goalId, 200)
    if (!this.database.listGoals().some((item) => item.id === goalId)) throw new Error('Agent 引用了不存在的目标。')
    if (operation === 'check') {
      const result = await this.goalTrackingService.check(goalId)
      return `已检查目标“${result.goal.title}”：${result.goal.agentSummary}`
    }
    if (operation === 'update_status') {
      const status = payload.status as GoalStatus
      if (!['planned', 'active', 'at-risk', 'completed', 'paused'].includes(status)) throw new Error('目标状态无效。')
      const goal = this.database.updateGoalStatus(goalId, status)
      return `目标“${goal.title}”已更新为 ${goal.status}。`
    }
    if (operation === 'update_priority') {
      const priority = payload.priority as GoalPriority
      if (!['P0', 'P1', 'P2'].includes(priority)) throw new Error('目标优先级无效。')
      const goal = this.database.updateGoalPriority(goalId, priority)
      return `目标“${goal.title}”的优先级已更新为 ${goal.priority}。`
    }
    throw new Error('不支持的目标操作。')
  }

  private executeInboxAction(payload: Record<string, unknown>): string {
    const operation = text(payload.operation, 100)
    if (operation === 'create') {
      const projectId = nullableText(payload.projectId, 200)
      if (projectId) requireProject(this.database, projectId)
      const item = this.database.createDecision({
        projectId,
        goalId: nullableText(payload.goalId, 200),
        title: text(payload.title, 200),
        summary: text(payload.summary, 2_000) || undefined
      })
      return `已把“${item.title}”投递到决策收件箱。`
    }
    if (operation === 'update_status') {
      const decisionId = text(payload.decisionId, 200)
      const status = payload.status as DecisionStatus
      if (!['inbox', 'in_progress', 'waiting', 'resolved', 'ignored'].includes(status)) throw new Error('收件箱状态无效。')
      const item = this.database.updateDecisionStatus(decisionId, status, { actor: 'agent' })
      return `收件箱事项“${item.title}”已更新为 ${item.status}。`
    }
    throw new Error('不支持的收件箱操作。')
  }
}
