import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  AutomationJob,
  AutomationRun,
  AgentRun,
  AgentRunArtifact,
  AgentRunDetail,
  AgentRunMessage,
  AppBootstrapDataKey,
  AppBootstrapPatch,
  AppBootstrap,
  AuditEntry,
  BriefingMessage,
  Capability,
  ConnectorInstance,
  ConnectorRun,
  ConnectorRunStatus,
  CreateProjectInput,
  CreateDecisionInput,
  CredentialStorageStatus,
  DailyBriefing,
  DecisionItem,
  DecisionRemediation,
  DecisionStatus,
  DecisionWaitingReason,
  EvidenceRef,
  GoalCheckIn,
  GoalMilestone,
  GoalMilestoneStatus,
  GoalPriority,
  GoalStatus,
  MorningBriefing,
  PermissionEvaluation,
  PermissionIntent,
  ProviderSettings,
  Project,
  ProjectAnalyticsProfileSummary,
  ProjectGoal,
  WorkAssistantActionProposal,
  WorkAssistantTaskContext
} from '../../shared/contracts'
import type { ConnectorCatalogItem } from '../../shared/contracts'
import { normalizeWorkspaceRoots } from '../../shared/project-workspaces'
import { companionEventDefinitions, companionProtocolVersion } from '../../shared/companion-sync'
import type { CompanionChatKind, CompanionChatPage } from '../../shared/companion-sync'
import {
  buildAgentChatRecords,
  buildWorkAssistantChatRecords,
  companionInitialChatBlockLimit,
  companionMaximumChatPageLimit,
  flattenAgentChatRecords,
  workAssistantChatId,
  workAssistantPageCollections
} from '../../shared/companion-chat'
import { emptyAgentModelLabels, type AgentModelLabels } from '../../shared/model-display'
import { databaseSchemaVersion, runDatabaseMigrations, type DatabaseMigration } from './database-migrations'
import { ensureCurrentDatabaseSchema } from './database-schema'
import { ProjectRepository } from '../features/projects/project-repository'
import { GoalRepository } from '../features/goals/goal-repository'
import { RunRepository } from '../features/runs/run-repository'
import { ConnectorRepository } from '../features/connectors/connector-repository'
import { BriefingRepository } from '../features/briefings/briefing-repository'
import { AutomationRepository } from '../features/automations/automation-repository'
import {
  CompanionRepository,
  compactPersistedCompanionCommandEvent,
  companionCommandForOutbox
} from '../features/companion/companion-repository'
import {
  DecisionRepository,
  type DecisionInspectionInput,
  type DecisionInspectionResult,
  type DecisionStatusTransitionInput
} from '../features/decisions/decision-repository'
export type {
  DecisionInspectionInput,
  DecisionInspectionResult,
  DecisionStatusTransitionInput
} from '../features/decisions/decision-repository'
import type {
  AgentTurnSettledPayload,
  CompanionCommand,
  CompanionCommandStatus,
  CompanionEntityType,
  CompanionOutboxPayloadMap,
  CompanionEventType,
  CompanionOutboxEvent,
  CompanionSnapshotPayload
} from '../../shared/companion-sync'

type SqlRow = Record<string, string | number | null>

