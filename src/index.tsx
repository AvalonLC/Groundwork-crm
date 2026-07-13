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
app.use('/js/*', serveStatic({ root: './public' }))
// ── Service Worker — self-destructing killer + real SW ───────────────────────
// /sw.js — self-destructing SW: wipes all caches then unregisters itself
// Any browser with the old SW will fetch this new version, which immediately
// kills all caches and unregisters itself. No more SW will run after this.
app.get('/sw.js', (c) => {
  const sw = `
self.addEventListener('install', e => { e.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach(c => c.postMessage({ type: 'GW_NUKE_DONE' }));
    await self.registration.unregister();
  })());
});
self.addEventListener('fetch', e => { e.respondWith(fetch(e.request)); });
`;
  return c.text(sw, 200, {
    'Content-Type': 'application/javascript',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
})
app.get('/site.webmanifest', (c) => {
  const manifest = {
    name: 'Groundwork CRM',
    short_name: 'Groundwork',
    description: 'Field sales and operations management for home service companies',
    start_url: '/',
    display: 'standalone',
    background_color: '#113931',
    theme_color: '#113931',
    orientation: 'portrait-primary',
    icons: [
      { src: '/js/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/js/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  };
  return c.json(manifest, 200, { 'Content-Type': 'application/manifest+json' });
})
// Apple requests the touch icon at the root — redirect to our static copy
app.get('/apple-touch-icon.png', (c) => c.redirect('/js/apple-touch-icon.png', 301))

// ── /reset  AND  /gw-clear-XXXXXXXX — nuclear SW killer pages ────────────────
// The old SW intercepts every known path. We serve the reset page at BOTH a
// fixed path AND a random-looking path that the stale SW has never cached.
// The page is 100% self-contained (no external fetches), so the SW cannot
// poison it by serving a cached response for any sub-resource.
const RESET_HTML = (extraHeaders: Record<string,string> = {}) => {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Resetting Groundwork CRM…</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:-apple-system,sans-serif;background:#113931;color:#fff;
         display:flex;flex-direction:column;align-items:center;justify-content:center;
         min-height:100vh;margin:0;padding:24px;text-align:center}
    h1{font-size:22px;margin:0 0 12px}
    p{color:rgba(255,255,255,.65);font-size:15px;margin:0 0 24px;line-height:1.5}
    #log{font-size:13px;color:#7FC5BB;line-height:1.8;min-height:80px;white-space:pre-line}
    .ring{width:44px;height:44px;border:3px solid rgba(255,255,255,.15);
          border-top-color:#7FC5BB;border-radius:50%;
          animation:spin .7s linear infinite;margin:0 auto 20px}
    @keyframes spin{to{transform:rotate(360deg)}}
    .ok{border-top-color:#2ecc71!important;animation:none!important}
  </style>
</head>
<body>
<div class="ring" id="ring"></div>
<h1>Clearing app cache…</h1>
<p>Wiping stale service workers &amp; cached files.<br>You'll be redirected automatically.</p>
<div id="log">Starting…</div>
<script>
(async()=>{
  const out=[];
  const log=(s)=>{out.push(s);document.getElementById('log').textContent=out.join('\\n');};

  // ── 1. Unregister every SW directly (works even if no killer SW can register) ──
  if('serviceWorker' in navigator){
    try{
      const regs=await navigator.serviceWorker.getRegistrations();
      for(const r of regs) await r.unregister();
      log('✓ '+regs.length+' service worker(s) unregistered');
    }catch(e){log('⚠ SW unregister: '+e.message);}
  } else { log('ℹ SW not supported in this browser'); }

  // ── 2. Wipe every cache entry ──────────────────────────────────────────────
  if('caches' in window){
    try{
      const keys=await caches.keys();
      await Promise.all(keys.map(k=>caches.delete(k)));
      log('✓ '+keys.length+' cache bucket(s) deleted');
    }catch(e){log('⚠ Cache wipe: '+e.message);}
  }

  // ── 3. Clear localStorage + sessionStorage ─────────────────────────────────
  try{ localStorage.clear(); sessionStorage.clear(); log('✓ Storage cleared'); }
  catch(e){ log('⚠ Storage: '+e.message); }

  // ── 4. Done — hard-navigate with cache-bust so browser fetches fresh HTML ──
  document.getElementById('ring').className='ring ok';
  log('✓ Done — loading fresh app…');
  setTimeout(()=>{
    // location.replace so Back button doesn't loop here
    window.location.replace('/?nocache='+Date.now());
  }, 1200);
})().catch(e=>{
  document.getElementById('log').textContent='Error: '+e.message+'\\n\\nRedirecting…';
  setTimeout(()=>window.location.replace('/'),2500);
});
</script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Surrogate-Control': 'no-store',
      ...extraHeaders,
    }
  });
};

// /reset — known path (may be cached by old SW, but we try anyway)
app.get('/reset', () => RESET_HTML())

// /gw-nuke — nuclear path the old SW has NEVER cached.
// Strategy: nuke SW + caches first, then swap in the real app HTML
// WITHOUT any redirect (a redirect gives the dying SW one last chance to intercept).
app.get('/gw-nuke', (c) => {
  // We'll inject the nuke script at the TOP of the real app HTML,
  // before anything else runs. The script runs synchronously, kills all SWs
  // and caches, then the rest of the page loads fresh with no SW active.
  const appHtml = getHtml();
  const nukeScript = `<script>
(function(){
  // Kill every SW registration immediately, synchronously where possible
  if('serviceWorker' in navigator){
    navigator.serviceWorker.getRegistrations().then(function(regs){
      regs.forEach(function(r){ r.unregister(); });
    });
    // Also nuke the controller right now
    if(navigator.serviceWorker.controller){
      navigator.serviceWorker.controller.postMessage({type:'SKIP_WAITING'});
    }
  }
  // Wipe all caches
  if('caches' in window){
    caches.keys().then(function(keys){
      keys.forEach(function(k){ caches.delete(k); });
    });
  }
  // Clear storage
  try{ localStorage.clear(); }catch(e){}
  try{ sessionStorage.clear(); }catch(e){}
  // Replace URL so bookmarks/history show / not /gw-nuke
  if(window.history && window.history.replaceState){
    window.history.replaceState(null,'','/');
  }
})();
</script>`;
  // Inject nuke script immediately after <head> opens
  const injected = appHtml.replace('<head>', '<head>' + nukeScript);
  return new Response(injected, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
    }
  });
})

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
// SSE — Server-Sent Events for real-time intra-company sync
// Every time a rep in company X writes data, all other connected reps in
// company X receive a "sync" event and re-pull from D1 immediately.
//
// Cloudflare Workers are stateless — each request runs in an isolated context.
// True multi-client fanout requires Durable Objects, but for a small team (2-5
// users) we use a lightweight long-poll SSE that each browser holds open.
// On any write we broadcast by setting a "last_write" timestamp in D1 settings.
// Each SSE client polls that timestamp every 5 seconds; if it changed since
// the client last saw it, it emits a "sync" event. This gives ≤5-second latency.
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/events/ping — called by writing rep after any D1 mutation
// Sets {company_id}:last_write = ISO timestamp so SSE clients detect the change
app.post('/api/events/ping', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId as string
  const now       = new Date().toISOString()
  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
  ).bind(`${companyId}:last_write`, `${now}|${repId}`).run()
  return json(c, { pinged: true })
})

// GET /api/events/poll — called by each browser tab every 5s via SSE-like long poll
// Returns the latest last_write timestamp so clients can detect peer changes
app.get('/api/events/poll', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const row = await c.env.DB.prepare(
    "SELECT value FROM settings WHERE key = ? LIMIT 1"
  ).bind(`${companyId}:last_write`).first<{ value: string }>()
  return json(c, { lastWrite: row?.value || null })
})

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
  // Log login activity (non-blocking)
  c.executionCtx?.waitUntil?.(logActivity(c.env.DB, {
    companyId: rep.company_id, actorId: rep.id, actorName: rep.name || rep.id,
    entityType: 'session', entityId: rep.id, entityLabel: rep.name || rep.id,
    action: 'login', afterJson: { email: rep.email, role: rep.role }
  }))
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
  deleteCookie(c, 'avalon_session', { path: '/' })
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

// GET /api/auth/bootstrap  — single call on login to hydrate all company config
// Returns: rep list, roles, pipeline stages, nav perms — everything the
// frontend needs to initialize without hardcoded static arrays.
// This is the key endpoint that replaces the static REPS array approach.
app.get('/api/auth/bootstrap', requireAuth, async (c) => {
  const companyId = c.var.companyId as string

  // Run all 4 queries in parallel
  const [repsResult, rolesResult, stagesRow, navPermsRow] = await Promise.all([
    c.env.DB.prepare(
      'SELECT id, name, title, role, color, commission_plan, active, email, email_signature, invite_accepted FROM reps WHERE company_id = ? ORDER BY active DESC, name'
    ).bind(companyId).all(),
    c.env.DB.prepare(
      'SELECT id, label, color, description, permissions, is_system, sort_order FROM roles WHERE company_id = ? ORDER BY sort_order, label'
    ).bind(companyId).all(),
    c.env.DB.prepare(
      "SELECT value FROM settings WHERE key = ? LIMIT 1"
    ).bind(`${companyId}:pipeline_stages`).first<{ value: string }>(),
    c.env.DB.prepare(
      "SELECT value FROM settings WHERE key = ? LIMIT 1"
    ).bind(`${companyId}:nav_perms`).first<{ value: string }>()
  ])

  const defaultStages = [
    "Lead Intake / Rapport","Mutual Agreement Set","Discovery / CBR Uncovered",
    "Budget & Investment Qualified","Decision Process Qualified",
    "Presentation & SOW Pitch","Deal Closed / Won","On Hold","Closed Lost"
  ]
  const defaultNavPerms = {
    admin: ['today','myDashboard','teamView','pipeline','lead','clients','properties','estimates','communications','templates','sequences','talkTracks','playbooks','aiAssist','automations','campaigns','process','forms','scripts','emailTemplates','objections','calculator','ai','academy','financialHub','invoices','payments','deposits','statements','financialActivity','scheduleBoard','dispatchBoard','recurringServices','crewView','workOrderList','workOrderDetail','assetList','assetDetail','maintenanceQueue','inventoryList','materialAllocation','toolsConsumables','timeTracker','revenueAdmin','salesReports','financialReports','opsReports','teamReports','settings','userManagement','integrations','manager','systemConfig','systemTemplates','opsHub'],
    office_manager: ['today','myDashboard','teamView','pipeline','lead','clients','properties','estimates','communications','templates','sequences','talkTracks','playbooks','aiAssist','automations','campaigns','process','forms','scripts','emailTemplates','objections','calculator','ai','academy','financialHub','invoices','payments','deposits','statements','financialActivity','scheduleBoard','dispatchBoard','recurringServices','crewView','workOrderList','workOrderDetail','assetList','assetDetail','maintenanceQueue','inventoryList','materialAllocation','toolsConsumables','timeTracker','revenueAdmin','salesReports','financialReports','opsReports','teamReports','settings','userManagement','integrations','manager'],
    rep: ['today','myDashboard','pipeline','lead','clients','properties','estimates','communications','templates','sequences','talkTracks','playbooks','aiAssist','automations','campaigns','process','forms','scripts','emailTemplates','objections','calculator','ai','academy'],
    estimator: ['today','pipeline','clients','properties','estimates','calculator','forms','playbooks'],
    foreman: ['today','myDashboard','scheduleBoard','dispatchBoard','recurringServices','crewView','workOrderList','workOrderDetail','assetList','assetDetail','maintenanceQueue','inventoryList','toolsConsumables','timeTracker','opsReports','teamReports','approvalQueue','fieldMode'],
    laborer: ['today','scheduleBoard','workOrderList','timeTracker','fieldMode'],
    view_only: ['today','pipeline'],
    // Legacy alias — D1 rows where role='field_supervisor' still resolve correctly
    field_supervisor: ['today','myDashboard','scheduleBoard','dispatchBoard','recurringServices','crewView','workOrderList','workOrderDetail','assetList','assetDetail','maintenanceQueue','inventoryList','toolsConsumables','timeTracker','opsReports','teamReports','approvalQueue','fieldMode']
  }

  let stages = defaultStages
  try { if (stagesRow?.value) stages = JSON.parse(stagesRow.value) } catch(_) {}

  let navPerms = defaultNavPerms
  try { if (navPermsRow?.value) navPerms = { ...defaultNavPerms, ...JSON.parse(navPermsRow.value) } } catch(_) {}

  // Parse permissions JSON in roles
  const roles = (rolesResult.results || []).map((r: any) => {
    let perms = {}
    try { perms = JSON.parse(r.permissions || '{}') } catch(_) {}
    return { ...r, permissions: perms }
  })

  return json(c, {
    reps: repsResult.results || [],
    roles,
    pipelineStages: stages,
    navPerms
  })
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

// ── Company Branding API ──────────────────────────────────────────────────────
// GET /api/branding/login  — PUBLIC endpoint: returns minimal branding for login screen (no auth)
// Returns only name, logo_url, brand_color — safe to expose publicly
app.get('/api/branding/login', async (c) => {
  const db = c.env.DB as D1Database
  // Always returns the first/main non-platform company
  const row: any = await db.prepare(
    `SELECT name, logo_url, brand_color FROM companies WHERE id != 'groundwork_platform' ORDER BY created_at ASC LIMIT 1`
  ).first()
  return c.json({
    name:        row?.name        || 'Groundwork',
    logo_url:    row?.logo_url    || '',
    brand_color: row?.brand_color || '#2D7A55',
  })
})

// GET /api/company/branding  — full branding/identity for authenticated company
app.get('/api/company/branding', requireAuth, async (c) => {
  const companyId = (c.var.companyId as string) || 'avalon'
  const row: any = await c.env.DB.prepare(`
    SELECT id, name, slug, phone, website, logo_url, timezone, owner_email,
           tagline, brand_color, brand_accent, business_type,
           crew_count, division_count,
           address_line1, address_city, address_state, address_zip,
           license_number, insurance_info, year_founded,
           service_area_desc, terminology,
           onboarding_completed, onboarding_step
    FROM companies WHERE id = ? LIMIT 1
  `).bind(companyId).first()
  if (!row) return err(c, 'Company not found', 404)
  try { row.terminology = JSON.parse(row.terminology || '{}') } catch(_) { row.terminology = {} }
  return json(c, row)
})

// PUT /api/company/branding  — update branding/identity fields
app.put('/api/company/branding', requireAuth, async (c) => {
  const companyId = (c.var.companyId as string) || 'avalon'
  const b = await c.req.json()
  const allowed = [
    'name','phone','website','logo_url','timezone','owner_email',
    'tagline','brand_color','brand_accent','business_type',
    'crew_count','division_count',
    'address_line1','address_city','address_state','address_zip',
    'license_number','insurance_info','year_founded',
    'service_area_desc','terminology',
    'onboarding_completed','onboarding_step'
  ]
  const updates = allowed.filter(f => b[f] !== undefined)
  if (!updates.length) return err(c, 'Nothing to update')
  const vals = updates.map(f => {
    if (f === 'terminology' && typeof b[f] === 'object') return JSON.stringify(b[f])
    return b[f]
  })
  const set = updates.map(f => `${f} = ?`).join(', ')
  await c.env.DB.prepare(
    `UPDATE companies SET ${set}, updated_at = datetime('now') WHERE id = ?`
  ).bind(...vals, companyId).run()
  return json(c, { updated: companyId })
})

// POST /api/companies  — onboard a new company (public endpoint for signup flow)
// Creates the company record AND seeds the company's "folder" in settings:
//   {companyId}:created_at   — ISO timestamp when company was onboarded
//   {companyId}:last_write   — used by poll-sync to detect peer changes
// This is the canonical entry point — ALL company data lives under {companyId}:*
app.post('/api/companies', async (c) => {
  const b = await c.req.json()
  if (!b.name || !b.slug) return err(c, 'name and slug required')
  // Check slug uniqueness
  const existing = await c.env.DB.prepare('SELECT id FROM companies WHERE slug = ? LIMIT 1').bind(b.slug).first()
  if (existing) return err(c, 'That company URL is already taken', 409)
  const id = b.slug // slug doubles as the company_id — e.g. 'avalon', 'acme-lawns'
  const now = new Date().toISOString()
  await c.env.DB.prepare(`
    INSERT INTO companies (id, name, slug, plan, owner_email, phone, website, timezone, active)
    VALUES (?, ?, ?, 'trial', ?, ?, ?, ?, 1)
  `).bind(id, b.name, b.slug, b.ownerEmail||'', b.phone||'', b.website||'', b.timezone||'America/New_York').run()
  // ── Seed company "folder" in settings ────────────────────────────────────
  // Every company gets these rows on creation so the folder always exists.
  const seedSettings = [
    [`${id}:created_at`,        now],
    [`${id}:last_write`,        `${now}|system`],
    [`${id}:db_migrated_v1`,    ''],           // cleared so first login runs migration
    [`${id}:plan`,              'trial'],
    [`${id}:onboarded_by`,      b.ownerEmail||''],
  ]
  for (const [key, val] of seedSettings) {
    await c.env.DB.prepare(
      "INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    ).bind(key, val).run()
  }
  return json(c, { id, slug: b.slug }, 201)
})

// ══════════════════════════════════════════════════════════════════════════════
// REPS  — all scoped to company_id
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/reps  — scoped to session's company
app.get('/api/reps', requireAuth, async (c) => {
  const companyId = (c.var.companyId as string) || c.req.query('companyId') || 'avalon'
  const rows = await c.env.DB.prepare(
    'SELECT id, name, title, role, color, commission_plan, active, company_id, email, email_signature, invite_accepted, invite_sent_at FROM reps WHERE company_id = ? ORDER BY active DESC, name'
  ).bind(companyId).all()
  return json(c, rows.results)
})

// GET /api/reps/:id
app.get('/api/reps/:id', requireAuth, async (c) => {
  const companyId = (c.var.companyId as string) || c.req.query('companyId') || 'avalon'
  const row = await c.env.DB.prepare(
    'SELECT id, name, title, role, color, commission_plan, active, company_id, email_signature FROM reps WHERE id = ? AND company_id = ? LIMIT 1'
  ).bind(c.req.param('id'), companyId).first()
  if (!row) return err(c, 'Rep not found', 404)
  return json(c, row)
})

// POST /api/reps  — add a rep to a company (admin/office_manager only)
// Accepts password (preferred) or pin (legacy) for the initial credential
app.post('/api/reps', requireAuth, async (c) => {
  const b = await c.req.json()
  // companyId comes from the session (authoritative); b.companyId ignored for security
  const companyId = c.var.companyId as string
  const sessionRole = c.var.role as string
  if (sessionRole !== 'admin' && sessionRole !== 'office_manager') return err(c, 'Only admins can add users', 403)
  const credential = b.password || b.pin
  if (!b.id || !b.name || !credential) return err(c, 'id, name, and password are required')
  if (!b.email) return err(c, 'email required — users log in with their email address')
  const pinHash = await hashPin(String(credential))
  await c.env.DB.prepare(`
    INSERT INTO reps (id, name, title, role, pin, pin_hash, email, color, commission_plan, company_id, active)
    VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, 1)
  `).bind(b.id, b.name, b.title||'', b.role||'rep', pinHash, b.email, b.color||'#6366f1', b.commissionPlan||'standard', companyId).run()
  return json(c, { id: b.id }, 201)
})

// PUT /api/reps/:id
app.put('/api/reps/:id', requireAuth, async (c) => {
  const id = c.req.param('id')
  const b  = await c.req.json()
  const companyId = (c.var.companyId as string) || b.companyId || 'avalon'
  const fields = ['name','title','role','color','email','commission_plan','active','email_signature']
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
// ROLES  — per-company role definitions (generic, not hardcoded to any company)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/roles  — returns all roles for the session's company
// Used at login to hydrate the frontend role system dynamically.
app.get('/api/roles', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const rows = await c.env.DB.prepare(
    'SELECT id, company_id, label, color, description, permissions, is_system, sort_order FROM roles WHERE company_id = ? ORDER BY sort_order, label'
  ).bind(companyId).all()
  return json(c, rows.results)
})

// POST /api/roles  — create a custom role (admin only)
app.post('/api/roles', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role      = c.var.role as string
  if (role !== 'admin') return err(c, 'Only admins can create roles', 403)
  const b = await c.req.json()
  if (!b.id || !b.label) return err(c, 'id and label required')
  // Prevent collisions with system role IDs
  const existing = await c.env.DB.prepare(
    'SELECT id FROM roles WHERE id = ? AND company_id = ? LIMIT 1'
  ).bind(b.id, companyId).first()
  if (existing) return err(c, 'A role with that ID already exists', 409)
  await c.env.DB.prepare(`
    INSERT INTO roles (id, company_id, label, color, description, permissions, is_system, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `).bind(
    b.id, companyId, b.label,
    b.color || '#6F7E6A',
    b.description || '',
    b.permissions ? JSON.stringify(b.permissions) : '{"views":["today","pipeline","settings"],"can_see_all_leads":false,"can_manage_users":false,"can_view_financials":false,"can_edit_roles":false,"can_export":false,"can_delete_leads":false}',
    b.sort_order ?? 99
  ).run()
  return json(c, { id: b.id, company_id: companyId }, 201)
})

// PUT /api/roles/:id  — update a role's label, color, description, or permissions
app.put('/api/roles/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role      = c.var.role as string
  if (role !== 'admin') return err(c, 'Only admins can edit roles', 403)
  const roleId = c.req.param('id')
  const b = await c.req.json()
  const allowed = ['label','color','description','sort_order']
  const updates: string[] = []
  const vals: any[] = []
  for (const f of allowed) {
    if (b[f] !== undefined) { updates.push(`${f} = ?`); vals.push(b[f]) }
  }
  if (b.permissions !== undefined) {
    updates.push('permissions = ?')
    vals.push(typeof b.permissions === 'string' ? b.permissions : JSON.stringify(b.permissions))
  }
  if (!updates.length) return err(c, 'Nothing to update')
  updates.push("updated_at = datetime('now')")
  await c.env.DB.prepare(
    `UPDATE roles SET ${updates.join(', ')} WHERE id = ? AND company_id = ?`
  ).bind(...vals, roleId, companyId).run()
  return json(c, { updated: roleId })
})

// DELETE /api/roles/:id  — delete a custom role (cannot delete system roles)
app.delete('/api/roles/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role      = c.var.role as string
  if (role !== 'admin') return err(c, 'Only admins can delete roles', 403)
  const roleId = c.req.param('id')
  // Block deletion of system roles
  const row = await c.env.DB.prepare(
    'SELECT is_system FROM roles WHERE id = ? AND company_id = ? LIMIT 1'
  ).bind(roleId, companyId).first<{ is_system: number }>()
  if (!row) return err(c, 'Role not found', 404)
  if (row.is_system) return err(c, 'System roles cannot be deleted. You can edit their permissions instead.', 403)
  // Check no reps are currently using this role
  const repCount = await c.env.DB.prepare(
    'SELECT COUNT(*) as n FROM reps WHERE role = ? AND company_id = ? AND active = 1'
  ).bind(roleId, companyId).first<{ n: number }>()
  if (repCount && repCount.n > 0) return err(c, `Cannot delete: ${repCount.n} active user(s) have this role. Reassign them first.`, 409)
  await c.env.DB.prepare('DELETE FROM roles WHERE id = ? AND company_id = ?').bind(roleId, companyId).run()
  return json(c, { deleted: roleId })
})

// ══════════════════════════════════════════════════════════════════════════════
// ACTIVITY LOG  — append-only audit trail for all company mutations
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/activity-log  — paginated activity log for the session's company
// ?limit=50&offset=0&entity_type=opportunity&entity_id=opp_abc&actor_id=tyler
app.get('/api/activity-log', requireAuth, async (c) => {
  const companyId  = c.var.companyId as string
  const role       = c.var.role as string
  // Only admin and office_manager can read the full audit log
  if (role !== 'admin' && role !== 'office_manager') return err(c, 'Access restricted', 403)
  const limit      = Math.min(parseInt(c.req.query('limit') || '50'), 200)
  const offset     = parseInt(c.req.query('offset') || '0')
  const entityType = c.req.query('entity_type') || ''
  const entityId   = c.req.query('entity_id') || ''
  const actorId    = c.req.query('actor_id') || ''

  let q = 'SELECT * FROM activity_log WHERE company_id = ?'
  const params: any[] = [companyId]
  if (entityType) { q += ' AND entity_type = ?'; params.push(entityType) }
  if (entityId)   { q += ' AND entity_id = ?';   params.push(entityId) }
  if (actorId)    { q += ' AND actor_id = ?';     params.push(actorId) }
  q += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)
  const rows = await c.env.DB.prepare(q).bind(...params).all()
  return json(c, rows.results)
})

// POST /api/activity-log  — internal only; called by server-side write operations
// Clients CANNOT post to this endpoint directly — they call regular mutation endpoints
// which call logActivity() internally.
// Exposed here for Cloudflare Queue consumers or future server-to-server logging.
async function logActivity(
  db: D1Database,
  { companyId, actorId, actorName, entityType, entityId, entityLabel, action, beforeJson, afterJson }: {
    companyId: string; actorId: string; actorName: string;
    entityType: string; entityId: string; entityLabel: string;
    action: string; beforeJson?: any; afterJson?: any
  }
) {
  try {
    const id = 'act_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    await db.prepare(`
      INSERT INTO activity_log
        (id, company_id, actor_id, actor_name, entity_type, entity_id, entity_label, action, before_json, after_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, companyId, actorId, actorName,
      entityType, entityId, entityLabel, action,
      beforeJson ? JSON.stringify(beforeJson) : '',
      afterJson  ? JSON.stringify(afterJson)  : ''
    ).run()
  } catch (_) {
    // Activity log failures must never break the main operation
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// PIPELINE STAGES  — per-company pipeline stage configuration
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/pipeline-stages  — returns ordered stage list for session's company
// Falls back to the 9-stage default if company hasn't customized yet.
app.get('/api/pipeline-stages', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const row = await c.env.DB.prepare(
    "SELECT value FROM settings WHERE key = ? LIMIT 1"
  ).bind(`${companyId}:pipeline_stages`).first<{ value: string }>()
  const defaultStages = [
    "Lead Intake / Rapport","Mutual Agreement Set","Discovery / CBR Uncovered",
    "Budget & Investment Qualified","Decision Process Qualified",
    "Presentation & SOW Pitch","Deal Closed / Won","On Hold","Closed Lost"
  ]
  let stages = defaultStages
  if (row?.value) {
    try { stages = JSON.parse(row.value) } catch(_) {}
  } else {
    // Seed the default for this company if it doesn't exist yet
    await c.env.DB.prepare(
      "INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    ).bind(`${companyId}:pipeline_stages`, JSON.stringify(defaultStages)).run()
  }
  return json(c, stages)
})

// PUT /api/pipeline-stages  — admin only — update company's pipeline stages
app.put('/api/pipeline-stages', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role      = c.var.role as string
  if (role !== 'admin' && role !== 'office_manager') return err(c, 'Admin access required', 403)
  const b = await c.req.json()
  if (!Array.isArray(b.stages) || b.stages.length < 2) return err(c, 'stages must be an array with at least 2 items')
  const stages = (b.stages as any[]).map(s => String(s).trim()).filter(Boolean)
  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
  ).bind(`${companyId}:pipeline_stages`, JSON.stringify(stages)).run()
  // Log the change
  await logActivity(c.env.DB, {
    companyId, actorId: c.var.repId, actorName: c.var.repId,
    entityType: 'pipeline_stage', entityId: companyId, entityLabel: 'Pipeline Stages',
    action: 'updated', afterJson: stages
  })
  return json(c, { stages })
})

