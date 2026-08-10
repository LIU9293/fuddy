import { randomUUID } from 'node:crypto'
import type {
  CreateProjectInput,
  DecisionStatus,
  ExecuteWorkAssistantActionInput,
  ExecuteWorkAssistantActionResult,
  GoalPriority,
  GoalStatus,
  Project,
  ProjectGoal,
  WorkAssistantActionProposal,
  WorkAssistantTaskContext
} from '../../shared/contracts'
import { evaluateAggressivePermission } from '../../shared/permissions'
import { AppDatabase } from './database'
import { GoalTrackingService } from './goal-tracking'
import type { AgentRuntime } from './pi-runtime'
import type { TaskDispatcher } from './task-dispatcher'
import type { ProjectInspectionService } from './project-inspection'
import { capabilityPromptCatalog } from './work-assistant-capabilities'
import type { WebResearchService } from './web-research'

type WorkspaceAction =
  | { type: 'list_projects' }
  | { type: 'create_project'; input: CreateProjectInput }
  | { type: 'update_project_state'; projectId: string; summary: string; facts: string[] }
  | { type: 'create_goal'; projectId: string; prompt: string; priority: GoalPriority; status: Extract<GoalStatus, 'planned' | 'active'> }
  | { type: 'check_goal'; goalId: string }
  | { type: 'update_goal_status'; goalId: string; status: GoalStatus }
  | { type: 'update_goal_priority'; goalId: string; priority: GoalPriority }
  | { type: 'create_inbox'; projectId: string | null; goalId: string | null; title: string; summary: string }
  | { type: 'update_inbox_status'; decisionId: string; status: DecisionStatus }
  | { type: 'inspect_project'; projectId: string; query: string }
  | { type: 'list_agent_runs'; projectId: string | null }
  | { type: 'inspect_agent_run'; runId: string }
  | { type: 'open_agent_run'; runId: string; draftPrompt: string | null }
  | { type: 'create_agent_run'; projectId: string | null; goalId: string | null; milestoneId: string | null; title: string; draftPrompt: string }
  | { type: 'rename_agent_run'; runId: string; title: string }
  | { type: 'update_agent_run_draft'; runId: string; draftPrompt: string }
  | { type: 'archive_agent_run'; runId: string }
  | { type: 'send_agent_run_message'; runId: string; prompt: string }
  | { type: 'search_web'; query: string }
  | { type: 'read_web'; url: string }
  | { type: 'read_latest_briefing' }
  | { type: 'generate_morning_briefing' }

export interface WorkspaceAgentActionResult {
  content: string
  toolContext: string
  linkedRunId: string | null
  requiresSynthesis: boolean
  proposals: WorkAssistantActionProposal[]
}

interface TaskDispatchResult {
  description: string
  linkedRunId: string | null
  proposal: WorkAssistantActionProposal | null
}

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
  return /(?:创建|新建|建立|新增|添加|设为|设成|改为|改成|做成|建成|暂停|恢复|继续追踪|标记|检查|复盘|更新|调整|投递|放进|放到|移到|移回|完成).{0,24}(?:目标|收件箱|项目现状|项目|roadmap|优先级)|(?:目标|收件箱|项目现状|roadmap|优先级).{0,24}(?:创建|新建|建立|新增|添加|设为|设成|改为|改成|暂停|恢复|检查|复盘|更新|调整|完成|稍后|待处理)|(?:agent\s*run|session|run|任务|PR\s*#?\d+).{0,30}(?:创建|新建|开启|开始|处理|打开|跳转|回到|进入|重命名|改名|归档|删除|继续|发送|执行)|(?:创建|新建|开启|开始|处理|修复|继续|打开|跳转|回到|进入|重命名|改名|归档|删除|发送|执行).{0,30}(?:agent\s*run|session|run|任务|PR\s*#?\d+)|(?:agent\s*run|session|run).{0,30}(?:修改|更新).{0,20}(?:prompt|任务说明|首条消息)|(?:修改|更新).{0,20}(?:agent\s*run|session|run).{0,20}(?:prompt|任务说明|首条消息)|(?:代码|文件|素材|logo|readme|仓库|workspace|项目资料).{0,30}(?:查找|寻找|搜索|读取|看看|看一下|在哪|有没有|找)|(?:查找|寻找|搜索|读取|看看|看一下|找).{0,30}(?:代码|文件|素材|logo|readme|仓库|workspace|项目资料)|(?:联网|网页|网上|互联网|web).{0,20}(?:搜索|查找|查看|读取|搜)|(?:搜索|查找|查看|读取|搜).{0,20}(?:联网|网页|网上|互联网|web)|(?:生成|重新生成|查看|读取).{0,16}(?:每日简报|早报|简报)|(?:每日简报|早报|简报).{0,16}(?:生成|重新生成|查看|读取)/i.test(question)
}

