import type {
  DecisionStatus,
  GoalPriority,
  GoalStatus,
  Project,
  ProjectGoal
} from '../../shared/contracts'
import { evaluateAggressivePermission } from '../../shared/permissions'
import { AppDatabase } from './database'
import { GoalTrackingService } from './goal-tracking'
import type { AgentRuntime } from './pi-runtime'

type WorkspaceAction =
  | { type: 'update_project_state'; projectId: string; summary: string; facts: string[] }
  | { type: 'create_goal'; projectId: string; prompt: string; priority: GoalPriority; status: Extract<GoalStatus, 'planned' | 'active'> }
  | { type: 'check_goal'; goalId: string }
  | { type: 'update_goal_status'; goalId: string; status: GoalStatus }
  | { type: 'update_goal_priority'; goalId: string; priority: GoalPriority }
  | { type: 'create_inbox'; projectId: string | null; goalId: string | null; title: string; summary: string }
  | { type: 'update_inbox_status'; decisionId: string; status: DecisionStatus }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function text(value: unknown, maxLength = 4_000): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function jsonObject(value: string): Record<string, unknown> | null {
  const cleaned = value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return record(JSON.parse(cleaned.slice(start, end + 1)))
  } catch {
    return null
  }
}

export function mightRequestWorkspaceAction(question: string): boolean {
  return /(?:创建|建立|新增|添加|设为|设成|改为|改成|做成|建成|暂停|恢复|继续追踪|标记|检查|复盘|更新|调整|投递|放进|放到|移到|移回|完成).{0,24}(?:目标|收件箱|项目现状|roadmap|优先级)|(?:目标|收件箱|项目现状|roadmap|优先级).{0,24}(?:创建|建立|新增|添加|设为|设成|改为|改成|暂停|恢复|检查|复盘|更新|调整|完成|稍后|待处理)/i.test(question)
}

function planPrompt(input: {
  question: string
  projects: Project[]
  goals: ProjectGoal[]
  decisions: ReturnType<AppDatabase['listDecisions']>
}): string {
  return `你是 Project Agent 的工具路由器。判断用户是否明确要求修改应用里的目标或决策收件箱。

只输出 JSON，不要 Markdown：
{"actions":[]}

允许的 action：
1. {"type":"update_project_state","projectId":"","summary":"","facts":[""]}
2. {"type":"create_goal","projectId":"","prompt":"","priority":"P0|P1|P2","status":"active|planned"}
3. {"type":"check_goal","goalId":""}
4. {"type":"update_goal_status","goalId":"","status":"planned|active|at-risk|completed|paused"}
5. {"type":"update_goal_priority","goalId":"","priority":"P0|P1|P2"}
6. {"type":"create_inbox","projectId":null,"goalId":null,"title":"","summary":""}
7. {"type":"update_inbox_status","decisionId":"","status":"inbox|later|resolved"}

规则：
- 只有用户明确要求创建、检查或改变状态时才生成 action；咨询、讨论、比较和“有什么”必须返回空 actions。
- 只能使用上下文中已有的 projectId、goalId、decisionId。
- “恢复目标”使用 active；“完成目标”使用 completed；“稍后处理”使用 later。
- P0 当前目标使用 active；P1/P2 Roadmap 默认使用 planned。priority 和 status 是两个独立字段。
- 用户亲自说明的项目现状使用 update_project_state，facts 只保存明确事实，不要加入推断。
- create_goal 的 prompt 保留用户完整意图，后续目标 Agent 会读取 Repo 与 Connector 证据再创建。
- 最多 6 个 actions，不得发明对象。

项目：${JSON.stringify(input.projects.map((project) => ({ id: project.id, name: project.name })), null, 2)}

目标：${JSON.stringify(input.goals.map((goal) => ({ id: goal.id, projectId: goal.projectId, title: goal.title, status: goal.status })), null, 2)}

收件箱：${JSON.stringify(input.decisions.slice(0, 30).map((item) => ({ id: item.id, projectId: item.projectId, goalId: item.goalId, title: item.title, status: item.status })), null, 2)}

用户请求：${input.question}`
}

