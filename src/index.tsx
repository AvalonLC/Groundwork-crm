import { Hono } from 'hono'
import { serveStatic } from 'hono/cloudflare-workers'
import { cors } from 'hono/cors'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'

type Bindings = { DB: D1Database; SENDGRID_API_KEY?: string }
type Variables = { repId: string; companyId: string; role: string; isSuperAdmin: boolean }

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// ── CORS + middleware ─────────────────────────────────────────────────────────
app.use('/api/*', cors())

// ── Static files ──────────────────────────────────────────────────────────────
app.use('/static/*', serveStatic({ root: './public' }))
app.use('/sw.js', serveStatic({ root: './public', path: 'sw.js' }))

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}
function json(c: any, data: any, status = 200) {
  return c.json({ ok: true, data }, status)
}
function err(c: any, msg: string, status = 400) {
  return c.json({ ok: false, error: msg }, status)
}

// ── PIN hashing (PBKDF2-SHA256 via Web Crypto API) ───────────────────────────
// Format stored in DB: "pbkdf2:100000:<salt_hex>:<hash_hex>"
async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const enc  = new TextEncoder()
  const key  = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 },
    key, 256
  )
  const toHex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2,'0')).join('')
  return `pbkdf2:100000:${toHex(salt)}:${toHex(new Uint8Array(bits))}`
}

async function verifyPin(pin: string, stored: string): Promise<boolean> {
  if (!stored || !stored.startsWith('pbkdf2:')) return false
  const parts = stored.split(':')
  if (parts.length !== 4) return false
  const [,iters, saltHex, hashHex] = parts
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(h => parseInt(h, 16)))
  const enc  = new TextEncoder()
  const key  = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: parseInt(iters) },
    key, 256
  )
  const toHex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2,'0')).join('')
  return toHex(new Uint8Array(bits)) === hashHex
}

// ── SendGrid email helper ─────────────────────────────────────────────────────
async function sendEmail(apiKey: string, to: string, subject: string, html: string): Promise<boolean> {
  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: 'noreply@groundwork-crm.com', name: 'Groundwork CRM' },
        subject,
        content: [{ type: 'text/html', value: html }]
      })
    })
    return res.status >= 200 && res.status < 300
  } catch { return false }
}

// ── Secure random hex token ───────────────────────────────────────────────────
function secureToken(bytes = 32): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map(b => b.toString(16).padStart(2,'0')).join('')
}

// ── requireAuth middleware ────────────────────────────────────────────────────
// Resolves session cookie → rep → company_id, sets c.var.{repId,companyId,role,isSuperAdmin}
async function requireAuth(c: any, next: any) {
  const token = getCookie(c, 'avalon_session')
  if (!token) return err(c, 'Unauthorized', 401)
  const row = await c.env.DB.prepare(`
    SELECT r.id as rep_id, r.company_id, r.role, r.is_super_admin
    FROM settings s
    JOIN reps r ON r.id = s.value
    WHERE s.key = ? LIMIT 1
  `).bind(`session_${token}`).first<{ rep_id: string; company_id: string; role: string; is_super_admin: number }>()
  if (!row) return err(c, 'Session expired', 401)
  c.set('repId',        row.rep_id)
  c.set('companyId',    row.company_id)
  c.set('role',         row.role)
  c.set('isSuperAdmin', !!row.is_super_admin)
  await next()
}

async function requireSuperAdmin(c: any, next: any) {
  await requireAuth(c, async () => {})
  if (!c.var.isSuperAdmin) return err(c, 'Forbidden', 403)
  await next()
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES  (no requireAuth — these establish identity)
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/auth/login  { email, password }
// Primary login: looks up rep by email (unique), verifies PBKDF2 password hash.
// Legacy shape { repId, pin, companyId } is also accepted as offline fallback.
app.post('/api/auth/login', async (c) => {
  const body = await c.req.json()
  const email    = (body.email    || '').toLowerCase().trim()
  const password = body.password  || body.pin   // accept both field names
  const repId    = body.repId
  const companyId = body.companyId

  if (!password) return err(c, 'password required')

  let rep: any
  if (email) {
    // Primary path: email-based lookup (unique across all tenants)
    rep = await c.env.DB.prepare(
      'SELECT * FROM reps WHERE email = ? AND active = 1 LIMIT 1'
    ).bind(email).first()
  } else if (repId) {
    // Legacy / offline fallback: repId + optional companyId
    if (companyId) {
      rep = await c.env.DB.prepare(
        'SELECT * FROM reps WHERE id = ? AND company_id = ? AND active = 1 LIMIT 1'
      ).bind(repId, companyId).first()
    } else {
      rep = await c.env.DB.prepare(
        'SELECT * FROM reps WHERE id = ? AND active = 1 LIMIT 1'
      ).bind(repId).first()
    }
  } else {
    return err(c, 'email required')
  }
  if (!rep) return err(c, 'Invalid credentials', 401)

  // Dual-mode password check: prefer hashed, fall back to plain-text legacy PIN
  let ok = false
  if (rep.pin_hash) {
    ok = await verifyPin(String(password), rep.pin_hash)
    // Clear any residual plain-text PIN column
    if (ok && rep.pin) {
      await c.env.DB.prepare("UPDATE reps SET pin = '' WHERE id = ? AND company_id = ?")
        .bind(rep.id, rep.company_id).run()
    }
  } else if (rep.pin) {
    // Legacy plain-text PIN — verify then upgrade to hash immediately
    ok = String(password) === String(rep.pin)
    if (ok) {
      const hash = await hashPin(String(password))
      await c.env.DB.prepare("UPDATE reps SET pin_hash = ?, pin = '' WHERE id = ? AND company_id = ?")
        .bind(hash, rep.id, rep.company_id).run()
    }
  }
  if (!ok) return err(c, 'Invalid credentials', 401)

  const token = uid() + uid()
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    ).bind(`session_${token}`, rep.id),
    c.env.DB.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    ).bind(`session_company_${token}`, rep.company_id)
  ])
  setCookie(c, 'avalon_session', token, {
    httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 60 * 60 * 24 * 30
  })
  const { pin: _p, pin_hash: _ph, ...safeRep } = rep as any
  return json(c, safeRep)
})

// POST /api/auth/logout
app.post('/api/auth/logout', async (c) => {
  const token = getCookie(c, 'avalon_session')
  if (token) {
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(`session_${token}`),
      c.env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(`session_company_${token}`)
    ])
  }
  deleteCookie(c, 'avalon_session')
  return json(c, { loggedOut: true })
})

// GET /api/auth/me
app.get('/api/auth/me', async (c) => {
  const token = getCookie(c, 'avalon_session')
  if (!token) return err(c, 'Not logged in', 401)
  const sess = await c.env.DB.prepare(
    'SELECT value FROM settings WHERE key = ? LIMIT 1'
  ).bind(`session_${token}`).first<{ value: string }>()
  if (!sess) return err(c, 'Session expired', 401)
  const rep = await c.env.DB.prepare(
    'SELECT id, name, title, role, color, commission_plan, company_id, is_super_admin FROM reps WHERE id = ? LIMIT 1'
  ).bind(sess.value).first()
  if (!rep) return err(c, 'Rep not found', 404)
  return json(c, rep)
})

// ══════════════════════════════════════════════════════════════════════════════
// COMPANIES  (super-admin only in future; open for now to bootstrap)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/companies/:id  — read own company info
app.get('/api/companies/:id', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT id, name, slug, plan, phone, website, logo_url, timezone, trial_ends_at, active, created_at FROM companies WHERE id = ? LIMIT 1'
  ).bind(c.req.param('id')).first()
  if (!row) return err(c, 'Company not found', 404)
  return json(c, row)
})

// PUT /api/companies/:id  — update own company (admin only, enforced in middleware later)
app.put('/api/companies/:id', async (c) => {
  const id = c.req.param('id')
  const b  = await c.req.json()
  const fields = ['name','phone','website','logo_url','timezone','owner_email']
  const updates = fields.filter(f => b[f] !== undefined)
  if (!updates.length) return err(c, 'Nothing to update')
  const set = updates.map(f => `${f} = ?`).join(', ')
  const vals = updates.map(f => b[f])
  await c.env.DB.prepare(
    `UPDATE companies SET ${set}, updated_at = datetime('now') WHERE id = ?`
  ).bind(...vals, id).run()
  return json(c, { updated: id })
})

// POST /api/companies  — onboard a new company (public endpoint for signup flow)
app.post('/api/companies', async (c) => {
  const b = await c.req.json()
  if (!b.name || !b.slug) return err(c, 'name and slug required')
  // Check slug uniqueness
  const existing = await c.env.DB.prepare('SELECT id FROM companies WHERE slug = ? LIMIT 1').bind(b.slug).first()
  if (existing) return err(c, 'That company URL is already taken', 409)
  const id = b.slug // use slug as id for readability
  await c.env.DB.prepare(`
    INSERT INTO companies (id, name, slug, plan, owner_email, phone, website, timezone, active)
    VALUES (?, ?, ?, 'trial', ?, ?, ?, ?, 1)
  `).bind(id, b.name, b.slug, b.ownerEmail||'', b.phone||'', b.website||'', b.timezone||'America/New_York').run()
  return json(c, { id, slug: b.slug }, 201)
})

// ══════════════════════════════════════════════════════════════════════════════
// REPS  — all scoped to company_id
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/reps?companyId=
app.get('/api/reps', async (c) => {
  const companyId = c.req.query('companyId') || 'avalon'
  const rows = await c.env.DB.prepare(
    'SELECT id, name, title, role, color, commission_plan, active, company_id, email, invite_accepted, invite_sent_at FROM reps WHERE company_id = ? ORDER BY active DESC, name'
  ).bind(companyId).all()
  return json(c, rows.results)
})

// GET /api/reps/:id
app.get('/api/reps/:id', async (c) => {
  const companyId = c.req.query('companyId') || 'avalon'
  const row = await c.env.DB.prepare(
    'SELECT id, name, title, role, color, commission_plan, active, company_id FROM reps WHERE id = ? AND company_id = ? LIMIT 1'
  ).bind(c.req.param('id'), companyId).first()
  if (!row) return err(c, 'Rep not found', 404)
  return json(c, row)
})

// POST /api/reps  — add a rep to a company
// Accepts password (preferred) or pin (legacy) for the initial credential
app.post('/api/reps', async (c) => {
  const b = await c.req.json()
  const credential = b.password || b.pin
  if (!b.id || !b.name || !credential || !b.companyId) return err(c, 'id, name, password, companyId required')
  if (!b.email) return err(c, 'email required — users log in with their email address')
  const pinHash = await hashPin(String(credential))
  await c.env.DB.prepare(`
    INSERT INTO reps (id, name, title, role, pin, pin_hash, email, color, commission_plan, company_id, active)
    VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, 1)
  `).bind(b.id, b.name, b.title||'', b.role||'rep', pinHash, b.email, b.color||'#6366f1', b.commissionPlan||'standard', b.companyId).run()
  return json(c, { id: b.id }, 201)
})

// PUT /api/reps/:id
app.put('/api/reps/:id', async (c) => {
  const id = c.req.param('id')
  const b  = await c.req.json()
  const companyId = b.companyId || 'avalon'
  const fields = ['name','title','role','color','email','commission_plan','active']
  const updates: string[] = []
  const vals: any[] = []
  for (const f of fields) {
    if (b[f] !== undefined) { updates.push(`${f} = ?`); vals.push(b[f]) }
  }
  // Hash new password if provided (accept both 'password' and legacy 'pin')
  const newCred = b.password || b.pin
  if (newCred) {
    const pinHash = await hashPin(String(newCred))
    updates.push("pin_hash = ?"); vals.push(pinHash)
    updates.push("pin = ''")     // clear legacy plain pin
  }
  if (!updates.length) return err(c, 'Nothing to update')
  await c.env.DB.prepare(
    `UPDATE reps SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ? AND company_id = ?`
  ).bind(...vals, id, companyId).run()
  return json(c, { updated: id })
})

// ══════════════════════════════════════════════════════════════════════════════
// INVITE SYSTEM  — admin sends magic-link invites to new team members
// ══════════════════════════════════════════════════════════════════════════════

// Shared helper: build + send the invite email
async function sendInviteEmail(
  c: any,
  { toEmail, toName, fromName, companyName, token, role, message }: {
    toEmail: string; toName: string; fromName: string;
    companyName: string; token: string; role: string; message?: string
  }
) {
  const apiKey = c.env.SENDGRID_API_KEY
  if (!apiKey) return false
  const inviteUrl = `https://groundwork-crm.com/invite/${token}`
  const roleLabel = role === 'admin' ? 'Owner / Admin'
    : role === 'office_manager' ? 'Office Manager'
    : role === 'estimator' ? 'Estimator'
    : role === 'view_only' ? 'View Only' : 'Sales Rep'
  const personalNote = message
    ? `<p style="font-size:15px;color:#b8bfb0;margin:0 0 24px;padding:16px;background:#1a2318;border-left:3px solid #4D8A86;border-radius:0 8px 8px 0;font-style:italic">"${message}"</p>`
    : ''
  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0d1510;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:520px;margin:40px auto;padding:0 16px">
  <div style="background:#131c11;border:1px solid #2a3a27;border-radius:16px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#1a2a18 0%,#0f1e0d 100%);padding:32px 36px;border-bottom:1px solid #2a3a27">
      <div style="font-size:22px;font-weight:800;color:#e8e4d9;letter-spacing:-0.5px">🌱 Groundwork CRM</div>
      <div style="font-size:13px;color:#5c6b58;margin-top:4px">You've been invited to join the team</div>
    </div>
    <div style="padding:32px 36px">
      <p style="font-size:16px;color:#e8e4d9;margin:0 0 8px;font-weight:600">Hi ${toName || 'there'},</p>
      <p style="font-size:15px;color:#b8bfb0;margin:0 0 24px;line-height:1.6">
        <strong style="color:#e8e4d9">${fromName}</strong> has invited you to join 
        <strong style="color:#e8e4d9">${companyName}</strong> on Groundwork CRM 
        as <strong style="color:#4D8A86">${roleLabel}</strong>.
      </p>
      ${personalNote}
      <p style="font-size:14px;color:#b8bfb0;margin:0 0 20px;line-height:1.6">
        Click the button below to set up your account — you'll choose your own password and be ready to go in under a minute.
      </p>
      <div style="text-align:center;margin:28px 0">
        <a href="${inviteUrl}" style="display:inline-block;background:#4D8A86;color:#fff;font-size:15px;font-weight:700;text-decoration:none;padding:14px 36px;border-radius:10px;letter-spacing:0.2px">
          Accept Invite &amp; Set Up Account →
        </a>
      </div>
      <p style="font-size:12px;color:#5c6b58;margin:0;text-align:center;line-height:1.6">
        This invite link expires in 7 days. If you didn't expect this email, you can safely ignore it.<br>
        Or copy this link: <a href="${inviteUrl}" style="color:#4D8A86">${inviteUrl}</a>
      </p>
    </div>
    <div style="padding:20px 36px;border-top:1px solid #2a3a27;text-align:center">
      <div style="font-size:11px;color:#3d4d3a">Groundwork CRM · Sent on behalf of ${companyName}</div>
    </div>
  </div>
</div>
</body></html>`
  return sendEmail(apiKey, toEmail, `You're invited to join ${companyName} on Groundwork CRM`, html)
}

