-- Migration 0045: Multi-day jobs — per-day crew checklists that auto-publish
-- client portal updates. A multi-day work order gets N wo_days rows; each day
-- carries AI-generated yes/no questions the crew must answer (with a photo per
-- question) before completing the day. Completing a day composes a client
-- update (AI) and publishes it to project_updates automatically.

ALTER TABLE work_orders ADD COLUMN is_multiday INTEGER DEFAULT 0;
ALTER TABLE work_orders ADD COLUMN total_days INTEGER DEFAULT 1;

CREATE TABLE IF NOT EXISTS wo_days (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  work_order_id TEXT NOT NULL,
  day_number    INTEGER NOT NULL DEFAULT 1,
  day_date      TEXT DEFAULT '',                -- scheduled date for this day
  scope         TEXT DEFAULT '',                -- what is planned for this day
  questions     TEXT NOT NULL DEFAULT '[]',     -- JSON [{q, answer, photo_media_id, answered_at, answered_by}]
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | in_progress | completed
  completed_at  TEXT DEFAULT '',
  completed_by  TEXT DEFAULT '',                -- rep id who completed the day
  update_id     TEXT DEFAULT '',                -- project_updates.id published for this day
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wodays_wo_day ON wo_days(work_order_id, day_number);
CREATE INDEX IF NOT EXISTS idx_wodays_company ON wo_days(company_id);
