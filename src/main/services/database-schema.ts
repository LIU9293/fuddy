import type { DatabaseSync } from 'node:sqlite'

export function ensureCurrentDatabaseSchema(database: DatabaseSync): void {
  database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        icon TEXT,
        summary TEXT NOT NULL,
        focus TEXT NOT NULL,
        status TEXT NOT NULL,
        accent TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        profile_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS project_goals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'P1',
        metric_json TEXT NOT NULL DEFAULT '{}',
        deadline TEXT,
        next_check_in_at TEXT,
        progress REAL NOT NULL DEFAULT 0,
        confidence REAL NOT NULL DEFAULT 0.5,
        agent_summary TEXT NOT NULL DEFAULT '',
        monitoring_sources_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS goal_milestones (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES project_goals(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        due_at TEXT,
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS goal_checkins (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES project_goals(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        progress REAL NOT NULL,
        summary TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        generation TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS decision_items (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id),
        goal_id TEXT REFERENCES project_goals(id),
        dedupe_key TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        impact TEXT NOT NULL,
        urgency TEXT NOT NULL,
        confidence REAL NOT NULL,
        suggested_actions_json TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        first_seen_at TEXT,
        last_seen_at TEXT,
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        resolved_at TEXT,
        resolution_summary TEXT,
        auto_completion_key TEXT,
        auto_completion_suppressed_key TEXT,
        waiting_reason TEXT,
        status_summary TEXT,
        status_updated_at TEXT,
        reopen_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS decision_observations (
        id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL REFERENCES decision_items(id) ON DELETE CASCADE,
        observation_key TEXT NOT NULL,
        state TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(decision_id, observation_key)
      );

      CREATE TABLE IF NOT EXISTS decision_status_events (
        id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL REFERENCES decision_items(id) ON DELETE CASCADE,
        from_status TEXT,
        to_status TEXT NOT NULL,
        waiting_reason TEXT,
        reason TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        actor_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS decision_status_events_decision_idx
      ON decision_status_events(decision_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS decision_remediations (
        id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL REFERENCES decision_items(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        state TEXT NOT NULL,
        summary TEXT NOT NULL,
        next_action TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE(decision_id, source_type, source_ref)
      );

      CREATE INDEX IF NOT EXISTS decision_remediations_decision_idx
      ON decision_remediations(decision_id, last_seen_at DESC);

      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id),
        goal_id TEXT REFERENCES project_goals(id),
        agent TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'pi',
        kind TEXT NOT NULL DEFAULT 'general',
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        model TEXT,
        reasoning_effort TEXT,
        session_id TEXT,
        working_directory TEXT,
        started_at TEXT,
        completed_at TEXT,
        summary TEXT NOT NULL,
        draft_prompt TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        archived_at TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_run_messages (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        event_type TEXT,
        tool_name TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_run_messages_run
      ON agent_run_messages(run_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS agent_run_artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id),
        relative_path TEXT NOT NULL,
        label TEXT NOT NULL,
        mime_type TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, relative_path)
      );

      CREATE INDEX IF NOT EXISTS idx_agent_run_artifacts_run
      ON agent_run_artifacts(run_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS audit_entries (
        id TEXT PRIMARY KEY,
        intent_json TEXT NOT NULL,
        evaluation_json TEXT NOT NULL,
        outcome TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS companion_sync_outbox (
        event_id TEXT PRIMARY KEY,
        protocol_version INTEGER NOT NULL,
        type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        published_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );

      CREATE INDEX IF NOT EXISTS companion_sync_outbox_pending_idx
      ON companion_sync_outbox(published_at, occurred_at);

      CREATE TABLE IF NOT EXISTS companion_remote_commands (
        command_id TEXT PRIMARY KEY,
        protocol_version INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        source_device_id TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS connector_instances (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}',
        credential_ref TEXT,
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        last_checked_at TEXT,
        last_sync_at TEXT,
        last_error TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS connector_runs (
        id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL REFERENCES connector_instances(id),
        project_id TEXT NOT NULL REFERENCES projects(id),
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        decision_id TEXT REFERENCES decision_items(id),
        data_json TEXT
      );

      CREATE TABLE IF NOT EXISTS daily_briefings (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        report_date TEXT NOT NULL,
        timezone TEXT NOT NULL,
        status TEXT NOT NULL,
        headline TEXT NOT NULL,
        body TEXT NOT NULL,
        metrics_json TEXT,
        signal_ids_json TEXT NOT NULL DEFAULT '[]',
        generated_at TEXT NOT NULL,
        error TEXT,
        generation TEXT NOT NULL,
        UNIQUE(project_id, report_date)
      );

      CREATE TABLE IF NOT EXISTS morning_briefings (
        id TEXT PRIMARY KEY,
        report_date TEXT NOT NULL UNIQUE,
        timezone TEXT NOT NULL,
        status TEXT NOT NULL,
        headline TEXT NOT NULL,
        body TEXT NOT NULL,
        narration TEXT NOT NULL,
        estimated_duration_seconds INTEGER NOT NULL,
        source_briefing_ids_json TEXT NOT NULL DEFAULT '[]',
        signal_ids_json TEXT NOT NULL DEFAULT '[]',
        generated_at TEXT NOT NULL,
        error TEXT,
        generation TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS briefing_messages (
        id TEXT PRIMARY KEY,
        briefing_id TEXT NOT NULL REFERENCES morning_briefings(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS work_assistant_messages (
        id TEXT PRIMARY KEY,
        source_briefing_id TEXT REFERENCES morning_briefings(id) ON DELETE SET NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        task_context_json TEXT,
        linked_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        actions_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automation_jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        schedule_description TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        timezone TEXT NOT NULL,
        action TEXT NOT NULL,
        prompt TEXT NOT NULL DEFAULT '',
        agent_kind TEXT NOT NULL DEFAULT 'general',
        agent_provider TEXT NOT NULL DEFAULT 'pi',
        enabled INTEGER NOT NULL DEFAULT 1,
        requires_confirmation INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 0,
        retry_delay_seconds INTEGER NOT NULL DEFAULT 30,
        status TEXT NOT NULL DEFAULT 'idle',
        last_run_at TEXT,
        next_run_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL REFERENCES automation_jobs(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        summary TEXT NOT NULL,
        error TEXT,
        agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS decision_status_created_idx
      ON decision_items(status, created_at DESC);

      CREATE INDEX IF NOT EXISTS decision_observations_decision_idx
      ON decision_observations(decision_id, observed_at DESC);

      CREATE INDEX IF NOT EXISTS project_goals_status_checkin_idx
      ON project_goals(project_id, status, next_check_in_at);

      CREATE INDEX IF NOT EXISTS goal_milestones_goal_idx
      ON goal_milestones(goal_id, sort_order);

      CREATE INDEX IF NOT EXISTS goal_checkins_goal_created_idx
      ON goal_checkins(goal_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS connector_runs_started_idx
      ON connector_runs(connector_id, started_at DESC);

      CREATE INDEX IF NOT EXISTS daily_briefings_report_idx
      ON daily_briefings(project_id, report_date DESC);

      CREATE INDEX IF NOT EXISTS briefing_messages_created_idx
      ON briefing_messages(briefing_id, created_at ASC);

      CREATE INDEX IF NOT EXISTS work_assistant_messages_created_idx
      ON work_assistant_messages(created_at ASC);

      CREATE INDEX IF NOT EXISTS work_assistant_messages_chat_page_idx
      ON work_assistant_messages(created_at DESC, id DESC);

      CREATE INDEX IF NOT EXISTS morning_briefings_chat_page_idx
      ON morning_briefings(generated_at DESC, id DESC)
      WHERE status = 'completed';

      CREATE INDEX IF NOT EXISTS automation_jobs_schedule_idx
      ON automation_jobs(enabled, next_run_at);

      CREATE INDEX IF NOT EXISTS automation_runs_job_idx
      ON automation_runs(automation_id, started_at DESC);
    `)

  database.exec(`
      INSERT OR IGNORE INTO work_assistant_messages (
        id, source_briefing_id, role, content, task_context_json, created_at
      )
      SELECT id, briefing_id, role, content, NULL, created_at
      FROM briefing_messages;
    `)

  const projectColumns = database.prepare('PRAGMA table_info(projects)').all() as Array<{
    name: string
  }>
  if (!projectColumns.some((column) => column.name === 'profile_json')) {
    database.exec("ALTER TABLE projects ADD COLUMN profile_json TEXT NOT NULL DEFAULT '{}'")
  }
  if (!projectColumns.some((column) => column.name === 'icon')) {
    database.exec('ALTER TABLE projects ADD COLUMN icon TEXT')
  }

  const workAssistantMessageColumns = database.prepare('PRAGMA table_info(work_assistant_messages)').all() as Array<{
    name: string
  }>
  if (!workAssistantMessageColumns.some((column) => column.name === 'attachments_json')) {
    database.exec("ALTER TABLE work_assistant_messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'")
  }
  if (!workAssistantMessageColumns.some((column) => column.name === 'linked_run_id')) {
    database.exec(
      'ALTER TABLE work_assistant_messages ADD COLUMN linked_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL'
    )
  }
  if (!workAssistantMessageColumns.some((column) => column.name === 'actions_json')) {
    database.exec("ALTER TABLE work_assistant_messages ADD COLUMN actions_json TEXT NOT NULL DEFAULT '[]'")
  }

  const connectorRunColumns = database.prepare('PRAGMA table_info(connector_runs)').all() as Array<{
    name: string
  }>
  if (!connectorRunColumns.some((column) => column.name === 'data_json')) {
    database.exec('ALTER TABLE connector_runs ADD COLUMN data_json TEXT')
  }

  const goalColumns = database.prepare('PRAGMA table_info(project_goals)').all() as Array<{
    name: string
  }>
  if (!goalColumns.some((column) => column.name === 'priority')) {
    database.exec("ALTER TABLE project_goals ADD COLUMN priority TEXT NOT NULL DEFAULT 'P1'")
  }

  const decisionColumns = database.prepare('PRAGMA table_info(decision_items)').all() as Array<{
    name: string
  }>
  if (!decisionColumns.some((column) => column.name === 'goal_id')) {
    database.exec('ALTER TABLE decision_items ADD COLUMN goal_id TEXT REFERENCES project_goals(id)')
  }
  if (!decisionColumns.some((column) => column.name === 'dedupe_key')) {
    database.exec('ALTER TABLE decision_items ADD COLUMN dedupe_key TEXT')
  }
  if (!decisionColumns.some((column) => column.name === 'first_seen_at')) {
    database.exec('ALTER TABLE decision_items ADD COLUMN first_seen_at TEXT')
  }
  if (!decisionColumns.some((column) => column.name === 'last_seen_at')) {
    database.exec('ALTER TABLE decision_items ADD COLUMN last_seen_at TEXT')
  }
  if (!decisionColumns.some((column) => column.name === 'occurrence_count')) {
    database.exec('ALTER TABLE decision_items ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1')
  }
  if (!decisionColumns.some((column) => column.name === 'resolved_at')) {
    database.exec('ALTER TABLE decision_items ADD COLUMN resolved_at TEXT')
  }
  if (!decisionColumns.some((column) => column.name === 'resolution_summary')) {
    database.exec('ALTER TABLE decision_items ADD COLUMN resolution_summary TEXT')
  }
  if (!decisionColumns.some((column) => column.name === 'auto_completion_key')) {
    database.exec('ALTER TABLE decision_items ADD COLUMN auto_completion_key TEXT')
  }
  if (!decisionColumns.some((column) => column.name === 'auto_completion_suppressed_key')) {
    database.exec('ALTER TABLE decision_items ADD COLUMN auto_completion_suppressed_key TEXT')
  }
  if (!decisionColumns.some((column) => column.name === 'waiting_reason')) {
    database.exec('ALTER TABLE decision_items ADD COLUMN waiting_reason TEXT')
  }
  if (!decisionColumns.some((column) => column.name === 'status_summary')) {
    database.exec('ALTER TABLE decision_items ADD COLUMN status_summary TEXT')
  }
  if (!decisionColumns.some((column) => column.name === 'status_updated_at')) {
    database.exec('ALTER TABLE decision_items ADD COLUMN status_updated_at TEXT')
  }
  if (!decisionColumns.some((column) => column.name === 'reopen_count')) {
    database.exec('ALTER TABLE decision_items ADD COLUMN reopen_count INTEGER NOT NULL DEFAULT 0')
  }
  database.exec(`
      UPDATE decision_items
      SET first_seen_at = COALESCE(first_seen_at, created_at),
          last_seen_at = COALESCE(last_seen_at, created_at),
          occurrence_count = COALESCE(occurrence_count, 1),
          status = CASE WHEN status = 'later' THEN 'waiting' ELSE status END,
          waiting_reason = CASE WHEN status = 'later' THEN 'user' ELSE waiting_reason END,
          status_summary = CASE WHEN status = 'later' THEN COALESCE(status_summary, '等待用户稍后处理。') ELSE status_summary END,
          status_updated_at = COALESCE(status_updated_at, resolved_at, last_seen_at, created_at),
          reopen_count = COALESCE(reopen_count, 0)
    `)
  database.exec(`
      INSERT INTO decision_status_events (
        id, decision_id, from_status, to_status, waiting_reason, reason,
        evidence_refs_json, actor_type, created_at
      )
      SELECT lower(hex(randomblob(16))), id, NULL, status, waiting_reason,
        COALESCE(status_summary, '迁移现有事项状态。'), evidence_refs_json, 'system',
        COALESCE(status_updated_at, created_at)
      FROM decision_items
      WHERE NOT EXISTS (
        SELECT 1 FROM decision_status_events WHERE decision_status_events.decision_id = decision_items.id
      )
    `)
  database.exec(`
      CREATE INDEX IF NOT EXISTS decision_lifecycle_idx
      ON decision_items(project_id, dedupe_key, status)
    `)

  const agentRunColumns = database.prepare('PRAGMA table_info(agent_runs)').all() as Array<{
    name: string
  }>
  if (!agentRunColumns.some((column) => column.name === 'goal_id')) {
    database.exec('ALTER TABLE agent_runs ADD COLUMN goal_id TEXT REFERENCES project_goals(id)')
  }
  if (!agentRunColumns.some((column) => column.name === 'decision_id')) {
    database.exec('ALTER TABLE agent_runs ADD COLUMN decision_id TEXT REFERENCES decision_items(id)')
  }
  if (!agentRunColumns.some((column) => column.name === 'milestone_id')) {
    database.exec('ALTER TABLE agent_runs ADD COLUMN milestone_id TEXT REFERENCES goal_milestones(id)')
  }
  if (!agentRunColumns.some((column) => column.name === 'kind')) {
    database.exec("ALTER TABLE agent_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'general'")
  }
  if (!agentRunColumns.some((column) => column.name === 'provider')) {
    database.exec("ALTER TABLE agent_runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'pi'")
  }
  if (!agentRunColumns.some((column) => column.name === 'session_id')) {
    database.exec('ALTER TABLE agent_runs ADD COLUMN session_id TEXT')
  }
  if (!agentRunColumns.some((column) => column.name === 'working_directory')) {
    database.exec('ALTER TABLE agent_runs ADD COLUMN working_directory TEXT')
  }
  if (!agentRunColumns.some((column) => column.name === 'updated_at')) {
    database.exec('ALTER TABLE agent_runs ADD COLUMN updated_at TEXT')
  }
  if (!agentRunColumns.some((column) => column.name === 'archived_at')) {
    database.exec('ALTER TABLE agent_runs ADD COLUMN archived_at TEXT')
  }
  if (!agentRunColumns.some((column) => column.name === 'draft_prompt')) {
    database.exec('ALTER TABLE agent_runs ADD COLUMN draft_prompt TEXT')
  }
  if (!agentRunColumns.some((column) => column.name === 'model')) {
    database.exec('ALTER TABLE agent_runs ADD COLUMN model TEXT')
  }
  if (!agentRunColumns.some((column) => column.name === 'reasoning_effort')) {
    database.exec('ALTER TABLE agent_runs ADD COLUMN reasoning_effort TEXT')
  }
  database.exec(`
      UPDATE agent_runs
      SET provider = CASE agent
        WHEN 'assistant' THEN 'pi'
        WHEN 'codex' THEN 'codex'
        WHEN 'claude' THEN 'claude'
        ELSE COALESCE(NULLIF(provider, ''), 'pi')
      END,
      kind = CASE
        WHEN CASE agent
          WHEN 'assistant' THEN 'pi'
          WHEN 'codex' THEN 'codex'
          WHEN 'claude' THEN 'claude'
          ELSE COALESCE(NULLIF(provider, ''), 'pi')
        END = 'pi' THEN 'general'
        ELSE 'coding'
      END,
      updated_at = COALESCE(updated_at, started_at, created_at)
    `)
  database.exec(`
      UPDATE agent_runs
      SET decision_id = (
        SELECT decision_items.id
        FROM decision_items
        WHERE decision_items.project_id IS agent_runs.project_id
          AND agent_runs.title = '处理 · ' || decision_items.title
        ORDER BY decision_items.first_seen_at ASC, decision_items.created_at ASC
        LIMIT 1
      )
      WHERE decision_id IS NULL
        AND title LIKE '处理 · %'
    `)
}