// POST /api/auth/invite  — admin creates a pending rep + sends magic-link invite
app.post('/api/auth/invite', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role      = c.var.role      as string
  if (role !== 'admin' && role !== 'office_manager') return err(c, 'Only admins can send invites', 403)

  const b = await c.req.json()
  const { email, name, inviteRole, title, color, message } = b
  if (!email || !name) return err(c, 'email and name required')

  // Check email not already taken in this company
  const existing = await c.env.DB.prepare(
    'SELECT id, invite_accepted FROM reps WHERE email = ? AND company_id = ? LIMIT 1'
  ).bind(email, companyId).first<{ id: string; invite_accepted: number }>()
  if (existing && existing.invite_accepted) return err(c, 'A user with that email already exists')

  // Get inviter + company info for email
  const inviterRow = await c.env.DB.prepare(
    'SELECT name FROM reps WHERE id = ? LIMIT 1'
  ).bind(c.var.repId).first<{ name: string }>()
  const companyRow = await c.env.DB.prepare(
    'SELECT name FROM companies WHERE id = ? LIMIT 1'
  ).bind(companyId).first<{ name: string }>()
  const fromName    = inviterRow?.name || 'Your admin'
  const companyName = companyRow?.name || companyId

  const token  = secureToken(32)
  const repId  = existing?.id || ('rep_' + uid())
  const roleToUse = inviteRole || 'rep'

  if (existing) {
    // Re-invite: refresh token on the same pending record
    await c.env.DB.prepare(`
      UPDATE reps SET invite_token=?, invite_sent_at=datetime('now'), name=?, role=?, title=?, color=?,
        updated_at=datetime('now')
      WHERE id=? AND company_id=?
    `).bind(token, name, roleToUse, title||'', color||'#4D8A86', existing.id, companyId).run()
  } else {
    // New pending rep — no password yet, active=0
    await c.env.DB.prepare(`
      INSERT INTO reps (id, name, title, role, pin, pin_hash, email, color, commission_plan,
        company_id, active, invite_token, invite_sent_at, invite_accepted)
      VALUES (?, ?, ?, ?, '', '', ?, ?, 'standard', ?, 0, ?, datetime('now'), 0)
    `).bind(repId, name, title||'', roleToUse, email, color||'#4D8A86', companyId, token).run()
  }

  const sent = await sendInviteEmail(c, { toEmail: email, toName: name, fromName, companyName, token, role: roleToUse, message })
  return json(c, { invited: true, email, emailSent: sent })
})

// POST /api/auth/resend-invite  — resend to a pending (invite_accepted=0) rep
app.post('/api/auth/resend-invite', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role      = c.var.role      as string
  if (role !== 'admin' && role !== 'office_manager') return err(c, 'Only admins can send invites', 403)

  const { repId: targetId } = await c.req.json()
  if (!targetId) return err(c, 'repId required')

  const rep = await c.env.DB.prepare(
    'SELECT id, name, email, role, invite_accepted FROM reps WHERE id=? AND company_id=? LIMIT 1'
  ).bind(targetId, companyId).first<{ id:string;name:string;email:string;role:string;invite_accepted:number }>()
  if (!rep) return err(c, 'Rep not found', 404)
  if (rep.invite_accepted) return err(c, 'User has already accepted their invite')
  if (!rep.email) return err(c, 'Rep has no email address')

  const token = secureToken(32)
  await c.env.DB.prepare(`
    UPDATE reps SET invite_token=?, invite_sent_at=datetime('now'), updated_at=datetime('now')
    WHERE id=? AND company_id=?
  `).bind(token, targetId, companyId).run()

  const inviterRow  = await c.env.DB.prepare('SELECT name FROM reps WHERE id=? LIMIT 1').bind(c.var.repId).first<{ name:string }>()
  const companyRow  = await c.env.DB.prepare('SELECT name FROM companies WHERE id=? LIMIT 1').bind(companyId).first<{ name:string }>()
  const sent = await sendInviteEmail(c, {
    toEmail: rep.email, toName: rep.name, fromName: inviterRow?.name||'Your admin',
    companyName: companyRow?.name||companyId, token, role: rep.role
  })
  return json(c, { resent: true, email: rep.email, emailSent: sent })
})

