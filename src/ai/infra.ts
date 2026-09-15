/**
 * Shared AI infrastructure — credential resolution, chat-completion calls,
 * usage metering, and quota gating.
 *
 * Extracted verbatim from src/index.tsx (where these lived as private,
 * unexported functions) into this leaf module so a standalone router file
 * mounted the same way as marketingRouter/ratesRouter/schedulingRouter (see
 * src/ai/lead-import-routes.ts) can import them without creating an import
 * cycle back into index.tsx — the same reason src/env.ts and
 * src/marketing/leads.ts exist as leaf modules rather than being read back
 * out of index.tsx by anything that needs them.
 *
 * index.tsx now imports from here instead of declaring these itself; every
 * existing call site (generate-proposal, marketing campaign draft, copilot,
 * assistant, parse-lead, generate-quote, multiday questions/update, and the
 * platform admin AI test/quota endpoints) is unchanged — only the
 * declaration moved.
 */

import mig0036 from '../../migrations/0036_ai_usage.sql?raw'

// ── AI usage schema (migration 0036) — auto-creates in prod on first AI request ──
let _ai36SchemaOk = false
export async function ensureAiSchema(db: D1Database): Promise<void> {
  if (_ai36SchemaOk) return
  const flag = await db.prepare("SELECT value FROM settings WHERE key = '_schema_ai_v2' LIMIT 1").first<any>()
  if (flag) { _ai36SchemaOk = true; return }
  const stmts = mig0036.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .split(';').map(x => x.trim()).filter(x => x.length > 0)
  for (const stmt of stmts) {
    try { await db.prepare(stmt).run() } catch (e: any) {
      const msg = String(e?.message || e)
      if (!/already exists|duplicate/i.test(msg)) console.error('[ensureAiSchema]', msg)
    }
  }
  // One-time default: Avalon (the founding tenant) gets platform AI enabled.
  // INSERT OR IGNORE — if the owner later flips it OFF, that choice sticks.
  try { await db.prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('avalon:ai_enabled', '1', datetime('now'))").run() } catch {}
  await db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('_schema_ai_v2', ?, datetime('now'))").bind(new Date().toISOString()).run()
  _ai36SchemaOk = true
}

// Key resolution, in priority order:
//   1. Tenant BYOK      — `{companyId}:openai_api_key` (company pastes their own key)
//   2. Platform master  — `groundwork_platform:openai_api_key`, ONLY if the tenant
//      has been enabled by the platform owner (`{companyId}:ai_enabled` = '1').
//      Usage on the platform key is metered in ai_usage for billing.
//   3. Legacy unprefixed `openai_api_key` (Avalon-era)
//   4. env OPENAI_API_KEY
export async function _aiCreds(db: D1Database, companyId: string, env: any): Promise<{ apiKey: string; baseUrl: string; model: string; keySource: string; aiEnabled: boolean }> {
  const rows = await db.prepare(`SELECT key, value FROM settings WHERE key IN (?,?,?,?,?,?,?,?,?,?)`)
    .bind(`${companyId}:openai_api_key`, `${companyId}:openai_base_url`, `${companyId}:openai_model`, `${companyId}:ai_enabled`,
          'groundwork_platform:openai_api_key', 'groundwork_platform:openai_base_url', 'groundwork_platform:openai_model',
          'openai_api_key', 'openai_base_url', 'openai_model').all()
  let byokKey = '', platKey = '', legacyKey = ''
  let baseUrl = '', model = '', platBase = '', platModel = ''
  let aiEnabledSetting = ''
  for (const r of (rows.results as any[])) {
    if (r.key === `${companyId}:openai_api_key`)  byokKey = r.value
    else if (r.key === `${companyId}:openai_base_url`) baseUrl = r.value
    else if (r.key === `${companyId}:openai_model`)    model = r.value
    else if (r.key === `${companyId}:ai_enabled`)      aiEnabledSetting = r.value
    else if (r.key === 'groundwork_platform:openai_api_key')  platKey = r.value
    else if (r.key === 'groundwork_platform:openai_base_url') platBase = r.value
    else if (r.key === 'groundwork_platform:openai_model')    platModel = r.value
    else if (r.key === 'openai_api_key'  && !legacyKey) legacyKey = r.value
    else if (r.key === 'openai_base_url' && !baseUrl)   baseUrl = r.value
    else if (r.key === 'openai_model'    && !model)     model = r.value
  }
  // The platform owner's own company always has AI on with its own key
  if (companyId === 'groundwork_platform' && !byokKey) byokKey = platKey
  const aiEnabled = aiEnabledSetting === '1'
  let apiKey = '', keySource = ''
  if (byokKey) { apiKey = byokKey; keySource = 'byok' }
  else if (platKey && aiEnabled) { apiKey = platKey; keySource = 'platform'; baseUrl = baseUrl || platBase; model = model || platModel }
  else if (legacyKey) { apiKey = legacyKey; keySource = 'byok' }
  else if (env.OPENAI_API_KEY) { apiKey = env.OPENAI_API_KEY; keySource = 'env' }
  baseUrl = (baseUrl || env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')
  model   = model || 'gpt-5-mini'
  return { apiKey, baseUrl, model, keySource, aiEnabled }
}

// Parse a JSON object out of an AI chat completion, tolerating markdown fences
// AND truncated output (the model ran out of tokens / the response was cut).
// Salvage strategy: strip fences, find the first '{', then re-balance any
// unterminated string/brackets so JSON.parse can succeed on a partial draft.
export function _aiParseJson(rawIn: string): any {
  let raw = String(rawIn || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const start = raw.indexOf('{')
  if (start === -1) throw new Error('No JSON in AI response')
  const end = raw.lastIndexOf('}')
  if (end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)) } catch { /* fall through to salvage */ }
  }
  let out = ''
  let inStr = false, escaped = false
  const stack: string[] = []
  for (const ch of raw.slice(start)) {
    if (escaped) { escaped = false; out += ch; continue }
    if (inStr) {
      if (ch === '\\') { escaped = true; out += ch; continue }
      if (ch === '"') inStr = false
      out += ch
      continue
    }
    if (ch === '"') { inStr = true; out += ch; continue }
    if (ch === '{' || ch === '[') { stack.push(ch); out += ch; continue }
    if (ch === '}' || ch === ']') { stack.pop(); out += ch; continue }
    out += ch
  }
  if (escaped) out = out.slice(0, -1)           // dangling backslash
  if (inStr) out += '"'                          // close unterminated string
  out = out.replace(/,\s*$/, '')                 // trailing comma before we close up
  while (stack.length) { const o = stack.pop(); out += o === '{' ? '}' : ']' }
  return JSON.parse(out)
}