// ══════════════════════════════════════════════════════════════════════════════
// NAV PERMISSIONS  — per-company per-role nav tab access (replaces localStorage)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/nav-perms  — returns nav permissions JSON for session's company
app.get('/api/nav-perms', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const row = await c.env.DB.prepare(
    "SELECT value FROM settings WHERE key = ? LIMIT 1"
  ).bind(`${companyId}:nav_perms`).first<{ value: string }>()
  const defaultPerms = {
    admin: ['gwDashboard','gwSales','gwFinancial','gwOperations','gwAdmin',
      'today','myDashboard','teamView','pipeline','lead','clients','properties','estimates',
      'communications','templates','sequences','talkTracks','playbooks','aiAssist',
      'automations','campaigns','process','forms','scripts','emailTemplates','objections','calculator','ai','academy',
      'financialHub','invoices','payments','deposits','statements','financialActivity',
      'scheduleBoard','dispatchBoard','recurringServices','crewView','workOrderList','workOrderDetail',
      'assetList','assetDetail','maintenanceQueue','inventoryList','materialAllocation','toolsConsumables','timeTracker',
      'revenueAdmin','salesReports','financialReports','opsReports','teamReports',
      'settings','userManagement','integrations','manager','systemConfig','systemTemplates','opsHub',
      'approvalQueue','auditLog','portalAdmin','automationCenter','fieldMode'],
    office_manager: ['gwDashboard','gwSales','gwFinancial','gwOperations','gwAdmin',
      'today','myDashboard','teamView','pipeline','lead','clients','properties','estimates',
      'communications','templates','sequences','talkTracks','playbooks','aiAssist',
      'automations','campaigns','process','forms','scripts','emailTemplates','objections','calculator','ai','academy',
      'financialHub','invoices','payments','deposits','statements','financialActivity',
      'scheduleBoard','dispatchBoard','recurringServices','crewView','workOrderList','workOrderDetail',
      'assetList','assetDetail','maintenanceQueue','inventoryList','materialAllocation','toolsConsumables','timeTracker',
      'revenueAdmin','salesReports','financialReports','opsReports','teamReports',
      'settings','userManagement','integrations','manager','approvalQueue','auditLog','portalAdmin','automationCenter'],
    rep: ['gwDashboard','gwSales',
      'today','myDashboard','pipeline','lead','clients','properties','estimates',
      'communications','templates','sequences','talkTracks','playbooks','aiAssist',
      'automations','campaigns','process','forms','scripts','emailTemplates','objections','calculator','ai','academy'],
    estimator: ['gwDashboard','gwSales','today','pipeline','clients','properties','estimates','calculator','forms','playbooks'],
    foreman: ['gwDashboard','gwOperations','gwAdmin',
      'today','fieldDashboard','myDashboard','scheduleBoard','dispatchBoard','recurringServices','crewView',
      'workOrderList','workOrderDetail','assetList','assetDetail',
      'maintenanceQueue','inventoryList','toolsConsumables','timeTracker',
      'opsReports','teamReports','approvalQueue','fieldMode','gwTimesheetAdmin'],
    laborer: ['gwDashboard','gwOperations','today','fieldDashboard','scheduleBoard','workOrderList','timeTracker','fieldMode'],
    view_only: ['gwDashboard','today','pipeline'],
    // Legacy alias — field_supervisor rows in D1 still get correct permissions
    field_supervisor: ['gwDashboard','gwOperations','gwAdmin',
      'today','fieldDashboard','myDashboard','scheduleBoard','dispatchBoard','recurringServices','crewView',
      'workOrderList','workOrderDetail','assetList','assetDetail',
      'maintenanceQueue','inventoryList','toolsConsumables','timeTracker',
      'opsReports','teamReports','approvalQueue','fieldMode','gwTimesheetAdmin']
  }
  let perms = defaultPerms
  if (row?.value) {
    try { perms = { ...defaultPerms, ...JSON.parse(row.value) } } catch(_) {}
  }
  return json(c, perms)
})

// PUT /api/nav-perms  — admin only — update nav permissions per role
app.put('/api/nav-perms', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role      = c.var.role as string
  if (role !== 'admin') return err(c, 'Only admins can edit permissions', 403)
  const b = await c.req.json()
  if (!b.perms || typeof b.perms !== 'object') return err(c, 'perms object required')
  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
  ).bind(`${companyId}:nav_perms`, JSON.stringify(b.perms)).run()
  return json(c, { saved: true })
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
    : role === 'foreman' ? 'Foreman'
    : role === 'field_supervisor' ? 'Foreman'
    : role === 'laborer' ? 'Laborer'
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
    : rep.role === 'foreman' ? 'Foreman'
    : rep.role === 'field_supervisor' ? 'Foreman'
    : rep.role === 'laborer' ? 'Laborer'
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
// PREFERRED: Use session cookie for company scoping (requireAuth sets c.var.companyId).
// Falls back to ?companyId= query param for unauthenticated/legacy callers.
app.get('/api/opportunities', requireAuth, async (c) => {
  // Session-authenticated company takes precedence over query param
  const companyId = (c.var.companyId as string) || c.req.query('companyId') || 'avalon'
  const repId     = c.req.query('repId')
  const status    = c.req.query('status')
  let q = 'SELECT * FROM opportunities WHERE company_id = ?'
  const params: any[] = [companyId]
  // When filtering by rep: show leads where rep_id = X OR assigned_to_rep_id = X
  // This ensures a lead created by Jen but assigned to Tyler appears in Tyler's list
  if (repId)  {
    q += ' AND (rep_id = ? OR (assigned_to_rep_id != \'\' AND assigned_to_rep_id = ?))'
    params.push(repId, repId)
  }
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
// Uses session cookie company_id as authoritative source — prevents cross-tenant writes.
app.post('/api/opportunities', requireAuth, async (c) => {
  const b = await c.req.json()
  const id        = b.id || ('opp_' + uid())
  // Session company_id is authoritative — body companyId is a hint only
  const companyId = (c.var.companyId as string) || b.companyId || b.company_id || 'avalon'
  const effRepId = b.repId||b.rep_id||null
  // assigned_to_rep_id: if Jen creates and assigns to Tyler, set to Tyler's id
  // defaults to same as rep_id (owner = assignee for reps creating their own leads)
  const assignedTo = b.assignedToRepId||b.assigned_to_rep_id||effRepId||''
  await c.env.DB.prepare(`
    INSERT INTO opportunities (
      id, company_id, rep_id, assigned_to_rep_id,
      client, phone, email, address, service_line, source, status,
      job_value, project, urgency, decision_maker, budget_range, next_follow_up,
      pipeline_stage, estimate_amount, estimate_sent_date, estimate_count,
      work_type, client_type, prompt, desired_outcome, fit_concerns,
      commission_approved, collected, sold_date, sold_amount,
      created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
  `).bind(
    id, companyId, effRepId, assignedTo,
    b.client||'', b.phone||'', b.email||'',
    b.address||'', b.serviceLine||b.service_line||'', b.source||'',
    b.status||'Lead Intake / Rapport', Number(b.jobValue||b.job_value||0),
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
  // Broadcast + activity log (non-blocking)
  c.executionCtx?.waitUntil?.(Promise.all([
    c.env.DB.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    ).bind(`${companyId}:last_write`, `${new Date().toISOString()}|${c.var.repId}`).run(),
    logActivity(c.env.DB, {
      companyId, actorId: c.var.repId, actorName: c.var.repId,
      entityType: 'opportunity', entityId: id,
      entityLabel: b.client || id,
      action: 'created', afterJson: { client: b.client, status: b.status || 'Lead Intake / Rapport', repId: effRepId }
    })
  ]))
  return json(c, { id }, 201)
})

// PUT /api/opportunities/:id
app.put('/api/opportunities/:id', requireAuth, async (c) => {
  const id        = c.req.param('id')
  const b         = await c.req.json()
  const companyId = (c.var.companyId as string) || b.companyId || b.company_id || 'avalon'
  const fieldMap: Record<string,string> = {
    repId:'rep_id', assignedToRepId:'assigned_to_rep_id',
    client:'client', phone:'phone', email:'email',
    address:'address', serviceLine:'service_line', source:'source',
    status:'status', jobValue:'job_value', project:'project',
    urgency:'urgency', decisionMaker:'decision_maker', budgetRange:'budget_range',
    nextFollowUp:'next_follow_up', pipelineStage:'pipeline_stage',
    estimateAmount:'estimate_amount', estimateSentDate:'estimate_sent_date',
    estimateCount:'estimate_count', workType:'work_type', clientType:'client_type',
    prompt:'prompt', desiredOutcome:'desired_outcome', fitConcerns:'fit_concerns',
    commissionApproved:'commission_approved', collected:'collected',
    soldDate:'sold_date', soldAmount:'sold_amount',
    rep_id:'rep_id', assigned_to_rep_id:'assigned_to_rep_id',
    service_line:'service_line', job_value:'job_value',
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
  // Broadcast + activity log (non-blocking)
  c.executionCtx?.waitUntil?.(Promise.all([
    c.env.DB.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    ).bind(`${companyId}:last_write`, `${new Date().toISOString()}|${c.var.repId}`).run(),
    logActivity(c.env.DB, {
      companyId, actorId: c.var.repId, actorName: c.var.repId,
      entityType: 'opportunity', entityId: id, entityLabel: id,
      action: b.status ? 'status_changed' : 'updated',
      afterJson: { fields: Object.keys(b).filter(k => k !== 'companyId') }
    })
  ]))
  return json(c, { updated: id })
})

// DELETE /api/opportunities/:id
app.delete('/api/opportunities/:id', requireAuth, async (c) => {
  const id        = c.req.param('id')
  const companyId = (c.var.companyId as string) || c.req.query('companyId') || 'avalon'
  const role      = c.var.role as string

  // Admins always allowed. For other roles, check can_delete_leads permission.
  if (role !== 'admin') {
    const roleDef = await c.env.DB.prepare(
      `SELECT permissions FROM roles WHERE id = ? AND company_id = ? LIMIT 1`
    ).bind(role, companyId).first<{ permissions: string }>()
    let perms: any = {}
    try { perms = JSON.parse(roleDef?.permissions || '{}') } catch(_) {}
    if (!perms.can_delete_leads) return err(c, 'Permission denied: cannot delete leads', 403)
  }

  await c.env.DB.prepare('DELETE FROM opportunities WHERE id = ? AND company_id = ?').bind(id, companyId).run()
  // Broadcast + activity log (non-blocking)
  c.executionCtx?.waitUntil?.(Promise.all([
    c.env.DB.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    ).bind(`${companyId}:last_write`, `${new Date().toISOString()}|${c.var.repId}`).run(),
    logActivity(c.env.DB, {
      companyId, actorId: c.var.repId, actorName: c.var.repId,
      entityType: 'opportunity', entityId: id, entityLabel: id,
      action: 'deleted', afterJson: {}
    })
  ]))
  return json(c, { deleted: id })
})

// POST /api/opportunities/bulk-upsert
// Used on login to push localStorage-only leads to D1 (one-time migration / recovery).
// Accepts array of opp objects. Uses session company_id. Skips opps already in D1.
app.post('/api/opportunities/bulk-upsert', requireAuth, async (c) => {
  const companyId = c.var.companyId as string || 'avalon'
  const repId     = c.var.repId as string
  const b = await c.req.json()
  const opps: any[] = Array.isArray(b.opps) ? b.opps : []
  if (!opps.length) return json(c, { inserted: 0, skipped: 0 })

  // Fetch IDs already in D1 for this company to avoid duplicates
  const existing = await c.env.DB.prepare(
    'SELECT id FROM opportunities WHERE company_id = ?'
  ).bind(companyId).all()
  const existingIds = new Set((existing.results as any[]).map((r: any) => r.id))

  let inserted = 0
  let skipped  = 0
  for (const opp of opps) {
    if (!opp.id) { skipped++; continue }
    if (existingIds.has(opp.id)) { skipped++; continue }
    const effRepId = opp.repId || opp.rep_id || repId || null
    await c.env.DB.prepare(`
      INSERT INTO opportunities (
        id, company_id, rep_id, client, phone, email, address, service_line, source, status,
        job_value, project, urgency, decision_maker, budget_range, next_follow_up,
        pipeline_stage, estimate_amount, estimate_sent_date, estimate_count,
        work_type, client_type, prompt, desired_outcome, fit_concerns,
        commission_approved, collected, sold_date, sold_amount,
        created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
        COALESCE(?,datetime('now')), COALESCE(?,datetime('now')))
    `).bind(
      opp.id, companyId, effRepId, opp.client||'', opp.phone||'', opp.email||'',
      opp.address||'', opp.serviceLine||opp.service_line||'', opp.source||'',
      opp.status||'New Lead', Number(opp.jobValue||opp.job_value||0),
      opp.project||'', opp.urgency||'', opp.decisionMaker||opp.decision_maker||'',
      opp.budgetRange||opp.budget_range||'', opp.nextFollowUp||opp.next_follow_up||'',
      opp.pipelineStage||opp.pipeline_stage||'',
      Number(opp.estimateAmount||opp.estimate_amount||0),
      opp.estimateSentDate||opp.estimate_sent_date||'',
      Number(opp.estimateCount||opp.estimate_count||0),
      opp.workType||opp.work_type||'', opp.clientType||opp.client_type||'',
      opp.prompt||'', opp.desiredOutcome||opp.desired_outcome||'',
      opp.fitConcerns||opp.fit_concerns||'',
      opp.commissionApproved||opp.commission_approved?1:0,
      opp.collected?1:0, opp.soldDate||opp.sold_date||'',
      Number(opp.soldAmount||opp.sold_amount||0),
      opp.createdAt||opp.created_at||null,
      opp.updatedAt||opp.updated_at||null
    ).run()
    inserted++
  }
  // Broadcast to all company users if any were inserted
  if (inserted > 0) {
    c.executionCtx?.waitUntil?.(c.env.DB.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    ).bind(`${companyId}:last_write`, `${new Date().toISOString()}|${c.var.repId}`).run())
  }
  return json(c, { inserted, skipped })
})

// ══════════════════════════════════════════════════════════════════════════════
// NOTES  — scoped via opp_id (opp already scoped to company)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/opportunities/:oppId/notes
app.get('/api/opportunities/:oppId/notes', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const rows = await c.env.DB.prepare(
    'SELECT * FROM notes WHERE opp_id = ? AND company_id = ? ORDER BY created_at DESC'
  ).bind(c.req.param('oppId'), companyId).all()
  return json(c, rows.results)
})

// POST /api/opportunities/:oppId/notes
app.post('/api/opportunities/:oppId/notes', requireAuth, async (c) => {
  const oppId     = c.req.param('oppId')
  const b         = await c.req.json()
  const companyId = c.var.companyId as string
  if (!b.body?.trim()) return err(c, 'body required')
  const id = 'note_' + uid()
  await c.env.DB.prepare(
    'INSERT INTO notes (id, opp_id, rep_id, body, company_id) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, oppId, b.repId||null, b.body.trim(), companyId).run()
  // Broadcast: note added means opp activity changed — teammates should refresh
  c.executionCtx?.waitUntil?.(c.env.DB.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
  ).bind(`${companyId}:last_write`, `${new Date().toISOString()}|${c.var.repId}`).run())
  return json(c, { id }, 201)
})

// DELETE /api/notes/:id
app.delete('/api/notes/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  await c.env.DB.prepare('DELETE FROM notes WHERE id = ? AND company_id = ?').bind(c.req.param('id'), companyId).run()
  return json(c, { deleted: c.req.param('id') })
})

// ══════════════════════════════════════════════════════════════════════════════
// COMMUNICATIONS  — scoped by company_id
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/opportunities/:oppId/comms
app.get('/api/opportunities/:oppId/comms', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const rows = await c.env.DB.prepare(
    'SELECT * FROM communications WHERE opp_id = ? AND company_id = ? ORDER BY ts DESC'
  ).bind(c.req.param('oppId'), companyId).all()
  return json(c, rows.results)
})

// POST /api/opportunities/:oppId/comms
app.post('/api/opportunities/:oppId/comms', requireAuth, async (c) => {
  const oppId     = c.req.param('oppId')
  const b         = await c.req.json()
  const companyId = c.var.companyId as string
  const id = 'comm_' + uid()
  await c.env.DB.prepare(
    "INSERT INTO communications (id, opp_id, rep_id, type, direction, subject, body, ts, company_id) VALUES (?,?,?,?,?,?,?,datetime('now'),?)"
  ).bind(id, oppId, b.repId||null, b.type||'note', b.direction||'out', b.subject||'', b.body||'', companyId).run()
  return json(c, { id }, 201)
})

// GET /api/comms  (activity log)
app.get('/api/comms', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
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

app.get('/api/opportunities/:oppId/files', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const rows = await c.env.DB.prepare(
    'SELECT * FROM files WHERE opp_id = ? AND company_id = ? ORDER BY created_at DESC'
  ).bind(c.req.param('oppId'), companyId).all()
  return json(c, rows.results)
})

app.post('/api/opportunities/:oppId/files', requireAuth, async (c) => {
  const oppId     = c.req.param('oppId')
  const b         = await c.req.json()
  const companyId = c.var.companyId as string
  const id = 'file_' + uid()
  await c.env.DB.prepare(
    'INSERT INTO files (id, opp_id, rep_id, name, size, mime_type, url, company_id) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(id, oppId, b.repId||null, b.name||'', b.size||0, b.mimeType||'', b.url||'', companyId).run()
  return json(c, { id }, 201)
})

// ══════════════════════════════════════════════════════════════════════════════
// CHECKLIST PROGRESS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/checklist/:oppId', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const rows = await c.env.DB.prepare(
    'SELECT * FROM checklist_progress WHERE opp_id = ? AND company_id = ?'
  ).bind(c.req.param('oppId'), companyId).all()
  return json(c, rows.results)
})

app.put('/api/checklist', requireAuth, async (c) => {
  const b = await c.req.json()
  const { oppId, checklistId, itemIndex, checked } = b
  const companyId = c.var.companyId as string
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

app.get('/api/clients', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const rows = await c.env.DB.prepare(
    'SELECT * FROM clients WHERE company_id = ? ORDER BY name ASC'
  ).bind(companyId).all()
  return json(c, rows.results)
})

app.post('/api/clients', requireAuth, async (c) => {
  const b = await c.req.json()
  const id        = b.id || ('client_' + uid())
  const companyId = c.var.companyId as string
  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO clients (id, name, phone, email, address, type, notes, company_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))"
  ).bind(id, b.name||'', b.phone||'', b.email||'', b.address||'', b.type||'Residential', b.notes||'', companyId).run()
  return json(c, { id }, 201)
})

app.put('/api/clients/:id', requireAuth, async (c) => {
  const id        = c.req.param('id')
  const b         = await c.req.json()
  const companyId = c.var.companyId as string
  await c.env.DB.prepare(
    "UPDATE clients SET name=?, phone=?, email=?, address=?, type=?, notes=?, updated_at=datetime('now') WHERE id=? AND company_id=?"
  ).bind(b.name||'', b.phone||'', b.email||'', b.address||'', b.type||'Residential', b.notes||'', id, companyId).run()
  return json(c, { updated: id })
})

app.delete('/api/clients/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  await c.env.DB.prepare('DELETE FROM clients WHERE id = ? AND company_id = ?').bind(c.req.param('id'), companyId).run()
  return json(c, { deleted: c.req.param('id') })
})

// ══════════════════════════════════════════════════════════════════════════════
// CUSTOMERS — rich single-customer endpoint for the Customer Detail page
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/customers/:id — fetch a single client with all fields
app.get('/api/customers/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const id = c.req.param('id')
  const row: any = await c.env.DB.prepare(
    'SELECT * FROM clients WHERE id = ? AND company_id = ?'
  ).bind(id, companyId).first()
  if (!row) return c.json({ ok: false, error: 'Not found' }, 404)
  return json(c, {
    ...row,
    tags: JSON.parse(row.tags || '[]'),
    properties: JSON.parse(row.properties || '[]'),
  })
})

// PUT /api/customers/:id — update a client with all fields
app.put('/api/customers/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const id = c.req.param('id')
  const b: any = await c.req.json()
  await c.env.DB.prepare(`
    UPDATE clients SET
      name=COALESCE(?,name), phone=COALESCE(?,phone), email=COALESCE(?,email),
      address=COALESCE(?,address), type=COALESCE(?,type), notes=COALESCE(?,notes),
      street=COALESCE(?,street), street2=COALESCE(?,street2), city=COALESCE(?,city),
      state=COALESCE(?,state), zip=COALESCE(?,zip), mobile=COALESCE(?,mobile),
      email2=COALESCE(?,email2), since=COALESCE(?,since),
      tags=COALESCE(?,tags), properties=COALESCE(?,properties), status=COALESCE(?,status),
      updated_at=datetime('now')
    WHERE id=? AND company_id=?
  `).bind(
    b.name||null, b.phone||null, b.email||null, b.address||null, b.type||null, b.notes||null,
    b.street||null, b.street2||null, b.city||null, b.state||null, b.zip||null, b.mobile||null,
    b.email2||null, b.since||null,
    b.tags !== undefined ? JSON.stringify(b.tags) : null,
    b.properties !== undefined ? JSON.stringify(b.properties) : null,
    b.status||null,
    id, companyId
  ).run()
  return json(c, { updated: id })
})

// GET /api/customers/:id/notes — get notes for a customer
app.get('/api/customers/:id/notes', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const clientId = c.req.param('id')
  const rows = await c.env.DB.prepare(
    'SELECT * FROM customer_notes WHERE client_id = ? AND company_id = ? ORDER BY created_at DESC LIMIT 50'
  ).bind(clientId, companyId).all()
  return json(c, rows.results || [])
})

// POST /api/customers/:id/notes — add a note
app.post('/api/customers/:id/notes', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId as string
  const clientId  = c.req.param('id')
  const b: any    = await c.req.json()
  const id        = 'cn-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
  await c.env.DB.prepare(
    `INSERT INTO customer_notes (id, client_id, company_id, note, type, created_by) VALUES (?,?,?,?,?,?)`
  ).bind(id, clientId, companyId, b.note || '', b.type || 'customer', repId).run()
  return json(c, { id }, 201)
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
  <link rel="icon" type="image/png" sizes="32x32" href="/js/favicon-32.png" />
  <link rel="icon" type="image/png" sizes="16x16" href="/js/favicon-16.png" />
  <link rel="icon" type="image/x-icon" href="/js/favicon.ico" />
  <link rel="apple-touch-icon" href="/js/apple-touch-icon.png" />
  <link rel="manifest" href="/site.webmanifest" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="Groundwork" />
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
      <img src="/js/avalon-logo.png" alt="Groundwork CRM">
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

// GET /api/time/team-summary?from=&to=  — per-rep summary with entries (admin/office_manager)
app.get('/api/time/team-summary', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role      = c.var.role as string
  if (role !== 'admin' && role !== 'office_manager') return err(c, 'Admin only', 403)
  const from = c.req.query('from') || new Date(Date.now() - 7*86400000).toISOString().slice(0,10)
  const to   = c.req.query('to')   || new Date().toISOString().slice(0,10)

  // Fetch all entries for the period with rep info
  const entryRows = await c.env.DB.prepare(`
    SELECT te.*, r.name as rep_name, r.color as rep_color
    FROM time_entries te
    LEFT JOIN reps r ON r.id=te.rep_id AND r.company_id=te.company_id
    WHERE te.company_id=? AND date(te.clock_in)>=? AND date(te.clock_in)<=?
    ORDER BY te.clock_in DESC
  `).bind(companyId, from, to).all()

  // Group entries by rep
  const repMap = new Map<string, { rep_id: string; rep_name: string; rep_color: string; total_min: number; entries: any[] }>()
  for (const row of (entryRows.results as any[])) {
    if (!repMap.has(row.rep_id)) {
      repMap.set(row.rep_id, {
        rep_id:    row.rep_id,
        rep_name:  row.rep_name  || row.rep_id,
        rep_color: row.rep_color || '#4ade80',
        total_min: 0,
        entries:   []
      })
    }
    const rep = repMap.get(row.rep_id)!
    rep.entries.push(row)
    rep.total_min += (row.duration_min || 0)
  }

  const data = Array.from(repMap.values()).sort((a, b) => b.total_min - a.total_min)
  return json(c, data)
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
// PHASE 9 — WORKDAY / BREAK / SETTINGS APIs
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/time/clock-in  (extended: accepts work_order_id)
// Replaces generic clock-in above — same route, we patch the existing handler
// by overwriting it here (Hono uses last-match for duplicate routes? No — Hono
// matches first. So we add work_order_id support via PATCH on the existing INSERT)
// Instead: add a separate route for job-linked clock-in
// POST /api/time/clock-in/job  { workOrderId?, jobLabel?, jobType? }
app.post('/api/time/clock-in/job', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId as string
  const open = await c.env.DB.prepare(
    `SELECT id FROM time_entries WHERE rep_id=? AND company_id=? AND clock_out IS NULL LIMIT 1`
  ).bind(repId, companyId).first<{ id: string }>()
  if (open) return err(c, 'Already clocked in', 409)
  const b = await c.req.json().catch(() => ({})) as any
  const id = 'te_' + uid()
  const now = new Date().toISOString()
  await c.env.DB.prepare(
    `INSERT INTO time_entries (id,rep_id,company_id,clock_in,job_type,work_order_id,notes,approved)
     VALUES (?,?,?,?,?,?,?,0)`
  ).bind(id, repId, companyId, now, b.jobType||'General Work', b.workOrderId||null, b.notes||'').run()
  return json(c, { id, clock_in: now, work_order_id: b.workOrderId||null }, 201)
})

// POST /api/time/break/start   — start a break on active entry
app.post('/api/time/break/start', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId as string
  // Must be clocked in
  const entry = await c.env.DB.prepare(
    `SELECT id FROM time_entries WHERE rep_id=? AND company_id=? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1`
  ).bind(repId, companyId).first<{ id: string }>()
  if (!entry) return err(c, 'Not clocked in', 404)
  // No open break already
  const openBreak = await c.env.DB.prepare(
    `SELECT id FROM break_entries WHERE rep_id=? AND company_id=? AND break_end IS NULL LIMIT 1`
  ).bind(repId, companyId).first<{ id: string }>()
  if (openBreak) return err(c, 'Break already active', 409)
  const id = 'br_' + uid()
  const now = new Date().toISOString()
  await c.env.DB.prepare(
    `INSERT INTO break_entries (id,time_entry_id,rep_id,company_id,break_start) VALUES (?,?,?,?,?)`
  ).bind(id, entry.id, repId, companyId, now).run()
  return json(c, { id, break_start: now }, 201)
})

// POST /api/time/break/end   — end the active break
app.post('/api/time/break/end', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId as string
  const openBreak = await c.env.DB.prepare(
    `SELECT * FROM break_entries WHERE rep_id=? AND company_id=? AND break_end IS NULL ORDER BY break_start DESC LIMIT 1`
  ).bind(repId, companyId).first<any>()
  if (!openBreak) return err(c, 'No active break', 404)
  const now      = new Date()
  const start    = new Date(openBreak.break_start)
  const durMin   = Math.round((now.getTime() - start.getTime()) / 60000)
  await c.env.DB.prepare(
    `UPDATE break_entries SET break_end=?, duration_min=? WHERE id=? AND company_id=?`
  ).bind(now.toISOString(), durMin, openBreak.id, companyId).run()
  // Accumulate break_minutes on time_entry
  await c.env.DB.prepare(
    `UPDATE time_entries SET break_minutes=COALESCE(break_minutes,0)+? WHERE id=? AND company_id=?`
  ).bind(durMin, openBreak.time_entry_id, companyId).run()
  return json(c, { id: openBreak.id, duration_min: durMin })
})

// GET /api/time/break/active   — currently open break for rep
app.get('/api/time/break/active', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId as string
  const row = await c.env.DB.prepare(
    `SELECT * FROM break_entries WHERE rep_id=? AND company_id=? AND break_end IS NULL ORDER BY break_start DESC LIMIT 1`
  ).bind(repId, companyId).first()
  return json(c, row || null)
})

// GET /api/time/timesheet-summary?from=&to=   — 9C admin roll-up
app.get('/api/time/timesheet-summary', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role      = c.var.role as string
  const myRepId   = c.var.repId as string
  if (role !== 'admin' && role !== 'office_manager') return err(c, 'Admin only', 403)
  const from = c.req.query('from') || new Date(Date.now() - 7*86400000).toISOString().slice(0,10)
  const to   = c.req.query('to')   || new Date().toISOString().slice(0,10)
  const rows = await c.env.DB.prepare(`
    SELECT te.rep_id, r.name AS rep_name, r.role AS rep_role,
           COUNT(te.id) AS entry_count,
           SUM(te.duration_min) AS total_minutes,
           SUM(COALESCE(te.break_minutes,0)) AS total_break_minutes,
           SUM(CASE WHEN te.approved=1 THEN te.duration_min ELSE 0 END) AS approved_minutes,
           SUM(CASE WHEN te.clock_out IS NULL THEN 1 ELSE 0 END) AS open_entries,
           SUM(CASE WHEN te.approved=0 AND te.clock_out IS NOT NULL THEN 1 ELSE 0 END) AS pending_approval,
           GROUP_CONCAT(DISTINCT te.work_order_id) AS work_order_ids
    FROM time_entries te
    JOIN reps r ON r.id=te.rep_id AND r.company_id=te.company_id
    WHERE te.company_id=?
      AND date(te.clock_in) BETWEEN ? AND ?
    GROUP BY te.rep_id
    ORDER BY r.name
  `).bind(companyId, from, to).all()
  return json(c, rows.results || [])
})