function planPrompt(input: {
  question: string
  projects: Project[]
  goals: ProjectGoal[]
  decisions: ReturnType<AppDatabase['listDecisions']>
  runs: ReturnType<AppDatabase['listRuns']>
  taskContext: WorkAssistantTaskContext | null
}): string {
  return `你是 Project Agent 工作助理的能力路由器。选择完成用户请求所需的最少能力。

能力目录：
${capabilityPromptCatalog()}

只输出 JSON，不要 Markdown：
{"actions":[]}

允许的 action：
0. {"type":"list_projects"}
0a. {"type":"create_project","input":{"name":"","summary":"","focus":"","mission":"","vision":"","productType":"","stage":"","websiteUrl":null,"workspacePath":null,"defaultAgent":"codex"}}
1. {"type":"update_project_state","projectId":"","summary":"","facts":[""]}
2. {"type":"create_goal","projectId":"","prompt":"","priority":"P0|P1|P2","status":"active|planned"}
3. {"type":"check_goal","goalId":""}
4. {"type":"update_goal_status","goalId":"","status":"planned|active|at-risk|completed|paused"}
5. {"type":"update_goal_priority","goalId":"","priority":"P0|P1|P2"}
6. {"type":"create_inbox","projectId":null,"goalId":null,"title":"","summary":""}
7. {"type":"update_inbox_status","decisionId":"","status":"inbox|in_progress|waiting|resolved|ignored"}
8. {"type":"inspect_project","projectId":"","query":"要查找的文件、代码或项目信息"}
9. {"type":"list_agent_runs","projectId":null}
10. {"type":"inspect_agent_run","runId":""}
10a. {"type":"open_agent_run","runId":"","draftPrompt":null}
11. {"type":"create_agent_run","projectId":null,"goalId":null,"milestoneId":null,"title":"","draftPrompt":""}
12. {"type":"rename_agent_run","runId":"","title":""}
13. {"type":"update_agent_run_draft","runId":"","draftPrompt":""}
14. {"type":"archive_agent_run","runId":""}
15. {"type":"send_agent_run_message","runId":"","prompt":""}
16. {"type":"search_web","query":""}
17. {"type":"read_web","url":"http://... 或 https://..."}
18. {"type":"read_latest_briefing"}
19. {"type":"generate_morning_briefing"}

规则：
- 只有用户明确要求创建、检查、查询或改变应用状态时才生成 action；纯讨论、比较和假设问题返回空 actions。
- list_projects、项目/Run/文件/网页/简报读取是只读能力，可以直接执行。
- create_project 只生成待确认的项目草案，不直接创建。没有 Workspace 路径也可以先创建项目，但之后不能启动项目 Run。
- 项目信息、文件、素材或代码查询使用 inspect_project；它只会读取配置的 Workspace Roots 和项目文件空间。
- 用户询问 Run 列表或状态时可使用 list_agent_runs / inspect_agent_run。
- 用户要求打开、跳转或回到已有 Run 时使用 open_agent_run；它只生成确认 Action，不发送消息。
- “创建/开启任务”只创建带 draftPrompt 的草稿 Run，不发送首条消息。只有用户明确说“直接执行/发送给 Run/让它继续跑”时才使用 send_agent_run_message。
- “删除 Run/Session”使用 archive_agent_run；不做硬删除。不能归档正在运行的 Run。
- 修改尚未发送的 Run 首条任务说明使用 update_agent_run_draft。
- 能从当前任务上下文确定 projectId/goalId/milestoneId 时必须沿用，不要让用户重复提供。
- 只能使用上下文中已有的 projectId、goalId、decisionId。
- “恢复目标”使用 active；“完成目标”使用 completed；用户明确忽略收件箱事项时使用 ignored。
- P0 当前目标使用 active；P1/P2 Roadmap 默认使用 planned。priority 和 status 是两个独立字段。
- 用户亲自说明的项目现状使用 update_project_state，facts 只保存明确事实，不要加入推断。
- create_goal 的 prompt 保留用户完整意图，后续目标 Agent 会读取 Repo 与 Connector 证据再创建。
- 最多 6 个 actions，不得发明对象。

项目：${JSON.stringify(input.projects.map((project) => ({ id: project.id, name: project.name })), null, 2)}

目标：${JSON.stringify(input.goals.map((goal) => ({ id: goal.id, projectId: goal.projectId, title: goal.title, status: goal.status })), null, 2)}

收件箱：${JSON.stringify(input.decisions.slice(0, 30).map((item) => ({ id: item.id, projectId: item.projectId, goalId: item.goalId, title: item.title, status: item.status })), null, 2)}

Agent Runs：${JSON.stringify(input.runs.slice(0, 30).map((run) => ({ id: run.id, projectId: run.projectId, goalId: run.goalId, milestoneId: run.milestoneId, title: run.title, status: run.status })), null, 2)}

当前任务上下文：${JSON.stringify(input.taskContext, null, 2)}

用户请求：${input.question}`
}

