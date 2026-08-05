-- Admin-editable overrides for config/finance/*.json. The JSON files remain
-- the safe-default source of truth (version-controlled, deployed with the
-- app); a row here replaces the effective config for one config_name,
-- either globally ('__global__') or per-tenant. Tenant-specific overrides
-- take precedence over a global override, which takes precedence over the
-- static JSON default. See src/config/finance-config-runtime.ts.

CREATE TABLE finance_config_override (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL DEFAULT '__global__',
  config_name  TEXT NOT NULL, -- e.g. 'classifier_rules', 'ingest_sources'
  config_json  TEXT NOT NULL, -- full replacement blob, same shape as the static default
  updated_by   TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_finance_config_override_scope ON finance_config_override(tenant_id, config_name);