// GET /api/time/exceptions?from=&to=   — missed punches + overtime flags
app.get('/api/time/exceptions', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role      = c.var.role as string
  if (role !== 'admin' && role !== 'office_manager') return err(c, 'Admin only', 403)
  const from = c.req.query('from') || new Date(Date.now() - 7*86400000).toISOString().slice(0,10)
  const to   = c.req.query('to')   || new Date().toISOString().slice(0,10)
  // Open entries older than today = missed clock-out
  const open = await c.env.DB.prepare(`
    SELECT te.*, r.name AS rep_name FROM time_entries te
    JOIN reps r ON r.id=te.rep_id AND r.company_id=te.company_id
    WHERE te.company_id=? AND te.clock_out IS NULL
      AND date(te.clock_in) < date('now')
  `).bind(companyId).all()
  // Entries > 10h = overtime flag
  const overtime = await c.env.DB.prepare(`
    SELECT te.*, r.name AS rep_name FROM time_entries te
    JOIN reps r ON r.id=te.rep_id AND r.company_id=te.company_id
    WHERE te.company_id=? AND te.duration_min > 600
      AND date(te.clock_in) BETWEEN ? AND ?
  `).bind(companyId, from, to).all()
  return json(c, { missed_clock_out: open.results || [], overtime: overtime.results || [] })
})

// GET /api/workday-settings   — fetch company workday config
app.get('/api/workday-settings', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const row = await c.env.DB.prepare(
    `SELECT * FROM workday_settings WHERE company_id=? LIMIT 1`
  ).bind(companyId).first()
  return json(c, row || {
    working_days: '1,2,3,4,5', shift_start: '07:00', shift_end: '17:00',
    lunch_minutes: 30, grace_period_minutes: 10, late_threshold_minutes: 15,
    overtime_threshold_hours: 8.0, missed_punch_flag: 1, prompt_clock_in: 1
  })
})

// PUT /api/workday-settings   — save company workday config (admin only)
app.put('/api/workday-settings', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role      = c.var.role as string
  if (role !== 'admin' && role !== 'office_manager') return err(c, 'Admin only', 403)
  const b = await c.req.json() as any
  await c.env.DB.prepare(`
    INSERT INTO workday_settings
      (id, company_id, working_days, shift_start, shift_end, lunch_minutes,
       grace_period_minutes, late_threshold_minutes, overtime_threshold_hours,
       missed_punch_flag, prompt_clock_in, updated_at)
    VALUES ('default_'||?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(company_id) DO UPDATE SET
      working_days=excluded.working_days, shift_start=excluded.shift_start,
      shift_end=excluded.shift_end, lunch_minutes=excluded.lunch_minutes,
      grace_period_minutes=excluded.grace_period_minutes,
      late_threshold_minutes=excluded.late_threshold_minutes,
      overtime_threshold_hours=excluded.overtime_threshold_hours,
      missed_punch_flag=excluded.missed_punch_flag,
      prompt_clock_in=excluded.prompt_clock_in,
      updated_at=datetime('now')
  `).bind(
    companyId, companyId,
    b.working_days||'1,2,3,4,5', b.shift_start||'07:00', b.shift_end||'17:00',
    b.lunch_minutes??30, b.grace_period_minutes??10, b.late_threshold_minutes??15,
    b.overtime_threshold_hours??8.0, b.missed_punch_flag??1, b.prompt_clock_in??1
  ).run()
  return json(c, { ok: true })
})

// ══════════════════════════════════════════════════════════════════════════════
// TASKS — Unified Task / To-Do Engine (Phase 10)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/tasks
// Query params: assignedUserId, recordType, recordId, status, from (due_date >=), to (due_date <=)
// Scoped to session company. Returns open tasks by default; pass status=all for everything.
app.get('/api/tasks', requireAuth, async (c) => {
  const companyId     = c.var.companyId as string
  const role          = c.var.role as string
  const repId         = c.var.repId as string
  const assignedUser  = c.req.query('assignedUserId') || null
  const recordType    = c.req.query('recordType')     || null
  const recordId      = c.req.query('recordId')       || null
  const statusFilter  = c.req.query('status')         || 'open'  // 'open'|'completed'|'archived'|'all'
  const from          = c.req.query('from')            || null
  const to            = c.req.query('to')              || null

  // Non-admins can only see tasks assigned to themselves, unless they provide no filter
  const isManager = role === 'admin' || role === 'office_manager'
  const effectiveUser = isManager
    ? (assignedUser || null)
    : repId  // non-managers always scoped to self

  let q = 'SELECT * FROM tasks WHERE company_id=?'
  const params: any[] = [companyId]

  if (effectiveUser) { q += ' AND assigned_user_id=?'; params.push(effectiveUser) }
  if (recordType)    { q += ' AND linked_record_type=?'; params.push(recordType) }
  if (recordId)      { q += ' AND linked_record_id=?'; params.push(recordId) }
  if (statusFilter !== 'all') { q += ' AND status=?'; params.push(statusFilter) }
  if (from)          { q += ' AND (due_date IS NULL OR due_date >= ?)'; params.push(from) }
  if (to)            { q += ' AND due_date <= ?'; params.push(to) }

  q += ' ORDER BY CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date ASC, created_at DESC'

  const rows = await c.env.DB.prepare(q).bind(...params).all()
  return json(c, rows.results)
})

// POST /api/tasks  — create a new task
app.post('/api/tasks', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId as string
  const b = await c.req.json() as any

  if (!b.title?.trim()) return err(c, 'title required')
  const id  = 'task_' + uid()
  const now = new Date().toISOString()

  await c.env.DB.prepare(`
    INSERT INTO tasks (
      id, company_id, title, description, task_type,
      linked_record_type, linked_record_id, linked_record_label,
      assigned_user_id, assigned_user_label, created_by,
      due_date, due_time, priority, status,
      calendar_sync_state, source, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    id, companyId,
    b.title.trim(),
    b.description || '',
    b.taskType || 'follow_up',
    b.linkedRecordType  || null,
    b.linkedRecordId    || null,
    b.linkedRecordLabel || '',
    b.assignedUserId    || repId,
    b.assignedUserLabel || '',
    repId,
    b.dueDate  || null,
    b.dueTime  || null,
    b.priority || 'normal',
    'open',
    b.calendarSyncState || 'none',
    b.source || 'manual',
    now, now
  ).run()

  const task = await c.env.DB.prepare('SELECT * FROM tasks WHERE id=? LIMIT 1').bind(id).first()
  return json(c, task, 201)
})

// PUT /api/tasks/:id  — update task fields
app.put('/api/tasks/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId as string
  const role      = c.var.role as string
  const id        = c.req.param('id')
  const b = await c.req.json() as any

  const task = await c.env.DB.prepare(
    'SELECT * FROM tasks WHERE id=? AND company_id=? LIMIT 1'
  ).bind(id, companyId).first<any>()
  if (!task) return err(c, 'Task not found', 404)

  // Non-admins can only edit tasks assigned to them or created by them
  const isManager = role === 'admin' || role === 'office_manager'
  if (!isManager && task.assigned_user_id !== repId && task.created_by !== repId)
    return err(c, 'Forbidden', 403)

  const updates: string[] = []
  const vals: any[] = []

  const fields: Record<string, string> = {
    title: 'title', description: 'description', taskType: 'task_type',
    linkedRecordType: 'linked_record_type', linkedRecordId: 'linked_record_id',
    linkedRecordLabel: 'linked_record_label', assignedUserId: 'assigned_user_id',
    assignedUserLabel: 'assigned_user_label', dueDate: 'due_date', dueTime: 'due_time',
    priority: 'priority', calendarSyncState: 'calendar_sync_state',
    calendarEventId: 'calendar_event_id'
  }
  for (const [jsKey, dbCol] of Object.entries(fields)) {
    if (b[jsKey] !== undefined) { updates.push(`${dbCol}=?`); vals.push(b[jsKey]) }
  }
  if (!updates.length) return err(c, 'Nothing to update')

  updates.push("updated_at=datetime('now')")
  await c.env.DB.prepare(
    `UPDATE tasks SET ${updates.join(',')} WHERE id=? AND company_id=?`
  ).bind(...vals, id, companyId).run()

  const updated = await c.env.DB.prepare('SELECT * FROM tasks WHERE id=? LIMIT 1').bind(id).first()
  return json(c, updated)
})

// PUT /api/tasks/:id/complete  — mark a task completed
app.put('/api/tasks/:id/complete', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId as string
  const role      = c.var.role as string
  const id        = c.req.param('id')

  const task = await c.env.DB.prepare(
    'SELECT * FROM tasks WHERE id=? AND company_id=? LIMIT 1'
  ).bind(id, companyId).first<any>()
  if (!task) return err(c, 'Task not found', 404)
  const isManager = role === 'admin' || role === 'office_manager'
  if (!isManager && task.assigned_user_id !== repId && task.created_by !== repId)
    return err(c, 'Forbidden', 403)

  const now = new Date().toISOString()
  // Set status='archived' so the task never reappears in open/completed fetches on reload.
  // completed_at and completed_by are preserved for audit history.
  await c.env.DB.prepare(`
    UPDATE tasks SET status='archived', completed_at=?, completed_by=?, archived_at=?, archived_by=?, updated_at=datetime('now')
    WHERE id=? AND company_id=?
  `).bind(now, repId, now, repId, id, companyId).run()

  return json(c, { id, status: 'archived', completed_at: now })
})

// PUT /api/tasks/:id/archive  — archive a task (soft-delete)
app.put('/api/tasks/:id/archive', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId as string
  const role      = c.var.role as string
  const id        = c.req.param('id')

  const task = await c.env.DB.prepare(
    'SELECT * FROM tasks WHERE id=? AND company_id=? LIMIT 1'
  ).bind(id, companyId).first<any>()
  if (!task) return err(c, 'Task not found', 404)
  const isManager = role === 'admin' || role === 'office_manager'
  if (!isManager && task.assigned_user_id !== repId && task.created_by !== repId)
    return err(c, 'Forbidden', 403)

  const now = new Date().toISOString()
  await c.env.DB.prepare(`
    UPDATE tasks SET status='archived', archived_at=?, archived_by=?, updated_at=datetime('now')
    WHERE id=? AND company_id=?
  `).bind(now, repId, id, companyId).run()

  return json(c, { id, status: 'archived', archived_at: now })
})

// GET /api/tasks/team-summary  — manager cockpit: task counts per user
// Returns: [ { assigned_user_id, assigned_user_label, open, overdue, due_today, completed_today } ]
app.get('/api/tasks/team-summary', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role      = c.var.role as string
  if (role !== 'admin' && role !== 'office_manager') return err(c, 'Admin only', 403)

  const today = new Date().toISOString().slice(0, 10)
  const rows = await c.env.DB.prepare(`
    SELECT
      t.assigned_user_id,
      t.assigned_user_label,
      COUNT(CASE WHEN t.status='open' THEN 1 END)                                          AS open_count,
      COUNT(CASE WHEN t.status='open' AND t.due_date < ?  THEN 1 END)                      AS overdue_count,
      COUNT(CASE WHEN t.status='open' AND t.due_date = ?  THEN 1 END)                      AS due_today_count,
      COUNT(CASE WHEN t.status='completed' AND date(t.completed_at) = ? THEN 1 END)        AS completed_today_count
    FROM tasks t
    WHERE t.company_id = ? AND t.status IN ('open','completed')
    GROUP BY t.assigned_user_id
    ORDER BY overdue_count DESC, open_count DESC
  `).bind(today, today, today, companyId).all()

  return json(c, rows.results)
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
// PHASE 8 — AUDIT LOG  (/api/audit)
// ══════════════════════════════════════════════════════════════════════════════
// CREWS & WORK ORDERS
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/crews — list all crews for company (with members)
app.get('/api/crews', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const crews = await db.prepare(
    `SELECT c.*, GROUP_CONCAT(cm.rep_id||':'||cm.crew_role) as member_list
     FROM crews c
     LEFT JOIN crew_members cm ON cm.crew_id = c.id
     WHERE c.company_id = ? AND c.active = 1
     GROUP BY c.id ORDER BY c.name`
  ).bind(companyId).all()
  // Also get rep details for member names
  const reps = await db.prepare(`SELECT id, name, role FROM reps WHERE company_id = ? AND active = 1`).bind(companyId).all()
  const repMap: Record<string, any> = {}
  for (const r of (reps.results || [])) { repMap[(r as any).id] = r }
  const result = (crews.results || []).map((cr: any) => {
    const members = cr.member_list ? cr.member_list.split(',').map((m: string) => {
      const [repId, crewRole] = m.split(':')
      return { repId, crewRole, name: repMap[repId]?.name || repId }
    }) : []
    return { ...cr, member_list: undefined, members }
  })
  return c.json({ ok: true, data: result })
})

// POST /api/crews — create a new crew
app.post('/api/crews', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId as string
  const db = c.env.DB as D1Database
  const body: any = await c.req.json()
  const id = 'crew-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
  const name     = (body.name  || '').trim()
  const color    = body.color || '#22c55e'
  const division = body.division || null
  if (!name) return c.json({ ok: false, error: 'Crew name required' }, 400)
  await db.prepare(
    `INSERT INTO crews (id, company_id, name, color, division) VALUES (?,?,?,?,?)`
  ).bind(id, companyId, name, color, division).run()
  // Add members if provided
  const members: { repId: string; crewRole: string }[] = body.members || []
  for (const m of members) {
    if (!m.repId) continue
    const mid = 'cm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
    await db.prepare(
      `INSERT OR IGNORE INTO crew_members (id, crew_id, rep_id, company_id, crew_role) VALUES (?,?,?,?,?)`
    ).bind(mid, id, m.repId, companyId, m.crewRole || 'laborer').run()
  }
  return c.json({ ok: true, id })
})

// PUT /api/crews/:id — update crew name/color
app.put('/api/crews/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const crewId = c.req.param('id')
  const body: any = await c.req.json()
  await db.prepare(
    `UPDATE crews SET name=?, color=?, division=COALESCE(?,division), updated_at=datetime('now') WHERE id=? AND company_id=?`
  ).bind(body.name, body.color, body.division || null, crewId, companyId).run()
  return c.json({ ok: true })
})

// PUT /api/crews/:id/members — replace member list
app.put('/api/crews/:id/members', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const crewId = c.req.param('id')
  const body: any = await c.req.json()
  const members: { repId: string; crewRole: string }[] = body.members || []
  // Delete existing, re-insert
  await db.prepare(`DELETE FROM crew_members WHERE crew_id=? AND company_id=?`).bind(crewId, companyId).run()
  for (const m of members) {
    if (!m.repId) continue
    const mid = 'cm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
    await db.prepare(
      `INSERT OR IGNORE INTO crew_members (id, crew_id, rep_id, company_id, crew_role) VALUES (?,?,?,?,?)`
    ).bind(mid, crewId, m.repId, companyId, m.crewRole || 'laborer').run()
  }
  return c.json({ ok: true })
})

// DELETE /api/crews/:id — soft-delete
app.delete('/api/crews/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const crewId = c.req.param('id')
  await db.prepare(`UPDATE crews SET active=0, updated_at=datetime('now') WHERE id=? AND company_id=?`).bind(crewId, companyId).run()
  return c.json({ ok: true })
})

// ── ESTIMATES (D1) ────────────────────────────────────────────────────────────

// GET /api/estimates — list estimates with optional filters
app.get('/api/estimates', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const status  = c.req.query('status')
  const repId   = c.req.query('rep_id')
  const search  = c.req.query('q')
  const limit   = Math.min(Number(c.req.query('limit') || 200), 500)
  const offset  = Number(c.req.query('offset') || 0)

  let q = `SELECT * FROM estimates WHERE company_id = ?`
  const params: any[] = [companyId]
  if (status) { q += ` AND status = ?`; params.push(status) }
  if (repId)  { q += ` AND rep_id = ?`; params.push(repId) }
  if (search) { q += ` AND (client_name LIKE ? OR est_number LIKE ? OR title LIKE ?)`; const s = `%${search}%`; params.push(s,s,s) }
  q += ` ORDER BY updated_at DESC LIMIT ? OFFSET ?`
  params.push(limit, offset)
  const rows = await db.prepare(q).bind(...params).all()
  return c.json({ ok: true, data: rows.results || [] })
})

// GET /api/estimates/kpis — summary counts
app.get('/api/estimates/kpis', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const rows = await db.prepare(`
    SELECT status, COUNT(*) as cnt, COALESCE(SUM(total),0) as total_val
    FROM estimates WHERE company_id = ?
    GROUP BY status
  `).bind(companyId).all()
  const kpis: Record<string,{cnt:number;val:number}> = {}
  for (const r of (rows.results||[]) as any[]) {
    kpis[r.status] = { cnt: r.cnt, val: r.total_val }
  }
  return c.json({ ok: true, data: kpis })
})

// GET /api/estimates/:id
app.get('/api/estimates/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const row: any = await db.prepare(`SELECT * FROM estimates WHERE id=? AND company_id=?`)
    .bind(c.req.param('id'), companyId).first()
  if (!row) return c.json({ ok: false, error: 'Not found' }, 404)
  return c.json({ ok: true, data: {
    ...row,
    line_items:  JSON.parse(row.line_items  || '[]'),
    attachments: JSON.parse(row.attachments || '[]'),
  }})
})

// GET /api/estimates/portal/:token — public (no auth) portal view
app.get('/api/estimates/portal/:token', async (c) => {
  const db = c.env.DB as D1Database
  const row: any = await db.prepare(`SELECT * FROM estimates WHERE portal_token=? LIMIT 1`)
    .bind(c.req.param('token')).first()
  if (!row) return c.json({ ok: false, error: 'Not found' }, 404)
  // Track view
  if (!row.viewed_at) {
    await db.prepare(`UPDATE estimates SET viewed_at=datetime('now'), status=CASE WHEN status='sent' THEN 'viewed' ELSE status END, updated_at=datetime('now') WHERE portal_token=?`)
      .bind(c.req.param('token')).run()
  }
  return c.json({ ok: true, data: {
    ...row,
    line_items:  JSON.parse(row.line_items  || '[]'),
    attachments: JSON.parse(row.attachments || '[]'),
  }})
})

// POST /api/estimates — create
app.post('/api/estimates', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId as string
  const db = c.env.DB as D1Database
  const b: any = await c.req.json()

  // Auto-generate est_number
  const countRow: any = await db.prepare(`SELECT COUNT(*) as n FROM estimates WHERE company_id=?`).bind(companyId).first()
  const num = ((countRow?.n || 0) + 1).toString().padStart(4,'0')
  const estNumber = b.est_number || `EST-${num}`
  const id = b.id || ('est_' + uid())
  const portalToken = uid() + uid()

  // Calc totals
  const items: any[] = Array.isArray(b.line_items) ? b.line_items : []
  const subtotal = items.reduce((s:number,i:any)=>s+(Number(i.qty||1)*Number(i.rate||0)),0)
  const discAmt  = b.discount_pct ? subtotal * (Number(b.discount_pct)/100) : Number(b.discount_amt||0)
  const taxAmt   = b.tax_pct ? (subtotal-discAmt) * (Number(b.tax_pct)/100) : Number(b.tax_amt||0)
  const total    = subtotal - discAmt + taxAmt
  const depAmt   = b.deposit_pct ? total * (Number(b.deposit_pct)/100) : Number(b.deposit_amt||0)

  await db.prepare(`
    INSERT INTO estimates (id,company_id,est_number,title,scope_of_work,
      client_id,client_name,client_email,client_phone,client_address,
      property_id,property_addr,opp_id,rep_id,assigned_to,
      status,subtotal,discount_pct,discount_amt,tax_pct,tax_amt,total,
      deposit_pct,deposit_amt,line_items,attachments,
      internal_notes,customer_notes,terms,portal_token,
      estimate_date,expiry_date,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
  `).bind(
    id,companyId,estNumber,
    b.title||'',b.scope_of_work||'',
    b.client_id||'',b.client_name||'',b.client_email||'',b.client_phone||'',b.client_address||'',
    b.property_id||'',b.property_addr||'',b.opp_id||'',
    repId,b.assigned_to||repId,
    b.status||'draft',
    subtotal,Number(b.discount_pct||0),discAmt,
    Number(b.tax_pct||0),taxAmt,total,
    Number(b.deposit_pct||30),depAmt,
    JSON.stringify(items),JSON.stringify(b.attachments||[]),
    b.internal_notes||'',b.customer_notes||'',b.terms||'',
    portalToken,
    b.estimate_date||new Date().toISOString().slice(0,10),
    b.expiry_date||''
  ).run()
  return c.json({ ok: true, data: { id, est_number: estNumber, portal_token: portalToken } }, 201)
})

// PUT /api/estimates/:id — update
app.put('/api/estimates/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const id = c.req.param('id')
  const b: any = await c.req.json()

  const items: any[] = Array.isArray(b.line_items) ? b.line_items : []
  const subtotal = items.reduce((s:number,i:any)=>s+(Number(i.qty||1)*Number(i.rate||0)),0)
  const discAmt  = b.discount_pct ? subtotal * (Number(b.discount_pct)/100) : Number(b.discount_amt||0)
  const taxAmt   = b.tax_pct ? (subtotal-discAmt) * (Number(b.tax_pct)/100) : Number(b.tax_amt||0)
  const total    = subtotal - discAmt + taxAmt
  const depAmt   = b.deposit_pct ? total * (Number(b.deposit_pct)/100) : Number(b.deposit_amt||0)

  await db.prepare(`
    UPDATE estimates SET
      title=?,scope_of_work=?,
      client_id=?,client_name=?,client_email=?,client_phone=?,client_address=?,
      property_id=?,property_addr=?,assigned_to=?,
      status=?,subtotal=?,discount_pct=?,discount_amt=?,tax_pct=?,tax_amt=?,total=?,
      deposit_pct=?,deposit_amt=?,line_items=?,attachments=?,
      internal_notes=?,customer_notes=?,terms=?,
      estimate_date=?,expiry_date=?,updated_at=datetime('now')
    WHERE id=? AND company_id=?
  `).bind(
    b.title||'',b.scope_of_work||'',
    b.client_id||'',b.client_name||'',b.client_email||'',b.client_phone||'',b.client_address||'',
    b.property_id||'',b.property_addr||'',b.assigned_to||'',
    b.status||'draft',
    subtotal,Number(b.discount_pct||0),discAmt,
    Number(b.tax_pct||0),taxAmt,total,
    Number(b.deposit_pct||30),depAmt,
    JSON.stringify(items),JSON.stringify(b.attachments||[]),
    b.internal_notes||'',b.customer_notes||'',b.terms||'',
    b.estimate_date||'',b.expiry_date||'',
    id,companyId
  ).run()
  return c.json({ ok: true, data: { id, subtotal, total } })
})

// POST /api/estimates/:id/send — mark as sent
app.post('/api/estimates/:id/send', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const b: any = await c.req.json().catch(()=>({}))
  await db.prepare(`UPDATE estimates SET status='sent', sent_at=datetime('now'), send_method=?, updated_at=datetime('now') WHERE id=? AND company_id=?`)
    .bind(b.method||'email', c.req.param('id'), companyId).run()
  return c.json({ ok: true })
})

// POST /api/estimates/:id/accept — portal or internal accept
app.post('/api/estimates/:id/accept', async (c) => {
  const db = c.env.DB as D1Database
  await db.prepare(`UPDATE estimates SET status='accepted', accepted_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
    .bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

// POST /api/estimates/:id/decline
app.post('/api/estimates/:id/decline', async (c) => {
  const db = c.env.DB as D1Database
  const b: any = await c.req.json().catch(()=>({}))
  await db.prepare(`UPDATE estimates SET status='declined', declined_at=datetime('now'), decline_reason=?, updated_at=datetime('now') WHERE id=?`)
    .bind(b.reason||'', c.req.param('id')).run()
  return c.json({ ok: true })
})

// POST /api/estimates/:id/changes — request changes
app.post('/api/estimates/:id/changes', async (c) => {
  const db = c.env.DB as D1Database
  const b: any = await c.req.json().catch(()=>({}))
  await db.prepare(`UPDATE estimates SET status='changes_requested', changes_at=datetime('now'), change_request=?, updated_at=datetime('now') WHERE id=?`)
    .bind(b.message||'', c.req.param('id')).run()
  return c.json({ ok: true })
})

// POST /api/estimates/:id/duplicate
app.post('/api/estimates/:id/duplicate', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const row: any = await db.prepare(`SELECT * FROM estimates WHERE id=? AND company_id=?`)
    .bind(c.req.param('id'), companyId).first()
  if (!row) return c.json({ ok: false, error: 'Not found' }, 404)
  const countRow: any = await db.prepare(`SELECT COUNT(*) as n FROM estimates WHERE company_id=?`).bind(companyId).first()
  const num = ((countRow?.n || 0) + 1).toString().padStart(4,'0')
  const newId = 'est_' + uid()
  const newToken = uid() + uid()
  await db.prepare(`
    INSERT INTO estimates SELECT * FROM estimates WHERE id=?
  `).bind(row.id).run().catch(()=>{}) // fallback below
  await db.prepare(`
    INSERT INTO estimates (id,company_id,est_number,title,scope_of_work,
      client_id,client_name,client_email,client_phone,client_address,
      property_id,property_addr,opp_id,rep_id,assigned_to,
      status,subtotal,discount_pct,discount_amt,tax_pct,tax_amt,total,
      deposit_pct,deposit_amt,line_items,attachments,
      internal_notes,customer_notes,terms,portal_token,
      estimate_date,expiry_date,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
  `).bind(
    newId,companyId,`EST-${num}`,
    `Copy of ${row.title||''}`,row.scope_of_work||'',
    row.client_id||'',row.client_name||'',row.client_email||'',row.client_phone||'',row.client_address||'',
    row.property_id||'',row.property_addr||'',row.opp_id||'',
    row.rep_id||'',row.assigned_to||'',
    'draft',
    row.subtotal||0,row.discount_pct||0,row.discount_amt||0,
    row.tax_pct||0,row.tax_amt||0,row.total||0,
    row.deposit_pct||30,row.deposit_amt||0,
    row.line_items||'[]',row.attachments||'[]',
    row.internal_notes||'',row.customer_notes||'',row.terms||'',
    newToken,
    new Date().toISOString().slice(0,10),row.expiry_date||''
  ).run()
  return c.json({ ok: true, data: { id: newId, est_number: `EST-${num}` } }, 201)
})

// DELETE /api/estimates/:id
app.delete('/api/estimates/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await db.prepare(`DELETE FROM estimates WHERE id=? AND company_id=?`)
    .bind(c.req.param('id'), companyId).run()
  return c.json({ ok: true })
})

// ── INVOICES (D1) ─────────────────────────────────────────────────────────────

// GET /api/invoices — list invoices with filters
app.get('/api/invoices', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const status   = c.req.query('status')
  const clientId = c.req.query('client_id')
  const search   = c.req.query('q')
  const limit    = Math.min(Number(c.req.query('limit') || 200), 500)
  const offset   = Number(c.req.query('offset') || 0)

  let q = `SELECT * FROM invoices WHERE company_id = ?`
  const params: any[] = [companyId]
  if (status)   { q += ` AND status = ?`;         params.push(status) }
  if (clientId) { q += ` AND client_id = ?`;      params.push(clientId) }
  if (search)   { q += ` AND (client_name LIKE ? OR invoice_number LIKE ? OR title LIKE ?)`;
                  params.push(`%${search}%`, `%${search}%`, `%${search}%`) }
  q += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`
  params.push(limit, offset)

  const { results } = await db.prepare(q).bind(...params).all()
  results.forEach((r: any) => {
    try { r.line_items = JSON.parse(r.line_items || '[]') } catch(_) { r.line_items = [] }
  })
  return c.json(results)
})

// GET /api/invoices/:id — single invoice
app.get('/api/invoices/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const row: any = await db.prepare(
    `SELECT * FROM invoices WHERE id = ? AND company_id = ? LIMIT 1`
  ).bind(c.req.param('id'), companyId).first()
  if (!row) return c.json({ error: 'Not found' }, 404)
  try { row.line_items = JSON.parse(row.line_items || '[]') } catch(_) { row.line_items = [] }
  return c.json(row)
})

// GET /api/invoices/portal/:token — public portal (no auth)
app.get('/api/invoices/portal/:token', async (c) => {
  const db = c.env.DB as D1Database
  const row: any = await db.prepare(
    `SELECT * FROM invoices WHERE portal_token = ? LIMIT 1`
  ).bind(c.req.param('token')).first()
  if (!row) return c.json({ error: 'Not found' }, 404)
  // Mark as viewed
  if (row.status === 'sent') {
    await db.prepare(`UPDATE invoices SET status='viewed', viewed_at=datetime('now') WHERE portal_token=?`)
      .bind(c.req.param('token')).run()
    row.status = 'viewed'
    row.viewed_at = new Date().toISOString()
  }
  try { row.line_items = JSON.parse(row.line_items || '[]') } catch(_) { row.line_items = [] }
  return c.json(row)
})

// POST /api/invoices — create invoice
app.post('/api/invoices', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const b: any = await c.req.json()

  // Auto-increment invoice number per company
  await db.prepare(`INSERT OR IGNORE INTO invoice_counters (company_id, last_number) VALUES (?, 0)`)
    .bind(companyId).run()
  await db.prepare(`UPDATE invoice_counters SET last_number = last_number + 1 WHERE company_id = ?`)
    .bind(companyId).run()
  const counter: any = await db.prepare(`SELECT last_number FROM invoice_counters WHERE company_id = ?`)
    .bind(companyId).first()
  const invoiceNumber = b.invoice_number || `INV-${String(counter?.last_number || 1).padStart(4, '0')}`

  const id = `inv_${Date.now()}_${Math.random().toString(36).slice(2,8)}`
  const portalToken = crypto.randomUUID()
  const lineItems = Array.isArray(b.line_items) ? JSON.stringify(b.line_items) : b.line_items || '[]'
  const total = b.total || 0
  const taxAmount = b.tax_amount || 0
  const subtotal = b.subtotal || 0
  const discountAmount = b.discount_amount || 0
  const balanceDue = total - (b.amount_paid || 0)

  await db.prepare(`
    INSERT INTO invoices (id, company_id, invoice_number, estimate_id, client_id, client_name,
      client_email, client_phone, client_address, title, status, subtotal, tax_rate, tax_amount,
      discount_amount, total, amount_paid, balance_due, due_date, line_items, notes, internal_notes,
      terms, footer_note, portal_token, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
  `).bind(id, companyId, invoiceNumber,
    b.estimate_id||'', b.client_id||'', b.client_name||'', b.client_email||'',
    b.client_phone||'', b.client_address||'', b.title||`Invoice ${invoiceNumber}`,
    b.status||'draft', subtotal, b.tax_rate||0, taxAmount, discountAmount,
    total, b.amount_paid||0, balanceDue, b.due_date||'',
    lineItems, b.notes||'', b.internal_notes||'',
    b.terms||'Net 30', b.footer_note||'', portalToken
  ).run()
  return c.json({ id, invoice_number: invoiceNumber, portal_token: portalToken })
})

// PUT /api/invoices/:id — update invoice
app.put('/api/invoices/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const b: any = await c.req.json()
  const id = c.req.param('id')

  const allowed = ['title','status','client_id','client_name','client_email','client_phone',
    'client_address','estimate_id','subtotal','tax_rate','tax_amount','discount_amount','total',
    'amount_paid','balance_due','due_date','sent_at','viewed_at','paid_at','voided_at',
    'line_items','notes','internal_notes','terms','footer_note','payment_intent_id',
    'stripe_payment_status']
  const sets: string[] = []
  const vals: any[] = []
  for (const key of allowed) {
    if (key in b) {
      sets.push(`${key} = ?`)
      vals.push(key === 'line_items' && Array.isArray(b[key]) ? JSON.stringify(b[key]) : b[key])
    }
  }
  if (!sets.length) return c.json({ error: 'Nothing to update' }, 400)
  sets.push(`updated_at = datetime('now')`)
  vals.push(id, companyId)
  await db.prepare(`UPDATE invoices SET ${sets.join(', ')} WHERE id = ? AND company_id = ?`)
    .bind(...vals).run()
  return c.json({ ok: true })
})

// DELETE /api/invoices/:id — delete invoice (draft only)
app.delete('/api/invoices/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await db.prepare(`DELETE FROM invoices WHERE id=? AND company_id=? AND status='draft'`)
    .bind(c.req.param('id'), companyId).run()
  return c.json({ ok: true })
})

// POST /api/invoices/:id/send — mark as sent (email handled client-side or via SendGrid)
app.post('/api/invoices/:id/send', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await db.prepare(`UPDATE invoices SET status='sent', sent_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND company_id=?`)
    .bind(c.req.param('id'), companyId).run()
  return c.json({ ok: true })
})

// POST /api/invoices/:id/record-payment — record a manual payment
app.post('/api/invoices/:id/record-payment', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const b: any = await c.req.json()
  const id = c.req.param('id')

  const inv: any = await db.prepare(`SELECT * FROM invoices WHERE id=? AND company_id=? LIMIT 1`)
    .bind(id, companyId).first()
  if (!inv) return c.json({ error: 'Not found' }, 404)

  const newPaid = (inv.amount_paid || 0) + (b.amount || 0)
  const newBalance = (inv.total || 0) - newPaid
  const newStatus = newBalance <= 0 ? 'paid' : 'partial'
  const paidAt = newBalance <= 0 ? `datetime('now')` : inv.paid_at || ''

  await db.prepare(`UPDATE invoices SET amount_paid=?, balance_due=?, status=?, updated_at=datetime('now') WHERE id=? AND company_id=?`)
    .bind(newPaid, Math.max(0, newBalance), newStatus, id, companyId).run()

  // Log to payments table
  const payId = `pay_${Date.now()}_${Math.random().toString(36).slice(2,8)}`
  await db.prepare(`INSERT INTO payments (id, company_id, invoice_id, client_id, amount, net_amount, status, payment_method, description, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`)
    .bind(payId, companyId, id, inv.client_id||'', b.amount||0, b.amount||0, 'succeeded',
      b.method||'check', b.note||'Manual payment recorded').run()

  return c.json({ ok: true, status: newStatus, balance_due: Math.max(0, newBalance) })
})

// POST /api/invoices/from-estimate/:estimateId — convert estimate to invoice
app.post('/api/invoices/from-estimate/:estimateId', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const est: any = await db.prepare(`SELECT * FROM estimates WHERE id=? AND company_id=? LIMIT 1`)
    .bind(c.req.param('estimateId'), companyId).first()
  if (!est) return c.json({ error: 'Estimate not found' }, 404)

  // Auto-number
  await db.prepare(`INSERT OR IGNORE INTO invoice_counters (company_id, last_number) VALUES (?, 0)`)
    .bind(companyId).run()
  await db.prepare(`UPDATE invoice_counters SET last_number = last_number + 1 WHERE company_id = ?`)
    .bind(companyId).run()
  const counter: any = await db.prepare(`SELECT last_number FROM invoice_counters WHERE company_id = ?`)
    .bind(companyId).first()
  const invoiceNumber = `INV-${String(counter?.last_number || 1).padStart(4, '0')}`

  // Parse estimate line items → invoice line items
  let lineItems: any[] = []
  try { lineItems = JSON.parse(est.line_items || '[]') } catch(_) {}

  const id = `inv_${Date.now()}_${Math.random().toString(36).slice(2,8)}`
  const portalToken = crypto.randomUUID()
  const total = est.total || 0
  const depositPaid = est.deposit_paid_amount || 0
  const balanceDue = total - depositPaid

  // Get due date = today + 30 days
  const due = new Date(); due.setDate(due.getDate() + 30)
  const dueDate = due.toISOString().split('T')[0]

  await db.prepare(`
    INSERT INTO invoices (id, company_id, invoice_number, estimate_id, client_id, client_name,
      client_email, client_phone, title, status, subtotal, tax_rate, tax_amount,
      total, amount_paid, balance_due, due_date, line_items, notes, portal_token,
      created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
  `).bind(id, companyId, invoiceNumber, est.id, est.client_id||'', est.client_name||'',
    est.client_email||'', est.client_phone||'',
    `Invoice for ${est.title || est.estimate_number}`, 'draft',
    est.subtotal||0, est.tax_rate||0, est.tax_amount||0,
    total, depositPaid, Math.max(0, balanceDue), dueDate,
    JSON.stringify(lineItems), est.notes||'', portalToken
  ).run()

  // Update estimate status to invoiced
  await db.prepare(`UPDATE estimates SET status='invoiced', updated_at=datetime('now') WHERE id=? AND company_id=?`)
    .bind(est.id, companyId).run()

  return c.json({ id, invoice_number: invoiceNumber, portal_token: portalToken })
})

// GET /api/clients/:id/payment-methods — list saved Stripe payment methods for a client
// Returns saved cards/ACH that the client has on file (via Stripe Customer)
app.get('/api/clients/:id/payment-methods', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const stripeKey = (c.env as any).STRIPE_SECRET_KEY as string | undefined
  const clientId = c.req.param('id')

  // Get client's stripe_customer_id
  const client: any = await db.prepare(
    `SELECT id, name, email, stripe_customer_id FROM clients WHERE id=? AND company_id=? LIMIT 1`
  ).bind(clientId, companyId).first()
  if (!client) return c.json({ error: 'Client not found' }, 404)

  if (!stripeKey || !client.stripe_customer_id) {
    return c.json({ payment_methods: [], stripe_customer_id: null })
  }

  try {
    // Fetch cards
    const [cardsRes, bankRes] = await Promise.all([
      fetch(`https://api.stripe.com/v1/payment_methods?customer=${client.stripe_customer_id}&type=card&limit=20`, {
        headers: { 'Authorization': `Bearer ${stripeKey}` }
      }),
      fetch(`https://api.stripe.com/v1/payment_methods?customer=${client.stripe_customer_id}&type=us_bank_account&limit=20`, {
        headers: { 'Authorization': `Bearer ${stripeKey}` }
      })
    ])
    const cards = cardsRes.ok ? (await cardsRes.json() as any).data || [] : []
    const banks = bankRes.ok ? (await bankRes.json() as any).data || [] : []
    const paymentMethods = [...cards, ...banks].map((pm: any) => ({
      id: pm.id,
      type: pm.type,
      brand: pm.card?.brand || pm.us_bank_account?.bank_name || 'Unknown',
      last4: pm.card?.last4 || pm.us_bank_account?.last4 || '????',
      exp_month: pm.card?.exp_month,
      exp_year: pm.card?.exp_year,
      label: pm.type === 'card'
        ? `${(pm.card?.brand||'Card').charAt(0).toUpperCase()+(pm.card?.brand||'').slice(1)} •••• ${pm.card?.last4} (${pm.card?.exp_month}/${pm.card?.exp_year})`
        : `${pm.us_bank_account?.bank_name || 'Bank'} •••• ${pm.us_bank_account?.last4} (ACH)`
    }))
    return c.json({ payment_methods: paymentMethods, stripe_customer_id: client.stripe_customer_id })
  } catch (e: any) {
    return c.json({ error: e.message, payment_methods: [] }, 500)
  }
})

