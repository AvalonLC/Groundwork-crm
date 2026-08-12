-- 0062_marketing_send_attempts.sql — Marketing OS.
--
-- Adds a per-recipient attempt counter to the send snapshot.
--
-- Why this is not folded into 0060: the drain re-queues a batch when the
-- provider returns a transient error (429, 5xx) and the reaper re-queues rows
-- whose worker died mid-batch. Without a bound, a recipient the provider will
-- never accept cycles queued -> sending -> queued forever, and every cron tick
-- spends its budget on the same doomed batch instead of the rest of the
-- campaign. The counter is what lets the drain give up and mark a row 'failed'
-- with its last error, where a human can see it.
--
-- Kept as a separate migration rather than an edit to 0060 because 0060 may
-- already have been applied to a local database.

ALTER TABLE marketing_campaign_recipient ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