function parseActions(value: unknown): WorkspaceAction[] {
  const root = record(value)
  if (!Array.isArray(root.actions)) return []
  return root.actions.slice(0, 6).flatMap<WorkspaceAction>((candidate): WorkspaceAction[] => {
    const action = record(candidate)
    const type = text(action.type, 50)
    if (type === 'list_projects') return [{ type }]
    if (type === 'create_project') {
      const input = record(action.input)
      const name = text(input.name, 200)
      const summary = text(input.summary, 2_000)
      const focus = text(input.focus, 500)
      const mission = text(input.mission, 2_000)
      const vision = text(input.vision, 2_000)
      const productType = text(input.productType, 200)
      const stage = text(input.stage, 200)
      if (!name || !summary || !focus || !mission || !vision || !productType || !stage) return []
      const defaultAgent = ['pi', 'codex', 'claude', 'opencode'].includes(String(input.defaultAgent))
        ? input.defaultAgent as CreateProjectInput['defaultAgent']
        : 'codex'
      return [{ type, input: {
        name,
        summary,
        focus,
        mission,
        vision,
        productType,
        stage,
        websiteUrl: input.websiteUrl === null ? null : text(input.websiteUrl, 2_000) || null,
        workspacePath: input.workspacePath === null ? null : text(input.workspacePath, 2_000) || null,
        defaultAgent
      } }]
    }
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
      return decisionId && (status === 'inbox' || status === 'in_progress' || status === 'waiting' || status === 'resolved' || status === 'ignored')
        ? [{ type, decisionId, status }]
        : []
    }
    if (type === 'inspect_project') {
      const projectId = text(action.projectId, 200)
      return projectId ? [{ type, projectId, query: text(action.query, 500) }] : []
    }
    if (type === 'list_agent_runs') {
      const projectId = action.projectId === null || action.projectId === undefined ? null : text(action.projectId, 200)
      return [{ type, projectId: projectId || null }]
    }
    if (type === 'inspect_agent_run') {
      const runId = text(action.runId, 200)
      return runId ? [{ type, runId }] : []
    }
    if (type === 'open_agent_run') {
      const runId = text(action.runId, 200)
      const draftPrompt = action.draftPrompt === null || action.draftPrompt === undefined ? null : text(action.draftPrompt, 20_000) || null
      return runId ? [{ type, runId, draftPrompt }] : []
    }
    if (type === 'create_agent_run') {
      const projectId = action.projectId === null || action.projectId === undefined ? null : text(action.projectId, 200)
      const goalId = action.goalId === null || action.goalId === undefined ? null : text(action.goalId, 200)
      const milestoneId = action.milestoneId === null || action.milestoneId === undefined ? null : text(action.milestoneId, 200)
      const title = text(action.title, 200)
      const draftPrompt = text(action.draftPrompt, 20_000)
      return title && draftPrompt ? [{ type, projectId: projectId || null, goalId: goalId || null, milestoneId: milestoneId || null, title, draftPrompt }] : []
    }
    if (type === 'rename_agent_run') {
      const runId = text(action.runId, 200)
      const title = text(action.title, 200)
      return runId && title ? [{ type, runId, title }] : []
    }
    if (type === 'update_agent_run_draft') {
      const runId = text(action.runId, 200)
      const draftPrompt = text(action.draftPrompt, 20_000)
      return runId && draftPrompt ? [{ type, runId, draftPrompt }] : []
    }
    if (type === 'archive_agent_run') {
      const runId = text(action.runId, 200)
      return runId ? [{ type, runId }] : []
    }
    if (type === 'send_agent_run_message') {
      const runId = text(action.runId, 200)
      const prompt = text(action.prompt, 20_000)
      return runId && prompt ? [{ type, runId, prompt }] : []
    }
    if (type === 'search_web') {
      const query = text(action.query, 1_000)
      return query ? [{ type, query }] : []
    }
    if (type === 'read_web') {
      const url = text(action.url, 2_000)
      return url ? [{ type, url }] : []
    }
    if (type === 'read_latest_briefing' || type === 'generate_morning_briefing') return [{ type }]
    return []
  })
}

function referencedProject(question: string, projects: Project[]): Project | null {
  const normalized = question.toLocaleLowerCase()
  const matches = projects.filter((project) => normalized.includes(project.name.toLocaleLowerCase()))
  return matches.length === 1 ? matches[0] : null
}