// GET /invite/:token  — onboarding landing page
app.get('/invite/:token', async (c) => {
  const token = c.req.param('token')
  const rep = await c.env.DB.prepare(`
    SELECT r.id, r.name, r.email, r.role, r.title, r.company_id, r.invite_accepted,
           co.name as company_name
    FROM reps r
    LEFT JOIN companies co ON co.id = r.company_id
    WHERE r.invite_token = ? AND r.invite_accepted = 0 LIMIT 1
  `).bind(token).first<{
    id:string; name:string; email:string; role:string; title:string;
    company_id:string; invite_accepted:number; company_name:string
  }>()

  const roleLabel = !rep ? '' : rep.role === 'admin' ? 'Owner / Admin'
    : rep.role === 'office_manager' ? 'Office Manager'
    : rep.role === 'estimator' ? 'Estimator'
    : rep.role === 'view_only' ? 'View Only' : 'Sales Rep'

  if (!rep) {
    return c.html(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invalid Invite — Groundwork CRM</title>
<style>*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1510;color:#e8e4d9;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}</style>
</head><body>
<div style="text-align:center;max-width:420px">
  <div style="font-size:48px;margin-bottom:16px">🔗</div>
  <h1 style="font-size:22px;margin:0 0 12px;color:#e8e4d9">Invite Link Expired or Invalid</h1>
  <p style="color:#6F7E6A;font-size:15px;line-height:1.6;margin:0 0 24px">This invite link has already been used or has expired. Ask your admin to send a new invite.</p>
  <a href="/" style="display:inline-block;background:#4D8A86;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700;font-size:14px">← Go to Login</a>
</div>
</body></html>`)
  }

  return c.html(`<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Join ${rep.company_name || rep.company_id} — Groundwork CRM</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1510;color:#e8e4d9;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#131c11;border:1px solid #2a3a27;border-radius:16px;width:min(480px,100%);overflow:hidden}
.card-header{background:linear-gradient(135deg,#1a2a18 0%,#0f1e0d 100%);padding:28px 32px;border-bottom:1px solid #2a3a27}
.card-body{padding:32px}
label{display:block;font-size:12px;font-weight:700;color:#5c6b58;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
input{width:100%;padding:11px 14px;background:#0d1510;border:1.5px solid #2a3a27;border-radius:8px;color:#e8e4d9;font-size:15px;outline:none;transition:border-color .15s}
input:focus{border-color:#4D8A86}
.btn{width:100%;padding:14px;background:#4D8A86;color:#fff;font-size:15px;font-weight:700;border:none;border-radius:10px;cursor:pointer;margin-top:8px;transition:opacity .15s}
.btn:hover{opacity:.9}
.btn:disabled{opacity:.5;cursor:not-allowed}
.err{color:#C97B6A;font-size:13px;margin-top:10px;display:none}
.info-pill{display:inline-block;background:#4D8A8618;border:1px solid #4D8A8640;color:#4D8A86;font-size:12px;font-weight:700;padding:3px 10px;border-radius:20px}
</style>
</head><body>
<div class="card">
  <div class="card-header">
    <div style="font-size:20px;font-weight:800;color:#e8e4d9;letter-spacing:-0.5px;margin-bottom:4px">🌱 Groundwork CRM</div>
    <div style="font-size:13px;color:#5c6b58">Account Setup</div>
  </div>
  <div class="card-body">
    <div style="margin-bottom:24px">
      <p style="font-size:16px;color:#e8e4d9;font-weight:600;margin-bottom:6px">Welcome, ${rep.name}!</p>
      <p style="font-size:14px;color:#b8bfb0;line-height:1.6;margin-bottom:12px">
        You've been invited to join <strong style="color:#e8e4d9">${rep.company_name || rep.company_id}</strong>.
        Set your password below to activate your account.
      </p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <span class="info-pill">${roleLabel}</span>
        ${rep.title ? `<span class="info-pill" style="background:#8B691418;border-color:#8B691440;color:#8B6914">${rep.title}</span>` : ''}
        <span style="font-size:12px;color:#5c6b58;align-self:center">${rep.email}</span>
      </div>
    </div>

    <form id="accept-form">
      <input type="hidden" id="inv-token" value="${token}">
      <div style="margin-bottom:16px">
        <label>Your Full Name</label>
        <input id="inv-name" type="text" value="${rep.name}" placeholder="Your full name" required>
      </div>
      <div style="margin-bottom:16px">
        <label>Create Password</label>
        <input id="inv-pw" type="password" placeholder="Min 6 characters" required autocomplete="new-password">
      </div>
      <div style="margin-bottom:20px">
        <label>Confirm Password</label>
        <input id="inv-pw2" type="password" placeholder="Re-enter password" required autocomplete="new-password">
      </div>
      <button class="btn" type="submit" id="inv-btn">Activate My Account →</button>
      <div class="err" id="inv-err"></div>
    </form>
  </div>
</div>

<script>
document.getElementById('accept-form').addEventListener('submit', async function(e) {
  e.preventDefault();
  const btn = document.getElementById('inv-btn');
  const errEl = document.getElementById('inv-err');
  const name = document.getElementById('inv-name').value.trim();
  const pw   = document.getElementById('inv-pw').value;
  const pw2  = document.getElementById('inv-pw2').value;
  const token = document.getElementById('inv-token').value;
  errEl.style.display = 'none';
  if (!name) { errEl.textContent = 'Please enter your name.'; errEl.style.display='block'; return; }
  if (pw.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; errEl.style.display='block'; return; }
  if (pw !== pw2) { errEl.textContent = 'Passwords do not match.'; errEl.style.display='block'; return; }
  btn.disabled = true; btn.textContent = 'Activating…';
  try {
    const res = await fetch('/api/auth/accept-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, name, password: pw })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      btn.textContent = '✓ Account activated! Redirecting…';
      setTimeout(() => { window.location.href = '/'; }, 1200);
    } else {
      errEl.textContent = data.error || 'Something went wrong. Please try again.';
      errEl.style.display = 'block';
      btn.disabled = false; btn.textContent = 'Activate My Account →';
    }
  } catch(err) {
    errEl.textContent = 'Network error. Please check your connection and try again.';
    errEl.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Activate My Account →';
  }
});
</script>
</body></html>`)
})

// POST /api/auth/accept-invite  — validates token, hashes password, activates rep, creates session
app.post('/api/auth/accept-invite', async (c) => {
  const { token, name, password } = await c.req.json()
  if (!token || !password) return err(c, 'token and password required')
  if (String(password).length < 6) return err(c, 'Password must be at least 6 characters')

  const rep = await c.env.DB.prepare(`
    SELECT id, company_id, role, email FROM reps
    WHERE invite_token = ? AND invite_accepted = 0 LIMIT 1
  `).bind(token).first<{ id:string; company_id:string; role:string; email:string }>()
  if (!rep) return err(c, 'Invite link is invalid or has already been used')

  const pinHash = await hashPin(String(password))
  const finalName = (name || '').trim()

  await c.env.DB.prepare(`
    UPDATE reps SET
      pin_hash = ?, pin = '', active = 1, invite_accepted = 1, invite_token = '',
      ${finalName ? "name = ?," : ''}
      updated_at = datetime('now')
    WHERE id = ? AND company_id = ?
  `).bind(
    pinHash,
    ...(finalName ? [finalName] : []),
    rep.id, rep.company_id
  ).run()

  // Create session
  const sessionToken = uid() + uid()
  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO settings (id, key, value, company_id) VALUES (?, ?, ?, ?)`
  ).bind('sess_' + sessionToken, `session_${sessionToken}`, rep.id, rep.company_id).run()

  const cookie = `avalon_session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`
  return new Response(JSON.stringify({ ok: true, repId: rep.id }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie }
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// OPPORTUNITIES  — all scoped to company_id
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/opportunities?companyId=&repId=&status=
app.get('/api/opportunities', async (c) => {
  const companyId = c.req.query('companyId') || 'avalon'
  const repId     = c.req.query('repId')
  const status    = c.req.query('status')
  let q = 'SELECT * FROM opportunities WHERE company_id = ?'
  const params: any[] = [companyId]
  if (repId)  { q += ' AND rep_id = ?';  params.push(repId) }
  if (status) { q += ' AND status = ?';  params.push(status) }
  q += ' ORDER BY updated_at DESC'
  const rows = await c.env.DB.prepare(q).bind(...params).all()
  return json(c, rows.results)
})

// GET /api/opportunities/:id?companyId=
app.get('/api/opportunities/:id', async (c) => {
  const companyId = c.req.query('companyId') || 'avalon'
  const row = await c.env.DB.prepare(
    'SELECT * FROM opportunities WHERE id = ? AND company_id = ? LIMIT 1'
  ).bind(c.req.param('id'), companyId).first()
  if (!row) return err(c, 'Not found', 404)
  return json(c, row)
})

// POST /api/opportunities
app.post('/api/opportunities', async (c) => {
  const b = await c.req.json()
  const id        = b.id || ('opp_' + uid())
  const companyId = b.companyId || b.company_id || 'avalon'
  await c.env.DB.prepare(`
    INSERT INTO opportunities (
      id, company_id, rep_id, client, phone, email, address, service_line, source, status,
      job_value, project, urgency, decision_maker, budget_range, next_follow_up,
      pipeline_stage, estimate_amount, estimate_sent_date, estimate_count,
      work_type, client_type, prompt, desired_outcome, fit_concerns,
      commission_approved, collected, sold_date, sold_amount,
      created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
  `).bind(
    id, companyId, b.repId||b.rep_id||null, b.client||'', b.phone||'', b.email||'',
    b.address||'', b.serviceLine||b.service_line||'', b.source||'',
    b.status||'New Lead', Number(b.jobValue||b.job_value||0),
    b.project||'', b.urgency||'', b.decisionMaker||b.decision_maker||'',
    b.budgetRange||b.budget_range||'', b.nextFollowUp||b.next_follow_up||'',
    b.pipelineStage||b.pipeline_stage||'',
    Number(b.estimateAmount||b.estimate_amount||0),
    b.estimateSentDate||b.estimate_sent_date||'',
    Number(b.estimateCount||b.estimate_count||0),
    b.workType||b.work_type||'', b.clientType||b.client_type||'',
    b.prompt||'', b.desiredOutcome||b.desired_outcome||'',
    b.fitConcerns||b.fit_concerns||'',
    b.commissionApproved||b.commission_approved?1:0,
    b.collected?1:0, b.soldDate||b.sold_date||'',
    Number(b.soldAmount||b.sold_amount||0)
  ).run()
  return json(c, { id }, 201)
})

// PUT /api/opportunities/:id
app.put('/api/opportunities/:id', async (c) => {
  const id        = c.req.param('id')
  const b         = await c.req.json()
  const companyId = b.companyId || b.company_id || 'avalon'
  const fieldMap: Record<string,string> = {
    repId:'rep_id', client:'client', phone:'phone', email:'email',
    address:'address', serviceLine:'service_line', source:'source',
    status:'status', jobValue:'job_value', project:'project',
    urgency:'urgency', decisionMaker:'decision_maker', budgetRange:'budget_range',
    nextFollowUp:'next_follow_up', pipelineStage:'pipeline_stage',
    estimateAmount:'estimate_amount', estimateSentDate:'estimate_sent_date',
    estimateCount:'estimate_count', workType:'work_type', clientType:'client_type',
    prompt:'prompt', desiredOutcome:'desired_outcome', fitConcerns:'fit_concerns',
    commissionApproved:'commission_approved', collected:'collected',
    soldDate:'sold_date', soldAmount:'sold_amount',
    rep_id:'rep_id', service_line:'service_line', job_value:'job_value',
    decision_maker:'decision_maker', budget_range:'budget_range',
    next_follow_up:'next_follow_up', pipeline_stage:'pipeline_stage',
    estimate_amount:'estimate_amount', estimate_sent_date:'estimate_sent_date',
    estimate_count:'estimate_count', work_type:'work_type', client_type:'client_type',
    desired_outcome:'desired_outcome', fit_concerns:'fit_concerns',
    commission_approved:'commission_approved', sold_date:'sold_date', sold_amount:'sold_amount'
  }
  const updates: string[] = []
  const vals: any[] = []
  for (const [key, col] of Object.entries(fieldMap)) {
    if (b[key] !== undefined && !updates.includes(`${col} = ?`)) {
      updates.push(`${col} = ?`)
      vals.push(b[key])
    }
  }
  if (!updates.length) return err(c, 'Nothing to update')
  await c.env.DB.prepare(
    `UPDATE opportunities SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ? AND company_id = ?`
  ).bind(...vals, id, companyId).run()
  return json(c, { updated: id })
})

// DELETE /api/opportunities/:id?companyId=
app.delete('/api/opportunities/:id', async (c) => {
  const id        = c.req.param('id')
  const companyId = c.req.query('companyId') || 'avalon'
  await c.env.DB.prepare('DELETE FROM opportunities WHERE id = ? AND company_id = ?').bind(id, companyId).run()
  return json(c, { deleted: id })
})

// ══════════════════════════════════════════════════════════════════════════════
// NOTES  — scoped via opp_id (opp already scoped to company)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/opportunities/:oppId/notes
app.get('/api/opportunities/:oppId/notes', async (c) => {
  const companyId = c.req.query('companyId') || 'avalon'
  const rows = await c.env.DB.prepare(
    'SELECT * FROM notes WHERE opp_id = ? AND company_id = ? ORDER BY created_at DESC'
  ).bind(c.req.param('oppId'), companyId).all()
  return json(c, rows.results)
})

// POST /api/opportunities/:oppId/notes
app.post('/api/opportunities/:oppId/notes', async (c) => {
  const oppId     = c.req.param('oppId')
  const b         = await c.req.json()
  const companyId = b.companyId || 'avalon'
  if (!b.body?.trim()) return err(c, 'body required')
  const id = 'note_' + uid()
  await c.env.DB.prepare(
    'INSERT INTO notes (id, opp_id, rep_id, body, company_id) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, oppId, b.repId||null, b.body.trim(), companyId).run()
  return json(c, { id }, 201)
})

// DELETE /api/notes/:id?companyId=
app.delete('/api/notes/:id', async (c) => {
  const companyId = c.req.query('companyId') || 'avalon'
  await c.env.DB.prepare('DELETE FROM notes WHERE id = ? AND company_id = ?').bind(c.req.param('id'), companyId).run()
  return json(c, { deleted: c.req.param('id') })
})

// ══════════════════════════════════════════════════════════════════════════════
// COMMUNICATIONS  — scoped by company_id
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/opportunities/:oppId/comms
app.get('/api/opportunities/:oppId/comms', async (c) => {
  const companyId = c.req.query('companyId') || 'avalon'
  const rows = await c.env.DB.prepare(
    'SELECT * FROM communications WHERE opp_id = ? AND company_id = ? ORDER BY ts DESC'
  ).bind(c.req.param('oppId'), companyId).all()
  return json(c, rows.results)
})

// POST /api/opportunities/:oppId/comms
app.post('/api/opportunities/:oppId/comms', async (c) => {
  const oppId     = c.req.param('oppId')
  const b         = await c.req.json()
  const companyId = b.companyId || 'avalon'
  const id = 'comm_' + uid()
  await c.env.DB.prepare(
    "INSERT INTO communications (id, opp_id, rep_id, type, direction, subject, body, ts, company_id) VALUES (?,?,?,?,?,?,?,datetime('now'),?)"
  ).bind(id, oppId, b.repId||null, b.type||'note', b.direction||'out', b.subject||'', b.body||'', companyId).run()
  return json(c, { id }, 201)
})

// GET /api/comms?companyId=&repId=  (activity log)
app.get('/api/comms', async (c) => {
  const companyId = c.req.query('companyId') || 'avalon'
  const repId     = c.req.query('repId')
  let q = 'SELECT * FROM communications WHERE company_id = ?'
  const params: any[] = [companyId]
  if (repId) { q += ' AND rep_id = ?'; params.push(repId) }
  q += ' ORDER BY ts DESC LIMIT 200'
  const rows = await c.env.DB.prepare(q).bind(...params).all()
  return json(c, rows.results)
})

// ══════════════════════════════════════════════════════════════════════════════
// FILES
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/opportunities/:oppId/files', async (c) => {
  const companyId = c.req.query('companyId') || 'avalon'
  const rows = await c.env.DB.prepare(
    'SELECT * FROM files WHERE opp_id = ? AND company_id = ? ORDER BY created_at DESC'
  ).bind(c.req.param('oppId'), companyId).all()
  return json(c, rows.results)
})

app.post('/api/opportunities/:oppId/files', async (c) => {
  const oppId     = c.req.param('oppId')
  const b         = await c.req.json()
  const companyId = b.companyId || 'avalon'
  const id = 'file_' + uid()
  await c.env.DB.prepare(
    'INSERT INTO files (id, opp_id, rep_id, name, size, mime_type, url, company_id) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(id, oppId, b.repId||null, b.name||'', b.size||0, b.mimeType||'', b.url||'', companyId).run()
  return json(c, { id }, 201)
})

// ══════════════════════════════════════════════════════════════════════════════
// CHECKLIST PROGRESS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/checklist/:oppId', async (c) => {
  const companyId = c.req.query('companyId') || 'avalon'
  const rows = await c.env.DB.prepare(
    'SELECT * FROM checklist_progress WHERE opp_id = ? AND company_id = ?'
  ).bind(c.req.param('oppId'), companyId).all()
  return json(c, rows.results)
})

app.put('/api/checklist', async (c) => {
  const b = await c.req.json()
  const { oppId, checklistId, itemIndex, checked } = b
  const companyId = b.companyId || 'avalon'
  const id = `check-${checklistId}-${oppId}-${itemIndex}`
  await c.env.DB.prepare(`
    INSERT INTO checklist_progress (id, opp_id, checklist_id, item_index, checked, company_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(opp_id, checklist_id, item_index) DO UPDATE SET
      checked = excluded.checked, updated_at = datetime('now')
  `).bind(id, oppId, checklistId, itemIndex, checked ? 1 : 0, companyId).run()
  return json(c, { id })
})

// ══════════════════════════════════════════════════════════════════════════════
// ACADEMY PROGRESS  — scoped by company_id
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/academy/progress/:repId', async (c) => {
  const companyId = c.req.query('companyId') || 'avalon'
  const rows = await c.env.DB.prepare(
    'SELECT * FROM academy_progress WHERE rep_id = ? AND company_id = ?'
  ).bind(c.req.param('repId'), companyId).all()
  return json(c, rows.results)
})

app.put('/api/academy/progress', async (c) => {
  const b = await c.req.json()
  const { repId, moduleId, sectionId, completed, score } = b
  const companyId = b.companyId || 'avalon'
  const id = `acad-${companyId}-${repId}-${moduleId}-${sectionId||'_'}`
  await c.env.DB.prepare(`
    INSERT INTO academy_progress (id, rep_id, module_id, section_id, completed, score, company_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(rep_id, module_id, section_id) DO UPDATE SET
      completed = excluded.completed, score = excluded.score, updated_at = datetime('now')
  `).bind(id, repId, moduleId, sectionId||null, completed?1:0, score||0, companyId).run()
  return json(c, { id })
})

app.get('/api/academy/quiz/:repId', async (c) => {
  const companyId = c.req.query('companyId') || 'avalon'
  const rows = await c.env.DB.prepare(
    'SELECT * FROM quiz_attempts WHERE rep_id = ? AND company_id = ? ORDER BY attempted_at DESC'
  ).bind(c.req.param('repId'), companyId).all()
  return json(c, rows.results)
})

app.post('/api/academy/quiz', async (c) => {
  const b = await c.req.json()
  const companyId = b.companyId || 'avalon'
  const id = 'quiz_' + uid()
  await c.env.DB.prepare(
    'INSERT INTO quiz_attempts (id, rep_id, module_id, score, total, passed, answers, company_id) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(id, b.repId, b.moduleId, b.score||0, b.total||0, b.passed?1:0, JSON.stringify(b.answers||[]), companyId).run()
  return json(c, { id }, 201)
})

app.get('/api/academy/badges/:repId', async (c) => {
  const companyId = c.req.query('companyId') || 'avalon'
  const rows = await c.env.DB.prepare(
    'SELECT * FROM badges WHERE rep_id = ? AND company_id = ?'
  ).bind(c.req.param('repId'), companyId).all()
  return json(c, rows.results)
})

app.post('/api/academy/badges', async (c) => {
  const b = await c.req.json()
  const { repId, badgeId } = b
  const companyId = b.companyId || 'avalon'
  const id = `badge-${companyId}-${repId}-${badgeId}`
  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO badges (id, rep_id, badge_id, company_id) VALUES (?,?,?,?)'
  ).bind(id, repId, badgeId, companyId).run()
  return json(c, { id }, 201)
})

app.get('/api/academy/certs/:repId', async (c) => {
  const companyId = c.req.query('companyId') || 'avalon'
  const rows = await c.env.DB.prepare(
    'SELECT * FROM certifications WHERE rep_id = ? AND company_id = ?'
  ).bind(c.req.param('repId'), companyId).all()
  return json(c, rows.results)
})

app.put('/api/academy/certs', async (c) => {
  const b = await c.req.json()
  const { repId, phaseId, status } = b
  const companyId = b.companyId || 'avalon'
  const id = `cert-${companyId}-${repId}-${phaseId}`
  await c.env.DB.prepare(`
    INSERT INTO certifications (id, rep_id, phase_id, status, company_id, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(rep_id, phase_id) DO UPDATE SET status = excluded.status, updated_at = datetime('now')
  `).bind(id, repId, phaseId, status||'not_started', companyId).run()
  return json(c, { id })
})

// ══════════════════════════════════════════════════════════════════════════════
// CLIENTS  — scoped by company_id
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/clients', async (c) => {
  const companyId = c.req.query('companyId') || 'avalon'
  const rows = await c.env.DB.prepare(
    'SELECT * FROM clients WHERE company_id = ? ORDER BY name ASC'
  ).bind(companyId).all()
  return json(c, rows.results)
})

app.post('/api/clients', async (c) => {
  const b = await c.req.json()
  const id        = b.id || ('client_' + uid())
  const companyId = b.companyId || b.company_id || 'avalon'
  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO clients (id, name, phone, email, address, type, notes, company_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))"
  ).bind(id, b.name||'', b.phone||'', b.email||'', b.address||'', b.type||'Residential', b.notes||'', companyId).run()
  return json(c, { id }, 201)
})

app.put('/api/clients/:id', async (c) => {
  const id        = c.req.param('id')
  const b         = await c.req.json()
  const companyId = b.companyId || b.company_id || 'avalon'
  await c.env.DB.prepare(
    "UPDATE clients SET name=?, phone=?, email=?, address=?, type=?, notes=?, updated_at=datetime('now') WHERE id=? AND company_id=?"
  ).bind(b.name||'', b.phone||'', b.email||'', b.address||'', b.type||'Residential', b.notes||'', id, companyId).run()
  return json(c, { updated: id })
})

app.delete('/api/clients/:id', async (c) => {
  const companyId = c.req.query('companyId') || 'avalon'
  await c.env.DB.prepare('DELETE FROM clients WHERE id = ? AND company_id = ?').bind(c.req.param('id'), companyId).run()
  return json(c, { deleted: c.req.param('id') })
})

// ══════════════════════════════════════════════════════════════════════════════
// SETTINGS  — namespaced per company: key stored as "{companyId}:{key}"
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/settings', async (c) => {
  const companyId = c.req.query('companyId') || 'avalon'
  const prefix    = `${companyId}:`
  const rows = await c.env.DB.prepare(
    "SELECT key, value FROM settings WHERE key LIKE ? AND key NOT LIKE 'session_%'"
  ).bind(`${prefix}%`).all()
  const obj: Record<string,string> = {}
  for (const r of (rows.results as any[])) {
    // Strip the company prefix before returning to client
    obj[r.key.slice(prefix.length)] = r.value
  }
  // Also include legacy keys (no prefix) for backward compat
  const legacy = await c.env.DB.prepare(
    "SELECT key, value FROM settings WHERE key NOT LIKE '%:%' AND key NOT LIKE 'session_%' AND key NOT LIKE 'db_%'"
  ).all()
  for (const r of (legacy.results as any[])) obj[r.key] = r.value
  return json(c, obj)
})

app.put('/api/settings', async (c) => {
  const b = await c.req.json()
  if (!b.key) return err(c, 'key required')
  const companyId = b.companyId || 'avalon'
  const scopedKey = b.key.includes(':') ? b.key : `${companyId}:${b.key}`
  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
  ).bind(scopedKey, String(b.value)).run()
  return json(c, { key: b.key })
})

// ══════════════════════════════════════════════════════════════════════════════
// REVENUE ACTUALS  — scoped by company_id
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/revenue', async (c) => {
  const companyId = c.req.query('companyId') || 'avalon'
  const rows = await c.env.DB.prepare(
    'SELECT * FROM revenue_actuals WHERE company_id = ? ORDER BY year, month'
  ).bind(companyId).all()
  return json(c, rows.results)
})

