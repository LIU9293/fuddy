import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  CreateDecisionInput,
  DecisionItem,
  DecisionRemediation,
  DecisionStatus,
  DecisionWaitingReason,
  EvidenceRef
} from '../../../shared/contracts'

type SqlRow = Record<string, string | number | null>

export interface DecisionInspectionInput {
  projectId: string | null
  dedupeKey: string
  observationKey: string
  state: 'active' | 'resolved'
  observedAt: string
  summary: string
  evidenceRefs: EvidenceRef[]
  decision?: DecisionItem
}

export interface DecisionInspectionResult {
  decision: DecisionItem | null
  created: boolean
  updated: boolean
  resolved: boolean
}

export interface DecisionStatusTransitionInput {
  actor: 'system' | 'agent' | 'user'
  reason?: string
  waitingReason?: DecisionWaitingReason | null
  evidenceRefs?: EvidenceRef[]
  occurredAt?: string
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export class DecisionRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly transaction: <T>(operation: () => T) => T,
    private readonly publish: (type: 'decision.created' | 'decision.updated', decision: DecisionItem) => void
  ) {}

  list(): DecisionItem[] {
    return (this.database.prepare('SELECT * FROM decision_items ORDER BY created_at DESC').all() as SqlRow[]).map(
      (row) => this.map(row)
    )
  }

  listRemediations(decisionId?: string): DecisionRemediation[] {
    const rows = decisionId
      ? (this.database
          .prepare(
            `SELECT * FROM decision_remediations WHERE decision_id = ? ORDER BY last_seen_at DESC, first_seen_at DESC`
          )
          .all(decisionId) as SqlRow[])
      : (this.database
          .prepare('SELECT * FROM decision_remediations ORDER BY last_seen_at DESC, first_seen_at DESC')
          .all() as SqlRow[])
    return rows.map((row) => this.mapRemediation(row))
  }

  upsertRemediation(remediation: DecisionRemediation): DecisionRemediation {
    this.database
      .prepare(
        `
      INSERT INTO decision_remediations (
        id, decision_id, source_type, source_ref, state, summary, next_action,
        evidence_refs_json, metadata_json, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(decision_id, source_type, source_ref) DO UPDATE SET
        state = excluded.state, summary = excluded.summary, next_action = excluded.next_action,
        evidence_refs_json = excluded.evidence_refs_json, metadata_json = excluded.metadata_json,
        last_seen_at = excluded.last_seen_at
    `
      )
      .run(
        remediation.id,
        remediation.decisionId,
        remediation.sourceType,
        remediation.sourceRef,
        remediation.state,
        remediation.summary,
        remediation.nextAction,
        JSON.stringify(remediation.evidenceRefs),
        JSON.stringify(remediation.metadata),
        remediation.firstSeenAt,
        remediation.lastSeenAt
      )
    const row = this.database
      .prepare(
        `
      SELECT * FROM decision_remediations WHERE decision_id = ? AND source_type = ? AND source_ref = ?
    `
      )
      .get(remediation.decisionId, remediation.sourceType, remediation.sourceRef) as SqlRow
    return this.mapRemediation(row)
  }

  insertIfAbsent(item: DecisionItem): DecisionItem | null {
    if (this.database.prepare('SELECT id FROM decision_items WHERE id = ?').get(item.id)) return null
    this.insert(item)
    return item
  }

  upsertOpenSignal(item: DecisionItem): {
    decision: DecisionItem
    created: boolean
  } {
    const result = this.applyInspection({
      projectId: item.projectId,
      dedupeKey: item.dedupeKey ?? `legacy:${item.projectId ?? 'all'}:${item.title}`,
      observationKey: `legacy:${item.id}`,
      state: 'active',
      observedAt: item.createdAt,
      summary: item.summary,
      evidenceRefs: item.evidenceRefs,
      decision: item
    })
    if (!result.decision) throw new Error('Active inspection did not produce a decision item.')
    return { decision: result.decision, created: result.created }
  }

  applyInspection(input: DecisionInspectionInput): DecisionInspectionResult {
    return this.transaction(() => {
      const result = this.applyInspectionMutation(input)
      if (result.decision) this.publish(result.created ? 'decision.created' : 'decision.updated', result.decision)
      return result
    })
  }

  create(input: CreateDecisionInput): DecisionItem {
    return this.transaction(() => {
      const item: DecisionItem = {
        id: randomUUID(),
        projectId: input.projectId,
        goalId: input.goalId ?? null,
        kind: 'decision',
        title: input.title,
        summary: input.summary ?? '由用户投递，等待助理分析并建议下一步。',
        impact: '待分析',
        urgency: 'medium',
        confidence: 1,
        suggestedActions: ['交给助理分析', '稍后处理'],
        evidenceRefs: input.evidenceRefs ?? [],
        status: 'inbox',
        source: '用户投递',
        createdAt: new Date().toISOString()
      }
      this.insert(item)
      this.publish('decision.created', item)
      return item
    })
  }

  updateStatus(
    id: string,
    status: DecisionStatus,
    transition: DecisionStatusTransitionInput = { actor: 'user' }
  ): DecisionItem {
    return this.transaction(() => {
      const current = this.get(id)
      const occurredAt = transition.occurredAt ?? new Date().toISOString()
      const waitingReason = status === 'waiting' ? (transition.waitingReason ?? current.waitingReason ?? 'user') : null
      const reason =
        transition.reason ??
        (status === 'inbox'
          ? '事项恢复为待处理。'
          : status === 'in_progress'
            ? '事项开始处理。'
            : status === 'waiting'
              ? '事项正在等待下一项外部条件。'
              : status === 'resolved'
                ? '事项已解决。'
                : '由用户忽略。')
      const mergedEvidence = this.mergeEvidence(current.evidenceRefs, transition.evidenceRefs ?? [])
      this.database
        .prepare(
          `
        UPDATE decision_items
        SET status = ?, waiting_reason = ?, status_summary = ?, status_updated_at = ?, evidence_refs_json = ?,
          reopen_count = reopen_count + CASE WHEN status = 'resolved' AND ? IN ('inbox', 'in_progress', 'waiting') THEN 1 ELSE 0 END,
          resolved_at = CASE WHEN ? IN ('resolved', 'ignored') THEN COALESCE(resolved_at, ?) ELSE NULL END,
          resolution_summary = CASE WHEN ? = 'resolved' THEN ? WHEN ? = 'ignored' THEN '由用户忽略。' ELSE NULL END,
          auto_completion_suppressed_key = CASE
            WHEN ? IN ('inbox', 'in_progress', 'waiting') AND status = 'resolved' AND auto_completion_key IS NOT NULL THEN auto_completion_key
            ELSE auto_completion_suppressed_key END,
          auto_completion_key = CASE WHEN ? = 'resolved' THEN NULL ELSE auto_completion_key END
        WHERE id = ?
      `
        )
        .run(
          status,
          waitingReason,
          reason,
          occurredAt,
          JSON.stringify(mergedEvidence),
          status,
          status,
          occurredAt,
          status,
          reason,
          status,
          status,
          status,
          id
        )
      if (current.status !== status || current.waitingReason !== waitingReason || current.statusSummary !== reason) {
        this.recordStatusEvent(id, current.status, status, {
          ...transition,
          reason,
          waitingReason,
          occurredAt
        })
      }
      const decision = this.get(id)
      this.publish('decision.updated', decision)
      return decision
    })
  }

  completeWithEvidence(
    id: string,
    resolutionSummary: string,
    evidenceRefs: EvidenceRef[],
    completionKey: string,
    resolvedAt = new Date().toISOString()
  ): DecisionItem {
    return this.transaction(() => {
      const lifecycle = this.database
        .prepare(
          `
        SELECT status, auto_completion_key, auto_completion_suppressed_key FROM decision_items WHERE id = ?
      `
        )
        .get(id) as SqlRow | undefined
      if (!lifecycle) throw new Error(`Decision item not found: ${id}`)
      const current = this.get(id)
      if (
        current.status === 'ignored' ||
        lifecycle.auto_completion_suppressed_key === completionKey ||
        (current.status === 'resolved' && lifecycle.auto_completion_key === completionKey)
      )
        return current
      const mergedEvidence = this.mergeEvidence(current.evidenceRefs, evidenceRefs)
      this.database
        .prepare(
          `
        UPDATE decision_items
        SET status = 'resolved', waiting_reason = NULL, status_summary = ?, status_updated_at = ?,
          resolved_at = ?, resolution_summary = ?, evidence_refs_json = ?, auto_completion_key = ?
        WHERE id = ?
      `
        )
        .run(
          resolutionSummary,
          resolvedAt,
          resolvedAt,
          resolutionSummary,
          JSON.stringify(mergedEvidence),
          completionKey,
          id
        )
      if (current.status !== 'resolved') {
        this.recordStatusEvent(id, current.status, 'resolved', {
          actor: 'system',
          reason: resolutionSummary,
          evidenceRefs,
          occurredAt: resolvedAt
        })
      }
      const decision = this.get(id)
      this.publish('decision.updated', decision)
      return decision
    })
  }

  migrateLifecycle(): void {
    const legacyRows = this.database
      .prepare(
        `
      SELECT * FROM decision_items WHERE source = '每日项目总结' AND dedupe_key IS NULL
      ORDER BY project_id, title, created_at ASC, id ASC
    `
      )
      .all() as SqlRow[]
    const groups = new Map<string, SqlRow[]>()
    for (const row of legacyRows) {
      const key = `${String(row.project_id ?? '')}\u0000${String(row.title)}`
      groups.set(key, [...(groups.get(key) ?? []), row])
    }
    for (const rows of groups.values()) this.migrateLegacyGroup(rows)
    // Historical compatibility stays isolated in the migration boundary.
    this.database
      .prepare(
        `
      UPDATE decision_items SET suggested_actions_json = ?
      WHERE dedupe_key = 'roombase:onboarding:waiting-platform'
    `
      )
      .run(JSON.stringify(['检查最老入驻事项的阻塞原因']))
  }

  private applyInspectionMutation(input: DecisionInspectionInput): DecisionInspectionResult {
    const existing = this.database
      .prepare(
        `
      SELECT * FROM decision_items WHERE project_id IS ? AND dedupe_key = ?
      ORDER BY first_seen_at ASC, created_at ASC LIMIT 1
    `
      )
      .get(input.projectId, input.dedupeKey) as SqlRow | undefined
    if (input.state === 'resolved') return this.resolveInspection(input, existing)
    if (!input.decision) throw new Error('Active inspection requires a decision payload.')
    if (!existing) {
      const idCollision = this.database.prepare('SELECT 1 FROM decision_items WHERE id = ?').get(input.decision.id)
      const decision: DecisionItem = {
        ...input.decision,
        id: idCollision ? `${input.decision.id}-${randomUUID().slice(0, 8)}` : input.decision.id,
        dedupeKey: input.dedupeKey,
        firstSeenAt: input.observedAt,
        lastSeenAt: input.observedAt,
        occurrenceCount: 1,
        resolvedAt: null,
        resolutionSummary: null
      }
      this.insert(decision)
      this.recordObservation(decision.id, input)
      return {
        decision: this.get(decision.id),
        created: true,
        updated: false,
        resolved: false
      }
    }
    return this.updateActiveInspection(input, existing)
  }

  private resolveInspection(input: DecisionInspectionInput, existing?: SqlRow): DecisionInspectionResult {
    if (!existing)
      return {
        decision: null,
        created: false,
        updated: false,
        resolved: false
      }
    const id = String(existing.id)
    const current = this.map(existing)
    const isNewObservation = this.recordObservation(id, input)
    const mergedEvidence = this.mergeEvidence(current.evidenceRefs, input.evidenceRefs)
    if (current.status === 'ignored') {
      this.database
        .prepare(
          `
        UPDATE decision_items SET last_seen_at = ?, evidence_refs_json = ?, occurrence_count = occurrence_count + ? WHERE id = ?
      `
        )
        .run(input.observedAt, JSON.stringify(mergedEvidence), isNewObservation ? 1 : 0, id)
      return {
        decision: this.get(id),
        created: false,
        updated: isNewObservation,
        resolved: false
      }
    }
    this.database
      .prepare(
        `
      UPDATE decision_items
      SET status = 'resolved', waiting_reason = NULL, status_summary = ?, status_updated_at = ?,
        last_seen_at = ?, resolved_at = ?, resolution_summary = ?, evidence_refs_json = ?,
        occurrence_count = occurrence_count + ? WHERE id = ?
    `
      )
      .run(
        input.summary,
        input.observedAt,
        input.observedAt,
        input.observedAt,
        input.summary,
        JSON.stringify(mergedEvidence),
        isNewObservation ? 1 : 0,
        id
      )
    if (current.status !== 'resolved') {
      this.recordStatusEvent(id, current.status, 'resolved', {
        actor: 'system',
        reason: input.summary,
        evidenceRefs: input.evidenceRefs,
        occurredAt: input.observedAt
      })
    }
    return {
      decision: this.get(id),
      created: false,
      updated: true,
      resolved: true
    }
  }

  private updateActiveInspection(input: DecisionInspectionInput, existing: SqlRow): DecisionInspectionResult {
    const id = String(existing.id)
    const current = this.map(existing)
    const isNewObservation = this.recordObservation(id, input)
    const item = input.decision as DecisionItem
    if (current.status === 'ignored') {
      this.database
        .prepare(
          `
        UPDATE decision_items SET summary = ?, evidence_refs_json = ?, last_seen_at = ?,
          occurrence_count = occurrence_count + ? WHERE id = ?
      `
        )
        .run(item.summary, JSON.stringify(item.evidenceRefs), input.observedAt, isNewObservation ? 1 : 0, id)
      return {
        decision: this.get(id),
        created: false,
        updated: true,
        resolved: false
      }
    }
    const newerThanResolution =
      current.status !== 'resolved' || !current.resolvedAt || input.observedAt > current.resolvedAt
    if (current.status === 'resolved' && !newerThanResolution) {
      return {
        decision: current,
        created: false,
        updated: isNewObservation,
        resolved: true
      }
    }
    const reopened = current.status === 'resolved'
    const verificationFailed =
      current.status === 'waiting' &&
      current.waitingReason === 'verification' &&
      input.observedAt > (current.statusUpdatedAt ?? current.createdAt)
    const nextStatus: DecisionStatus = reopened ? 'inbox' : verificationFailed ? 'in_progress' : current.status
    const nextStatusSummary = reopened
      ? `最新巡检重新打开：${input.summary}`
      : verificationFailed
        ? `生产验证失败：${input.summary}`
        : (current.statusSummary ?? null)
    const statusChanged = reopened || verificationFailed
    this.database
      .prepare(
        `
      UPDATE decision_items
      SET goal_id = ?, dedupe_key = ?, kind = ?, title = ?, summary = ?, impact = ?, urgency = ?,
        confidence = ?, suggested_actions_json = ?, evidence_refs_json = ?, source = ?,
        last_seen_at = ?, occurrence_count = occurrence_count + ?, resolved_at = NULL,
        resolution_summary = NULL, status = ?, waiting_reason = ?, status_summary = ?,
        status_updated_at = CASE WHEN ? THEN ? ELSE status_updated_at END,
        reopen_count = reopen_count + CASE WHEN ? THEN 1 ELSE 0 END,
        auto_completion_key = CASE WHEN ? THEN NULL ELSE auto_completion_key END WHERE id = ?
    `
      )
      .run(
        item.goalId ?? null,
        input.dedupeKey,
        item.kind,
        item.title,
        item.summary,
        item.impact,
        item.urgency,
        item.confidence,
        JSON.stringify(item.suggestedActions),
        JSON.stringify(item.evidenceRefs),
        item.source,
        input.observedAt,
        isNewObservation ? 1 : 0,
        nextStatus,
        statusChanged ? null : (current.waitingReason ?? null),
        nextStatusSummary,
        statusChanged ? 1 : 0,
        input.observedAt,
        reopened ? 1 : 0,
        reopened ? 1 : 0,
        id
      )
    if (statusChanged) {
      this.recordStatusEvent(id, current.status, nextStatus, {
        actor: 'system',
        reason: nextStatusSummary ?? input.summary,
        evidenceRefs: input.evidenceRefs,
        occurredAt: input.observedAt
      })
    }
    return {
      decision: this.get(id),
      created: false,
      updated: true,
      resolved: false
    }
  }

  private insert(item: DecisionItem): void {
    this.database
      .prepare(
        `
      INSERT INTO decision_items (
        id, project_id, goal_id, dedupe_key, kind, title, summary, impact, urgency, confidence,
        suggested_actions_json, evidence_refs_json, status, source, created_at,
        first_seen_at, last_seen_at, occurrence_count, resolved_at, resolution_summary,
        waiting_reason, status_summary, status_updated_at, reopen_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        item.id,
        item.projectId,
        item.goalId ?? null,
        item.dedupeKey ?? null,
        item.kind,
        item.title,
        item.summary,
        item.impact,
        item.urgency,
        item.confidence,
        JSON.stringify(item.suggestedActions),
        JSON.stringify(item.evidenceRefs),
        item.status,
        item.source,
        item.createdAt,
        item.firstSeenAt ?? item.createdAt,
        item.lastSeenAt ?? item.createdAt,
        item.occurrenceCount ?? 1,
        item.resolvedAt ?? null,
        item.resolutionSummary ?? null,
        item.waitingReason ?? null,
        item.statusSummary ?? null,
        item.statusUpdatedAt ?? item.createdAt,
        item.reopenCount ?? 0
      )
    this.recordStatusEvent(item.id, null, item.status, {
      actor: 'system',
      reason: item.statusSummary ?? '事项已创建。',
      waitingReason: item.waitingReason ?? null,
      evidenceRefs: item.evidenceRefs,
      occurredAt: item.statusUpdatedAt ?? item.createdAt
    })
  }

  private get(id: string): DecisionItem {
    const row = this.database.prepare('SELECT * FROM decision_items WHERE id = ?').get(id) as SqlRow | undefined
    if (!row) throw new Error(`Decision item not found: ${id}`)
    return this.map(row)
  }

  private recordStatusEvent(
    decisionId: string,
    fromStatus: DecisionStatus | null,
    toStatus: DecisionStatus,
    input: DecisionStatusTransitionInput
  ): void {
    this.database
      .prepare(
        `
      INSERT INTO decision_status_events (
        id, decision_id, from_status, to_status, waiting_reason, reason,
        evidence_refs_json, actor_type, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        randomUUID(),
        decisionId,
        fromStatus,
        toStatus,
        input.waitingReason ?? null,
        input.reason ?? '事项状态已更新。',
        JSON.stringify(input.evidenceRefs ?? []),
        input.actor,
        input.occurredAt ?? new Date().toISOString()
      )
  }

  private recordObservation(decisionId: string, input: DecisionInspectionInput): boolean {
    const existing = this.database
      .prepare(
        `
      SELECT id FROM decision_observations WHERE decision_id = ? AND observation_key = ?
    `
      )
      .get(decisionId, input.observationKey) as SqlRow | undefined
    const now = new Date().toISOString()
    if (existing) {
      this.database
        .prepare(
          `
        UPDATE decision_observations SET state = ?, summary = ?, evidence_refs_json = ?, observed_at = ?, created_at = ?
        WHERE id = ?
      `
        )
        .run(input.state, input.summary, JSON.stringify(input.evidenceRefs), input.observedAt, now, String(existing.id))
      return false
    }
    this.database
      .prepare(
        `
      INSERT INTO decision_observations (
        id, decision_id, observation_key, state, summary, evidence_refs_json, observed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        randomUUID(),
        decisionId,
        input.observationKey,
        input.state,
        input.summary,
        JSON.stringify(input.evidenceRefs),
        input.observedAt,
        now
      )
    return true
  }

  private migrateLegacyGroup(rows: SqlRow[]): void {
    const keeper = rows[0]
    const keeperId = String(keeper.id)
    const projectId = keeper.project_id ? String(keeper.project_id) : null
    const title = String(keeper.title)
    const dedupeKey =
      projectId === 'roombase' && title === 'Roombase 有长期等待平台处理的入驻事项'
        ? 'roombase:onboarding:waiting-platform'
        : projectId === 'roombase' && title === 'Roombase 首次预订用户低于 7 日基线'
          ? 'roombase:activation:first-booking-below-7d'
          : `daily:${projectId ?? 'all'}:${title}`
    const latest = rows.at(-1) as SqlRow
    const open = rows.find((row) => ['inbox', 'in_progress', 'waiting', 'later'].includes(String(row.status)))
    const finalStatus = open ? String(open.status) : 'resolved'
    for (const row of rows) {
      this.recordObservation(keeperId, {
        projectId,
        dedupeKey,
        observationKey: `legacy:${String(row.id)}`,
        state: 'active',
        observedAt: String(row.created_at),
        summary: String(row.summary),
        evidenceRefs: parseJson<EvidenceRef[]>(String(row.evidence_refs_json), [])
      })
    }
    for (const duplicate of rows.slice(1)) {
      const duplicateId = String(duplicate.id)
      this.database
        .prepare('UPDATE connector_runs SET decision_id = ? WHERE decision_id = ?')
        .run(keeperId, duplicateId)
      this.database.prepare('UPDATE agent_runs SET decision_id = ? WHERE decision_id = ?').run(keeperId, duplicateId)
      this.database
        .prepare('UPDATE decision_remediations SET decision_id = ? WHERE decision_id = ?')
        .run(keeperId, duplicateId)
      this.replaceBriefingSignalId('daily_briefings', duplicateId, keeperId)
      this.replaceBriefingSignalId('morning_briefings', duplicateId, keeperId)
      this.database.prepare('DELETE FROM decision_items WHERE id = ?').run(duplicateId)
    }
    this.database
      .prepare(
        `
      UPDATE decision_items
      SET dedupe_key = ?, summary = ?, impact = ?, urgency = ?, confidence = ?,
        suggested_actions_json = ?, evidence_refs_json = ?, status = ?, first_seen_at = ?,
        last_seen_at = ?, occurrence_count = ?,
        resolved_at = CASE WHEN ? = 'resolved' THEN COALESCE(resolved_at, ?) ELSE NULL END,
        resolution_summary = CASE WHEN ? = 'resolved' THEN resolution_summary ELSE NULL END
      WHERE id = ?
    `
      )
      .run(
        dedupeKey,
        String(latest.summary),
        String(latest.impact),
        String(latest.urgency),
        Number(latest.confidence),
        String(latest.suggested_actions_json),
        String(latest.evidence_refs_json),
        finalStatus,
        String(rows[0].created_at),
        String(latest.created_at),
        rows.length,
        finalStatus,
        String(latest.created_at),
        finalStatus,
        keeperId
      )
  }

  private replaceBriefingSignalId(table: 'daily_briefings' | 'morning_briefings', oldId: string, newId: string): void {
    const rows = this.database.prepare(`SELECT id, signal_ids_json FROM ${table}`).all() as SqlRow[]
    const update = this.database.prepare(`UPDATE ${table} SET signal_ids_json = ? WHERE id = ?`)
    for (const row of rows) {
      const ids = parseJson<string[]>(String(row.signal_ids_json), [])
      if (ids.includes(oldId))
        update.run(JSON.stringify([...new Set(ids.map((id) => (id === oldId ? newId : id)))]), String(row.id))
    }
  }

  private mergeEvidence(current: EvidenceRef[], incoming: EvidenceRef[]): EvidenceRef[] {
    const merged = [...current]
    for (const evidence of incoming) if (!merged.some((item) => item.uri === evidence.uri)) merged.push(evidence)
    return merged
  }

  private map(row: SqlRow): DecisionItem {
    return {
      id: String(row.id),
      projectId: row.project_id ? String(row.project_id) : null,
      goalId: row.goal_id ? String(row.goal_id) : null,
      dedupeKey: row.dedupe_key ? String(row.dedupe_key) : null,
      kind: row.kind as DecisionItem['kind'],
      title: String(row.title),
      summary: String(row.summary),
      impact: String(row.impact),
      urgency: row.urgency as DecisionItem['urgency'],
      confidence: Number(row.confidence),
      suggestedActions: parseJson<string[]>(String(row.suggested_actions_json), []),
      evidenceRefs: parseJson<EvidenceRef[]>(String(row.evidence_refs_json), []),
      status: (row.status === 'later' ? 'waiting' : row.status) as DecisionItem['status'],
      waitingReason: row.waiting_reason ? (String(row.waiting_reason) as DecisionWaitingReason) : null,
      statusSummary: row.status_summary ? String(row.status_summary) : null,
      statusUpdatedAt: row.status_updated_at ? String(row.status_updated_at) : String(row.created_at),
      reopenCount: row.reopen_count === null ? 0 : Number(row.reopen_count),
      source: String(row.source),
      createdAt: String(row.created_at),
      firstSeenAt: row.first_seen_at ? String(row.first_seen_at) : String(row.created_at),
      lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : String(row.created_at),
      occurrenceCount: row.occurrence_count === null ? 1 : Number(row.occurrence_count),
      resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
      resolutionSummary: row.resolution_summary ? String(row.resolution_summary) : null
    }
  }

  private mapRemediation(row: SqlRow): DecisionRemediation {
    return {
      id: String(row.id),
      decisionId: String(row.decision_id),
      sourceType: row.source_type as DecisionRemediation['sourceType'],
      sourceRef: String(row.source_ref),
      state: row.state as DecisionRemediation['state'],
      summary: String(row.summary),
      nextAction: String(row.next_action),
      evidenceRefs: parseJson<EvidenceRef[]>(String(row.evidence_refs_json), []),
      metadata: parseJson<Record<string, unknown>>(String(row.metadata_json), {}),
      firstSeenAt: String(row.first_seen_at),
      lastSeenAt: String(row.last_seen_at)
    }
  }
}