export interface AppDatabaseOptions {
  /**
   * Explicit bootstrap data for imports, demos, and tests. Production callers
   * intentionally omit this so a clean install starts with no private projects.
   */
  initialProjects?: Project[]
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback

  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export class AppDatabase {
  private readonly database: DatabaseSync
  private readonly projects: ProjectRepository
  private readonly goals: GoalRepository
  private readonly runs: RunRepository
  private readonly connectors: ConnectorRepository
  private readonly briefings: BriefingRepository
  private readonly automations: AutomationRepository
  private readonly companion: CompanionRepository
  private readonly decisions: DecisionRepository

  constructor(path: string, options: AppDatabaseOptions = {}) {
    mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path)
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.projects = new ProjectRepository(
      this.database,
      (operation) => this.companionTransaction(operation),
      (type, project) => this.enqueueCompanionEvent(type, 'project', project.id, project)
    )
    this.goals = new GoalRepository(
      this.database,
      (operation) => this.companionTransaction(operation),
      (type, goal) => this.enqueueCompanionEvent(type, 'goal', goal.id, goal),
      (runId) => {
        const run = this.getAgentRun(runId)
        this.enqueueCompanionEvent('agent-run.updated', 'agent-run', run.id, run)
      }
    )
    this.runs = new RunRepository(
      this.database,
      (operation) => this.companionTransaction(operation),
      (event) =>
        this.enqueueCompanionEvent(
          event.type as CompanionEventType,
          event.entityType,
          event.entityId,
          event.payload as never
        )
    )
    this.connectors = new ConnectorRepository(this.database)
    this.briefings = new BriefingRepository(
      this.database,
      (operation) => this.companionTransaction(operation),
      (event) => this.enqueueCompanionEvent(event.type, event.entityType, event.entityId, event.payload as never)
    )
    this.automations = new AutomationRepository(this.database)
    this.decisions = new DecisionRepository(
      this.database,
      (operation) => this.companionTransaction(operation),
      (type, decision) => this.enqueueCompanionEvent(type, 'decision', decision.id, decision)
    )
    const migrations: DatabaseMigration[] = [
      {
        version: 1,
        name: 'baseline-schema',
        apply: () => ensureCurrentDatabaseSchema(this.database)
      },
      {
        version: 2,
        name: 'normalize-project-workspaces',
        apply: () => {
          this.migrateProjectWorkspaceProfiles()
          this.migrateAgentRunWorkspaces()
        }
      },
      {
        version: 3,
        name: 'normalize-decision-lifecycles',
        apply: () => this.decisions.migrateLifecycle()
      },
      {
        version: 4,
        name: 'add-agent-run-execution-settings',
        apply: () => ensureCurrentDatabaseSchema(this.database)
      },
      {
        version: 5,
        name: 'add-companion-chat-page-indexes',
        apply: () => ensureCurrentDatabaseSchema(this.database)
      },
      {
        version: 6,
        name: 'repair-companion-outbox-delivery',
        apply: () => this.migrateCompanionOutboxDelivery()
      }
    ]
    const currentVersion = databaseSchemaVersion(this.database)
    const latestVersion = migrations.at(-1)?.version ?? 0
    if (currentVersion > latestVersion) {
      this.database.close()
      throw new Error(`Database schema version ${currentVersion} is newer than this app supports (${latestVersion}).`)
    }
    // Legacy version-0 databases need the schema before seed cleanup can run.
    // Data normalization remains after seed, preserving the historical startup
    // order while every step is now independently versioned and transactional.
    if (currentVersion === 0) runDatabaseMigrations(this.database, [migrations[0]])
    this.seed(options.initialProjects ?? [])
    runDatabaseMigrations(this.database, migrations)
    this.companion = new CompanionRepository(this.database)
  }

  close(): void {
    this.companion.close()
    this.database.close()
  }

  onCompanionEventEnqueued(listener: () => void): () => void {
    return this.companion.onEnqueued(listener)
  }

  getBootstrap(
    capabilities: Capability[],
    connectorCatalog: ConnectorCatalogItem[],
    analyticsProfiles: ProjectAnalyticsProfileSummary[],
    credentialStorage: CredentialStorageStatus,
    providerSettings: ProviderSettings
  ): AppBootstrap {
    return {
      projects: this.listProjects(),
      goals: this.listGoals(),
      decisions: this.listDecisions(),
      decisionRemediations: this.listDecisionRemediations(),
      runs: this.listRuns(),
      connectors: this.listConnectors(),
      connectorRuns: this.listConnectorRuns(),
      dailyBriefings: this.listDailyBriefings(),
      morningBriefings: this.listMorningBriefings(),
      briefingMessages: this.listBriefingMessages(),
      automations: this.listAutomations(),
      automationRuns: this.listAutomationRuns(),
      providerSettings,
      connectorCatalog,
      analyticsProfiles,
      capabilities,
      credentialStorage,
      permissionMode: 'full-access'
    }
  }