app.put('/api/revenue', async (c) => {
  const b         = await c.req.json()
  const companyId = b.companyId || 'avalon'
  await c.env.DB.prepare(`
    INSERT INTO revenue_actuals (id, company_id, month, year, revenue, note, division, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(company_id, month, year, division) DO UPDATE SET
      revenue = excluded.revenue, note = excluded.note, updated_at = datetime('now')
  `).bind(
    `rev-${companyId}-${b.month}-${b.year||2026}-${b.division||'total'}`,
    companyId, b.month, b.year||2026, b.revenue||0, b.note||'', b.division||'total'
  ).run()
  return json(c, { updated: true })
})

// ══════════════════════════════════════════════════════════════════════════════
// BULK SYNC  — localStorage → D1 one-time migration, company-scoped
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/sync', async (c) => {
  const b = await c.req.json()
  const { opportunities = [], notes = [], communications = [], clients = [] } = b
  const companyId = b.companyId || 'avalon'
  const stmts: D1PreparedStatement[] = []

  for (const o of opportunities) {
    stmts.push(c.env.DB.prepare(`
      INSERT OR REPLACE INTO opportunities (
        id, company_id, rep_id, client, phone, email, address, service_line, source, status,
        job_value, project, urgency, decision_maker, budget_range, next_follow_up,
        pipeline_stage, estimate_amount, estimate_sent_date, estimate_count,
        work_type, client_type, prompt, desired_outcome, fit_concerns,
        commission_approved, collected, sold_date, sold_amount, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      o.id||('opp_'+uid()), companyId, o.repId||o.rep_id||null,
      o.client||'', o.phone||'', o.email||'',
      o.address||'', o.serviceLine||o.service_line||'', o.source||'', o.status||'New Lead',
      Number(o.jobValue||o.job_value||0), o.project||'', o.urgency||'',
      o.decisionMaker||o.decision_maker||'', o.budgetRange||o.budget_range||'',
      o.nextFollowUp||o.next_follow_up||'', o.pipelineStage||o.pipeline_stage||'',
      Number(o.estimateAmount||o.estimate_amount||0),
      o.estimateSentDate||o.estimate_sent_date||'',
      Number(o.estimateCount||o.estimate_count||0),
      o.workType||o.work_type||'', o.clientType||o.client_type||'',
      o.prompt||'', o.desiredOutcome||o.desired_outcome||'',
      o.fitConcerns||o.fit_concerns||'',
      o.commissionApproved||o.commission_approved?1:0,
      o.collected?1:0, o.soldDate||o.sold_date||'',
      Number(o.soldAmount||o.sold_amount||0),
      o.createdAt||o.created_at||new Date().toISOString(),
      o.updatedAt||o.updated_at||new Date().toISOString()
    ))
  }
  for (const n of notes) {
    stmts.push(c.env.DB.prepare(
      'INSERT OR IGNORE INTO notes (id, opp_id, rep_id, body, company_id, created_at) VALUES (?,?,?,?,?,?)'
    ).bind(n.id||('note_'+uid()), n.oppId||n.opp_id, n.repId||n.rep_id||null, n.body||'', companyId, n.createdAt||n.created_at||new Date().toISOString()))
  }
  for (const m of communications) {
    stmts.push(c.env.DB.prepare(
      'INSERT OR IGNORE INTO communications (id, opp_id, rep_id, type, direction, subject, body, ts, company_id) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(m.id||('comm_'+uid()), m.oppId||m.opp_id, m.repId||m.rep_id||null, m.type||'note', m.direction||'out', m.subject||'', m.body||'', m.ts||new Date().toISOString(), companyId))
  }
  for (const cl of clients) {
    stmts.push(c.env.DB.prepare(
      "INSERT OR IGNORE INTO clients (id, name, phone, email, address, type, notes, company_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).bind(cl.id||('client_'+uid()), cl.name||'', cl.phone||'', cl.email||'', cl.address||'', cl.type||'Residential', cl.notes||'', companyId, cl.createdAt||new Date().toISOString(), cl.updatedAt||new Date().toISOString()))
  }
  if (stmts.length) await c.env.DB.batch(stmts)
  return json(c, { synced: stmts.length, companyId })
})

// ══════════════════════════════════════════════════════════════════════════════
// PASSWORD RESET
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/auth/reset-request  { email } OR { repId, companyId }
// Sends a 6-digit OTP to the rep's email. OTP expires in 1 hour.
app.post('/api/auth/reset-request', async (c) => {
  const body = await c.req.json()
  const { email, repId, companyId } = body
  let rep: any = null
  if (email) {
    // Email-based lookup (preferred — used by frontend forgot-PIN flow)
    rep = await c.env.DB.prepare(
      'SELECT id, name, email, company_id FROM reps WHERE email = ? AND active = 1 LIMIT 1'
    ).bind(email.toLowerCase().trim()).first<any>()
  } else if (repId && companyId) {
    rep = await c.env.DB.prepare(
      'SELECT id, name, email, company_id FROM reps WHERE id = ? AND company_id = ? AND active = 1 LIMIT 1'
    ).bind(repId, companyId).first<any>()
  } else {
    return err(c, 'email required')
  }
  // Always return ok to prevent enumeration
  if (!rep || !rep.email) return json(c, { sent: false, reason: 'no_email' })

  const otp = String(Math.floor(100000 + Math.random() * 900000)) // 6-digit
  const otpHash = await hashPin(otp) // store hashed OTP
  const exp = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  await c.env.DB.prepare(
    "UPDATE reps SET reset_token = ?, reset_token_exp = ? WHERE id = ? AND company_id = ?"
  ).bind(otpHash, exp, rep.id, rep.company_id).run()

  const sent = c.env.SENDGRID_API_KEY ? await sendEmail(
    c.env.SENDGRID_API_KEY, rep.email,
    'Your Groundwork CRM password reset code',
    `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#F5F9F7;font-family:Inter,Arial,sans-serif">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F9F7;padding:48px 20px">
      <tr><td align="center">
        <table width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 8px 40px rgba(30,70,56,.10)">
          <!-- Header -->
          <tr><td style="background:linear-gradient(135deg,#0E372F 0%,#113931 60%,#1A4740 100%);padding:36px 40px 32px;text-align:center">
            <div style="display:inline-block;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);border-radius:14px;padding:10px 18px;margin-bottom:18px">
              <span style="font-size:20px;font-weight:900;color:#ffffff;letter-spacing:-.04em">Groundwork</span>
              <span style="font-size:11px;font-weight:600;color:rgba(255,255,255,.5);letter-spacing:.12em;text-transform:uppercase;display:block;margin-top:1px">CRM</span>
            </div>
            <h1 style="margin:0;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-.03em">Your password reset code</h1>
            <p style="margin:8px 0 0;color:rgba(255,255,255,.55);font-size:14px">Use this to set a new password</p>
          </td></tr>
          <!-- Body -->
          <tr><td style="padding:36px 40px 20px">
            <p style="margin:0 0 28px;font-size:15px;color:#5A6B79;line-height:1.6">Hi <strong style="color:#0F1C14">${rep.name}</strong>, here is your one-time reset code for Groundwork CRM:</p>
            <!-- OTP block -->
            <div style="background:#F5F9F7;border:1.5px solid #E2EBE8;border-radius:14px;padding:28px;text-align:center;margin-bottom:28px">
              <span style="font-size:52px;font-weight:900;letter-spacing:10px;color:#113931;display:block;line-height:1">${otp}</span>
              <p style="margin:12px 0 0;font-size:12px;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:.1em">One-time code · expires in 1 hour</p>
            </div>
            <p style="margin:0 0 12px;font-size:13px;color:#94A3B8;line-height:1.6">Enter this code in the Groundwork CRM app when prompted to set your new password. If you didn't request this, you can safely ignore this email — your account remains secure.</p>
          </td></tr>
          <!-- Footer -->
          <tr><td style="padding:20px 40px 36px;border-top:1px solid #E2EBE8;text-align:center">
            <p style="margin:0;font-size:11px;color:#C8D8D3;font-weight:600;letter-spacing:.08em;text-transform:uppercase">Groundwork CRM · Sent automatically · Do not reply</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
    </body></html>`
  ) : false

  return json(c, { sent, email: rep.email.replace(/(.{2}).+(@.+)/, '$1***$2') })
})

// POST /api/auth/reset-pin  { email, token, new_pin|new_password } OR { repId, companyId, otp, newPin }
app.post('/api/auth/reset-pin', async (c) => {
  const body = await c.req.json()
  // Support email+password shape, and legacy repId+PIN shape
  const email  = body.email
  const otp    = body.token       || body.otp
  const newPin = body.new_password || body.new_pin  || body.newPin
  const repId  = body.repId
  const companyId = body.companyId
  if (!otp || !newPin) return err(c, 'token and new_pin required')
  let rep: any = null
  if (email) {
    rep = await c.env.DB.prepare(
      'SELECT id, reset_token, reset_token_exp, company_id FROM reps WHERE email = ? AND active = 1 LIMIT 1'
    ).bind(email.toLowerCase().trim()).first<any>()
  } else if (repId && companyId) {
    rep = await c.env.DB.prepare(
      'SELECT id, reset_token, reset_token_exp, company_id FROM reps WHERE id = ? AND company_id = ? AND active = 1 LIMIT 1'
    ).bind(repId, companyId).first<any>()
  } else {
    return err(c, 'email or repId+companyId required')
  }
  if (!rep || !rep.reset_token) return err(c, 'No reset requested', 400)
  if (new Date(rep.reset_token_exp) < new Date()) return err(c, 'Code expired', 400)
  const valid = await verifyPin(String(otp), rep.reset_token)
  if (!valid) return err(c, 'Invalid code', 401)
  const newHash = await hashPin(String(newPin))
  await c.env.DB.prepare(
    "UPDATE reps SET pin_hash = ?, pin = '', reset_token = '', reset_token_exp = '' WHERE id = ? AND company_id = ?"
  ).bind(newHash, rep.id, rep.company_id).run()
  return json(c, { reset: true })
})

// ══════════════════════════════════════════════════════════════════════════════
// COMPANY ONBOARDING  (public signup — no auth required)
// ══════════════════════════════════════════════════════════════════════════════

// GET /onboard  — serve the public signup page  (GW-015 rebranded)
app.get('/onboard', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Get Started — Groundwork CRM</title>
  <meta name="theme-color" content="#113931" />
  <meta name="description" content="Set up your team on Groundwork CRM in 2 minutes." />
  <link rel="icon" type="image/png" href="/static/avalon-logo.png" />
  <link rel="icon" type="image/x-icon" href="/static/favicon.ico" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{
      font-family:Inter,sans-serif;
      background:linear-gradient(160deg,#0E372F 0%,#113931 45%,#0E372F 100%);
      min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
    }
    /* Decorative ring behind card */
    body::before{
      content:'';position:fixed;top:-120px;right:-120px;
      width:440px;height:440px;
      background:radial-gradient(circle,rgba(16,185,129,.08) 0%,transparent 70%);
      pointer-events:none;
    }
    .card{
      background:#ffffff;
      border-radius:24px;
      padding:0;
      width:100%;max-width:500px;
      box-shadow:0 32px 80px rgba(0,0,0,.25);
      overflow:hidden;
      position:relative;
    }
    /* Pine header strip */
    .card-header{
      background:linear-gradient(135deg,#0E372F 0%,#113931 60%,#1A4740 100%);
      padding:30px 36px 28px;
      text-align:center;
    }
    .logo-pill{
      display:inline-flex;align-items:center;gap:10px;
      background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.18);
      border-radius:14px;padding:8px 16px 8px 12px;margin-bottom:16px;
    }
    .logo-pill img{width:28px;height:28px;object-fit:contain;filter:brightness(0) invert(1);opacity:.9;border-radius:6px}
    .logo-pill-text{font-size:17px;font-weight:900;color:#fff;letter-spacing:-.03em;line-height:1}
    .logo-pill-sub{font-size:9px;font-weight:700;color:rgba(255,255,255,.45);letter-spacing:.13em;text-transform:uppercase;margin-top:1px}
    .card-header h1{margin:0;font-size:20px;font-weight:800;color:#fff;letter-spacing:-.03em}
    .card-header p{margin:6px 0 0;color:rgba(255,255,255,.52);font-size:13px}
    .card-body{padding:32px 36px 36px}
    h1.step-title{font-size:24px;font-weight:800;margin-bottom:6px;color:#0F1C14;letter-spacing:-.03em}
    p.sub{color:#5A6B79;font-size:14px;margin-bottom:24px;line-height:1.55}
    label{display:block;font-size:12px;font-weight:700;color:#5A6B79;margin-bottom:5px;letter-spacing:.02em;text-transform:uppercase}
    input,select{
      width:100%;padding:11px 14px;
      background:#F5F9F7;border:1.5px solid #E2EBE8;
      border-radius:10px;color:#0F1C14;font-size:14px;
      font-family:inherit;outline:none;transition:border-color .15s,box-shadow .15s;
    }
    input:focus,select:focus{border-color:#113931;box-shadow:0 0 0 3px rgba(30,70,56,.12)}
    input::placeholder{color:#94A3B8}
    .field{margin-bottom:16px}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    .hint{font-size:11px;color:#94A3B8;margin-top:4px}
    .slug-preview{font-size:12px;color:#113931;margin-top:4px;font-weight:700}
    button[type=submit]{
      width:100%;padding:13px;
      background:#113931;color:#fff;
      font-size:15px;font-weight:700;
      border:none;border-radius:12px;cursor:pointer;
      margin-top:6px;transition:background .15s,box-shadow .15s;
      font-family:inherit;
      box-shadow:0 4px 16px rgba(30,70,56,.3);
    }
    button[type=submit]:hover{background:#1A4740;box-shadow:0 6px 22px rgba(30,70,56,.38)}
    button[type=submit]:disabled{background:#C8D8D3;box-shadow:none;cursor:not-allowed}
    .step{display:none}.step.active{display:block}
    /* Success state */
    .success-ring{
      width:68px;height:68px;border-radius:50%;
      background:linear-gradient(135deg,#113931,#10B981);
      display:flex;align-items:center;justify-content:center;
      font-size:28px;margin:0 auto 18px;
      box-shadow:0 8px 24px rgba(16,185,129,.3);
    }
    .creds{
      background:#F5F9F7;border:1px solid #E2EBE8;
      border-radius:12px;padding:18px;margin:18px 0 24px;
      font-size:14px;
    }
    .creds .row-item{
      display:flex;justify-content:space-between;align-items:center;
      padding:7px 0;border-bottom:1px solid #E2EBE8;
    }
    .creds .row-item:last-child{border-bottom:none}
    .creds .cred-label{font-size:11px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:.07em}
    .creds .cred-val{font-size:14px;font-weight:700;color:#0F1C14;font-family:monospace}
    .open-btn{
      display:block;width:100%;padding:13px;
      background:#113931;color:#fff;
      font-size:15px;font-weight:700;border-radius:12px;
      text-align:center;text-decoration:none;
      box-shadow:0 4px 16px rgba(30,70,56,.3);
      transition:background .15s;
    }
    .open-btn:hover{background:#1A4740}
    .error{
      background:#FEF2F2;border:1px solid #FECACA;
      color:#991B1B;padding:11px 14px;border-radius:10px;
      font-size:13px;margin-bottom:14px;display:none;
    }
    .spinner{display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:7px}
    @keyframes spin{to{transform:rotate(360deg)}}
    @media(max-width:520px){
      .card-header{padding:24px 24px 22px}.card-body{padding:24px 24px 28px}
      .row{grid-template-columns:1fr}
    }
  </style>
</head>
<body>
<div class="card">
  <!-- Pine header -->
  <div class="card-header">
    <div class="logo-pill">
      <img src="/static/avalon-logo.png" alt="Groundwork CRM">
      <div>
        <div class="logo-pill-text">Groundwork</div>
        <div class="logo-pill-sub">CRM</div>
      </div>
    </div>
    <h1>Set up your workspace</h1>
    <p>Get your crew live in 2 minutes. No credit card required.</p>
  </div>

  <div class="card-body">

    <!-- Step 1: Company info -->
    <div class="step active" id="step1">
      <div id="errorBox" class="error"></div>
      <form id="onboardForm">
        <div class="field">
          <label>Company name</label>
          <input type="text" id="companyName" placeholder="Apex Landscaping" required autocomplete="organization">
          <div class="slug-preview" id="slugPreview"></div>
        </div>
        <div class="row">
          <div class="field">
            <label>Your name</label>
            <input type="text" id="ownerName" placeholder="Tyler" required autocomplete="given-name">
          </div>
          <div class="field">
            <label>Your role</label>
            <select id="ownerRole">
              <option value="admin">Owner / Admin</option>
              <option value="office_manager">Office Manager</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label>Work email <span style="font-weight:400;text-transform:none;letter-spacing:0;color:#94A3B8">(for PIN reset)</span></label>
          <input type="email" id="ownerEmail" placeholder="tyler@yourbusiness.com" autocomplete="email">
        </div>
        <div class="row">
          <div class="field">
            <label>Login ID</label>
            <input type="text" id="ownerId" placeholder="tyler" required autocomplete="username" pattern="[a-z0-9_-]+" title="lowercase letters, numbers, - _">
            <div class="hint">Lowercase, no spaces</div>
          </div>
          <div class="field">
            <label>Choose a PIN</label>
            <input type="password" id="ownerPin" placeholder="4–8 digits" required minlength="4" maxlength="8" inputmode="numeric">
          </div>
        </div>
        <button type="submit" id="submitBtn">Create my account →</button>
      </form>
    </div>

    <!-- Step 2: Success -->
    <div class="step" id="step2">
      <div class="success-ring">✓</div>
      <h1 class="step-title" style="text-align:center">You're all set!</h1>
      <p class="sub" style="text-align:center">Your Groundwork CRM workspace is ready. Save these credentials.</p>
      <div class="creds">
        <div class="row-item">
          <span class="cred-label">Company ID</span>
          <span class="cred-val" id="s2company"></span>
        </div>
        <div class="row-item">
          <span class="cred-label">Login ID</span>
          <span class="cred-val" id="s2repId"></span>
        </div>
        <div class="row-item">
          <span class="cred-label">PIN</span>
          <span class="cred-val" id="s2pin"></span>
        </div>
      </div>
      <a href="/" class="open-btn">Open Groundwork CRM →</a>
    </div>

  </div>
</div>

<script>
  // Auto-generate slug from company name
  const nameEl = document.getElementById('companyName')
  const slugEl = document.getElementById('slugPreview')
  function toSlug(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,30)
  }
  nameEl.addEventListener('input', () => {
    const slug = toSlug(nameEl.value)
    slugEl.textContent = slug ? 'Your company ID: ' + slug : ''
  })

  document.getElementById('onboardForm').addEventListener('submit', async (e) => {
    e.preventDefault()
    const btn = document.getElementById('submitBtn')
    const errBox = document.getElementById('errorBox')
    errBox.style.display = 'none'
    btn.disabled = true
    btn.innerHTML = '<span class="spinner"></span>Creating account…'

    const companyName = nameEl.value.trim()
    const slug        = toSlug(companyName)
    const ownerName   = document.getElementById('ownerName').value.trim()
    const ownerRole   = document.getElementById('ownerRole').value
    const ownerEmail  = document.getElementById('ownerEmail').value.trim()
    const ownerId     = document.getElementById('ownerId').value.trim().toLowerCase()
    const ownerPin    = document.getElementById('ownerPin').value

    try {
      // 1. Create company
      const cRes = await fetch('/api/companies', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ name: companyName, slug, ownerEmail, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
      })
      const cData = await cRes.json()
      if (!cData.ok) throw new Error(cData.error || 'Company creation failed')

      // 2. Create owner rep
      const rRes = await fetch('/api/reps', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ id: ownerId, name: ownerName, role: ownerRole, pin: ownerPin, email: ownerEmail, companyId: slug, color: '#00A7E1' })
      })
      const rData = await rRes.json()
      if (!rData.ok) throw new Error(rData.error || 'Rep creation failed')

      // 3. Show success
      document.getElementById('s2company').textContent = slug
      document.getElementById('s2repId').textContent   = ownerId
      document.getElementById('s2pin').textContent     = ownerPin
      document.getElementById('step1').classList.remove('active')
      document.getElementById('step2').classList.add('active')
    } catch(err) {
      errBox.textContent = err.message
      errBox.style.display = 'block'
      btn.disabled = false
      btn.textContent = 'Create my account →'
    }
  })
</script>
</body>
</html>`)
})