// POST /api/invoices/:id/charge — charge a saved Stripe payment method on file
app.post('/api/invoices/:id/charge', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const stripeKey = (c.env as any).STRIPE_SECRET_KEY as string | undefined
  if (!stripeKey) return c.json({ error: 'Stripe not configured' }, 503)

  const invoiceId = c.req.param('id')
  const body = await c.req.json() as any
  const { stripe_pm_id, amount } = body  // amount in cents

  if (!stripe_pm_id) return c.json({ error: 'Payment method required' }, 400)
  if (!amount || amount < 50) return c.json({ error: 'Minimum charge is $0.50' }, 400)

  // Load invoice + company
  const inv: any = await db.prepare(
    `SELECT * FROM invoices WHERE id=? AND company_id=? LIMIT 1`
  ).bind(invoiceId, companyId).first()
  if (!inv) return c.json({ error: 'Invoice not found' }, 404)

  const company: any = await db.prepare(
    `SELECT stripe_account_id, stripe_onboarded, stripe_platform_fee_pct FROM companies WHERE id=? LIMIT 1`
  ).bind(companyId).first()

  // Get client's Stripe customer ID
  const client: any = inv.client_id
    ? await db.prepare(`SELECT stripe_customer_id FROM clients WHERE id=? AND company_id=? LIMIT 1`)
        .bind(inv.client_id, companyId).first()
    : null
  if (!client?.stripe_customer_id) return c.json({ error: 'Client has no Stripe customer on file' }, 400)

  try {
    const feePct = company?.stripe_platform_fee_pct || 2.9
    const applicationFeeAmount = Math.round(amount * feePct / 100)

    // Build PaymentIntent params
    const form = new URLSearchParams({
      amount: String(amount),
      currency: 'usd',
      customer: client.stripe_customer_id,
      payment_method: stripe_pm_id,
      confirm: 'true',
      'metadata[invoice_id]': invoiceId,
      'metadata[company_id]': companyId,
      'off_session': 'true',
    })

    // If connected account, route through it
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${stripeKey}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
    if (company?.stripe_account_id && company.stripe_onboarded) {
      form.set('application_fee_amount', String(applicationFeeAmount))
      form.set('transfer_data[destination]', company.stripe_account_id)
    }

    const piRes = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST', headers, body: form.toString()
    })
    const pi = await piRes.json() as any
    if (!piRes.ok) throw new Error(pi.error?.message || 'Charge failed')
    if (pi.status !== 'succeeded') throw new Error(`Payment status: ${pi.status} — may require additional authentication`)

    // Record payment and update invoice
    const amountDollars = amount / 100
    const newPaid = (inv.amount_paid || 0) + amountDollars
    const newBalance = Math.max(0, (inv.total || inv.balance_due || 0) - newPaid)
    const newStatus = newBalance <= 0 ? 'paid' : 'partial'

    await db.prepare(
      `UPDATE invoices SET amount_paid=?, balance_due=?, status=?, updated_at=datetime('now') WHERE id=? AND company_id=?`
    ).bind(newPaid, newBalance, newStatus, invoiceId, companyId).run()

    const pymtId = `py_${Date.now()}_${Math.random().toString(36).slice(2,7)}`
    await db.prepare(
      `INSERT INTO payments (id, company_id, invoice_id, client_id, amount, net_amount, status, payment_method, description, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`
    ).bind(pymtId, companyId, invoiceId, inv.client_id||'', amountDollars, amountDollars,
      'succeeded', 'card', `Stripe charge — ${pi.id}`).run()

    return c.json({ ok: true, payment_intent_id: pi.id, status: newStatus, balance_due: newBalance, amount_paid: newPaid })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// GET /api/clients/import-preview — preview CSV rows before bulk insert
app.post('/api/clients/import-preview', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const b: any = await c.req.json()
  const rows: any[] = b.rows || []

  // For each incoming row, check if email or name already exists
  const results = await Promise.all(rows.slice(0, 100).map(async (row: any) => {
    let duplicate = false
    let matchReason = ''
    if (row.email) {
      const existing: any = await db.prepare(`SELECT id, name FROM clients WHERE company_id=? AND email=? LIMIT 1`)
        .bind(companyId, row.email.toLowerCase().trim()).first()
      if (existing) { duplicate = true; matchReason = `Email matches "${existing.name}"` }
    }
    if (!duplicate && row.name) {
      const existing: any = await db.prepare(`SELECT id, name FROM clients WHERE company_id=? AND LOWER(name)=? LIMIT 1`)
        .bind(companyId, row.name.toLowerCase().trim()).first()
      if (existing) { duplicate = true; matchReason = `Name matches "${existing.name}"` }
    }
    return { ...row, _duplicate: duplicate, _matchReason: matchReason }
  }))
  return c.json({ preview: results, total: rows.length })
})

// POST /api/clients/import-bulk — bulk insert clients from CSV
app.post('/api/clients/import-bulk', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const b: any = await c.req.json()
  const rows: any[] = b.rows || []
  const skipDuplicates: boolean = b.skip_duplicates !== false

  let inserted = 0, skipped = 0, errors: string[] = []

  for (const row of rows.slice(0, 500)) {
    try {
      if (skipDuplicates && row._duplicate) { skipped++; continue }

      // Check live before insert
      let isDupe = false
      if (row.email) {
        const ex = await db.prepare(`SELECT id FROM clients WHERE company_id=? AND email=? LIMIT 1`)
          .bind(companyId, row.email.toLowerCase().trim()).first()
        if (ex) isDupe = true
      }
      if (!isDupe && skipDuplicates && row.name) {
        const ex = await db.prepare(`SELECT id FROM clients WHERE company_id=? AND LOWER(name)=? LIMIT 1`)
          .bind(companyId, row.name.toLowerCase().trim()).first()
        if (ex) isDupe = true
      }
      if (isDupe && skipDuplicates) { skipped++; continue }

      const id = row.id || `cl_${Date.now()}_${Math.random().toString(36).slice(2,8)}`
      await db.prepare(`
        INSERT OR IGNORE INTO clients
          (id, company_id, name, email, phone, address, city, state, zip, type, status, notes, tags, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
      `).bind(id, companyId,
        row.name||'', (row.email||'').toLowerCase().trim(),
        row.phone||row.mobile||'', row.street||row.address||'',
        row.city||'', row.state||'', row.zip||'',
        row.type||'Residential', row.status||'Active',
        row.notes||'', JSON.stringify(row.tags||[])
      ).run()
      inserted++
    } catch(e: any) {
      errors.push(`Row "${row.name}": ${e.message}`)
    }
  }
  return c.json({ inserted, skipped, errors: errors.slice(0, 20), total: rows.length })
})

// ── PUBLIC SIGNUP ─────────────────────────────────────────────────────────────

// POST /api/auth/signup — create new company + admin user (public, no auth)
app.post('/api/auth/signup', async (c) => {
  const db = c.env.DB as D1Database
  const b: any = await c.req.json()
  const { company_name, email, password, business_type, owner_name } = b

  if (!company_name || !email || !password) {
    return c.json({ error: 'Company name, email, and password are required' }, 400)
  }
  if (password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400)
  }

  // Check email uniqueness
  const existing = await db.prepare(`SELECT id FROM reps WHERE email=? LIMIT 1`)
    .bind(email.toLowerCase().trim()).first()
  if (existing) return c.json({ error: 'An account with this email already exists' }, 409)

  // Create company slug
  const slug = company_name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 30)
  const companyId = `co_${Date.now()}_${Math.random().toString(36).slice(2,8)}`

  // Trial: 14 days
  const trialStart = new Date().toISOString()
  const trialEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()

  await db.prepare(`
    INSERT INTO companies (id, name, slug, owner_email, business_type, brand_color, brand_accent,
      subscription_status, trial_plan, trial_started_at, trial_expires_at, onboarding_step,
      created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
  `).bind(companyId, company_name, slug, email.toLowerCase().trim(),
    business_type||'home_services', '#2D7A55', '#4D8A86',
    'trial', 'growth', trialStart, trialEnd, 0
  ).run()

  // Hash password
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256
  )
  const hashHex = [...new Uint8Array(bits)].map(b2 => b2.toString(16).padStart(2,'0')).join('')
  const saltHex = [...salt].map(b2 => b2.toString(16).padStart(2,'0')).join('')
  const passwordHash = `pbkdf2:${saltHex}:${hashHex}`

  const repId = `rep_${Date.now()}_${Math.random().toString(36).slice(2,8)}`
  const displayName = owner_name || email.split('@')[0]

  await db.prepare(`
    INSERT INTO reps (id, company_id, name, email, password_hash, role, is_active, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now'))
  `).bind(repId, companyId, displayName, email.toLowerCase().trim(), passwordHash, 'admin', 1).run()

  // Create a session
  const sessionToken = crypto.randomUUID()
  const sessionExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  await db.prepare(`INSERT INTO sessions (id, rep_id, company_id, expires_at, created_at) VALUES (?,?,?,?,datetime('now'))`)
    .bind(sessionToken, repId, companyId, sessionExpiry).run()

  const res = c.json({
    ok: true,
    company_id: companyId,
    rep_id: repId,
    trial_expires_at: trialEnd,
    onboarding_step: 0
  })

  // Set session cookie
  const headers = new Headers(res.headers)
  headers.set('Set-Cookie', `avalon_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30*24*3600}`)
  return new Response(res.body, { status: 200, headers })
})

// ── RECURRING PLANS (D1) ──────────────────────────────────────────────────────

// GET /api/recurring-plans — list all plans for company
app.get('/api/recurring-plans', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const activeOnly = c.req.query('active')
  let sql = `SELECT * FROM recurring_plans WHERE company_id=? ORDER BY name ASC`
  if (activeOnly === '1') sql = `SELECT * FROM recurring_plans WHERE company_id=? AND is_active=1 ORDER BY name ASC`
  const rows = await db.prepare(sql).bind(companyId).all()
  return c.json(rows.results || [])
})

// GET /api/recurring-plans/:id — single plan
app.get('/api/recurring-plans/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const planId = parseInt(c.req.param('id'))
  const plan = await db.prepare(`SELECT * FROM recurring_plans WHERE id=? AND company_id=?`).bind(planId, companyId).first()
  if (!plan) return c.json({ error: 'Not found' }, 404)
  return c.json(plan)
})

