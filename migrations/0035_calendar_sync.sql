-- 0035: Google Calendar sync — pull booked meetings into Groundwork,
-- match attendees to leads, and drive post-meeting task automation.

CREATE TABLE IF NOT EXISTS calendar_events (
  id              TEXT PRIMARY KEY,           -- google event id
  company_id      TEXT NOT NULL DEFAULT '',
  rep_id          TEXT NOT NULL DEFAULT '',   -- whose Google account it synced from
  rep_email       TEXT DEFAULT '',
  summary         TEXT DEFAULT '',
  description     TEXT DEFAULT '',
  location        TEXT DEFAULT '',
  start_at        TEXT DEFAULT '',            -- ISO datetime (or date for all-day)
  end_at          TEXT DEFAULT '',
  all_day         INTEGER NOT NULL DEFAULT 0,
  attendees       TEXT DEFAULT '[]',          -- [{email,name,response}]
  organizer_email TEXT DEFAULT '',
  hangout_link    TEXT DEFAULT '',
  html_link       TEXT DEFAULT '',            -- open-in-Google link
  color_id        TEXT DEFAULT '',
  status          TEXT DEFAULT 'confirmed',   -- confirmed | cancelled
  event_type      TEXT DEFAULT '',            -- google eventType (birthday, fromGmail, default…)
  is_booking      INTEGER NOT NULL DEFAULT 0, -- came from an appointment-schedule booking page
  opp_id          TEXT DEFAULT '',            -- matched Groundwork lead/client
  opp_match_how   TEXT DEFAULT '',            -- attendee_email | manual | description_tag
  automation_done INTEGER NOT NULL DEFAULT 0, -- post-meeting follow-up task created
  synced_at       TEXT NOT NULL DEFAULT (datetime('now')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_calev_company_start ON calendar_events(company_id, start_at);
CREATE INDEX IF NOT EXISTS idx_calev_opp           ON calendar_events(opp_id);
CREATE INDEX IF NOT EXISTS idx_calev_rep           ON calendar_events(rep_id, start_at);