// ══════════════════════════════════════════════════════════════════════════════
// TIME TRACKING  — clock-in/out, weekly timesheets, payroll approval
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/time/active?companyId=   — currently open entry for logged-in rep
app.get('/api/time/active', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId as string
  const row = await c.env.DB.prepare(
    `SELECT * FROM time_entries WHERE rep_id=? AND company_id=? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1`
  ).bind(repId, companyId).first()
  return json(c, row || null)
})

// POST /api/time/clock-in   { jobType?, notes? }
app.post('/api/time/clock-in', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId as string
  // Check not already clocked in
  const open = await c.env.DB.prepare(
    `SELECT id FROM time_entries WHERE rep_id=? AND company_id=? AND clock_out IS NULL LIMIT 1`
  ).bind(repId, companyId).first<{ id: string }>()
  if (open) return err(c, 'Already clocked in', 409)
  const b = await c.req.json().catch(() => ({})) as any
  const id = 'te_' + uid()
  const now = new Date().toISOString()
  await c.env.DB.prepare(
    `INSERT INTO time_entries (id,rep_id,company_id,clock_in,job_type,notes,approved)
     VALUES (?,?,?,?,?,?,0)`
  ).bind(id, repId, companyId, now, b.jobType||'General Work', b.notes||'').run()
  return json(c, { id, clock_in: now }, 201)
})

// POST /api/time/clock-out   { entryId?, notes? }
app.post('/api/time/clock-out', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId as string
  const b = await c.req.json().catch(() => ({})) as any
  const entry = await c.env.DB.prepare(
    `SELECT * FROM time_entries WHERE rep_id=? AND company_id=? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1`
  ).bind(repId, companyId).first<any>()
  if (!entry) return err(c, 'Not clocked in', 404)
  const now    = new Date()
  const clockIn = new Date(entry.clock_in)
  const durMin = Math.round((now.getTime() - clockIn.getTime()) / 60000)
  await c.env.DB.prepare(
    `UPDATE time_entries SET clock_out=?, duration_min=?, notes=?, updated_at=datetime('now')
     WHERE id=? AND company_id=?`
  ).bind(now.toISOString(), durMin, b.notes ?? entry.notes, entry.id, companyId).run()
  return json(c, { id: entry.id, duration_min: durMin })
})

// GET /api/time/entries?companyId=&repId=&from=&to=&approved=
app.get('/api/time/entries', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role      = c.var.role as string
  const myRepId   = c.var.repId as string
  // Non-admins can only see their own entries
  const targetRep = (role === 'admin' || role === 'office_manager')
    ? (c.req.query('repId') || null)
    : myRepId
  const from = c.req.query('from') || new Date(Date.now() - 7*86400000).toISOString().slice(0,10)
  const to   = c.req.query('to')   || new Date(Date.now() + 86400000).toISOString().slice(0,10)
  const approved = c.req.query('approved')

  let q = `SELECT te.*, r.name as rep_name, r.color as rep_color
            FROM time_entries te
            LEFT JOIN reps r ON r.id=te.rep_id AND r.company_id=te.company_id
            WHERE te.company_id=? AND date(te.clock_in)>=? AND date(te.clock_in)<=?`
  const params: any[] = [companyId, from, to]
  if (targetRep) { q += ' AND te.rep_id=?'; params.push(targetRep) }
  if (approved !== undefined && approved !== '') { q += ' AND te.approved=?'; params.push(Number(approved)) }
  q += ' ORDER BY te.clock_in DESC'
  const rows = await c.env.DB.prepare(q).bind(...params).all()
  return json(c, rows.results)
})

// GET /api/time/weekly-summary?from=&to=   — hours per rep for payroll
app.get('/api/time/weekly-summary', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role      = c.var.role as string
  if (role !== 'admin' && role !== 'office_manager') return err(c, 'Admin only', 403)
  const from = c.req.query('from') || new Date(Date.now() - 7*86400000).toISOString().slice(0,10)
  const to   = c.req.query('to')   || new Date().toISOString().slice(0,10)
  const rows = await c.env.DB.prepare(`
    SELECT te.rep_id, r.name as rep_name, r.color as rep_color,
           COUNT(*) as entry_count,
           SUM(CASE WHEN te.clock_out IS NOT NULL THEN te.duration_min ELSE 0 END) as total_min,
           SUM(CASE WHEN te.approved=1 AND te.clock_out IS NOT NULL THEN te.duration_min ELSE 0 END) as approved_min,
           SUM(CASE WHEN te.approved=0 AND te.clock_out IS NOT NULL THEN te.duration_min ELSE 0 END) as pending_min
    FROM time_entries te
    LEFT JOIN reps r ON r.id=te.rep_id AND r.company_id=te.company_id
    WHERE te.company_id=? AND date(te.clock_in)>=? AND date(te.clock_in)<=?
    GROUP BY te.rep_id ORDER BY r.name
  `).bind(companyId, from, to).all()
  return json(c, rows.results)
})

