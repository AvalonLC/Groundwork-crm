/**
 * Audience compiler.
 *
 * Turns a saved filter (marketing_audience.filter_json) into ONE parameterized
 * SQL statement over the CRM's own tables. A saved audience is a definition,
 * not a list of ids: it stays live until a campaign snapshots it into
 * marketing_campaign_recipient at send time.
 *
 * Three properties this module is responsible for, in order of how much damage
 * their absence would do:
 *
 *   1. NO INTERPOLATION. Field names are looked up in a hardcoded whitelist and
 *      every value is bound. A filter is authored by an operator in the UI and,
 *      in Phase 2, by an AI copilot — neither is a trusted source of SQL.
 *
 *   2. EVERY QUERY IS COMPANY-SCOPED. Each arm of the pool and every EXISTS
 *      subquery carries its own company_id predicate. A missing one leaks one
 *      tenant's client list into another tenant's campaign.
 *
 *   3. ONE EMAIL IS ONE RECIPIENT. A commercial client with six contacts on
 *      info@ must receive one copy, not six. Dedupe happens here, and again as
 *      a UNIQUE index on marketing_campaign_recipient(campaign_id, email).
 *
 * Suppression is excluded here at count time and again at snapshot time and a
 * third time immediately before each batch is handed to the provider. Three
 * checks is deliberate: the count is advisory, the snapshot can be hours stale
 * by the time a large send drains, and only the last one is authoritative.
 *
 * Geography note: properties/clients carry free-text city/state/zip and no
 * lat/lng, county or parcel data. "Fairfax County" is therefore not expressible
 * today; a seeded zip-to-county lookup is the cheap path to it later.
 */

export interface AudienceRule {
  field: string;
  op: string;
  value?: unknown;
}

export type AudienceSource = 'contacts' | 'clients' | 'leads';

export interface AudienceFilter {
  version: number;
  match: 'all' | 'any';
  /** Which populations to draw from. Defaults to contacts + clients. */
  sources?: AudienceSource[];
  rules: AudienceRule[];
}

export interface CompiledQuery {
  sql: string;
  binds: unknown[];
}

export interface CompileResult extends CompiledQuery {
  /** Rules that were dropped, with the reason. Surfaced in the UI. */
  warnings: string[];
}

// ── field whitelist ──────────────────────────────────────────────────────────

type FieldKind = 'text' | 'date';

interface FieldDef {
  /** SQL expression, always referencing the pool alias `p`. */
  expr: string;
  kind: FieldKind;
  label: string;
}

/**
 * The only fields a filter may reference. Anything else is dropped with a
 * warning rather than being passed through to SQL.
 */
export const AUDIENCE_FIELDS: Record<string, FieldDef> = {
  client_type: { expr: 'p.client_type', kind: 'text', label: 'Client type' },
  client_status: { expr: 'p.client_status', kind: 'text', label: 'Client status' },
  client_tag: { expr: 'p.client_tags', kind: 'text', label: 'Client tag' },
  city: { expr: 'p.city', kind: 'text', label: 'City' },
  state: { expr: 'p.state', kind: 'text', label: 'State' },
  zip: { expr: 'p.zip', kind: 'text', label: 'ZIP' },
  client_since: { expr: 'p.client_since', kind: 'date', label: 'Client since' },
  email_domain: { expr: "substr(p.email_key, instr(p.email_key,'@')+1)", kind: 'text', label: 'Email domain' },
  source: { expr: 'p.source', kind: 'text', label: 'Record source' },
};

/**
 * Fields backed by an EXISTS subquery rather than a pool column. Kept separate
 * because they need the company_id bind threaded into the subquery.
 */
export const AUDIENCE_HISTORY_FIELDS = [
  'serviced_type',
  'not_serviced_type',
  'serviced_since',
  'serviced_before',
  'has_sold_job',
  'never_sold',
] as const;

const TEXT_OPS = ['in', 'not_in', 'eq', 'neq', 'contains', 'not_contains', 'is_empty', 'not_empty'];
const DATE_OPS = ['before', 'after', 'is_empty', 'not_empty'];

// ── helpers ──────────────────────────────────────────────────────────────────

const asList = (v: unknown): string[] => {
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .map((x) => String(x ?? '').trim())
    .filter((x) => x !== '')
    .slice(0, 200);
};

const asText = (v: unknown): string => String(v ?? '').trim();

