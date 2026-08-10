// ═══════════════════════════════════════════════════════════════════════════
// GROUNDWORK CLIENT PORTAL — Release 1, Phase 1A
// Identity, authentication, scoping, audit, internal administration.
//
// Design rules (see product spec):
//  - Portal auth is a SEPARATE world from staff auth: own cookie
//    (gw_portal_session), own sessions table. A staff session never satisfies
//    portal auth and vice versa.
//  - Every portal request re-resolves user -> memberships -> clients ->
//    properties server-side. Disabling a user/membership takes effect on the
//    next request.
//  - Portal APIs select explicit client-safe columns. Never SELECT * to client.
//  - All significant events are audit logged with actor_type='portal'.
// ═══════════════════════════════════════════════════════════════════════════
import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import mig0041 from '../migrations/0041_properties.sql?raw'
import mig0042 from '../migrations/0042_portal_identity.sql?raw'
import mig0043 from '../migrations/0043_project_updates.sql?raw'
import mig0044 from '../migrations/0044_portal_payments.sql?raw'
import mig0045 from '../migrations/0045_multiday_jobs.sql?raw'
import mig0056 from '../migrations/0056_portal_preview.sql?raw'

type Env = { Bindings: { DB: D1Database; MEDIA: R2Bucket; SENDGRID_API_KEY?: string } }

// ── Portal schema self-heal ──────────────────────────────────────────────────
// Applies migrations 0041 + 0042 idempotently at runtime (same pattern as
// ensureFullSchema in index.tsx). Guarded by a settings flag + module memo.
let _portalSchemaOk = false
async function ensurePortalSchema(db: D1Database): Promise<void> {
  if (_portalSchemaOk) return
  try {
    const flag = await db.prepare("SELECT value FROM settings WHERE key = '_schema_portal_v6' LIMIT 1").first<any>()
    if (flag) { _portalSchemaOk = true; return }
  } catch (_) {}
  const migs: Array<[string, string]> = [['0041_properties.sql', mig0041], ['0042_portal_identity.sql', mig0042], ['0043_project_updates.sql', mig0043], ['0044_portal_payments.sql', mig0044], ['0045_multiday_jobs.sql', mig0045], ['0056_portal_preview.sql', mig0056]]
  for (const [name, sql] of migs) {
    // Strip inline "--" comments too: 0042 has comments containing ';' which
    // would otherwise break statement splitting (no '--' inside literals here).
    const stmts = sql.split('\n').map(l => l.replace(/--.*$/, '')).join('\n')
      .split(';').map(s => s.trim()).filter(s => s.length > 0)
    for (const stmt of stmts) {
      try { await db.prepare(stmt).run() } catch (e: any) {
        const msg = String(e?.message || e)
        if (!/duplicate column|already exists|UNIQUE constraint/i.test(msg)) {
          console.log('ensurePortalSchema skip-error', name, msg.slice(0, 120))
        }
      }
    }
    // Keep wrangler migration bookkeeping consistent
    try {
      await db.prepare('INSERT INTO d1_migrations (name, applied_at) SELECT ?, CURRENT_TIMESTAMP WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = ?)').bind(name, name).run()
    } catch (_) {}
  }
  try {
    await db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('_schema_portal_v6', ?, datetime('now'))").bind(new Date().toISOString()).run()
  } catch (_) {}
  _portalSchemaOk = true
}

// ── Small local helpers (self-contained to avoid circular imports) ──────────
const pUid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
const nowIso = () => new Date().toISOString()

async function pHash(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, key, 256)
  const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')
  return `pbkdf2:100000:${hex(salt)}:${hex(new Uint8Array(bits))}`
}
async function pVerify(pw: string, stored: string): Promise<boolean> {
  if (!stored || !stored.startsWith('pbkdf2:')) return false
  const parts = stored.split(':'); if (parts.length !== 4) return false
  const [, iters, saltHex, hashHex] = parts
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(h => parseInt(h, 16)))
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: parseInt(iters) }, key, 256)
  const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')
  return hex(new Uint8Array(bits)) === hashHex
}
const escH = (s: any) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// ── Audit ────────────────────────────────────────────────────────────────────
export async function portalAudit(db: D1Database, e: {
  companyId: string; actorType: 'staff' | 'portal' | 'system'; repId?: string;
  portalUserId?: string; clientId?: string; eventType: string;
  entityType?: string; entityId?: string; entityLabel?: string; meta?: any; ip?: string;
}) {
  try {
    await db.prepare(`INSERT INTO audit_log (id, company_id, rep_id, event_type, entity_type, entity_id, entity_label, meta, created_at, actor_type, portal_user_id, client_id, ip)
      VALUES (?,?,?,?,?,?,?,?,datetime('now'),?,?,?,?)`)
      .bind('aud_' + pUid(), e.companyId, e.repId || null, e.eventType, e.entityType || '', e.entityId || '',
        e.entityLabel || '', JSON.stringify(e.meta || {}), e.actorType, e.portalUserId || '', e.clientId || '', e.ip || '').run()
  } catch (_) { /* audit must never break the request */ }
}

// ── Role presets ─────────────────────────────────────────────────────────────
export const PORTAL_PERMISSIONS = [
  'view_projects', 'view_estimates', 'approve_estimates', 'view_billing', 'make_payments',
  'view_payment_history', 'manage_payment_methods', 'manage_autopay', 'view_documents', 'manage_contacts'
] as const

export const PORTAL_ROLE_PRESETS: Record<string, Record<string, boolean>> = {
  account_admin: { view_projects: true, view_estimates: true, approve_estimates: true, view_billing: true, make_payments: true, view_payment_history: true, manage_payment_methods: true, manage_autopay: true, view_documents: true, manage_contacts: true },
  billing:       { view_projects: false, view_estimates: false, approve_estimates: false, view_billing: true, make_payments: true, view_payment_history: true, manage_payment_methods: true, manage_autopay: true, view_documents: true, manage_contacts: false },
  project:       { view_projects: true, view_estimates: false, approve_estimates: false, view_billing: false, make_payments: false, view_payment_history: false, manage_payment_methods: false, manage_autopay: false, view_documents: true, manage_contacts: false },
  approver:      { view_projects: true, view_estimates: true, approve_estimates: true, view_billing: false, make_payments: false, view_payment_history: false, manage_payment_methods: false, manage_autopay: false, view_documents: true, manage_contacts: false },
  read_only:     { view_projects: true, view_estimates: true, approve_estimates: false, view_billing: true, make_payments: false, view_payment_history: true, manage_payment_methods: false, manage_autopay: false, view_documents: true, manage_contacts: false },
}

// Staff "Preview Portal" permission set — deliberately stricter than the
// read_only client role. Staff previewing a client's portal can see the
// general shape of their account (projects, estimates, invoice/balance
// totals, documents) but never payment history, saved payment methods, or
// anything that could resemble bank/card details — that stays private to the
// client per their own login, even from Avalon staff. No actions of any kind
// are permitted (approvals, payments, autopay, contact changes).
export const PORTAL_PREVIEW_PERMISSIONS: Record<string, boolean> = {
  view_projects: true, view_estimates: true, approve_estimates: false,
  view_billing: true, make_payments: false, view_payment_history: false,
  manage_payment_methods: false, manage_autopay: false,
  view_documents: true, manage_contacts: false,
}

function resolvePermissions(role: string, permsJson: string): Record<string, boolean> {
  const preset = PORTAL_ROLE_PRESETS[role] || PORTAL_ROLE_PRESETS.read_only
  let custom: any = {}
  try { custom = JSON.parse(permsJson || '{}') } catch (_) {}
  return { ...preset, ...custom }
}

// ── Portal scope resolution ──────────────────────────────────────────────────
// Resolves on EVERY request. Returns null when the user has no active access.
export type PortalScope = {
  user: any
  memberships: any[]                 // active memberships with resolved permissions
  clientIds: string[]
  propertyIds: string[]              // union of accessible property ids
  companyId: string
  can: (perm: string, clientId?: string) => boolean
  isPreview?: boolean                 // true for staff "Preview Portal" sessions (see 0056)
}

async function resolveScope(db: D1Database, portalUserId: string): Promise<PortalScope | null> {
  const user: any = await db.prepare(
    `SELECT id, company_id, contact_id, email, name, phone, status, last_login_at FROM portal_users WHERE id=? LIMIT 1`
  ).bind(portalUserId).first()
  if (!user || user.status !== 'active') return null

  const mems = (await db.prepare(
    `SELECT m.id, m.client_id, m.role, m.permissions, m.all_properties, c.name as client_name
     FROM portal_memberships m JOIN clients c ON c.id = m.client_id
     WHERE m.portal_user_id=? AND m.active=1`
  ).bind(portalUserId).all()).results as any[] || []
  if (!mems.length) return null

  const clientIds = mems.map(m => m.client_id)
  // Property scope: all client properties for all_properties memberships,
  // explicit property_access rows otherwise. Each membership also keeps its
  // own granted list (m.property_ids) for per-record filtering.
  const propertyIds: string[] = []
  for (const m of mems) {
    if (m.all_properties) {
      const rows = (await db.prepare(`SELECT id FROM properties WHERE client_id=? AND active=1`).bind(m.client_id).all()).results as any[] || []
      m.property_ids = rows.map(r => r.id)
    } else {
      const rows = (await db.prepare(`SELECT property_id FROM property_access WHERE membership_id=?`).bind(m.id).all()).results as any[] || []
      m.property_ids = rows.map(r => r.property_id)
    }
    m.property_ids.forEach((id: string) => propertyIds.push(id))
    m.resolved_permissions = resolvePermissions(m.role, m.permissions)
  }

  return {
    user, memberships: mems, clientIds, propertyIds,
    companyId: user.company_id,
    isPreview: false,
    can(perm: string, clientId?: string) {
      const pool = clientId ? mems.filter(m => m.client_id === clientId) : mems
      return pool.some(m => !!m.resolved_permissions[perm])
    }
  }
}

// Builds a locked-down PortalScope for a staff "Preview Portal" session (see
// migration 0056). Does not require the client to have any portal_users row —
// staff can preview before a client has ever been invited.
async function buildPreviewScope(db: D1Database, sess: any): Promise<PortalScope | null> {
  const client: any = await db.prepare(
    `SELECT id, name, company_id FROM clients WHERE id=? AND company_id=? LIMIT 1`
  ).bind(sess.preview_client_id, sess.preview_company_id).first()
  if (!client) return null
  const propRows = (await db.prepare(`SELECT id FROM properties WHERE client_id=? AND active=1`).bind(client.id).all()).results as any[] || []
  const propertyIds = propRows.map((r: any) => r.id)
  const perms = PORTAL_PREVIEW_PERMISSIONS
  const membership = {
    id: 'preview', client_id: client.id, client_name: client.name, role: 'read_only',
    all_properties: 1, property_ids: propertyIds, resolved_permissions: perms
  }
  return {
    user: { id: 'preview:' + sess.preview_rep_id, name: 'Staff Preview', email: '', phone: '' },
    memberships: [membership],
    clientIds: [client.id],
    propertyIds,
    companyId: client.company_id,
    isPreview: true,
    can(perm: string, clientId?: string) {
      if (clientId && clientId !== client.id) return false
      return !!perms[perm]
    }
  }
}

// ── requirePortalAuth middleware ─────────────────────────────────────────────
const PORTAL_COOKIE = 'gw_portal_session'
const SESSION_MAX_AGE_DAYS = 30
const SESSION_IDLE_DAYS = 7
const MAX_SESSIONS_PER_USER = 10
const PREVIEW_MAX_AGE_HOURS = 2

// D1-backed sliding-window rate limiter (keyed via settings table).
// Returns true when the request is allowed.
async function rateLimit(db: D1Database, key: string, max: number, windowSec: number): Promise<boolean> {
  try {
    const now = Date.now()
    const skey = 'rl_' + key
    const row: any = await db.prepare(`SELECT value FROM settings WHERE key=? LIMIT 1`).bind(skey).first()
    let n = 0, exp = now + windowSec * 1000
    if (row?.value) {
      try { const v = JSON.parse(row.value); if (v && v.exp > now) { n = v.n || 0; exp = v.exp } } catch (_) {}
    }
    n++
    await db.prepare(`INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES (?,?,datetime('now'))`)
      .bind(skey, JSON.stringify({ n, exp })).run()
    return n <= max
  } catch (_) { return true } // fail-open: never block auth because the limiter itself failed
}

export async function requirePortalAuth(c: any, next: any) {
  const token = getCookie(c, PORTAL_COOKIE)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB as D1Database
  const sess: any = await db.prepare(`SELECT * FROM portal_sessions WHERE token=? LIMIT 1`).bind(token).first()
  if (!sess) return c.json({ error: 'Session expired' }, 401)

  if (sess.is_preview) {
    // Preview sessions are short-lived regardless of idle activity.
    const ageMs = Date.now() - new Date(sess.created_at.replace(' ', 'T') + 'Z').getTime()
    if (isFinite(ageMs) && ageMs > PREVIEW_MAX_AGE_HOURS * 36e5) {
      await db.prepare(`DELETE FROM portal_sessions WHERE token=?`).bind(token).run()
      return c.json({ error: 'Preview session expired' }, 401)
    }
    const scope = await buildPreviewScope(db, sess)
    if (!scope) {
      await db.prepare(`DELETE FROM portal_sessions WHERE token=?`).bind(token).run()
      return c.json({ error: 'This client is no longer available to preview' }, 401)
    }
    await db.prepare(`UPDATE portal_sessions SET last_seen_at=datetime('now') WHERE token=?`).bind(token).run()
    c.set('portalScope', scope)
    c.set('portalUserId', scope.user.id)
    return next()
  }

  const ageMs = Date.now() - new Date(sess.created_at.replace(' ', 'T') + 'Z').getTime()
  if (isFinite(ageMs) && ageMs > SESSION_MAX_AGE_DAYS * 864e5) {
    await db.prepare(`DELETE FROM portal_sessions WHERE token=?`).bind(token).run()
    return c.json({ error: 'Session expired' }, 401)
  }
  // Idle timeout: sessions unused for SESSION_IDLE_DAYS expire early.
  const idleMs = Date.now() - new Date(String(sess.last_seen_at || sess.created_at).replace(' ', 'T') + 'Z').getTime()
  if (isFinite(idleMs) && idleMs > SESSION_IDLE_DAYS * 864e5) {
    await db.prepare(`DELETE FROM portal_sessions WHERE token=?`).bind(token).run()
    return c.json({ error: 'Session expired' }, 401)
  }
  const scope = await resolveScope(db, sess.portal_user_id)
  if (!scope) {
    // User disabled or no active memberships — kill the session immediately.
    await db.prepare(`DELETE FROM portal_sessions WHERE token=?`).bind(token).run()
    return c.json({ error: 'Access disabled' }, 401)
  }
  await db.prepare(`UPDATE portal_sessions SET last_seen_at=datetime('now') WHERE token=?`).bind(token).run()
  c.set('portalScope', scope)
  c.set('portalUserId', scope.user.id)
  await next()
}