// PUT /api/time/entries/:id   — edit notes/jobType (own entry) or approve (admin)
app.put('/api/time/entries/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role      = c.var.role as string
  const repId     = c.var.repId as string
  const id        = c.req.param('id')
  const b = await c.req.json() as any

  const entry = await c.env.DB.prepare(
    `SELECT * FROM time_entries WHERE id=? AND company_id=? LIMIT 1`
  ).bind(id, companyId).first<any>()
  if (!entry) return err(c, 'Entry not found', 404)
  // Non-admins can only edit their own entries
  if (role !== 'admin' && role !== 'office_manager' && entry.rep_id !== repId)
    return err(c, 'Forbidden', 403)

  const updates: string[] = []
  const vals: any[] = []
  if (b.notes     !== undefined) { updates.push('notes=?');    vals.push(b.notes) }
  if (b.jobType   !== undefined) { updates.push('job_type=?'); vals.push(b.jobType) }
  if (b.clockIn   !== undefined && (role==='admin'||role==='office_manager')) {
    updates.push('clock_in=?'); vals.push(b.clockIn)
  }
  if (b.clockOut  !== undefined && (role==='admin'||role==='office_manager')) {
    updates.push('clock_out=?'); vals.push(b.clockOut || null)
    // Recompute duration
    if (b.clockOut && b.clockIn) {
      const dur = Math.round((new Date(b.clockOut).getTime() - new Date(b.clockIn).getTime()) / 60000)
      updates.push('duration_min=?'); vals.push(dur)
    }
  }
  // Approval — admin only
  if (b.approved !== undefined && (role==='admin'||role==='office_manager')) {
    updates.push('approved=?', 'approved_by=?', 'approved_at=datetime(\'now\')');
    vals.push(Number(b.approved), repId)
  }
  if (!updates.length) return err(c, 'Nothing to update')
  updates.push("updated_at=datetime('now')")
  await c.env.DB.prepare(
    `UPDATE time_entries SET ${updates.join(',')} WHERE id=? AND company_id=?`
  ).bind(...vals, id, companyId).run()
  return json(c, { updated: id })
})

// DELETE /api/time/entries/:id
app.delete('/api/time/entries/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role      = c.var.role as string
  const repId     = c.var.repId as string
  const id        = c.req.param('id')
  const entry = await c.env.DB.prepare(
    `SELECT rep_id, approved FROM time_entries WHERE id=? AND company_id=? LIMIT 1`
  ).bind(id, companyId).first<{ rep_id: string; approved: number }>()
  if (!entry) return err(c, 'Not found', 404)
  if (role !== 'admin' && role !== 'office_manager' && entry.rep_id !== repId)
    return err(c, 'Forbidden', 403)
  if (entry.approved === 1 && role !== 'admin') return err(c, 'Cannot delete approved entry', 403)
  await c.env.DB.prepare(`DELETE FROM time_entries WHERE id=? AND company_id=?`).bind(id, companyId).run()
  return json(c, { deleted: id })
})

// POST /api/time/approve-batch   { ids: string[], approved: 0|1|2 }  — admin bulk approve
app.post('/api/time/approve-batch', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role      = c.var.role as string
  const repId     = c.var.repId as string
  if (role !== 'admin' && role !== 'office_manager') return err(c, 'Admin only', 403)
  const { ids, approved } = await c.req.json() as { ids: string[]; approved: number }
  if (!ids?.length) return err(c, 'No ids provided')
  const placeholders = ids.map(() => '?').join(',')
  await c.env.DB.prepare(
    `UPDATE time_entries SET approved=?, approved_by=?, approved_at=datetime('now'), updated_at=datetime('now')
     WHERE id IN (${placeholders}) AND company_id=?`
  ).bind(Number(approved), repId, ...ids, companyId).run()
  return json(c, { updated: ids.length })
})

// ══════════════════════════════════════════════════════════════════════════════
// SUPER-ADMIN API  (is_super_admin = 1 required)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/admin/companies  — list all tenant companies with stats
// Excludes groundwork_platform (the platform owner's anchor record, not a customer tenant)
app.get('/api/admin/companies', requireSuperAdmin, async (c) => {
  const companies = await c.env.DB.prepare(`
    SELECT c.id, c.name, c.slug, c.plan, c.owner_email, c.website, c.active,
           c.created_at, c.updated_at, c.trial_ends_at, c.notes,
           COUNT(DISTINCT r.id)   AS rep_count,
           COUNT(DISTINCT o.id)   AS opp_count,
           MAX(o.updated_at)      AS last_activity
    FROM companies c
    LEFT JOIN reps r         ON r.company_id = c.id AND r.active = 1
    LEFT JOIN opportunities o ON o.company_id = c.id
    WHERE c.id != 'groundwork_platform'
    GROUP BY c.id
    ORDER BY c.created_at DESC
  `).all()
  return json(c, companies.results)
})

// GET /api/admin/stats  — platform-wide totals (excludes platform owner anchor records)
app.get('/api/admin/stats', requireSuperAdmin, async (c) => {
  const [companies, reps, opps] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT COUNT(*) as n FROM companies WHERE active = 1 AND id != 'groundwork_platform'"),
    c.env.DB.prepare("SELECT COUNT(*) as n FROM reps WHERE active = 1 AND company_id != 'groundwork_platform'"),
    c.env.DB.prepare('SELECT COUNT(*) as n FROM opportunities')
  ])
  return json(c, {
    companies: (companies.results[0] as any).n,
    reps:      (reps.results[0] as any).n,
    opps:      (opps.results[0] as any).n
  })
})

// POST /api/admin/impersonate  { companyId } — set session company scope
// Creates a new session token scoped to the target company, returns it.
// The super-admin's own session is unchanged; frontend stores the impersonation token separately.
app.post('/api/admin/impersonate', requireSuperAdmin, async (c) => {
  const { companyId } = await c.req.json()
  if (!companyId) return err(c, 'companyId required')
  // Find admin rep of that company
  const targetRep = await c.env.DB.prepare(
    "SELECT id, company_id FROM reps WHERE company_id = ? AND role IN ('admin','office_manager') AND active = 1 ORDER BY role ASC LIMIT 1"
  ).bind(companyId).first<any>()
  if (!targetRep) return err(c, 'No admin rep found for that company', 404)
  const token = secureToken()
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES (?,?,datetime('now'))")
      .bind(`session_${token}`, targetRep.id),
    c.env.DB.prepare("INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES (?,?,datetime('now'))")
      .bind(`session_company_${token}`, companyId)
  ])
  // Set the impersonation cookie (replaces current session in browser)
  setCookie(c, 'avalon_session', token, {
    httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 60 * 60 * 2 // 2hr impersonation window
  })
  return json(c, { impersonating: companyId, repId: targetRep.id })
})

// PUT /api/admin/companies/:id  — update company fields (plan, status, name, etc.)
app.put('/api/admin/companies/:id', requireSuperAdmin, async (c) => {
  const id = c.req.param('id')
  const b  = await c.req.json()
  const allowed = ['plan','active','trial_ends_at','name','owner_email','website','notes']
  const updates = allowed.filter(f => b[f] !== undefined)
  if (!updates.length) return err(c, 'Nothing to update')
  const set  = updates.map(f => `${f} = ?`).join(', ')
  const vals = updates.map(f => b[f])
  await c.env.DB.prepare(
    `UPDATE companies SET ${set}, updated_at = datetime('now') WHERE id = ?`
  ).bind(...vals, id).run()
  return json(c, { updated: id })
})