function parseActions(value: unknown): WorkspaceAction[] {
  const root = record(value)
  if (!Array.isArray(root.actions)) return []
  return root.actions.slice(0, 6).flatMap<WorkspaceAction>((candidate): WorkspaceAction[] => {
    const action = record(candidate)
    const type = text(action.type, 50)
    if (type === 'update_project_state') {
      const projectId = text(action.projectId, 200)
      const summary = text(action.summary, 2_000)
      const facts = Array.isArray(action.facts)
        ? action.facts.map((item) => text(item, 500)).filter(Boolean).slice(0, 30)
        : []
      return projectId && summary ? [{ type, projectId, summary, facts }] : []
    }
    if (type === 'create_goal') {
      const projectId = text(action.projectId, 200)
      const prompt = text(action.prompt)
      const priority = action.priority
      const status = action.status
      return projectId && prompt && (priority === 'P0' || priority === 'P1' || priority === 'P2') && (status === 'active' || status === 'planned')
        ? [{ type, projectId, prompt, priority, status }]
        : []
    }
    if (type === 'check_goal') {
      const goalId = text(action.goalId, 200)
      return goalId ? [{ type, goalId }] : []
    }
    if (type === 'update_goal_status') {
      const goalId = text(action.goalId, 200)
      const status = action.status
      return goalId && (status === 'planned' || status === 'active' || status === 'at-risk' || status === 'completed' || status === 'paused')
        ? [{ type, goalId, status }]
        : []
    }
    if (type === 'update_goal_priority') {
      const goalId = text(action.goalId, 200)
      const priority = action.priority
      return goalId && (priority === 'P0' || priority === 'P1' || priority === 'P2')
        ? [{ type, goalId, priority }]
        : []
    }
    if (type === 'create_inbox') {
      const projectId = action.projectId === null ? null : text(action.projectId, 200)
      const goalId = action.goalId === null || action.goalId === undefined ? null : text(action.goalId, 200)
      const title = text(action.title, 200)
      const summary = text(action.summary, 2_000)
      return title ? [{ type, projectId: projectId || null, goalId: goalId || null, title, summary }] : []
    }
    if (type === 'update_inbox_status') {
      const decisionId = text(action.decisionId, 200)
      const status = action.status
      return decisionId && (status === 'inbox' || status === 'later' || status === 'resolved')
        ? [{ type, decisionId, status }]
        : []
    }
    return []
  })
}

function referencedProject(question: string, projects: Project[]): Project | null {
  const normalized = question.toLocaleLowerCase()
  const matches = projects.filter((project) => normalized.includes(project.name.toLocaleLowerCase()))
  return matches.length === 1 ? matches[0] : null
}

function fallbackActions(question: string, projects: Project[], goals: ProjectGoal[]): WorkspaceAction[] {
  const project = referencedProject(question, projects)
  if (project && /(?:创建|建立|新增|添加|做成|建成).{0,30}目标|目标.{0,20}(?:创建|建立|新增)/.test(question)) {
    return [{ type: 'create_goal', projectId: project.id, prompt: question, priority: 'P0', status: 'active' }]
  }
  const projectGoals = project
    ? goals.filter((goal) => goal.projectId === project.id && goal.status !== 'completed')
    : []
  if (projectGoals.length === 1 && /(?:检查|复盘|更新).{0,20}目标|目标.{0,20}(?:检查|复盘|更新)/.test(question)) {
    return [{ type: 'check_goal', goalId: projectGoals[0].id }]
  }
  return []
}

export class WorkspaceAgentActions {
  constructor(
    private readonly database: AppDatabase,
    private readonly agentRuntime: AgentRuntime,
    private readonly goalTrackingService: GoalTrackingService
  ) {}