function fallbackActions(
  question: string,
  projects: Project[],
  goals: ProjectGoal[],
  runs: ReturnType<AppDatabase['listRuns']>,
  taskContext: WorkAssistantTaskContext | null
): WorkspaceAction[] {
  const project = referencedProject(question, projects)
    ?? (taskContext ? projects.find((item) => item.id === taskContext.projectId) ?? null : null)
  if (project && /(?:创建|建立|新增|添加|做成|建成).{0,30}目标|目标.{0,20}(?:创建|建立|新增)/.test(question)) {
    return [{ type: 'create_goal', projectId: project.id, prompt: question, priority: 'P0', status: 'active' }]
  }
  const projectGoals = project
    ? goals.filter((goal) => goal.projectId === project.id && goal.status !== 'completed')
    : []
  if (projectGoals.length === 1 && /(?:检查|复盘|更新).{0,20}目标|目标.{0,20}(?:检查|复盘|更新)/.test(question)) {
    return [{ type: 'check_goal', goalId: projectGoals[0].id }]
  }
  if (project && /(?:代码|文件|素材|logo|readme|仓库|workspace|项目资料)/i.test(question)) {
    return [{ type: 'inspect_project', projectId: project.id, query: question }]
  }
  if (/(?:有哪些|列出|查看|看看).{0,12}项目|所有项目/.test(question)) return [{ type: 'list_projects' }]
  if (/(?:生成|重新生成).{0,12}(?:每日简报|早报|简报)/.test(question)) return [{ type: 'generate_morning_briefing' }]
  if (/(?:查看|读取|最近).{0,12}(?:每日简报|早报|简报)/.test(question)) return [{ type: 'read_latest_briefing' }]
  const explicitUrl = question.match(/https?:\/\/[^\s)\]}]+/i)?.[0]
  if (explicitUrl && /(?:查看|读取|分析|网页|网站)/.test(question)) return [{ type: 'read_web', url: explicitUrl }]
  if (/(?:联网|网上|互联网|网页|web).{0,20}(?:搜索|查找|搜)|(?:搜索|查找|搜).{0,20}(?:联网|网上|互联网|网页|web)/i.test(question)) {
    return [{ type: 'search_web', query: question }]
  }
  if (/(?:有哪些|列出|查看|看看).{0,20}(?:agent\s*run|session|run)|(?:agent\s*run|session|run).{0,20}(?:有哪些|列出|查看|看看)/i.test(question)) {
    return [{ type: 'list_agent_runs', projectId: project?.id ?? null }]
  }
  if (project && /(?:创建|新建|开启|开始).{0,20}(?:agent\s*run|session|run|任务)|(?:agent\s*run|session|run|任务).{0,20}(?:创建|新建|开启|开始)/i.test(question)) {
    const goal = taskContext ? goals.find((item) => item.id === taskContext.goalId) ?? null : null
    const milestone = goal?.milestones.find((item) => item.id === taskContext?.milestoneId) ?? null
    const title = milestone?.title ?? `${project.name} 任务`
    return [{
      type: 'create_agent_run',
      projectId: project.id,
      goalId: goal?.id ?? null,
      milestoneId: milestone?.id ?? null,
      title,
      draftPrompt: taskContext
        ? `请推进项目“${project.name}”的任务“${taskContext.milestoneTitle}”。先检查项目 Workspace 和项目文件空间中的已有证据与产物，再执行安全的第一步；不要自动把里程碑标记为完成。`
        : question
    }]
  }
  const referencedRun = runs.find((run) => question.includes(run.id) || question.includes(run.title))
  if (referencedRun && /(?:打开|跳转|回到|进入)/.test(question)) return [{ type: 'open_agent_run', runId: referencedRun.id, draftPrompt: null }]
  if (referencedRun && /(?:归档|删除)/.test(question)) return [{ type: 'archive_agent_run', runId: referencedRun.id }]
  return []
}