  getBootstrapPatch(
    keys: readonly AppBootstrapDataKey[],
    capabilities: Capability[],
    connectorCatalog: ConnectorCatalogItem[],
    analyticsProfiles: ProjectAnalyticsProfileSummary[],
    credentialStorage: CredentialStorageStatus,
    providerSettings: ProviderSettings
  ): AppBootstrapPatch {
    const patch: AppBootstrapPatch = {}
    for (const key of keys) {
      switch (key) {
        case 'projects': patch.projects = this.listProjects(); break
        case 'goals': patch.goals = this.listGoals(); break
        case 'decisions': patch.decisions = this.listDecisions(); break
        case 'decisionRemediations': patch.decisionRemediations = this.listDecisionRemediations(); break
        case 'runs': patch.runs = this.listRuns(); break
        case 'connectors': patch.connectors = this.listConnectors(); break
        case 'connectorRuns': patch.connectorRuns = this.listConnectorRuns(); break
        case 'dailyBriefings': patch.dailyBriefings = this.listDailyBriefings(); break
        case 'morningBriefings': patch.morningBriefings = this.listMorningBriefings(); break
        case 'briefingMessages': patch.briefingMessages = this.listBriefingMessages(); break
        case 'automations': patch.automations = this.listAutomations(); break
        case 'automationRuns': patch.automationRuns = this.listAutomationRuns(); break
        case 'providerSettings': patch.providerSettings = providerSettings; break
        case 'connectorCatalog': patch.connectorCatalog = connectorCatalog; break
        case 'analyticsProfiles': patch.analyticsProfiles = analyticsProfiles; break
        case 'capabilities': patch.capabilities = capabilities; break
        case 'credentialStorage': patch.credentialStorage = credentialStorage; break
        case 'permissionMode': patch.permissionMode = 'full-access'; break
      }
    }
    return patch
  }

  listProjects(): Project[] {
    return this.projects.list()
  }

  updateProject(project: Project): Project {
    return this.projects.update(project)
  }

  createProject(input: CreateProjectInput): Project {
    return this.projects.create(input)
  }

  listGoals(projectId?: string): ProjectGoal[] {
    return this.goals.list(projectId)
  }

  getGoal(id: string): ProjectGoal {
    return this.goals.get(id)
  }

  createGoal(goal: ProjectGoal): ProjectGoal {
    return this.goals.create(goal)
  }

  updateGoalTracking(input: {
    id: string
    status: GoalStatus
    progress: number
    metric: ProjectGoal['metric']
    confidence: number
    agentSummary: string
    nextCheckInAt: string | null
  }): ProjectGoal {
    return this.goals.updateTracking(input)
  }

  updateGoalStatus(id: string, status: GoalStatus): ProjectGoal {
    return this.goals.updateStatus(id, status)
  }

  updateGoalPriority(id: string, priority: GoalPriority): ProjectGoal {
    return this.goals.updatePriority(id, priority)
  }

  updateGoalMilestones(goalId: string, updates: Array<{ title: string; status: GoalMilestoneStatus }>): void {
    return this.goals.updateMilestones(goalId, updates)
  }

  completeGoalMilestone(goalId: string, milestoneId: string): ProjectGoal {
    return this.goals.completeMilestone(goalId, milestoneId)
  }

  deleteGoalMilestone(goalId: string, milestoneId: string): ProjectGoal {
    return this.goals.deleteMilestone(goalId, milestoneId)
  }

  createGoalCheckIn(checkIn: GoalCheckIn): GoalCheckIn {
    return this.goals.createCheckIn(checkIn)
  }

  listDecisions(): DecisionItem[] {
    return this.decisions.list()
  }

  listDecisionRemediations(decisionId?: string): DecisionRemediation[] {
    return this.decisions.listRemediations(decisionId)
  }

  upsertDecisionRemediation(remediation: DecisionRemediation): DecisionRemediation {
    return this.decisions.upsertRemediation(remediation)
  }

  listRuns(): AgentRun[] {
    return this.runs.list()
  }

  getAgentRun(id: string): AgentRun {
    return this.runs.get(id)
  }

  getAgentRunDetail(id: string): AgentRunDetail {
    return this.runs.getDetail(id)
  }

  renameAgentRun(id: string, title: string): AgentRun {
    return this.runs.rename(id, title)
  }

  updateAgentRunDraftPrompt(id: string, draftPrompt: string): AgentRun {
    return this.runs.updateDraftPrompt(id, draftPrompt)
  }

  updateAgentRunExecutionSettings(
    id: string,
    provider: AgentRun['provider'],
    model: string | null,
    reasoningEffort: string | null
  ): AgentRun {
    return this.runs.updateExecutionSettings(id, provider, model, reasoningEffort)
  }

