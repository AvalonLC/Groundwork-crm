-- 0063_marketing_link_key.sql — Marketing OS.
--
-- Separates a tracked link's per-campaign key from its globally unique row id.
--
-- The renderer numbers links in document order (lnk_1, lnk_2, ...) so that
-- re-rendering a campaign yields the same ids and a link already sitting in
-- someone's inbox keeps resolving. That determinism is the point — but it also
-- means EVERY campaign produces a link called lnk_1, and marketing_link.id is
-- a PRIMARY KEY, so the second campaign to be rendered collided with the first.
--
-- The URL keeps the short key (/c/:track_token/:link_key); the row id becomes
-- campaign-qualified. Caught by src/marketing/public.test.ts before this ever
-- reached a real send.

ALTER TABLE marketing_link ADD COLUMN link_key TEXT NOT NULL DEFAULT '';

-- Backfill: any row written before this migration used the bare key as its id.
UPDATE marketing_link SET link_key = id WHERE link_key = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_mkt_link_key ON marketing_link(campaign_id, link_key);