/** SQLite has no ILIKE; LIKE on lower()'d operands is the portable equivalent. */
const lower = (expr: string) => `lower(coalesce(${expr},''))`;

// ── rule compilation ─────────────────────────────────────────────────────────

interface RuleSql {
  sql: string;
  binds: unknown[];
}

function compileHistoryRule(companyId: string, rule: AudienceRule): RuleSql | string {
  const values = asList(rule.value);
  switch (rule.field) {
    case 'serviced_type':
    case 'not_serviced_type': {
      if (!values.length) return `"${rule.field}" needs at least one service type`;
      const holes = values.map(() => '?').join(',');
      const not = rule.field === 'not_serviced_type' ? 'NOT ' : '';
      return {
        sql:
          `${not}EXISTS (SELECT 1 FROM work_orders w WHERE w.company_id = ? ` +
          `AND w.client_id = p.client_id AND lower(coalesce(w.type,'')) IN (${holes}))`,
        binds: [companyId, ...values.map((v) => v.toLowerCase())],
      };
    }
    case 'serviced_since':
    case 'serviced_before': {
      const date = asText(rule.value);
      if (!date) return `"${rule.field}" needs a date`;
      const cmp = rule.field === 'serviced_since' ? '>=' : '<';
      return {
        sql:
          `EXISTS (SELECT 1 FROM work_orders w WHERE w.company_id = ? ` +
          `AND w.client_id = p.client_id AND coalesce(w.scheduled_date,'') <> '' ` +
          `AND w.scheduled_date ${cmp} ?)`,
        binds: [companyId, date],
      };
    }
    case 'has_sold_job':
    case 'never_sold': {
      const not = rule.field === 'never_sold' ? 'NOT ' : '';
      return {
        sql:
          `${not}EXISTS (SELECT 1 FROM opportunities o2 WHERE o2.company_id = ? ` +
          `AND o2.client_id = p.client_id AND coalesce(o2.sold_date,'') <> '')`,
        binds: [companyId],
      };
    }
    default:
      return `unknown history field "${rule.field}"`;
  }
}

/** Returns compiled SQL, or a string describing why the rule was dropped. */
function compileRule(companyId: string, rule: AudienceRule): RuleSql | string {
  if (!rule || typeof rule !== 'object') return 'malformed rule';
  const field = asText(rule.field);
  const op = asText(rule.op).toLowerCase();

  if ((AUDIENCE_HISTORY_FIELDS as readonly string[]).includes(field)) {
    return compileHistoryRule(companyId, rule);
  }

  const def = AUDIENCE_FIELDS[field];
  if (!def) return `unknown field "${field}"`;

  const allowed = def.kind === 'date' ? DATE_OPS : TEXT_OPS;
  if (!allowed.includes(op)) return `operator "${op}" is not valid for "${field}"`;

  switch (op) {
    case 'is_empty':
      return { sql: `trim(coalesce(${def.expr},'')) = ''`, binds: [] };
    case 'not_empty':
      return { sql: `trim(coalesce(${def.expr},'')) <> ''`, binds: [] };
    case 'in':
    case 'not_in': {
      const values = asList(rule.value);
      if (!values.length) return `"${field}" needs at least one value`;
      const holes = values.map(() => '?').join(',');
      const not = op === 'not_in' ? 'NOT ' : '';
      return { sql: `${not}(${lower(def.expr)} IN (${holes}))`, binds: values.map((v) => v.toLowerCase()) };
    }
    case 'eq':
    case 'neq': {
      const v = asText(rule.value);
      if (!v) return `"${field}" needs a value`;
      return { sql: `${lower(def.expr)} ${op === 'eq' ? '=' : '<>'} ?`, binds: [v.toLowerCase()] };
    }
    case 'contains':
    case 'not_contains': {
      const v = asText(rule.value);
      if (!v) return `"${field}" needs a value`;
      // ESCAPE so a literal % or _ in the operator's value is not a wildcard.
      const not = op === 'not_contains' ? 'NOT ' : '';
      const esc = v.toLowerCase().replace(/([%_\\])/g, '\\$1');
      return { sql: `${not}(${lower(def.expr)} LIKE ? ESCAPE '\\')`, binds: [`%${esc}%`] };
    }
    case 'before':
    case 'after': {
      const v = asText(rule.value);
      if (!v) return `"${field}" needs a date`;
      return {
        sql: `(trim(coalesce(${def.expr},'')) <> '' AND ${def.expr} ${op === 'before' ? '<' : '>='} ?)`,
        binds: [v],
      };
    }
    default:
      return `operator "${op}" is not supported`;
  }
}

