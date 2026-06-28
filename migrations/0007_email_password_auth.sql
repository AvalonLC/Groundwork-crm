-- ============================================================
-- Groundwork CRM — Migration 0007
-- Email + Password Authentication
--
-- Changes:
--   1. Set email addresses for existing Avalon reps so every
--      user has a unique login email.
--   2. Add a unique index on (email) so no two active reps
--      can share the same email (login key).
--   3. The existing pin_hash column now stores the PBKDF2
--      password hash — no schema change needed, the column
--      is simply used for longer/text passwords going forward.
--   4. The legacy plain-text pin column is cleared where set.
--
-- After this migration runs, login is:
--   email + password  →  session cookie
-- instead of:
--   rep-picker + PIN  →  session cookie
-- ============================================================

-- Set emails for Avalon reps that are missing them
UPDATE reps SET email = 'jen@avalon-lc.com'  WHERE id = 'jen'  AND company_id = 'avalon' AND (email = '' OR email IS NULL);
UPDATE reps SET email = 'ryan@avalon-lc.com' WHERE id = 'ryan' AND company_id = 'avalon' AND (email = '' OR email IS NULL);

-- Clear any remaining plain-text PINs now that hashed auth is fully live
-- (Any rep without a pin_hash will need to use Forgot Password to set one)
UPDATE reps SET pin = '' WHERE pin != '' AND pin_hash != '';

-- Unique partial index: each email must be unique across ALL active reps.
-- SQLite partial indexes (WHERE email != '') prevent blank emails from conflicting.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reps_email_unique
  ON reps(email)
  WHERE email != '' AND email IS NOT NULL;