function clientIp(c: any): string {
  return c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || ''
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE REGISTRATION
// registerPortal(app, deps) is called from index.tsx.
// deps.requireStaffAuth = the existing internal requireAuth middleware.
// deps.sendEmail        = the existing SendGrid helper.
// ═══════════════════════════════════════════════════════════════════════════
export function registerPortal(app: Hono<any>, deps: {
  requireStaffAuth: (c: any, next: any) => Promise<any>
  sendEmail: (apiKey: string, to: string, subject: string, html: string, opts?: any) => Promise<boolean>
  woFlipHolds?: (db: D1Database, estimateId: string, companyId: string, toStatus: 'scheduled' | 'cancelled') => Promise<void>
}) {

  // Schema self-heal: guarantees portal tables exist in prod even before
  // wrangler-driven migrations are applied (runs once, then memoized).
  app.use('/api/portal/*', async (c, next) => { await ensurePortalSchema(c.env.DB as D1Database); await next() })
  app.use('/api/admin/portal/*', async (c, next) => { await ensurePortalSchema(c.env.DB as D1Database); await next() })

  // Security headers on portal pages + no-store on portal APIs (except media, which
  // sets its own private cache policy).
  app.use('/portal/*', async (c, next) => {
    await next()
    c.header('X-Frame-Options', 'DENY')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  })
  app.use('/api/portal/*', async (c, next) => {
    await next()
    c.header('X-Content-Type-Options', 'nosniff')
    if (!c.req.path.startsWith('/api/portal/media/')) c.header('Cache-Control', 'no-store')
  })

  // ══ PORTAL AUTH APIS ══════════════════════════════════════════════════════

  // POST /api/portal/auth/login
  app.post('/api/portal/auth/login', async (c) => {
    const db = c.env.DB as D1Database
    const { email, password } = await c.req.json().catch(() => ({} as any))
    if (!email || !password) return c.json({ error: 'Email and password required' }, 400)
    // Rate limits: 10 attempts / 5 min per IP, 8 / 5 min per email.
    const ip = clientIp(c) || 'noip'
    const ipOk = await rateLimit(db, 'plogin_ip_' + ip.slice(0, 60), 10, 300)
    const emOk = await rateLimit(db, 'plogin_em_' + String(email).trim().toLowerCase().slice(0, 80), 8, 300)
    if (!ipOk || !emOk) return c.json({ error: 'Too many attempts. Please wait a few minutes and try again.' }, 429)

    const user: any = await db.prepare(
      `SELECT * FROM portal_users WHERE lower(email)=lower(?) AND status='active' LIMIT 1`
    ).bind(String(email).trim()).first()

    // Uniform error for unknown email / wrong password — no account enumeration.
    const fail = async (uid?: string, coId?: string) => {
      if (uid) {
        await db.prepare(`UPDATE portal_users SET failed_logins=failed_logins+1,
          locked_until=CASE WHEN failed_logins+1>=5 THEN datetime('now','+15 minutes') ELSE locked_until END WHERE id=?`).bind(uid).run()
        await portalAudit(db, { companyId: coId || '', actorType: 'portal', portalUserId: uid, eventType: 'portal_login_failed', ip: clientIp(c) })
      }
      return c.json({ error: 'Invalid email or password' }, 401)
    }
    if (!user) return fail()
    if (user.locked_until && new Date(user.locked_until.replace(' ', 'T') + 'Z').getTime() > Date.now()) {
      return c.json({ error: 'Too many failed attempts. Try again in a few minutes.' }, 429)
    }
    if (!(await pVerify(password, user.password_hash))) return fail(user.id, user.company_id)

    const scope = await resolveScope(db, user.id)
    if (!scope) return c.json({ error: 'Your portal access is not active. Contact your service provider.' }, 403)

    const token = pUid() + pUid()
    await db.batch([
      db.prepare(`INSERT INTO portal_sessions (token, portal_user_id, ip, user_agent) VALUES (?,?,?,?)`)
        .bind(token, user.id, clientIp(c), (c.req.header('user-agent') || '').slice(0, 300)),
      db.prepare(`UPDATE portal_users SET last_login_at=datetime('now'), failed_logins=0, locked_until='' WHERE id=?`).bind(user.id),
      // Cap concurrent sessions per user: keep the most recent MAX_SESSIONS_PER_USER.
      db.prepare(`DELETE FROM portal_sessions WHERE portal_user_id=? AND token NOT IN (
        SELECT token FROM portal_sessions WHERE portal_user_id=? ORDER BY created_at DESC LIMIT ${MAX_SESSIONS_PER_USER})`).bind(user.id, user.id)
    ])
    setCookie(c, PORTAL_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_MAX_AGE_DAYS * 86400 })
    await portalAudit(db, { companyId: user.company_id, actorType: 'portal', portalUserId: user.id, eventType: 'portal_login', ip: clientIp(c) })
    // Opportunistic housekeeping (~5% of logins): purge expired sessions + stale rate-limit keys.
    if (Math.random() < 0.05) {
      try {
        await db.batch([
          db.prepare(`DELETE FROM portal_sessions WHERE created_at < datetime('now','-${SESSION_MAX_AGE_DAYS} days')`),
          db.prepare(`DELETE FROM settings WHERE key LIKE 'rl_%' AND updated_at < datetime('now','-1 day')`)
        ])
      } catch (_) {}
    }
    return c.json({ ok: true })
  })

  // POST /api/portal/auth/logout
  app.post('/api/portal/auth/logout', async (c) => {
    const db = c.env.DB as D1Database
    const token = getCookie(c, PORTAL_COOKIE)
    if (token) {
      const sess: any = await db.prepare(`SELECT portal_user_id FROM portal_sessions WHERE token=?`).bind(token).first()
      await db.prepare(`DELETE FROM portal_sessions WHERE token=?`).bind(token).run()
      if (sess) {
        const u: any = await db.prepare(`SELECT company_id FROM portal_users WHERE id=?`).bind(sess.portal_user_id).first()
        await portalAudit(db, { companyId: u?.company_id || '', actorType: 'portal', portalUserId: sess.portal_user_id, eventType: 'portal_logout', ip: clientIp(c) })
      }
    }
    deleteCookie(c, PORTAL_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })

  // GET /api/portal/auth/me — session snapshot: identity, memberships, properties
  app.get('/api/portal/auth/me', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    const props = s.propertyIds.length
      ? (await db.prepare(`SELECT id, client_id, label, street, city, state, zip, is_primary FROM properties
          WHERE id IN (${s.propertyIds.map(() => '?').join(',')}) AND active=1`).bind(...s.propertyIds).all()).results
      : []
    const co: any = await db.prepare(`SELECT name, logo_url, brand_color, phone, website FROM companies WHERE id=? LIMIT 1`).bind(s.companyId).first()
    return c.json({
      ok: true,
      preview: !!s.isPreview,
      user: { id: s.user.id, name: s.user.name, email: s.user.email, phone: s.user.phone },
      memberships: s.memberships.map(m => ({ client_id: m.client_id, client_name: m.client_name, role: m.role, permissions: m.resolved_permissions })),
      properties: props,
      company: { name: co?.name || '', logo_url: co?.logo_url || '', brand_color: co?.brand_color || '#2D7A55', phone: co?.phone || '', website: co?.website || '' }
    })
  })

  // POST /api/portal/auth/accept-invite — activate account, set password
  app.post('/api/portal/auth/accept-invite', async (c) => {
    const db = c.env.DB as D1Database
    const { token, password } = await c.req.json().catch(() => ({} as any))
    if (!token || !password) return c.json({ error: 'Token and password required' }, 400)
    if (!(await rateLimit(db, 'paccept_ip_' + (clientIp(c) || 'noip').slice(0, 60), 10, 900))) {
      return c.json({ error: 'Too many attempts. Please wait a few minutes and try again.' }, 429)
    }
    if (String(password).length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400)
    const user: any = await db.prepare(`SELECT * FROM portal_users WHERE invite_token=? AND invite_token!='' LIMIT 1`).bind(token).first()
    if (!user) return c.json({ error: 'This invitation link is invalid or has already been used.' }, 404)
    if (user.status === 'disabled') return c.json({ error: 'This account has been disabled. Contact your service provider.' }, 403)
    if (user.invite_expires_at && new Date(user.invite_expires_at.replace(' ', 'T') + 'Z').getTime() < Date.now()) {
      return c.json({ error: 'This invitation has expired. Ask your service provider to send a new one.' }, 410)
    }
    const hash = await pHash(password)
    await db.prepare(`UPDATE portal_users SET password_hash=?, status='active', invite_token='', activated_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
      .bind(hash, user.id).run()
    await portalAudit(db, { companyId: user.company_id, actorType: 'portal', portalUserId: user.id, eventType: 'portal_invite_accepted', ip: clientIp(c) })
    return c.json({ ok: true })
  })

  // GET /api/portal/auth/invite-info/:token — safe preview for the accept page
  app.get('/api/portal/auth/invite-info/:token', async (c) => {
    const db = c.env.DB as D1Database
    const user: any = await db.prepare(`SELECT name, email, company_id, invite_expires_at, status FROM portal_users WHERE invite_token=? AND invite_token!='' LIMIT 1`)
      .bind(c.req.param('token')).first()
    if (!user) return c.json({ error: 'Invalid or used invitation' }, 404)
    const co: any = await db.prepare(`SELECT name FROM companies WHERE id=?`).bind(user.company_id).first()
    const expired = !!(user.invite_expires_at && new Date(user.invite_expires_at.replace(' ', 'T') + 'Z').getTime() < Date.now())
    return c.json({ ok: true, name: user.name, email: user.email, company: co?.name || '', expired })
  })

  // POST /api/portal/auth/request-reset — always returns ok (no enumeration)
  app.post('/api/portal/auth/request-reset', async (c) => {
    const db = c.env.DB as D1Database
    const { email } = await c.req.json().catch(() => ({} as any))
    if (!email) return c.json({ ok: true })
    // Rate limits: 5 / 15 min per IP, 3 / 15 min per email — prevents reset-email spam.
    const rip = clientIp(c) || 'noip'
    const ripOk = await rateLimit(db, 'preset_ip_' + rip.slice(0, 60), 5, 900)
    const remOk = await rateLimit(db, 'preset_em_' + String(email).trim().toLowerCase().slice(0, 80), 3, 900)
    if (!ripOk || !remOk) return c.json({ ok: true }) // still uniform response — silently drop
    const user: any = await db.prepare(`SELECT * FROM portal_users WHERE lower(email)=lower(?) AND status='active' LIMIT 1`).bind(String(email).trim()).first()
    if (user) {
      const token = pUid() + pUid()
      await db.prepare(`UPDATE portal_users SET reset_token=?, reset_expires_at=datetime('now','+2 hours') WHERE id=?`).bind(token, user.id).run()
      const origin = new URL(c.req.url).origin
      const link = `${origin}/portal/reset/${token}`
      const apiKey = c.env.SENDGRID_API_KEY
      if (apiKey) {
        await deps.sendEmail(apiKey, user.email, 'Reset your client portal password',
          `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
            <h2 style="color:#1F2A2B">Password Reset</h2>
            <p>We received a request to reset your client portal password. This link expires in 2 hours.</p>
            <p><a href="${link}" style="display:inline-block;background:#2D7A55;color:#fff;text-decoration:none;font-weight:700;padding:12px 28px;border-radius:8px">Reset Password</a></p>
            <p style="font-size:12px;color:#6B7280">If you did not request this, you can safely ignore this email.</p>
          </div>`)
      }
      await portalAudit(db, { companyId: user.company_id, actorType: 'portal', portalUserId: user.id, eventType: 'portal_reset_requested', ip: clientIp(c) })
    }
    return c.json({ ok: true })
  })

  // POST /api/portal/auth/reset
  app.post('/api/portal/auth/reset', async (c) => {
    const db = c.env.DB as D1Database
    const { token, password } = await c.req.json().catch(() => ({} as any))
    if (!token || !password) return c.json({ error: 'Token and password required' }, 400)
    if (!(await rateLimit(db, 'preset2_ip_' + (clientIp(c) || 'noip').slice(0, 60), 10, 900))) {
      return c.json({ error: 'Too many attempts. Please wait a few minutes and try again.' }, 429)
    }
    if (String(password).length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400)
    const user: any = await db.prepare(`SELECT * FROM portal_users WHERE reset_token=? AND reset_token!='' LIMIT 1`).bind(token).first()
    if (!user || !user.reset_expires_at || new Date(user.reset_expires_at.replace(' ', 'T') + 'Z').getTime() < Date.now()) {
      return c.json({ error: 'This reset link is invalid or has expired.' }, 410)
    }
    const hash = await pHash(password)
    await db.batch([
      db.prepare(`UPDATE portal_users SET password_hash=?, reset_token='', reset_expires_at='', failed_logins=0, locked_until='', updated_at=datetime('now') WHERE id=?`).bind(hash, user.id),
      db.prepare(`DELETE FROM portal_sessions WHERE portal_user_id=?`).bind(user.id)  // invalidate existing sessions
    ])
    await portalAudit(db, { companyId: user.company_id, actorType: 'portal', portalUserId: user.id, eventType: 'portal_password_reset', ip: clientIp(c) })
    return c.json({ ok: true })
  })

  // PUT /api/portal/account — safe self-service profile updates only
  app.put('/api/portal/account', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    if (s.isPreview) return c.json({ error: 'Not available in preview mode' }, 403)
    const b: any = await c.req.json().catch(() => ({}))
    const updates: string[] = []; const vals: any[] = []
    if (typeof b.name === 'string' && b.name.trim()) { updates.push('name=?'); vals.push(b.name.trim().slice(0, 120)) }
    if (typeof b.phone === 'string') { updates.push('phone=?'); vals.push(b.phone.trim().slice(0, 40)) }
    if (b.new_password) {
      if (!b.current_password || !(await pVerify(b.current_password, (await db.prepare(`SELECT password_hash FROM portal_users WHERE id=?`).bind(s.user.id).first() as any).password_hash))) {
        return c.json({ error: 'Current password is incorrect' }, 403)
      }
      if (String(b.new_password).length < 8) return c.json({ error: 'New password must be at least 8 characters' }, 400)
      updates.push('password_hash=?'); vals.push(await pHash(b.new_password))
    }
    if (!updates.length) return c.json({ error: 'Nothing to update' }, 400)
    updates.push(`updated_at=datetime('now')`)
    await db.prepare(`UPDATE portal_users SET ${updates.join(',')} WHERE id=?`).bind(...vals, s.user.id).run()
    // Password changed: revoke every other session for this user (keep current one).
    if (b.new_password) {
      const curTok = getCookie(c, PORTAL_COOKIE) || ''
      await db.prepare(`DELETE FROM portal_sessions WHERE portal_user_id=? AND token!=?`).bind(s.user.id, curTok).run()
    }
    await portalAudit(db, { companyId: s.companyId, actorType: 'portal', portalUserId: s.user.id, eventType: 'portal_account_updated', meta: { fields: Object.keys(b).filter(k => k !== 'current_password' && k !== 'new_password') }, ip: clientIp(c) })
    return c.json({ ok: true })
  })

  // GET /api/portal/dashboard — attention summary, fully scoped (Phase 1A light version)
  app.get('/api/portal/dashboard', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    const cin = s.clientIds.map(() => '?').join(',')
    const canEst = s.can('view_estimates'); const canBill = s.can('view_billing'); const canProj = s.can('view_projects')
    let estAwaiting = 0, openBalance = 0, overdueBalance = 0, lastPayment: any = null, activeProjects = 0
    if (canProj) {
      try {
        const r: any = await db.prepare(`SELECT COUNT(*) as n FROM work_orders WHERE company_id=? AND client_id IN (${cin})
          AND portal_visible=1 AND status IN ('scheduled','in_progress','started','paused')`).bind(s.companyId, ...s.clientIds).first()
        activeProjects = r?.n || 0
      } catch (_) {}
    }
    if (canEst) {
      const r: any = await db.prepare(`SELECT COUNT(*) as n FROM estimates WHERE company_id=? AND client_id IN (${cin}) AND status IN ('sent','viewed')`).bind(s.companyId, ...s.clientIds).first()
      estAwaiting = r?.n || 0
    }
    if (canBill) {
      const r: any = await db.prepare(`SELECT COALESCE(SUM(balance_due),0) as open_bal,
          COALESCE(SUM(CASE WHEN status='overdue' THEN balance_due ELSE 0 END),0) as overdue_bal
        FROM invoices WHERE company_id=? AND client_id IN (${cin}) AND status IN ('sent','viewed','partial','overdue')`).bind(s.companyId, ...s.clientIds).first()
      openBalance = r?.open_bal || 0; overdueBalance = r?.overdue_bal || 0
      lastPayment = await db.prepare(`SELECT amount, created_at, payment_method FROM payments
        WHERE company_id=? AND client_id IN (${cin}) AND status IN ('succeeded','paid','completed')
        ORDER BY created_at DESC LIMIT 1`).bind(s.companyId, ...s.clientIds).first()
    }
    return c.json({
      ok: true,
      cards: {
        estimates_awaiting: canEst ? estAwaiting : null,
        open_balance: canBill ? openBalance : null,
        overdue_balance: canBill ? overdueBalance : null,
        last_payment: canBill && lastPayment ? { amount: lastPayment.amount, date: lastPayment.created_at, method: lastPayment.payment_method } : null,
        active_projects: canProj ? activeProjects : null
      }
    })
  })

  // ══ PHASE 1B: CORE RECORDS — estimates, billing, documents ════════════════
  // All queries are company + client scoped; property scope is enforced with
  // propOk(): records with no property assignment are visible to any member
  // of that client, records with a property_id require that property grant.

  const propOk = (s: PortalScope, rec: any): boolean => {
    const mems = s.memberships.filter(m => m.client_id === rec.client_id)
    if (!mems.length) return false
    if (!rec.property_id) return true
    return mems.some(m => m.all_properties || (m.property_ids || []).includes(rec.property_id))
  }

  const notify = async (db: D1Database, companyId: string, type: string, title: string, body: string, entityType: string, entityId: string, actionUrl: string) => {
    try {
      await db.prepare(`INSERT OR IGNORE INTO notifications (id,company_id,type,title,body,entity_type,entity_id,action_url)
        VALUES (?,?,?,?,?,?,?,?)`)
        .bind('notif_' + pUid(), companyId, type, title, body, entityType, entityId, actionUrl).run()
    } catch (_) {}
  }

  // Client-safe estimate columns (never internal_notes / cost_data / ai_meta)
  const EST_LIST_COLS = `id, est_number, title, status, total, subtotal, tax_amt, discount_amt,
    deposit_amt, deposit_paid, estimate_date, expiry_date, sent_at, viewed_at, accepted_at,
    declined_at, client_id, property_id, portal_token, created_at`
  const EST_DETAIL_COLS = EST_LIST_COLS + `, line_items, scope_of_work, customer_notes, terms, payment_schedule, doc_type`

  // GET /api/portal/estimates
  app.get('/api/portal/estimates', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    if (!s.can('view_estimates')) return c.json({ error: 'Not permitted' }, 403)
    const cin = s.clientIds.map(() => '?').join(',')
    const rows = ((await db.prepare(
      `SELECT ${EST_LIST_COLS} FROM estimates
       WHERE company_id=? AND client_id IN (${cin}) AND status NOT IN ('draft','void','deleted')
       ORDER BY created_at DESC LIMIT 200`
    ).bind(s.companyId, ...s.clientIds).all()).results as any[] || []).filter(r => propOk(s, r))
    return c.json({ ok: true, data: rows })
  })

  // GET /api/portal/estimates/:id
  app.get('/api/portal/estimates/:id', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    if (!s.can('view_estimates')) return c.json({ error: 'Not permitted' }, 403)
    const cin = s.clientIds.map(() => '?').join(',')
    const row: any = await db.prepare(
      `SELECT ${EST_DETAIL_COLS} FROM estimates
       WHERE id=? AND company_id=? AND client_id IN (${cin}) AND status NOT IN ('draft','void','deleted') LIMIT 1`
    ).bind(c.req.param('id'), s.companyId, ...s.clientIds).first()
    if (!row || !propOk(s, row)) return c.json({ error: 'Not found' }, 404)
    // Mark viewed (first client view only)
    if (row.status === 'sent') {
      await db.prepare(`UPDATE estimates SET status='viewed', viewed_at=COALESCE(viewed_at, datetime('now')), updated_at=datetime('now') WHERE id=?`).bind(row.id).run()
      row.status = 'viewed'
      await portalAudit(db, { companyId: s.companyId, actorType: 'portal', portalUserId: s.user.id, clientId: row.client_id, eventType: 'portal_estimate_viewed', entityType: 'estimate', entityId: row.id, entityLabel: row.est_number || row.id, ip: clientIp(c) })
    }
    return c.json({ ok: true, data: row })
  })

  // POST /api/portal/estimates/:id/approve
  app.post('/api/portal/estimates/:id/approve', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    const cin = s.clientIds.map(() => '?').join(',')
    const row: any = await db.prepare(`SELECT id, client_id, property_id, status, est_number, client_name FROM estimates
      WHERE id=? AND company_id=? AND client_id IN (${cin}) LIMIT 1`).bind(c.req.param('id'), s.companyId, ...s.clientIds).first()
    if (!row || !propOk(s, row)) return c.json({ error: 'Not found' }, 404)
    if (!s.can('approve_estimates', row.client_id)) return c.json({ error: 'You do not have permission to approve estimates' }, 403)
    if (!['sent', 'viewed'].includes(row.status)) return c.json({ error: 'This estimate is no longer awaiting a response' }, 409)
    await db.prepare(`UPDATE estimates SET status='approved', accepted_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).bind(row.id).run()
    if (deps.woFlipHolds) await deps.woFlipHolds(db, row.id, s.companyId, 'scheduled')
    await notify(db, s.companyId, 'estimate_approved',
      `Estimate ${row.est_number || row.id} Approved`,
      `${s.user.name} approved the estimate via the client portal. Ready to schedule.`,
      'estimate', row.id, '#estimates')
    await portalAudit(db, { companyId: s.companyId, actorType: 'portal', portalUserId: s.user.id, clientId: row.client_id, eventType: 'portal_estimate_approved', entityType: 'estimate', entityId: row.id, entityLabel: row.est_number || row.id, ip: clientIp(c) })
    return c.json({ ok: true, status: 'approved' })
  })

  // POST /api/portal/estimates/:id/decline — decline or request changes
  app.post('/api/portal/estimates/:id/decline', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    const cin = s.clientIds.map(() => '?').join(',')
    const row: any = await db.prepare(`SELECT id, client_id, property_id, status, est_number FROM estimates
      WHERE id=? AND company_id=? AND client_id IN (${cin}) LIMIT 1`).bind(c.req.param('id'), s.companyId, ...s.clientIds).first()
    if (!row || !propOk(s, row)) return c.json({ error: 'Not found' }, 404)
    if (!s.can('approve_estimates', row.client_id)) return c.json({ error: 'You do not have permission to respond to estimates' }, 403)
    if (!['sent', 'viewed'].includes(row.status)) return c.json({ error: 'This estimate is no longer awaiting a response' }, 409)
    const b: any = await c.req.json().catch(() => ({}))
    const reason = String(b.reason || '').slice(0, 1000)
    await db.prepare(`UPDATE estimates SET status='declined', declined_at=datetime('now'), decline_reason=?, updated_at=datetime('now') WHERE id=?`)
      .bind(reason, row.id).run()
    if (deps.woFlipHolds) await deps.woFlipHolds(db, row.id, s.companyId, 'cancelled')
    await notify(db, s.companyId, 'estimate_declined',
      `Estimate ${row.est_number || row.id} — Changes Requested`,
      reason ? `${s.user.name}: "${reason}"` : `${s.user.name} declined the estimate via the client portal.`,
      'estimate', row.id, '#estimates')
    await portalAudit(db, { companyId: s.companyId, actorType: 'portal', portalUserId: s.user.id, clientId: row.client_id, eventType: 'portal_estimate_declined', entityType: 'estimate', entityId: row.id, entityLabel: row.est_number || row.id, meta: { reason }, ip: clientIp(c) })
    return c.json({ ok: true, status: 'declined' })
  })

  // GET /api/portal/invoices
  app.get('/api/portal/invoices', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    if (!s.can('view_billing')) return c.json({ error: 'Not permitted' }, 403)
    const cin = s.clientIds.map(() => '?').join(',')
    const rows = ((await db.prepare(
      `SELECT id, invoice_number, title, status, total, amount_paid, balance_due, due_date,
              sent_at, paid_at, client_id, property_id, portal_token, created_at
       FROM invoices WHERE company_id=? AND client_id IN (${cin}) AND status NOT IN ('draft','void','deleted')
       ORDER BY created_at DESC LIMIT 200`
    ).bind(s.companyId, ...s.clientIds).all()).results as any[] || []).filter(r => propOk(s, r))
    return c.json({ ok: true, data: rows })
  })

  // GET /api/portal/invoices/:id
  app.get('/api/portal/invoices/:id', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    if (!s.can('view_billing')) return c.json({ error: 'Not permitted' }, 403)
    const cin = s.clientIds.map(() => '?').join(',')
    const row: any = await db.prepare(
      `SELECT id, invoice_number, title, status, subtotal, tax_amount, discount_amount, total,
              amount_paid, balance_due, due_date, sent_at, viewed_at, paid_at, line_items,
              terms, footer_note, notes, client_id, property_id, portal_token, created_at
       FROM invoices WHERE id=? AND company_id=? AND client_id IN (${cin}) AND status NOT IN ('draft','void','deleted') LIMIT 1`
    ).bind(c.req.param('id'), s.companyId, ...s.clientIds).first()
    if (!row || !propOk(s, row)) return c.json({ error: 'Not found' }, 404)
    if (row.status === 'sent') {
      await db.prepare(`UPDATE invoices SET status='viewed', viewed_at=COALESCE(viewed_at, datetime('now')), updated_at=datetime('now') WHERE id=?`).bind(row.id).run()
      row.status = 'viewed'
    }
    // Payments applied to this invoice
    row.payments = (await db.prepare(
      `SELECT amount, status, payment_method, created_at FROM payments
       WHERE invoice_id=? AND company_id=? AND status IN ('succeeded','paid','completed') ORDER BY created_at DESC`
    ).bind(row.id, s.companyId).all()).results || []
    return c.json({ ok: true, data: row })
  })

  // GET /api/portal/payments — payment history across the account
  app.get('/api/portal/payments', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    if (!s.can('view_payment_history')) return c.json({ error: 'Not permitted' }, 403)
    const cin = s.clientIds.map(() => '?').join(',')
    const rows = (await db.prepare(
      `SELECT p.id, p.amount, p.status, p.payment_method, p.created_at, p.invoice_number, p.invoice_id, p.client_id
       FROM payments p WHERE p.company_id=? AND p.client_id IN (${cin})
       AND p.status IN ('succeeded','paid','completed')
       ORDER BY p.created_at DESC LIMIT 100`
    ).bind(s.companyId, ...s.clientIds).all()).results || []
    return c.json({ ok: true, data: rows })
  })

  // GET /api/portal/documents — proposals + shared document links
  app.get('/api/portal/documents', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    if (!s.can('view_documents')) return c.json({ error: 'Not permitted' }, 403)
    const cin = s.clientIds.map(() => '?').join(',')
    const proposals = ((await db.prepare(
      `SELECT id, prop_number, title, status, total, portal_token, sent_at, accepted_at, proposal_date, created_at, client_id, property_id
       FROM proposals WHERE company_id=? AND client_id IN (${cin}) AND status NOT IN ('draft','void','deleted')
       ORDER BY created_at DESC LIMIT 100`
    ).bind(s.companyId, ...s.clientIds).all()).results as any[] || []).filter(r => propOk(s, r))
    return c.json({ ok: true, data: { proposals } })
  })

  // ══ RELEASE 2: PAYMENT METHODS, AUTOPAY, DEPOSITS, CONTACTS ═══════════════
  //
  // Payment model (matches existing staff flows in index.tsx):
  //  - Saved payment methods live on a PLATFORM-account Stripe Customer per
  //    client (clients.stripe_customer_id). Off-session charges use
  //    transfer_data[destination] to route funds to the connected account.
  //  - Hosted Checkout (deposit fallback) is created ON the connected account,
  //    same as the public invoice pay page.
  //  - All portal-initiated charges require the company to be Stripe-connected.

  const stripeKeyOf = (c: any) => (c.env as any).STRIPE_SECRET_KEY as string | undefined

  // Resolve which client a payments/contacts request targets. Single-client
  // accounts need no param; multi-client users pass ?client_id= / body.client_id.
  function pickClientId(s: PortalScope, requested: string | undefined, perm: string): string | null {
    if (requested) return s.clientIds.includes(requested) && s.can(perm, requested) ? requested : null
    const withPerm = s.clientIds.filter(id => s.can(perm, id))
    return withPerm.length === 1 || (withPerm.length > 1 && s.clientIds.length === 1) ? withPerm[0] : (withPerm[0] || null)
  }

  async function stripeCustomerFor(db: D1Database, stripeKey: string, companyId: string, clientId: string): Promise<string> {
    const client: any = await db.prepare(`SELECT id, name, email, stripe_customer_id FROM clients WHERE id=? AND company_id=? LIMIT 1`).bind(clientId, companyId).first()
    if (!client) throw new Error('Client not found')
    if (client.stripe_customer_id) return client.stripe_customer_id
    const form = new URLSearchParams({ name: client.name || '', 'metadata[client_id]': clientId, 'metadata[company_id]': companyId })
    if (client.email) form.set('email', client.email)
    const res = await fetch('https://api.stripe.com/v1/customers', {
      method: 'POST', headers: { 'Authorization': `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString()
    })
    const cust: any = await res.json()
    if (!res.ok) throw new Error(cust.error?.message || 'Could not create Stripe customer')
    await db.prepare(`UPDATE clients SET stripe_customer_id=? WHERE id=?`).bind(cust.id, clientId).run()
    return cust.id
  }

  async function listStripePMs(stripeKey: string, customerId: string) {
    const [cardsRes, bankRes] = await Promise.all([
      fetch(`https://api.stripe.com/v1/payment_methods?customer=${customerId}&type=card&limit=20`, { headers: { 'Authorization': `Bearer ${stripeKey}` } }),
      fetch(`https://api.stripe.com/v1/payment_methods?customer=${customerId}&type=us_bank_account&limit=20`, { headers: { 'Authorization': `Bearer ${stripeKey}` } })
    ])
    const cards = cardsRes.ok ? (await cardsRes.json() as any).data || [] : []
    const banks = bankRes.ok ? (await bankRes.json() as any).data || [] : []
    return [...cards, ...banks].map((pm: any) => ({
      id: pm.id, type: pm.type,
      brand: pm.card?.brand || pm.us_bank_account?.bank_name || 'Unknown',
      last4: pm.card?.last4 || pm.us_bank_account?.last4 || '????',
      exp_month: pm.card?.exp_month, exp_year: pm.card?.exp_year,
      label: pm.type === 'card'
        ? `${(pm.card?.brand || 'Card').charAt(0).toUpperCase() + (pm.card?.brand || '').slice(1)} •••• ${pm.card?.last4} (${pm.card?.exp_month}/${pm.card?.exp_year})`
        : `${pm.us_bank_account?.bank_name || 'Bank'} •••• ${pm.us_bank_account?.last4} (ACH)`
    }))
  }

  // Off-session charge on the platform customer, routed to the connected acct.
  async function chargeSavedPM(stripeKey: string, company: any, customerId: string, pmId: string, amountCents: number, metadata: Record<string, string>) {
    const feePct = company?.stripe_platform_fee_pct || 2.9
    const form = new URLSearchParams({
      amount: String(amountCents), currency: 'usd', customer: customerId,
      payment_method: pmId, confirm: 'true', 'off_session': 'true',
      'application_fee_amount': String(Math.round(amountCents * feePct / 100)),
      'transfer_data[destination]': company.stripe_account_id
    })
    for (const [k, v] of Object.entries(metadata)) form.set(`metadata[${k}]`, v)
    const res = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST', headers: { 'Authorization': `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString()
    })
    const pi: any = await res.json()
    if (!res.ok) throw new Error(pi.error?.message || 'Charge failed')
    if (pi.status !== 'succeeded') throw new Error(`Payment status: ${pi.status} — this payment method may require additional authentication`)
    return pi
  }

  const companyStripe = (db: D1Database, companyId: string) =>
    db.prepare(`SELECT stripe_account_id, stripe_onboarded, stripe_platform_fee_pct FROM companies WHERE id=? LIMIT 1`).bind(companyId).first() as Promise<any>

  async function notifyCompany(db: D1Database, companyId: string, type: string, title: string, body: string, entityType: string, entityId: string, actionUrl: string) {
    try {
      await db.prepare(`INSERT OR IGNORE INTO notifications (id,company_id,type,title,body,entity_type,entity_id,action_url) VALUES (?,?,?,?,?,?,?,?)`)
        .bind(`notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, companyId, type, title, body, entityType, entityId, actionUrl).run()
    } catch (_) {}
  }

  // ── Payment methods ────────────────────────────────────────────────────────

  // GET /api/portal/payment-methods — list saved methods for a client
  app.get('/api/portal/payment-methods', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    const perms = ['manage_payment_methods', 'make_payments', 'manage_autopay']
    const clientId = c.req.query('client_id')
      ? (s.clientIds.includes(c.req.query('client_id')!) && perms.some(p => s.can(p, c.req.query('client_id')!)) ? c.req.query('client_id')! : null)
      : (s.clientIds.find(id => perms.some(p => s.can(p, id))) || null)
    if (!clientId) return c.json({ error: 'Not permitted' }, 403)
    const stripeKey = stripeKeyOf(c)
    if (!stripeKey) return c.json({ ok: true, data: [], client_id: clientId, available: false })
    const client: any = await db.prepare(`SELECT stripe_customer_id FROM clients WHERE id=? AND company_id=? LIMIT 1`).bind(clientId, s.companyId).first()
    if (!client?.stripe_customer_id) return c.json({ ok: true, data: [], client_id: clientId, available: true })
    try {
      return c.json({ ok: true, data: await listStripePMs(stripeKey, client.stripe_customer_id), client_id: clientId, available: true })
    } catch (e: any) { return c.json({ error: e.message }, 500) }
  })

  // POST /api/portal/payment-methods/setup — hosted Checkout (setup mode) to add a card
  app.post('/api/portal/payment-methods/setup', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    const b: any = await c.req.json().catch(() => ({}))
    const clientId = pickClientId(s, b.client_id, 'manage_payment_methods')
    if (!clientId) return c.json({ error: 'Not permitted' }, 403)
    const stripeKey = stripeKeyOf(c)
    if (!stripeKey) return c.json({ error: 'Online payments are not available' }, 503)
    try {
      const customerId = await stripeCustomerFor(db, stripeKey, s.companyId, clientId)
      const origin = new URL(c.req.url).origin
      const form = new URLSearchParams({
        mode: 'setup', customer: customerId, 'payment_method_types[]': 'card',
        'success_url': `${origin}/portal/home?pm_added=1#billing`,
        'cancel_url': `${origin}/portal/home#billing`,
        'metadata[client_id]': clientId, 'metadata[company_id]': s.companyId
      })
      const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST', headers: { 'Authorization': `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString()
      })
      const session: any = await res.json()
      if (!res.ok) throw new Error(session.error?.message || 'Could not start setup')
      await portalAudit(db, { companyId: s.companyId, actorType: 'portal', portalUserId: s.user.id, clientId, eventType: 'portal_pm_setup_started', ip: clientIp(c) })
      return c.json({ ok: true, url: session.url })
    } catch (e: any) { return c.json({ error: e.message }, 500) }
  })

  // DELETE /api/portal/payment-methods/:pmId — detach a saved method
  app.delete('/api/portal/payment-methods/:pmId', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    const clientId = pickClientId(s, c.req.query('client_id'), 'manage_payment_methods')
    if (!clientId) return c.json({ error: 'Not permitted' }, 403)
    const stripeKey = stripeKeyOf(c)
    if (!stripeKey) return c.json({ error: 'Online payments are not available' }, 503)
    const pmId = c.req.param('pmId')
    const client: any = await db.prepare(`SELECT stripe_customer_id FROM clients WHERE id=? AND company_id=? LIMIT 1`).bind(clientId, s.companyId).first()
    if (!client?.stripe_customer_id) return c.json({ error: 'No payment methods on file' }, 404)
    try {
      // Ownership check: the PM must belong to this client's customer
      const pmRes = await fetch(`https://api.stripe.com/v1/payment_methods/${encodeURIComponent(pmId)}`, { headers: { 'Authorization': `Bearer ${stripeKey}` } })
      const pm: any = await pmRes.json()
      if (!pmRes.ok || pm.customer !== client.stripe_customer_id) return c.json({ error: 'Payment method not found' }, 404)
      const detRes = await fetch(`https://api.stripe.com/v1/payment_methods/${encodeURIComponent(pmId)}/detach`, { method: 'POST', headers: { 'Authorization': `Bearer ${stripeKey}` } })
      if (!detRes.ok) { const err: any = await detRes.json(); throw new Error(err.error?.message || 'Could not remove payment method') }
      // If autopay pointed at this method, disable it
      await db.prepare(`UPDATE client_autopay SET enabled=0, stripe_pm_id='', pm_label='', updated_at=datetime('now') WHERE client_id=? AND stripe_pm_id=?`).bind(clientId, pmId).run()
      await portalAudit(db, { companyId: s.companyId, actorType: 'portal', portalUserId: s.user.id, clientId, eventType: 'portal_pm_removed', meta: { pm_id: pmId }, ip: clientIp(c) })
      return c.json({ ok: true })
    } catch (e: any) { return c.json({ error: e.message }, 500) }
  })

  // ── Autopay ────────────────────────────────────────────────────────────────

  // GET /api/portal/autopay — current autopay configuration
  app.get('/api/portal/autopay', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    const clientId = pickClientId(s, c.req.query('client_id'), 'manage_autopay')
    if (!clientId) return c.json({ error: 'Not permitted' }, 403)
    const row: any = await db.prepare(`SELECT enabled, stripe_pm_id, pm_label, max_amount, updated_at FROM client_autopay WHERE client_id=? AND company_id=? LIMIT 1`).bind(clientId, s.companyId).first()
    return c.json({ ok: true, data: row || { enabled: 0, stripe_pm_id: '', pm_label: '', max_amount: 0 }, client_id: clientId })
  })

  // PUT /api/portal/autopay — enable/disable, choose method, set cap
  app.put('/api/portal/autopay', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    const b: any = await c.req.json().catch(() => ({}))
    const clientId = pickClientId(s, b.client_id, 'manage_autopay')
    if (!clientId) return c.json({ error: 'Not permitted' }, 403)
    const enabled = b.enabled ? 1 : 0
    const maxAmount = Math.max(0, Number(b.max_amount) || 0)
    let pmId = String(b.stripe_pm_id || '')
    let pmLabel = ''
    if (enabled) {
      const stripeKey = stripeKeyOf(c)
      if (!stripeKey) return c.json({ error: 'Online payments are not available' }, 503)
      if (!pmId) return c.json({ error: 'Choose a payment method for autopay' }, 400)
      const client: any = await db.prepare(`SELECT stripe_customer_id FROM clients WHERE id=? AND company_id=? LIMIT 1`).bind(clientId, s.companyId).first()
      if (!client?.stripe_customer_id) return c.json({ error: 'Add a payment method first' }, 400)
      const pms = await listStripePMs(stripeKey, client.stripe_customer_id)
      const pm = pms.find(p => p.id === pmId)
      if (!pm) return c.json({ error: 'That payment method is not on file' }, 400)
      pmLabel = pm.label
    } else { pmId = '' }
    const maxAmountCents = Math.round(maxAmount * 100)
    await db.prepare(
      `INSERT INTO client_autopay (id, company_id, client_id, enabled, stripe_pm_id, pm_label, max_amount, max_amount_cents, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(client_id) DO UPDATE SET enabled=excluded.enabled, stripe_pm_id=excluded.stripe_pm_id,
         pm_label=excluded.pm_label, max_amount=excluded.max_amount, max_amount_cents=excluded.max_amount_cents, updated_by=excluded.updated_by, updated_at=datetime('now')`
    ).bind(`ap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, s.companyId, clientId, enabled, pmId, pmLabel, maxAmount, maxAmountCents, s.user.id).run()
    await portalAudit(db, { companyId: s.companyId, actorType: 'portal', portalUserId: s.user.id, clientId, eventType: 'portal_autopay_updated', meta: { enabled: !!enabled, max_amount: maxAmount }, ip: clientIp(c) })
    await notifyCompany(db, s.companyId, 'portal_autopay', `Autopay ${enabled ? 'enabled' : 'disabled'} by client`, `${s.user.name || s.user.email} ${enabled ? 'enabled' : 'disabled'} autopay${enabled && maxAmount ? ` (cap $${maxAmount})` : ''}.`, 'client', clientId, '#clients')
    return c.json({ ok: true })
  })

  // ── Payments: invoice pay + estimate deposit ───────────────────────────────

  async function recordInvoicePayment(db: D1Database, inv: any, amountDollars: number, piId: string, companyId: string) {
    const newPaid = (inv.amount_paid || 0) + amountDollars
    const newBalance = Math.max(0, (inv.total || inv.balance_due || 0) - newPaid)
    const newStatus = newBalance <= 0 ? 'paid' : 'partial'
    const amountCents = Math.round(amountDollars * 100)
    await db.prepare(`UPDATE invoices SET amount_paid=?, amount_paid_cents=?, balance_due=?, balance_due_cents=?, status=?, updated_at=datetime('now') WHERE id=? AND company_id=?`)
      .bind(newPaid, Math.round(newPaid*100), newBalance, Math.round(newBalance*100), newStatus, inv.id, companyId).run()
    await db.prepare(
      `INSERT INTO payments (id, company_id, invoice_id, client_id, amount, amount_cents, net_amount, net_amount_cents, status, payment_method, stripe_payment_intent_id, description, invoice_number, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`
    ).bind(`py_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, companyId, inv.id, inv.client_id || '', amountDollars, amountCents, amountDollars, amountCents,
      'succeeded', 'card', piId, `Portal payment — ${piId}`, inv.invoice_number || '').run()
    return { status: newStatus, balance_due: newBalance, amount_paid: newPaid }
  }

  // POST /api/portal/invoices/:id/pay — pay open balance with a saved method
  app.post('/api/portal/invoices/:id/pay', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    if (!s.can('make_payments')) return c.json({ error: 'Not permitted' }, 403)
    if (!(await rateLimit(db, 'ppay_' + s.user.id, 10, 600))) return c.json({ error: 'Too many payment attempts. Please wait a few minutes.' }, 429)
    const stripeKey = stripeKeyOf(c)
    if (!stripeKey) return c.json({ error: 'Online payments are not available' }, 503)
    const b: any = await c.req.json().catch(() => ({}))
    const pmId = String(b.stripe_pm_id || '')
    if (!pmId) return c.json({ error: 'Payment method required' }, 400)
    const cin = s.clientIds.map(() => '?').join(',')
    const inv: any = await db.prepare(`SELECT * FROM invoices WHERE id=? AND company_id=? AND client_id IN (${cin}) LIMIT 1`)
      .bind(c.req.param('id'), s.companyId, ...s.clientIds).first()
    if (!inv || !propOk(s, inv)) return c.json({ error: 'Not found' }, 404)
    if (!s.can('make_payments', inv.client_id)) return c.json({ error: 'Not permitted' }, 403)
    const owedCents = Math.round(Math.max(0, Number(inv.total || 0) - Number(inv.amount_paid || 0)) * 100)
    if (owedCents < 50) return c.json({ error: 'Nothing due on this invoice' }, 400)
    const company = await companyStripe(db, s.companyId)
    if (!company?.stripe_account_id || !company.stripe_onboarded) return c.json({ error: 'Online payment is not available' }, 400)
    const client: any = await db.prepare(`SELECT stripe_customer_id FROM clients WHERE id=? AND company_id=? LIMIT 1`).bind(inv.client_id, s.companyId).first()
    if (!client?.stripe_customer_id) return c.json({ error: 'No saved payment methods on file' }, 400)
    try {
      const pi = await chargeSavedPM(stripeKey, company, client.stripe_customer_id, pmId, owedCents,
        { invoice_id: inv.id, company_id: s.companyId, source: 'portal' })
      const out = await recordInvoicePayment(db, inv, owedCents / 100, pi.id, s.companyId)
      await portalAudit(db, { companyId: s.companyId, actorType: 'portal', portalUserId: s.user.id, clientId: inv.client_id, eventType: 'portal_invoice_paid', entityType: 'invoice', entityId: inv.id, entityLabel: inv.invoice_number || inv.id, meta: { amount: owedCents / 100 }, ip: clientIp(c) })
      await notifyCompany(db, s.companyId, 'portal_payment', `Invoice ${inv.invoice_number || ''} paid via portal`, `${s.user.name || s.user.email} paid $${(owedCents / 100).toFixed(2)}.`, 'invoice', inv.id, '#invoices')
      return c.json({ ok: true, ...out })
    } catch (e: any) { return c.json({ error: e.message }, 500) }
  })

  async function markDepositPaid(db: D1Database, est: any, amountDollars: number, piId: string, companyId: string) {
    const amountCents = Math.round(amountDollars * 100)
    await db.prepare(`UPDATE estimates SET deposit_paid=1, deposit_paid_at=datetime('now'), deposit_paid_amount=?, deposit_paid_amount_cents=?, stripe_payment_status='deposit_paid', payment_intent_id=?, updated_at=datetime('now') WHERE id=? AND company_id=?`)
      .bind(amountDollars, amountCents, piId, est.id, companyId).run()
    await db.prepare(
      `INSERT INTO payments (id, company_id, estimate_id, client_id, amount, amount_cents, net_amount, net_amount_cents, status, payment_method, stripe_payment_intent_id, description, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`
    ).bind(`py_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, companyId, est.id, est.client_id || '', amountDollars, amountCents, amountDollars, amountCents,
      'succeeded', 'card', piId, `Deposit — estimate ${est.est_number || est.id}`).run()
  }

  const depositEstFor = async (db: D1Database, s: PortalScope, id: string) => {
    const cin = s.clientIds.map(() => '?').join(',')
    const est: any = await db.prepare(`SELECT * FROM estimates WHERE id=? AND company_id=? AND client_id IN (${cin}) LIMIT 1`).bind(id, s.companyId, ...s.clientIds).first()
    return est && propOk(s, est) ? est : null
  }

  // POST /api/portal/estimates/:id/pay-deposit — saved method OR hosted checkout
  app.post('/api/portal/estimates/:id/pay-deposit', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    if (!s.can('make_payments')) return c.json({ error: 'Not permitted' }, 403)
    if (!(await rateLimit(db, 'ppay_' + s.user.id, 10, 600))) return c.json({ error: 'Too many payment attempts. Please wait a few minutes.' }, 429)
    const stripeKey = stripeKeyOf(c)
    if (!stripeKey) return c.json({ error: 'Online payments are not available' }, 503)
    const est = await depositEstFor(db, s, c.req.param('id'))
    if (!est) return c.json({ error: 'Not found' }, 404)
    if (!s.can('make_payments', est.client_id)) return c.json({ error: 'Not permitted' }, 403)
    if (est.deposit_paid) return c.json({ error: 'The deposit on this estimate is already paid' }, 400)
    const depCents = Math.round(Number(est.deposit_amt || 0) * 100)
    if (depCents < 50) return c.json({ error: 'No deposit is due on this estimate' }, 400)
    const company = await companyStripe(db, s.companyId)
    if (!company?.stripe_account_id || !company.stripe_onboarded) return c.json({ error: 'Online payment is not available' }, 400)
    const b: any = await c.req.json().catch(() => ({}))

    if (b.stripe_pm_id) {
      // Saved method: immediate off-session charge
      const client: any = await db.prepare(`SELECT stripe_customer_id FROM clients WHERE id=? AND company_id=? LIMIT 1`).bind(est.client_id, s.companyId).first()
      if (!client?.stripe_customer_id) return c.json({ error: 'No saved payment methods on file' }, 400)
      try {
        const pi = await chargeSavedPM(stripeKey, company, client.stripe_customer_id, String(b.stripe_pm_id), depCents,
          { estimate_id: est.id, company_id: s.companyId, source: 'portal_deposit' })
        await markDepositPaid(db, est, depCents / 100, pi.id, s.companyId)
        await portalAudit(db, { companyId: s.companyId, actorType: 'portal', portalUserId: s.user.id, clientId: est.client_id, eventType: 'portal_deposit_paid', entityType: 'estimate', entityId: est.id, entityLabel: est.est_number || est.id, meta: { amount: depCents / 100 }, ip: clientIp(c) })
        await notifyCompany(db, s.companyId, 'portal_payment', `Deposit paid on estimate ${est.est_number || ''}`, `${s.user.name || s.user.email} paid the $${(depCents / 100).toFixed(2)} deposit via the portal.`, 'estimate', est.id, '#estimates')
        return c.json({ ok: true, paid: true })
      } catch (e: any) { return c.json({ error: e.message }, 500) }
    }

    // No saved method: hosted Stripe Checkout on the connected account
    try {
      const origin = new URL(c.req.url).origin
      const feePct = company.stripe_platform_fee_pct || 2.9
      const form = new URLSearchParams({
        'payment_method_types[]': 'card',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': String(depCents),
        'line_items[0][price_data][product_data][name]': `Deposit — Estimate ${est.est_number || est.id}`,
        'line_items[0][quantity]': '1',
        mode: 'payment',
        'success_url': `${origin}/portal/home?dep_est=${encodeURIComponent(est.id)}&dep_session={CHECKOUT_SESSION_ID}`,
        'cancel_url': `${origin}/portal/home#estimates`,
        'payment_intent_data[application_fee_amount]': String(Math.round(depCents * feePct / 100)),
        'payment_intent_data[metadata][estimate_id]': est.id,
        'payment_intent_data[metadata][company_id]': s.companyId,
      })
      if (s.user.email) form.set('customer_email', s.user.email)
      const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Account': company.stripe_account_id },
        body: form.toString()
      })
      const session: any = await res.json()
      if (!res.ok) throw new Error(session.error?.message || 'Checkout creation failed')
      return c.json({ ok: true, url: session.url })
    } catch (e: any) { return c.json({ error: e.message }, 500) }
  })

  // POST /api/portal/estimates/:id/verify-deposit — confirm a Checkout return
  app.post('/api/portal/estimates/:id/verify-deposit', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    if (!s.can('make_payments')) return c.json({ error: 'Not permitted' }, 403)
    const stripeKey = stripeKeyOf(c)
    if (!stripeKey) return c.json({ error: 'Online payments are not available' }, 503)
    const est = await depositEstFor(db, s, c.req.param('id'))
    if (!est) return c.json({ error: 'Not found' }, 404)
    if (est.deposit_paid) return c.json({ ok: true, paid: true })  // idempotent
    const b: any = await c.req.json().catch(() => ({}))
    const sessionId = String(b.session_id || '')
    if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return c.json({ error: 'Invalid session' }, 400)
    const company = await companyStripe(db, s.companyId)
    if (!company?.stripe_account_id) return c.json({ error: 'Online payment is not available' }, 400)
    try {
      const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
        headers: { 'Authorization': `Bearer ${stripeKey}`, 'Stripe-Account': company.stripe_account_id }
      })
      const session: any = await res.json()
      if (!res.ok) throw new Error(session.error?.message || 'Could not verify payment')
      if (session.payment_status !== 'paid') return c.json({ ok: true, paid: false })
      // Confirm the session belongs to THIS estimate before marking paid
      const piRes = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(session.payment_intent)}`, {
        headers: { 'Authorization': `Bearer ${stripeKey}`, 'Stripe-Account': company.stripe_account_id }
      })
      const pi: any = await piRes.json()
      if (!piRes.ok || pi.metadata?.estimate_id !== est.id) return c.json({ error: 'Payment does not match this estimate' }, 400)
      await markDepositPaid(db, est, (session.amount_total || 0) / 100, session.payment_intent || '', s.companyId)
      await portalAudit(db, { companyId: s.companyId, actorType: 'portal', portalUserId: s.user.id, clientId: est.client_id, eventType: 'portal_deposit_paid', entityType: 'estimate', entityId: est.id, entityLabel: est.est_number || est.id, meta: { amount: (session.amount_total || 0) / 100, via: 'checkout' }, ip: clientIp(c) })
      await notifyCompany(db, s.companyId, 'portal_payment', `Deposit paid on estimate ${est.est_number || ''}`, `${s.user.name || s.user.email} paid the $${((session.amount_total || 0) / 100).toFixed(2)} deposit via the portal.`, 'estimate', est.id, '#estimates')
      return c.json({ ok: true, paid: true })
    } catch (e: any) { return c.json({ error: e.message }, 500) }
  })

  // ── Contacts ───────────────────────────────────────────────────────────────

  // GET /api/portal/contacts — active contacts across manageable clients
  app.get('/api/portal/contacts', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    const ids = s.clientIds.filter(id => s.can('manage_contacts', id))
    if (!ids.length) return c.json({ error: 'Not permitted' }, 403)
    const cin = ids.map(() => '?').join(',')
    const rows = (await db.prepare(
      `SELECT id, client_id, name, email, phone, title, is_primary, created_at FROM client_contacts
       WHERE company_id=? AND client_id IN (${cin}) AND active=1 ORDER BY is_primary DESC, name ASC LIMIT 200`
    ).bind(s.companyId, ...ids).all()).results || []
    return c.json({ ok: true, data: rows })
  })

  // POST /api/portal/contacts — add a contact
  app.post('/api/portal/contacts', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    const b: any = await c.req.json().catch(() => ({}))
    const clientId = pickClientId(s, b.client_id, 'manage_contacts')
    if (!clientId) return c.json({ error: 'Not permitted' }, 403)
    const name = String(b.name || '').trim().slice(0, 120)
    if (!name) return c.json({ error: 'Name is required' }, 400)
    const id = `cc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    await db.prepare(
      `INSERT INTO client_contacts (id, company_id, client_id, name, email, phone, title) VALUES (?,?,?,?,?,?,?)`
    ).bind(id, s.companyId, clientId, name, String(b.email || '').trim().slice(0, 160).toLowerCase(),
      String(b.phone || '').trim().slice(0, 40), String(b.title || '').trim().slice(0, 80)).run()
    await portalAudit(db, { companyId: s.companyId, actorType: 'portal', portalUserId: s.user.id, clientId, eventType: 'portal_contact_added', entityType: 'contact', entityId: id, entityLabel: name, ip: clientIp(c) })
    return c.json({ ok: true, id })
  })

  // PUT /api/portal/contacts/:id — update a contact
  app.put('/api/portal/contacts/:id', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    const row: any = await db.prepare(`SELECT id, client_id, name FROM client_contacts WHERE id=? AND company_id=? AND active=1 LIMIT 1`).bind(c.req.param('id'), s.companyId).first()
    if (!row || !s.clientIds.includes(row.client_id) || !s.can('manage_contacts', row.client_id)) return c.json({ error: 'Not found' }, 404)
    const b: any = await c.req.json().catch(() => ({}))
    const updates: string[] = []; const vals: any[] = []
    if (typeof b.name === 'string' && b.name.trim()) { updates.push('name=?'); vals.push(b.name.trim().slice(0, 120)) }
    if (typeof b.email === 'string') { updates.push('email=?'); vals.push(b.email.trim().slice(0, 160).toLowerCase()) }
    if (typeof b.phone === 'string') { updates.push('phone=?'); vals.push(b.phone.trim().slice(0, 40)) }
    if (typeof b.title === 'string') { updates.push('title=?'); vals.push(b.title.trim().slice(0, 80)) }
    if (!updates.length) return c.json({ error: 'Nothing to update' }, 400)
    updates.push(`updated_at=datetime('now')`)
    await db.prepare(`UPDATE client_contacts SET ${updates.join(',')} WHERE id=?`).bind(...vals, row.id).run()
    await portalAudit(db, { companyId: s.companyId, actorType: 'portal', portalUserId: s.user.id, clientId: row.client_id, eventType: 'portal_contact_updated', entityType: 'contact', entityId: row.id, entityLabel: row.name, ip: clientIp(c) })
    return c.json({ ok: true })
  })

  // DELETE /api/portal/contacts/:id — deactivate (soft delete)
  app.delete('/api/portal/contacts/:id', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    const row: any = await db.prepare(`SELECT id, client_id, name FROM client_contacts WHERE id=? AND company_id=? AND active=1 LIMIT 1`).bind(c.req.param('id'), s.companyId).first()
    if (!row || !s.clientIds.includes(row.client_id) || !s.can('manage_contacts', row.client_id)) return c.json({ error: 'Not found' }, 404)
    // A contact that is linked to a portal login cannot be removed from the portal
    const linked: any = await db.prepare(`SELECT id FROM portal_users WHERE contact_id=? AND status!='disabled' LIMIT 1`).bind(row.id).first()
    if (linked) return c.json({ error: 'This contact has portal access. Ask your contractor to remove their access first.' }, 400)
    await db.prepare(`UPDATE client_contacts SET active=0, updated_at=datetime('now') WHERE id=?`).bind(row.id).run()
    await portalAudit(db, { companyId: s.companyId, actorType: 'portal', portalUserId: s.user.id, clientId: row.client_id, eventType: 'portal_contact_removed', entityType: 'contact', entityId: row.id, entityLabel: row.name, ip: clientIp(c) })
    return c.json({ ok: true })
  })

  // ══ PHASE 1C: PROJECTS — work orders, daily updates, R2 photos ════════════

  const WO_PORTAL_STATUSES = ['scheduled', 'in_progress', 'started', 'paused', 'completed', 'done']
  const woPhase = (st: string) => (['completed', 'done'].includes(st) ? 'completed' : ['in_progress', 'started', 'paused'].includes(st) ? 'in_progress' : 'scheduled')

  // GET /api/portal/projects — visible work orders for the account
  app.get('/api/portal/projects', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    if (!s.can('view_projects')) return c.json({ error: 'Not permitted' }, 403)
    const cin = s.clientIds.map(() => '?').join(',')
    const rows = ((await db.prepare(
      `SELECT id, wo_number, title, type, status, scheduled_date, scheduled_time, scheduled_end_time,
              property_addr, client_id, property_id, created_at
       FROM work_orders
       WHERE company_id=? AND client_id IN (${cin}) AND portal_visible=1
         AND status IN (${WO_PORTAL_STATUSES.map(() => '?').join(',')})
       ORDER BY CASE WHEN status IN ('completed','done') THEN 1 ELSE 0 END, scheduled_date DESC LIMIT 100`
    ).bind(s.companyId, ...s.clientIds, ...WO_PORTAL_STATUSES).all()).results as any[] || []).filter(r => propOk(s, r))
    // Latest update snippet + photo count per project
    for (const r of rows) {
      r.phase = woPhase(r.status)
      const u: any = await db.prepare(`SELECT update_date, title, body FROM project_updates
        WHERE work_order_id=? AND status='published' ORDER BY update_date DESC, created_at DESC LIMIT 1`).bind(r.id).first()
      r.latest_update = u || null
      const m: any = await db.prepare(`SELECT COUNT(*) n FROM project_media WHERE work_order_id=? AND visibility='client' AND kind='photo'`).bind(r.id).first()
      r.photo_count = m?.n || 0
    }
    return c.json({ ok: true, data: rows })
  })

  // GET /api/portal/projects/:id — detail with published updates + photos
  app.get('/api/portal/projects/:id', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    if (!s.can('view_projects')) return c.json({ error: 'Not permitted' }, 403)
    const cin = s.clientIds.map(() => '?').join(',')
    const row: any = await db.prepare(
      `SELECT id, wo_number, title, type, status, scheduled_date, scheduled_time, scheduled_end_time,
              duration_hours, property_addr, completion_notes, client_id, property_id, created_at
       FROM work_orders WHERE id=? AND company_id=? AND client_id IN (${cin}) AND portal_visible=1 LIMIT 1`
    ).bind(c.req.param('id'), s.companyId, ...s.clientIds).first()
    if (!row || !propOk(s, row)) return c.json({ error: 'Not found' }, 404)
    row.phase = woPhase(row.status)
    const updates = (await db.prepare(
      `SELECT id, update_date, title, body, published_at FROM project_updates
       WHERE work_order_id=? AND status='published' ORDER BY update_date DESC, created_at DESC LIMIT 60`
    ).bind(row.id).all()).results as any[] || []
    const media = (await db.prepare(
      `SELECT id, update_id, file_name, content_type, kind, caption, created_at FROM project_media
       WHERE work_order_id=? AND visibility='client' ORDER BY created_at DESC LIMIT 300`
    ).bind(row.id).all()).results as any[] || []
    for (const u of updates) u.media = media.filter(m => m.update_id === u.id)
    const unattached = media.filter(m => !m.update_id)
    return c.json({ ok: true, data: { project: row, updates, photos: unattached } })
  })

  // GET /api/portal/media/:id — stream an R2 object (portal-scoped)
  app.get('/api/portal/media/:id', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    const m: any = await db.prepare(
      `SELECT r2_key, content_type, file_name, client_id, company_id, visibility FROM project_media WHERE id=? LIMIT 1`
    ).bind(c.req.param('id')).first()
    if (!m || m.company_id !== s.companyId || m.visibility !== 'client' || !s.clientIds.includes(m.client_id)) {
      return c.json({ error: 'Not found' }, 404)
    }
    const obj = await (c.env.MEDIA as R2Bucket).get(m.r2_key)
    if (!obj) return c.json({ error: 'Not found' }, 404)
    return new Response(obj.body as any, {
      headers: {
        'Content-Type': m.content_type || 'application/octet-stream',
        'Cache-Control': 'private, max-age=3600',
        'Content-Disposition': `inline; filename="${(m.file_name || 'file').replace(/[^\w.\- ]/g, '')}"`
      }
    })
  })

  // ── Staff: media upload + daily updates ────────────────────────────────────

  // POST /api/admin/portal/projects/:woId/media — multipart photo upload to R2
  app.post('/api/admin/portal/projects/:woId/media', deps.requireStaffAuth, async (c) => {
    const db = c.env.DB as D1Database
    const companyId = c.var.companyId as string
    const wo: any = await db.prepare(`SELECT id, client_id FROM work_orders WHERE id=? AND company_id=?`).bind(c.req.param('woId'), companyId).first()
    if (!wo) return c.json({ error: 'Work order not found' }, 404)
    const form = await c.req.formData().catch(() => null)
    if (!form) return c.json({ error: 'multipart/form-data required' }, 400)
    const file = form.get('file') as unknown as File | null
    if (!file || typeof (file as any).arrayBuffer !== 'function') return c.json({ error: 'file field required' }, 400)
    const MAX = 15 * 1024 * 1024
    if ((file as any).size > MAX) return c.json({ error: 'File too large (max 15 MB)' }, 413)
    const ct = (file as any).type || 'application/octet-stream'
    const kind = ct.startsWith('image/') ? 'photo' : 'document'
    const caption = String(form.get('caption') || '').slice(0, 300)
    const updateId = String(form.get('update_id') || '')
    const id = 'med_' + pUid()
    const safeName = String((file as any).name || 'upload').replace(/[^\w.\- ]/g, '_').slice(0, 120)
    const key = `projects/${companyId}/${wo.id}/${id}_${safeName}`
    await (c.env.MEDIA as R2Bucket).put(key, await (file as any).arrayBuffer(), { httpMetadata: { contentType: ct } })
    await db.prepare(`INSERT INTO project_media (id, company_id, work_order_id, update_id, client_id, r2_key, file_name, content_type, size_bytes, kind, caption, visibility, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'client',?)`)
      .bind(id, companyId, wo.id, updateId, wo.client_id || '', key, safeName, ct, (file as any).size || 0, kind, caption, c.var.repId as string).run()
    return c.json({ ok: true, id, file_name: safeName, kind })
  })

  // GET /api/admin/portal/media/:id — staff view of any media in their company
  app.get('/api/admin/portal/media/:id', deps.requireStaffAuth, async (c) => {
    const db = c.env.DB as D1Database
    const m: any = await db.prepare(`SELECT r2_key, content_type, file_name, company_id FROM project_media WHERE id=? LIMIT 1`).bind(c.req.param('id')).first()
    if (!m || m.company_id !== (c.var.companyId as string)) return c.json({ error: 'Not found' }, 404)
    const obj = await (c.env.MEDIA as R2Bucket).get(m.r2_key)
    if (!obj) return c.json({ error: 'Not found' }, 404)
    return new Response(obj.body as any, { headers: { 'Content-Type': m.content_type || 'application/octet-stream', 'Cache-Control': 'private, max-age=3600' } })
  })

  // DELETE /api/admin/portal/media/:id
  app.delete('/api/admin/portal/media/:id', deps.requireStaffAuth, async (c) => {
    const db = c.env.DB as D1Database
    const m: any = await db.prepare(`SELECT id, r2_key, company_id FROM project_media WHERE id=? LIMIT 1`).bind(c.req.param('id')).first()
    if (!m || m.company_id !== (c.var.companyId as string)) return c.json({ error: 'Not found' }, 404)
    await (c.env.MEDIA as R2Bucket).delete(m.r2_key).catch(() => {})
    await db.prepare(`DELETE FROM project_media WHERE id=?`).bind(m.id).run()
    return c.json({ ok: true })
  })

  // GET /api/admin/portal/projects/:woId/updates — staff list (all statuses)
  app.get('/api/admin/portal/projects/:woId/updates', deps.requireStaffAuth, async (c) => {
    const db = c.env.DB as D1Database
    const companyId = c.var.companyId as string
    const rows = (await db.prepare(
      `SELECT id, update_date, title, body, status, published_at, created_by, created_at FROM project_updates
       WHERE work_order_id=? AND company_id=? ORDER BY update_date DESC, created_at DESC LIMIT 100`
    ).bind(c.req.param('woId'), companyId).all()).results as any[] || []
    for (const u of rows) {
      u.media = (await db.prepare(`SELECT id, file_name, kind, caption FROM project_media WHERE update_id=?`).bind(u.id).all()).results || []
    }
    return c.json({ ok: true, data: rows })
  })

  // POST /api/admin/portal/projects/:woId/updates — publish a daily update
  app.post('/api/admin/portal/projects/:woId/updates', deps.requireStaffAuth, async (c) => {
    const db = c.env.DB as D1Database
    const companyId = c.var.companyId as string
    const wo: any = await db.prepare(`SELECT id, client_id, property_id, title, wo_number FROM work_orders WHERE id=? AND company_id=?`).bind(c.req.param('woId'), companyId).first()
    if (!wo) return c.json({ error: 'Work order not found' }, 404)
    const b: any = await c.req.json().catch(() => ({}))
    const body = String(b.body || '').trim().slice(0, 4000)
    if (!body) return c.json({ error: 'Update text is required' }, 400)
    const id = 'upd_' + pUid()
    const updateDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.update_date || '')) ? b.update_date : new Date().toISOString().slice(0, 10)
    await db.prepare(`INSERT INTO project_updates (id, company_id, work_order_id, client_id, property_id, update_date, title, body, status, published_at, created_by)
      VALUES (?,?,?,?,?,?,?,?,'published',datetime('now'),?)`)
      .bind(id, companyId, wo.id, wo.client_id || '', wo.property_id || '', updateDate, String(b.title || '').slice(0, 160), body, c.var.repId as string).run()
    // Attach previously-uploaded media ids
    if (Array.isArray(b.media_ids) && b.media_ids.length) {
      for (const mid of b.media_ids.slice(0, 30)) {
        await db.prepare(`UPDATE project_media SET update_id=? WHERE id=? AND company_id=? AND work_order_id=?`).bind(id, mid, companyId, wo.id).run()
      }
    }
    await portalAudit(db, { companyId, actorType: 'staff', repId: c.var.repId as string, clientId: wo.client_id || '', eventType: 'portal_update_published', entityType: 'project_update', entityId: id, entityLabel: `${wo.wo_number || wo.id} ${updateDate}`, ip: clientIp(c) })
    // Email active portal users on this client who can view projects (unless suppressed).
    let emailed = 0
    if (b.notify_client !== false && wo.client_id && c.env.SENDGRID_API_KEY) {
      try {
        const pus = (await db.prepare(
          `SELECT DISTINCT pu.id, pu.email, pu.name, pm.role, pm.permissions FROM portal_users pu
           JOIN portal_memberships pm ON pm.portal_user_id=pu.id AND pm.active=1
           WHERE pm.client_id=? AND pu.company_id=? AND pu.status='active' LIMIT 20`
        ).bind(wo.client_id, companyId).all()).results as any[] || []
        const co: any = await db.prepare(`SELECT name, brand_color FROM companies WHERE id=? LIMIT 1`).bind(companyId).first()
        const origin = new URL(c.req.url).origin
        const brand = (co?.brand_color || '#2D7A55').replace(/[^#0-9A-Fa-f]/g, '') || '#2D7A55'
        const mediaCount = Array.isArray(b.media_ids) ? Math.min(b.media_ids.length, 30) : 0
        for (const pu of pus) {
          let perms: any = {}
          try { perms = { ...(PORTAL_ROLE_PRESETS[pu.role] || {}), ...JSON.parse(pu.permissions || '{}') } } catch (_) { perms = PORTAL_ROLE_PRESETS[pu.role] || {} }
          if (!perms.view_projects) continue
          const ok = await deps.sendEmail(c.env.SENDGRID_API_KEY, pu.email,
            `Project update: ${wo.title || wo.wo_number || 'your project'}`,
            `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
              <h2 style="color:#1F2A2B;margin:0 0 4px">${escH(b.title || 'New project update')}</h2>
              <p style="font-size:12px;color:#6B7280;margin:0 0 16px">${escH(wo.title || '')} &middot; ${escH(updateDate)}${mediaCount ? ` &middot; ${mediaCount} photo${mediaCount === 1 ? '' : 's'}` : ''}</p>
              <p style="font-size:14px;line-height:1.6;color:#1F2A2B;white-space:pre-wrap">${escH(body.slice(0, 600))}${body.length > 600 ? '&hellip;' : ''}</p>
              <p style="margin:20px 0"><a href="${origin}/portal/home#projects" style="display:inline-block;background:${brand};color:#fff;text-decoration:none;font-weight:700;padding:12px 28px;border-radius:8px">View in Your Portal</a></p>
              <p style="font-size:11px;color:#9CA3AF">Sent by ${escH(co?.name || 'your contractor')} via their client portal.</p>
            </div>`,
            { fromName: co?.name || undefined })
          if (ok) emailed++
        }
      } catch (_) { /* email failures never block the publish */ }
    }
    return c.json({ ok: true, id, emailed })
  })

  // DELETE /api/admin/portal/updates/:id
  app.delete('/api/admin/portal/updates/:id', deps.requireStaffAuth, async (c) => {
    const db = c.env.DB as D1Database
    const companyId = c.var.companyId as string
    const u: any = await db.prepare(`SELECT id FROM project_updates WHERE id=? AND company_id=?`).bind(c.req.param('id'), companyId).first()
    if (!u) return c.json({ error: 'Not found' }, 404)
    await db.batch([
      db.prepare(`UPDATE project_media SET update_id='' WHERE update_id=?`).bind(u.id),
      db.prepare(`DELETE FROM project_updates WHERE id=?`).bind(u.id)
    ])
    return c.json({ ok: true })
  })

  // ══ INTERNAL ADMIN APIS (staff auth) ══════════════════════════════════════

  // GET /api/admin/portal/users — all portal users for the company, or (with
  // ?client_id=) just the users who have a membership on one specific client.
  app.get('/api/admin/portal/users', deps.requireStaffAuth, async (c) => {
    const db = c.env.DB as D1Database
    const companyId = c.var.companyId as string
    const clientFilter = c.req.query('client_id') || ''
    const users = (await db.prepare(
      clientFilter
        ? `SELECT u.id, u.contact_id, u.email, u.name, u.phone, u.status, u.invite_sent_at, u.invite_expires_at,
                  u.activated_at, u.last_login_at, u.created_at,
                  CASE WHEN u.invite_token != '' THEN 1 ELSE 0 END as has_pending_invite
           FROM portal_users u
           WHERE u.company_id=? AND EXISTS (SELECT 1 FROM portal_memberships m WHERE m.portal_user_id=u.id AND m.client_id=?)
           ORDER BY u.created_at DESC`
        : `SELECT id, contact_id, email, name, phone, status, invite_sent_at, invite_expires_at,
                  activated_at, last_login_at, created_at,
                  CASE WHEN invite_token != '' THEN 1 ELSE 0 END as has_pending_invite
           FROM portal_users WHERE company_id=? ORDER BY created_at DESC`
    ).bind(...(clientFilter ? [companyId, clientFilter] : [companyId])).all()).results as any[] || []
    for (const u of users) {
      u.memberships = (await db.prepare(
        `SELECT m.id, m.client_id, m.role, m.all_properties, m.active, c.name as client_name
         FROM portal_memberships m JOIN clients c ON c.id=m.client_id WHERE m.portal_user_id=?`
      ).bind(u.id).all()).results || []
    }
    return c.json({ ok: true, data: users })
  })

  // POST /api/admin/portal/preview/:clientId — start a locked-down, read-only
  // "Preview Portal" session for a specific client. No password, no existing
  // portal_users row required. See migration 0056 + PORTAL_PREVIEW_PERMISSIONS.
  app.post('/api/admin/portal/preview/:clientId', deps.requireStaffAuth, async (c) => {
    const db = c.env.DB as D1Database
    const companyId = c.var.companyId as string
    const repId = c.var.repId as string
    const clientId = c.req.param('clientId')
    const client: any = await db.prepare(`SELECT id, name FROM clients WHERE id=? AND company_id=?`).bind(clientId, companyId).first()
    if (!client) return c.json({ error: 'Client not found' }, 404)
    const token = pUid() + pUid()
    await db.prepare(
      `INSERT INTO portal_sessions (token, portal_user_id, ip, user_agent, is_preview, preview_client_id, preview_company_id, preview_rep_id)
       VALUES (?,?,?,?,1,?,?,?)`
    ).bind(token, 'preview_' + repId, clientIp(c), (c.req.header('user-agent') || '').slice(0, 300), clientId, companyId, repId).run()
    setCookie(c, PORTAL_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: PREVIEW_MAX_AGE_HOURS * 3600 })
    await portalAudit(db, { companyId, actorType: 'staff', repId, clientId, eventType: 'portal_preview_started', entityType: 'client', entityId: clientId, entityLabel: client.name, ip: clientIp(c) })
    return c.json({ ok: true, url: '/portal/home' })
  })

  // GET /api/admin/portal/clients/:id/properties — for the invite form
  app.get('/api/admin/portal/clients/:id/properties', deps.requireStaffAuth, async (c) => {
    const db = c.env.DB as D1Database
    const rows = (await db.prepare(`SELECT id, label, street, city, state, zip, is_primary FROM properties WHERE client_id=? AND company_id=? AND active=1`)
      .bind(c.req.param('id'), c.var.companyId as string).all()).results || []
    return c.json({ ok: true, data: rows })
  })

  // POST /api/admin/portal/users — invite a client contact to the portal
  app.post('/api/admin/portal/users', deps.requireStaffAuth, async (c) => {
    const db = c.env.DB as D1Database
    const companyId = c.var.companyId as string
    const repId = c.var.repId as string
    const b: any = await c.req.json().catch(() => ({}))
    const { client_id, name, email, phone, role, all_properties, property_ids } = b
    if (!client_id || !name || !email) return c.json({ error: 'client_id, name, and email are required' }, 400)
    const client: any = await db.prepare(`SELECT id, name FROM clients WHERE id=? AND company_id=?`).bind(client_id, companyId).first()
    if (!client) return c.json({ error: 'Client not found' }, 404)
    const roleKey = PORTAL_ROLE_PRESETS[role] ? role : 'read_only'

    // Reuse existing portal user with this email, or create a new one
    let user: any = await db.prepare(`SELECT * FROM portal_users WHERE company_id=? AND lower(email)=lower(?) LIMIT 1`).bind(companyId, String(email).trim()).first()
    const inviteToken = pUid() + pUid()
    if (!user) {
      const contactId = 'cc_' + pUid()
      await db.prepare(`INSERT INTO client_contacts (id, company_id, client_id, name, email, phone) VALUES (?,?,?,?,?,?)`)
        .bind(contactId, companyId, client_id, name.trim(), String(email).trim(), phone || '').run()
      const userId = 'pu_' + pUid()
      await db.prepare(`INSERT INTO portal_users (id, company_id, contact_id, email, name, phone, status, invite_token, invite_sent_at, invite_expires_at, created_by)
        VALUES (?,?,?,?,?,?,'invited',?,datetime('now'),datetime('now','+7 days'),?)`)
        .bind(userId, companyId, contactId, String(email).trim(), name.trim(), phone || '', inviteToken, repId).run()
      user = { id: userId, email: String(email).trim(), name: name.trim(), status: 'invited' }
    } else if (user.status === 'invited') {
      await db.prepare(`UPDATE portal_users SET invite_token=?, invite_sent_at=datetime('now'), invite_expires_at=datetime('now','+7 days'), updated_at=datetime('now') WHERE id=?`)
        .bind(inviteToken, user.id).run()
    }

    // Membership (idempotent)
    const memId = 'pm_' + pUid()
    await db.prepare(`INSERT INTO portal_memberships (id, company_id, portal_user_id, client_id, role, permissions, all_properties, active)
      VALUES (?,?,?,?,?,'{}',?,1)
      ON CONFLICT(portal_user_id, client_id) DO UPDATE SET role=excluded.role, all_properties=excluded.all_properties, active=1, updated_at=datetime('now')`)
      .bind(memId, companyId, user.id, client_id, roleKey, all_properties === false ? 0 : 1).run()

    // Explicit property grants
    if (all_properties === false && Array.isArray(property_ids) && property_ids.length) {
      const mem: any = await db.prepare(`SELECT id FROM portal_memberships WHERE portal_user_id=? AND client_id=?`).bind(user.id, client_id).first()
      if (mem) {
        await db.prepare(`DELETE FROM property_access WHERE membership_id=?`).bind(mem.id).run()
        for (const pid of property_ids.slice(0, 100)) {
          const owned: any = await db.prepare(`SELECT id FROM properties WHERE id=? AND client_id=?`).bind(pid, client_id).first()
          if (owned) await db.prepare(`INSERT OR IGNORE INTO property_access (id, membership_id, property_id) VALUES (?,?,?)`).bind('pa_' + pUid(), mem.id, pid).run()
        }
      }
    }

    // Send / return invitation
    const origin = new URL(c.req.url).origin
    const inviteLink = `${origin}/portal/accept/${user.status === 'invited' ? inviteToken : ''}`
    let emailSent = false
    if (user.status === 'invited') {
      const apiKey = c.env.SENDGRID_API_KEY
      const co: any = await db.prepare(`SELECT name FROM companies WHERE id=?`).bind(companyId).first()
      if (apiKey) {
        emailSent = await deps.sendEmail(apiKey, user.email, `${co?.name || 'Your contractor'} invited you to their client portal`,
          `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
            <h2 style="color:#1F2A2B">You're invited to the client portal</h2>
            <p>${escH(co?.name || 'Your contractor')} has set up secure portal access for <strong>${escH(client.name)}</strong>. You can review estimates, invoices, project updates, and documents in one place.</p>
            <p><a href="${inviteLink}" style="display:inline-block;background:#2D7A55;color:#fff;text-decoration:none;font-weight:700;padding:12px 28px;border-radius:8px">Activate Your Account</a></p>
            <p style="font-size:12px;color:#6B7280">This invitation expires in 7 days. If you weren't expecting it, you can ignore this email.</p>
          </div>`)
      }
    }
    await portalAudit(db, { companyId, actorType: 'staff', repId, clientId: client_id, portalUserId: user.id, eventType: 'portal_invite_sent', entityType: 'portal_user', entityId: user.id, entityLabel: user.email, meta: { role: roleKey, email_sent: emailSent }, ip: clientIp(c) })
    return c.json({ ok: true, user_id: user.id, status: user.status, invite_link: user.status === 'invited' ? inviteLink : null, email_sent: emailSent })
  })

  // POST /api/admin/portal/users/:id/resend — new token + email
  app.post('/api/admin/portal/users/:id/resend', deps.requireStaffAuth, async (c) => {
    const db = c.env.DB as D1Database
    const companyId = c.var.companyId as string
    const user: any = await db.prepare(`SELECT * FROM portal_users WHERE id=? AND company_id=?`).bind(c.req.param('id'), companyId).first()
    if (!user) return c.json({ error: 'Not found' }, 404)
    if (user.status === 'active') return c.json({ error: 'User is already active' }, 400)
    const inviteToken = pUid() + pUid()
    await db.prepare(`UPDATE portal_users SET invite_token=?, invite_sent_at=datetime('now'), invite_expires_at=datetime('now','+7 days'), status='invited', updated_at=datetime('now') WHERE id=?`)
      .bind(inviteToken, user.id).run()
    const origin = new URL(c.req.url).origin
    const inviteLink = `${origin}/portal/accept/${inviteToken}`
    let emailSent = false
    const apiKey = c.env.SENDGRID_API_KEY
    if (apiKey) {
      const co: any = await db.prepare(`SELECT name FROM companies WHERE id=?`).bind(companyId).first()
      emailSent = await deps.sendEmail(apiKey, user.email, `Reminder: activate your ${co?.name || ''} client portal account`,
        `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
          <p>Here is a fresh link to activate your client portal account. It expires in 7 days.</p>
          <p><a href="${inviteLink}" style="display:inline-block;background:#2D7A55;color:#fff;text-decoration:none;font-weight:700;padding:12px 28px;border-radius:8px">Activate Your Account</a></p>
        </div>`)
    }
    await portalAudit(db, { companyId, actorType: 'staff', repId: c.var.repId as string, portalUserId: user.id, eventType: 'portal_invite_resent', entityType: 'portal_user', entityId: user.id, entityLabel: user.email, meta: { email_sent: emailSent }, ip: clientIp(c) })
    return c.json({ ok: true, invite_link: inviteLink, email_sent: emailSent })
  })

  // PUT /api/admin/portal/users/:id — role / permissions / property scope
  app.put('/api/admin/portal/users/:id', deps.requireStaffAuth, async (c) => {
    const db = c.env.DB as D1Database
    const companyId = c.var.companyId as string
    const user: any = await db.prepare(`SELECT id FROM portal_users WHERE id=? AND company_id=?`).bind(c.req.param('id'), companyId).first()
    if (!user) return c.json({ error: 'Not found' }, 404)
    const b: any = await c.req.json().catch(() => ({}))
    if (b.client_id && (b.role || b.all_properties !== undefined || b.permissions)) {
      const mem: any = await db.prepare(`SELECT id FROM portal_memberships WHERE portal_user_id=? AND client_id=?`).bind(user.id, b.client_id).first()
      if (!mem) return c.json({ error: 'Membership not found' }, 404)
      const sets: string[] = []; const vals: any[] = []
      if (b.role && PORTAL_ROLE_PRESETS[b.role]) { sets.push('role=?'); vals.push(b.role) }
      if (b.permissions && typeof b.permissions === 'object') { sets.push('permissions=?'); vals.push(JSON.stringify(b.permissions)) }
      if (b.all_properties !== undefined) { sets.push('all_properties=?'); vals.push(b.all_properties ? 1 : 0) }
      if (sets.length) {
        sets.push(`updated_at=datetime('now')`)
        await db.prepare(`UPDATE portal_memberships SET ${sets.join(',')} WHERE id=?`).bind(...vals, mem.id).run()
      }
      if (b.all_properties === false && Array.isArray(b.property_ids)) {
        await db.prepare(`DELETE FROM property_access WHERE membership_id=?`).bind(mem.id).run()
        for (const pid of b.property_ids.slice(0, 100)) {
          const owned: any = await db.prepare(`SELECT id FROM properties WHERE id=? AND client_id=?`).bind(pid, b.client_id).first()
          if (owned) await db.prepare(`INSERT OR IGNORE INTO property_access (id, membership_id, property_id) VALUES (?,?,?)`).bind('pa_' + pUid(), mem.id, pid).run()
        }
      }
      await portalAudit(db, { companyId, actorType: 'staff', repId: c.var.repId as string, portalUserId: user.id, clientId: b.client_id, eventType: 'portal_access_changed', entityType: 'portal_user', entityId: user.id, meta: { role: b.role, all_properties: b.all_properties }, ip: clientIp(c) })
    }
    return c.json({ ok: true })
  })

  // POST /api/admin/portal/users/:id/disable | /reactivate
  app.post('/api/admin/portal/users/:id/disable', deps.requireStaffAuth, async (c) => {
    const db = c.env.DB as D1Database
    const companyId = c.var.companyId as string
    const user: any = await db.prepare(`SELECT id, email FROM portal_users WHERE id=? AND company_id=?`).bind(c.req.param('id'), companyId).first()
    if (!user) return c.json({ error: 'Not found' }, 404)
    await db.batch([
      db.prepare(`UPDATE portal_users SET status='disabled', invite_token='', updated_at=datetime('now') WHERE id=?`).bind(user.id),
      db.prepare(`DELETE FROM portal_sessions WHERE portal_user_id=?`).bind(user.id)   // immediate lockout
    ])
    await portalAudit(db, { companyId, actorType: 'staff', repId: c.var.repId as string, portalUserId: user.id, eventType: 'portal_access_disabled', entityType: 'portal_user', entityId: user.id, entityLabel: user.email, ip: clientIp(c) })
    return c.json({ ok: true })
  })

  app.post('/api/admin/portal/users/:id/reactivate', deps.requireStaffAuth, async (c) => {
    const db = c.env.DB as D1Database
    const companyId = c.var.companyId as string
    const user: any = await db.prepare(`SELECT id, email, password_hash FROM portal_users WHERE id=? AND company_id=?`).bind(c.req.param('id'), companyId).first()
    if (!user) return c.json({ error: 'Not found' }, 404)
    // If they had activated before, restore to active; otherwise back to invited.
    const newStatus = user.password_hash ? 'active' : 'invited'
    await db.prepare(`UPDATE portal_users SET status=?, updated_at=datetime('now') WHERE id=?`).bind(newStatus, user.id).run()
    await portalAudit(db, { companyId, actorType: 'staff', repId: c.var.repId as string, portalUserId: user.id, eventType: 'portal_access_reactivated', entityType: 'portal_user', entityId: user.id, entityLabel: user.email, ip: clientIp(c) })
    return c.json({ ok: true, status: newStatus })
  })

  // GET /api/admin/portal/audit — recent portal-related audit events
  app.get('/api/admin/portal/audit', deps.requireStaffAuth, async (c) => {
    const db = c.env.DB as D1Database
    const rows = (await db.prepare(
      `SELECT id, event_type, entity_type, entity_id, entity_label, actor_type, portal_user_id, client_id, ip, created_at, meta
       FROM audit_log WHERE company_id=? AND (actor_type='portal' OR event_type LIKE 'portal_%')
       ORDER BY created_at DESC LIMIT 100`
    ).bind(c.var.companyId as string).all()).results || []
    return c.json({ ok: true, data: rows })
  })

  // ══ PORTAL PAGES (light, brand-aware, mobile-first) ═══════════════════════

  app.get('/portal/login', (c) => c.html(portalAuthPage('login')))
  app.get('/portal/accept/:token', (c) => c.html(portalAuthPage('accept', c.req.param('token'))))
  app.get('/portal/reset/:token', (c) => c.html(portalAuthPage('reset', c.req.param('token'))))
  app.get('/portal/forgot', (c) => c.html(portalAuthPage('forgot')))
  app.get('/portal/home', (c) => c.html(portalShellPage()))
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE TEMPLATES
// ═══════════════════════════════════════════════════════════════════════════
const PORTAL_BASE_CSS = `
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--brand:#2D7A55;--ink:#1F2A2B;--muted:#6B7280;--line:#E5E9E7;--bg:#F6F8F7;--card:#FFFFFF;--danger:#B4423A}
  body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--ink);min-height:100vh;-webkit-font-smoothing:antialiased}
  a{color:var(--brand)}
  .gwp-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--brand);color:#fff;border:none;font-weight:700;font-size:14px;padding:12px 24px;border-radius:9px;cursor:pointer;width:100%;transition:opacity .15s}
  .gwp-btn:hover{opacity:.92}
  .gwp-btn:disabled{opacity:.5;cursor:default}
  .gwp-input{width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:9px;font-size:15px;font-family:inherit;background:#fff;color:var(--ink)}
  .gwp-input:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px rgba(45,122,85,.12)}
  .gwp-label{display:block;font-size:12.5px;font-weight:600;color:var(--muted);margin:14px 0 5px;letter-spacing:.2px}
  .gwp-err{display:none;background:#FDF1F0;border:1px solid #F0CFCC;color:var(--danger);font-size:13px;padding:10px 13px;border-radius:8px;margin-top:14px}
  .gwp-ok{display:none;background:#EFF7F2;border:1px solid #CCE5D8;color:#1F5C40;font-size:13px;padding:10px 13px;border-radius:8px;margin-top:14px}
`

