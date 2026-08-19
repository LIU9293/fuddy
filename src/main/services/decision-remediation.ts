import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import type {
  AgentRun,
  DecisionRemediation,
  DecisionRemediationState
} from '../../shared/contracts'
import { AppDatabase } from './database'
import { throwIfCancelled } from './cancellation'

const execFileAsync = promisify(execFile)
const GITHUB_PR_PATTERN = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g

interface GithubPullRequestReference {
  owner: string
  repository: string
  number: number
  url: string
}

export interface GithubPullRequestSnapshot extends GithubPullRequestReference {
  title: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  mergedAt: string | null
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  mergeStateStatus: string
  headSha: string
  checks: 'passing' | 'pending' | 'failing' | 'unknown'
  unresolvedReviewThreads: number
  baseRefName?: string
}

export type GithubPullRequestInspector = (
  reference: GithubPullRequestReference,
  cancellationSignal?: AbortSignal
) => Promise<GithubPullRequestSnapshot>

export interface DecisionRemediationSyncResult {
  remediations: DecisionRemediation[]
  errors: string[]
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function parseGithubPullRequestUrl(value: string): GithubPullRequestReference | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/)
    if (!match) return null
    const number = Number(match[3])
    if (!Number.isInteger(number) || number <= 0) return null
    return {
      owner: match[1],
      repository: match[2],
      number,
      url: `https://github.com/${match[1]}/${match[2]}/pull/${number}`
    }
  } catch {
    return null
  }
}

export function extractGithubPullRequestUrls(value: string): string[] {
  const matches = value.match(GITHUB_PR_PATTERN) ?? []
  return [...new Set(matches.flatMap((match) => {
    const parsed = parseGithubPullRequestUrl(match)
    return parsed ? [parsed.url] : []
  }))]
}

function checksState(value: unknown): GithubPullRequestSnapshot['checks'] {
  if (!Array.isArray(value) || value.length === 0) return 'unknown'
  let pending = false
  for (const raw of value) {
    const check = object(raw)
    const state = String(check.conclusion ?? check.state ?? check.status ?? '').toUpperCase()
    if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(state)) {
      return 'failing'
    }
    if (!['SUCCESS', 'NEUTRAL', 'SKIPPED', 'COMPLETED'].includes(state)) pending = true
  }
  return pending ? 'pending' : 'passing'
}

export async function inspectGithubPullRequest(
  reference: GithubPullRequestReference,
  cancellationSignal?: AbortSignal
): Promise<GithubPullRequestSnapshot> {
  throwIfCancelled(cancellationSignal)
  const query = `query($owner:String!,$name:String!,$number:Int!){
    repository(owner:$owner,name:$name){
      pullRequest(number:$number){
        reviewThreads(first:100){nodes{isResolved isOutdated}}
      }
    }
  }`
  const [viewResult, threadsResult] = await Promise.all([
    execFileAsync('gh', [
      'pr', 'view', reference.url,
      '--json', 'title,state,isDraft,mergedAt,mergeable,mergeStateStatus,headRefOid,statusCheckRollup,baseRefName'
    ], { encoding: 'utf8', timeout: 15_000, maxBuffer: 1_000_000, signal: cancellationSignal }),
    execFileAsync('gh', [
      'api', 'graphql',
      '-f', `query=${query}`,
      '-f', `owner=${reference.owner}`,
      '-f', `name=${reference.repository}`,
      '-F', `number=${reference.number}`
    ], { encoding: 'utf8', timeout: 15_000, maxBuffer: 1_000_000, signal: cancellationSignal })
  ])
  throwIfCancelled(cancellationSignal)
  const view = object(JSON.parse(viewResult.stdout) as unknown)
  const threads = object(object(object(JSON.parse(threadsResult.stdout) as unknown).data).repository)
  const reviewThreads = object(object(threads.pullRequest).reviewThreads).nodes
  const unresolvedReviewThreads = Array.isArray(reviewThreads)
    ? reviewThreads.filter((raw) => {
        const thread = object(raw)
        return thread.isResolved !== true && thread.isOutdated !== true
      }).length
    : 0
  const state = String(view.state).toUpperCase()
  return {
    ...reference,
    title: String(view.title ?? `PR #${reference.number}`),
    state: state === 'MERGED' ? 'MERGED' : state === 'CLOSED' ? 'CLOSED' : 'OPEN',
    isDraft: view.isDraft === true,
    mergedAt: typeof view.mergedAt === 'string' ? view.mergedAt : null,
    mergeable: ['MERGEABLE', 'CONFLICTING'].includes(String(view.mergeable))
      ? String(view.mergeable) as 'MERGEABLE' | 'CONFLICTING'
      : 'UNKNOWN',
    mergeStateStatus: String(view.mergeStateStatus ?? 'UNKNOWN'),
    headSha: String(view.headRefOid ?? ''),
    checks: checksState(view.statusCheckRollup),
    unresolvedReviewThreads,
    baseRefName: typeof view.baseRefName === 'string' ? view.baseRefName : undefined
  }
}

