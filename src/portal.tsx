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

type Env = { Bindings: { DB: D1Database; MEDIA: R2Bucket; SENDGRID_API_KEY?: string } }

// ── Portal schema self-heal ──────────────────────────────────────────────────
// Applies migrations 0041 + 0042 idempotently at runtime (same pattern as
// ensureFullSchema in index.tsx). Guarded by a settings flag + module memo.
let _portalSchemaOk = false
async function ensurePortalSchema(db: D1Database): Promise<void> {
  if (_portalSchemaOk) return
  try {
    const flag = await db.prepare("SELECT value FROM settings WHERE key = '_schema_portal_v2' LIMIT 1").first<any>()
    if (flag) { _portalSchemaOk = true; return }
  } catch (_) {}
  const migs: Array<[string, string]> = [['0041_properties.sql', mig0041], ['0042_portal_identity.sql', mig0042]]
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
    await db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('_schema_portal_v1', ?, datetime('now'))").bind(new Date().toISOString()).run()
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
    can(perm: string, clientId?: string) {
      const pool = clientId ? mems.filter(m => m.client_id === clientId) : mems
      return pool.some(m => !!m.resolved_permissions[perm])
    }
  }
}

// ── requirePortalAuth middleware ─────────────────────────────────────────────
const PORTAL_COOKIE = 'gw_portal_session'
const SESSION_MAX_AGE_DAYS = 30

