import { BrowserWindow, dialog, ipcMain, shell, systemPreferences } from 'electron'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { DecisionStatus, GoalStatus, PermissionIntent } from '../../shared/contracts'
import { evaluateAggressivePermission } from '../../shared/permissions'
import { createProjectSchema, updateProjectSchema } from '../../shared/project-validation'
import { connectorCatalog } from '../connectors/connector-runtime'
import { listProjectAnalyticsProfileSummaries } from '../analytics/project-analytics-profiles'
import { getCapabilities } from '../services/capabilities'
import { discoverCodingAgentModels } from '../services/coding-agent-models'
import { collectGitWorkingTreeSummary } from '../services/git-working-tree'
import { requestMacMicrophoneAccess } from '../services/microphone-permissions'
import {
  agentEndpointSchema,
  configureConnectorSchema,
  configurePostgresSchema,
  connectorIdSchema,
  connectorToggleSchema,
  createAgentRunDraftSchema,
  createDecisionSchema,
  dispatchProjectAgentSchema,
  dispatchTaskSchema,
  permissionIntentSchema,
  renameAgentRunSchema,
  respondAgentApprovalSchema,
  saveAutomationSchema,
  sendAgentRunMessageSchema,
  ttsEndpointSchema,
  updateDecisionSchema,
  updateAgentRunExecutionSettingsSchema,
  workspacePathSchema,
  workspaceProjectIdSchema,
  workAssistantImageSchema
} from './schemas'
import type { IpcContext } from './context'
import { parseRemoteRunId } from '../services/mac-peer-sync'