// ── the pool ─────────────────────────────────────────────────────────────────

/**
 * Normalized contactable people, one row per (source, email). Every arm
 * produces the same column list so rules can be written once and applied to
 * the union rather than per arm.
 *
 * source_rank decides which row survives dedupe: a primary contact beats a
 * secondary contact, which beats the catch-all address on the client record,
 * which beats an unconverted lead.
 */
function poolSql(companyId: string, sources: AudienceSource[]): CompiledQuery {
  const arms: string[] = [];
  const binds: unknown[] = [];

  if (sources.includes('contacts')) {
    arms.push(
      `SELECT lower(trim(cc.email)) AS email_key, trim(cc.email) AS email, ` +
        `coalesce(cc.name,'') AS full_name, cc.id AS contact_id, cl.id AS client_id, ` +
        `NULL AS opportunity_id, cl.type AS client_type, cl.status AS client_status, ` +
        `cl.tags AS client_tags, cl.city AS city, cl.state AS state, cl.zip AS zip, ` +
        `cl.since AS client_since, ` +
        `CASE WHEN cc.is_primary = 1 THEN 0 ELSE 1 END AS source_rank, 'contact' AS source ` +
        `FROM client_contacts cc ` +
        `JOIN clients cl ON cl.id = cc.client_id AND cl.company_id = cc.company_id ` +
        `WHERE cc.company_id = ? AND cc.active = 1 AND trim(coalesce(cc.email,'')) <> ''`,
    );
    binds.push(companyId);
  }

  if (sources.includes('clients')) {
    arms.push(
      `SELECT lower(trim(cl.email)) AS email_key, trim(cl.email) AS email, ` +
        `coalesce(cl.name,'') AS full_name, NULL AS contact_id, cl.id AS client_id, ` +
        `NULL AS opportunity_id, cl.type AS client_type, cl.status AS client_status, ` +
        `cl.tags AS client_tags, cl.city AS city, cl.state AS state, cl.zip AS zip, ` +
        `cl.since AS client_since, 2 AS source_rank, 'client' AS source ` +
        `FROM clients cl ` +
        `WHERE cl.company_id = ? AND trim(coalesce(cl.email,'')) <> ''`,
    );
    binds.push(companyId);
  }

  if (sources.includes('leads')) {
    // Only opportunities that never became a client — anyone already converted
    // is reachable through the contacts/clients arms with better data.
    arms.push(
      `SELECT lower(trim(o.email)) AS email_key, trim(o.email) AS email, ` +
        `coalesce(o.client,'') AS full_name, NULL AS contact_id, NULL AS client_id, ` +
        `o.id AS opportunity_id, o.client_type AS client_type, o.status AS client_status, ` +
        `'' AS client_tags, NULL AS city, NULL AS state, NULL AS zip, ` +
        `NULL AS client_since, 3 AS source_rank, 'lead' AS source ` +
        `FROM opportunities o ` +
        `WHERE o.company_id = ? AND trim(coalesce(o.email,'')) <> '' ` +
        `AND coalesce(o.client_id,'') = ''`,
    );
    binds.push(companyId);
  }

  return { sql: arms.join(' UNION ALL '), binds };
}

export function normalizeSources(v: unknown): AudienceSource[] {
  const valid: AudienceSource[] = ['contacts', 'clients', 'leads'];
  if (!Array.isArray(v)) return ['contacts', 'clients'];
  const out = v.map((x) => String(x)).filter((x): x is AudienceSource => (valid as string[]).includes(x));
  return out.length ? Array.from(new Set(out)) : ['contacts', 'clients'];
}

export function parseFilter(input: unknown): AudienceFilter {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      raw = null;
    }
  }
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rules = Array.isArray(o.rules) ? o.rules : [];
  return {
    version: 1,
    match: o.match === 'any' ? 'any' : 'all',
    sources: normalizeSources(o.sources),
    rules: rules.slice(0, 40).map((r) => {
      const ro = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
      return { field: asText(ro.field), op: asText(ro.op), value: ro.value };
    }),
  };
}

// ── entry points ─────────────────────────────────────────────────────────────

const SELECT_COLUMNS =
  `p.email AS email, p.full_name AS full_name, p.contact_id AS contact_id, ` +
  `p.client_id AS client_id, p.opportunity_id AS opportunity_id, p.source AS source, ` +
  `MIN(p.source_rank) AS source_rank`;

