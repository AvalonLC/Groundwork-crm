-- ============================================================
-- Groundwork CRM — Company Branding & Identity System
-- Migration: 0021_company_branding
--
-- Adds rich branding and identity fields to the companies table.
-- Supports any business type: blue collar, home services, excavation,
-- small (1-person) through large (10+ crews, 5+ divisions).
-- ============================================================

-- ── Extend companies table with branding columns ─────────────
-- logo_url already exists from 0003, adding new branding fields
ALTER TABLE companies ADD COLUMN tagline          TEXT DEFAULT '';
ALTER TABLE companies ADD COLUMN brand_color      TEXT DEFAULT '#2D7A55';
ALTER TABLE companies ADD COLUMN brand_accent     TEXT DEFAULT '#4D8A86';
ALTER TABLE companies ADD COLUMN business_type    TEXT DEFAULT 'home_services';
ALTER TABLE companies ADD COLUMN crew_count       INTEGER DEFAULT 1;
ALTER TABLE companies ADD COLUMN division_count   INTEGER DEFAULT 1;
ALTER TABLE companies ADD COLUMN address_line1    TEXT DEFAULT '';
ALTER TABLE companies ADD COLUMN address_city     TEXT DEFAULT '';
ALTER TABLE companies ADD COLUMN address_state    TEXT DEFAULT '';
ALTER TABLE companies ADD COLUMN address_zip      TEXT DEFAULT '';
ALTER TABLE companies ADD COLUMN license_number   TEXT DEFAULT '';
ALTER TABLE companies ADD COLUMN insurance_info   TEXT DEFAULT '';
ALTER TABLE companies ADD COLUMN year_founded     INTEGER DEFAULT 0;
ALTER TABLE companies ADD COLUMN service_area_desc TEXT DEFAULT '';
ALTER TABLE companies ADD COLUMN terminology      TEXT DEFAULT '{}';
-- terminology JSON: {"workOrder":"Work Order","estimate":"Estimate","crew":"Crew","division":"Division"}
-- Allows businesses to rename terms to match their culture:
-- excavation: work order → "Dig Order", crew → "Team"
-- HVAC: work order → "Service Call", crew → "Tech"
-- Landscaping: crew → "Crew", division → "Division" (default)

-- ── Seed Avalon branding ──────────────────────────────────────
UPDATE companies
SET
  tagline        = 'Professional Landscape Construction',
  brand_color    = '#2D7A55',
  brand_accent   = '#4D8A86',
  business_type  = 'landscaping',
  crew_count     = 5,
  division_count = 2,
  address_line1  = '123 Main St',
  address_city   = 'Richmond',
  address_state  = 'VA',
  address_zip    = '23219',
  year_founded   = 2018,
  service_area_desc = 'Greater Richmond Metro Area',
  terminology    = '{"workOrder":"Work Order","estimate":"Estimate","crew":"Crew","division":"Division","client":"Client","invoice":"Invoice"}'
WHERE id = 'avalon';