export async function requirePortalAuth(c: any, next: any) {
  const token = getCookie(c, PORTAL_COOKIE)
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB as D1Database
  const sess: any = await db.prepare(`SELECT * FROM portal_sessions WHERE token=? LIMIT 1`).bind(token).first()
  if (!sess) return c.json({ error: 'Session expired' }, 401)
  const ageMs = Date.now() - new Date(sess.created_at.replace(' ', 'T') + 'Z').getTime()
  if (isFinite(ageMs) && ageMs > SESSION_MAX_AGE_DAYS * 864e5) {
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

  // ══ PORTAL AUTH APIS ══════════════════════════════════════════════════════

  // POST /api/portal/auth/login
  app.post('/api/portal/auth/login', async (c) => {
    const db = c.env.DB as D1Database
    const { email, password } = await c.req.json().catch(() => ({} as any))
    if (!email || !password) return c.json({ error: 'Email and password required' }, 400)

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
      db.prepare(`UPDATE portal_users SET last_login_at=datetime('now'), failed_logins=0, locked_until='' WHERE id=?`).bind(user.id)
    ])
    setCookie(c, PORTAL_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_MAX_AGE_DAYS * 86400 })
    await portalAudit(db, { companyId: user.company_id, actorType: 'portal', portalUserId: user.id, eventType: 'portal_login', ip: clientIp(c) })
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
    await portalAudit(db, { companyId: s.companyId, actorType: 'portal', portalUserId: s.user.id, eventType: 'portal_account_updated', meta: { fields: Object.keys(b).filter(k => k !== 'current_password' && k !== 'new_password') }, ip: clientIp(c) })
    return c.json({ ok: true })
  })

  // GET /api/portal/dashboard — attention summary, fully scoped (Phase 1A light version)
  app.get('/api/portal/dashboard', requirePortalAuth, async (c) => {
    const db = c.env.DB as D1Database
    const s: PortalScope = c.var.portalScope
    const cin = s.clientIds.map(() => '?').join(',')
    const canEst = s.can('view_estimates'); const canBill = s.can('view_billing')
    let estAwaiting = 0, openBalance = 0, overdueBalance = 0, lastPayment: any = null
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
        active_projects: null   // populated in Phase 1C
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

  // ══ INTERNAL ADMIN APIS (staff auth) ══════════════════════════════════════

  // GET /api/admin/portal/users — all portal users for the company
  app.get('/api/admin/portal/users', deps.requireStaffAuth, async (c) => {
    const db = c.env.DB as D1Database
    const companyId = c.var.companyId as string
    const users = (await db.prepare(
      `SELECT id, contact_id, email, name, phone, status, invite_sent_at, invite_expires_at,
              activated_at, last_login_at, created_at,
              CASE WHEN invite_token != '' THEN 1 ELSE 0 END as has_pending_invite
       FROM portal_users WHERE company_id=? ORDER BY created_at DESC`
    ).bind(companyId).all()).results as any[] || []
    for (const u of users) {
      u.memberships = (await db.prepare(
        `SELECT m.id, m.client_id, m.role, m.all_properties, m.active, c.name as client_name
         FROM portal_memberships m JOIN clients c ON c.id=m.client_id WHERE m.portal_user_id=?`
      ).bind(u.id).all()).results || []
    }
    return c.json({ ok: true, data: users })
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
</style></head>
<body>
<div id="portal-root"><div class="gwp-loading"><div class="gwp-spin"></div>Loading your portal...</div></div>
<script>
(function(){
  var ME=null, VIEW='home';
  var root=document.getElementById('portal-root');
  var money=function(n){return '$'+(Number(n)||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})};
  var esc=function(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')};
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
  function navHtml(cls){return NAV.map(function(n){return '<a href="#'+n.id+'" class="'+(VIEW===n.id?'active':'')+'" data-v="'+n.id+'">'+ICONS[n.id]+'<span>'+n.label+'</span></a>'}).join('')}
  function shell(inner){
    var brand=ME.company||{};
    document.documentElement.style.setProperty('--brand',brand.brand_color||'#2D7A55');
    root.innerHTML=
      '<header class="gwp-topbar"><div class="gwp-brand">'+(brand.logo_url?'<img src="'+esc(brand.logo_url)+'" alt="">':'')+'<span class="co">'+esc(brand.name||'Client Portal')+'</span></div>'+
      '<div class="gwp-user"><span class="un">'+esc(ME.user.name)+'</span><button class="gwp-logout" id="btn-logout">Sign Out</button></div></header>'+
      '<div class="gwp-layout"><nav class="gwp-nav" id="side-nav">'+navHtml()+'</nav>'+
      '<main class="gwp-main" id="view-main">'+inner+'</main></div>'+
      '<nav class="gwp-tabbar" id="tab-nav">'+navHtml()+'</nav>';
    document.getElementById('btn-logout').onclick=function(){api('/api/portal/auth/logout',{method:'POST'}).then(function(){location.href='/portal/login'})};
  }
  function comingSoon(title,desc){return '<h2 class="gwp-h">'+title+'</h2><p class="gwp-hs">'+desc+'</p><div class="gwp-empty">This section is being rolled out. Check back soon — your '+title.toLowerCase()+' will appear here.</div>'}
  function can(p){return (ME.memberships||[]).some(function(m){return m.permissions&&m.permissions[p]})}

  function renderHome(){
    api('/api/portal/dashboard').then(function(d){
      var cds=d.cards||{};var cards='';
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
      '<div class="gwp-ok" id="pw-ok"></div><div class="gwp-err" id="pw-err"></div></div></div>');
    bindNav();
    function flash(id,m){var el=document.getElementById(id);el.textContent=m;el.style.display='block';setTimeout(function(){el.style.display='none'},3500)}
    document.getElementById('ac-save').onclick=function(){
      api('/api/portal/account',{method:'PUT',body:{name:document.getElementById('ac-name').value,phone:document.getElementById('ac-phone').value}})
        .then(function(d){if(d.error)return flash('ac-err',d.error);ME.user.name=document.getElementById('ac-name').value;flash('ac-ok','Profile saved')})};
    document.getElementById('pw-save').onclick=function(){
      api('/api/portal/account',{method:'PUT',body:{current_password:document.getElementById('pw-cur').value,new_password:document.getElementById('pw-new').value}})
        .then(function(d){if(d.error)return flash('pw-err',d.error);document.getElementById('pw-cur').value='';document.getElementById('pw-new').value='';flash('pw-ok','Password updated')})};
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
        (lineRows?'<table class="gwp-lines"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead><tbody>'+lineRows+'</tbody></table>':'')+
        '<div class="gwp-totals">'+
        (r.subtotal&&r.subtotal!==r.total?'<div><span>Subtotal</span><span>'+money(r.subtotal)+'</span></div>':'')+
        (r.discount_amt?'<div><span>Discount</span><span>-'+money(r.discount_amt)+'</span></div>':'')+
        (r.tax_amt?'<div><span>Tax</span><span>'+money(r.tax_amt)+'</span></div>':'')+
        '<div class="tt"><span>Total</span><span>'+money(r.total)+'</span></div>'+
        (r.deposit_amt?'<div><span>Deposit due</span><span>'+money(r.deposit_amt)+(r.deposit_paid?' (paid)':'')+'</span></div>':'')+
        '</div>'+
        (r.customer_notes?'<div class="gwp-note">'+esc(r.customer_notes)+'</div>':'')+
        (r.terms?'<div style="font-size:11.5px;color:var(--muted);margin-top:16px;line-height:1.6;white-space:pre-wrap">'+esc(r.terms)+'</div>':'')+
        (canApprove?'<div class="gwp-actions"><button class="gwp-btn" id="est-approve" style="width:auto">Approve Estimate</button><button class="gwp-btn-ghost" id="est-decline">Decline / Request Changes</button></div><div id="est-decline-box" style="display:none;margin-top:14px"><label class="gwp-label">Tell us what you would like changed (optional)</label><textarea class="gwp-input" id="est-reason"></textarea><div style="height:10px"></div><button class="gwp-btn-ghost" id="est-decline-send">Send Response</button></div>':'')+
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
    })
  }

  // ── Billing ────────────────────────────────────────────────────────────
  function renderBilling(tab){
    tab=tab||'invoices';
    if(!can('view_billing')){shell('<h2 class="gwp-h">Billing</h2><div class="gwp-empty">Your account does not include access to billing.</div>');bindNav();return}
    var loadHistory=tab==='history'&&can('view_payment_history');
    api(loadHistory?'/api/portal/payments':'/api/portal/invoices').then(function(d){
      var rows=d.data||[];var inner;
      var tabs='<div class="gwp-tabs"><button class="gwp-tab'+(tab==='invoices'?' active':'')+'" data-tab="invoices">Invoices</button>'+(can('view_payment_history')?'<button class="gwp-tab'+(tab==='history'?' active':'')+'" data-tab="history">Payment History</button>':'')+'</div>';
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
        (lineRows?'<table class="gwp-lines"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead><tbody>'+lineRows+'</tbody></table>':'')+
        '<div class="gwp-totals">'+
        (r.subtotal&&r.subtotal!==r.total?'<div><span>Subtotal</span><span>'+money(r.subtotal)+'</span></div>':'')+
        (r.discount_amount?'<div><span>Discount</span><span>-'+money(r.discount_amount)+'</span></div>':'')+
        (r.tax_amount?'<div><span>Tax</span><span>'+money(r.tax_amount)+'</span></div>':'')+
        '<div class="tt"><span>Total</span><span>'+money(r.total)+'</span></div>'+
        (r.amount_paid?'<div><span>Paid</span><span>-'+money(r.amount_paid)+'</span></div>':'')+
        (openBal?'<div class="tt"><span>Balance Due</span><span>'+money(r.balance_due)+'</span></div>':'')+
        '</div>'+
        (pays?'<div style="margin-top:20px"><div style="font-size:12px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--muted);margin-bottom:6px">Payments</div>'+pays+'</div>':'')+
        (openBal&&can('make_payments')&&r.portal_token?'<div class="gwp-actions"><a class="gwp-btn" style="width:auto;text-decoration:none" href="/invoices/portal/'+esc(r.portal_token)+'" target="_blank" rel="noopener">Pay '+money(r.balance_due)+'</a></div>':'')+
        (r.notes?'<div class="gwp-note">'+esc(r.notes)+'</div>':'')+
        (r.terms?'<div style="font-size:11.5px;color:var(--muted);margin-top:16px;line-height:1.6;white-space:pre-wrap">'+esc(r.terms)+'</div>':'')+
        '</div>');
      bindNav();
      document.getElementById('inv-back').onclick=function(){renderBilling()};
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
    shell(comingSoon('Projects','Track active work, schedules, and daily updates.'));bindNav();
  }
  function bindNav(){
    Array.prototype.forEach.call(document.querySelectorAll('[data-v]'),function(a){
      a.onclick=function(e){e.preventDefault();VIEW=a.getAttribute('data-v');history.replaceState(null,'','#'+VIEW);render()}})
  }
  var h=(location.hash||'').replace('#','');if(NAV.some(function(n){return n.id===h}))VIEW=h;
  api('/api/portal/auth/me').then(function(d){if(!d.ok){location.href='/portal/login';return}ME=d;render()})
    .catch(function(){/* redirect handled in api() */});
})();
</script>
</body></html>`
}
