-- 0055: Client portfolio — durable client link on leads + rich client contact fields
-- opportunities.client_id: the missing FK that lets a client page show every
-- lead (open, won, lost) in its portfolio. Previously the frontend clientId
-- was dropped on save because no column existed.
ALTER TABLE opportunities ADD COLUMN client_id TEXT;
CREATE INDEX IF NOT EXISTS idx_opps_client_id ON opportunities(client_id);
-- clients.extra: JSON blob for rich contact fields that do not warrant their
-- own columns (ccEmails[], phone2, mailing address, poc, billingContact,
-- siteContact, paymentMethod, company, homeworksId...). Packed/unpacked by the
-- clients endpoints in src/index.tsx.
ALTER TABLE clients ADD COLUMN extra TEXT;
-- recurring_plans drift fix: the recurring-plans/subscriptions endpoints
-- reference frequency_unit / visit_duration_minutes / services_included but
-- migration 0024 created frequency_days instead. Without these columns every
-- GET /api/recurring-subscriptions 500s (blocks revenue projections).
ALTER TABLE recurring_plans ADD COLUMN frequency_unit TEXT DEFAULT 'weeks';
ALTER TABLE recurring_plans ADD COLUMN visit_duration_minutes INTEGER DEFAULT 60;
ALTER TABLE recurring_plans ADD COLUMN services_included TEXT DEFAULT '';