function remediationState(snapshot: GithubPullRequestSnapshot): DecisionRemediationState {
  if (snapshot.state === 'MERGED' || snapshot.mergedAt) return 'merged_awaiting_deploy'
  if (snapshot.state === 'CLOSED') return 'blocked'
  if (snapshot.mergeable === 'CONFLICTING' || snapshot.checks === 'failing') return 'blocked'
  if (snapshot.unresolvedReviewThreads > 0) return 'review_required'
  if (snapshot.isDraft || snapshot.checks === 'pending') return 'in_progress'
  if (snapshot.mergeable === 'MERGEABLE' && snapshot.checks === 'passing') return 'ready_to_merge'
  return 'in_progress'
}

function stateCopy(
  snapshot: GithubPullRequestSnapshot,
  state: DecisionRemediationState
): Pick<DecisionRemediation, 'summary' | 'nextAction'> {
  const label = `PR #${snapshot.number}`
  const ci = snapshot.checks === 'passing'
    ? 'CI 已通过'
    : snapshot.checks === 'failing'
      ? 'CI 未通过'
      : snapshot.checks === 'pending'
        ? 'CI 仍在运行'
        : '暂未发现可核验的 CI 状态'
  if (state === 'review_required') {
    return {
      summary: `${label} 已提交，${ci}；仍有 ${snapshot.unresolvedReviewThreads} 条当前 Review 意见待处理。`,
      nextAction: `处理 ${label} 的 ${snapshot.unresolvedReviewThreads} 条当前 Review 意见，然后重新确认 CI 与可合并状态。`
    }
  }
  if (state === 'ready_to_merge') {
    return {
      summary: `${label} ${ci}且当前可合并，修复尚未进入生产。`,
      nextAction: `合并 ${label}，完成发布和数据迁移后复查生产异常。`
    }
  }
  if (state === 'merged_awaiting_deploy') {
    return {
      summary: `${label} 已合并，代码处理已经完成，但业务问题仍需等待部署和生产验证。`,
      nextAction: `等待 ${label} 进入生产，然后由最新巡检验证问题是否真正解除。`
    }
  }
  if (state === 'blocked') {
    const reason = snapshot.state === 'CLOSED'
      ? '已关闭但未合并'
      : snapshot.mergeable === 'CONFLICTING'
        ? '存在合并冲突'
        : ci
    return {
      summary: `${label} 当前受阻：${reason}。`,
      nextAction: `解除 ${label} 的阻塞并重新核验 Review、CI 与可合并状态。`
    }
  }
  return {
    summary: `${label} 正在推进；${ci}，尚未满足合并并验证生产结果的条件。`,
    nextAction: `继续推进 ${label}，直到 Review、CI 和可合并状态全部通过。`
  }
}

function linkedRunContent(database: AppDatabase, run: AgentRun): string {
  const assistantMessages = database.listAgentRunMessages(run.id)
    .filter((message) => message.role === 'assistant' && message.eventType !== 'reasoning')
    .map((message) => message.content)
  return [run.summary, ...assistantMessages].join('\n')
}

function reconcileDecisionStatus(database: AppDatabase, decisionId: string): void {
  const decision = database.listDecisions().find((item) => item.id === decisionId)
  if (!decision || decision.status === 'resolved' || decision.status === 'ignored') return
  const remediations = database.listDecisionRemediations(decisionId)
  if (remediations.length === 0) return
  const unfinished = remediations.filter((item) => item.state !== 'merged_awaiting_deploy')
  if (unfinished.length > 0) {
    const priority: Record<DecisionRemediationState, number> = {
      blocked: 0,
      review_required: 1,
      in_progress: 2,
      ready_to_merge: 3,
      investigating: 4,
      merged_awaiting_deploy: 5
    }
    const current = [...unfinished].sort((left, right) => priority[left.state] - priority[right.state])[0]
    database.updateDecisionStatus(decisionId, 'in_progress', {
      actor: 'system',
      reason: current.summary,
      evidenceRefs: current.evidenceRefs,
      occurredAt: current.lastSeenAt
    })
    return
  }
  const productionMerged = remediations.some((item) => item.metadata.baseRefName === 'production')
  const latestProductionMerge = remediations
    .filter((item) => item.metadata.baseRefName === 'production' && typeof item.metadata.mergedAt === 'string')
    .map((item) => String(item.metadata.mergedAt))
    .sort((left, right) => right.localeCompare(left))[0] ?? null
  const latest = [...remediations].sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))[0]
  if (latestProductionMerge && (decision.lastSeenAt ?? decision.createdAt) > latestProductionMerge) {
    database.updateDecisionStatus(decisionId, 'in_progress', {
      actor: 'system',
      reason: `生产部署后的最新巡检仍发现问题：${decision.summary}`,
      evidenceRefs: decision.evidenceRefs,
      occurredAt: decision.lastSeenAt ?? latest.lastSeenAt
    })
    return
  }
  database.updateDecisionStatus(decisionId, 'waiting', {
    actor: 'system',
    waitingReason: productionMerged ? 'verification' : 'deployment',
    reason: productionMerged
      ? '生产发布已合并，等待最新生产巡检验证问题是否真正解除。'
      : '代码修复已合并，等待进入生产环境。',
    evidenceRefs: latest.evidenceRefs,
    occurredAt: latest.lastSeenAt
  })
}