  archiveAgentRun(id: string): void {
    return this.runs.archive(id)
  }

  listAgentRunMessages(runId: string): AgentRunMessage[] {
    return this.runs.listMessages(runId)
  }

  listAgentRunArtifacts(runId: string): AgentRunArtifact[] {
    return this.runs.listArtifacts(runId)
  }

  getAgentRunArtifact(id: string): AgentRunArtifact | null {
    return this.runs.getArtifact(id)
  }

  listConnectors(): ConnectorInstance[] {
    return this.connectors.list()
  }

  getConnector(id: string): ConnectorInstance {
    return this.connectors.get(id)
  }

  listConnectorRuns(): ConnectorRun[] {
    return this.connectors.listRuns()
  }

  listDailyBriefings(): DailyBriefing[] {
    return this.briefings.listDaily()
  }

  getDailyBriefing(projectId: string, reportDate: string): DailyBriefing | null {
    return this.briefings.getDaily(projectId, reportDate)
  }

  upsertDailyBriefing(briefing: DailyBriefing): DailyBriefing {
    return this.briefings.upsertDaily(briefing)
  }

  listMorningBriefings(): MorningBriefing[] {
    return this.briefings.listMorning()
  }

  getMorningBriefing(reportDate: string): MorningBriefing | null {
    return this.briefings.getMorning(reportDate)
  }

  getMorningBriefingById(id: string): MorningBriefing | null {
    return this.briefings.getMorningById(id)
  }

  upsertMorningBriefing(briefing: MorningBriefing): MorningBriefing {
    return this.briefings.upsertMorning(briefing)
  }

  listBriefingMessages(briefingId?: string): BriefingMessage[] {
    return this.briefings.listMessages(briefingId)
  }

  getBriefingMessage(id: string): BriefingMessage | null {
    return this.briefings.getMessage(id)
  }

  createBriefingMessage(message: BriefingMessage): BriefingMessage {
    return this.briefings.createMessage(message)
  }

