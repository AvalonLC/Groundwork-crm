-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 0015 — Unified Task / To-Do Engine
-- ══════════════════════════════════════════════════════════════════════════════
-- Replaces the single nextFollowUp field on opportunities with a real task
-- object that can be attached to any record type (lead, client, work_order,
-- estimate, invoice, internal).
--
-- STATUS MODEL: only 'open' | 'completed' | 'archived' are persisted.
-- due_today and overdue are derived at query/display time from dueDate vs NOW().
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tasks (
  id                   TEXT    NOT NULL PRIMARY KEY,
  company_id           TEXT    NOT NULL,
  title                TEXT    NOT NULL DEFAULT '',
  description          TEXT    NOT NULL DEFAULT '',
  task_type            TEXT    NOT NULL DEFAULT 'follow_up',
  -- linked record (nullable — tasks can be unlinked / internal)
  linked_record_type   TEXT             DEFAULT NULL,  -- 'lead'|'client'|'work_order'|'estimate'|'invoice'|'internal'
  linked_record_id     TEXT             DEFAULT NULL,
  linked_record_label  TEXT    NOT NULL DEFAULT '',
  -- assignment
  assigned_user_id     TEXT             DEFAULT NULL,
  assigned_user_label  TEXT    NOT NULL DEFAULT '',
  created_by           TEXT    NOT NULL DEFAULT '',
  -- scheduling
  due_date             TEXT             DEFAULT NULL,  -- ISO date YYYY-MM-DD
  due_time             TEXT             DEFAULT NULL,  -- HH:MM 24h
  priority             TEXT    NOT NULL DEFAULT 'normal',  -- 'low'|'normal'|'high'
  -- lifecycle (only open/completed/archived stored)
  status               TEXT    NOT NULL DEFAULT 'open',
  completed_at         TEXT             DEFAULT NULL,
  completed_by         TEXT    NOT NULL DEFAULT '',
  archived_at          TEXT             DEFAULT NULL,
  archived_by          TEXT    NOT NULL DEFAULT '',
  -- calendar push foundation
  calendar_sync_state  TEXT    NOT NULL DEFAULT 'none',  -- 'none'|'pending'|'synced'|'error'
  calendar_event_id    TEXT             DEFAULT NULL,
  -- provenance
  source               TEXT    NOT NULL DEFAULT 'manual',  -- 'manual'|'automation'|'template'|'migrated_legacy'
  -- audit
  created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Index for Today / per-user queries:  WHERE company_id=? AND assigned_user_id=? AND status='open' ORDER BY due_date
CREATE INDEX IF NOT EXISTS idx_tasks_user_status_due
  ON tasks(company_id, assigned_user_id, status, due_date);

-- Index for record-page lookups:  WHERE company_id=? AND linked_record_type=? AND linked_record_id=?
CREATE INDEX IF NOT EXISTS idx_tasks_linked_record
  ON tasks(company_id, linked_record_type, linked_record_id);

-- Index for Team View rollups:  WHERE company_id=? AND status='open'
CREATE INDEX IF NOT EXISTS idx_tasks_company_status
  ON tasks(company_id, status, due_date);

-- ── SERVER-SIDE LEGACY MIGRATION ────────────────────────────────────────────
-- Idempotent backfill: for every opportunity row that has a next_follow_up date
-- and does NOT already have a migrated task, create one task of type 'follow_up'.
-- Uses INSERT OR IGNORE on a deterministic id (opp_id + '_fu') so re-runs are safe.
-- The migrated task is assigned to the rep who owns the opportunity.
INSERT OR IGNORE INTO tasks (
  id, company_id, title, description, task_type,
  linked_record_type, linked_record_id, linked_record_label,
  assigned_user_id, assigned_user_label, created_by,
  due_date, priority, status, source, created_at, updated_at
)
SELECT
  o.id || '_fu',
  o.company_id,
  'Follow up with ' || o.client,
  '',
  'follow_up',
  'lead',
  o.id,
  o.client,
  o.rep_id,
  COALESCE((SELECT r.name FROM reps r WHERE r.id = o.rep_id LIMIT 1), ''),
  o.rep_id,
  o.next_follow_up,
  'normal',
  CASE
    WHEN o.status IN ('Sold / Activation', 'Deal Closed / Won', 'Closed Lost') THEN 'archived'
    ELSE 'open'
  END,
  'migrated_legacy',
  COALESCE(o.updated_at, o.created_at, datetime('now')),
  datetime('now')
FROM opportunities o
WHERE o.next_follow_up IS NOT NULL
  AND o.next_follow_up != ''
  AND o.company_id IS NOT NULL;