// POST /api/recurring-plans — create a plan
app.post('/api/recurring-plans', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const body = await c.req.json() as any
  const { name, description, frequency, frequency_unit, price, visit_duration_minutes, services_included, is_active } = body
  if (!name || !frequency || !price) return c.json({ error: 'name, frequency, price required' }, 400)
  const id = Date.now()
  await db.prepare(`
    INSERT INTO recurring_plans (id, company_id, name, description, frequency, frequency_unit, price, visit_duration_minutes, services_included, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).bind(id, companyId, name, description||'', frequency, frequency_unit||'weeks', price, visit_duration_minutes||60, services_included||'', is_active??1).run()
  const created = await db.prepare(`SELECT * FROM recurring_plans WHERE id=?`).bind(id).first()
  return c.json(created, 201)
})

// PUT /api/recurring-plans/:id — update a plan
app.put('/api/recurring-plans/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const planId = parseInt(c.req.param('id'))
  const plan = await db.prepare(`SELECT id FROM recurring_plans WHERE id=? AND company_id=?`).bind(planId, companyId).first()
  if (!plan) return c.json({ error: 'Not found' }, 404)
  const body = await c.req.json() as any
  const fields = ['name','description','frequency','frequency_unit','price','visit_duration_minutes','services_included','is_active']
  const setClauses: string[] = []
  const vals: any[] = []
  fields.forEach(f => { if (body[f] !== undefined) { setClauses.push(`${f}=?`); vals.push(body[f]) } })
  if (!setClauses.length) return c.json({ error: 'No fields to update' }, 400)
  vals.push(planId, companyId)
  await db.prepare(`UPDATE recurring_plans SET ${setClauses.join(',')} WHERE id=? AND company_id=?`).bind(...vals).run()
  const updated = await db.prepare(`SELECT * FROM recurring_plans WHERE id=?`).bind(planId).first()
  return c.json(updated)
})

// GET /api/recurring-subscriptions — list subscriptions
app.get('/api/recurring-subscriptions', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const status   = c.req.query('status')
  const upcoming = c.req.query('upcoming') // '1' = only next 30 days
  let sql = `
    SELECT cs.*, rp.name as plan_name, rp.frequency, rp.frequency_unit, rp.price as plan_price,
           cl.name as client_display_name, cl.phone as client_phone, cl.address as client_address
    FROM client_plan_subscriptions cs
    LEFT JOIN recurring_plans rp ON rp.id = cs.plan_id
    LEFT JOIN clients cl ON cl.id = cs.client_id
    WHERE cs.company_id=?`
  const binds: any[] = [companyId]
  if (status) { sql += ` AND cs.status=?`; binds.push(status) }
  if (upcoming === '1') { sql += ` AND cs.next_visit_date <= date('now','+30 days') AND cs.status='active'` }
  sql += ` ORDER BY cs.next_visit_date ASC, cs.created_at DESC`
  const rows = await db.prepare(sql).bind(...binds).all()
  return c.json(rows.results || [])
})

// GET /api/recurring-subscriptions/:id — single subscription
app.get('/api/recurring-subscriptions/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const subId = parseInt(c.req.param('id'))
  const sub = await db.prepare(`
    SELECT cs.*, rp.name as plan_name, rp.frequency, rp.frequency_unit, rp.price as plan_price,
           cl.name as client_display_name, cl.phone as client_phone
    FROM client_plan_subscriptions cs
    LEFT JOIN recurring_plans rp ON rp.id = cs.plan_id
    LEFT JOIN clients cl ON cl.id = cs.client_id
    WHERE cs.id=? AND cs.company_id=?`).bind(subId, companyId).first()
  if (!sub) return c.json({ error: 'Not found' }, 404)
  // Also fetch visit history
  const visits = await db.prepare(`SELECT * FROM plan_visits WHERE subscription_id=? ORDER BY visit_date DESC LIMIT 50`).bind(subId).all()
  return c.json({ ...sub, visits: visits.results || [] })
})

// POST /api/recurring-subscriptions — create subscription
app.post('/api/recurring-subscriptions', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const body = await c.req.json() as any
  const { plan_id, client_id, client_name, start_date, next_visit_date, price_override, notes } = body
  if (!plan_id || !client_id) return c.json({ error: 'plan_id and client_id required' }, 400)
  // Verify plan belongs to this company
  const plan = await db.prepare(`SELECT * FROM recurring_plans WHERE id=? AND company_id=?`).bind(plan_id, companyId).first() as any
  if (!plan) return c.json({ error: 'Plan not found' }, 404)
  const id = Date.now()
  const startDate = start_date || new Date().toISOString().split('T')[0]
  const nextVisit = next_visit_date || startDate
  const finalPrice = price_override ?? plan.price
  await db.prepare(`
    INSERT INTO client_plan_subscriptions (id, company_id, plan_id, client_id, client_name, start_date, next_visit_date, price_override, notes, status)
    VALUES (?,?,?,?,?,?,?,?,?,'active')
  `).bind(id, companyId, plan_id, client_id, client_name||'', startDate, nextVisit, finalPrice, notes||'').run()
  const created = await db.prepare(`SELECT * FROM client_plan_subscriptions WHERE id=?`).bind(id).first()
  return c.json(created, 201)
})

// PUT /api/recurring-subscriptions/:id — update subscription (status, next_visit_date, notes, price_override)
app.put('/api/recurring-subscriptions/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const subId = parseInt(c.req.param('id'))
  const sub = await db.prepare(`SELECT id FROM client_plan_subscriptions WHERE id=? AND company_id=?`).bind(subId, companyId).first()
  if (!sub) return c.json({ error: 'Not found' }, 404)
  const body = await c.req.json() as any
  const fields = ['status','next_visit_date','price_override','notes']
  const setClauses: string[] = []
  const vals: any[] = []
  fields.forEach(f => { if (body[f] !== undefined) { setClauses.push(`${f}=?`); vals.push(body[f]) } })
  if (!setClauses.length) return c.json({ error: 'No fields to update' }, 400)
  if (body.status === 'cancelled') { setClauses.push('cancelled_at=?'); vals.push(new Date().toISOString()) }
  vals.push(subId, companyId)
  await db.prepare(`UPDATE client_plan_subscriptions SET ${setClauses.join(',')} WHERE id=? AND company_id=?`).bind(...vals).run()
  const updated = await db.prepare(`SELECT * FROM client_plan_subscriptions WHERE id=?`).bind(subId).first()
  return c.json(updated)
})

// POST /api/recurring-subscriptions/:id/log-visit — log a completed visit + advance next date
app.post('/api/recurring-subscriptions/:id/log-visit', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const subId = parseInt(c.req.param('id'))
  const sub = await db.prepare(`
    SELECT cs.*, rp.frequency, rp.frequency_unit
    FROM client_plan_subscriptions cs
    LEFT JOIN recurring_plans rp ON rp.id = cs.plan_id
    WHERE cs.id=? AND cs.company_id=?`).bind(subId, companyId).first() as any
  if (!sub) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json() as any
  const { visit_date, notes, technician_name, work_order_id } = body
  const visitDate = visit_date || new Date().toISOString().split('T')[0]

  // Log the visit
  const visitId = Date.now()
  await db.prepare(`
    INSERT INTO plan_visits (id, company_id, subscription_id, visit_date, notes, technician_name, work_order_id, status)
    VALUES (?,?,?,?,?,?,?,'completed')
  `).bind(visitId, companyId, subId, visitDate, notes||'', technician_name||'', work_order_id||null).run()

  // Advance next_visit_date based on plan frequency
  let nextDate = new Date(visitDate)
  const freq = sub.frequency || 1
  const unit = sub.frequency_unit || 'weeks'
  if (unit === 'days')   nextDate.setDate(nextDate.getDate() + freq)
  else if (unit === 'weeks')  nextDate.setDate(nextDate.getDate() + freq * 7)
  else if (unit === 'months') nextDate.setMonth(nextDate.getMonth() + freq)
  else if (unit === 'years')  nextDate.setFullYear(nextDate.getFullYear() + freq)
  const nextDateStr = nextDate.toISOString().split('T')[0]

  await db.prepare(`UPDATE client_plan_subscriptions SET next_visit_date=?, last_visit_date=? WHERE id=?`)
    .bind(nextDateStr, visitDate, subId).run()

  return c.json({ success: true, visit_id: visitId, next_visit_date: nextDateStr })
})

// ── PLAN VISITS (individual visit management) ─────────────────────────────────

// GET /api/plan-visits — list visits (filter by subscription_id, status, date range)
app.get('/api/plan-visits', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const subId   = c.req.query('subscription_id')
  const status  = c.req.query('status')
  const dateFrom = c.req.query('from')
  const dateTo   = c.req.query('to')
  const limit    = parseInt(c.req.query('limit') || '100')
  let sql = `
    SELECT pv.*,
           cs.client_name, cs.service_address, cs.property_access,
           rp.name as plan_name, rp.frequency, rp.tasks as plan_tasks
    FROM plan_visits pv
    LEFT JOIN client_plan_subscriptions cs ON cs.id = pv.subscription_id
    LEFT JOIN recurring_plans rp ON rp.id = pv.plan_id
    WHERE pv.company_id=?`
  const binds: any[] = [companyId]
  if (subId)    { sql += ` AND pv.subscription_id=?`; binds.push(subId) }
  if (status)   { sql += ` AND pv.status=?`;           binds.push(status) }
  if (dateFrom) { sql += ` AND pv.scheduled_date>=?`;  binds.push(dateFrom) }
  if (dateTo)   { sql += ` AND pv.scheduled_date<=?`;  binds.push(dateTo) }
  sql += ` ORDER BY pv.scheduled_date ASC LIMIT ?`
  binds.push(limit)
  const rows = await db.prepare(sql).bind(...binds).all()
  return c.json(rows.results || [])
})

// GET /api/plan-visits/:id — single visit detail
app.get('/api/plan-visits/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const visitId = c.req.param('id')
  const visit = await db.prepare(`
    SELECT pv.*,
           cs.client_name, cs.client_id, cs.service_address, cs.property_access,
           cs.default_crew_name, cs.default_employees,
           rp.name as plan_name, rp.frequency, rp.tasks as plan_tasks, rp.estimated_hours as plan_hours
    FROM plan_visits pv
    LEFT JOIN client_plan_subscriptions cs ON cs.id = pv.subscription_id
    LEFT JOIN recurring_plans rp ON rp.id = pv.plan_id
    WHERE pv.id=? AND pv.company_id=?`).bind(visitId, companyId).first()
  if (!visit) return c.json({ error: 'Not found' }, 404)
  return c.json(visit)
})

// POST /api/plan-visits — create a scheduled visit occurrence
app.post('/api/plan-visits', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const body = await c.req.json() as any
  const { subscription_id, plan_id, client_id, scheduled_date, crew_id, crew_name,
          employee_ids, employee_names, budgeted_hours, address, priority_note,
          visit_notes, checklist_state } = body
  if (!subscription_id || !scheduled_date) return c.json({ error: 'subscription_id and scheduled_date required' }, 400)
  const id = `visit_${Date.now()}_${Math.random().toString(36).slice(2,7)}`
  await db.prepare(`
    INSERT INTO plan_visits (id, company_id, subscription_id, plan_id, client_id,
      scheduled_date, status, crew_id, crew_name, employee_ids, employee_names,
      budgeted_hours, address, priority_note, visit_notes, checklist_state,
      photos, priority_ack, created_at, updated_at)
    VALUES (?,?,?,?,?,?,'scheduled',?,?,?,?,?,?,?,?,?,'[]',0,datetime('now'),datetime('now'))
  `).bind(id, companyId, subscription_id, plan_id||'', client_id||'',
    scheduled_date, crew_id||'', crew_name||'',
    JSON.stringify(employee_ids||[]), JSON.stringify(employee_names||[]),
    budgeted_hours||0, address||'', priority_note||'', visit_notes||'',
    JSON.stringify(checklist_state||{})).run()
  const created = await db.prepare(`SELECT * FROM plan_visits WHERE id=?`).bind(id).first()
  return c.json(created, 201)
})

// PUT /api/plan-visits/:id — update visit (crew, employees, priority note, notes, address, checklist)
app.put('/api/plan-visits/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const visitId = c.req.param('id')
  const visit = await db.prepare(`SELECT id FROM plan_visits WHERE id=? AND company_id=?`).bind(visitId, companyId).first()
  if (!visit) return c.json({ error: 'Not found' }, 404)
  const body = await c.req.json() as any
  const allowed = ['crew_id','crew_name','employee_ids','employee_names','budgeted_hours',
                   'actual_hours','address','priority_note','visit_notes','checklist_state',
                   'photos','status','scheduled_date','priority_ack','priority_ack_by','priority_ack_at']
  const setClauses: string[] = ['updated_at=datetime(\'now\')']
  const vals: any[] = []
  allowed.forEach(f => {
    if (body[f] !== undefined) {
      setClauses.push(`${f}=?`)
      vals.push(typeof body[f] === 'object' ? JSON.stringify(body[f]) : body[f])
    }
  })
  if (setClauses.length === 1) return c.json({ error: 'No fields to update' }, 400)
  vals.push(visitId, companyId)
  await db.prepare(`UPDATE plan_visits SET ${setClauses.join(',')} WHERE id=? AND company_id=?`).bind(...vals).run()
  const updated = await db.prepare(`SELECT * FROM plan_visits WHERE id=?`).bind(visitId).first()
  return c.json(updated)
})

// POST /api/plan-visits/:id/acknowledge — crew acknowledges priority note
app.post('/api/plan-visits/:id/acknowledge', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const visitId = c.req.param('id')
  const body = await c.req.json() as any
  const { acknowledged_by } = body
  const now = new Date().toISOString()
  await db.prepare(`
    UPDATE plan_visits SET priority_ack=1, priority_ack_by=?, priority_ack_at=?, updated_at=datetime('now')
    WHERE id=? AND company_id=?`).bind(acknowledged_by||'Unknown', now, visitId, companyId).run()
  return c.json({ success: true, acknowledged_at: now })
})

// POST /api/plan-visits/:id/complete — mark visit complete, auto-advance subscription next_visit_date
app.post('/api/plan-visits/:id/complete', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const visitId = c.req.param('id')
  const visit = await db.prepare(`
    SELECT pv.*, rp.frequency, rp.frequency_days
    FROM plan_visits pv
    LEFT JOIN recurring_plans rp ON rp.id = pv.plan_id
    WHERE pv.id=? AND pv.company_id=?`).bind(visitId, companyId).first() as any
  if (!visit) return c.json({ error: 'Not found' }, 404)

  // If priority note exists and not acknowledged, block completion
  if (visit.priority_note && !visit.priority_ack) {
    return c.json({ error: 'Priority note must be acknowledged before completing this visit', code: 'ACK_REQUIRED' }, 422)
  }

  const body = await c.req.json() as any
  const { actual_hours, visit_notes, checklist_state, photos } = body
  const now = new Date().toISOString()
  const today = now.split('T')[0]

  // Mark this visit complete
  await db.prepare(`
    UPDATE plan_visits SET status='completed', completed_date=?, actual_hours=?,
      visit_notes=COALESCE(?,visit_notes), checklist_state=COALESCE(?,checklist_state),
      photos=COALESCE(?,photos), updated_at=datetime('now')
    WHERE id=? AND company_id=?`).bind(
    today, actual_hours||0,
    visit_notes||null,
    checklist_state ? JSON.stringify(checklist_state) : null,
    photos ? JSON.stringify(photos) : null,
    visitId, companyId).run()

  // Advance subscription: increment visit_count, update last_visit_date, compute next_visit_date
  const sub = await db.prepare(`
    SELECT cs.*, rp.frequency, rp.frequency_days
    FROM client_plan_subscriptions cs
    LEFT JOIN recurring_plans rp ON rp.id = cs.plan_id
    WHERE cs.id=? AND cs.company_id=?`).bind(visit.subscription_id, companyId).first() as any

  let nextDateStr = today
  if (sub) {
    const freqDaysMap: Record<string,number> = { weekly:7,biweekly:14,monthly:30,bimonthly:60,quarterly:91,semiannual:182,annual:365 }
    const days = sub.frequency_days || freqDaysMap[sub.frequency] || 30
    const base = new Date(today + 'T00:00:00')
    base.setDate(base.getDate() + days)
    nextDateStr = base.toISOString().split('T')[0]
    await db.prepare(`
      UPDATE client_plan_subscriptions
      SET visit_count = visit_count + 1, last_visit_date=?, next_visit_date=?, updated_at=datetime('now')
      WHERE id=?`).bind(today, nextDateStr, visit.subscription_id).run()
  }

  return c.json({ success: true, next_visit_date: nextDateStr, visit_id: visitId })
})

// POST /api/plan-visits/:id/photos — add photos to a visit
app.post('/api/plan-visits/:id/photos', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const visitId = c.req.param('id')
  const visit = await db.prepare(`SELECT id, photos FROM plan_visits WHERE id=? AND company_id=?`).bind(visitId, companyId).first() as any
  if (!visit) return c.json({ error: 'Not found' }, 404)
  const body = await c.req.json() as any
  const { photos } = body // [{url, caption}]
  let existing: any[] = []
  try { existing = JSON.parse(visit.photos || '[]') } catch(_) {}
  const newPhotos = [...existing, ...(photos||[]).map((p: any) => ({
    url: p.url, caption: p.caption||'', uploaded_at: new Date().toISOString()
  }))]
  await db.prepare(`UPDATE plan_visits SET photos=?, updated_at=datetime('now') WHERE id=? AND company_id=?`)
    .bind(JSON.stringify(newPhotos), visitId, companyId).run()
  return c.json({ success: true, photos: newPhotos })
})

// PUT /api/recurring-subscriptions/:id/assignment — update default crew/employees/address for a subscription
app.put('/api/recurring-subscriptions/:id/assignment', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const subId = c.req.param('id')
  const sub = await db.prepare(`SELECT id FROM client_plan_subscriptions WHERE id=? AND company_id=?`).bind(subId, companyId).first()
  if (!sub) return c.json({ error: 'Not found' }, 404)
  const body = await c.req.json() as any
  const { default_crew_id, default_crew_name, default_employees, service_address, property_access } = body
  await db.prepare(`
    UPDATE client_plan_subscriptions
    SET default_crew_id=?, default_crew_name=?, default_employees=?,
        service_address=?, property_access=?, updated_at=datetime('now')
    WHERE id=? AND company_id=?`).bind(
    default_crew_id||'', default_crew_name||'',
    JSON.stringify(default_employees||[]),
    service_address||'', property_access||'',
    subId, companyId).run()
  const updated = await db.prepare(`SELECT * FROM client_plan_subscriptions WHERE id=?`).bind(subId).first()
  return c.json(updated)
})

// ── REVIEWS (D1) ──────────────────────────────────────────────────────────────

// GET /api/reviews — list review requests
app.get('/api/reviews', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const status    = c.req.query('status')
  const clientId  = c.req.query('client_id')
  const search    = c.req.query('search')
  const limit     = parseInt(c.req.query('limit') || '100')
  let sql = `SELECT * FROM review_requests WHERE company_id=?`
  const binds: any[] = [companyId]
  if (status)   { sql += ` AND status=?`;            binds.push(status) }
  if (clientId) { sql += ` AND client_id=?`;         binds.push(clientId) }
  if (search)   { sql += ` AND client_name LIKE ?`;  binds.push(`%${search}%`) }
  sql += ` ORDER BY created_at DESC LIMIT ?`
  binds.push(limit)
  const rows = await db.prepare(sql).bind(...binds).all()
  const reviews = rows.results || []
  return c.json({ reviews, total: reviews.length })
})

// GET /api/reviews/settings — get review settings for company
app.get('/api/reviews/settings', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  // Auto-create default settings row if missing
  await db.prepare(`INSERT OR IGNORE INTO review_settings (company_id) VALUES (?)`).bind(companyId).run()
  const row = await db.prepare(`SELECT * FROM review_settings WHERE company_id=?`).bind(companyId).first() as any
  // Map DB columns → frontend field names (backwards-compatible)
  const settings = row ? {
    ...row,
    auto_send_enabled:    row.trigger_on_wo || 0,
    send_delay_hours:     row.delay_hours   || 0,
    message_template:     row.sms_body      || '',
    min_rating_threshold: 0,
  } : {}
  return c.json({ settings })
})

// PUT /api/reviews/settings — update review settings
app.put('/api/reviews/settings', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const body = await c.req.json() as any
  // Accept both frontend aliases and raw DB column names
  const setClauses: string[] = []
  const vals: any[] = []
  const colMap: Record<string,string> = {
    google_review_url:    'google_review_url',
    facebook_url:         'facebook_url',
    yelp_url:             'yelp_url',
    auto_send_enabled:    'trigger_on_wo',
    send_delay_hours:     'delay_hours',
    message_template:     'sms_body',
    trigger_on_wo:        'trigger_on_wo',
    trigger_on_invoice:   'trigger_on_invoice',
    delay_hours:          'delay_hours',
    channel:              'channel',
    email_subject:        'email_subject',
    email_body:           'email_body',
    sms_body:             'sms_body',
    enabled:              'enabled',
  }
  Object.entries(colMap).forEach(([frontKey, dbCol]) => {
    if (body[frontKey] !== undefined) {
      // Avoid duplicate SET clauses if alias points to same col
      if (!setClauses.includes(`${dbCol}=?`)) {
        setClauses.push(`${dbCol}=?`)
        vals.push(body[frontKey])
      }
    }
  })
  if (!setClauses.length) return c.json({ error: 'No fields to update' }, 400)
  // Upsert settings row
  await db.prepare(`INSERT OR IGNORE INTO review_settings (company_id) VALUES (?)`).bind(companyId).run()
  vals.push(companyId)
  await db.prepare(`UPDATE review_settings SET ${setClauses.join(',')} WHERE company_id=?`).bind(...vals).run()
  const updated = await db.prepare(`SELECT * FROM review_settings WHERE company_id=?`).bind(companyId).first()
  return c.json({ settings: updated })
})

// POST /api/reviews — create a review request
app.post('/api/reviews', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const body = await c.req.json() as any
  const { client_id, client_name, client_name_hint, client_email, trigger_type, work_order_id, custom_message, auto_triggered } = body
  // client_id required for manual; auto_triggered may pass work_order_id without client_id
  const id = `rv_${Date.now()}_${Math.random().toString(36).slice(2,7)}`
  const triggerTypeResolved = trigger_type || (auto_triggered ? 'work_order_close' : 'manual')
  const resolvedName = client_name || client_name_hint || ''
  await db.prepare(`
    INSERT INTO review_requests
      (id, company_id, client_id, client_name, client_email, trigger_type, trigger_id, status, delay_hours)
    VALUES (?,?,?,?,?,?,?,?, 0)
  `).bind(
    id, companyId,
    client_id || '',
    resolvedName,
    client_email || '',
    triggerTypeResolved,
    work_order_id ? String(work_order_id) : '',
    auto_triggered ? 'sent' : 'pending'
  ).run()
  const created = await db.prepare(`SELECT * FROM review_requests WHERE id=?`).bind(id).first()
  return c.json({ review: created }, 201)
})

// POST /api/reviews/:id/send — mark a review request as sent
app.post('/api/reviews/:id/send', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const rvId = c.req.param('id')
  const rv = await db.prepare(`SELECT id FROM review_requests WHERE id=? AND company_id=?`).bind(rvId, companyId).first()
  if (!rv) return c.json({ error: 'Not found' }, 404)
  await db.prepare(`UPDATE review_requests SET status='sent', sent_at=? WHERE id=? AND company_id=?`)
    .bind(new Date().toISOString(), rvId, companyId).run()
  const updated = await db.prepare(`SELECT * FROM review_requests WHERE id=?`).bind(rvId).first()
  return c.json({ review: updated })
})

// PUT /api/reviews/:id — update review request (status, rating, review_text, platform)
app.put('/api/reviews/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const rvId = parseInt(c.req.param('id'))
  const rv = await db.prepare(`SELECT id FROM review_requests WHERE id=? AND company_id=?`).bind(rvId, companyId).first()
  if (!rv) return c.json({ error: 'Not found' }, 404)
  const body = await c.req.json() as any
  const fields = ['status','rating','review_text','platform']
  const setClauses: string[] = []
  const vals: any[] = []
  fields.forEach(f => { if (body[f] !== undefined) { setClauses.push(`${f}=?`); vals.push(body[f]) } })
  if (body.status === 'reviewed') { setClauses.push('reviewed_at=?'); vals.push(new Date().toISOString()) }
  if (body.status === 'sent')     { setClauses.push('sent_at=?');     vals.push(new Date().toISOString()) }
  if (!setClauses.length) return c.json({ error: 'No fields to update' }, 400)
  vals.push(rvId, companyId)
  await db.prepare(`UPDATE review_requests SET ${setClauses.join(',')} WHERE id=? AND company_id=?`).bind(...vals).run()
  const updated = await db.prepare(`SELECT * FROM review_requests WHERE id=?`).bind(rvId).first()
  return c.json(updated)
})

// ── EMAIL (SendGrid) ─────────────────────────────────────────────────────────

// GET /api/email/status — check if SendGrid is configured
app.get('/api/email/status', requireAuth, async (c) => {
  const configured = !!(c.env as any).SENDGRID_API_KEY
  return c.json({ configured })
})

// POST /api/email/send — send a transactional email
app.post('/api/email/send', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const apiKey = (c.env as any).SENDGRID_API_KEY as string | undefined
  const body = await c.req.json() as any
  const { to_email, subject, body: msgBody, entity_type, entity_id } = body
  if (!to_email || !subject || !msgBody) return c.json({ error: 'to_email, subject, body required' }, 400)

  if (!apiKey) {
    // No SendGrid — signal fallback to mailto
    return c.json({ fallback: true, message: 'SendGrid not configured — use mailto fallback' })
  }

  // Convert plain text body to simple HTML
  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:600px;margin:40px auto;padding:0 20px;color:#374151">
    <div style="border-bottom:3px solid #2D7A55;padding-bottom:12px;margin-bottom:24px">
      <strong style="font-size:18px;color:#111827">Groundwork CRM</strong>
    </div>
    <div style="font-size:15px;line-height:1.7;white-space:pre-wrap">${msgBody.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
    <div style="margin-top:32px;padding-top:16px;border-top:1px solid #E5E7EB;font-size:11px;color:#9CA3AF">
      Sent via Groundwork CRM
    </div>
  </body></html>`

  const sent = await sendEmail(apiKey, to_email, subject, html)
  if (!sent) return c.json({ error: 'Email delivery failed' }, 500)

  return c.json({ ok: true, to: to_email, subject })
})

// ── NOTIFICATIONS (D1) ──────────────────────────────────────────────────────

// GET /api/notifications — list notifications for current user
app.get('/api/notifications', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const limit = parseInt(c.req.query('limit') || '30')
  const rows = await db.prepare(`
    SELECT * FROM notifications
    WHERE company_id=?
    ORDER BY created_at DESC LIMIT ?
  `).bind(companyId, limit).all()
  const notifications = rows.results || []
  const unread = notifications.filter((n: any) => !n.is_read).length
  return c.json({ notifications, unread })
})

// POST /api/notifications — create a notification (internal use)
app.post('/api/notifications', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const body = await c.req.json() as any
  const { type, title, body: notifBody, entity_type, entity_id, action_url, rep_id } = body
  if (!type || !title) return c.json({ error: 'type and title required' }, 400)
  const id = `notif_${Date.now()}_${Math.random().toString(36).slice(2,7)}`
  await db.prepare(`
    INSERT INTO notifications (id, company_id, rep_id, type, title, body, entity_type, entity_id, action_url)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).bind(id, companyId, rep_id||'', type, title, notifBody||'', entity_type||'', entity_id||'', action_url||'').run()
  return c.json({ ok: true, id }, 201)
})

// POST /api/notifications/:id/read — mark single notification read
app.post('/api/notifications/:id/read', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const id = c.req.param('id')
  await db.prepare(`UPDATE notifications SET is_read=1 WHERE id=? AND company_id=?`).bind(id, companyId).run()
  return c.json({ ok: true })
})

// POST /api/notifications/read-all — mark all notifications read
app.post('/api/notifications/read-all', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await db.prepare(`UPDATE notifications SET is_read=1 WHERE company_id=?`).bind(companyId).run()
  return c.json({ ok: true })
})

// ══════════════════════════════════════════════════════════════════════════════
// FIELD OPS — Equipment Reports, After Action Reports, Division Manager
// ══════════════════════════════════════════════════════════════════════════════

// ── Field Reports ─────────────────────────────────────────────────────────────

// GET /api/field-reports — list (division_manager/admin/OM sees all; field roles see own)
app.get('/api/field-reports', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const rep: any = c.var.rep
  const managerRoles = ['admin','owner','office_manager','division_manager']
  const isManager = managerRoles.includes(rep?.role)
  const status = c.req.query('status') || null
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200)

  let query = `SELECT fr.*, r.name as rep_name, r.role as rep_role
    FROM field_reports fr
    LEFT JOIN reps r ON r.id = fr.rep_id
    WHERE fr.company_id = ?`
  const params: any[] = [companyId]

  if (!isManager) {
    query += ` AND fr.rep_id = ?`
    params.push(rep.id)
  }
  if (status) {
    query += ` AND fr.status = ?`
    params.push(status)
  }
  query += ` ORDER BY fr.created_at DESC LIMIT ?`
  params.push(limit)

  const rows = await db.prepare(query).bind(...params).all()
  return c.json({ ok: true, field_reports: rows.results || [] })
})

// POST /api/field-reports — submit a new field report (any field role)
app.post('/api/field-reports', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const rep: any = c.var.rep
  const body = await c.req.json() as any

  const { report_type, title, description, priority, crew_id, asset_id, photo_url, work_order_id } = body
  if (!title || !description) return c.json({ error: 'title and description are required' }, 400)

  const id = `fr-${Date.now()}-${Math.random().toString(36).slice(2,7)}`
  await db.prepare(`
    INSERT INTO field_reports (id, company_id, rep_id, crew_id, report_type, title, description, priority, status, asset_id, photo_url, work_order_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(id, companyId, rep.id, crew_id||null, report_type||'equipment', title, description, priority||'normal', 'open', asset_id||null, photo_url||null, work_order_id||null).run()

  // Notify managers
  try {
    const managers = await db.prepare(`SELECT id FROM reps WHERE company_id=? AND role IN ('admin','owner','office_manager','division_manager') AND active=1`).bind(companyId).all()
    for (const mgr of (managers.results || []) as any[]) {
      const nid = `notif-fr-${Date.now()}-${Math.random().toString(36).slice(2,6)}`
      await db.prepare(`INSERT OR IGNORE INTO notifications (id, company_id, rep_id, type, title, body, link) VALUES (?,?,?,?,?,?,?)`)
        .bind(nid, companyId, mgr.id, 'field_report', `Field Report: ${title}`, `${rep.name || 'A field employee'} submitted a ${report_type||'equipment'} report.`, '/field-reports').run()
    }
  } catch(_) {}

  return c.json({ ok: true, id })
})

// PATCH /api/field-reports/:id — update status/resolution (manager only)
app.patch('/api/field-reports/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const rep: any = c.var.rep
  const managerRoles = ['admin','owner','office_manager','division_manager']
  if (!managerRoles.includes(rep?.role)) return c.json({ error: 'Insufficient permissions' }, 403)

  const id = c.req.param('id')
  const body = await c.req.json() as any
  const { status, resolved_note } = body

  await db.prepare(`
    UPDATE field_reports SET status=COALESCE(?,status), resolved_by=COALESCE(?,resolved_by),
    resolved_note=COALESCE(?,resolved_note), updated_at=datetime('now')
    WHERE id=? AND company_id=?
  `).bind(status||null, status==='resolved' ? rep.id : null, resolved_note||null, id, companyId).run()

  return c.json({ ok: true })
})

// ── AAR Templates ─────────────────────────────────────────────────────────────

// GET /api/aar-template — get active template for this company
app.get('/api/aar-template', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const tmpl: any = await db.prepare(`SELECT * FROM aar_templates WHERE company_id=? LIMIT 1`).bind(companyId).first()
  if (!tmpl) {
    // Return default
    return c.json({ ok: true, template: {
      id: null, title: 'End-of-Day Field Report',
      intro_text: 'Quick check before you clock out.',
      require_before_clockout: 1,
      questions: [
        {id:'q1',type:'yesno',label:'Did you complete all assigned work orders for today?',required:true},
        {id:'q2',type:'yesno',label:'Did any equipment break or require service today?',required:true},
        {id:'q3',type:'yesno',label:'Were there any safety incidents or near-misses?',required:true},
        {id:'q4',type:'yesno',label:'Do you need any supplies or materials restocked?',required:false},
        {id:'q5',type:'text',label:'Any notes for the manager?',required:false},
        {id:'q6',type:'rating',label:'How did the day go overall? (1=rough, 5=great)',required:false},
      ]
    }})
  }
  let questions = tmpl.questions
  if (typeof questions === 'string') {
    try { questions = JSON.parse(questions) } catch(_) { questions = [] }
  }
  return c.json({ ok: true, template: { ...tmpl, questions } })
})

// PUT /api/aar-template — save/update template (admin/OM/division_manager)
app.put('/api/aar-template', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const rep: any = c.var.rep
  const allowed = ['admin','owner','office_manager','division_manager']
  if (!allowed.includes(rep?.role)) return c.json({ error: 'Insufficient permissions' }, 403)

  const body = await c.req.json() as any
  const { title, intro_text, questions, require_before_clockout } = body
  if (!questions || !Array.isArray(questions)) return c.json({ error: 'questions array required' }, 400)

  const id = `aar-${companyId}`
  await db.prepare(`
    INSERT INTO aar_templates (id, company_id, title, intro_text, questions, require_before_clockout, created_by, updated_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(company_id) DO UPDATE SET
      title=excluded.title, intro_text=excluded.intro_text, questions=excluded.questions,
      require_before_clockout=excluded.require_before_clockout, updated_at=datetime('now')
  `).bind(id, companyId, title||'End-of-Day Field Report', intro_text||'', JSON.stringify(questions), require_before_clockout===false?0:1, rep.id).run()

  return c.json({ ok: true })
})

// ── AAR Submissions ───────────────────────────────────────────────────────────

// GET /api/aar-submissions — list (manager sees all, field sees own)
app.get('/api/aar-submissions', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const rep: any = c.var.rep
  const managerRoles = ['admin','owner','office_manager','division_manager']
  const isManager = managerRoles.includes(rep?.role)
  const date = c.req.query('date') || null
  const repFilter = c.req.query('rep_id') || null
  const limit = Math.min(parseInt(c.req.query('limit')||'50'), 200)

  let query = `SELECT s.*, r.name as rep_name FROM aar_submissions s
    LEFT JOIN reps r ON r.id = s.rep_id
    WHERE s.company_id = ?`
  const params: any[] = [companyId]

  if (!isManager) {
    query += ` AND s.rep_id = ?`
    params.push(rep.id)
  } else if (repFilter) {
    query += ` AND s.rep_id = ?`
    params.push(repFilter)
  }
  if (date) { query += ` AND s.work_date = ?`; params.push(date) }
  query += ` ORDER BY s.submitted_at DESC LIMIT ?`
  params.push(limit)

  const rows = await db.prepare(query).bind(...params).all()
  const results = (rows.results || []).map((r: any) => ({
    ...r,
    answers: typeof r.answers === 'string' ? (() => { try { return JSON.parse(r.answers) } catch(_) { return {} } })() : r.answers
  }))
  return c.json({ ok: true, submissions: results })
})