/**
 * Build the recipient query for a filter.
 *
 * The dedupe relies on SQLite's documented bare-column behaviour: when a query
 * contains exactly one min() or max() aggregate, the bare columns in the same
 * row come from the row that produced that extreme value. So MIN(source_rank)
 * with GROUP BY email_key returns the best record for each address — the
 * primary contact rather than an arbitrary one. D1 is SQLite, so this holds.
 */
export function compileAudience(
  companyId: string,
  filterInput: unknown,
  opts: { includeSuppressed?: boolean; limit?: number } = {},
): CompileResult {
  const filter = parseFilter(filterInput);
  const sources = normalizeSources(filter.sources);
  const pool = poolSql(companyId, sources);
  const binds: unknown[] = [...pool.binds];
  const warnings: string[] = [];

  const clauses: string[] = [];
  for (const rule of filter.rules) {
    const compiled = compileRule(companyId, rule);
    if (typeof compiled === 'string') {
      warnings.push(compiled);
      continue;
    }
    clauses.push(compiled.sql);
    binds.push(...compiled.binds);
  }

  // An 'any' match with zero usable rules must not silently become "everyone".
  // 'all' with zero rules legitimately means the whole pool.
  let where = '1=1';
  if (clauses.length) {
    where = clauses.map((c) => `(${c})`).join(filter.match === 'any' ? ' OR ' : ' AND ');
  } else if (filter.match === 'any' && filter.rules.length) {
    where = '1=0';
    warnings.push('no usable rules in an "any" filter — matching nobody rather than everybody');
  }

  let suppression = '';
  if (!opts.includeSuppressed) {
    suppression =
      ` AND NOT EXISTS (SELECT 1 FROM marketing_suppression s ` +
      `WHERE s.company_id = ? AND s.email = p.email_key)`;
    binds.push(companyId);
  }

  let sql =
    `WITH pool AS (${pool.sql}) ` +
    `SELECT ${SELECT_COLUMNS} FROM pool p ` +
    `WHERE (${where})${suppression} ` +
    `GROUP BY p.email_key ORDER BY p.full_name COLLATE NOCASE`;

  if (opts.limit && Number.isFinite(opts.limit)) {
    sql += ` LIMIT ${Math.max(1, Math.min(5000, Math.floor(opts.limit)))}`;
  }

  return { sql, binds, warnings };
}

/** COUNT(*) over the same definition. */
export function compileAudienceCount(companyId: string, filterInput: unknown): CompileResult {
  const inner = compileAudience(companyId, filterInput);
  return {
    sql: `SELECT COUNT(*) AS n FROM (${inner.sql}) q`,
    binds: inner.binds,
    warnings: inner.warnings,
  };
}

/** How many distinct addresses the filter matched but suppression removed. */
export function compileSuppressedCount(companyId: string, filterInput: unknown): CompileResult {
  const all = compileAudience(companyId, filterInput, { includeSuppressed: true });
  const live = compileAudience(companyId, filterInput);
  return {
    sql: `SELECT (SELECT COUNT(*) FROM (${all.sql}) a) - (SELECT COUNT(*) FROM (${live.sql}) b) AS n`,
    binds: [...all.binds, ...live.binds],
    warnings: all.warnings,
  };
}

/** Split a stored full name into the parts the merge tags need. */
export function splitName(full: string): { first: string; last: string } {
  const s = String(full ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return { first: '', last: '' };
  const parts = s.split(' ');
  if (parts.length === 1) return { first: parts[0] ?? '', last: '' };
  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
}

/** Human-readable description of a filter, for the campaign review screen. */
export function describeFilter(filterInput: unknown): string {
  const filter = parseFilter(filterInput);
  const sources = normalizeSources(filter.sources).join(' + ');
  if (!filter.rules.length) return `Everyone in ${sources}`;
  const parts = filter.rules.map((r) => {
    const def = AUDIENCE_FIELDS[r.field];
    const label = def ? def.label : r.field;
    const value = Array.isArray(r.value) ? r.value.join(', ') : String(r.value ?? '');
    return `${label} ${r.op.replace(/_/g, ' ')}${value ? ` ${value}` : ''}`;
  });
  return `${sources} where ${parts.join(filter.match === 'any' ? ' OR ' : ' AND ')}`;
}