function portalAuthPage(mode: 'login' | 'accept' | 'reset' | 'forgot', token = ''): string {
  const tokenJs = JSON.stringify(token)
  const titles: Record<string, string> = { login: 'Sign In', accept: 'Activate Your Account', reset: 'Reset Password', forgot: 'Forgot Password' }
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${titles[mode]} — Client Portal</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>${PORTAL_BASE_CSS}
  body{display:flex;align-items:center;justify-content:center;padding:20px}
  .gwp-authcard{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:36px 30px;box-shadow:0 4px 24px rgba(31,42,43,.06)}
  .gwp-mark{text-align:center;font-size:13px;font-weight:800;letter-spacing:1.5px;color:var(--brand);margin-bottom:6px}
  .gwp-sub{text-align:center;font-size:12px;color:var(--muted);margin-bottom:24px}
  h1{font-size:20px;font-weight:800;text-align:center;margin-bottom:4px}
  .gwp-intro{font-size:13.5px;color:var(--muted);text-align:center;line-height:1.55;margin-bottom:8px}
  .gwp-foot{text-align:center;font-size:13px;color:var(--muted);margin-top:20px}
  .gwp-foot a{font-weight:600;text-decoration:none}
</style></head>
<body>
<main class="gwp-authcard" id="auth-card">
  <div class="gwp-mark">CLIENT PORTAL</div>
  <div class="gwp-sub" id="company-name">&nbsp;</div>
  <h1 id="page-title">${titles[mode]}</h1>
  <p class="gwp-intro" id="page-intro"></p>
  <form id="auth-form" novalidate></form>
  <div class="gwp-err" id="msg-err"></div>
  <div class="gwp-ok" id="msg-ok"></div>
  <div class="gwp-foot" id="page-foot"></div>
</main>
<script>
(function(){
  var MODE=${JSON.stringify(mode)}, TOKEN=${tokenJs};
  var form=document.getElementById('auth-form'), errEl=document.getElementById('msg-err'), okEl=document.getElementById('msg-ok');
  var intro=document.getElementById('page-intro'), foot=document.getElementById('page-foot');
  function showErr(m){errEl.textContent=m;errEl.style.display='block';okEl.style.display='none'}
  function showOk(m){okEl.textContent=m;okEl.style.display='block';errEl.style.display='none'}
  function field(label,type,id,ph){return '<label class="gwp-label" for="'+id+'">'+label+'</label><input class="gwp-input" type="'+type+'" id="'+id+'" placeholder="'+(ph||'')+'" autocomplete="'+(type==='password'?'new-password':type==='email'?'email':'off')+'">'}
  async function post(url,body){var r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(body)});var d=await r.json().catch(function(){return{}});if(!r.ok)throw new Error(d.error||'Something went wrong');return d}

  if(MODE==='login'){
    form.innerHTML=field('Email','email','f-email','you@example.com')+field('Password','password','f-pass')+'<div style="height:20px"></div><button class="gwp-btn" type="submit">Sign In</button>';
    document.getElementById('f-pass').setAttribute('autocomplete','current-password');
    foot.innerHTML='<a href="/portal/forgot">Forgot your password?</a>';
    form.onsubmit=async function(e){e.preventDefault();var btn=form.querySelector('button');btn.disabled=true;
      try{await post('/api/portal/auth/login',{email:document.getElementById('f-email').value.trim(),password:document.getElementById('f-pass').value});location.href='/portal/home'}
      catch(err){showErr(err.message);btn.disabled=false}};
  }

  if(MODE==='forgot'){
    intro.textContent='Enter your email and we will send you a reset link if an account exists.';
    form.innerHTML=field('Email','email','f-email','you@example.com')+'<div style="height:20px"></div><button class="gwp-btn" type="submit">Send Reset Link</button>';
    foot.innerHTML='<a href="/portal/login">Back to sign in</a>';
    form.onsubmit=async function(e){e.preventDefault();var btn=form.querySelector('button');btn.disabled=true;
      try{await post('/api/portal/auth/request-reset',{email:document.getElementById('f-email').value.trim()});showOk('If an account exists for that email, a reset link is on its way.');form.style.display='none'}
      catch(err){showErr(err.message);btn.disabled=false}};
  }

  if(MODE==='accept'){
    intro.textContent='Loading your invitation...';
    fetch('/api/portal/auth/invite-info/'+encodeURIComponent(TOKEN)).then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d}})}).then(function(res){
      if(!res.ok){intro.textContent='';showErr(res.d.error||'This invitation link is invalid or has already been used.');foot.innerHTML='<a href="/portal/login">Go to sign in</a>';return}
      if(res.d.expired){intro.textContent='';showErr('This invitation has expired. Ask your service provider to send a new one.');return}
      document.getElementById('company-name').textContent=res.d.company||'';
      intro.textContent='Welcome, '+(res.d.name||'')+'. Choose a password to activate your account for '+(res.d.email||'')+'.';
      form.innerHTML=field('Password (min 8 characters)','password','f-pass')+field('Confirm password','password','f-pass2')+'<div style="height:20px"></div><button class="gwp-btn" type="submit">Activate Account</button>';
      form.onsubmit=async function(e){e.preventDefault();
        var p1=document.getElementById('f-pass').value,p2=document.getElementById('f-pass2').value;
        if(p1.length<8)return showErr('Password must be at least 8 characters');
        if(p1!==p2)return showErr('Passwords do not match');
        var btn=form.querySelector('button');btn.disabled=true;
        try{await post('/api/portal/auth/accept-invite',{token:TOKEN,password:p1});showOk('Account activated. Redirecting to sign in...');setTimeout(function(){location.href='/portal/login'},1400)}
        catch(err){showErr(err.message);btn.disabled=false}};
    }).catch(function(){intro.textContent='';showErr('Could not load invitation. Try again.')});
  }

  if(MODE==='reset'){
    intro.textContent='Choose a new password for your account.';
    form.innerHTML=field('New password (min 8 characters)','password','f-pass')+field('Confirm password','password','f-pass2')+'<div style="height:20px"></div><button class="gwp-btn" type="submit">Set New Password</button>';
    foot.innerHTML='<a href="/portal/login">Back to sign in</a>';
    form.onsubmit=async function(e){e.preventDefault();
      var p1=document.getElementById('f-pass').value,p2=document.getElementById('f-pass2').value;
      if(p1.length<8)return showErr('Password must be at least 8 characters');
      if(p1!==p2)return showErr('Passwords do not match');
      var btn=form.querySelector('button');btn.disabled=true;
      try{await post('/api/portal/auth/reset',{token:TOKEN,password:p1});showOk('Password updated. Redirecting to sign in...');setTimeout(function(){location.href='/portal/login'},1400)}
      catch(err){showErr(err.message);btn.disabled=false}};
  }
})();
</script>
</body></html>`
}

function portalShellPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Client Portal</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>${PORTAL_BASE_CSS}
  .gwp-topbar{background:#fff;border-bottom:1px solid var(--line);padding:0 20px;height:60px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:20}
  .gwp-brand{display:flex;align-items:center;gap:11px;min-width:0}
  .gwp-brand img{height:34px;width:auto;max-width:120px;object-fit:contain}
  .gwp-brand .co{font-size:15px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .gwp-user{display:flex;align-items:center;gap:12px}
  .gwp-user .un{font-size:13px;font-weight:600;color:var(--muted);display:none}
  @media(min-width:600px){.gwp-user .un{display:block}}
  .gwp-logout{background:none;border:1px solid var(--line);border-radius:8px;font-size:12.5px;font-weight:600;color:var(--muted);padding:7px 14px;cursor:pointer;font-family:inherit}
  .gwp-logout:hover{border-color:var(--brand);color:var(--brand)}
  .gwp-preview-bar{background:#1F2A2B;color:#fff;font-size:12.5px;font-weight:600;padding:9px 20px;display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;text-align:center;position:sticky;top:60px;z-index:19}
  .gwp-preview-bar b{color:#F2C879}
  .gwp-preview-bar button{background:rgba(255,255,255,.14);color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:7px;font-size:12px;font-weight:700;padding:5px 12px;cursor:pointer;font-family:inherit}
  .gwp-preview-bar button:hover{background:rgba(255,255,255,.24)}
  .gwp-layout{display:flex;max-width:1160px;margin:0 auto;min-height:calc(100vh - 60px)}
  .gwp-nav{width:210px;flex-shrink:0;padding:24px 14px;display:none;flex-direction:column;gap:2px}
  @media(min-width:820px){.gwp-nav{display:flex}}
  .gwp-nav a{display:flex;align-items:center;gap:10px;padding:10px 13px;border-radius:9px;font-size:14px;font-weight:600;color:var(--muted);text-decoration:none}
  .gwp-nav a.active{background:rgba(45,122,85,.09);color:var(--brand)}
  .gwp-nav a:hover:not(.active){background:rgba(31,42,43,.04)}
  .gwp-main{flex:1;padding:26px 20px 90px;min-width:0}
  .gwp-tabbar{position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid var(--line);display:flex;z-index:20}
  @media(min-width:820px){.gwp-tabbar{display:none}}
  .gwp-tabbar a{flex:1;text-align:center;padding:10px 2px 12px;font-size:10.5px;font-weight:600;color:var(--muted);text-decoration:none}
  .gwp-tabbar a.active{color:var(--brand)}
  .gwp-tabbar svg{display:block;margin:0 auto 3px}
  h2.gwp-h{font-size:21px;font-weight:800;margin-bottom:4px}
  .gwp-hs{font-size:13.5px;color:var(--muted);margin-bottom:22px}
  .gwp-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin-bottom:26px}
  .gwp-card{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:18px 20px}
  .gwp-card .k{font-size:12px;font-weight:600;color:var(--muted);letter-spacing:.3px;text-transform:uppercase;margin-bottom:8px}
  .gwp-card .v{font-size:24px;font-weight:800}
  .gwp-card .v.warn{color:var(--danger)}
  .gwp-card .s{font-size:12px;color:var(--muted);margin-top:5px}
  .gwp-empty{background:var(--card);border:1px dashed var(--line);border-radius:13px;padding:34px 24px;text-align:center;color:var(--muted);font-size:14px;line-height:1.6}
  .gwp-section{margin-bottom:30px}
  .gwp-props{display:flex;flex-direction:column;gap:10px}
  .gwp-prop{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:14px 17px;display:flex;justify-content:space-between;align-items:center;gap:12px}
  .gwp-prop .pl{font-size:14px;font-weight:700}
  .gwp-prop .pa{font-size:12.5px;color:var(--muted);margin-top:2px}
  .gwp-pill{font-size:11px;font-weight:700;color:var(--brand);background:rgba(45,122,85,.1);border-radius:20px;padding:4px 11px;white-space:nowrap}
  .gwp-form-card{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:22px;max-width:480px}
  .gwp-form-card h3{font-size:15px;font-weight:800;margin-bottom:4px}
  .gwp-form-card .hint{font-size:12.5px;color:var(--muted);margin-bottom:8px}
  .gwp-loading{display:flex;align-items:center;justify-content:center;min-height:60vh;color:var(--muted);font-size:13px;flex-direction:column;gap:14px}
  .gwp-spin{width:30px;height:30px;border:2.5px solid var(--line);border-top-color:var(--brand);border-radius:50%;animation:gsp .8s linear infinite}
  @keyframes gsp{to{transform:rotate(360deg)}}
  .gwp-list{display:flex;flex-direction:column;gap:10px}
  .gwp-item{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:15px 18px;display:flex;justify-content:space-between;align-items:center;gap:14px;cursor:pointer;transition:border-color .12s}
  .gwp-item:hover{border-color:var(--brand)}
  .gwp-item .it{font-size:14px;font-weight:700}
  .gwp-item .is{font-size:12.5px;color:var(--muted);margin-top:3px}
  .gwp-item .ir{text-align:right;flex-shrink:0}
  .gwp-item .iv{font-size:15px;font-weight:800}
  .gwp-status{display:inline-block;font-size:10.5px;font-weight:700;border-radius:20px;padding:3px 10px;letter-spacing:.3px;text-transform:uppercase}
  .st-sent,.st-viewed{background:rgba(77,138,186,.12);color:#3B72A0}
  .st-approved,.st-accepted,.st-paid{background:rgba(45,122,85,.12);color:var(--brand)}
  .st-declined,.st-overdue{background:rgba(180,66,58,.1);color:var(--danger)}
  .st-partial{background:rgba(216,158,58,.14);color:#9A6D1D}
  .st-scheduled{background:rgba(77,138,186,.12);color:#3B72A0}
  .st-in_progress{background:rgba(216,158,58,.14);color:#9A6D1D}
  .st-completed{background:rgba(45,122,85,.12);color:var(--brand)}
  .gwp-update{border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:14px;background:#fff}
  .gwp-update .ud{font-size:11.5px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--brand);margin-bottom:5px}
  .gwp-update .ut{font-size:14.5px;font-weight:700;margin-bottom:5px}
  .gwp-update .ub{font-size:13.5px;line-height:1.65;color:var(--ink);white-space:pre-wrap}
  .gwp-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;margin-top:12px}
  .gwp-gallery a{display:block;border-radius:9px;overflow:hidden;border:1px solid var(--line);aspect-ratio:1;background:var(--bg)}
  .gwp-gallery img{width:100%;height:100%;object-fit:cover;display:block}
  .gwp-lightbox{position:fixed;inset:0;background:rgba(15,23,20,.92);z-index:200;display:flex;align-items:center;justify-content:center;padding:24px;cursor:zoom-out}
  .gwp-lightbox img{max-width:100%;max-height:88vh;border-radius:10px}
  .gwp-lightbox .cap{position:absolute;bottom:18px;left:0;right:0;text-align:center;color:#fff;font-size:13px;padding:0 24px}
  .gwp-proj-meta{display:flex;flex-wrap:wrap;gap:14px;font-size:13px;color:var(--muted);margin-top:10px}
  .gwp-proj-meta strong{color:var(--ink);font-weight:700}
  .gwp-tabbar{padding-bottom:env(safe-area-inset-bottom,0)}
  .gwp-item>div:first-child{min-width:0}
  .gwp-item .it,.gwp-item .is{overflow:hidden;text-overflow:ellipsis}
  .gwp-lines-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
  @media(max-width:640px){
    .gwp-main{padding:20px 14px 96px}
    .gwp-detail{padding:18px 16px}
    .gwp-cards{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
    .gwp-card{padding:14px 15px}
    .gwp-card .v{font-size:20px}
    .gwp-item{padding:13px 14px;gap:10px}
    .gwp-actions .gwp-btn,.gwp-actions .gwp-btn-ghost{flex:1;min-width:0}
    .gwp-gallery{grid-template-columns:repeat(auto-fill,minmax(88px,1fr))}
    h2.gwp-h{font-size:19px}
  }
  .gwp-back{display:inline-flex;align-items:center;gap:7px;background:none;border:none;color:var(--muted);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;padding:0;margin-bottom:16px}
  .gwp-back:hover{color:var(--brand)}
  .gwp-detail{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:26px;max-width:760px}
  .gwp-detail-head{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;margin-bottom:6px}
  .gwp-detail h3{font-size:18px;font-weight:800}
  .gwp-detail .dnum{font-size:12.5px;color:var(--muted);margin-top:3px}
  .gwp-lines{width:100%;border-collapse:collapse;margin:18px 0 8px;font-size:13.5px}
  .gwp-lines th{text-align:left;font-size:11px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--muted);padding:8px 10px;border-bottom:1px solid var(--line)}
  .gwp-lines td{padding:10px;border-bottom:1px solid var(--line);vertical-align:top}
  .gwp-lines .num{text-align:right;white-space:nowrap}
  .gwp-totals{margin-left:auto;max-width:280px;font-size:13.5px;margin-top:12px}
  .gwp-totals div{display:flex;justify-content:space-between;padding:5px 10px}
  .gwp-totals .tt{font-weight:800;font-size:15px;border-top:2px solid var(--ink);margin-top:4px;padding-top:9px}
  .gwp-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px}
  .gwp-btn-ghost{display:inline-flex;align-items:center;justify-content:center;background:#fff;color:var(--danger);border:1px solid var(--line);font-weight:700;font-size:14px;padding:12px 24px;border-radius:9px;cursor:pointer;font-family:inherit}
  .gwp-btn-ghost:hover{border-color:var(--danger)}
  .gwp-note{background:var(--bg);border-radius:9px;padding:12px 15px;font-size:13px;line-height:1.6;color:var(--ink);margin-top:14px;white-space:pre-wrap}
  .gwp-banner-ok{background:rgba(45,122,85,.08);border:1px solid rgba(45,122,85,.25);color:var(--brand);font-size:13.5px;font-weight:600;padding:12px 16px;border-radius:10px;margin-bottom:18px}
  .gwp-banner-warn{background:rgba(180,66,58,.06);border:1px solid rgba(180,66,58,.2);color:var(--danger);font-size:13.5px;font-weight:600;padding:12px 16px;border-radius:10px;margin-bottom:18px}
  textarea.gwp-input{min-height:90px;resize:vertical}
  .gwp-tabs{display:flex;gap:6px;margin-bottom:18px;border-bottom:1px solid var(--line)}
  .gwp-tab{background:none;border:none;font-family:inherit;font-size:13.5px;font-weight:700;color:var(--muted);padding:9px 14px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
  .gwp-tab.active{color:var(--brand);border-bottom-color:var(--brand)}
  .gw-rt-view p{margin:0 0 8px}.gw-rt-view ul,.gw-rt-view ol{margin:4px 0 10px;padding-left:22px}.gw-rt-view li{margin:2px 0}.gw-rt-view h1,.gw-rt-view h2,.gw-rt-view h3,.gw-rt-view h4{margin:10px 0 6px;line-height:1.3;font-size:1.05em}
</style></head>
<body>
<div id="portal-root"><div class="gwp-loading"><div class="gwp-spin"></div>Loading your portal...</div></div>
<script>
(function(){
  var ME=null, VIEW='home';
  var root=document.getElementById('portal-root');
  var money=function(n){return '$'+(Number(n)||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})};
  var esc=function(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')};
  // Terms/notes may be legacy plain text OR sanitized HTML from the staff rich editor.
  var rich=function(v){
    v=String(v==null?'':v);
    if(!v)return '';
    if(!/<[a-z][^>]*>/i.test(v))return esc(v).replace(/\\n/g,'<br>');
    var ALLOWED=['p','div','br','b','strong','i','em','u','s','strike','ul','ol','li','h1','h2','h3','h4','blockquote'];
    var d=document.createElement('div');d.innerHTML=v;
    var bad=d.querySelectorAll('script,style,iframe,object,embed,form,link,meta,svg,img,video,audio,input,button,textarea,select');
    for(var i=0;i<bad.length;i++)bad[i].parentNode.removeChild(bad[i]);
    var walk=function(node){
      var kids=[].slice.call(node.childNodes);
      for(var j=0;j<kids.length;j++){
        var ch=kids[j];
        if(ch.nodeType===8){node.removeChild(ch);continue}
        if(ch.nodeType!==1)continue;
        walk(ch);
        if(ALLOWED.indexOf(ch.tagName.toLowerCase())<0){
          while(ch.firstChild)node.insertBefore(ch.firstChild,ch);
          node.removeChild(ch);
        }else{
          var atts=[].slice.call(ch.attributes||[]);
          for(var k=0;k<atts.length;k++)ch.removeAttribute(atts[k].name);
        }
      }
    };
    walk(d);
    return d.innerHTML;
  };
  var NAV=[
    {id:'home',label:'Home'},
    {id:'projects',label:'Projects'},
    {id:'estimates',label:'Estimates'},
    {id:'billing',label:'Billing'},
    {id:'documents',label:'Documents'},
    {id:'account',label:'Account'}
  ];
  var ICONS={
    home:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    projects:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>',
    estimates:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    billing:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>',
    documents:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    account:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
  };
  function api(url,opts){opts=opts||{};opts.credentials='same-origin';if(opts.body){opts.headers={'Content-Type':'application/json'};opts.body=JSON.stringify(opts.body)}
    return fetch(url,opts).then(function(r){if(r.status===401){location.href='/portal/login';throw new Error('unauthorized')}return r.json()})}
  function navHtml(cls){return NAV.filter(function(n){return !(ME&&ME.preview&&n.id==='account')}).map(function(n){return '<a href="#'+n.id+'" class="'+(VIEW===n.id?'active':'')+'" data-v="'+n.id+'">'+ICONS[n.id]+'<span>'+n.label+'</span></a>'}).join('')}
  function shell(inner){
    var brand=ME.company||{};
    document.documentElement.style.setProperty('--brand',brand.brand_color||'#2D7A55');
    root.innerHTML=
      '<header class="gwp-topbar"><div class="gwp-brand">'+(brand.logo_url?'<img src="'+esc(brand.logo_url)+'" alt="">':'')+'<span class="co">'+esc(brand.name||'Client Portal')+'</span></div>'+
      '<div class="gwp-user"><span class="un">'+esc(ME.user.name)+'</span><button class="gwp-logout" id="btn-logout">Sign Out</button></div></header>'+
      (ME.preview?'<div class="gwp-preview-bar"><span><b>Staff Preview</b> &mdash; read-only view. Payment details are hidden and no actions will be sent to the client.</span><button id="btn-exit-preview">Exit Preview</button></div>':'')+
      '<div class="gwp-layout"><nav class="gwp-nav" id="side-nav">'+navHtml()+'</nav>'+
      '<main class="gwp-main" id="view-main">'+inner+'</main></div>'+
      '<nav class="gwp-tabbar" id="tab-nav">'+navHtml()+'</nav>';
    document.getElementById('btn-logout').onclick=function(){api('/api/portal/auth/logout',{method:'POST'}).then(function(){location.href='/portal/login'})};
    var exitBtn=document.getElementById('btn-exit-preview');
    if(exitBtn)exitBtn.onclick=function(){api('/api/portal/auth/logout',{method:'POST'}).then(function(){window.close();setTimeout(function(){location.href='/'},250)})};
  }
  function comingSoon(title,desc){return '<h2 class="gwp-h">'+title+'</h2><p class="gwp-hs">'+desc+'</p><div class="gwp-empty">This section is being rolled out. Check back soon — your '+title.toLowerCase()+' will appear here.</div>'}
  function can(p){return (ME.memberships||[]).some(function(m){return m.permissions&&m.permissions[p]})}

  function renderHome(){
    api('/api/portal/dashboard').then(function(d){
      var cds=d.cards||{};var cards='';
      if(cds.active_projects!==null&&cds.active_projects!==undefined)cards+='<div class="gwp-card" data-goto="projects" style="cursor:pointer"><div class="k">Active Projects</div><div class="v">'+cds.active_projects+'</div></div>';
      if(cds.estimates_awaiting!==null&&cds.estimates_awaiting!==undefined)cards+='<div class="gwp-card"><div class="k">Estimates Awaiting Review</div><div class="v">'+cds.estimates_awaiting+'</div></div>';
      if(cds.open_balance!==null&&cds.open_balance!==undefined)cards+='<div class="gwp-card"><div class="k">Open Balance</div><div class="v">'+money(cds.open_balance)+'</div></div>';
      if(cds.overdue_balance)cards+='<div class="gwp-card"><div class="k">Overdue</div><div class="v warn">'+money(cds.overdue_balance)+'</div></div>';
      if(cds.last_payment)cards+='<div class="gwp-card"><div class="k">Last Payment</div><div class="v">'+money(cds.last_payment.amount)+'</div><div class="s">'+esc((cds.last_payment.date||'').slice(0,10))+'</div></div>';
      if(!cards)cards='<div class="gwp-empty" style="grid-column:1/-1">Nothing needs your attention right now.</div>';
      var props=(ME.properties||[]).map(function(p){
        var addr=[p.street,p.city,p.state].filter(Boolean).join(', ');
        return '<div class="gwp-prop"><div><div class="pl">'+esc(p.label||addr||'Property')+'</div><div class="pa">'+esc(addr)+'</div></div>'+(p.is_primary?'<span class="gwp-pill">Primary</span>':'')+'</div>'}).join('');
      shell('<h2 class="gwp-h">Welcome back, '+esc((ME.user.name||'').split(' ')[0])+'</h2><p class="gwp-hs">Here is what needs your attention.</p>'+
        '<div class="gwp-cards">'+cards+'</div>'+
        (props?'<section class="gwp-section"><h2 class="gwp-h" style="font-size:16px">Your Properties</h2><p class="gwp-hs">Service locations on your account.</p><div class="gwp-props">'+props+'</div></section>':''));
      bindNav();
      Array.prototype.forEach.call(document.querySelectorAll('[data-goto]'),function(el){el.onclick=function(){VIEW=el.getAttribute('data-goto');history.replaceState(null,'','#'+VIEW);render()}});
    })
  }
  function renderAccount(){
    shell('<h2 class="gwp-h">Account</h2><p class="gwp-hs">Manage your profile and password.</p>'+
      '<div class="gwp-section"><div class="gwp-form-card"><h3>Profile</h3>'+
      '<label class="gwp-label">Name</label><input class="gwp-input" id="ac-name" value="'+esc(ME.user.name)+'">'+
      '<label class="gwp-label">Email</label><input class="gwp-input" value="'+esc(ME.user.email)+'" disabled style="background:var(--bg);color:var(--muted)">'+
      '<label class="gwp-label">Phone</label><input class="gwp-input" id="ac-phone" value="'+esc(ME.user.phone||'')+'">'+
      '<div style="height:16px"></div><button class="gwp-btn" id="ac-save" style="width:auto;padding:10px 22px">Save Profile</button>'+
      '<div class="gwp-ok" id="ac-ok"></div><div class="gwp-err" id="ac-err"></div></div></div>'+
      '<div class="gwp-section"><div class="gwp-form-card"><h3>Change Password</h3><p class="hint">Minimum 8 characters.</p>'+
      '<label class="gwp-label">Current password</label><input class="gwp-input" type="password" id="pw-cur" autocomplete="current-password">'+
      '<label class="gwp-label">New password</label><input class="gwp-input" type="password" id="pw-new" autocomplete="new-password">'+
      '<div style="height:16px"></div><button class="gwp-btn" id="pw-save" style="width:auto;padding:10px 22px">Update Password</button>'+
      '<div class="gwp-ok" id="pw-ok"></div><div class="gwp-err" id="pw-err"></div></div></div>'+
      (can('manage_contacts')?'<div class="gwp-section"><div class="gwp-form-card"><h3>Contacts</h3><p class="hint">People on your account your contractor may reach out to.</p><div id="ct-list"><div class="gwp-empty">Loading...</div></div><div style="height:12px"></div><button class="gwp-btn-ghost" id="ct-add" style="width:auto;padding:9px 18px">Add Contact</button><div id="ct-form" style="display:none;margin-top:14px"></div><div class="gwp-ok" id="ct-ok"></div><div class="gwp-err" id="ct-err"></div></div></div>':''));
    bindNav();
    if(can('manage_contacts'))initContacts();
    function flash(id,m){var el=document.getElementById(id);el.textContent=m;el.style.display='block';setTimeout(function(){el.style.display='none'},3500)}
    document.getElementById('ac-save').onclick=function(){
      api('/api/portal/account',{method:'PUT',body:{name:document.getElementById('ac-name').value,phone:document.getElementById('ac-phone').value}})
        .then(function(d){if(d.error)return flash('ac-err',d.error);ME.user.name=document.getElementById('ac-name').value;flash('ac-ok','Profile saved')})};
    document.getElementById('pw-save').onclick=function(){
      api('/api/portal/account',{method:'PUT',body:{current_password:document.getElementById('pw-cur').value,new_password:document.getElementById('pw-new').value}})
        .then(function(d){if(d.error)return flash('pw-err',d.error);document.getElementById('pw-cur').value='';document.getElementById('pw-new').value='';flash('pw-ok','Password updated')})};
    function initContacts(){
      function cflash(id,m){flash(id,m)}
      function ctForm(existing){
        var f=document.getElementById('ct-form');var e=existing||{};
        f.style.display='block';
        f.innerHTML='<label class="gwp-label">Name</label><input class="gwp-input" id="cf-name" value="'+esc(e.name||'')+'">'+
          '<label class="gwp-label">Email</label><input class="gwp-input" id="cf-email" type="email" value="'+esc(e.email||'')+'">'+
          '<label class="gwp-label">Phone</label><input class="gwp-input" id="cf-phone" value="'+esc(e.phone||'')+'">'+
          '<label class="gwp-label">Role / Title (optional)</label><input class="gwp-input" id="cf-title" value="'+esc(e.title||'')+'" placeholder="e.g. Property Manager">'+
          '<div style="height:12px"></div><button class="gwp-btn" id="cf-save" style="width:auto;padding:9px 20px">'+(e.id?'Save Changes':'Add Contact')+'</button> <button class="gwp-btn-ghost" id="cf-cancel" style="padding:9px 16px">Cancel</button>';
        document.getElementById('cf-cancel').onclick=function(){f.style.display='none';f.innerHTML=''};
        document.getElementById('cf-save').onclick=function(){
          var body={name:document.getElementById('cf-name').value,email:document.getElementById('cf-email').value,phone:document.getElementById('cf-phone').value,title:document.getElementById('cf-title').value};
          this.disabled=true;var btn=this;
          api(e.id?'/api/portal/contacts/'+e.id:'/api/portal/contacts',{method:e.id?'PUT':'POST',body:body}).then(function(x){
            btn.disabled=false;
            if(x.error)return cflash('ct-err',x.error);
            f.style.display='none';f.innerHTML='';cflash('ct-ok',e.id?'Contact updated':'Contact added');loadContacts()})};
      }
      var CTS=[];
      function loadContacts(){
        api('/api/portal/contacts').then(function(d){
          var list=document.getElementById('ct-list');if(!list)return;
          CTS=d.data||[];
          list.innerHTML=CTS.length?'<div class="gwp-list">'+CTS.map(function(ct){
            return '<div class="gwp-item" style="cursor:default"><div><div class="it">'+esc(ct.name)+(ct.is_primary?' <span class="gwp-status" style="background:var(--bg);color:var(--muted);margin-left:6px">Primary</span>':'')+'</div><div class="is">'+esc([ct.title,ct.email,ct.phone].filter(Boolean).join(' · '))+'</div></div>'+
              '<div class="ir"><button class="gwp-btn-ghost" data-ct-edit="'+esc(ct.id)+'" style="padding:6px 12px;font-size:12px">Edit</button> <button class="gwp-btn-ghost" data-ct-del="'+esc(ct.id)+'" style="padding:6px 12px;font-size:12px">Remove</button></div></div>'}).join('')+'</div>'
            :'<div class="gwp-empty">No contacts yet.</div>';
          Array.prototype.forEach.call(list.querySelectorAll('[data-ct-edit]'),function(b){b.onclick=function(){
            var ct=CTS.find(function(x){return x.id===b.getAttribute('data-ct-edit')});if(ct)ctForm(ct)}});
          Array.prototype.forEach.call(list.querySelectorAll('[data-ct-del]'),function(b){b.onclick=function(){
            if(!confirm('Remove this contact?'))return;
            api('/api/portal/contacts/'+b.getAttribute('data-ct-del'),{method:'DELETE'}).then(function(x){
              if(x.error)return cflash('ct-err',x.error);
              cflash('ct-ok','Contact removed');loadContacts()})}});
        }).catch(function(){});
      }
      document.getElementById('ct-add').onclick=function(){ctForm(null)};
      loadContacts();
    }
  }
  var fmtD=function(s){if(!s)return '';var d=new Date(String(s).replace(' ','T'));return isNaN(d)?String(s).slice(0,10):d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})};
  var stPill=function(st){var lbl={sent:'Awaiting Review',viewed:'Awaiting Review',approved:'Approved',accepted:'Accepted',declined:'Declined',paid:'Paid',partial:'Partially Paid',overdue:'Overdue'}[st]||st;return '<span class="gwp-status st-'+esc(st)+'">'+esc(lbl)+'</span>'};
  var propLabel=function(pid){var p=(ME.properties||[]).find(function(x){return x.id===pid});if(!p)return '';return p.label||[p.street,p.city].filter(Boolean).join(', ')};

  // ── Estimates ──────────────────────────────────────────────────────────
  function renderEstimates(){
    if(!can('view_estimates')){shell('<h2 class="gwp-h">Estimates</h2><div class="gwp-empty">Your account does not include access to estimates.</div>');bindNav();return}
    api('/api/portal/estimates').then(function(d){
      var rows=d.data||[];
      var awaiting=rows.filter(function(r){return r.status==='sent'||r.status==='viewed'});
      var others=rows.filter(function(r){return r.status!=='sent'&&r.status!=='viewed'});
      function itemHtml(r){
        var pl=propLabel(r.property_id);
        return '<div class="gwp-item" data-est="'+esc(r.id)+'"><div><div class="it">'+esc(r.title||('Estimate '+(r.est_number||'')))+'</div>'+
          '<div class="is">'+esc(r.est_number||'')+(pl?' &middot; '+esc(pl):'')+' &middot; '+fmtD(r.estimate_date||r.created_at)+'</div></div>'+
          '<div class="ir"><div class="iv">'+money(r.total)+'</div><div style="margin-top:5px">'+stPill(r.status)+'</div></div></div>'}
      shell('<h2 class="gwp-h">Estimates</h2><p class="gwp-hs">Review and respond to estimates from your contractor.</p>'+
        (awaiting.length?'<section class="gwp-section"><h2 class="gwp-h" style="font-size:15px">Awaiting Your Review ('+awaiting.length+')</h2><div style="height:10px"></div><div class="gwp-list">'+awaiting.map(itemHtml).join('')+'</div></section>':'')+
        (others.length?'<section class="gwp-section"><h2 class="gwp-h" style="font-size:15px">History</h2><div style="height:10px"></div><div class="gwp-list">'+others.map(itemHtml).join('')+'</div></section>':'')+
        (!rows.length?'<div class="gwp-empty">No estimates yet. When your contractor sends one, it will appear here.</div>':''));
      bindNav();
      Array.prototype.forEach.call(document.querySelectorAll('[data-est]'),function(el){el.onclick=function(){renderEstimateDetail(el.getAttribute('data-est'))}});
    })
  }
  function renderEstimateDetail(id){
    api('/api/portal/estimates/'+id).then(function(d){
      if(d.error){renderEstimates();return}
      var r=d.data;var lines=[];try{lines=JSON.parse(r.line_items||'[]')}catch(_){}
      var canApprove=can('approve_estimates')&&(r.status==='sent'||r.status==='viewed');
      var lineRows=lines.map(function(l){
        var qty=l.qty||l.quantity||1,price=l.price||l.unit_price||l.rate||0,amt=l.amount!=null?l.amount:qty*price;
        return '<tr><td>'+esc(l.name||l.description||l.item||'')+(l.description&&l.name?'<div style="font-size:12px;color:var(--muted);margin-top:2px">'+esc(l.description)+'</div>':'')+'</td><td class="num">'+esc(qty)+'</td><td class="num">'+money(price)+'</td><td class="num">'+money(amt)+'</td></tr>'}).join('');
      var banner='';
      if(r.status==='approved'||r.status==='accepted')banner='<div class="gwp-banner-ok">You approved this estimate'+(r.accepted_at?' on '+fmtD(r.accepted_at):'')+'. Your contractor will follow up on scheduling.</div>';
      if(r.status==='declined')banner='<div class="gwp-banner-warn">You declined this estimate'+(r.declined_at?' on '+fmtD(r.declined_at):'')+'.</div>';
      shell('<button class="gwp-back" id="est-back">&larr; Back to estimates</button>'+banner+
        '<div class="gwp-detail"><div class="gwp-detail-head"><div><h3>'+esc(r.title||'Estimate')+'</h3><div class="dnum">'+esc(r.est_number||'')+' &middot; '+fmtD(r.estimate_date||r.created_at)+(r.expiry_date?' &middot; Valid through '+fmtD(r.expiry_date):'')+'</div></div>'+stPill(r.status)+'</div>'+
        (r.scope_of_work?'<div class="gwp-note">'+esc(r.scope_of_work)+'</div>':'')+
        (lineRows?'<div class="gwp-lines-wrap"><table class="gwp-lines"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead><tbody>'+lineRows+'</tbody></table></div>':'')+
        '<div class="gwp-totals">'+
        (r.subtotal&&r.subtotal!==r.total?'<div><span>Subtotal</span><span>'+money(r.subtotal)+'</span></div>':'')+
        (r.discount_amt?'<div><span>Discount</span><span>-'+money(r.discount_amt)+'</span></div>':'')+
        (r.tax_amt?'<div><span>Tax</span><span>'+money(r.tax_amt)+'</span></div>':'')+
        '<div class="tt"><span>Total</span><span>'+money(r.total)+'</span></div>'+
        (r.deposit_amt?'<div><span>Deposit due</span><span>'+money(r.deposit_amt)+(r.deposit_paid?' (paid)':'')+'</span></div>':'')+
        '</div>'+
        (r.customer_notes?'<div class="gwp-note">'+esc(r.customer_notes)+'</div>':'')+
        (r.terms?'<div class="gw-rt-view" style="font-size:11.5px;color:var(--muted);margin-top:16px;line-height:1.6">'+rich(r.terms)+'</div>':'')+
        (canApprove?'<div class="gwp-actions"><button class="gwp-btn" id="est-approve" style="width:auto">Approve Estimate</button><button class="gwp-btn-ghost" id="est-decline">Decline / Request Changes</button></div><div id="est-decline-box" style="display:none;margin-top:14px"><label class="gwp-label">Tell us what you would like changed (optional)</label><textarea class="gwp-input" id="est-reason"></textarea><div style="height:10px"></div><button class="gwp-btn-ghost" id="est-decline-send">Send Response</button></div>':'')+
        (r.deposit_amt&&!r.deposit_paid&&can('make_payments')&&(r.status==='approved'||r.status==='accepted'||r.status==='invoiced')?'<div id="est-dep-box" style="margin-top:14px"></div>':'')+
        '<div class="gwp-err" id="est-err"></div></div>');
      bindNav();
      document.getElementById('est-back').onclick=function(){renderEstimates()};
      if(canApprove){
        var errEl=document.getElementById('est-err');
        document.getElementById('est-approve').onclick=function(){
          if(!confirm('Approve this estimate for '+money(r.total)+'?'))return;
          this.disabled=true;
          api('/api/portal/estimates/'+id+'/approve',{method:'POST'}).then(function(x){
            if(x.error){errEl.textContent=x.error;errEl.style.display='block';return}
            renderEstimateDetail(id)})};
        document.getElementById('est-decline').onclick=function(){document.getElementById('est-decline-box').style.display='block';this.style.display='none'};
        document.getElementById('est-decline-send').onclick=function(){
          this.disabled=true;
          api('/api/portal/estimates/'+id+'/decline',{method:'POST',body:{reason:document.getElementById('est-reason').value}}).then(function(x){
            if(x.error){errEl.textContent=x.error;errEl.style.display='block';return}
            renderEstimateDetail(id)})};
      }
      // Deposit payment (approved estimates with an unpaid deposit)
      var depBox=document.getElementById('est-dep-box');
      if(depBox){
        var derr=document.getElementById('est-err');
        function depFail(m){derr.textContent=m;derr.style.display='block'}
        api('/api/portal/payment-methods').then(function(pd){
          var pms=(pd&&pd.data)||[];
          depBox.innerHTML='<div style="padding:14px;border:1px solid var(--line);border-radius:10px"><div style="font-size:12px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--muted);margin-bottom:8px">Deposit due: '+money(r.deposit_amt)+'</div>'+
            (pms.length?'<select class="gwp-input" id="dep-pm-sel" style="margin-bottom:10px">'+pmOptions(pms,'')+'</select><button class="gwp-btn" id="dep-pay-saved" style="width:auto">Pay Deposit with Saved Method</button> ':'')+
            '<button class="'+(pms.length?'gwp-btn-ghost':'gwp-btn')+'" id="dep-pay-card" style="width:auto'+(pms.length?';margin-top:8px':'')+'">Pay Deposit by Card</button></div>';
          var sb=document.getElementById('dep-pay-saved');
          if(sb){sb.onclick=function(){
            var pm=document.getElementById('dep-pm-sel').value;if(!pm)return;
            if(!confirm('Pay the '+money(r.deposit_amt)+' deposit with the selected payment method?'))return;
            sb.disabled=true;sb.textContent='Processing...';
            api('/api/portal/estimates/'+id+'/pay-deposit',{method:'POST',body:{stripe_pm_id:pm}}).then(function(x){
              if(x.error){depFail(x.error);sb.disabled=false;sb.textContent='Pay Deposit with Saved Method';return}
              renderEstimateDetail(id)})};
          }
          var cb=document.getElementById('dep-pay-card');
          cb.onclick=function(){
            cb.disabled=true;cb.textContent='Opening secure checkout...';
            api('/api/portal/estimates/'+id+'/pay-deposit',{method:'POST',body:{}}).then(function(x){
              if(x.error){depFail(x.error);cb.disabled=false;cb.textContent='Pay Deposit by Card';return}
              location.href=x.url})};
        }).catch(function(){});
      }
    })
  }

  // ── Billing ────────────────────────────────────────────────────────────
  function billingTabs(tab){
    return '<div class="gwp-tabs"><button class="gwp-tab'+(tab==='invoices'?' active':'')+'" data-tab="invoices">Invoices</button>'+
      (can('view_payment_history')?'<button class="gwp-tab'+(tab==='history'?' active':'')+'" data-tab="history">Payment History</button>':'')+
      (can('manage_payment_methods')||can('manage_autopay')?'<button class="gwp-tab'+(tab==='methods'?' active':'')+'" data-tab="methods">Payment Methods</button>':'')+'</div>';
  }
  function renderBilling(tab){
    tab=tab||'invoices';
    if(!can('view_billing')){shell('<h2 class="gwp-h">Billing</h2><div class="gwp-empty">Your account does not include access to billing.</div>');bindNav();return}
    if(tab==='methods')return renderPaymentMethods();
    var loadHistory=tab==='history'&&can('view_payment_history');
    api(loadHistory?'/api/portal/payments':'/api/portal/invoices').then(function(d){
      var rows=d.data||[];var inner;
      var tabs=billingTabs(tab);
      if(loadHistory){
        inner=rows.length?'<div class="gwp-list">'+rows.map(function(p){
          return '<div class="gwp-item" style="cursor:default"><div><div class="it">'+money(p.amount)+'</div><div class="is">'+esc(p.invoice_number?('Invoice '+p.invoice_number+' · '):'')+esc(p.payment_method||'payment')+'</div></div><div class="ir"><div class="is">'+fmtD(p.created_at)+'</div></div></div>'}).join('')+'</div>'
          :'<div class="gwp-empty">No payments recorded yet.</div>';
      }else{
        var open=rows.filter(function(r){return ['sent','viewed','partial','overdue'].indexOf(r.status)>=0});
        var closed=rows.filter(function(r){return ['sent','viewed','partial','overdue'].indexOf(r.status)<0});
        function invHtml(r){var pl=propLabel(r.property_id);
          return '<div class="gwp-item" data-inv="'+esc(r.id)+'"><div><div class="it">'+esc(r.title||('Invoice '+(r.invoice_number||'')))+'</div><div class="is">'+esc(r.invoice_number||'')+(pl?' &middot; '+esc(pl):'')+(r.due_date?' &middot; Due '+fmtD(r.due_date):'')+'</div></div>'+
          '<div class="ir"><div class="iv">'+money(r.balance_due!=null&&['sent','viewed','partial','overdue'].indexOf(r.status)>=0?r.balance_due:r.total)+'</div><div style="margin-top:5px">'+stPill(r.status)+'</div></div></div>'}
        inner=(open.length?'<section class="gwp-section"><h2 class="gwp-h" style="font-size:15px">Open ('+open.length+')</h2><div style="height:10px"></div><div class="gwp-list">'+open.map(invHtml).join('')+'</div></section>':'')+
          (closed.length?'<section class="gwp-section"><h2 class="gwp-h" style="font-size:15px">Paid &amp; Closed</h2><div style="height:10px"></div><div class="gwp-list">'+closed.map(invHtml).join('')+'</div></section>':'')+
          (!rows.length?'<div class="gwp-empty">No invoices yet.</div>':'');
      }
      shell('<h2 class="gwp-h">Billing</h2><p class="gwp-hs">Invoices, balances, and payment history.</p>'+tabs+inner);
      bindNav();
      Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'),function(b){b.onclick=function(){renderBilling(b.getAttribute('data-tab'))}});
      Array.prototype.forEach.call(document.querySelectorAll('[data-inv]'),function(el){el.onclick=function(){renderInvoiceDetail(el.getAttribute('data-inv'))}});
    })
  }
  function renderInvoiceDetail(id){
    api('/api/portal/invoices/'+id).then(function(d){
      if(d.error){renderBilling();return}
      var r=d.data;var lines=[];try{lines=JSON.parse(r.line_items||'[]')}catch(_){}
      var lineRows=lines.map(function(l){
        var qty=l.qty||l.quantity||1,price=l.price||l.unit_price||l.rate||0,amt=l.amount!=null?l.amount:qty*price;
        return '<tr><td>'+esc(l.name||l.description||l.item||'')+'</td><td class="num">'+esc(qty)+'</td><td class="num">'+money(price)+'</td><td class="num">'+money(amt)+'</td></tr>'}).join('');
      var openBal=['sent','viewed','partial','overdue'].indexOf(r.status)>=0&&r.balance_due>0;
      var pays=(r.payments||[]).map(function(p){return '<div style="display:flex;justify-content:space-between;font-size:13px;padding:7px 10px;border-bottom:1px solid var(--line)"><span>'+fmtD(p.created_at)+' &middot; '+esc(p.payment_method||'payment')+'</span><span style="font-weight:700">'+money(p.amount)+'</span></div>'}).join('');
      shell('<button class="gwp-back" id="inv-back">&larr; Back to billing</button>'+
        (r.status==='paid'?'<div class="gwp-banner-ok">This invoice is paid in full. Thank you.</div>':'')+
        (r.status==='overdue'?'<div class="gwp-banner-warn">This invoice is past due. Balance: '+money(r.balance_due)+'</div>':'')+
        '<div class="gwp-detail"><div class="gwp-detail-head"><div><h3>'+esc(r.title||'Invoice')+'</h3><div class="dnum">'+esc(r.invoice_number||'')+(r.due_date?' &middot; Due '+fmtD(r.due_date):'')+'</div></div>'+stPill(r.status)+'</div>'+
        (lineRows?'<div class="gwp-lines-wrap"><table class="gwp-lines"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead><tbody>'+lineRows+'</tbody></table></div>':'')+
        '<div class="gwp-totals">'+
        (r.subtotal&&r.subtotal!==r.total?'<div><span>Subtotal</span><span>'+money(r.subtotal)+'</span></div>':'')+
        (r.discount_amount?'<div><span>Discount</span><span>-'+money(r.discount_amount)+'</span></div>':'')+
        (r.tax_amount?'<div><span>Tax</span><span>'+money(r.tax_amount)+'</span></div>':'')+
        '<div class="tt"><span>Total</span><span>'+money(r.total)+'</span></div>'+
        (r.amount_paid?'<div><span>Paid</span><span>-'+money(r.amount_paid)+'</span></div>':'')+
        (openBal?'<div class="tt"><span>Balance Due</span><span>'+money(r.balance_due)+'</span></div>':'')+
        '</div>'+
        (pays?'<div style="margin-top:20px"><div style="font-size:12px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--muted);margin-bottom:6px">Payments</div>'+pays+'</div>':'')+
        (openBal&&can('make_payments')?'<div class="gwp-actions" id="inv-pay-row">'+(r.portal_token?'<a class="gwp-btn" style="width:auto;text-decoration:none" href="/invoices/portal/'+esc(r.portal_token)+'" target="_blank" rel="noopener">Pay '+money(r.balance_due)+'</a>':'')+'</div><div id="inv-pay-saved-box"></div><div class="gwp-err" id="inv-pay-err"></div>':'')+
        (r.notes?'<div class="gwp-note">'+esc(r.notes)+'</div>':'')+
        (r.terms?'<div class="gw-rt-view" style="font-size:11.5px;color:var(--muted);margin-top:16px;line-height:1.6">'+rich(r.terms)+'</div>':'')+
        '</div>');
      bindNav();
      document.getElementById('inv-back').onclick=function(){renderBilling()};
      // Offer saved-method payment when the account has methods on file
      var box=document.getElementById('inv-pay-saved-box');
      if(box&&openBal){
        api('/api/portal/payment-methods').then(function(pd){
          var pms=(pd&&pd.data)||[];if(!pms.length)return;
          box.innerHTML='<div style="margin-top:14px;padding:14px;border:1px solid var(--line);border-radius:10px"><div style="font-size:12px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--muted);margin-bottom:8px">Pay with a saved method</div>'+
            '<select class="gwp-input" id="inv-pm-sel" style="margin-bottom:10px">'+pmOptions(pms,'')+'</select>'+
            '<button class="gwp-btn" id="inv-pay-saved" style="width:auto">Pay '+money(r.balance_due)+' now</button></div>';
          document.getElementById('inv-pay-saved').onclick=function(){
            var payBtn=this,pm=document.getElementById('inv-pm-sel').value;
            if(!pm)return;
            if(!confirm('Charge '+money(r.balance_due)+' to the selected payment method?'))return;
            payBtn.disabled=true;payBtn.textContent='Processing...';
            api('/api/portal/invoices/'+id+'/pay',{method:'POST',body:{stripe_pm_id:pm}}).then(function(x){
              if(x.error){var e=document.getElementById('inv-pay-err');e.textContent=x.error;e.style.display='block';payBtn.disabled=false;payBtn.textContent='Pay '+money(r.balance_due)+' now';return}
              renderInvoiceDetail(id)})};
        }).catch(function(){});
      }
    })
  }

  // ── Payment methods + autopay ───────────────────────────────────────────
  function pmOptions(pms,sel){return pms.map(function(p){return '<option value="'+esc(p.id)+'"'+(p.id===sel?' selected':'')+'>'+esc(p.label)+'</option>'}).join('')}
  function renderPaymentMethods(){
    var canPM=can('manage_payment_methods'),canAP=can('manage_autopay');
    if(!canPM&&!canAP){renderBilling();return}
    Promise.all([api('/api/portal/payment-methods'),canAP?api('/api/portal/autopay'):Promise.resolve({data:null})]).then(function(res){
      var pmd=res[0]||{},apd=res[1]||{};
      var pms=pmd.data||[],ap=apd.data||{enabled:0,stripe_pm_id:'',max_amount:0};
      var unavailable=pmd.available===false;
      var list=pms.length?'<div class="gwp-list">'+pms.map(function(p){
        return '<div class="gwp-item" style="cursor:default"><div><div class="it">'+esc(p.label)+'</div><div class="is">'+(p.type==='card'?'Card':'Bank account')+'</div></div>'+
          (canPM?'<div class="ir"><button class="gwp-btn-ghost" data-pm-del="'+esc(p.id)+'" style="padding:7px 14px;font-size:12px">Remove</button></div>':'')+'</div>'}).join('')+'</div>'
        :'<div class="gwp-empty">No saved payment methods yet.</div>';
      var apHtml='';
      if(canAP){
        apHtml='<section class="gwp-section"><div class="gwp-form-card"><h3>Autopay</h3>'+
          '<p class="hint">When enabled, new invoices are charged to your chosen payment method automatically when your contractor sends them.</p>'+
          (pms.length?'<label style="display:flex;align-items:center;gap:9px;font-size:14px;margin:12px 0;cursor:pointer"><input type="checkbox" id="ap-on"'+(ap.enabled?' checked':'')+'> Enable autopay</label>'+
          '<label class="gwp-label">Payment method</label><select class="gwp-input" id="ap-pm">'+pmOptions(pms,ap.stripe_pm_id)+'</select>'+
          '<label class="gwp-label">Maximum per invoice (0 = no limit)</label><input class="gwp-input" id="ap-max" type="number" min="0" step="1" value="'+(ap.max_amount||0)+'">'+
          '<div style="height:14px"></div><button class="gwp-btn" id="ap-save" style="width:auto;padding:10px 22px">Save Autopay Settings</button>'+
          '<div class="gwp-ok" id="ap-ok"></div><div class="gwp-err" id="ap-err"></div>'
          :'<p class="hint" style="margin-top:10px">Add a payment method first to set up autopay.</p>')+
          '</div></section>';
      }
      shell('<h2 class="gwp-h">Billing</h2><p class="gwp-hs">Invoices, balances, and payment history.</p>'+billingTabs('methods')+
        '<section class="gwp-section"><h2 class="gwp-h" style="font-size:15px">Saved Payment Methods</h2><div style="height:10px"></div>'+
        (unavailable?'<div class="gwp-empty">Online payments are not available for this account.</div>':list+
        (canPM?'<div class="gwp-actions"><button class="gwp-btn" id="pm-add" style="width:auto">Add Payment Method</button></div>':''))+
        '<div class="gwp-err" id="pm-err"></div></section>'+apHtml);
      bindNav();
      Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'),function(b){b.onclick=function(){renderBilling(b.getAttribute('data-tab'))}});
      function perr(id,m){var el=document.getElementById(id);if(el){el.textContent=m;el.style.display='block'}}
      var addBtn=document.getElementById('pm-add');
      if(addBtn){addBtn.onclick=function(){
        addBtn.disabled=true;addBtn.textContent='Opening secure checkout...';
        api('/api/portal/payment-methods/setup',{method:'POST',body:{}}).then(function(x){
          if(x.error){perr('pm-err',x.error);addBtn.disabled=false;addBtn.textContent='Add Payment Method';return}
          location.href=x.url})};
      }
      Array.prototype.forEach.call(document.querySelectorAll('[data-pm-del]'),function(b){
        b.onclick=function(){
          if(!confirm('Remove this payment method?'))return;
          b.disabled=true;
          api('/api/portal/payment-methods/'+encodeURIComponent(b.getAttribute('data-pm-del')),{method:'DELETE'}).then(function(x){
            if(x.error){perr('pm-err',x.error);b.disabled=false;return}
            renderPaymentMethods()})};
      });
      var apSave=document.getElementById('ap-save');
      if(apSave){apSave.onclick=function(){
        apSave.disabled=true;
        api('/api/portal/autopay',{method:'PUT',body:{enabled:document.getElementById('ap-on').checked,stripe_pm_id:document.getElementById('ap-pm').value,max_amount:Number(document.getElementById('ap-max').value)||0}}).then(function(x){
          apSave.disabled=false;
          if(x.error)return perr('ap-err',x.error);
          var ok=document.getElementById('ap-ok');ok.textContent='Autopay settings saved';ok.style.display='block';setTimeout(function(){ok.style.display='none'},3500)})};
      }
    })
  }

  // ── Projects ───────────────────────────────────────────────────────────
  var phasePill=function(ph){var lbl={scheduled:'Scheduled',in_progress:'In Progress',completed:'Completed'}[ph]||ph;return '<span class="gwp-status st-'+esc(ph)+'">'+esc(lbl)+'</span>'};
  function lightbox(src,cap){
    var lb=document.createElement('div');lb.className='gwp-lightbox';
    lb.innerHTML='<img src="'+esc(src)+'" alt="">'+(cap?'<div class="cap">'+esc(cap)+'</div>':'');
    lb.onclick=function(){document.body.removeChild(lb)};
    document.body.appendChild(lb);
  }
  function galleryHtml(media){
    var photos=(media||[]).filter(function(m){return m.kind==='photo'});
    if(!photos.length)return '';
    return '<div class="gwp-gallery">'+photos.map(function(m){
      return '<a href="/api/portal/media/'+esc(m.id)+'" data-photo="'+esc(m.id)+'" data-cap="'+esc(m.caption||'')+'"><img src="/api/portal/media/'+esc(m.id)+'" alt="'+esc(m.caption||m.file_name||'Project photo')+'" loading="lazy"></a>'}).join('')+'</div>';
  }
  function bindGallery(){
    Array.prototype.forEach.call(document.querySelectorAll('[data-photo]'),function(a){
      a.onclick=function(e){e.preventDefault();lightbox('/api/portal/media/'+a.getAttribute('data-photo'),a.getAttribute('data-cap'))}});
  }
  function renderProjects(){
    if(!can('view_projects')){shell('<h2 class="gwp-h">Projects</h2><div class="gwp-empty">Your account does not include access to projects.</div>');bindNav();return}
    api('/api/portal/projects').then(function(d){
      var rows=d.data||[];
      var active=rows.filter(function(r){return r.phase!=='completed'});
      var done=rows.filter(function(r){return r.phase==='completed'});
      function itemHtml(r){
        var pl=propLabel(r.property_id)||r.property_addr||'';
        var snip=r.latest_update?('Latest update '+fmtD(r.latest_update.update_date)+(r.latest_update.title?' — '+r.latest_update.title:'')):'No updates posted yet';
        return '<div class="gwp-item" data-proj="'+esc(r.id)+'"><div><div class="it">'+esc(r.title||('Project '+(r.wo_number||'')))+'</div>'+
          '<div class="is">'+esc(r.wo_number||'')+(pl?' &middot; '+esc(pl):'')+(r.scheduled_date?' &middot; '+fmtD(r.scheduled_date):'')+'</div>'+
          '<div class="is" style="margin-top:3px">'+esc(snip)+(r.photo_count?' &middot; '+r.photo_count+' photo'+(r.photo_count===1?'':'s'):'')+'</div></div>'+
          '<div class="ir"><div style="margin-top:5px">'+phasePill(r.phase)+'</div></div></div>'}
      shell('<h2 class="gwp-h">Projects</h2><p class="gwp-hs">Track active work, schedules, and daily updates from your crew.</p>'+
        (active.length?'<section class="gwp-section"><h2 class="gwp-h" style="font-size:15px">Active ('+active.length+')</h2><div style="height:10px"></div><div class="gwp-list">'+active.map(itemHtml).join('')+'</div></section>':'')+
        (done.length?'<section class="gwp-section"><h2 class="gwp-h" style="font-size:15px">Completed</h2><div style="height:10px"></div><div class="gwp-list">'+done.map(itemHtml).join('')+'</div></section>':'')+
        (!rows.length?'<div class="gwp-empty">No projects yet. When work is scheduled on your account, it will appear here with daily progress updates.</div>':''));
      bindNav();
      Array.prototype.forEach.call(document.querySelectorAll('[data-proj]'),function(el){el.onclick=function(){renderProjectDetail(el.getAttribute('data-proj'))}});
    })
  }
  function renderProjectDetail(id){
    api('/api/portal/projects/'+id).then(function(d){
      if(d.error){renderProjects();return}
      var p=d.data.project,updates=d.data.updates||[],photos=d.data.photos||[];
      var pl=propLabel(p.property_id)||p.property_addr||'';
      var meta='<div class="gwp-proj-meta">'+
        (pl?'<span>Location: <strong>'+esc(pl)+'</strong></span>':'')+
        (p.scheduled_date?'<span>Scheduled: <strong>'+fmtD(p.scheduled_date)+(p.scheduled_time?' at '+esc(p.scheduled_time):'')+'</strong></span>':'')+
        (p.type?'<span>Type: <strong>'+esc(p.type)+'</strong></span>':'')+
        '</div>';
      var updHtml=updates.map(function(u){
        return '<div class="gwp-update"><div class="ud">'+fmtD(u.update_date)+'</div>'+
          (u.title?'<div class="ut">'+esc(u.title)+'</div>':'')+
          '<div class="ub">'+esc(u.body)+'</div>'+galleryHtml(u.media)+'</div>'}).join('');
      shell('<button class="gwp-back" id="proj-back">&larr; Back to projects</button>'+
        (p.phase==='completed'?'<div class="gwp-banner-ok">This project is complete.'+(p.completion_notes?' '+esc(p.completion_notes):'')+'</div>':'')+
        '<div class="gwp-detail"><div class="gwp-detail-head"><div><h3>'+esc(p.title||'Project')+'</h3><div class="dnum">'+esc(p.wo_number||'')+'</div></div>'+phasePill(p.phase)+'</div>'+meta+'</div>'+
        '<section class="gwp-section"><h2 class="gwp-h" style="font-size:16px">Daily Updates</h2><p class="gwp-hs">Progress notes and photos posted by your crew.</p>'+
        (updHtml||'<div class="gwp-empty">No updates posted yet. Check back once work begins.</div>')+'</section>'+
        (photos.length?'<section class="gwp-section"><h2 class="gwp-h" style="font-size:16px">Photo Gallery</h2><p class="gwp-hs">Additional project photos.</p>'+galleryHtml(photos)+'</section>':''));
      bindNav();bindGallery();
      document.getElementById('proj-back').onclick=function(){renderProjects()};
    })
  }

  // ── Documents ──────────────────────────────────────────────────────────
  function renderDocuments(){
    if(!can('view_documents')){shell('<h2 class="gwp-h">Documents</h2><div class="gwp-empty">Your account does not include access to documents.</div>');bindNav();return}
    api('/api/portal/documents').then(function(d){
      var props=(d.data&&d.data.proposals)||[];
      var items=props.map(function(p){var pl=propLabel(p.property_id);
        return '<div class="gwp-item" data-doc="'+esc(p.portal_token||'')+'"><div><div class="it">'+esc(p.title||('Proposal '+(p.prop_number||'')))+'</div><div class="is">Proposal'+(p.prop_number?' '+esc(p.prop_number):'')+(pl?' &middot; '+esc(pl):'')+' &middot; '+fmtD(p.proposal_date||p.created_at)+'</div></div>'+
        '<div class="ir">'+(p.total?'<div class="iv">'+money(p.total)+'</div>':'')+'<div style="margin-top:5px">'+stPill(p.status)+'</div></div></div>'}).join('');
      shell('<h2 class="gwp-h">Documents</h2><p class="gwp-hs">Proposals and documents shared with you.</p>'+
        (items?'<div class="gwp-list">'+items+'</div>':'<div class="gwp-empty">No documents yet. Proposals and contracts shared by your contractor will appear here.</div>'));
      bindNav();
      Array.prototype.forEach.call(document.querySelectorAll('[data-doc]'),function(el){
        el.onclick=function(){var t=el.getAttribute('data-doc');if(t)window.open('/portal/proposal/'+t,'_blank','noopener')}});
    })
  }

  function render(){
    if(VIEW==='home')return renderHome();
    if(VIEW==='account')return renderAccount();
    if(VIEW==='estimates')return renderEstimates();
    if(VIEW==='billing')return renderBilling();
    if(VIEW==='documents')return renderDocuments();
    if(VIEW==='projects')return renderProjects();
    return renderHome();
  }
  function bindNav(){
    Array.prototype.forEach.call(document.querySelectorAll('[data-v]'),function(a){
      a.onclick=function(e){e.preventDefault();VIEW=a.getAttribute('data-v');history.replaceState(null,'','#'+VIEW);render()}})
  }
  var h=(location.hash||'').replace('#','');if(NAV.some(function(n){return n.id===h}))VIEW=h;
  // Stripe Checkout returns: deposit verification / payment method added
  var QS=new URLSearchParams(location.search);
  var depEst=QS.get('dep_est'),depSession=QS.get('dep_session');
  if(QS.get('pm_added'))VIEW='billing';
  api('/api/portal/auth/me').then(function(d){if(!d.ok){location.href='/portal/login';return}ME=d;
    if(depEst&&depSession){
      history.replaceState(null,'','/portal/home#estimates');
      api('/api/portal/estimates/'+depEst+'/verify-deposit',{method:'POST',body:{session_id:depSession}})
        .then(function(){VIEW='estimates';renderEstimateDetail(depEst)})
        .catch(function(){VIEW='estimates';render()});
      return;
    }
    if(QS.get('pm_added')){history.replaceState(null,'','/portal/home#billing');renderPaymentMethods();return}
    render()})
    .catch(function(){/* redirect handled in api() */});
})();
</script>
</body></html>`
}