// POST /api/aar-submissions — field worker submits their AAR
app.post('/api/aar-submissions', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const rep: any = c.var.rep
  const body = await c.req.json() as any

  const { answers, time_entry_id, work_date } = body
  if (!answers || typeof answers !== 'object') return c.json({ error: 'answers object required' }, 400)

  const today = new Date().toISOString().slice(0, 10)
  const dateKey = work_date || today

  // Prevent duplicate submission for same rep+date
  const existing: any = await db.prepare(`SELECT id FROM aar_submissions WHERE rep_id=? AND company_id=? AND work_date=?`).bind(rep.id, companyId, dateKey).first()
  if (existing) {
    // Update instead of duplicate
    await db.prepare(`UPDATE aar_submissions SET answers=?, time_entry_id=COALESCE(?,time_entry_id), submitted_at=datetime('now') WHERE id=?`)
      .bind(JSON.stringify(answers), time_entry_id||null, existing.id).run()
    return c.json({ ok: true, id: existing.id, updated: true })
  }

  const id = `aar-${Date.now()}-${Math.random().toString(36).slice(2,7)}`
  await db.prepare(`
    INSERT INTO aar_submissions (id, company_id, rep_id, time_entry_id, work_date, answers)
    VALUES (?,?,?,?,?,?)
  `).bind(id, companyId, rep.id, time_entry_id||null, dateKey, JSON.stringify(answers)).run()

  return c.json({ ok: true, id })
})

// PATCH /api/aar-submissions/:id/review — manager reviews/flags a submission
app.patch('/api/aar-submissions/:id/review', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const rep: any = c.var.rep
  const allowed = ['admin','owner','office_manager','division_manager']
  if (!allowed.includes(rep?.role)) return c.json({ error: 'Insufficient permissions' }, 403)

  const id = c.req.param('id')
  const body = await c.req.json() as any
  const { flagged, review_note } = body

  await db.prepare(`
    UPDATE aar_submissions SET flagged=COALESCE(?,flagged), review_note=COALESCE(?,review_note),
    reviewed_by=?, reviewed_at=datetime('now') WHERE id=? AND company_id=?
  `).bind(flagged!==undefined?Number(flagged):null, review_note||null, rep.id, id, companyId).run()

  return c.json({ ok: true })
})

// GET /api/aar-check-today — has this rep submitted an AAR for today already?
app.get('/api/aar-check-today', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const rep: any = c.var.rep
  const today = new Date().toISOString().slice(0, 10)
  const row: any = await db.prepare(`SELECT id FROM aar_submissions WHERE rep_id=? AND company_id=? AND work_date=?`).bind(rep.id, companyId, today).first()
  const tmpl: any = await db.prepare(`SELECT require_before_clockout FROM aar_templates WHERE company_id=? LIMIT 1`).bind(companyId).first()
  return c.json({ submitted: !!row, required: tmpl ? Boolean(tmpl.require_before_clockout) : true })
})

// ── ESTIMATE PORTAL (public — no auth) ───────────────────────────────────────