  updateBriefingMessageActions(
    messageId: string,
    actions: WorkAssistantActionProposal[],
    linkedRunId?: string | null
  ): BriefingMessage {
    return this.briefings.updateMessageActions(messageId, actions, linkedRunId)
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.database.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key) as
      SqlRow | undefined
    return row ? parseJson<T>(String(row.value_json), fallback) : fallback
  }

  setSetting<T>(key: string, value: T): void {
    this.database
      .prepare(
        `
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `
      )
      .run(key, JSON.stringify(value), new Date().toISOString())
  }

  listAutomations(): AutomationJob[] {
    return this.automations.list()
  }

  getAutomation(id: string): AutomationJob {
    return this.automations.get(id)
  }

  saveAutomation(job: AutomationJob): AutomationJob {
    return this.automations.save(job)
  }

  setAutomationEnabled(id: string, enabled: boolean, nextRunAt: string | null): AutomationJob {
    return this.automations.setEnabled(id, enabled, nextRunAt)
  }

  updateAutomationRuntime(
    id: string,
    input: Pick<AutomationJob, 'status' | 'lastRunAt' | 'nextRunAt' | 'lastError'>
  ): AutomationJob {
    return this.automations.updateRuntime(id, input)
  }

  listAutomationRuns(automationId?: string): AutomationRun[] {
    return this.automations.listRuns(automationId)
  }

  getAutomationRun(id: string): AutomationRun {
    return this.automations.getRun(id)
  }

  saveAutomationRun(run: AutomationRun): AutomationRun {
    return this.automations.saveRun(run)
  }

  recoverInterruptedAutomations(recoveredAt: string): void {
    this.automations.recoverInterrupted(recoveredAt)
  }

  setConnectorEnabled(id: string, enabled: boolean): ConnectorInstance {
    return this.connectors.setEnabled(id, enabled)
  }

  upsertConnector(input: {
    id: string
    projectId: string
    kind: ConnectorInstance['kind']
    name: string
    config: Record<string, string | number | boolean>
    credentialRef: string | null
    capabilities: string[]
    sortOrder: number
  }): ConnectorInstance {
    return this.connectors.upsert(input)
  }

  markConnectorRunning(id: string, checkedAt: string): ConnectorInstance {
    return this.connectors.markRunning(id, checkedAt)
  }

  completeConnector(
    id: string,
    status: 'connected' | 'error',
    completedAt: string,
    error: string | null
  ): ConnectorInstance {
    return this.connectors.complete(id, status, completedAt, error)
  }

  createConnectorRun(run: ConnectorRun): void {
    this.connectors.createRun(run)
  }

  insertDecisionIfAbsent(item: DecisionItem): DecisionItem | null {
    return this.decisions.insertIfAbsent(item)
  }

  upsertOpenDecisionSignal(item: DecisionItem): {
    decision: DecisionItem
    created: boolean
  } {
    return this.decisions.upsertOpenSignal(item)
  }

  applyDecisionInspection(input: DecisionInspectionInput): DecisionInspectionResult {
    return this.decisions.applyInspection(input)
  }

  createDecision(input: CreateDecisionInput): DecisionItem {
    return this.decisions.create(input)
  }

  updateDecisionStatus(
    id: string,
    status: DecisionStatus,
    transition: DecisionStatusTransitionInput = { actor: 'user' }
  ): DecisionItem {
    return this.decisions.updateStatus(id, status, transition)
  }

  completeDecisionWithEvidence(
    id: string,
    resolutionSummary: string,
    evidenceRefs: EvidenceRef[],
    completionKey: string,
    resolvedAt = new Date().toISOString()
  ): DecisionItem {
    return this.decisions.completeWithEvidence(id, resolutionSummary, evidenceRefs, completionKey, resolvedAt)
  }

  createAgentRun(run: AgentRun): AgentRun {
    return this.runs.create(run)
  }

  updateAgentRun(run: AgentRun): AgentRun {
    return this.runs.update(run)
  }

  recoverInterruptedAgentRuns(recoveredAt: string): number {
    return this.runs.recoverInterrupted(recoveredAt)
  }

  createAgentRunMessage(message: AgentRunMessage): AgentRunMessage {
    return this.runs.createMessage(message)
  }

  upsertAgentRunArtifact(artifact: AgentRunArtifact): AgentRunArtifact {
    return this.runs.upsertArtifact(artifact)
  }

  enqueueCompanionSnapshot(modelLabels: AgentModelLabels = emptyAgentModelLabels): CompanionOutboxEvent {
    const assistantPage = this.getCompanionChatPage('assistant', workAssistantChatId)
    const assistantCollections = workAssistantPageCollections(assistantPage)
    const runDetails = this.listRuns().map((run) => {
      const page = this.getCompanionChatPage('agent', run.id)
      return {
        detail: {
          run,
          messages: flattenAgentChatRecords(page.records),
          artifacts: this.listAgentRunArtifacts(run.id)
        },
        page
      }
    })
    const snapshot: CompanionSnapshotPayload = {
      generatedAt: new Date().toISOString(),
      modelLabels,
      projects: this.listProjects(),
      goals: this.listGoals(),
      decisions: this.listDecisions(),
      morningBriefings: assistantCollections.briefings,
      workAssistantMessages: assistantCollections.messages,
      attachments: [],
      runs: runDetails.map(({ detail }) => detail),
      chatPages: [assistantPage, ...runDetails.map(({ page }) => page)]
    }
    return this.enqueueCompanionEvent('snapshot.created', 'snapshot', 'current', snapshot)
  }

  getCompanionChatPage(
    chatKind: CompanionChatKind,
    chatId: string,
    before?: string | null,
    limit?: number
  ): CompanionChatPage {
    if (chatKind === 'assistant') {
      if (chatId !== workAssistantChatId) throw new Error('工作助理聊天 ID 无效。')
      const pageLimit = Math.min(
        companionMaximumChatPageLimit,
        Math.max(1, Math.trunc(limit ?? companionInitialChatBlockLimit))
      )
      const window = this.briefings.listChatWindow(before ?? null, pageLimit)
      const records = buildWorkAssistantChatRecords(window.messages, window.briefings)
      return {
        chatId,
        chatKind,
        records,
        hasMore: window.hasMore,
        nextBefore: window.hasMore ? records[0]?.id ?? null : null
      }
    }
    if (!this.listRuns().some((run) => run.id === chatId)) {
      throw new Error('没有找到这个 Agent Run。')
    }
    const pageLimit = Math.min(
      companionMaximumChatPageLimit,
      Math.max(1, Math.trunc(limit ?? companionInitialChatBlockLimit))
    )
    const window = this.runs.listChatWindow(chatId, before ?? null, pageLimit)
    const records = buildAgentChatRecords(chatId, window.messages)
    const trailingRecord = records.at(-1)
    if (trailingRecord?.kind === 'process' && window.trailingProcessCompletedAt) {
      trailingRecord.completedAt = window.trailingProcessCompletedAt
    }
    return {
      chatId,
      chatKind,
      records,
      hasMore: window.hasMore,
      nextBefore: window.hasMore ? records[0]?.id ?? null : null
    }
  }

  enqueueAgentTurnSettled(payload: AgentTurnSettledPayload): CompanionOutboxEvent {
    return this.enqueueCompanionEvent('agent-turn.settled', 'agent-run', payload.runId, payload)
  }

  enqueueCompanionModelLabels(modelLabels: AgentModelLabels): CompanionOutboxEvent {
    return this.enqueueCompanionEvent('model-labels.updated', 'settings', 'models', modelLabels)
  }

  enqueueCompanionPairingSnapshot(modelLabels: AgentModelLabels = emptyAgentModelLabels): CompanionOutboxEvent {
    return this.companionTransaction(() => {
      this.database.prepare('DELETE FROM companion_sync_outbox WHERE published_at IS NULL').run()
      return this.enqueueCompanionSnapshot(modelLabels)
    })
  }

  listPendingCompanionEvents(limit = 100): CompanionOutboxEvent[] {
    return this.companion.listPending(limit)
  }

  countPendingCompanionEvents(): number {
    return this.companion.countPending()
  }

  countDeadLetterCompanionEvents(): number {
    return this.companion.countDeadLetters()
  }

  markCompanionEventPublished(eventId: string, publishedAt: string): void {
    this.companion.markPublished(eventId, publishedAt)
  }

  prunePublishedCompanionEvents(retentionDays = 30, batchSize = 1_000): number {
    return this.companion.prunePublished(retentionDays, batchSize)
  }

  markCompanionEventFailed(eventId: string, error: string): void {
    this.companion.markFailed(eventId, error)
  }

  markCompanionEventDeadLettered(eventId: string, reason: string): void {
    this.companion.markDeadLettered(eventId, reason)
  }

  getCompanionCommand(commandId: string): CompanionCommand | null {
    return this.companion.getCommand(commandId)
  }

  upsertCompanionCommand(command: CompanionCommand): CompanionCommand {
    return this.companion.upsertCommand(command)
  }

  updateCompanionCommand(
    commandId: string,
    status: CompanionCommandStatus,
    result: unknown = null,
    error: string | null = null
  ): CompanionCommand {
    return this.companion.updateCommand(commandId, status, result, error)
  }

  enqueueCompanionCommandUpdate(command: CompanionCommand): CompanionOutboxEvent<'command.updated'> {
    return this.enqueueCompanionEvent(
      'command.updated',
      'command',
      command.commandId,
      companionCommandForOutbox(command)
    )
  }

  private migrateCompanionOutboxDelivery(): void {
    const columns = this.database.prepare('PRAGMA table_info(companion_sync_outbox)').all() as Array<{ name: string }>
    const columnNames = new Set(columns.map((column) => column.name))
    if (!columnNames.has('dead_lettered_at')) {
      this.database.exec('ALTER TABLE companion_sync_outbox ADD COLUMN dead_lettered_at TEXT')
    }
    if (!columnNames.has('dead_letter_reason')) {
      this.database.exec('ALTER TABLE companion_sync_outbox ADD COLUMN dead_letter_reason TEXT')
    }
    this.database.exec(`
      DROP INDEX IF EXISTS companion_sync_outbox_pending_idx;
      CREATE INDEX companion_sync_outbox_pending_idx
      ON companion_sync_outbox(published_at, dead_lettered_at, occurred_at);
    `)

    const rows = this.database.prepare(`
      SELECT event_id, payload_json FROM companion_sync_outbox
      WHERE published_at IS NULL AND dead_lettered_at IS NULL AND type = 'command.updated'
    `).all() as Array<{ event_id: string; payload_json: string }>
    const update = this.database.prepare(`
      UPDATE companion_sync_outbox
      SET payload_json = ?, attempts = 0, last_error = NULL
      WHERE event_id = ?
    `)
    for (const row of rows) {
      const payload = parseJson<unknown>(row.payload_json, null)
      update.run(JSON.stringify(compactPersistedCompanionCommandEvent(payload)), row.event_id)
    }
  }

  private companionTransaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private enqueueCompanionEvent<TType extends CompanionEventType>(
    type: TType,
    entityType: (typeof companionEventDefinitions)[TType],
    entityId: string,
    payload: CompanionOutboxPayloadMap[TType]
  ): CompanionOutboxEvent<TType> {
    return this.companion.enqueue(type, entityType, entityId, payload)
  }

  recordPermissionEvaluation(intent: PermissionIntent, evaluation: PermissionEvaluation): AuditEntry {
    const entry: AuditEntry = {
      id: randomUUID(),
      intent,
      evaluation,
      outcome: evaluation.decision === 'auto-approved' ? 'approved' : 'pending',
      createdAt: new Date().toISOString()
    }

    this.database
      .prepare(
        `
      INSERT INTO audit_entries (id, intent_json, evaluation_json, outcome, created_at)
      VALUES (?, ?, ?, ?, ?)
    `
      )
      .run(entry.id, JSON.stringify(entry.intent), JSON.stringify(entry.evaluation), entry.outcome, entry.createdAt)

    return entry
  }

  updateAuditOutcome(id: string, outcome: AuditEntry['outcome']): void {
    const result = this.database.prepare('UPDATE audit_entries SET outcome = ? WHERE id = ?').run(outcome, id)
    if (result.changes === 0) throw new Error(`Audit entry not found: ${id}`)
  }

  private migrateAgentRunWorkspaces(): void {
    const runs = this.database
      .prepare(
        `
      SELECT id, project_id, provider, session_id, working_directory
      FROM agent_runs
      WHERE project_id IS NOT NULL AND provider = 'pi'
    `
      )
      .all() as SqlRow[]
    const projects = this.listProjects()
    for (const run of runs) {
      const projectId = String(run.project_id)
      const project = projects.find((item) => item.id === projectId)
      if (!project) continue
      const primary = normalizeWorkspaceRoots(project.profile).repoPath
      if (!primary) continue
      const current = run.working_directory ? String(run.working_directory) : ''
      const isLegacyFilesDirectory = current.includes('/project-files/')
      if (!current || isLegacyFilesDirectory) {
        this.database
          .prepare(
            `
          UPDATE agent_runs
          SET kind = 'general', working_directory = ?, session_id = NULL, updated_at = COALESCE(updated_at, created_at)
          WHERE id = ?
        `
          )
          .run(primary, String(run.id))
      }
    }
  }

  private migrateProjectWorkspaceProfiles(): void {
    const update = this.database.prepare('UPDATE projects SET profile_json = ? WHERE id = ?')
    for (const project of this.listProjects()) {
      update.run(JSON.stringify(project.profile), project.id)
    }
  }

  private seed(projects: Project[]): void {
    if (projects.length === 0) return
    const insertProject = this.database.prepare(`
      INSERT INTO projects (id, name, icon, summary, focus, status, accent, sort_order, profile_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `)

    projects.forEach((project, index) => {
      insertProject.run(
        project.id,
        project.name,
        project.icon ?? null,
        project.summary,
        project.focus,
        project.status,
        project.accent,
        index,
        JSON.stringify(project.profile)
      )
    })

    const insertConnector = this.database.prepare(`
      INSERT INTO connector_instances (
        id, project_id, kind, name, enabled, status, config_json,
        credential_ref, capabilities_json, sort_order
      ) VALUES (?, ?, 'repo', ?, 1, 'needs-setup', ?, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        name = excluded.name,
        config_json = excluded.config_json,
        capabilities_json = excluded.capabilities_json,
        sort_order = excluded.sort_order
    `)

    projects.forEach((project, index) => {
      insertConnector.run(
        `repo-${project.id}`,
        project.id,
        `${project.name} Repo`,
        JSON.stringify({ repoPath: project.profile.repoPath }),
        JSON.stringify(['health', 'collect', 'evidence']),
        index
      )
    })
  }
}