// POST /api/admin/companies  — create a new tenant company
app.post('/api/admin/companies', requireSuperAdmin, async (c) => {
  const b = await c.req.json()
  const { id, name, slug, owner_email, website, plan, active, notes } = b as any
  if (!id || !name) return err(c, 'id and name required')
  await c.env.DB.prepare(
    `INSERT INTO companies (id, name, slug, plan, owner_email, website, active, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).bind(id, name, slug||id, plan||'trial', owner_email||'', website||'', active??1, notes||'').run()
  return json(c, { created: id })
})

// ── Platform internal data routes (gw-leads, tickets, announcements) ──────────

// GW Sales Leads  (/api/platform/gw-leads)
app.get('/api/platform/gw-leads', requireSuperAdmin, async (c) => {
  const limit = parseInt(c.req.query('limit')||'200')
  const rows = await c.env.DB.prepare(
    `SELECT * FROM gw_leads ORDER BY updated_at DESC LIMIT ?`
  ).bind(limit).all()
  return json(c, rows.results || [])
})
app.post('/api/platform/gw-leads', requireSuperAdmin, async (c) => {
  const b = await c.req.json()
  const id = uid()
  const { company_name, contact_name, email, phone, stage, priority, deal_value, next_action, notes, source } = b as any
  await c.env.DB.prepare(
    `INSERT INTO gw_leads (id, company_name, contact_name, email, phone, stage, priority, deal_value, next_action, notes, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).bind(id, company_name||'', contact_name||'', email||'', phone||'', stage||'prospect', priority||'medium', deal_value||0, next_action||'', notes||'', source||'other').run()
  return json(c, { id })
})
app.put('/api/platform/gw-leads/:id', requireSuperAdmin, async (c) => {
  const id = c.req.param('id')
  const b  = await c.req.json()
  const allowed = ['company_name','contact_name','email','phone','stage','priority','deal_value','next_action','notes','source']
  const updates = allowed.filter(f => (b as any)[f] !== undefined)
  if (!updates.length) return err(c, 'Nothing to update')
  const set  = updates.map(f => `${f} = ?`).join(', ')
  const vals = updates.map(f => (b as any)[f])
  await c.env.DB.prepare(
    `UPDATE gw_leads SET ${set}, updated_at = datetime('now') WHERE id = ?`
  ).bind(...vals, id).run()
  return json(c, { updated: id })
})
app.delete('/api/platform/gw-leads/:id', requireSuperAdmin, async (c) => {
  const id = c.req.param('id')
  await c.env.DB.prepare(`DELETE FROM gw_leads WHERE id = ?`).bind(id).run()
  return json(c, { deleted: id })
})

// Support Tickets  (/api/platform/tickets)
app.get('/api/platform/tickets', requireSuperAdmin, async (c) => {
  const limit  = parseInt(c.req.query('limit')||'200')
  const status = c.req.query('status')
  const rows = status
    ? await c.env.DB.prepare(`SELECT * FROM gw_tickets WHERE status = ? ORDER BY created_at DESC LIMIT ?`).bind(status, limit).all()
    : await c.env.DB.prepare(`SELECT * FROM gw_tickets ORDER BY created_at DESC LIMIT ?`).bind(limit).all()
  return json(c, rows.results || [])
})
app.post('/api/platform/tickets', requireSuperAdmin, async (c) => {
  const b = await c.req.json()
  const id = uid()
  const { subject, body, company_name, company_id, submitter_email, submitter_name, priority, status, internal_notes } = b as any
  await c.env.DB.prepare(
    `INSERT INTO gw_tickets (id, subject, body, company_name, company_id, submitter_email, submitter_name, priority, status, internal_notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).bind(id, subject||'', body||'', company_name||'', company_id||'', submitter_email||'', submitter_name||'', priority||'medium', status||'open', internal_notes||'').run()
  return json(c, { id })
})
app.put('/api/platform/tickets/:id', requireSuperAdmin, async (c) => {
  const id = c.req.param('id')
  const b  = await c.req.json()
  const allowed = ['subject','status','priority','internal_notes','body']
  const updates = allowed.filter(f => (b as any)[f] !== undefined)
  if (!updates.length) return err(c, 'Nothing to update')
  const set  = updates.map(f => `${f} = ?`).join(', ')
  const vals = updates.map(f => (b as any)[f])
  await c.env.DB.prepare(
    `UPDATE gw_tickets SET ${set}, updated_at = datetime('now') WHERE id = ?`
  ).bind(...vals, id).run()
  return json(c, { updated: id })
})
app.delete('/api/platform/tickets/:id', requireSuperAdmin, async (c) => {
  await c.env.DB.prepare(`DELETE FROM gw_tickets WHERE id = ?`).bind(c.req.param('id')).run()
  return json(c, { deleted: c.req.param('id') })
})

// Announcements  (/api/platform/announcements)
app.get('/api/platform/announcements', requireSuperAdmin, async (c) => {
  const rows = await c.env.DB.prepare(`SELECT * FROM gw_announcements ORDER BY created_at DESC LIMIT 200`).all()
  return json(c, rows.results || [])
})
app.post('/api/platform/announcements', requireSuperAdmin, async (c) => {
  const b = await c.req.json()
  const id = uid()
  const { title, body, type, published, audience } = b as any
  await c.env.DB.prepare(
    `INSERT INTO gw_announcements (id, title, body, type, published, audience, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).bind(id, title||'', body||'', type||'announcement', published?1:0, audience||'all').run()
  return json(c, { id })
})
app.put('/api/platform/announcements/:id', requireSuperAdmin, async (c) => {
  const id = c.req.param('id')
  const b  = await c.req.json()
  const allowed = ['title','body','type','published','audience','published_at']
  const updates = allowed.filter(f => (b as any)[f] !== undefined)
  if (!updates.length) return err(c, 'Nothing to update')
  const set  = updates.map(f => `${f} = ?`).join(', ')
  const vals = updates.map(f => (b as any)[f])
  await c.env.DB.prepare(
    `UPDATE gw_announcements SET ${set}, updated_at = datetime('now') WHERE id = ?`
  ).bind(...vals, id).run()
  return json(c, { updated: id })
})
app.delete('/api/platform/announcements/:id', requireSuperAdmin, async (c) => {
  await c.env.DB.prepare(`DELETE FROM gw_announcements WHERE id = ?`).bind(c.req.param('id')).run()
  return json(c, { deleted: c.req.param('id') })
})

// POST /api/admin/clear-sessions — wipe all session tokens from settings table
app.post('/api/admin/clear-sessions', requireSuperAdmin, async (c) => {
  await c.env.DB.prepare(`DELETE FROM settings WHERE key LIKE 'session_%'`).run()
  return json(c, { cleared: true })
})

// ══════════════════════════════════════════════════════════════════════════════
// PLATFORM OWNER LOGIN  (/platform-login)
// ══════════════════════════════════════════════════════════════════════════════

// GET /platform-login — dedicated login page for tyler@groundwork-crm.com
// Completely separate from the Avalon tenant rep-picker login screen.
// Accessible at groundwork-crm.com/platform-login (not linked from the main app).
app.get('/platform-login', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Groundwork CRM — Platform Admin</title>
  <meta name="robots" content="noindex,nofollow"/>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{min-height:100vh;background:linear-gradient(160deg,#0E2E27 0%,#0A1F1B 55%,#0E2E27 100%);
         display:flex;align-items:center;justify-content:center;
         font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif}
    .shell{width:min(400px,94vw);padding:0 20px}
    /* Brand mark */
    .brand{text-align:center;margin-bottom:40px}
    .brand-icon{display:inline-flex;align-items:center;justify-content:center;
                width:68px;height:68px;background:rgba(32,74,67,.7);
                border:1px solid rgba(77,138,134,.35);border-radius:18px;
                margin-bottom:16px;box-shadow:0 8px 28px rgba(0,0,0,.5)}
    .brand-icon svg{display:block}
    .brand h1{color:#fff;font-size:24px;font-weight:900;letter-spacing:-.04em;margin-bottom:4px}
    .brand-sub{color:rgba(255,255,255,.38);font-size:11px;font-weight:700;
               letter-spacing:.1em;text-transform:uppercase}
    .brand-badge{display:inline-block;margin-top:10px;padding:4px 10px;
                 background:rgba(32,74,67,.6);border:1px solid rgba(77,138,134,.4);
                 border-radius:20px;color:#7FC5BB;font-size:10px;font-weight:700;
                 letter-spacing:.08em;text-transform:uppercase}
    /* Card */
    .card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);
          border-radius:20px;padding:28px;backdrop-filter:blur(10px)}
    .card-title{color:rgba(255,255,255,.65);font-size:12px;font-weight:700;
                letter-spacing:.07em;text-transform:uppercase;margin-bottom:20px;
                text-align:center}
    /* Fields */
    .field{margin-bottom:16px}
    .field label{display:block;color:rgba(255,255,255,.5);font-size:11px;
                 font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-bottom:6px}
    .email-display{padding:12px 14px;background:rgba(255,255,255,.04);
                   border:1px solid rgba(255,255,255,.1);border-radius:10px;
                   color:rgba(255,255,255,.6);font-size:13px;font-family:monospace}
    .pw-wrap{position:relative}
    .pw-input{width:100%;padding:12px 44px 12px 14px;background:rgba(255,255,255,.07);
              border:1px solid rgba(255,255,255,.18);border-radius:10px;
              color:#fff;font-size:15px;font-family:inherit;outline:none;
              transition:border-color .15s}
    .pw-input:focus{border-color:#4D8A86}
    .pw-input::placeholder{color:rgba(255,255,255,.25)}
    .pw-toggle{position:absolute;right:12px;top:50%;transform:translateY(-50%);
               background:none;border:none;color:rgba(255,255,255,.4);cursor:pointer;
               font-size:15px;padding:4px;line-height:1}
    .pw-toggle:hover{color:rgba(255,255,255,.75)}
    /* Sign in button */
    .signin-btn{width:100%;padding:14px;background:#4D8A86;border:none;border-radius:12px;
                color:#fff;font-size:15px;font-weight:700;cursor:pointer;
                transition:background .15s;margin-top:6px;letter-spacing:.01em}
    .signin-btn:hover{background:#3d7a76}
    .signin-btn:disabled{opacity:.5;cursor:default}
    /* Error */
    .error-msg{color:#F5C8C0;font-size:13px;text-align:center;margin-top:12px;display:none}
    /* Footer */
    .footer{text-align:center;color:rgba(255,255,255,.18);font-size:11px;
            margin-top:28px;letter-spacing:.04em}
  </style>
</head>
<body>
<div class="shell">

  <!-- Brand -->
  <div class="brand">
    <div class="brand-icon">
      <!-- Groundwork "G" logomark -->
      <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
        <rect width="36" height="36" rx="10" fill="none"/>
        <path d="M25 14.5C23.5 11.5 20.5 9.5 18 9.5C13.5 9.5 10 13.3 10 18C10 22.7 13.5 26.5 18 26.5C21 26.5 23.6 24.8 25 22.3" stroke="#7FC5BB" stroke-width="2" stroke-linecap="round"/>
        <path d="M21 18H26.5" stroke="#7FC5BB" stroke-width="2" stroke-linecap="round"/>
        <path d="M24 15.5V20.5" stroke="#7FC5BB" stroke-width="2" stroke-linecap="round"/>
      </svg>
    </div>
    <h1>Groundwork CRM</h1>
    <p class="brand-sub">Platform Administration</p>
    <span class="brand-badge">Restricted Access</span>
  </div>

  <!-- Login card -->
  <div class="card" id="loginCard">
    <p class="card-title">Platform Owner Sign In</p>

    <div class="field">
      <label>Account</label>
      <div class="email-display">tyler@groundwork-crm.com</div>
    </div>

    <div class="field">
      <label>Password</label>
      <div class="pw-wrap">
        <input id="pwInput" class="pw-input" type="password"
               placeholder="Enter your password" autocomplete="current-password"
               onkeydown="if(event.key==='Enter')doSignIn()">
        <button class="pw-toggle" type="button" onclick="togglePw()" tabindex="-1" title="Show/hide password">
          <span id="pwEye">👁</span>
        </button>
      </div>
    </div>

    <button class="signin-btn" id="signinBtn" onclick="doSignIn()">Sign In</button>

    <div class="error-msg" id="errMsg"></div>
  </div>

  <p class="footer">GROUNDWORK CRM · PLATFORM ADMIN · RESTRICTED</p>
</div>

<script>
  function togglePw() {
    const inp = document.getElementById('pwInput');
    const eye = document.getElementById('pwEye');
    if (inp.type === 'password') { inp.type = 'text'; eye.textContent = '🙈'; }
    else                         { inp.type = 'password'; eye.textContent = '👁'; }
  }

  async function doSignIn() {
    const password = document.getElementById('pwInput').value;
    const btn  = document.getElementById('signinBtn');
    const err  = document.getElementById('errMsg');

    err.style.display = 'none';
    if (!password) { err.textContent = 'Please enter your password'; err.style.display = 'block'; return; }

    btn.disabled = true;
    btn.textContent = 'Signing in…';

    try {
      const res  = await fetch('/api/auth/platform-login', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ password })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Incorrect password — please try again');
      // Success — redirect to main app; _initialRoute() detects platform admin
      window.location.href = '/';
    } catch(e) {
      err.textContent = e.message || 'Incorrect password — please try again';
      err.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Sign In';
      // Subtle shake on the card
      const card = document.getElementById('loginCard');
      card.style.transition = 'transform .08s';
      card.style.transform = 'translateX(-6px)';
      setTimeout(() => card.style.transform = 'translateX(6px)', 80);
      setTimeout(() => { card.style.transform = ''; card.style.transition = ''; }, 160);
      document.getElementById('pwInput').focus();
    }
  }

  // Focus password field on load
  window.addEventListener('load', () => document.getElementById('pwInput').focus());
</script>
</body>
</html>`)
})

// POST /api/auth/platform-login  { password }
// Email is fixed as tyler@groundwork-crm.com (id='gw_tyler', company='groundwork_platform').
// On success sets the same avalon_session cookie as normal login.
// The client-side _initialRoute() detects is_super_admin=1 + company_id='groundwork_platform'
// and auto-navigates to superAdmin() instead of today().
app.post('/api/auth/platform-login', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  // Accept 'password' (new) or 'pin' (legacy fallback) field name
  const credential = (body as any).password || (body as any).pin
  if (!credential) return err(c, 'Password required')
  // Always look up the single platform-owner rep — no picker needed
  const rep = await c.env.DB.prepare(
    "SELECT * FROM reps WHERE id = 'gw_tyler' AND company_id = 'groundwork_platform' AND is_super_admin = 1 AND active = 1 LIMIT 1"
  ).first<any>()
  if (!rep) return err(c, 'Platform account not found', 401)
  // Dual-mode credential check: PBKDF2 hash first, then plain-text migration path
  let credOk = false
  if (rep.pin_hash) {
    credOk = await verifyPin(String(credential), rep.pin_hash)
    if (credOk && rep.pin) {
      await c.env.DB.prepare("UPDATE reps SET pin = '' WHERE id = 'gw_tyler'").run()
    }
  } else if (rep.pin) {
    credOk = String(credential) === String(rep.pin)
    if (credOk) {
      const hash = await hashPin(String(credential))
      await c.env.DB.prepare("UPDATE reps SET pin_hash = ?, pin = '' WHERE id = 'gw_tyler'")
        .bind(hash).run()
    }
  }
  if (!credOk) return err(c, 'Incorrect password', 401)
  const token = uid() + uid()
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    ).bind(`session_${token}`, rep.id),
    c.env.DB.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    ).bind(`session_company_${token}`, rep.company_id)
  ])
  setCookie(c, 'avalon_session', token, {
    httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 60 * 60 * 24 * 30
  })
  const { pin: _p, pin_hash: _ph, ...safeRep } = rep as any
  return json(c, safeRep)
})

// Google OAuth2 callback page — receives access token from Google's implicit flow,
// posts it back to the opener window, then closes itself.
app.get('/auth/google/callback', (c) => {
  return c.html(`<!DOCTYPE html>
<html>
<head>
  <title>Connecting to Google…</title>
  <style>
    /* Groundwork brand palette — #113931 Brand Primary, #0E372F Deep Pine, #4D8A86 UI Accent */
    body { font-family: 'Satoshi', Inter, sans-serif; background: linear-gradient(160deg,#113931,#0E372F); color: #DDD5C8;
           display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; flex-direction: column; gap: 16px; }
    .spinner { width: 40px; height: 40px; border: 3px solid rgba(255,255,255,.15); border-top-color: #4D8A86; border-radius: 50%; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    p { color: #8FB8B2; font-size: 14px; margin: 0; }
  </style>
</head>
<body>
  <div class="spinner"></div>
  <p>Connecting to Google — you can close this window if it doesn't close automatically.</p>
  <script>
    // The access token arrives in the URL hash via Google's implicit flow.
    // The opener (user_management.js) polls this page's location.hash to read it.
    // Nothing needs to happen here — just stay open so the polling can read the hash.

    // Auto-close after 10 seconds as a fallback (gives the opener enough poll cycles)
    if (window.opener) {
      setTimeout(() => window.close(), 10000);
    }
  </script>
</body>
</html>`)
})

// Main app - serve Groundwork CRM
app.get('/', (c) => {
  return c.html(getHtml())
})

function getHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Groundwork CRM</title>
  <link rel="icon" type="image/png" href="/static/avalon-logo.png" />
  <link rel="icon" type="image/x-icon" href="/static/favicon.ico" />
  <meta name="theme-color" content="#113931" />
  <meta name="description" content="Field sales CRM built for home services teams." />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/static/premium.css?v=20260628gw6">
  <link rel="stylesheet" href="/static/styles.css?v=20260628gw6">
  <link rel="stylesheet" href="/static/groundwork-design.css?v=20260628gw7">
</head>
<body>
<div id="sidebarScrim" class="sidebar-scrim"></div>
<div class="app-shell">
  <aside class="sidebar" id="sidebar">
    <div class="brand">
      <div class="brand-mark" onclick="show('today')" style="cursor:pointer;" title="Go to Today">
        <img src="/static/avalon-logo.png" alt="Groundwork" />
      </div>
      <div>
        <div class="brand-name">Groundwork</div>
        <div class="brand-subtitle">Sales CRM</div>
      </div>
    </div>
    <nav class="nav" id="mainNav" role="navigation">

      <!-- ── Tenant nav groups (hidden when platform admin session active) ── -->
      <details class="nav-group tenant-nav" open>
        <summary class="nav-summary">Home</summary>
        <div class="nav-items">
          <button class="nav-item active" data-view="today" onclick="show('today')">Today</button>
          <button class="nav-item" data-view="myDashboard" onclick="show('myDashboard')">My Dashboard</button>
          <button class="nav-item" data-view="timeTracker" onclick="show('timeTracker')">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px"><circle cx="8" cy="9" r="5"/><path d="M8 6v3l2 1.5"/><path d="M6 1h4M8 1v3"/></svg>
            Time Tracker
          </button>
        </div>
      </details>

      <details class="nav-group tenant-nav" open>
        <summary class="nav-summary">Pipeline</summary>
        <div class="nav-items">
          <button class="nav-item" data-view="pipeline" onclick="show('pipeline')">Pipeline</button>
          <button class="nav-item" data-view="lead" onclick="show('lead')">Add Lead</button>
          <button class="nav-item" data-view="clients" onclick="show('clients')">Clients &amp; Properties</button>
        </div>
      </details>

      <details class="nav-group tenant-nav">
        <summary class="nav-summary">Sales Toolkit</summary>
        <div class="nav-items">
          <button class="nav-item" data-view="process" onclick="show('process')">Sales Process</button>
          <button class="nav-item" data-view="forms" onclick="show('forms')">Forms &amp; Checklists</button>
          <button class="nav-item" data-view="scripts" onclick="show('scripts')">Scripts</button>
          <button class="nav-item" data-view="templates" onclick="show('templates')">Email Templates</button>
          <button class="nav-item" data-view="objections" onclick="show('objections')">Objection Handling</button>
          <button class="nav-item" data-view="calculator" onclick="show('calculator')">Pricing Tools</button>
          <button class="nav-item" data-view="ai" onclick="show('ai')">AI Sales Assistant</button>
        </div>
      </details>

      <details class="nav-group tenant-nav">
        <summary class="nav-summary">Learning</summary>
        <div class="nav-items">
          <button class="nav-item" data-view="academy" onclick="show('academy')">Sales Academy</button>
        </div>
      </details>

      <details class="nav-group tenant-nav">
        <summary class="nav-summary">Admin</summary>
        <div class="nav-items">
          <button class="nav-item" data-view="manager" onclick="show('manager')">Manager Tools</button>
          <button class="nav-item" data-view="revenueAdmin" onclick="show('revenueAdmin')">Financial Data Hub</button>
          <button class="nav-item" data-view="integrations" onclick="show('integrations')">Integrations</button>
          <button class="nav-item" data-view="userManagement" onclick="show('userManagement')">User Management</button>
          <button class="nav-item" data-view="settings" onclick="show('settings')">Settings</button>
        </div>
      </details>

      <!-- ── Platform Admin nav (visible only when company_id=groundwork_platform) ── -->
      <div id="platformAdminNav" style="display:none">
        <div class="nav-section-label" style="color:#4D8A86;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;padding:18px 16px 6px">Platform Admin</div>
        <div class="nav-items">
          <button class="nav-item" data-view="superAdmin" onclick="show('superAdmin')">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px"><rect x="1" y="3" width="14" height="10" rx="2"/><path d="M1 7h14"/></svg>
            Overview
          </button>
          <button class="nav-item" data-view="gwTenants" onclick="show('gwTenants')">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>
            Tenants
          </button>
          <button class="nav-item" data-view="gwLeads" onclick="show('gwLeads')">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px"><circle cx="8" cy="5" r="3"/><path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>
            Sales Pipeline
          </button>
          <button class="nav-item" data-view="gwSupport" onclick="show('gwSupport')">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px"><path d="M8 2C4.7 2 2 4.7 2 8s2.7 6 6 6 6-2.7 6-6-2.7-6-6-6z"/><path d="M6 6c0-1.1.9-2 2-2s2 .9 2 2c0 1.5-2 2-2 3"/><circle cx="8" cy="13" r=".5" fill="currentColor"/></svg>
            Support &amp; Tickets
          </button>
          <button class="nav-item" data-view="gwAnnounce" onclick="show('gwAnnounce')">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px"><path d="M13 3l-8 5H2v2h3l8 5V3z"/></svg>
            Announcements
          </button>
          <button class="nav-item" data-view="gwBilling" onclick="show('gwBilling')">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px"><rect x="1" y="4" width="14" height="9" rx="1.5"/><path d="M1 7.5h14"/><path d="M4 10.5h3"/></svg>
            Billing &amp; Plans
          </button>
          <button class="nav-item" data-view="gwPlatformSettings" onclick="show('gwPlatformSettings')">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px"><circle cx="8" cy="8" r="2.5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M3.2 12.8l1.4-1.4M11.4 4.6l1.4-1.4"/></svg>
            Platform Settings
          </button>
        </div>
      </div>

    </nav>
    <!-- ── Time Tracker sidebar widget ── -->
    <div id="tt-sidebar-widget" class="tenant-nav" style="padding:10px 12px 0"></div>

    <div class="sidebar-footer" id="sidebarUserFooter">
      <div id="sidebarAvatarInitials">TJ</div>
      <div style="min-width:0;flex:1">
        <strong id="sidebarUserName">Tyler Jones</strong>
        <span id="sidebarUserRole">Operations Director</span>
      </div>
    </div>
  </aside>
  <main class="main" role="main">
    <header class="topbar">
      <button class="menu-btn" id="menuBtn" aria-label="Toggle menu"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="5" x2="17" y2="5"/><line x1="3" y1="10" x2="17" y2="10"/><line x1="3" y1="15" x2="17" y2="15"/></svg></button>
      <div class="search-wrap">
        <input id="searchInput" type="search" placeholder="Search scripts, forms, stages, templates..." autocomplete="off" aria-label="Search">
        <div id="searchResults" class="search-results" hidden></div>
      </div>
      <button class="install-btn" id="installBtn" hidden>Install App</button>

      <!-- + New quick-create dropdown -->
      <div class="topbar-new-wrap" id="topbarNewWrap">
        <button class="topbar-new-btn" id="topbarNewBtn" aria-haspopup="true" aria-expanded="false" aria-label="Create new">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="7" y1="1" x2="7" y2="13"/><line x1="1" y1="7" x2="13" y2="7"/></svg>
          New
          <svg class="topbar-new-caret" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,3.5 5,6.5 8,3.5"/></svg>
        </button>
        <div class="topbar-new-dropdown" id="topbarNewDropdown" hidden role="menu">
          <div class="tnd-section-label">Pipeline</div>
          <button class="tnd-item" onclick="window._closeNewMenu();show('lead')" role="menuitem">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="6" r="3"/><path d="M2 14c0-3.3 2.7-5 6-5s6 1.7 6 5"/></svg>
            Add Lead
          </button>
          <button class="tnd-item" onclick="window._closeNewMenu();show('clients');setTimeout(()=>window.showClientForm&&window.showClientForm(),80)" role="menuitem">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M8 5v6M5 8h6"/></svg>
            Add Client
          </button>
        </div>
      </div>

      <button class="topbar-settings" onclick="show('settings')" title="Settings"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><circle cx="10" cy="10" r="3"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.22 4.22l1.42 1.42M14.36 14.36l1.42 1.42M4.22 15.78l1.42-1.42M14.36 5.64l1.42-1.42"/></svg>Settings</button>
    </header>
    <div class="view" id="view" role="region" aria-live="polite"></div>
  </main>
</div>
<div id="toast" class="toast" hidden role="alert" aria-live="assertive"></div>

<script src="/static/gw-icons.js?v=20260628gw1"></script>
<script src="/static/db.js?v=20260628gw9"></script>
<script src="/static/data.js?v=20260628gw9"></script>
<script src="/static/reps.js?v=20260628gw9"></script>
<script src="/static/academy.js?v=20260628gw9"></script>
<script src="/static/app_premium.js?v=20260628gw9"></script>
<script src="/static/integrations.js?v=20260628gw9"></script>
<script src="/static/import_clients_csv.js?v=20260628gw9"></script>
<script src="/static/user_management.js?v=20260628gw9"></script>
<script src="/static/platform_admin.js?v=20260628gw9"></script>
<script src="/static/time_tracker.js?v=20260629tt1"></script>
<script>
  // Service Worker registration
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  
  // PWA install prompt
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    window.deferredPrompt = e;
    const btn = document.getElementById('installBtn');
    if (btn) {
      btn.hidden = false;
      btn.onclick = () => { e.prompt(); btn.hidden = true; };
    }
  });

  // Expose state to integrations module
  window._avalonState = state;

  // ── D1 + Auth Bootstrap ───────────────────────────────────────────────────
  // 1. Check D1 session cookie → if valid, set window._d1Rep and load D1 state
  // 2. If no D1 session, fall back to localStorage auth (reps.js getCurrentRep)
  // 3. One-time migration: push localStorage data → D1 on first D1-enabled load
  (async function bootstrapD1Auth() {
    try {
      // Check if D1 session is active
      const d1Rep = await window.DB.getSession();
      if (d1Rep) {
        // D1 session valid — sync D1 rep into reps.js auth system
        window._d1SessionRep = d1Rep;
        // ── Multi-tenant: set company context for all subsequent DB calls ──
        window._companyId = d1Rep.company_id || 'avalon';
        // Map D1 rep to reps.js format for full compatibility
        const localRep = (window.REPS || []).find(r => r.id === d1Rep.id);
        if (localRep) {
          // Enrich local rep with D1 data
          Object.assign(localRep, {
            role: d1Rep.role || localRep.role,
            color: d1Rep.color || localRep.color,
            commissionPlan: d1Rep.commission_plan || localRep.commissionPlan
          });
        }
        // Set localStorage auth so getCurrentRep() works
        const AUTH_KEY = 'avalonCurrentRep';
        localStorage.setItem(AUTH_KEY, JSON.stringify({ repId: d1Rep.id, loginAt: new Date().toISOString() }));

        // Run one-time localStorage → D1 migration (skipped if already done)
        const migrated = await window.DB.migrateFromLocalStorage();
        if (migrated) {
          console.log('[Bootstrap] Migrated localStorage data to D1');
        }

        // ── D1 is source of truth: load opps, notes, clients in parallel ──────
        const isAdmin = d1Rep.role === 'admin' || d1Rep.role === 'office_manager';

        // Helper: map a D1 opportunity row (snake_case) → app camelCase shape
        function mapOpp(o) {
          return {
            id: o.id, repId: o.rep_id, companyId: o.company_id,
            client: o.client, phone: o.phone, email: o.email, address: o.address,
            serviceLine: o.service_line, source: o.source,
            status: o.status, jobValue: o.job_value,
            project: o.project, urgency: o.urgency,
            decisionMaker: o.decision_maker, budgetRange: o.budget_range,
            nextFollowUp: o.next_follow_up, pipelineStage: o.pipeline_stage,
            estimateAmount: o.estimate_amount, estimateSentDate: o.estimate_sent_date,
            estimateCount: o.estimate_count, workType: o.work_type,
            clientType: o.client_type, prompt: o.prompt,
            desiredOutcome: o.desired_outcome, fitConcerns: o.fit_concerns,
            commissionApproved: !!o.commission_approved, collected: !!o.collected,
            soldDate: o.sold_date, soldAmount: o.sold_amount,
            leadSource: o.lead_source || '',
            projectCategory: o.project_category || o.service_line || '',
            createdAt: o.created_at, updatedAt: o.updated_at
          };
        }

        // Load opportunities — D1 is authoritative, localStorage used only as offline fallback
        try {
          const opps = await window.DB.opportunities.list({ repId: isAdmin ? undefined : d1Rep.id });
          if (opps && opps.length > 0) {
            // D1 wins entirely — replace state, keep any local-only opps not yet synced
            const d1Ids = new Set(opps.map(o => o.id));
            const localOnly = (state.opportunities || []).filter(o => !d1Ids.has(o.id) && !o._fromD1);
            state.opportunities = [
              ...opps.map(mapOpp).map(o => ({...o, _fromD1: true})),
              ...localOnly
            ];
            // Persist into localStorage so offline works and saveState() is non-destructive
            saveState();
            console.log('[Bootstrap] Loaded', opps.length, 'opportunities from D1');
          }
        } catch(e) {
          console.warn('[Bootstrap] Could not load D1 opportunities:', e.message);
        }

        // Load clients from D1 → write into localStorage so loadClients() returns D1 data
        try {
          const d1Clients = await window.DB.clients.list();
          if (d1Clients && d1Clients.length > 0) {
            // Map D1 client rows to app client shape (D1 stores flat; app stores rich objects)
            // Merge: D1 wins on shared ids, keep local-only clients
            const localClients = JSON.parse(localStorage.getItem('avalonClientsV1') || '[]');
            const d1Ids = new Set(d1Clients.map(c => c.id));
            const localOnly = localClients.filter(c => !d1Ids.has(c.id));
            // D1 clients may lack rich fields (properties[], tags[]) — preserve local enrichment
            const merged = d1Clients.map(dc => {
              const lc = localClients.find(l => l.id === dc.id);
              return {
                id: dc.id, name: dc.name, phone: dc.phone || '', email: dc.email || '',
                address: dc.address || '', type: dc.type || 'Residential',
                notes: dc.notes || '',
                // Preserve local-only rich fields if they exist
                ...(lc ? { firstName: lc.firstName, lastName: lc.lastName,
                            company: lc.company, status: lc.status, mobile: lc.mobile,
                            since: lc.since, tags: lc.tags, homeworksId: lc.homeworksId,
                            properties: lc.properties } : {})
              };
            });
            localStorage.setItem('avalonClientsV1', JSON.stringify([...merged, ...localOnly]));
            console.log('[Bootstrap] Loaded', d1Clients.length, 'clients from D1');
          }
        } catch(e) {
          console.warn('[Bootstrap] Could not load D1 clients:', e.message);
        }

        window._d1Ready = true;
        window._mapOpp = mapOpp; // expose for login flow reuse
        // Flush any writes that were queued before D1 was ready
        if (typeof window._d1FlushQueue === 'function') window._d1FlushQueue();
        // Refresh nav visibility now that super-admin status is known
        if (typeof window._refreshAdminNav === 'function') window._refreshAdminNav();
        // ── Dynamic brand kicker: show real company name from D1 ──
        try {
          const compRes = await fetch('/api/companies/' + d1Rep.company_id);
          if (compRes.ok) {
            const compJson = await compRes.json();
            const compName = (compJson.data ?? compJson)?.name;
            if (compName) {
              const kicker = document.getElementById('brandKicker');
              if (kicker) kicker.textContent = compName;
              window._companyName = compName;
            }
          }
        } catch(e) {
          console.warn('[Bootstrap] Could not load company name:', e.message);
        }
        console.log('[Bootstrap] D1 session active for', d1Rep.name);
        return; // Don't show login screen
      }
    } catch(e) {
      console.warn('[Bootstrap] D1 session check failed, falling back to localStorage:', e.message);
    }

    // Fall back: check localStorage auth (reps.js)
    setTimeout(() => {
      if (!window.getCurrentRep()) {
        window.renderLoginScreen();
      }
    }, 100);
  })();

  // Show/hide admin-only nav items based on current rep role
  (function applyNavVisibility() {
    function refreshAdminNav() {
      const rep = window.getCurrentRep ? window.getCurrentRep() : null;
      const isAdmin = rep && rep.role === 'admin';
      const umBtn = document.querySelector('[data-view="userManagement"]');
      if (umBtn) {
        umBtn.style.display = isAdmin ? '' : 'none';
      }
      // Super-admin nav: visible only if is_super_admin from D1 session rep
      const d1Rep = window._d1SessionRep;
      const isSuperAdmin = d1Rep && (d1Rep.is_super_admin === 1 || d1Rep.is_super_admin === true);
      const saBtn = document.getElementById('superAdminNavBtn');
      if (saBtn) {
        saBtn.style.display = isSuperAdmin ? '' : 'none';
      }
    }
    // Run on load and expose so login/logout can call it
    setTimeout(refreshAdminNav, 200);
    window._refreshAdminNav = refreshAdminNav;
  })();
</script>
</body>
</html>`
}

export default app