export function registerRunIpc(context: IpcContext): void {
  const {
    database,
    dispatcher,
    connectorRuntime,
    decisionRemediationService,
    credentialVault,
    dailyBriefingService,
    morningBriefingService,
    goalTrackingService,
    providerSettings,
    asrService,
    ttsService,
    workspaceFiles,
    automationRuntime,
    projectAgentIntegration,
    companionSync,
    accountEnrollmentCoordinator,
    persistAttachments
  } = context
  ipcMain.handle('task:dispatch', (event, rawInput: unknown) => {
    const input = dispatchTaskSchema.parse(rawInput)
    return dispatcher.dispatch(input, (update) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('agent-run:update', { requestId: input.requestId, runId: '', update })
      }
    })
  })

  ipcMain.handle('agent-run:create-draft', (_event, rawInput: unknown) => {
    const input = createAgentRunDraftSchema.parse(rawInput)
    if (input.executionHostId && input.executionHostId !== context.accountService.getState().device?.hostId && input.executionHostId !== 'local') {
      if (!context.macPeers) throw new Error('跨 Mac 执行尚未连接。')
      return context.macPeers.createDraft(input)
    }
    return dispatcher.createDraft(input)
  })

  ipcMain.handle('agent-run:execution-hosts', async (_event, rawId: unknown) => {
    const id = z.string().trim().min(1).max(200).nullable().parse(rawId)
    await context.macPeers?.syncNow()
    return context.macPeers?.listHosts(id) ?? []
  })

  ipcMain.handle('project-agent:dispatch', (event, rawInput: unknown) => {
    const input = dispatchProjectAgentSchema.parse(rawInput)
    return projectAgentIntegration.dispatch(input, (update) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('agent-run:update', { requestId: input.requestId, runId: '', update })
      }
    })
  })

  ipcMain.handle('agent-run:get', (_event, rawId: unknown) => {
    const id = z.string().trim().min(1).max(200).parse(rawId)
    if (parseRemoteRunId(id)) return context.macPeers!.getDetail(id)
    return dispatcher.getDetail(id)
  })

  ipcMain.handle('agent-run:load-history', (_event, rawId: unknown) => {
    const id = z.string().trim().min(1).max(200).parse(rawId)
    return parseRemoteRunId(id) ? context.macPeers!.loadHistory(id) : dispatcher.getDetail(id)
  })

  ipcMain.handle('agent-run:rename', (_event, rawInput: unknown) => {
    const input = renameAgentRunSchema.parse(rawInput)
    if (parseRemoteRunId(input.id)) return context.macPeers!.mutate(input.id, 'agent.rename-session', { title: input.title }).then((detail) => detail!.run)
    return database.renameAgentRun(input.id, input.title)
  })

  ipcMain.handle('agent-run:update-draft-prompt', (_event, rawInput: unknown) => {
    const input = z
      .object({
        id: z.string().trim().min(1).max(200),
        draftPrompt: z.string().max(20_000)
      })
      .parse(rawInput)
    if (parseRemoteRunId(input.id)) return context.macPeers!.mutate(input.id, 'agent.update-draft-prompt', { draftPrompt: input.draftPrompt }).then((detail) => detail!.run)
    return database.updateAgentRunDraftPrompt(input.id, input.draftPrompt)
  })

  ipcMain.handle('agent-run:archive', (_event, rawId: unknown) => {
    const id = z.string().trim().min(1).max(200).parse(rawId)
    if (parseRemoteRunId(id)) return context.macPeers!.mutate(id, 'agent.archive-session').then(() => undefined)
    database.archiveAgentRun(id)
  })

  ipcMain.handle('agent-run:update-execution-settings', (_event, rawInput: unknown) => {
    const input = updateAgentRunExecutionSettingsSchema.parse(rawInput)
    if (parseRemoteRunId(input.id)) return context.macPeers!.mutate(input.id, 'agent.update-execution-settings', {
      provider: input.provider, model: input.model ?? undefined, reasoningEffort: input.reasoningEffort ?? undefined
    }).then((detail) => detail!.run)
    return database.updateAgentRunExecutionSettings(
      input.id,
      input.provider,
      input.model,
      input.reasoningEffort
    )
  })

  ipcMain.handle('companion:get-status', () => companionSync.getStatus())

  ipcMain.handle('companion:get-relay-configuration', () => ({
    relayUrl: accountEnrollmentCoordinator.getRelayUrl(),
    available: Boolean(accountEnrollmentCoordinator.getRelayUrl())
  }))

  ipcMain.handle('companion:sync-now', () => companionSync.syncNow())

  ipcMain.handle('agent-run:send', (event, rawInput: unknown) => {
    const input = sendAgentRunMessageSchema.parse(rawInput)
    if (parseRemoteRunId(input.runId)) return context.macPeers!.send(input.runId, input.prompt, input.attachments, input.requestId)
    return dispatcher.sendMessage(
      input.runId,
      input.prompt,
      (update) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('agent-run:update', { requestId: input.requestId, runId: input.runId, update })
        }
      },
      input.requestId,
      input.attachments
    )
  })

  ipcMain.handle('agent-run:stop', (_event, rawId: unknown) => {
    const id = z.string().trim().min(1).max(200).parse(rawId)
    if (parseRemoteRunId(id)) return context.macPeers!.mutate(id, 'agent.stop-message')
    return dispatcher.stopMessage(id)
  })

  ipcMain.handle('agent-run:git-summary', async (_event, rawId: unknown) => {
    const id = z.string().trim().min(1).max(200).parse(rawId)
    if (parseRemoteRunId(id)) return { available: false, repoRoot: null, branch: null, head: null, additions: 0, deletions: 0, changedFileCount: 0, changes: [], error: 'Git 工作区位于执行 Mac。' }
    const run = database.getAgentRun(id)
    if (!run) throw new Error('Chat 不存在。')
    if (!run.workingDirectory) {
      return {
        available: false,
        repoRoot: null,
        branch: null,
        head: null,
        additions: 0,
        deletions: 0,
        changedFileCount: 0,
        changes: [],
        error: '当前 Session 没有 Workspace。'
      }
    }
    return collectGitWorkingTreeSummary(run.workingDirectory)
  })

  ipcMain.handle('agent-run:artifact-preview', (_event, rawInput: unknown) => {
    const input = z
      .object({
        runId: z.string().trim().min(1).max(200),
        artifactId: z.string().trim().min(1).max(200)
      })
      .parse(rawInput)
    if (parseRemoteRunId(input.runId)) return context.macPeers!.previewArtifact(input.runId, input.artifactId)
    const artifact = database.getAgentRunArtifact(input.artifactId)
    if (!artifact || artifact.runId !== input.runId) throw new Error('Session 产物不存在。')
    return workspaceFiles.previewArtifact(artifact)
  })

  ipcMain.handle('agent-run:approval', (_event, rawInput: unknown) => {
    const input = respondAgentApprovalSchema.parse(rawInput)
    dispatcher.respondToApproval(input.requestId, input.decision)
  })
}