export class DecisionRemediationService {
  constructor(
    private readonly database: AppDatabase,
    private readonly inspectPullRequest: GithubPullRequestInspector = inspectGithubPullRequest
  ) {}

  async sync(
    projectId: string | null = null,
    cancellationSignal?: AbortSignal
  ): Promise<DecisionRemediationSyncResult> {
    throwIfCancelled(cancellationSignal)
    const now = new Date().toISOString()
    const decisions = new Map(this.database.listDecisions().map((decision) => [decision.id, decision]))
    const runs = this.database.listRuns().filter((run) =>
      Boolean(run.decisionId) && (!projectId || run.projectId === projectId))

    for (const run of runs) {
      throwIfCancelled(cancellationSignal)
      const decision = run.decisionId ? decisions.get(run.decisionId) : null
      if (!decision) continue
      for (const url of extractGithubPullRequestUrls(linkedRunContent(this.database, run))) {
        const existing = this.database.listDecisionRemediations(decision.id)
          .find((item) => item.sourceType === 'github-pr' && item.sourceRef === url)
        const reference = parseGithubPullRequestUrl(url)
        if (!reference) continue
        this.database.upsertDecisionRemediation({
          id: existing?.id ?? randomUUID(),
          decisionId: decision.id,
          sourceType: 'github-pr',
          sourceRef: url,
          state: existing?.state ?? 'investigating',
          summary: existing?.summary ?? `Agent Run「${run.title}」已关联 PR #${reference.number}，等待 GitHub 实时状态核验。`,
          nextAction: existing?.nextAction ?? `核验 PR #${reference.number} 的 Review、CI 和可合并状态。`,
          evidenceRefs: existing?.evidenceRefs ?? [{ label: `GitHub PR #${reference.number}`, uri: url }],
          metadata: { ...(existing?.metadata ?? {}), runId: run.id },
          firstSeenAt: existing?.firstSeenAt ?? run.updatedAt,
          lastSeenAt: existing?.lastSeenAt ?? run.updatedAt
        })
      }
    }

    const errors: string[] = []
    const linked = this.database.listDecisionRemediations()
      .filter((item) => item.sourceType === 'github-pr')
      .filter((item) => {
        if (!projectId) return true
        return decisions.get(item.decisionId)?.projectId === projectId
      })
    for (const remediation of linked) {
      throwIfCancelled(cancellationSignal)
      const reference = parseGithubPullRequestUrl(remediation.sourceRef)
      if (!reference) continue
      try {
        const snapshot = await this.inspectPullRequest(reference, cancellationSignal)
        throwIfCancelled(cancellationSignal)
        const state = remediationState(snapshot)
        const copy = stateCopy(snapshot, state)
        const verifiedRemediation: DecisionRemediation = {
          ...remediation,
          state,
          ...copy,
          evidenceRefs: [{ label: `GitHub PR #${snapshot.number}`, uri: snapshot.url }],
          metadata: {
            ...remediation.metadata,
            repository: `${snapshot.owner}/${snapshot.repository}`,
            number: snapshot.number,
            title: snapshot.title,
            headSha: snapshot.headSha,
            checks: snapshot.checks,
            unresolvedReviewThreads: snapshot.unresolvedReviewThreads,
            mergeable: snapshot.mergeable,
            mergeStateStatus: snapshot.mergeStateStatus,
            isDraft: snapshot.isDraft,
            githubState: snapshot.state,
            mergedAt: snapshot.mergedAt,
            baseRefName: snapshot.baseRefName ?? null
          },
          lastSeenAt: now
        }
        this.database.upsertDecisionRemediation(verifiedRemediation)
      } catch (error) {
        throwIfCancelled(cancellationSignal)
        errors.push(error instanceof Error
          ? `${reference.owner}/${reference.repository}#${reference.number}: ${error.message}`
          : `${reference.owner}/${reference.repository}#${reference.number}: GitHub 状态核验失败`)
      }
    }

    for (const decisionId of new Set(linked.map((item) => item.decisionId))) {
      throwIfCancelled(cancellationSignal)
      reconcileDecisionStatus(this.database, decisionId)
    }

    return { remediations: this.database.listDecisionRemediations(), errors }
  }
}