// Call the chat-completions API tuned for FAST structured output. gpt-5-family
// models default to heavy reasoning + verbose prose, which pushed 3-tier quote
// generations past Cloudflare's 100s edge timeout (the browser saw a dead
// request even though the worker finished). reasoning_effort:'low' +
// response_format:json_object cuts completion size/time by ~3x. If the
// configured model rejects those params (custom BYOK models), retry once bare.
// `schema` (optional) asks for a guaranteed shape via Structured Outputs. The
// retry ladder becomes json_schema → json_object → bare, so a BYOK model that
// rejects json_schema still lands on the existing json_object behaviour and
// only a model rejecting both falls all the way through. Callers that pass no
// schema get exactly the previous two-step behaviour.
// `tools` (optional) enables tool calling for the marketing copilot.
export async function _aiChatJson(baseUrl: string, apiKey: string, model: string, messages: any[], schema?: { name: string; schema: any }, tools?: any[]): Promise<any> {
  const call = async (extra: any) => fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, ...(tools && tools.length ? { tools } : {}), ...extra }),
  })
  const fast: any = { response_format: { type: 'json_object' } }
  if (/^(gpt-5|o\d)/i.test(model)) fast.reasoning_effort = 'low'
  if (schema) {
    const strict: any = { ...fast, response_format: { type: 'json_schema', json_schema: { name: schema.name, schema: schema.schema, strict: true } } }
    const r0 = await call(strict)
    if (r0.status !== 400) return r0
    // Falls through to json_object below.
  }
  let r = await call(fast)
  if (r.status === 400) {
    // Model may not support response_format / reasoning_effort — plain retry
    r = await call({})
  }
  return r
}

