-- Staff "Preview Portal" sessions ────────────────────────────────────────────
-- Lets an authenticated staff member open a specific client's portal in a
-- locked-down, read-only mode (no payment/card details, no approvals, no
-- charges, no contact changes) without needing the client's password and
-- without requiring the client to have a portal account at all.
--
-- Reuses the existing portal_sessions table + gw_portal_session cookie so no
-- new auth plumbing is needed on the client-facing side. requirePortalAuth()
-- in src/portal.tsx checks is_preview and, when set, synthesizes a scoped
-- PortalScope for preview_client_id directly instead of loading a real
-- portal_user + memberships row.
ALTER TABLE portal_sessions ADD COLUMN is_preview INTEGER NOT NULL DEFAULT 0;
ALTER TABLE portal_sessions ADD COLUMN preview_client_id TEXT NOT NULL DEFAULT '';
ALTER TABLE portal_sessions ADD COLUMN preview_company_id TEXT NOT NULL DEFAULT '';
ALTER TABLE portal_sessions ADD COLUMN preview_rep_id TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_psess_preview ON portal_sessions(is_preview, preview_client_id);