  async tryExecute(question: string): Promise<string | null> {
    if (!mightRequestWorkspaceAction(question)) return null
    const projects = this.database.listProjects()
    const goals = this.database.listGoals()
    const decisions = this.database.listDecisions()
    let actions: WorkspaceAction[] = []
    if (this.agentRuntime.isConfigured()) {
      try {
        const response = await this.agentRuntime.run(planPrompt({ question, projects, goals, decisions }))
        actions = parseActions(jsonObject(response))
      } catch {
        // The deterministic route below still supports common explicit requests.
      }
    }
    if (actions.length === 0) actions = fallbackActions(question, projects, goals)
    if (actions.length === 0) return null

    const results: string[] = []
    for (const action of actions) {
      this.authorize(action)
      if (action.type === 'update_project_state') {
        const project = projects.find((item) => item.id === action.projectId)
        if (!project) throw new Error('Agent 引用了不存在的项目。')
        this.database.updateProject({
          ...project,
          profile: {
            ...project.profile,
            currentState: {
              summary: action.summary,
              facts: action.facts,
              source: 'user',
              updatedAt: new Date().toISOString()
            }
          }
        })
        results.push(`已更新 **${project.name}** 的用户确认项目现状。`)
      } else if (action.type === 'create_goal') {
        if (!projects.some((project) => project.id === action.projectId)) throw new Error('Agent 引用了不存在的项目。')
        const goal = await this.goalTrackingService.createFromPrompt(action.projectId, action.prompt, {
          priority: action.priority,
          status: action.status
        })
        results.push(`已为 **${projects.find((project) => project.id === goal.projectId)?.name ?? '项目'}** 创建 ${goal.priority} ${goal.status === 'planned' ? 'Roadmap' : '目标'}“**${goal.title}**”，包含 ${goal.milestones.length} 个里程碑。`)
      } else if (action.type === 'check_goal') {
        if (!goals.some((goal) => goal.id === action.goalId)) throw new Error('Agent 引用了不存在的目标。')
        const result = await this.goalTrackingService.check(action.goalId)
        results.push(`已检查目标“**${result.goal.title}**”：${result.goal.agentSummary}`)
      } else if (action.type === 'update_goal_status') {
        if (!goals.some((goal) => goal.id === action.goalId)) throw new Error('Agent 引用了不存在的目标。')
        const goal = this.database.updateGoalStatus(action.goalId, action.status)
        results.push(`目标“**${goal.title}**”已更新为「${this.goalStatusLabel(goal.status)}」。`)
      } else if (action.type === 'update_goal_priority') {
        if (!goals.some((goal) => goal.id === action.goalId)) throw new Error('Agent 引用了不存在的目标。')
        const goal = this.database.updateGoalPriority(action.goalId, action.priority)
        results.push(`目标“**${goal.title}**”的优先级已更新为 ${goal.priority}。`)
      } else if (action.type === 'create_inbox') {
        if (action.projectId && !projects.some((project) => project.id === action.projectId)) throw new Error('Agent 引用了不存在的项目。')
        if (action.goalId && !goals.some((goal) => goal.id === action.goalId)) throw new Error('Agent 引用了不存在的目标。')
        const item = this.database.createDecision({
          projectId: action.projectId,
          goalId: action.goalId,
          title: action.title,
          summary: action.summary || undefined
        })
        results.push(`已把“**${item.title}**”投递到决策收件箱。`)
      } else {
        if (!decisions.some((item) => item.id === action.decisionId)) throw new Error('Agent 引用了不存在的收件箱事项。')
        const item = this.database.updateDecisionStatus(action.decisionId, action.status)
        results.push(`收件箱事项“**${item.title}**”已更新为「${this.decisionStatusLabel(item.status)}」。`)
      }
    }

    return ['### 已完成', '', ...results.map((result) => `- ${result}`)].join('\n')
  }

  private authorize(action: WorkspaceAction): void {
    const target = 'goalId' in action
      ? action.goalId ?? undefined
      : 'decisionId' in action
        ? action.decisionId
        : 'projectId' in action
          ? action.projectId ?? undefined
          : undefined
    const intent = {
      tool: 'workspace-agent',
      action: action.type,
      target,
      description: '根据用户在项目助理对话中的明确指令管理目标或决策收件箱。'
    }
    const evaluation = evaluateAggressivePermission(intent)
    this.database.recordPermissionEvaluation(intent, evaluation)
    if (evaluation.decision === 'requires-confirmation') {
      throw new Error(`这个 Agent 操作需要确认：${evaluation.reason}`)
    }
  }

  private goalStatusLabel(status: GoalStatus): string {
    return status === 'planned' ? '已规划' : status === 'active' ? '进行中' : status === 'at-risk' ? '有风险' : status === 'paused' ? '已暂停' : '已完成'
  }

  private decisionStatusLabel(status: DecisionStatus): string {
    return status === 'inbox' ? '待处理' : status === 'later' ? '稍后' : '已完成'
  }
}