// Record one metered AI action. Never throws — metering must not break the feature.
export async function _logAiUsage(db: D1Database, companyId: string, repId: string, feature: string, model: string, usage: any, keySource: string): Promise<void> {
  try {
    await ensureAiSchema(db)
    await db.prepare(`INSERT INTO ai_usage (company_id, rep_id, feature, model, prompt_tokens, completion_tokens, total_tokens, key_source)
                      VALUES (?,?,?,?,?,?,?,?)`)
      .bind(companyId, repId || '', feature, model || '',
            Number(usage?.prompt_tokens) || 0, Number(usage?.completion_tokens) || 0,
            Number(usage?.total_tokens) || 0, keySource || 'platform').run()
  } catch (e: any) { console.error('[ai_usage]', e?.message || e) }
}

// ── AI PLAN TIERS & MONTHLY QUOTAS (Phase 2) ─────────────────────────────────
// Plans apply ONLY to platform-key usage (BYOK tenants are never capped — it's
// their own key/money). Caps are AI actions per calendar month.
//   starter   → 200 actions/mo (default for every enabled tenant)
//   pro       → 1,000 actions/mo
//   unlimited → no cap
// Override per tenant with `{companyId}:ai_custom_cap` (a number; 0 = no cap).
// Real Groundwork tiers — CRM plans include AI actions; AI packages are add-ons.
// 0 = uncapped (enterprise/custom/unlimited).
export const AI_PLAN_CAPS = {
  starter: 50, core: 100, growth: 250, pro: 500, enterprise: 0,
  essentials: 500, plus: 1500, max: 5000,
  unlimited: 0,
} satisfies Record<string, number>

/** Normalises a stored plan name to one this table actually prices. */
export const aiPlanOf = (plan: string | undefined): keyof typeof AI_PLAN_CAPS =>
  (plan && plan in AI_PLAN_CAPS) ? (plan as keyof typeof AI_PLAN_CAPS) : 'starter'

export async function _aiQuota(db: D1Database, companyId: string): Promise<{ plan: string; cap: number; used: number; remaining: number; warn: boolean; blocked: boolean }> {
  await ensureAiSchema(db)
  const rows = await db.prepare(`SELECT key, value FROM settings WHERE key IN (?,?)`)
    .bind(`${companyId}:ai_plan`, `${companyId}:ai_custom_cap`).all()
  let plan = 'starter', customCap = ''
  for (const r of (rows.results as any[])) {
    if (r.key === `${companyId}:ai_plan`) plan = String(r.value || 'starter')
    else if (r.key === `${companyId}:ai_custom_cap`) customCap = String(r.value || '')
  }
  if (!(plan in AI_PLAN_CAPS)) plan = 'starter'
  // `plan` was forced into AI_PLAN_CAPS on the line above; the fallback restates
  // that rather than asserting it, so a future edit to that guard cannot make
  // this silently `undefined` — which would read as `cap > 0` false, i.e. UNLIMITED.
  let cap = AI_PLAN_CAPS[aiPlanOf(plan)]
  if (customCap !== '' && isFinite(Number(customCap))) cap = Number(customCap)
  const u: any = await db.prepare(
    `SELECT COUNT(*) AS n FROM ai_usage WHERE company_id = ? AND key_source = 'platform' AND created_at >= datetime('now','start of month')`
  ).bind(companyId).first()
  const used = Number(u?.n) || 0
  const remaining = cap > 0 ? Math.max(0, cap - used) : -1  // -1 = unlimited
  return {
    plan, cap, used, remaining,
    warn:    cap > 0 && used >= Math.floor(cap * 0.8) && used < cap,
    blocked: cap > 0 && used >= cap,
  }
}

// Gate a tenant AI request against its monthly quota. Only platform-key usage
// counts; returns null when the request may proceed, or a ready error payload.
export async function _aiQuotaGate(db: D1Database, companyId: string, keySource: string): Promise<{ status: number; body: any } | null> {
  if (keySource !== 'platform') return null
  const q = await _aiQuota(db, companyId)
  if (q.blocked) {
    return { status: 429, body: { ok: false, error: 'quota_exceeded', message: `Your team has used all ${q.cap} AI actions in your ${q.plan} plan this month. Upgrade your AI plan or wait for the monthly reset.`, quota: q } }
  }
  return null
}
