import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ProjectAnalyticsMetric, ProjectAnalyticsProfileSummary } from '../../shared/contracts'

export type ProjectAgentIntegration =
  | {
      kind: 'repo-skill'
      skillPath: string
      workspacePath: string
      provider: 'codex'
      approvalBoundary: string
    }
  | {
      kind: 'http-super-agent'
      threadPath: string
      chatPath: string
      workspace: 'global' | 'image'
      approvalBoundary: string
    }

export interface ProjectAnalyticsProfile {
  id: string
  version: 1
  projectId: string
  projectName: string
  timezone: 'Asia/Shanghai'
  objective: string
  funnel: string[]
  metrics: ProjectAnalyticsMetric[]
  requiredConnectors: Array<'postgres' | 'repo' | 'project-agent'>
  recommendedConnectors: Array<'cloudflare' | 'ga4'>
  decisionRules: string[]
  agentIntegration: ProjectAgentIntegration
}

const metricSchema = z.object({
  key: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(200),
  funnelStage: z.string().trim().min(1).max(200),
  source: z.string().trim().min(1).max(500),
  unit: z.string().trim().min(1).max(50)
})

const profileSchema = z.object({
  id: z.string().trim().min(1).max(200),
  version: z.literal(1),
  projectId: z.string().trim().min(1).max(200),
  projectName: z.string().trim().min(1).max(200),
  timezone: z.literal('Asia/Shanghai'),
  objective: z.string().trim().min(1).max(2_000),
  funnel: z.array(z.string().trim().min(1).max(200)).max(50),
  metrics: z.array(metricSchema).max(200),
  requiredConnectors: z.array(z.enum(['postgres', 'repo', 'project-agent'])).max(10),
  recommendedConnectors: z.array(z.enum(['cloudflare', 'ga4'])).max(10),
  decisionRules: z.array(z.string().trim().min(1).max(1_000)).max(50),
  agentIntegration: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('repo-skill'),
      skillPath: z.string().trim().min(1).max(2_000),
      workspacePath: z.string().trim().min(1).max(2_000),
      provider: z.literal('codex'),
      approvalBoundary: z.string().trim().min(1).max(2_000)
    }),
    z.object({
      kind: z.literal('http-super-agent'),
      threadPath: z.string().trim().min(1).max(2_000),
      chatPath: z.string().trim().min(1).max(2_000),
      workspace: z.enum(['global', 'image']),
      approvalBoundary: z.string().trim().min(1).max(2_000)
    })
  ])
})

const profiles = new Map<string, ProjectAnalyticsProfile>()

export function registerProjectAnalyticsProfile(profile: ProjectAnalyticsProfile): void {
  const parsed = profileSchema.parse(profile) as ProjectAnalyticsProfile
  const conflicting = [...profiles.values()].find((candidate) =>
    candidate.projectId === parsed.projectId && candidate.id !== parsed.id
  )
  if (conflicting) {
    throw new Error(`项目 ${parsed.projectId} 已注册 Analytics Profile：${conflicting.id}`)
  }
  profiles.set(parsed.id, parsed)
}

/**
 * Loads declarative project capabilities without changing contracts, IPC, or
 * Renderer code. A malformed profile fails startup with its filename so the
 * product never silently advertises a partially valid capability.
 */
export function loadProjectAnalyticsProfiles(directory: string): number {
  let loaded = 0
  for (const filename of readdirSync(directory, { withFileTypes: true })) {
    if (!filename.isFile() || !filename.name.endsWith('.json')) continue
    try {
      registerProjectAnalyticsProfile(JSON.parse(readFileSync(join(directory, filename.name), 'utf8')) as unknown as ProjectAnalyticsProfile)
      loaded += 1
    } catch (error) {
      throw new Error(`Analytics Profile ${filename.name} 无效。`, { cause: error })
    }
  }
  return loaded
}

export function listProjectAnalyticsProfiles(): ProjectAnalyticsProfile[] {
  return [...profiles.values()].map((profile) => ({ ...profile, metrics: profile.metrics.map((metric) => ({ ...metric })) }))
}

export function getProjectAnalyticsProfile(projectId: string): ProjectAnalyticsProfile | null {
  return listProjectAnalyticsProfiles().find((profile) => profile.projectId === projectId) ?? null
}

export function requireAnalyticsProfile(id: string, projectId?: string): ProjectAnalyticsProfile {
  const profile = listProjectAnalyticsProfiles().find((candidate) => candidate.id === id)
  if (!profile || (projectId && profile.projectId !== projectId)) {
    throw new Error(`未知或不匹配的 Analytics Profile：${id}`)
  }
  return profile
}

export function listProjectAnalyticsProfileSummaries(): ProjectAnalyticsProfileSummary[] {
  return listProjectAnalyticsProfiles().map((profile) => ({
    id: profile.id,
    version: profile.version,
    projectId: profile.projectId,
    projectName: profile.projectName,
    timezone: profile.timezone,
    objective: profile.objective,
    funnel: [...profile.funnel],
    metrics: profile.metrics.map((metric) => ({ ...metric })),
    requiredConnectors: [...profile.requiredConnectors],
    recommendedConnectors: [...profile.recommendedConnectors],
    decisionRules: [...profile.decisionRules],
    agentKind: profile.agentIntegration.kind,
    agentLabel: profile.agentIntegration.kind === 'repo-skill'
      ? `Repo Skill · ${profile.agentIntegration.skillPath}`
      : `Super Agent · ${profile.agentIntegration.chatPath}`,
    approvalBoundary: profile.agentIntegration.approvalBoundary
  }))
}