function taskDispatchProposal(
  database: AppDatabase,
  question: string,
  projects: Project[],
  taskContext: WorkAssistantTaskContext | null
): TaskDispatchResult | null {
  const dispatchIntent = /(?:处理|修复|推进|开始|开启|继续).{0,36}(?:PR\s*#?\d+|问题|事项|任务)|(?:PR\s*#?\d+|问题|事项|任务).{0,36}(?:处理|修复|推进|开始|开启|继续)/i.test(question)
  if (!dispatchIntent) return null
  const prNumber = question.match(/\bPR\s*#?\s*(\d+)\b/i)?.[1] ?? null
  const remediations = database.listDecisionRemediations()
  const remediation = prNumber
    ? remediations.find((item) => new RegExp(`/pull/${prNumber}(?:$|[/?#])`).test(item.sourceRef)) ?? null
    : null
  const decisions = database.listDecisions()
  const decision = remediation ? decisions.find((item) => item.id === remediation.decisionId) ?? null : null
  const namedProject = referencedProject(question, projects)
  const project = projects.find((item) => item.id === (decision?.projectId ?? taskContext?.projectId)) ?? namedProject
  if (!project) return null
  const terms = [prNumber ? `#${prNumber}` : '', prNumber ? `PR ${prNumber}` : '', decision?.title ?? '']
    .filter(Boolean)
    .map((item) => item.toLocaleLowerCase())
  const candidates = database.listRuns().map((run) => {
    let score = 0
    if (run.projectId === project.id) score += 20
    if (decision && run.decisionId === decision.id) score += 100
    if (taskContext?.goalId && run.goalId === taskContext.goalId) score += 30
    const detail = database.getAgentRunDetail(run.id)
    const haystack = [run.title, run.summary, ...detail.messages.map((message) => message.content)].join('\n').toLocaleLowerCase()
    if (terms.some((term) => term && haystack.includes(term))) score += 55
    if (run.status === 'running' || run.status === 'queued') score += 25
    else if (run.status === 'draft' || run.status === 'idle') score += 20
    else if (run.status === 'failed') score += 10
    else if (run.status === 'completed' || run.status === 'cancelled') score -= 40
    return { run, score }
  }).filter((item) => item.score >= 60).sort((a, b) => b.score - a.score)
  const activeCandidates = candidates.filter((item) => item.run.status !== 'completed' && item.run.status !== 'cancelled').slice(0, 3)
  const taskLabel = prNumber ? `PR #${prNumber}` : decision?.title ?? question.slice(0, 80)
  const draftPrompt = prNumber
    ? `继续处理 ${project.name} 的 PR #${prNumber}。先读取最新 diff、Review 意见、CI 和已有会话上下文，逐条处理仍未解决的问题；完成后说明证据、剩余风险与部署/验证状态。不要把代码合并等同于生产问题已经解决。`
    : `请继续处理 ${project.name} 的“${decision?.title ?? question}”。先检查已有证据和会话上下文，再推进安全的下一步。`
  const now = new Date().toISOString()
  if (activeCandidates.length > 0) {
    const preferred = activeCandidates[0].run
    const status = preferred.status === 'failed' ? '上次中断，可继续原 Session' : preferred.status === 'running' || preferred.status === 'queued' ? '当前正在执行' : `当前状态：${preferred.status}`
    return {
      description: `找到与 ${taskLabel} 相关的“${preferred.title}”。${status}。可以通过下方链接直接回到这个 Run。`,
      linkedRunId: preferred.id,
      proposal: null
    }
  }
  const proposal: WorkAssistantActionProposal = {
    id: randomUUID(),
    title: '创建 Agent Run',
    description: `没有找到正在处理 ${taskLabel} 的可继续 Run。确认后会创建草稿并预填任务说明，不会自动发送。`,
    status: 'pending',
    context: decision ? `关联收件箱：${decision.title}` : `项目：${project.name}`,
    options: [{
      id: 'create-run',
      label: '创建并打开',
      style: 'primary',
      capability: 'agent-run.create',
      payload: {
        projectId: project.id,
        decisionId: decision?.id ?? null,
        goalId: taskContext?.goalId ?? null,
        milestoneId: taskContext?.milestoneId ?? null,
        title: `处理 · ${taskLabel}`,
        draftPrompt
      }
    }],
    acceptedOptionId: null,
    createdAt: now,
    resolvedAt: null
  }
  return { description: proposal.description, linkedRunId: null, proposal }
}

export class WorkspaceAgentActions {
  private generateMorningBriefing: (() => Promise<{ briefing: { reportDate: string; headline: string } }>) | null = null

  constructor(
    private readonly database: AppDatabase,
    private readonly agentRuntime: AgentRuntime,
    private readonly goalTrackingService: GoalTrackingService,
    private readonly dispatcher?: TaskDispatcher,
    private readonly projectInspection?: ProjectInspectionService,
    private readonly webResearch?: WebResearchService
  ) {}

  setMorningBriefingGenerator(generator: () => Promise<{ briefing: { reportDate: string; headline: string } }>): void {
    this.generateMorningBriefing = generator
  }

  async tryExecute(question: string): Promise<string | null> {
    return (await this.tryExecuteDetailed(question))?.content ?? null
  }

  async tryExecuteDetailed(
    question: string,
    taskContext: WorkAssistantTaskContext | null = null,
    activeRunId: string | null = null
  ): Promise<WorkspaceAgentActionResult | null> {
    if (!mightRequestWorkspaceAction(question)) return null
    const projects = this.database.listProjects()
    const goals = this.database.listGoals()
    const decisions = this.database.listDecisions()
    const runs = this.database.listRuns()
    const handoff = taskDispatchProposal(this.database, question, projects, taskContext)
    if (handoff) {
      return {
        content: handoff.description,
        toolContext: JSON.stringify({ capability: 'agent-run.find', linkedRunId: handoff.linkedRunId, proposal: handoff.proposal }, null, 2),
        linkedRunId: handoff.linkedRunId,
        requiresSynthesis: false,
        proposals: handoff.proposal ? [handoff.proposal] : []
      }
    }
    let actions: WorkspaceAction[] = []
    if (this.agentRuntime.isConfigured()) {
      try {
        const response = await this.agentRuntime.run(`${planPrompt({ question, projects, goals, decisions, runs, taskContext })}\n\n当前激活的 Agent Run：${activeRunId ?? '无'}`)
        actions = parseActions(jsonObject(response))
      } catch {
        // The deterministic route below still supports common explicit requests.
      }
    }
    if (actions.length === 0) actions = fallbackActions(question, projects, goals, runs, taskContext)
    if (actions.length === 0 && activeRunId && /(?:这个|当前).{0,8}(?:run|session|任务)/i.test(question)) {
      if (/(?:归档|删除)/.test(question)) actions = [{ type: 'archive_agent_run', runId: activeRunId }]
      else if (/(?:查看|状态|怎么样)/.test(question)) actions = [{ type: 'inspect_agent_run', runId: activeRunId }]
    }
    const explicitlyRequestedExecution = /(?:直接|现在|立即).{0,8}(?:执行|发送|开始跑)|(?:发送给|让).{0,24}(?:agent\s*run|session|run).{0,16}(?:执行|继续|运行)|(?:继续|执行|运行).{0,16}(?:这个|当前)?(?:agent\s*run|session|run)/i.test(question)
    if (!explicitlyRequestedExecution) {
      actions = actions.filter((action) => action.type !== 'send_agent_run_message')
    }
    if (actions.length === 0) return null

    const results: string[] = []
    const toolResults: unknown[] = []
    const proposals: WorkAssistantActionProposal[] = []
    let linkedRunId: string | null = null
    for (const action of actions) {
      if (!['list_projects', 'inspect_project', 'list_agent_runs', 'inspect_agent_run', 'search_web', 'read_web', 'read_latest_briefing'].includes(action.type)) this.authorize(action)
      if (action.type === 'list_projects') {
        results.push(projects.length > 0
          ? `当前有 ${projects.length} 个项目：${projects.map((project) => `“${project.name}”（${project.status}）`).join('；')}。`
          : '当前还没有项目。')
        toolResults.push({ action: action.type, projects })
      } else if (action.type === 'create_project') {
        const proposal: WorkAssistantActionProposal = {
          id: randomUUID(),
          title: `新建项目“${action.input.name}”`,
          description: `${action.input.summary}。确认后创建项目${action.input.workspacePath ? '并配置首个 Workspace Root' : '；Workspace 可以稍后在项目设置中补充'}。`,
          status: 'pending',
          context: `类型：${action.input.productType} · 阶段：${action.input.stage}`,
          options: [{ id: 'create-project', label: '确认创建', style: 'primary', capability: 'project.create', payload: action.input }],
          acceptedOptionId: null,
          createdAt: new Date().toISOString(),
          resolvedAt: null
        }
        proposals.push(proposal)
        results.push(`已准备项目“**${action.input.name}**”的创建草案，请确认后创建。`)
        toolResults.push({ action: action.type, proposal })
      } else if (action.type === 'update_project_state') {
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
        toolResults.push({ action: action.type, projectId: project.id, currentState: action })
      } else if (action.type === 'create_goal') {
        if (!projects.some((project) => project.id === action.projectId)) throw new Error('Agent 引用了不存在的项目。')
        const goal = await this.goalTrackingService.createFromPrompt(action.projectId, action.prompt, {
          priority: action.priority,
          status: action.status
        })
        results.push(`已为 **${projects.find((project) => project.id === goal.projectId)?.name ?? '项目'}** 创建 ${goal.priority} ${goal.status === 'planned' ? 'Roadmap' : '目标'}“**${goal.title}**”，包含 ${goal.milestones.length} 个里程碑。`)
        toolResults.push({ action: action.type, goal })
      } else if (action.type === 'check_goal') {
        if (!goals.some((goal) => goal.id === action.goalId)) throw new Error('Agent 引用了不存在的目标。')
        const result = await this.goalTrackingService.check(action.goalId)
        results.push(`已检查目标“**${result.goal.title}**”：${result.goal.agentSummary}`)
        toolResults.push({ action: action.type, result })
      } else if (action.type === 'update_goal_status') {
        if (!goals.some((goal) => goal.id === action.goalId)) throw new Error('Agent 引用了不存在的目标。')
        const goal = this.database.updateGoalStatus(action.goalId, action.status)
        results.push(`目标“**${goal.title}**”已更新为「${this.goalStatusLabel(goal.status)}」。`)
        toolResults.push({ action: action.type, goal })
      } else if (action.type === 'update_goal_priority') {
        if (!goals.some((goal) => goal.id === action.goalId)) throw new Error('Agent 引用了不存在的目标。')
        const goal = this.database.updateGoalPriority(action.goalId, action.priority)
        results.push(`目标“**${goal.title}**”的优先级已更新为 ${goal.priority}。`)
        toolResults.push({ action: action.type, goal })
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
        toolResults.push({ action: action.type, item })
      } else if (action.type === 'update_inbox_status') {
        if (!decisions.some((item) => item.id === action.decisionId)) throw new Error('Agent 引用了不存在的收件箱事项。')
        const item = this.database.updateDecisionStatus(action.decisionId, action.status, { actor: 'agent' })
        results.push(`收件箱事项“**${item.title}**”已更新为「${this.decisionStatusLabel(item.status)}」。`)
        toolResults.push({ action: action.type, item })
      } else if (action.type === 'inspect_project') {
        if (!this.projectInspection) throw new Error('工作助理的项目检查能力尚未初始化。')
        const inspection = this.projectInspection.inspect(action.projectId, action.query)
        const paths = inspection.matches.slice(0, 8).map((match) => `${match.rootLabel}/${match.relativePath}`)
        results.push(`已检查 **${inspection.project.name}** 的项目资料、文件空间和 Workspace。${paths.length > 0 ? `找到：${paths.join('；')}。` : '没有找到与查询直接匹配的文件。'}`)
        toolResults.push({ action: action.type, inspection })
      } else if (action.type === 'list_agent_runs') {
        const matched = runs.filter((run) => !action.projectId || run.projectId === action.projectId).slice(0, 20)
        results.push(matched.length > 0
          ? `找到 ${matched.length} 个 Agent Run：${matched.map((run) => `“${run.title}”（${run.status}）`).join('；')}。`
          : '当前没有匹配的 Agent Run。')
        toolResults.push({ action: action.type, runs: matched })
      } else if (action.type === 'inspect_agent_run') {
        const detail = this.database.getAgentRunDetail(action.runId)
        results.push(`Agent Run“**${detail.run.title}**”当前为 ${detail.run.status}，最近摘要：${detail.run.summary}`)
        toolResults.push({ action: action.type, detail })
        linkedRunId = detail.run.id
      } else if (action.type === 'open_agent_run') {
        const run = this.database.getAgentRun(action.runId)
        linkedRunId = run.id
        results.push(`已找到 Agent Run“**${run.title}**”，可以通过下方链接直接打开。`)
        toolResults.push({ action: action.type, runId: run.id })
      } else if (action.type === 'create_agent_run') {
        const proposal: WorkAssistantActionProposal = {
          id: randomUUID(),
          title: `创建 Agent Run“${action.title}”`,
          description: '确认后创建 Draft Run 并预填首条任务说明，不会自动发送或执行。',
          status: 'pending',
          context: action.projectId ? `项目：${projects.find((item) => item.id === action.projectId)?.name ?? action.projectId}` : '共享 Run',
          options: [{
            id: 'create-run',
            label: '创建并打开',
            style: 'primary',
            capability: 'agent-run.create',
            payload: {
              projectId: action.projectId,
              decisionId: null,
              goalId: action.goalId,
              milestoneId: action.milestoneId,
              title: action.title,
              draftPrompt: action.draftPrompt
            }
          }],
          acceptedOptionId: null,
          createdAt: new Date().toISOString(),
          resolvedAt: null
        }
        proposals.push(proposal)
        results.push(`已准备 Agent Run“**${action.title}**”，请确认后创建。`)
        toolResults.push({ action: action.type, proposal })
      } else if (action.type === 'rename_agent_run') {
        const run = this.database.renameAgentRun(action.runId, action.title)
        linkedRunId = run.id
        results.push(`Agent Run 已重命名为“**${run.title}**”。`)
        toolResults.push({ action: action.type, run })
      } else if (action.type === 'update_agent_run_draft') {
        const run = this.database.updateAgentRunDraftPrompt(action.runId, action.draftPrompt)
        linkedRunId = run.id
        results.push(`已更新 Agent Run“**${run.title}**”的预填任务说明，仍未发送。`)
        toolResults.push({ action: action.type, run })
      } else if (action.type === 'archive_agent_run') {
        const run = this.database.getAgentRun(action.runId)
        this.database.archiveAgentRun(action.runId)
        results.push(`已归档 Agent Run“**${run.title}**”。`)
        toolResults.push({ action: action.type, runId: run.id, archived: true })
      } else if (action.type === 'send_agent_run_message') {
        if (!this.dispatcher) throw new Error('工作助理的 Agent Run 管理能力尚未初始化。')
        const detail = await this.dispatcher.sendMessage(action.runId, action.prompt)
        linkedRunId = detail.run.id
        results.push(`已把消息发送给 Agent Run“**${detail.run.title}**”：${detail.run.summary}`)
        toolResults.push({ action: action.type, detail })
      } else if (action.type === 'search_web') {
        if (!this.webResearch) throw new Error('工作助理的联网搜索能力尚未初始化。')
        const research = await this.webResearch.search(action.query)
        results.push(research.sources.length > 0
          ? `联网找到 ${research.sources.length} 个来源：${research.sources.map((source) => `[${source.title}](${source.url})`).join('；')}。`
          : '联网搜索没有返回可验证的公开来源。')
        toolResults.push({ action: action.type, research })
      } else if (action.type === 'read_web') {
        if (!this.webResearch) throw new Error('工作助理的网页读取能力尚未初始化。')
        const research = await this.webResearch.read(action.url)
        results.push(`已读取 [${research.sources[0]?.title ?? action.url}](${research.sources[0]?.url ?? action.url})。`)
        toolResults.push({ action: action.type, research })
      } else if (action.type === 'read_latest_briefing') {
        const briefing = this.database.listMorningBriefings().find((item) => item.status === 'completed') ?? null
        results.push(briefing ? `最近一份每日简报是 **${briefing.reportDate}**：“${briefing.headline}”。` : '当前还没有已完成的每日简报。')
        toolResults.push({ action: action.type, briefing })
      } else if (action.type === 'generate_morning_briefing') {
        if (!this.generateMorningBriefing) throw new Error('工作助理的每日简报生成能力尚未初始化。')
        const generated = await this.generateMorningBriefing()
        results.push(`已生成 **${generated.briefing.reportDate}** 每日简报：“${generated.briefing.headline}”。`)
        toolResults.push({ action: action.type, generated })
      }
    }

    const readOnly = actions.every((action) => ['list_projects', 'inspect_project', 'list_agent_runs', 'inspect_agent_run', 'search_web', 'read_web', 'read_latest_briefing'].includes(action.type))
    return {
      content: [proposals.length > 0 ? '### 请确认' : readOnly ? '### 已检查' : '### 已完成', '', ...results.map((result) => `- ${result}`)].join('\n'),
      toolContext: JSON.stringify(toolResults, null, 2).slice(0, 40_000),
      linkedRunId,
      requiresSynthesis: readOnly,
      proposals
    }
  }

  executeProposal(input: ExecuteWorkAssistantActionInput): ExecuteWorkAssistantActionResult {
    const message = this.database.listBriefingMessages().find((item) => item.id === input.messageId)
    if (!message || message.role !== 'assistant') throw new Error('没有找到这条工作助理 Action。')
    const actions = message.actions ?? []
    const proposal = actions.find((item) => item.id === input.proposalId)
    if (!proposal) throw new Error('这个 Action 已不存在。')
    if (proposal.status !== 'pending') throw new Error('这个 Action 已经处理过。')
    const option = proposal.options.find((item) => item.id === input.optionId)
    if (!option) throw new Error('没有找到这个 Action 选项。')
    let navigation: ExecuteWorkAssistantActionResult['navigation'] = null
    let notice = ''
    let linkedRunId: string | null | undefined
    if (option.capability === 'agent-run.open') {
      const run = this.database.listRuns().find((item) => item.id === option.payload.runId)
      if (!run) throw new Error('这个 Agent Run 已归档或不存在，请重新查找。')
      return {
        message,
        navigation: { kind: 'agent-run', id: run.id, draftPrompt: null },
        notice: `已打开“${run.title}”。`
      }
    } else if (option.capability === 'agent-run.create') {
      if (!this.dispatcher) throw new Error('工作助理的 Agent Run 管理能力尚未初始化。')
      const existing = this.database.listRuns().find((run) =>
        run.status !== 'completed'
        && run.status !== 'cancelled'
        && ((option.payload.decisionId && run.decisionId === option.payload.decisionId)
          || (!option.payload.decisionId && run.projectId === option.payload.projectId && run.title === option.payload.title && run.createdAt >= proposal.createdAt))
      )
      const detail = existing ? this.database.getAgentRunDetail(existing.id) : this.dispatcher.createDraft(option.payload)
      if (option.payload.decisionId) {
        this.database.updateDecisionStatus(option.payload.decisionId, 'in_progress', {
          actor: 'agent',
          reason: `已交由 Agent Run“${detail.run.title}”处理。`
        })
      }
      linkedRunId = detail.run.id
      navigation = { kind: 'agent-run', id: detail.run.id, draftPrompt: detail.run.draftPrompt }
      notice = existing
        ? `检测到刚刚创建的“${detail.run.title}”，已直接打开，避免重复创建。`
        : `已创建草稿“${detail.run.title}”，首条消息尚未发送。`
    } else if (option.capability === 'project.create') {
      const project = this.database.createProject(option.payload)
      navigation = { kind: 'project', id: project.id }
      notice = `已创建项目“${project.name}”。`
    }
    const now = new Date().toISOString()
    const updatedActions = actions.map((item) => item.id === proposal.id ? {
      ...item,
      status: 'accepted' as const,
      acceptedOptionId: option.id,
      resolvedAt: now
    } : item)
    const updatedMessage = this.database.updateBriefingMessageActions(message.id, updatedActions, linkedRunId)
    return { message: updatedMessage, notice, navigation }
  }

  private authorize(action: WorkspaceAction): void {
    const target = 'goalId' in action
      ? action.goalId ?? undefined
      : 'decisionId' in action
        ? action.decisionId
        : 'runId' in action
          ? action.runId
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
    return status === 'inbox' ? '待处理' : status === 'in_progress' ? '进行中' : status === 'waiting' ? '等待中' : status === 'ignored' ? '已忽略' : '已完成'
  }
}
