import { z } from 'zod'

export const projectProfileSchema = z.object({
  productType: z.string().trim().min(1).max(200),
  stage: z.string().trim().min(1).max(200),
  mission: z.string().trim().min(1).max(2_000),
  vision: z.string().trim().min(1).max(2_000),
  repoPath: z.string().trim().max(2_000),
  workspaceRoots: z.array(z.object({
    id: z.string().trim().min(1).max(100),
    label: z.string().trim().min(1).max(200),
    path: z.string().trim().min(1).max(2_000)
  })).max(12),
  primaryWorkspaceRootId: z.string().trim().min(1).max(100).nullable(),
  defaultAgent: z.enum(['pi', 'codex', 'claude', 'opencode']),
  websiteUrl: z.url().nullable(),
  surfaces: z.array(z.string().trim().min(1).max(200)).max(30),
  focusAreas: z.array(z.string().trim().min(1).max(200)).max(30),
  dataSources: z.array(z.string().trim().min(1).max(300)).max(50),
  nextMoves: z.array(z.string().trim().min(1).max(500)).max(30),
  currentState: z.object({
    summary: z.string().trim().min(1).max(2_000),
    facts: z.array(z.string().trim().min(1).max(500)).max(30),
    source: z.enum(['user', 'agent', 'connector']),
    updatedAt: z.iso.datetime().nullable()
  })
})

export const updateProjectSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(2_000),
  focus: z.string().trim().min(1).max(500),
  status: z.enum(['active', 'watching', 'paused']),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  profile: projectProfileSchema
})

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(2_000),
  focus: z.string().trim().min(1).max(500),
  mission: z.string().trim().min(1).max(2_000),
  vision: z.string().trim().min(1).max(2_000),
  productType: z.string().trim().min(1).max(200),
  stage: z.string().trim().min(1).max(200),
  websiteUrl: z.url().nullable().optional(),
  workspacePath: z.string().trim().max(2_000).nullable().optional(),
  defaultAgent: z.enum(['pi', 'codex', 'claude', 'opencode']).optional()
})