// GET /estimates/portal/:token — public estimate approval page
app.get('/estimates/portal/:token', async (c) => {
  const token = c.req.param('token')
  const db = c.env.DB as D1Database
  // Look up token
  const pt = await db.prepare(`SELECT * FROM estimate_portal_tokens WHERE token=?`).bind(token).first() as any
  if (!pt) return c.html(`<html><body style="font-family:sans-serif;text-align:center;padding:60px">
    <h2>Link not found</h2><p>This estimate link is invalid or has expired.</p></body></html>`, 404)
  const est = await db.prepare(`SELECT * FROM estimates WHERE id=? AND company_id=?`).bind(pt.estimate_id, pt.company_id).first() as any
  if (!est) return c.html(`<html><body style="font-family:sans-serif;text-align:center;padding:60px">
    <h2>Estimate not found</h2></body></html>`, 404)
  const company = await db.prepare(`SELECT * FROM companies WHERE id=?`).bind(pt.company_id).first() as any

  const statusLabel = { draft:'Draft', sent:'Sent', approved:'Approved ✓', declined:'Declined', expired:'Expired' }[est.status] || est.status
  const canAct = ['sent','draft'].includes(est.status)
  const lineItems = (() => { try { return JSON.parse(est.line_items||'[]') } catch { return [] } })()
  const total = lineItems.reduce((s: number, i: any) => s + (Number(i.qty||1) * Number(i.unit_price||0)), 0)

  return c.html(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Estimate from ${company?.name || 'Groundwork'}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F9FAFB;color:#111827}
    .portal-header{background:#111827;padding:20px 24px;display:flex;align-items:center;gap:12px}
    .portal-logo{font-size:18px;font-weight:800;color:#fff;display:flex;align-items:center;gap:8px}
    .portal-logo span{color:#2D7A55}
    .portal-wrap{max-width:680px;margin:32px auto;padding:0 16px 60px}
    .portal-card{background:#fff;border:1px solid #E5E7EB;border-radius:14px;overflow:hidden;margin-bottom:20px}
    .portal-card-header{background:#2D7A55;padding:20px 24px}
    .portal-card-title{font-size:20px;font-weight:700;color:#fff}
    .portal-card-sub{font-size:13px;color:rgba(255,255,255,.75);margin-top:4px}
    .portal-section{padding:20px 24px;border-bottom:1px solid #F3F4F6}
    .portal-section:last-child{border-bottom:none}
    .portal-label{font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
    .portal-value{font-size:15px;color:#111827}
    .portal-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    table{width:100%;border-collapse:collapse}
    th{text-align:left;font-size:12px;font-weight:600;color:#6B7280;padding:8px 0;border-bottom:1px solid #E5E7EB}
    td{padding:10px 0;font-size:14px;color:#374151;border-bottom:1px solid #F3F4F6}
    tr:last-child td{border-bottom:none}
    .total-row{display:flex;justify-content:flex-end;margin-top:16px}
    .total-val{font-size:22px;font-weight:800;color:#111827}
    .status-badge{display:inline-flex;padding:4px 14px;border-radius:99px;font-size:12px;font-weight:600}
    .status-sent{background:#EFF6FF;color:#1D4ED8}
    .status-approved{background:#F0FAF4;color:#2D7A55}
    .status-declined{background:#FEF2F2;color:#DC2626}
    .action-section{padding:24px;display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
    .btn-approve{background:#2D7A55;color:#fff;border:none;border-radius:10px;padding:14px 32px;font-size:15px;font-weight:700;cursor:pointer;transition:.15s}
    .btn-approve:hover{background:#1F5C3F}
    .btn-decline{background:#fff;color:#DC2626;border:2px solid #FECACA;border-radius:10px;padding:13px 28px;font-size:15px;font-weight:600;cursor:pointer;transition:.15s}
    .btn-decline:hover{background:#FEF2F2}
    .action-msg{text-align:center;padding:20px;font-size:16px;font-weight:600}
    .action-msg.success{color:#2D7A55}
    .action-msg.error{color:#DC2626}
    #decline-reason{display:none;padding:0 24px 16px}
    textarea{width:100%;padding:10px 12px;border:1px solid #D1D5DB;border-radius:8px;font-size:14px;font-family:inherit;resize:vertical;margin-bottom:10px}
    .btn-confirm-decline{background:#DC2626;color:#fff;border:none;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:600;cursor:pointer}
    @media(max-width:480px){.portal-grid{grid-template-columns:1fr}.action-section{flex-direction:column}}
  </style>
</head>
<body>
<div class="portal-header">
  <div class="portal-logo">${company?.name || 'Groundwork'}</div>
</div>
<div class="portal-wrap">
  <div class="portal-card">
    <div class="portal-card-header">
      <div class="portal-card-title">Estimate #${est.estimate_number || est.id}</div>
      <div class="portal-card-sub">${company?.name || ''} · <span class="status-badge status-${est.status}">${statusLabel}</span></div>
    </div>

    <div class="portal-section portal-grid">
      <div><div class="portal-label">Client</div><div class="portal-value">${est.client_name || '—'}</div></div>
      <div><div class="portal-label">Project</div><div class="portal-value">${est.project_name || est.service_type || '—'}</div></div>
      <div><div class="portal-label">Date</div><div class="portal-value">${est.created_at ? new Date(est.created_at).toLocaleDateString() : '—'}</div></div>
      <div><div class="portal-label">Valid Until</div><div class="portal-value">${est.valid_until ? new Date(est.valid_until).toLocaleDateString() : '30 days'}</div></div>
    </div>

    ${lineItems.length ? `
    <div class="portal-section">
      <div class="portal-label" style="margin-bottom:12px">Line Items</div>
      <table>
        <thead><tr><th>Description</th><th>Qty</th><th>Unit Price</th><th style="text-align:right">Total</th></tr></thead>
        <tbody>
          ${lineItems.map((li: any) => {
            const qty = Number(li.qty||1)
            const price = Number(li.unit_price||0)
            return `<tr>
              <td>${li.name||li.description||'Service'}</td>
              <td>${qty}</td>
              <td>$${price.toFixed(2)}</td>
              <td style="text-align:right">$${(qty*price).toFixed(2)}</td>
            </tr>`
          }).join('')}
        </tbody>
      </table>
      <div class="total-row">
        <div>
          <div style="font-size:12px;color:#9CA3AF;text-align:right;margin-bottom:2px">TOTAL</div>
          <div class="total-val">$${total.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
        </div>
      </div>
    </div>` : ''}

    ${est.notes ? `
    <div class="portal-section">
      <div class="portal-label">Notes</div>
      <div class="portal-value" style="line-height:1.6;white-space:pre-wrap">${est.notes}</div>
    </div>` : ''}

    ${canAct ? `
    <div id="action-section" class="action-section">
      <button class="btn-approve" onclick="_portalApprove('${token}')">✓ Approve Estimate</button>
      <button class="btn-decline" onclick="_portalShowDecline()">Request Changes</button>
    </div>
    <div id="decline-reason">
      <textarea id="decline-text" rows="3" placeholder="What changes would you like? (optional)"></textarea>
      <button class="btn-confirm-decline" onclick="_portalDecline('${token}')">Submit Request</button>
    </div>` : `
    <div class="action-section">
      <div class="action-msg ${est.status==='approved'?'success':''}">${
        est.status==='approved' ? '✓ You approved this estimate' :
        est.status==='declined' ? 'You requested changes on this estimate' :
        'This estimate is no longer pending action.'
      }</div>
    </div>`}

    <div id="action-result"></div>
  </div>

  <p style="text-align:center;font-size:12px;color:#9CA3AF">
    Questions? Contact ${company?.phone || company?.email || 'your contractor'} · Powered by Groundwork CRM
  </p>
</div>
<script>
async function _portalApprove(token) {
  const btn = document.querySelector('.btn-approve');
  if(btn){btn.disabled=true;btn.textContent='Approving…';}
  const res = await fetch('/api/estimates/portal/'+token+'/approve',{method:'POST'});
  const d = await res.json();
  const sec = document.getElementById('action-section');
  const result = document.getElementById('action-result');
  if(sec) sec.style.display='none';
  if(result) result.innerHTML = '<div class="action-msg success" style="padding:20px">✓ Estimate approved! We\'ll be in touch shortly to schedule the work.</div>';
}
function _portalShowDecline() {
  const dr = document.getElementById('decline-reason');
  if(dr) dr.style.display = dr.style.display==='none'?'block':'none';
}
async function _portalDecline(token) {
  const reason = document.getElementById('decline-text')?.value||'';
  const res = await fetch('/api/estimates/portal/'+token+'/decline',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason})});
  const d = await res.json();
  const sec = document.getElementById('action-section');
  const dr  = document.getElementById('decline-reason');
  const result = document.getElementById('action-result');
  if(sec) sec.style.display='none';
  if(dr)  dr.style.display='none';
  if(result) result.innerHTML = '<div class="action-msg" style="padding:20px">Request submitted! We\'ll follow up with you soon.</div>';
}
</script>
</body></html>`)
})

// POST /api/estimates/portal/:token/approve — client approves estimate
app.post('/api/estimates/portal/:token/approve', async (c) => {
  const token = c.req.param('token')
  const db = c.env.DB as D1Database
  const pt = await db.prepare(`SELECT * FROM estimate_portal_tokens WHERE token=?`).bind(token).first() as any
  if (!pt) return c.json({ error: 'Invalid token' }, 404)
  await db.prepare(`UPDATE estimates SET status='approved' WHERE id=? AND company_id=?`).bind(pt.estimate_id, pt.company_id).run()
  await db.prepare(`UPDATE estimate_portal_tokens SET used_at=? WHERE token=?`).bind(new Date().toISOString(), token).run()
  // Create notification for the company
  const est = await db.prepare(`SELECT estimate_number, client_name FROM estimates WHERE id=?`).bind(pt.estimate_id).first() as any
  const notifId = `notif_${Date.now()}`
  await db.prepare(`INSERT OR IGNORE INTO notifications (id,company_id,type,title,body,entity_type,entity_id,action_url)
    VALUES (?,?,'estimate_approved',?,?,?,?,?)`)
    .bind(notifId, pt.company_id,
      `Estimate #${est?.estimate_number||pt.estimate_id} Approved!`,
      `${est?.client_name||'Client'} approved the estimate. Ready to schedule.`,
      'estimate', pt.estimate_id, '#estimates').run()
  return c.json({ ok: true })
})

// POST /api/estimates/portal/:token/decline — client requests changes
app.post('/api/estimates/portal/:token/decline', async (c) => {
  const token = c.req.param('token')
  const db = c.env.DB as D1Database
  const pt = await db.prepare(`SELECT * FROM estimate_portal_tokens WHERE token=?`).bind(token).first() as any
  if (!pt) return c.json({ error: 'Invalid token' }, 404)
  const body = await c.req.json().catch(() => ({})) as any
  await db.prepare(`UPDATE estimates SET status='declined', notes=COALESCE(notes||' | Client feedback: '||?,'') WHERE id=? AND company_id=?`)
    .bind(body.reason||'Changes requested', pt.estimate_id, pt.company_id).run()
  const est = await db.prepare(`SELECT estimate_number, client_name FROM estimates WHERE id=?`).bind(pt.estimate_id).first() as any
  const notifId = `notif_${Date.now()}`
  await db.prepare(`INSERT OR IGNORE INTO notifications (id,company_id,type,title,body,entity_type,entity_id,action_url)
    VALUES (?,?,'estimate_declined',?,?,?,?,?)`)
    .bind(notifId, pt.company_id,
      `Estimate #${est?.estimate_number||pt.estimate_id} — Changes Requested`,
      body.reason ? `Feedback: "${body.reason}"` : `${est?.client_name||'Client'} requested changes.`,
      'estimate', pt.estimate_id, '#estimates').run()
  return c.json({ ok: true })
})

// POST /api/estimates/:id/portal-token — generate a portal token for estimate
app.post('/api/estimates/:id/portal-token', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const estId = c.req.param('id')
  const est = await db.prepare(`SELECT id FROM estimates WHERE id=? AND company_id=?`).bind(estId, companyId).first()
  if (!est) return c.json({ error: 'Not found' }, 404)
  const body = await c.req.json().catch(() => ({})) as any
  const token = `ept_${Date.now()}_${Math.random().toString(36).slice(2,10)}`
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  await db.prepare(`INSERT OR REPLACE INTO estimate_portal_tokens (token,company_id,estimate_id,client_email,expires_at)
    VALUES (?,?,?,?,?)`).bind(token, companyId, estId, body.client_email||'', expires).run()
  const portalUrl = `${new URL(c.req.url).origin}/estimates/portal/${token}`
  return c.json({ token, url: portalUrl })
})

// ── STRIPE CONNECT (D1 + Stripe API) ─────────────────────────────────────────
// All routes use requireAuth. Stripe secret is stored as STRIPE_SECRET_KEY env var.
// Platform Connect model: Groundwork is the platform, tenants are connected accounts.

// GET /api/stripe/status — connected account info + balance
app.get('/api/stripe/status', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const stripeKey = (c.env as any).STRIPE_SECRET_KEY as string | undefined
  if (!stripeKey) return c.json({ error: 'Stripe not configured' }, 503)
  const company = await db.prepare(`SELECT stripe_account_id, stripe_onboarded, stripe_charges_enabled, stripe_platform_fee_pct FROM companies WHERE id=?`).bind(companyId).first() as any
  if (!company?.stripe_account_id || !company.stripe_onboarded) {
    return c.json({ onboarded: false, platform_fee_pct: company?.stripe_platform_fee_pct || 2.9 })
  }
  // Fetch live data from Stripe
  try {
    const [acctRes, balRes] = await Promise.all([
      fetch(`https://api.stripe.com/v1/accounts/${company.stripe_account_id}`, {
        headers: { 'Authorization': `Bearer ${stripeKey}` }
      }),
      fetch(`https://api.stripe.com/v1/balance`, {
        headers: { 'Authorization': `Bearer ${stripeKey}`, 'Stripe-Account': company.stripe_account_id }
      }),
    ])
    const account = acctRes.ok ? await acctRes.json() : {}
    const balance = balRes.ok ? await balRes.json() : {}
    return c.json({ onboarded: true, account, balance, platform_fee_pct: company.stripe_platform_fee_pct || 2.9 })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// POST /api/stripe/connect — create account link for onboarding
app.post('/api/stripe/connect', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const stripeKey = (c.env as any).STRIPE_SECRET_KEY as string | undefined
  if (!stripeKey) return c.json({ error: 'Stripe not configured' }, 503)
  const company = await db.prepare(`SELECT stripe_account_id FROM companies WHERE id=?`).bind(companyId).first() as any
  try {
    let accountId = company?.stripe_account_id
    if (!accountId) {
      // Create Express connected account
      const form = new URLSearchParams({ type: 'express', 'capabilities[card_payments][requested]': 'true', 'capabilities[transfers][requested]': 'true' })
      const createRes = await fetch('https://api.stripe.com/v1/accounts', {
        method: 'POST', headers: { 'Authorization': `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString()
      })
      const created = await createRes.json() as any
      if (!createRes.ok) throw new Error(created.error?.message || 'Account creation failed')
      accountId = created.id
      await db.prepare(`UPDATE companies SET stripe_account_id=? WHERE id=?`).bind(accountId, companyId).run()
    }
    // Create account link
    const origin = new URL(c.req.url).origin
    const linkForm = new URLSearchParams({
      account: accountId,
      'refresh_url': `${origin}/api/stripe/connect-refresh`,
      'return_url': `${origin}/api/stripe/connect-return`,
      type: 'account_onboarding',
    })
    const linkRes = await fetch('https://api.stripe.com/v1/account_links', {
      method: 'POST', headers: { 'Authorization': `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: linkForm.toString()
    })
    const link = await linkRes.json() as any
    if (!linkRes.ok) throw new Error(link.error?.message || 'Link creation failed')
    return c.json({ url: link.url })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// GET /api/stripe/connect-return — Stripe redirects here after onboarding
app.get('/api/stripe/connect-return', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const stripeKey = (c.env as any).STRIPE_SECRET_KEY as string | undefined
  const company = await db.prepare(`SELECT stripe_account_id FROM companies WHERE id=?`).bind(companyId).first() as any
  if (company?.stripe_account_id && stripeKey) {
    const acctRes = await fetch(`https://api.stripe.com/v1/accounts/${company.stripe_account_id}`, {
      headers: { 'Authorization': `Bearer ${stripeKey}` }
    })
    const acct = await acctRes.json() as any
    if (acct.charges_enabled) {
      await db.prepare(`UPDATE companies SET stripe_onboarded=1, stripe_charges_enabled=1 WHERE id=?`).bind(companyId).run()
    }
  }
  return c.redirect('/#gwStripe')
})

// GET /api/stripe/connect-refresh — account link expired; redirect back to connect
app.get('/api/stripe/connect-refresh', requireAuth, async (c) => {
  return c.redirect('/#gwStripe')
})

// GET /api/stripe/charges — recent charges for connected account
app.get('/api/stripe/charges', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const stripeKey = (c.env as any).STRIPE_SECRET_KEY as string | undefined
  if (!stripeKey) return c.json({ charges: [] })
  const company = await db.prepare(`SELECT stripe_account_id, stripe_onboarded FROM companies WHERE id=?`).bind(companyId).first() as any
  if (!company?.stripe_account_id || !company.stripe_onboarded) return c.json({ charges: [] })
  try {
    const res = await fetch('https://api.stripe.com/v1/charges?limit=50&expand[]=data.application_fee', {
      headers: { 'Authorization': `Bearer ${stripeKey}`, 'Stripe-Account': company.stripe_account_id }
    })
    const data = await res.json() as any
    return c.json({ charges: data.data || [] })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// POST /api/stripe/payment-link — create Stripe Checkout session for invoice
app.post('/api/stripe/payment-link', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const stripeKey = (c.env as any).STRIPE_SECRET_KEY as string | undefined
  if (!stripeKey) return c.json({ error: 'Stripe not configured' }, 503)
  const company = await db.prepare(`SELECT stripe_account_id, stripe_onboarded, stripe_platform_fee_pct FROM companies WHERE id=?`).bind(companyId).first() as any
  if (!company?.stripe_account_id || !company.stripe_onboarded) return c.json({ error: 'Stripe not connected' }, 400)
  const body = await c.req.json() as any
  const { invoice_id, amount, client_email } = body
  if (!amount || amount < 50) return c.json({ error: 'Minimum amount is $0.50' }, 400)
  try {
    const origin = new URL(c.req.url).origin
    const feePct = company.stripe_platform_fee_pct || 2.9
    const applicationFeeAmount = Math.round(amount * feePct / 100)
    const form = new URLSearchParams({
      'payment_method_types[]': 'card',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': String(amount),
      'line_items[0][price_data][product_data][name]': `Invoice #${invoice_id || 'Groundwork'}`,
      'line_items[0][quantity]': '1',
      mode: 'payment',
      'success_url': `${origin}/api/invoices/portal/success?session_id={CHECKOUT_SESSION_ID}`,
      'cancel_url': `${origin}`,
      'payment_intent_data[application_fee_amount]': String(applicationFeeAmount),
      'payment_intent_data[metadata][invoice_id]': invoice_id || '',
      'payment_intent_data[metadata][company_id]': companyId,
    })
    if (client_email) form.set('customer_email', client_email)
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Account': company.stripe_account_id },
      body: form.toString()
    })
    const session = await res.json() as any
    if (!res.ok) throw new Error(session.error?.message || 'Checkout creation failed')
    return c.json({ url: session.url, session_id: session.id })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// POST /api/stripe/disconnect — unlink Stripe account
app.post('/api/stripe/disconnect', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await db.prepare(`UPDATE companies SET stripe_account_id='', stripe_onboarded=0, stripe_charges_enabled=0 WHERE id=?`).bind(companyId).run()
  return c.json({ ok: true })
})

// POST /api/stripe/webhook — Stripe platform webhook (no auth; verify signature)
app.post('/api/stripe/webhook', async (c) => {
  const stripeKey = (c.env as any).STRIPE_SECRET_KEY as string | undefined
  const webhookSecret = (c.env as any).STRIPE_WEBHOOK_SECRET as string | undefined
  const body = await c.req.text()
  const sig  = c.req.header('stripe-signature') || ''
  // Signature verification requires crypto — simplified check for edge
  // In production, use proper Stripe webhook verification library
  try {
    const event = JSON.parse(body)
    const db = c.env.DB as D1Database
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object
      const invoiceId  = session.metadata?.invoice_id
      const companyId  = session.metadata?.company_id
      const amountPaid = session.amount_total
      if (invoiceId && companyId && amountPaid) {
        // Record payment against invoice
        const inv = await db.prepare(`SELECT * FROM invoices WHERE id=? AND company_id=?`).bind(invoiceId, companyId).first() as any
        if (inv) {
          const newPaid = (inv.amount_paid || 0) + amountPaid / 100
          const newStatus = newPaid >= (inv.amount_total || inv.amount) ? 'paid' : 'partial'
          await db.prepare(`UPDATE invoices SET amount_paid=?, status=? WHERE id=? AND company_id=?`)
            .bind(newPaid, newStatus, invoiceId, companyId).run()
          // Log to payments table
          const pymtId = `py_${Date.now()}`
          await db.prepare(`INSERT OR IGNORE INTO payments (id, company_id, invoice_id, amount, method, stripe_payment_intent_id, status, paid_at)
            VALUES (?,?,?,?,?,?,'completed',?)`).bind(pymtId, companyId, invoiceId, amountPaid/100, 'card',
            session.payment_intent || '', new Date().toISOString()).run()
        }
      }
    }
    if (event.type === 'account.updated') {
      const acct = event.data.object
      if (acct.charges_enabled) {
        await db.prepare(`UPDATE companies SET stripe_charges_enabled=1, stripe_onboarded=1 WHERE stripe_account_id=?`).bind(acct.id).run()
      }
    }
    return c.json({ received: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 400)
  }
})

// ── WORK ORDERS (D1) ──────────────────────────────────────────────────────────

// GET /api/work-orders — list work orders (optional ?status=&crew_id=&rep_id=&date_from=&date_to=)
// rep_id filter: returns WOs where assigned_rep_id matches OR crew contains the rep (for field-role scoping)
app.get('/api/work-orders', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const status    = c.req.query('status')
  const crewId    = c.req.query('crew_id')
  const repId     = c.req.query('rep_id')
  const clientId  = c.req.query('client_id')
  const dateFrom  = c.req.query('date_from')
  const dateTo    = c.req.query('date_to')
  const limitParam = c.req.query('limit')
  const limitVal   = limitParam ? parseInt(limitParam) : 500
  let sql = `SELECT wo.*, cr.name as crew_name, cr.color as crew_color
             FROM work_orders wo
             LEFT JOIN crews cr ON cr.id = wo.crew_id
             WHERE wo.company_id = ?`
  const params: any[] = [companyId]
  if (status)   { sql += ` AND wo.status = ?`;          params.push(status) }
  if (crewId)   { sql += ` AND wo.crew_id = ?`;         params.push(crewId) }
  if (clientId) { sql += ` AND wo.client_id = ?`;       params.push(clientId) }
  if (dateFrom) { sql += ` AND wo.scheduled_date >= ?`; params.push(dateFrom) }
  if (dateTo)   { sql += ` AND wo.scheduled_date <= ?`; params.push(dateTo) }
  // rep_id filter: WOs assigned to this rep OR belonging to a crew the rep is in
  if (repId) {
    sql += ` AND (wo.assigned_rep_id = ? OR wo.crew_id IN (
      SELECT cm.crew_id FROM crew_members cm WHERE cm.rep_id = ? AND cm.company_id = ?
    ))`
    params.push(repId, repId, companyId)
  }
  sql += ` ORDER BY wo.scheduled_date DESC, wo.created_at DESC LIMIT ${limitVal}`
  const rows = await db.prepare(sql).bind(...params).all()
  // Parse JSON fields
  const data = (rows.results || []).map((r: any) => ({
    ...r,
    checklist:    JSON.parse(r.checklist    || '[]'),
    materials:    JSON.parse(r.materials    || '[]'),
    equipment:    JSON.parse(r.equipment    || '[]'),
    timeline:     JSON.parse(r.timeline     || '[]'),
    before_photos: JSON.parse(r.before_photos || '[]'),
    after_photos:  JSON.parse(r.after_photos  || '[]'),
  }))
  return c.json({ ok: true, data })
})

// POST /api/work-orders — create a work order
app.post('/api/work-orders', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId as string
  const db = c.env.DB as D1Database
  const body: any = await c.req.json()
  const id = 'wo-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
  // Auto-number
  const countRow = await db.prepare(`SELECT COUNT(*) as cnt FROM work_orders WHERE company_id=?`).bind(companyId).first() as any
  const woNum = 'WO-' + String((countRow?.cnt || 0) + 1).padStart(5, '0')
  await db.prepare(`
    INSERT INTO work_orders
      (id, company_id, wo_number, opp_id, crew_id, client_name, client_id, property_addr, title,
       type, status, readiness, scheduled_date, scheduled_time, scheduled_end_time, duration_hours, notes,
       amount_est, checklist, materials, equipment, timeline, before_photos, after_photos, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    id, companyId, woNum,
    body.opp_id || null, body.crew_id || null,
    body.client_name || '', body.client_id || null, body.property_addr || '',
    body.title || '', body.type || 'Service',
    body.status || 'scheduled', body.readiness || 'ready',
    body.scheduled_date || null, body.scheduled_time || null,
    body.scheduled_end_time || null,
    body.duration_hours || null, body.notes || '',
    body.amount_est || 0,
    JSON.stringify(body.checklist || []),
    JSON.stringify(body.materials || []),
    JSON.stringify(body.equipment || []),
    JSON.stringify([{ action: 'Work Order Created', note: `by ${repId}`, at: new Date().toISOString() }]),
    JSON.stringify(body.before_photos || []),
    JSON.stringify(body.after_photos || []),
    repId
  ).run()
  // Add employees if provided
  const employees: string[] = body.employee_ids || []
  for (const eId of employees) {
    const eid = 'woe-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
    await db.prepare(`INSERT OR IGNORE INTO work_order_employees (id, wo_id, rep_id, company_id) VALUES (?,?,?,?)`)
      .bind(eid, id, eId, companyId).run()
  }
  return c.json({ ok: true, id, wo_number: woNum })
})

// GET /api/work-orders/:id — single work order
app.get('/api/work-orders/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const woId = c.req.param('id')
  const row: any = await db.prepare(
    `SELECT wo.*, cr.name as crew_name, cr.color as crew_color
     FROM work_orders wo LEFT JOIN crews cr ON cr.id = wo.crew_id
     WHERE wo.id=? AND wo.company_id=?`
  ).bind(woId, companyId).first()
  if (!row) return c.json({ ok: false, error: 'Not found' }, 404)
  // Get assigned employees
  const emps = await db.prepare(
    `SELECT woe.rep_id, r.name, r.role FROM work_order_employees woe
     JOIN reps r ON r.id = woe.rep_id WHERE woe.wo_id=?`
  ).bind(woId).all()
  return c.json({ ok: true, data: {
    ...row,
    checklist:     JSON.parse(row.checklist     || '[]'),
    materials:     JSON.parse(row.materials     || '[]'),
    equipment:     JSON.parse(row.equipment     || '[]'),
    timeline:      JSON.parse(row.timeline      || '[]'),
    before_photos: JSON.parse(row.before_photos || '[]'),
    after_photos:  JSON.parse(row.after_photos  || '[]'),
    attachments:   JSON.parse(row.attachments   || '[]'),
    employees:     emps.results || [],
  }})
})

// PUT /api/work-orders/:id — update work order
app.put('/api/work-orders/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId as string
  const db = c.env.DB as D1Database
  const woId = c.req.param('id')
  const body: any = await c.req.json()
  // Get current WO for timeline diff
  const cur: any = await db.prepare(`SELECT status, timeline FROM work_orders WHERE id=? AND company_id=?`).bind(woId, companyId).first()
  if (!cur) return c.json({ ok: false, error: 'Not found' }, 404)
  let tl = JSON.parse(cur.timeline || '[]')
  if (body.status && body.status !== cur.status) {
    tl.push({ action: `Status → ${body.status}`, note: `by ${repId}`, at: new Date().toISOString() })
  }
  await db.prepare(`
    UPDATE work_orders SET
      crew_id=COALESCE(?,crew_id), client_name=COALESCE(?,client_name),
      property_addr=COALESCE(?,property_addr), title=COALESCE(?,title),
      type=COALESCE(?,type), status=COALESCE(?,status), readiness=COALESCE(?,readiness),
      scheduled_date=COALESCE(?,scheduled_date), scheduled_time=COALESCE(?,scheduled_time),
      scheduled_end_time=COALESCE(?,scheduled_end_time),
      duration_hours=COALESCE(?,duration_hours), notes=COALESCE(?,notes),
      completion_notes=COALESCE(?,completion_notes),
      amount_est=COALESCE(?,amount_est), amount_actual=COALESCE(?,amount_actual),
      checklist=COALESCE(?,checklist), materials=COALESCE(?,materials),
      equipment=COALESCE(?,equipment),
      before_photos=COALESCE(?,before_photos), after_photos=COALESCE(?,after_photos),
      attachments=COALESCE(?,attachments),
      timeline=?, updated_at=datetime('now')
    WHERE id=? AND company_id=?
  `).bind(
    body.crew_id !== undefined ? body.crew_id : null,
    body.client_name !== undefined ? body.client_name : null,
    body.property_addr !== undefined ? body.property_addr : null,
    body.title !== undefined ? body.title : null,
    body.type !== undefined ? body.type : null,
    body.status !== undefined ? body.status : null,
    body.readiness !== undefined ? body.readiness : null,
    body.scheduled_date !== undefined ? body.scheduled_date : null,
    body.scheduled_time !== undefined ? body.scheduled_time : null,
    body.scheduled_end_time !== undefined ? body.scheduled_end_time : null,
    body.duration_hours !== undefined ? body.duration_hours : null,
    body.notes !== undefined ? body.notes : null,
    body.completion_notes !== undefined ? body.completion_notes : null,
    body.amount_est !== undefined ? body.amount_est : null,
    body.amount_actual !== undefined ? body.amount_actual : null,
    body.checklist !== undefined ? JSON.stringify(body.checklist) : null,
    body.materials !== undefined ? JSON.stringify(body.materials) : null,
    body.equipment !== undefined ? JSON.stringify(body.equipment) : null,
    body.before_photos !== undefined ? JSON.stringify(body.before_photos) : null,
    body.after_photos  !== undefined ? JSON.stringify(body.after_photos)  : null,
    body.attachments   !== undefined ? JSON.stringify(body.attachments)   : null,
    JSON.stringify(tl),
    woId, companyId
  ).run()
  // Update employee list if provided
  if (body.employee_ids !== undefined) {
    await db.prepare(`DELETE FROM work_order_employees WHERE wo_id=? AND company_id=?`).bind(woId, companyId).run()
    for (const eId of (body.employee_ids as string[])) {
      const eid = 'woe-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
      await db.prepare(`INSERT OR IGNORE INTO work_order_employees (id, wo_id, rep_id, company_id) VALUES (?,?,?,?)`)
        .bind(eid, woId, eId, companyId).run()
    }
  }
  return c.json({ ok: true })
})

// DELETE /api/work-orders/:id
app.delete('/api/work-orders/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const woId = c.req.param('id')
  await db.prepare(`DELETE FROM work_orders WHERE id=? AND company_id=?`).bind(woId, companyId).run()
  return c.json({ ok: true })
})

// POST /api/work-orders/:id/duplicate — clone a work order to a new date
app.post('/api/work-orders/:id/duplicate', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId as string
  const db = c.env.DB as D1Database
  const woId = c.req.param('id')
  const body: any = await c.req.json().catch(() => ({}))
  const src: any = await db.prepare(
    `SELECT * FROM work_orders WHERE id=? AND company_id=?`
  ).bind(woId, companyId).first()
  if (!src) return c.json({ ok: false, error: 'Not found' }, 404)
  const newId = 'wo-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
  const countRow: any = await db.prepare(`SELECT COUNT(*) as cnt FROM work_orders WHERE company_id=?`).bind(companyId).first()
  const woNum = 'WO-' + String((countRow?.cnt || 0) + 1).padStart(5, '0')
  const newDate = body.scheduled_date || src.scheduled_date
  await db.prepare(`
    INSERT INTO work_orders
      (id, company_id, wo_number, opp_id, crew_id, client_name, client_id, property_addr, title,
       type, status, readiness, scheduled_date, scheduled_time, scheduled_end_time, duration_hours, notes,
       amount_est, checklist, materials, equipment, timeline, before_photos, after_photos, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    newId, companyId, woNum,
    src.opp_id, src.crew_id, src.client_name, src.client_id, src.property_addr,
    src.title, src.type, 'scheduled', 'ready',
    newDate, src.scheduled_time, src.scheduled_end_time, src.duration_hours, src.notes,
    src.amount_est,
    src.checklist, src.materials, src.equipment || '[]',
    JSON.stringify([{ action: 'Duplicated from ' + src.wo_number, note: `by ${repId}`, at: new Date().toISOString() }]),
    '[]', '[]', repId
  ).run()
  // Duplicate employee assignments
  const emps = await db.prepare(`SELECT rep_id FROM work_order_employees WHERE wo_id=?`).bind(woId).all()
  for (const e of (emps.results || [])) {
    const eid = 'woe-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
    await db.prepare(`INSERT OR IGNORE INTO work_order_employees (id, wo_id, rep_id, company_id) VALUES (?,?,?,?)`)
      .bind(eid, newId, (e as any).rep_id, companyId).run()
  }
  return c.json({ ok: true, id: newId, wo_number: woNum })
})

// PATCH /api/work-orders/:id/reschedule — quick date/time update (drag-drop)
app.patch('/api/work-orders/:id/reschedule', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const woId = c.req.param('id')
  const body: any = await c.req.json()
  await db.prepare(`
    UPDATE work_orders SET
      scheduled_date=COALESCE(?,scheduled_date),
      scheduled_time=COALESCE(?,scheduled_time),
      scheduled_end_time=COALESCE(?,scheduled_end_time),
      updated_at=datetime('now')
    WHERE id=? AND company_id=?
  `).bind(
    body.scheduled_date || null,
    body.scheduled_time || null,
    body.scheduled_end_time || null,
    woId, companyId
  ).run()
  return c.json({ ok: true })
})

// GET /api/my-schedule — jobs assigned to the current rep today
app.get('/api/my-schedule', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId as string
  const db = c.env.DB as D1Database
  const date = c.req.query('date') || new Date().toISOString().slice(0, 10)
  const rows = await db.prepare(`
    SELECT wo.*, cr.name as crew_name, cr.color as crew_color
    FROM work_orders wo
    JOIN work_order_employees woe ON woe.wo_id = wo.id AND woe.rep_id = ?
    LEFT JOIN crews cr ON cr.id = wo.crew_id
    WHERE wo.company_id = ? AND wo.scheduled_date = ? AND wo.status != 'cancelled'
    ORDER BY wo.scheduled_time ASC
  `).bind(repId, companyId, date).all()
  const data = (rows.results || []).map((r: any) => ({
    ...r,
    checklist:  JSON.parse(r.checklist  || '[]'),
    materials:  JSON.parse(r.materials  || '[]'),
    equipment:  JSON.parse(r.equipment  || '[]'),
    timeline:   JSON.parse(r.timeline   || '[]'),
  }))
  return c.json({ ok: true, data })
})

// ══════════════════════════════════════════════════════════════════════════════
// Rolling structured event log.  Each event is a JSON row persisted to D1.
// The frontend gwAudit() also keeps a local localStorage ring-buffer (max 500)
// for offline reads; this endpoint backs the permanent record.
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/audit  — ingest one or more audit events from the frontend
app.post('/api/audit', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId     as string
  let body: unknown
  try { body = await c.req.json() } catch { return json(c, { error: 'bad json' }, 400) }
  const events = Array.isArray(body) ? body : [body]
  const now    = new Date().toISOString()

  // Ensure audit_log table exists (idempotent — runs on first use)
  await c.env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id          TEXT PRIMARY KEY,
      company_id  TEXT NOT NULL,
      rep_id      TEXT,
      event_type  TEXT NOT NULL,
      entity_type TEXT,
      entity_id   TEXT,
      entity_label TEXT,
      meta        TEXT,
      created_at  TEXT NOT NULL
    )
  `).run()

  const stmt = c.env.DB.prepare(
    `INSERT OR IGNORE INTO audit_log
       (id, company_id, rep_id, event_type, entity_type, entity_id, entity_label, meta, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  )
  const batch = events.slice(0, 50).map((e: any) =>
    stmt.bind(
      e.id || (crypto.randomUUID ? crypto.randomUUID() : `al_${Date.now()}_${Math.random().toString(36).slice(2)}`),
      companyId,
      e.repId || repId || null,
      e.type  || 'unknown',
      e.entityType  || null,
      e.entityId    || null,
      e.entityLabel || null,
      e.meta ? JSON.stringify(e.meta) : null,
      e.at   || now
    )
  )
  if (batch.length) await c.env.DB.batch(batch)
  return json(c, { written: batch.length })
})

// GET /api/audit  — query audit events for current company (admin/office_manager only)
app.get('/api/audit', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const limit     = Math.min(parseInt(c.req.query('limit') || '200', 10), 500)
  const offset    = parseInt(c.req.query('offset') || '0', 10)
  const eventType = c.req.query('type')   || null
  const entityType= c.req.query('entity') || null
  const repId     = c.req.query('rep')    || null

  // Ensure table exists before querying
  await c.env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, rep_id TEXT,
      event_type TEXT NOT NULL, entity_type TEXT, entity_id TEXT,
      entity_label TEXT, meta TEXT, created_at TEXT NOT NULL
    )
  `).run()

  let sql = `SELECT * FROM audit_log WHERE company_id = ?`
  const binds: (string | number)[] = [companyId]
  if (eventType)  { sql += ` AND event_type  = ?`; binds.push(eventType) }
  if (entityType) { sql += ` AND entity_type = ?`; binds.push(entityType) }
  if (repId)      { sql += ` AND rep_id      = ?`; binds.push(repId) }
  sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`
  binds.push(limit, offset)

  const rows = await (c.env.DB.prepare(sql) as any).bind(...binds).all()
  return json(c, { events: rows.results || [], limit, offset })
})

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 8 — CLIENT PORTAL  (/portal)
// Token-based external portal for clients.  The Hono route serves a thin HTML
// shell; the heavy portal UI is rendered client-side by client_portal.js which
// detects the ?token= param via _gwCheckPortalRoute().
// ══════════════════════════════════════════════════════════════════════════════

app.get('/portal', (c) => {
  const token = c.req.query('token') || ''
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Groundwork — Client Portal</title>
  <meta name="robots" content="noindex,nofollow"/>
  <link rel="icon" type="image/png" href="/js/avalon-logo.png"/>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/js/premium.css?v=20260713b009">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0F1F1E; color: #E8EDE8; font-family: 'Inter', sans-serif; min-height: 100vh; }
    #portal-loading {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      min-height: 100vh; gap: 16px; color: rgba(255,255,255,.5); font-size: 13px;
    }
    .portal-spinner {
      width: 32px; height: 32px; border: 2.5px solid rgba(255,255,255,.15);
      border-top-color: #4D8A86; border-radius: 50%;
      animation: spin .8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div id="portal-loading">
    <div class="portal-spinner"></div>
    Loading your portal…
  </div>
  <div id="portal-root"></div>

  <script>window.__PORTAL_TOKEN__ = ${JSON.stringify(token)};</script>
  <script src="/js/platform_core.js?v=20260713b009"></script>
  <script src="/js/client_portal.js?v=20260713b009"></script>
  <script>
    // Hide spinner once portal renders, or show error if no token
    document.addEventListener('DOMContentLoaded', function() {
      if (!window.__PORTAL_TOKEN__) {
        document.getElementById('portal-loading').innerHTML =
          '<div style="text-align:center;padding:40px 24px">' +
          '<div style="font-size:16px;font-weight:700;margin-bottom:8px;color:#E8EDE8">Invalid Portal Link</div>' +
          '<div style="color:rgba(255,255,255,.5);font-size:13px">This link is missing a token. Please use the link provided by your service company.</div>' +
          '</div>';
        return;
      }
      // client_portal.js _gwCheckPortalRoute() handles rendering
      if (typeof window._gwCheckPortalRoute === 'function') {
        window._gwCheckPortalRoute();
      }
    });
  </script>
</body>
</html>`)
})

// GET /api/portal/verify  — validate a portal token (called by the portal shell)
app.get('/api/portal/verify', async (c) => {
  const token     = c.req.query('token') || ''
  const companyId = c.req.query('company') || ''
  if (!token) return json(c, { valid: false, error: 'no_token' }, 400)

  // Portal access records are stored in localStorage on the frontend (client_portal.js)
  // This endpoint provides a server-side validation hook for future D1 persistence.
  // For now it always returns valid:true so the client-side token check remains authoritative.
  // A future migration can add a portal_access table here.
  return json(c, { valid: true, token, company: companyId })
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

// ── /signup — Public trial signup page ────────────────────────────────────
app.get('/signup', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Start Free Trial — Groundwork CRM</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',sans-serif;background:linear-gradient(135deg,#0d2318 0%,#1a3a2a 50%,#0d2318 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .card{background:#fff;border-radius:20px;padding:40px;width:100%;max-width:440px;box-shadow:0 24px 80px rgba(0,0,0,0.4)}
    .logo{display:flex;align-items:center;gap:10px;margin-bottom:28px}
    .logo-mark{width:36px;height:36px;background:#2D7A55;border-radius:8px;display:flex;align-items:center;justify-content:center}
    .logo-mark svg{width:20px;height:20px;fill:#fff}
    .logo-name{font-size:18px;font-weight:800;color:#0d2318;letter-spacing:-.02em}
    .logo-name span{color:#2D7A55}
    h1{font-size:26px;font-weight:800;color:#0d2318;line-height:1.2;margin-bottom:6px}
    .sub{font-size:14px;color:#6B7280;margin-bottom:28px}
    .field{margin-bottom:16px}
    label{display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:5px;text-transform:uppercase;letter-spacing:.06em}
    input,select{width:100%;padding:11px 14px;border:1.5px solid #E5E7EB;border-radius:10px;font-size:14px;font-family:inherit;color:#111;transition:border .15s;outline:none}
    input:focus,select:focus{border-color:#2D7A55;box-shadow:0 0 0 3px rgba(45,122,85,.12)}
    .row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .btn{width:100%;padding:14px;background:#2D7A55;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;margin-top:8px;transition:background .15s;font-family:inherit}
    .btn:hover{background:#256645}
    .btn:disabled{opacity:.5;cursor:default}
    .trial-badge{background:#F0FAF4;border:1px solid #A7D7BC;border-radius:8px;padding:10px 14px;font-size:13px;color:#1C3A2B;margin-bottom:20px;display:flex;align-items:center;gap:8px}
    .check{color:#2D7A55;font-weight:700}
    .signin-link{text-align:center;font-size:13px;color:#6B7280;margin-top:18px}
    .signin-link a{color:#2D7A55;font-weight:600;text-decoration:none}
    .error{background:#FEF2F2;border:1px solid #FCA5A5;border-radius:8px;padding:10px 14px;font-size:13px;color:#991B1B;margin-bottom:16px;display:none}
    .spinner{display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite;vertical-align:middle;margin-right:6px}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <div class="logo-mark">
        <svg viewBox="0 0 20 20"><path d="M10 2L3 7v11h5v-5h4v5h5V7L10 2z"/></svg>
      </div>
      <div class="logo-name">Ground<span>work</span></div>
    </div>

    <h1>Start your free trial</h1>
    <p class="sub">14 days free. No credit card required.</p>

    <div class="trial-badge">
      <span class="check">✓</span>
      Full access to all features for 14 days — no limits, no credit card
    </div>

    <div id="errorMsg" class="error"></div>

    <form id="signupForm">
      <div class="field">
        <label>Company Name</label>
        <input type="text" id="companyName" placeholder="Avalon Landscaping" required autocomplete="organization">
      </div>
      <div class="field">
        <label>Business Type</label>
        <select id="businessType">
          <option value="landscaping">Landscaping & Lawn Care</option>
          <option value="excavation">Excavation & Grading</option>
          <option value="hvac">HVAC</option>
          <option value="plumbing">Plumbing</option>
          <option value="electrical">Electrical</option>
          <option value="painting">Painting</option>
          <option value="roofing">Roofing</option>
          <option value="cleaning">Cleaning Services</option>
          <option value="pest_control">Pest Control</option>
          <option value="tree_service">Tree Service</option>
          <option value="fencing">Fencing</option>
          <option value="flooring">Flooring</option>
          <option value="concrete">Concrete & Masonry</option>
          <option value="pool_service">Pool Service</option>
          <option value="home_services" selected>General Home Services</option>
        </select>
      </div>
      <div class="row2">
        <div class="field">
          <label>Your Name</label>
          <input type="text" id="ownerName" placeholder="Tyler Smith" required autocomplete="name">
        </div>
        <div class="field">
          <label>Work Email</label>
          <input type="email" id="email" placeholder="tyler@company.com" required autocomplete="email">
        </div>
      </div>
      <div class="field">
        <label>Password</label>
        <input type="password" id="password" placeholder="8+ characters" required minlength="8" autocomplete="new-password">
      </div>
      <button type="submit" class="btn" id="submitBtn">Create Free Account</button>
    </form>

    <div class="signin-link">
      Already have an account? <a href="/">Sign in</a>
    </div>
  </div>

  <script>
    document.getElementById('signupForm').addEventListener('submit', async function(e) {
      e.preventDefault();
      const btn = document.getElementById('submitBtn');
      const err = document.getElementById('errorMsg');
      err.style.display = 'none';
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>Creating account…';

      try {
        const res = await fetch('/api/auth/signup', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          credentials: 'include',
          body: JSON.stringify({
            company_name: document.getElementById('companyName').value.trim(),
            email: document.getElementById('email').value.trim(),
            password: document.getElementById('password').value,
            owner_name: document.getElementById('ownerName').value.trim(),
            business_type: document.getElementById('businessType').value
          })
        });
        const data = await res.json();
        if (!res.ok) {
          err.textContent = data.error || 'Signup failed. Please try again.';
          err.style.display = 'block';
          btn.disabled = false;
          btn.innerHTML = 'Create Free Account';
          return;
        }
        // Success — redirect to app (session cookie is set)
        btn.innerHTML = '✓ Account created! Redirecting…';
        window.location.href = '/';
      } catch(e) {
        err.textContent = 'Network error. Please try again.';
        err.style.display = 'block';
        btn.disabled = false;
        btn.innerHTML = 'Create Free Account';
      }
    });
  </script>
</body>
</html>`)
})

// ── /recover — Standalone lead-recovery page ──────────────────────────────
// Tyler can share this URL with Jen: https://groundwork-crm.com/recover
// Jen opens it on her device → her localStorage leads are pushed to D1
app.get('/recover', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lead Recovery — Groundwork CRM</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F5F6F3;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
    .card{background:#fff;border-radius:16px;padding:36px;max-width:480px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.08)}
    .logo{font-size:22px;font-weight:700;color:#113931;margin-bottom:24px;display:flex;align-items:center;gap:10px}
    .logo svg{flex-shrink:0}
    h1{font-size:20px;font-weight:700;color:#1C3829;margin-bottom:8px}
    p{font-size:14px;color:#5C6B58;line-height:1.6;margin-bottom:20px}
    #status{background:#F0F4F0;border-radius:10px;padding:14px;font-size:14px;color:#1C3829;margin-bottom:20px;min-height:52px;display:none}
    #status.show{display:block}
    #status.success{background:#E8F5EF;color:#1C6B40;border:1px solid #A8D9BF}
    #status.error{background:#FDECEA;color:#8B2020;border:1px solid #F5AAAA}
    #status.info{background:#E8F0F8;color:#1C3A6B;border:1px solid #A8C5F0}
    button{width:100%;background:#4D8A86;color:#fff;border:none;border-radius:10px;padding:14px;font-size:15px;font-weight:600;cursor:pointer;transition:opacity .15s}
    button:hover{opacity:.88}
    button:disabled{opacity:.5;cursor:not-allowed}
    .step{display:flex;gap:10px;font-size:13px;color:#5C6B58;padding:8px 0;border-bottom:1px solid #F0F0EE}
    .step:last-child{border-bottom:none}
    .step-num{width:22px;height:22px;background:#4D8A86;color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;margin-top:1px}
    .steps{background:#F8F9F7;border-radius:10px;padding:12px 14px;margin-bottom:20px}
    .note{font-size:12px;color:#8A9680;text-align:center;margin-top:16px}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none"><rect width="28" height="28" rx="7" fill="#113931"/><path d="M6 20V10l8-5 8 5v10H17v-5h-6v5H6z" fill="#7DB98A"/></svg>
      Groundwork CRM
    </div>
    <h1>Lead Recovery</h1>
    <p>This page pushes any leads saved on this device to the cloud so your teammates can see them. Safe to run anytime — it won't create duplicates.</p>

    <div class="steps">
      <div class="step"><div class="step-num">1</div><div>Reads all leads saved on this device (browser storage)</div></div>
      <div class="step"><div class="step-num">2</div><div>Sends any that aren't already in the cloud to the server</div></div>
      <div class="step"><div class="step-num">3</div><div>Shows you how many were recovered</div></div>
    </div>

    <div id="status"></div>
    <button id="recoverBtn" onclick="recover()">↑ Recover My Leads Now</button>
    <div class="note">You must be signed in to Groundwork CRM for this to work.<br>After recovery, <a href="/" style="color:#4D8A86">return to the app</a> and sync.</div>
  </div>

  <script>
  async function recover() {
    const btn = document.getElementById('recoverBtn');
    const status = document.getElementById('status');

    function setStatus(msg, type) {
      status.textContent = msg;
      status.className = 'show ' + (type || 'info');
    }

    btn.disabled = true;
    btn.textContent = '⏳ Scanning local storage…';
    setStatus('Reading leads from this device…', 'info');

    try {
      // Read localStorage
      const rawState = JSON.parse(localStorage.getItem('avalonSalesHubStateV3') || '{}');
      const allOpps = rawState.opportunities || [];
      const localOnly = allOpps.filter(o => !o._fromD1);

      if (allOpps.length === 0) {
        setStatus('No leads found in local storage on this device. If your leads are on a different device, open this page there.', 'info');
        btn.textContent = '↑ Recover My Leads Now';
        btn.disabled = false;
        return;
      }

      if (localOnly.length === 0) {
        setStatus('✅ All ' + allOpps.length + ' lead' + (allOpps.length !== 1 ? 's are' : ' is') + ' already synced to the cloud. Nothing to recover!', 'success');
        btn.textContent = '↑ Recover My Leads Now';
        btn.disabled = false;
        return;
      }

      btn.textContent = '⏳ Syncing ' + localOnly.length + ' lead' + (localOnly.length !== 1 ? 's' : '') + '…';
      setStatus('Sending ' + localOnly.length + ' local lead' + (localOnly.length !== 1 ? 's' : '') + ' to the cloud…', 'info');

      // Call bulk-upsert endpoint
      const res = await fetch('/api/opportunities/bulk-upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ opps: localOnly })
      });

      if (!res.ok) {
        const errText = await res.text();
        if (res.status === 401) {
          setStatus('❌ You are not signed in. Please sign in to Groundwork CRM first, then come back to this page.', 'error');
        } else {
          setStatus('❌ Server error (' + res.status + '): ' + errText.slice(0, 200), 'error');
        }
        btn.textContent = '↑ Try Again';
        btn.disabled = false;
        return;
      }

      const result = await res.json();
      const inserted = result.data?.inserted ?? result.inserted ?? 0;
      const skipped  = result.data?.skipped  ?? result.skipped  ?? 0;

      // Mark recovered leads as synced in localStorage
      if (inserted > 0 && rawState.opportunities) {
        const recoveredIds = new Set(localOnly.map(o => o.id));
        rawState.opportunities = rawState.opportunities.map(o =>
          recoveredIds.has(o.id) ? { ...o, _fromD1: true } : o
        );
        localStorage.setItem('avalonSalesHubStateV3', JSON.stringify(rawState));
      }

      if (inserted > 0) {
        setStatus('✅ Success! ' + inserted + ' lead' + (inserted !== 1 ? 's' : '') + ' recovered to the cloud.' +
          (skipped > 0 ? ' (' + skipped + ' already existed, skipped)' : '') +
          ' Return to the app and hit ⟳ to see them.', 'success');
        btn.textContent = '✅ Recovery Complete — Return to App';
        btn.onclick = function(){ window.location.href = '/'; };
      } else if (skipped > 0) {
        setStatus('✅ All ' + skipped + ' lead' + (skipped !== 1 ? 's were' : ' was') + ' already in the cloud. Nothing new to sync!', 'success');
        btn.textContent = '↑ Recover My Leads Now';
        btn.disabled = false;
      } else {
        setStatus('Nothing was synced. The server returned 0 inserted and 0 skipped. Try signing in to the app again then return here.', 'info');
        btn.textContent = '↑ Try Again';
        btn.disabled = false;
      }

    } catch (err) {
      setStatus('❌ Unexpected error: ' + err.message, 'error');
      btn.textContent = '↑ Try Again';
      btn.disabled = false;
    }
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
  <link rel="icon" type="image/png" sizes="32x32" href="/js/favicon-32.png" />
  <link rel="icon" type="image/png" sizes="16x16" href="/js/favicon-16.png" />
  <link rel="icon" type="image/x-icon" href="/js/favicon.ico" />
  <link rel="apple-touch-icon" href="/js/apple-touch-icon.png" />
  <link rel="manifest" href="/site.webmanifest" />
  <meta name="theme-color" content="#113931" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="Groundwork" />
  <meta name="description" content="Field sales CRM built for home services teams." />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/js/premium.css?v=20260713b009">
  <link rel="stylesheet" href="/js/styles.css?v=20260713b009">
  <link rel="stylesheet" href="/js/groundwork-design.css?v=20260713b009">
  <style>
    /* ── Nav baseline ───────────────────────────────────────────────────────── */
    .nav-item svg { vertical-align: middle; flex-shrink: 0; }

    /* ── Section divider labels inside a group ──────────────────────────────── */
    .nav-subgroup { margin-top: 2px; }
    .nav-subgroup-label {
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .11em;
      color: rgba(255,255,255,.22);
      padding: 10px 16px 2px 16px;
      pointer-events: none;
      user-select: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* ── Sub-items (indented under a section label) ─────────────────────────── */
    .nav-item--sub {
      padding-left: 24px !important;
      font-size: 12.5px !important;
    }

    /* ── Sidebar close button (mobile only, injected by JS) ─────────────────── */
    .sidebar-close-btn {
      display: none;
    }
    /* Desktop: show the collapse chevron inside the brand row */
    @media (min-width: 769px) {
      .sidebar-close-btn {
        display: flex !important;
        align-items: center;
        justify-content: center;
        background: none;
        border: none;
        cursor: pointer;
        color: rgba(255,255,255,.35);
        padding: 6px;
        border-radius: 8px;
        flex-shrink: 0;
        transition: color .15s, background .15s;
        margin-left: auto;
      }
      .sidebar-close-btn:hover { color: #fff; background: rgba(255,255,255,.08); }
    }

    /* ══════════════════════════════════════════════════════════════════════════
       MOBILE OVERRIDES  @media (max-width: 768px)
       All mobile sidebar and layout adjustments are here, not in premium.css.
    ══════════════════════════════════════════════════════════════════════════ */
    @media (max-width: 768px) {

      /* ── Sidebar: overlay panel, full-height, slide in from left ─────────── */
      .sidebar {
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        height: 100dvh !important;
        width: 280px !important;
        max-width: 85vw !important;
        transform: translateX(-100%) !important;
        transition: transform 0.22s ease !important;
        z-index: 200 !important;
        overflow-y: auto !important;
        -webkit-overflow-scrolling: touch;
      }
      .sidebar.open {
        transform: translateX(0) !important;
        box-shadow: 4px 0 32px rgba(0,0,0,.45) !important;
      }

      /* Scrim: keep z-index paired with the sidebar overlay (z-index:200 above).
         Visibility is still JS-controlled via .visible class — we only bump
         the stacking context so it sits between main content and the sidebar. */
      .sidebar-scrim.visible {
        z-index: 199 !important;
      }

      /* ── Main area: full width on mobile ─────────────────────────────────── */
      .main {
        margin-left: 0 !important;
        width: 100% !important;
      }

      /* ── Topbar adjustments ───────────────────────────────────────────────── */
      .topbar {
        padding: 0 12px !important;
        gap: 8px !important;
      }
      .search-wrap {
        min-width: 0 !important;
        flex: 1 !important;
      }
      .search-wrap input {
        font-size: 13px !important;
        padding: 6px 10px !important;
      }
      /* Hide install button on mobile — low-priority action */
      .install-btn { display: none !important; }

      /* ── Brand header in sidebar ─────────────────────────────────────────── */
      .brand {
        padding: 14px 14px 10px !important;
      }
      .brand-name  { font-size: 15px !important; }
      .brand-subtitle { font-size: 10px !important; }

      /* ── Nav group summaries (top-level section headers) ─────────────────── */
      .nav-summary {
        font-size: 10px !important;
        padding: 9px 14px !important;
        letter-spacing: .07em !important;
      }

      /* ── Nav items: tighter rows ─────────────────────────────────────────── */
      .nav-item {
        font-size: 13px !important;
        padding: 7px 14px !important;
        gap: 8px !important;
      }
      .nav-item svg {
        width: 13px !important;
        height: 13px !important;
      }

      /* ── Sub-items: slightly more indented, same reduced size ────────────── */
      .nav-item--sub {
        padding-left: 22px !important;
        font-size: 12px !important;
      }

      /* ── Section divider labels ──────────────────────────────────────────── */
      .nav-subgroup-label {
        font-size: 8.5px !important;
        padding: 8px 14px 2px 14px !important;
      }

      /* ── Collapse secondary groups by default on mobile ─────────────────── */
      /* Sales Resources and Engagement are depth-2 — hide until parent opens */
      details.nav-group.nav-group--secondary {
        /* marker class added in HTML below for resource-heavy groups */
      }

      /* ── Sidebar footer ──────────────────────────────────────────────────── */
      .sidebar-footer {
        padding: 10px 14px !important;
        gap: 8px !important;
      }
      #sidebarUserName { font-size: 12px !important; }
      #sidebarUserRole { font-size: 10px !important; }

      /* ── Close button on mobile — stays inside brand row ───────────────── */
      .sidebar-close-btn {
        display: flex !important;
        align-items: center;
        justify-content: center;
        background: none;
        border: none;
        cursor: pointer;
        color: rgba(255,255,255,.45);
        padding: 6px;
        border-radius: 8px;
        flex-shrink: 0;
      }
      .sidebar-close-btn:hover { color: #fff; background: rgba(255,255,255,.1); }

      /* ── Content area: tighter padding on mobile ─────────────────────────── */
      .view-wrap,
      #view > .rp-shell,
      #view > div {
        padding: 14px 12px !important;
      }

      /* ── Card grids: single column ───────────────────────────────────────── */
      .stat-grid,
      .ops-stat-grid,
      .gw-grid-3,
      .gw-grid-2 {
        grid-template-columns: 1fr !important;
        gap: 10px !important;
      }

      /* ── Record page shell: remove side margins ──────────────────────────── */
      .rp-shell {
        padding: 14px 12px !important;
      }
      .rp-cols {
        flex-direction: column !important;
        gap: 12px !important;
      }

      /* ── Tables: allow horizontal scroll rather than overflow ────────────── */
      .gw-table-wrap {
        overflow-x: auto !important;
        -webkit-overflow-scrolling: touch;
      }
      .gw-table {
        min-width: 520px !important;
      }

      /* ── Toolbars: wrap on small screens ─────────────────────────────────── */
      .gw-toolbar,
      .filter-row,
      .rp-actions {
        flex-wrap: wrap !important;
        gap: 6px !important;
      }
      .gw-toolbar button,
      .filter-row button {
        font-size: 12px !important;
        padding: 5px 10px !important;
      }

      /* ── Modals: full-width on mobile ────────────────────────────────────── */
      .gw-modal-card {
        width: 100% !important;
        max-width: 100% !important;
        margin: 0 !important;
        border-radius: 12px 12px 0 0 !important;
      }
      /* bottom-sheet feel for overlays */
      #exportModalOverlay,
      .modal-overlay {
        align-items: flex-end !important;
        padding: 0 !important;
      }

      /* ── Topbar new-dropdown: full width ────────────────────────────────── */
      .topbar-new-dropdown {
        right: 0 !important;
        left: auto !important;
        min-width: 200px !important;
      }

      /* ══════════════════════════════════════════════════════════════════════
         PAGE HEADER (rp-header) — definitive mobile stack fix
         Placed here (inline <style> after all <link> stylesheets) to ensure
         highest cascade order. Applies to every view using .rp-header pattern.
         ══════════════════════════════════════════════════════════════════════ */

      /* Force full-width block on the shell containers */
      .wo-list-shell,
      .disp-shell,
      .rp-shell {
        width: 100% !important;
        box-sizing: border-box !important;
        padding-left: 14px !important;
        padding-right: 14px !important;
        overflow-x: hidden !important;
      }

      /* Stack header: title row first, actions row below */
      .rp-header {
        display: flex !important;
        flex-direction: column !important;
        align-items: flex-start !important;
        gap: 8px !important;
        margin-bottom: 12px !important;
        width: 100% !important;
        box-sizing: border-box !important;
        /* Remove any inline padding from the <header style="..."> attribute */
        padding: 14px 0 0 !important;
      }

      /* Left side: full width, no truncation */
      .rp-header-left {
        width: 100% !important;
        min-width: 0 !important;
        flex-shrink: 0 !important;
      }

      /* Title: reduce size, allow wrapping */
      .rp-title {
        font-size: 22px !important;
        font-weight: 800 !important;
        letter-spacing: -.3px !important;
        white-space: normal !important;
        overflow: visible !important;
        text-overflow: clip !important;
        line-height: 1.15 !important;
        width: 100% !important;
        display: block !important;
      }

      /* Subtitle: one flowing paragraph */
      .rp-subtitle {
        font-size: 12px !important;
        white-space: normal !important;
        line-height: 1.5 !important;
        margin-top: 3px !important;
        display: block !important;
      }

      /* Actions row: full-width, wrap, side by side */
      .rp-header-actions {
        display: flex !important;
        flex-direction: row !important;
        flex-wrap: wrap !important;
        align-items: center !important;
        gap: 6px !important;
        width: 100% !important;
        flex-shrink: 0 !important;
      }

      /* Each action button: auto-flex, don't overflow */
      .rp-header-actions > button,
      .rp-header-actions > .rp-btn,
      .rp-header-actions > .rp-btn--primary {
        flex: 1 1 auto !important;
        min-width: 0 !important;
        max-width: 100% !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        font-size: 12px !important;
        padding: 7px 10px !important;
        text-align: center !important;
        justify-content: center !important;
        box-sizing: border-box !important;
      }

      /* disp-shell inner content: remove excess padding */
      .disp-shell > div[style*="max-width"] {
        padding-left: 0 !important;
        padding-right: 0 !important;
        max-width: 100% !important;
      }

      /* rp-shell with inline max-width/padding: override to full-width */
      .rp-shell[style*="max-width"],
      .recur-shell > div[style*="max-width"],
      .ops-hub-wrap > div[style*="max-width"] {
        max-width: 100% !important;
        padding-left: 0 !important;
        padding-right: 0 !important;
        box-sizing: border-box !important;
      }

      /* Stat-grid / ops-hub: 2-col max on mobile */
      .ops-hub-grid[style*="grid-template-columns"] {
        grid-template-columns: 1fr !important;
        padding: 0 !important;
      }
      .ops-stat-grid {
        grid-template-columns: repeat(2, 1fr) !important;
        gap: 8px !important;
      }

      /* Bottomnav safe area */
      .wo-list-shell,
      .disp-shell,
      .rp-shell,
      .ops-hub-wrap {
        padding-bottom: 80px !important;
      }
    }
  </style>
</head>
<body>
<div id="sidebarScrim" class="sidebar-scrim"></div>
<div class="app-shell">
  <aside class="sidebar" id="sidebar">
    <div class="brand">
      <div class="brand-mark" onclick="show('today')" style="cursor:pointer;" title="Go to Today">
        <img src="/js/avalon-logo.png" alt="Groundwork" />
      </div>
      <div style="flex:1;min-width:0">
        <div class="brand-name">Groundwork</div>
        <div class="brand-subtitle">Sales CRM</div>
      </div>
      <button class="sidebar-close-btn" id="sidebarCloseBtn" aria-label="Close menu">
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 5l-5 5 5 5"/></svg>
      </button>
    </div>

      <!-- ── Tenant nav (hidden when platform admin session active) ── -->

      <!-- ── Dashboard ── -->
      <div class="nav-ws-group tenant-nav">
        <button class="nav-item nav-workspace active" data-view="gwDashboard" data-label="Dashboard" onclick="_gwTogglePanel('gwDashboard')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M5 1v3M11 1v3M2 7h12"/></svg>
          <span class="nav-workspace-label">Dashboard</span>
          <svg class="nav-chevron-icon" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:auto;opacity:.45"><path d="M2 3.5l3 3 3-3"/></svg>
        </button>
        <div class="nav-subtabs" id="gw-subtabs-gwDashboard"></div>
      </div>

      <!-- ── Sales ── -->
      <div class="nav-ws-group tenant-nav">
        <button class="nav-item nav-workspace" data-view="gwSales" data-label="Sales" onclick="_gwTogglePanel('gwSales')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h3v8H2zM6.5 2h3v12h-3zM11 6h3v6h-3z"/></svg>
          <span class="nav-workspace-label">Sales</span>
          <svg class="nav-chevron-icon" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:auto;opacity:.45"><path d="M2 3.5l3 3 3-3"/></svg>
        </button>
        <div class="nav-subtabs" id="gw-subtabs-gwSales"></div>
      </div>

      <!-- ── Financial ── -->
      <div class="nav-ws-group tenant-nav">
        <button class="nav-item nav-workspace" data-view="gwFinancial" data-label="Financial" onclick="_gwTogglePanel('gwFinancial')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1v14M5 10.5c0 1.4.9 2.5 3 2.5s3-1.1 3-2.5c0-1.7-1.5-2.3-3-2.8S5 6 5 4.5C5 3.1 5.9 2 8 2s3 1.1 3 2.5"/></svg>
          <span class="nav-workspace-label">Financial</span>
          <svg class="nav-chevron-icon" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:auto;opacity:.45"><path d="M2 3.5l3 3 3-3"/></svg>
        </button>
        <div class="nav-subtabs" id="gw-subtabs-gwFinancial"></div>
      </div>

      <!-- ── Operations ── -->
      <div class="nav-ws-group tenant-nav">
        <button class="nav-item nav-workspace" data-view="gwOperations" data-label="Operations" onclick="_gwTogglePanel('gwOperations')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M5 1v3M11 1v3M2 7h12"/><path d="M5 10h2M9 10h2"/></svg>
          <span class="nav-workspace-label">Operations</span>
          <svg class="nav-chevron-icon" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:auto;opacity:.45"><path d="M2 3.5l3 3 3-3"/></svg>
        </button>
        <div class="nav-subtabs" id="gw-subtabs-gwOperations"></div>
      </div>

      <!-- ── Learning ── -->
      <div class="nav-ws-group tenant-nav">
        <button class="nav-item nav-workspace" data-view="gwLearning" data-label="Learning" onclick="_gwTogglePanel('gwLearning')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12L8 2l6 10H2z"/><path d="M5 12v2M11 12v2M3 14h10"/></svg>
          <span class="nav-workspace-label">Learning</span>
          <svg class="nav-chevron-icon" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:auto;opacity:.45"><path d="M2 3.5l3 3 3-3"/></svg>
        </button>
        <div class="nav-subtabs" id="gw-subtabs-gwLearning"></div>
      </div>

      <!-- ── Admin ── -->
      <div class="nav-ws-group tenant-nav">
        <button class="nav-item nav-workspace" data-view="gwAdmin" data-label="Admin" onclick="_gwTogglePanel('gwAdmin')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.22 3.22l1.42 1.42M11.36 11.36l1.42 1.42M3.22 12.78l1.42-1.42M11.36 4.64l1.42-1.42"/></svg>
          <span class="nav-workspace-label">Admin</span>
          <svg class="nav-chevron-icon" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:auto;opacity:.45"><path d="M2 3.5l3 3 3-3"/></svg>
        </button>
        <div class="nav-subtabs" id="gw-subtabs-gwAdmin"></div>
      </div>

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
      <div id="sidebarAvatarInitials" style="width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.25);color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;flex-shrink:0">…</div>
      <div style="min-width:0;flex:1">
        <strong id="sidebarUserName" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;font-size:13px;color:#ffffff">Loading…</strong>
        <span id="sidebarUserRole" style="font-size:11px;color:rgba(255,255,255,.50)"></span>
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
          <!-- Content populated by _gwBuildNewMenu() after login -->
          <div class="tnd-section-label">Create</div>
          <button class="tnd-item" onclick="window._closeNewMenu();show('lead')" role="menuitem" data-new-item="lead">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="6" r="3"/><path d="M2 14c0-3.3 2.7-5 6-5s6 1.7 6 5"/></svg>
            Add Lead
          </button>
          <button class="tnd-item" onclick="window._closeNewMenu();show('clients');setTimeout(()=>window.showClientForm&&window.showClientForm(),80)" role="menuitem" data-new-item="client">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M8 5v6M5 8h6"/></svg>
            Add Client
          </button>
        </div>
      </div>

      <!-- Live sync status pill — shown during/after background sync -->
      <div id="gw-sync-status" style="display:none;align-items:center;gap:5px;padding:4px 10px;background:var(--gw-surface-2,rgba(255,255,255,.07));border:1px solid var(--gw-line,rgba(255,255,255,.12));border-radius:20px;font-size:11px;font-weight:600;cursor:pointer" onclick="window._manualSync()" title="Click to sync now"></div>

      <!-- ── Phase 9A: Workday Clock pill ── -->
      <div id="gw-clock-pill" class="gw-clock-pill" style="display:none" onclick="gwClockPillClick()">
        <span id="gw-clock-dot" class="gw-clock-dot"></span>
        <span id="gw-clock-label" class="gw-clock-label">Clock In</span>
        <span id="gw-clock-timer" class="gw-clock-timer" style="display:none"></span>
        <!-- dropdown menu -->
        <div id="gw-clock-menu" class="gw-clock-menu" style="display:none" onclick="event.stopPropagation()">
          <div id="gw-clock-menu-inner"></div>
        </div>
      </div>

      <button class="topbar-settings" onclick="show('gwAdmin')" title="Admin"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><circle cx="10" cy="10" r="3"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.22 4.22l1.42 1.42M14.36 14.36l1.42 1.42M4.22 15.78l1.42-1.42M14.36 5.64l1.42-1.42"/></svg>Admin</button>
    </header>
    <nav id="gw-trail" class="gw-trail" aria-label="Navigation history" style="display:none"></nav>
    <div id="gw-ws-header" style="display:none"></div>
    <div class="view" id="view" role="region" aria-live="polite"></div>
  </main>
</div>
<div id="toast" class="toast" hidden role="alert" aria-live="assertive"></div>

<script src="/js/gw-icons.js?v=20260713b009"></script>
<script src="/js/db.js?v=20260713b009"></script>
<script src="/js/data.js?v=20260713b009"></script>
<script src="/js/reps.js?v=20260713b009"></script>
<script src="/js/record-page.js?v=20260713b009"></script>
<script src="/js/academy.js?v=20260713b009"></script>
<script src="/js/task_engine.js?v=20260713b009"></script>
<script src="/js/app_premium.js?v=20260713b009"></script>
<script src="/js/estimates.js?v=20260713b009"></script>
<script src="/js/invoices.js?v=20260713b009"></script>
<script src="/js/csv_import.js?v=20260713b009"></script>
<script src="/js/onboarding.js?v=20260713b009"></script>
<script src="/js/recurring_plans.js?v=20260713b009"></script>
<script src="/js/reviews.js?v=20260713b009"></script>
<script src="/js/stripe.js?v=20260713b009"></script>
<script src="/js/email.js?v=20260713b009"></script>
<script src="/js/notifications.js?v=20260713b009"></script>
<script src="/js/integrations.js?v=20260713b009"></script>
<script src="/js/user_management.js?v=20260713b009"></script>
<script src="/js/platform_admin.js?v=20260713b009"></script>
<script src="/js/time_tracker.js?v=20260713b009"></script>
<script src="/js/field_workday.js?v=20260713b009"></script>
<script src="/js/platform_core.js?v=20260713b009"></script>
<script src="/js/approval_engine.js?v=20260713b009"></script>
<script src="/js/automation_engine.js?v=20260713b009"></script>
<script src="/js/client_portal.js?v=20260713b009"></script>
<script src="/js/field_mode.js?v=20260713b009"></script>
<script>
  // ── Service Worker: KILL MODE (no reload loop) ────────────────────────────
  // Silently unregister all SWs and wipe all caches. Never register a new SW.
  // The /sw.js route still serves a self-destructing SW for browsers that
  // already have the old SW registered and will fetch it on their own update
  // cycle — but we do NOT register it from the page, which was causing the
  // GW_NUKE_DONE → reload() → re-register → GW_NUKE_DONE infinite loop.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then(regs => regs.forEach(r => r.unregister()))
      .catch(() => {});
  }
  if ('caches' in window) {
    caches.keys().then(keys => keys.forEach(k => caches.delete(k))).catch(() => {});
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

  // NOTE: window._avalonState is set by app_premium.js (saveState) — do NOT
  // reference 'state' here; it is in app_premium.js closure scope only.

  // ── D1 + Auth Bootstrap ───────────────────────────────────────────────────
  // 1. Check D1 session cookie → if valid, set window._d1Rep and load D1 state
  // 2. Call /api/auth/bootstrap to hydrate REPS + roles + navPerms + pipelineStages
  // 3. Update sidebar footer with real user identity
  // 4. Signal _initialRoute() via window._d1BootstrapReady promise
  // 5. If no D1 session, fall back to localStorage auth (reps.js getCurrentRep)

  // NOTE: window._d1BootstrapReady promise is created in db.js (loads first)
  // so _initialRoute() in app_premium.js can safely await it.
  // We only need to call window._d1BootstrapResolve() here when session check completes.

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
        // IMPORTANT: must match the key reps.js reads ('avalonRepAuth')
        localStorage.setItem('avalonRepAuth', JSON.stringify({ repId: d1Rep.id, loginAt: new Date().toISOString() }));

        // ── STEP 1: Hydrate REPS + roles + navPerms + pipeline stages ────────────
        // Do this FIRST and resolve the bootstrap promise immediately so
        // _initialRoute() can call show('today') without waiting for data loading.
        try {
          const bsRes = await fetch('/api/auth/bootstrap', { credentials: 'include' });
          if (bsRes.ok) {
            const bs = await bsRes.json();
            if (bs.ok && bs.data) {
              window._gwBootstrap       = bs.data;
              window._gwRoles           = bs.data.roles;
              window._gwPipelineStages  = bs.data.pipelineStages;
              window._gwNavPerms        = bs.data.navPerms;
              if (typeof window._hydrateRepsFromBootstrap === 'function') {
                window._hydrateRepsFromBootstrap(bs.data.reps);
              }
              if (window.AVALON_DATA && bs.data.pipelineStages) {
                window.AVALON_DATA.statuses = bs.data.pipelineStages;
              }
            }
          }
        } catch(bsErr) {
          console.warn('[Bootstrap] /api/auth/bootstrap failed:', bsErr.message);
        }

        // ── STEP 1b: Hide unauthorized nav groups immediately (fixes reload flash) ──
        // Runs before _initialRoute() so field roles never see Sales/Financial nav.
        try {
          if (typeof window.canViewTab === 'function') {
            var _bsRole = d1Rep && d1Rep.role;
            document.querySelectorAll('.nav-ws-group').forEach(function(group) {
              var btn = group.querySelector('.nav-item[data-view]');
              if (!btn) return;
              var wsView = btn.dataset.view;
              if (!wsView) return;
              var canSee = _bsRole === 'admin' || window.canViewTab(wsView);
              group.style.display = canSee ? '' : 'none';
            });
            // Mobile bottom nav
            document.querySelectorAll('.gw-mnav-btn[data-view]').forEach(function(btn) {
              var canSee = _bsRole === 'admin' || window.canViewTab(btn.dataset.view);
              btn.style.display = canSee ? '' : 'none';
            });
            // Also update sidebar rep appearance now that we have d1Rep
            if (typeof window._updateSidebarRep === 'function') {
              try { window._updateSidebarRep(); } catch(_) {}
            }
          }
        } catch(_navErr) {}

        // ── STEP 2: Update sidebar footer ─────────────────────────────────────
        try {
          const footer = document.querySelector('.sidebar-footer');
          if (footer) {
            const isAdmin = d1Rep.role === 'admin';
            const isOM    = d1Rep.role === 'office_manager';
            const displayName = d1Rep.name || 'User';
            const displayRole = isAdmin ? 'Owner / Admin' : isOM ? 'Office Manager' : (d1Rep.title || 'Sales Rep');
            const initials = displayName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
            footer.innerHTML =
              '<div style="width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.25);color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;flex-shrink:0;cursor:pointer;letter-spacing:-.01em" onclick="logoutRep();renderLoginScreen()" title="Sign out">' + initials + '</div>' +
              '<div style="min-width:0;flex:1">' +
              '<strong style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;font-size:13px;color:#ffffff">' + displayName + '</strong>' +
              '<span style="font-size:11px;color:rgba(255,255,255,.50)">' + displayRole + '</span>' +
              '</div>' +
              '<button id="gw-sync-btn" onclick="window._manualSync()" title="Sync" style="background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.18);border-radius:6px;color:rgba(255,255,255,.7);font-size:13px;line-height:1;padding:4px 6px;cursor:pointer;flex-shrink:0">⟳</button>';
          }
        } catch(sfErr) {}

        // ── STEP 3: Signal _initialRoute() — REPS ready, safe to show() ───────
        // This must happen BEFORE the slow data loading below.
        window._d1Ready = true;
        if (typeof window._d1FlushQueue === 'function') window._d1FlushQueue();
        if (typeof window._refreshAdminNav === 'function') window._refreshAdminNav();
        if (typeof window._d1BootstrapResolve === 'function') window._d1BootstrapResolve({ authed: true });
        // Phase 9A: initialize header clock pill
        if (typeof window.gwInitClockPill === 'function') window.gwInitClockPill();

        // ── STEP 4: Load data in background (after UI is already shown) ───────
        // Run one-time localStorage → D1 migration
        try {
          const migrated = await window.DB.migrateFromLocalStorage();
          if (migrated) console.log('[Bootstrap] Migrated localStorage data to D1');
        } catch(_e) {}

        // Safety-net recovery: push localStorage-only leads not yet in D1
        try {
          const _rawState = JSON.parse(localStorage.getItem('avalonSalesHubStateV3') || '{}');
          const _localOnly = (_rawState.opportunities || []).filter(o => !o._fromD1);
          if (_localOnly.length > 0) {
            const _r = await window.DB.opportunities.bulkUpsert(_localOnly);
            if (_r.inserted > 0) console.info('[Bootstrap] Recovery pushed ' + _r.inserted + ' lead(s) to D1');
          }
        } catch(_e) {}

        // Load opps + clients from D1
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

        // Load opportunities — D1 is authoritative, push into localStorage so
        // app_premium.js loadState() picks them up on next render cycle.
        // NOTE: 'state' and 'saveState' live in app_premium.js closure — we use
        // localStorage directly here to avoid ReferenceError in this inline script.
        try {
          const opps = await window.DB.opportunities.list({ repId: isAdmin ? undefined : d1Rep.id });
          if (opps && opps.length > 0) {
            const STORAGE_KEY = 'avalonSalesHubStateV3';
            const _raw = (() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch(_){return {};} })();
            const d1Ids = new Set(opps.map(o => o.id));
            const localOnly = (_raw.opportunities || []).filter(o => !d1Ids.has(o.id) && !o._fromD1);
            _raw.opportunities = [
              ...opps.map(mapOpp).map(o => ({...o, _fromD1: true})),
              ...localOnly
            ];
            localStorage.setItem(STORAGE_KEY, JSON.stringify(_raw));
            // Tell app_premium.js to reload state from localStorage now
            if (typeof window._avalonSyncState === 'function') window._avalonSyncState();
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

        // Expose mapOpp for other modules
        window._mapOpp = mapOpp;
        // Update brand kicker with real company name (background, non-blocking)
        fetch('/api/companies/' + d1Rep.company_id)
          .then(r => r.ok ? r.json() : null)
          .then(j => {
            const name = j && (j.data ?? j)?.name;
            if (name) {
              const kicker = document.getElementById('brandKicker');
              if (kicker) kicker.textContent = name;
              window._companyName = name;
            }
          }).catch(() => {});
        console.log('[Bootstrap] D1 data loaded for', d1Rep.name);
        return; // Done — promise already resolved in Step 3
      }
    } catch(e) {
      console.warn('[Bootstrap] D1 session check failed, falling back to localStorage:', e.message);
    }

    // No active D1 session — resolve bootstrap promise so _initialRoute doesn't hang
    // _initialRoute() will detect no d1Rep and call renderLoginScreen() itself.
    if (typeof window._d1BootstrapResolve === 'function') window._d1BootstrapResolve({ authed: false });
  })();

  // Show/hide nav items based on current rep role
  // With the 5-workspace model, visibility is handled inside gwAdmin workspace tabs;
  // the sidebar itself only needs to show/hide workspace buttons per role.
  (function applyNavVisibility() {
    function refreshAdminNav() {
      const rep = window.getCurrentRep ? window.getCurrentRep() : null;
      const isAdmin = rep && rep.role === 'admin';
      // Hide Admin workspace button from non-admin roles that lack admin views
      // (gwAdmin workspace itself handles internal tab visibility)
      const adminBtn = document.querySelector('[data-view="gwAdmin"]');
      if (adminBtn) {
        // Show Admin nav for admin and office_manager roles
        const canSeeAdmin = !rep || rep.role === 'admin' || rep.role === 'office_manager';
        adminBtn.style.display = canSeeAdmin ? '' : 'none';
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
