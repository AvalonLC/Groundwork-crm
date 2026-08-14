import { Hono } from 'hono'
import { serveStatic } from 'hono/cloudflare-workers'
import { cors } from 'hono/cors'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
// ── Embedded migrations (0022-0030) for production schema self-heal ─────────
// Vite inlines these at build time; applied idempotently via ensureFullSchema()
import mig0022 from '../migrations/0022_stripe_connect.sql?raw'
import mig0023 from '../migrations/0023_invoices.sql?raw'
import mig0024 from '../migrations/0024_recurring_plans.sql?raw'
import mig0025 from '../migrations/0025_onboarding.sql?raw'
import mig0026 from '../migrations/0026_reviews.sql?raw'
import mig0027 from '../migrations/0027_notifications.sql?raw'
import mig0028 from '../migrations/0028_field_ops.sql?raw'
import mig0029 from '../migrations/0029_language_preference.sql?raw'
import mig0030 from '../migrations/0030_plan_visits_v2.sql?raw'
import mig0031 from '../migrations/0031_assets_hub.sql?raw'
import mig0032 from '../migrations/0032_proposals_payments_google.sql?raw'
import mig0033 from '../migrations/0033_email_templates.sql?raw'
import mig0034 from '../migrations/0034_price_book_estimate_merge.sql?raw'
import mig0054 from '../migrations/0054_estimate_price_display.sql?raw'
import mig0035 from '../migrations/0035_calendar_sync.sql?raw'
import mig0036 from '../migrations/0036_ai_usage.sql?raw'
import mig0037 from '../migrations/0037_platform_demos_pricing.sql?raw'
import mig0038 from '../migrations/0038_real_pricing_import.sql?raw'
import mig0039 from '../migrations/0039_onboarding_system.sql?raw'
import mig0040 from '../migrations/0040_onboarding_buildout.sql?raw'
import mig0045 from '../migrations/0045_multiday_jobs.sql?raw'
import mig0046 from '../migrations/0046_multiday_phase_metadata.sql?raw'
import mig0047 from '../migrations/0047_schedule_timeline.sql?raw'
import mig0055 from '../migrations/0055_client_portfolio.sql?raw'
import mig0059 from '../migrations/0059_service_packages.sql?raw'
import { registerPortal } from './portal'
// ── Finance OS sub-routers (see CLAUDE.md, docs/spec/API.md, docs/spec/ACTIONS.md) ──
import { ratesRouter } from './api/rates'
import { actionsRouter } from './api/actions'
import { financeUiRouter } from './ui/mount'
import { cronTriggerRouter } from './api/cron-trigger'
import { updateWorkOrderFinanceColumns } from './db/repos'
import { postTimeEntryToLedger } from './api/posting'
// ── Marketing OS — mounted sub-routers (see src/marketing/) ──────────────────
import { marketingRouter } from './marketing/api'
import { marketingPublicRouter } from './marketing/public'
import { marketingCronRouter } from './marketing/cron'
import { insertOpportunityRow, resolveDefaultPipelineStage } from './marketing/leads'
import { CAMPAIGN_DRAFT_SCHEMA, COPILOT_SYSTEM_PROMPT, normalizeDraft, runTool, toolSpecs } from './marketing/ai-tools'
// ── Scheduling engine — mounted sub-router (see src/scheduling/) ─────────────
import { schedulingRouter, ensurePrimaryDay, syncDayEmployees, syncPrimaryDayFromWorkOrder } from './scheduling/api'
import { hoursPerVisitFromRecurringData } from './recurring/estimate_hours'


type Bindings = { DB: D1Database; MEDIA: R2Bucket; CRON_SECRET?: string; SENDGRID_API_KEY?: string; OPENAI_API_KEY?: string; OPENAI_BASE_URL?: string; GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string }
type Variables = { repId: string; companyId: string; role: string; isSuperAdmin: boolean }

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// ── Finance OS routes — mounted, not inlined; see src/api/rates.ts, src/api/actions.ts, src/ui/mount.ts ──
// These carry wage-derived data (burdened labor rates) and were previously mounted
// with NO authentication at all — an anonymous POST reached the handler. It leaked
// nothing only because no tenant had rate profiles yet. Gated the same way as
// /api/marketing/* and /api/scheduling/*. The routers additionally check that the
// company_id in the request body matches the session, because these endpoints take
// the tenant from the payload rather than the cookie.
app.use('/internal/rates/*', requireAuth)
app.use('/internal/actions/*', requireAuth)
app.route('/internal/rates', ratesRouter)
app.route('/internal/actions', actionsRouter)
// No requireAuth — this has its own X-Cron-Secret header auth (see
// src/api/cron-trigger.ts) since a scheduler can't supply a session cookie.
app.route('/internal/cron', cronTriggerRouter)
// requireAuth / requireAuthFinance are hoisted function declarations
// (defined further below in this file) — referencing them here, before
// their textual definition, is safe.
app.use('/finance/*', requireAuthFinance)
app.route('/finance', financeUiRouter)

// ── Marketing OS ─────────────────────────────────────────────────────────────
// Authenticated API. requireAuth is applied here rather than inside the router
// so the router stays a plain Hono app that can be tested on its own.
app.use('/api/marketing/*', requireAuth)
app.route('/api/marketing', marketingRouter)

// ── Scheduling engine ────────────────────────────────────────────────────────
// Same pattern: requireAuth at the mount point so the router stays a plain Hono
// app that can be tested on its own, and every handler can rely on
// c.var.companyId.
app.use('/api/scheduling/*', requireAuth)
app.route('/api/scheduling', schedulingRouter)
// Scheduled drain — X-Cron-Secret header auth, same as the finance rollup.
app.route('/internal/cron', marketingCronRouter)
// Public: campaign images, unsubscribe, click redirects, inquiry forms and the
// SendGrid event webhook. Each handler resolves an unguessable token or
// verifies a signature; none of them may assume a session.
app.route('/', marketingPublicRouter)

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
app.get('/api/status', (c) => c.json({
  app: 'Groundwork CRM',
  status: 'ok',
  server_time: new Date().toISOString(),
}))

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
    }catch(e){log('! SW unregister: '+e.message);}
  } else { log('SW not supported in this browser'); }

  // ── 2. Wipe every cache entry ──────────────────────────────────────────────
  if('caches' in window){
    try{
      const keys=await caches.keys();
      await Promise.all(keys.map(k=>caches.delete(k)));
      log('✓ '+keys.length+' cache bucket(s) deleted');
    }catch(e){log('! Cache wipe: '+e.message);}
  }

  // ── 3. Clear localStorage + sessionStorage ─────────────────────────────────
  try{ localStorage.clear(); sessionStorage.clear(); log('✓ Storage cleared'); }
  catch(e){ log('! Storage: '+e.message); }

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
async function sendEmail(apiKey: string, to: string, subject: string, html: string, opts?: { cc?: string; fromName?: string; replyTo?: string }): Promise<boolean> {
  try {
    const personalization: any = { to: [{ email: to }] }
    if (opts?.cc) personalization.cc = [{ email: opts.cc }]
    const payload: any = {
      personalizations: [personalization],
      from: { email: 'noreply@groundwork-crm.com', name: opts?.fromName || 'Groundwork CRM' },
      subject,
      content: [{ type: 'text/html', value: html }]
    }
    if (opts?.replyTo) payload.reply_to = { email: opts.replyTo }
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return res.status >= 200 && res.status < 300
  } catch { return false }
}

// ── Rich text render (server-side) ───────────────────────────────────────────
// Terms & notes may be stored as legacy plain text OR sanitized HTML from the
// rich editor (richtext.js). This renders either safely: plain text is escaped
// with \n→<br>; HTML is re-sanitized to a strict whitelist with all attributes
// stripped (no DOMParser in Workers, so a conservative regex pass is used).
function richTextHtml(v: any): string {
  const s = String(v ?? '')
  if (!s) return ''
  const esc = (x: string) => x.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
  if (!/<[a-z][^>]*>/i.test(s)) return esc(s).replace(/\n/g,'<br>')
  const ALLOWED = ['p','div','br','b','strong','i','em','u','s','strike','ul','ol','li','h1','h2','h3','h4','blockquote']
  // Remove script/style blocks entirely, then whitelist tags & strip attributes
  let out = s.replace(/<(script|style|iframe|object|embed|form)[\s\S]*?<\/\1\s*>/gi, '')
  out = out.replace(/<\/?([a-zA-Z0-9]+)[^>]*>/g, (m, tag) => {
    const t = String(tag).toLowerCase()
    if (!ALLOWED.includes(t)) return ''
    const close = m.startsWith('</')
    if (t === 'br') return '<br>'
    return close ? `</${t}>` : `<${t}>`
  })
  return out
}

// ── Secure random hex token ───────────────────────────────────────────────────
// ── Full schema self-heal ─────────────────────────────────────────────────────
// Applies embedded migrations 0022-0030 statement-by-statement, idempotently.
// Guarded by a settings flag so it runs at most once per database.
const EMBEDDED_MIGRATIONS: Array<[string, string]> = [
  ['0022_stripe_connect.sql', mig0022], ['0023_invoices.sql', mig0023],
  ['0024_recurring_plans.sql', mig0024], ['0025_onboarding.sql', mig0025],
  ['0026_reviews.sql', mig0026], ['0027_notifications.sql', mig0027],
  ['0028_field_ops.sql', mig0028], ['0029_language_preference.sql', mig0029],
  ['0030_plan_visits_v2.sql', mig0030], ['0031_assets_hub.sql', mig0031],
]
async function ensureFullSchema(db: D1Database): Promise<void> {
  const flag = await db.prepare("SELECT value FROM settings WHERE key = '_schema_full_v1' LIMIT 1").first<any>()
  if (flag) return
  for (const [name, sql] of EMBEDDED_MIGRATIONS) {
    // Strip line comments, split on ';' (no triggers/semicolons-in-literals in these files)
    const stmts = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
      .split(';').map(s => s.trim()).filter(s => s.length > 0)
    for (const stmt of stmts) {
      try { await db.prepare(stmt).run() } catch (e: any) {
        const msg = String(e?.message || e)
        // Idempotent: ignore already-applied DDL
        if (!/duplicate column|already exists|UNIQUE constraint/i.test(msg)) {
          console.log('ensureFullSchema skip-error', name, msg.slice(0, 120))
        }
      }
    }
    // Record in d1_migrations so wrangler-driven applies stay consistent
    try {
      await db.prepare('INSERT INTO d1_migrations (name, applied_at) SELECT ?, CURRENT_TIMESTAMP WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = ?)').bind(name, name).run()
    } catch {}
  }
  await db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('_schema_full_v1', ?, datetime('now'))").bind(new Date().toISOString()).run()
}

// ── Assets Hub schema (migration 0031) — lazy-applied on first assets API hit ──
let _assetsSchemaOk = false
async function ensureAssetsSchema(db: D1Database): Promise<void> {
  if (_assetsSchemaOk) return
  const flag = await db.prepare("SELECT value FROM settings WHERE key = '_schema_assets_v1' LIMIT 1").first<any>()
  if (flag) { _assetsSchemaOk = true; return }
  const stmts = mig0031.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .split(';').map(x => x.trim()).filter(x => x.length > 0)
  for (const stmt of stmts) {
    try { await db.prepare(stmt).run() } catch (e: any) {
      const msg = String(e?.message || e)
      if (!/duplicate column|already exists/i.test(msg)) console.log('ensureAssetsSchema err', msg.slice(0, 120))
    }
  }
  try {
    await db.prepare('INSERT INTO d1_migrations (name, applied_at) SELECT ?, CURRENT_TIMESTAMP WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = ?)').bind('0031_assets_hub.sql', '0031_assets_hub.sql').run()
  } catch {}
  await db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('_schema_assets_v1', ?, datetime('now'))").bind(new Date().toISOString()).run()
  _assetsSchemaOk = true
}

// ── Client portfolio schema (migration 0055): opportunities.client_id + clients.extra ──
let _portfolioSchemaOk = false
async function ensurePortfolioSchema(db: D1Database): Promise<void> {
  if (_portfolioSchemaOk) return
  const flag = await db.prepare("SELECT value FROM settings WHERE key = '_schema_portfolio_v1' LIMIT 1").first<any>()
  if (flag) { _portfolioSchemaOk = true; return }
  const stmts = mig0055.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .split(';').map(x => x.trim()).filter(x => x.length > 0)
  for (const stmt of stmts) {
    try { await db.prepare(stmt).run() } catch (e: any) {
      const msg = String(e?.message || e)
      if (!/duplicate column|already exists/i.test(msg)) console.log('ensurePortfolioSchema err', msg.slice(0, 120))
    }
  }
  try {
    await db.prepare('INSERT INTO d1_migrations (name, applied_at) SELECT ?, CURRENT_TIMESTAMP WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = ?)').bind('0055_client_portfolio.sql', '0055_client_portfolio.sql').run()
  } catch {}
  await db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('_schema_portfolio_v1', ?, datetime('now'))").bind(new Date().toISOString()).run()
  _portfolioSchemaOk = true
}

// ── Proposals / payment schedules / google tokens schema (migration 0032) ──
let _prop32SchemaOk = false
async function ensureProposalsSchema(db: D1Database): Promise<void> {
  if (_prop32SchemaOk) return
  const flag = await db.prepare("SELECT value FROM settings WHERE key = '_schema_prop_v1' LIMIT 1").first<any>()
  if (flag) { _prop32SchemaOk = true; return }
  const stmts = mig0032.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .split(';').map(x => x.trim()).filter(x => x.length > 0)
  for (const stmt of stmts) {
    try { await db.prepare(stmt).run() } catch (e: any) {
      const msg = String(e?.message || e)
      if (!/duplicate column|already exists/i.test(msg)) console.log('ensureProposalsSchema err', msg.slice(0, 120))
    }
  }
  try {
    await db.prepare('INSERT INTO d1_migrations (name, applied_at) SELECT ?, CURRENT_TIMESTAMP WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = ?)').bind('0032_proposals_payments_google.sql', '0032_proposals_payments_google.sql').run()
  } catch {}
  await db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('_schema_prop_v1', ?, datetime('now'))").bind(new Date().toISOString()).run()
  _prop32SchemaOk = true
}

// ── Custom email templates schema (migration 0033) ──
let _emailTplSchemaOk = false
async function ensureEmailTplSchema(db: D1Database): Promise<void> {
  if (_emailTplSchemaOk) return
  const stmts = mig0033.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .split(';').map(x => x.trim()).filter(x => x.length > 0)
  for (const stmt of stmts) {
    try { await db.prepare(stmt).run() } catch (e: any) {
      const msg = String(e?.message || e)
      if (!/duplicate column|already exists/i.test(msg)) console.log('ensureEmailTplSchema err', msg.slice(0, 120))
    }
  }
  try {
    await db.prepare('INSERT INTO d1_migrations (name, applied_at) SELECT ?, CURRENT_TIMESTAMP WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = ?)').bind('0033_email_templates.sql', '0033_email_templates.sql').run()
  } catch {}
  _emailTplSchemaOk = true
}

// ── Service packages schema (migration 0059) ──
let _servicePackagesSchemaOk = false
async function ensureServicePackagesSchema(db: D1Database): Promise<void> {
  if (_servicePackagesSchemaOk) return
  const stmts = mig0059.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .split(';').map(x => x.trim()).filter(x => x.length > 0)
  for (const stmt of stmts) {
    try { await db.prepare(stmt).run() } catch (e: any) {
      const msg = String(e?.message || e)
      if (!/duplicate column|already exists/i.test(msg)) console.log('ensureServicePackagesSchema err', msg.slice(0, 120))
    }
  }
  try {
    await db.prepare('INSERT INTO d1_migrations (name, applied_at) SELECT ?, CURRENT_TIMESTAMP WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = ?)').bind('0059_service_packages.sql', '0059_service_packages.sql').run()
  } catch {}
  _servicePackagesSchemaOk = true
}

// ── Price book + estimate merge schema (migration 0034) ──
let _priceBookSchemaOk = false
async function ensurePriceBookSchema(db: D1Database): Promise<void> {
  if (_priceBookSchemaOk) return
  const stmts = mig0034.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .split(';').map(x => x.trim()).filter(x => x.length > 0)
  for (const stmt of stmts) {
    try { await db.prepare(stmt).run() } catch (e: any) {
      const msg = String(e?.message || e)
      if (!/duplicate column|already exists/i.test(msg)) console.log('ensurePriceBookSchema err', msg.slice(0, 120))
    }
  }
  try {
    await db.prepare('INSERT INTO d1_migrations (name, applied_at) SELECT ?, CURRENT_TIMESTAMP WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = ?)').bind('0034_price_book_estimate_merge.sql', '0034_price_book_estimate_merge.sql').run()
  } catch {}
  // 0054: client-facing price display mode (total_only vs itemized)
  for (const stmt of mig0054.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').split(';').map(x => x.trim()).filter(Boolean)) {
    try { await db.prepare(stmt).run() } catch (e: any) {
      const msg = String(e?.message || e)
      if (!/duplicate column|already exists/i.test(msg)) console.log('ensurePriceBookSchema 0054 err', msg.slice(0, 120))
    }
  }
  try {
    await db.prepare('INSERT INTO d1_migrations (name, applied_at) SELECT ?, CURRENT_TIMESTAMP WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = ?)').bind('0054_estimate_price_display.sql', '0054_estimate_price_display.sql').run()
  } catch {}
  _priceBookSchemaOk = true
}

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
    SELECT r.id as rep_id, r.company_id, r.role, r.is_super_admin, s.updated_at as session_at
    FROM settings s
    JOIN reps r ON r.id = s.value
    WHERE s.key = ? AND r.active = 1 LIMIT 1
  `).bind(`session_${token}`).first<{ rep_id: string; company_id: string; role: string; is_super_admin: number; session_at: string }>()
  if (!row) return err(c, 'Session expired', 401)
  // 30-day server-side session expiry (matches cookie Max-Age)
  if (row.session_at) {
    const ageMs = Date.now() - new Date(row.session_at.replace(' ', 'T') + 'Z').getTime()
    if (isFinite(ageMs) && ageMs > 30 * 24 * 60 * 60 * 1000) {
      await c.env.DB.batch([
        c.env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(`session_${token}`),
        c.env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(`session_company_${token}`)
      ])
      return err(c, 'Session expired', 401)
    }
  }
  // Company scope: prefer the explicit session_company row (impersonation-aware)
  const coRow = await c.env.DB.prepare('SELECT value FROM settings WHERE key = ? LIMIT 1')
    .bind(`session_company_${token}`).first<{ value: string }>()
  const resolvedCompanyId = coRow?.value || row.company_id
  // Company gate: suspension (403) + trial expiry (402). Super-admins exempt.
  // try/catch: if trial columns don't exist yet (pre-migration DB), skip the gate.
  if (!row.is_super_admin) {
    try {
      const co = await c.env.DB.prepare(
        'SELECT active, subscription_status, trial_expires_at FROM companies WHERE id = ? LIMIT 1'
      ).bind(resolvedCompanyId).first<any>()
      if (co && co.active === 0) return err(c, 'company_suspended', 403)
      if (co && co.subscription_status === 'trial' && co.trial_expires_at &&
          new Date(co.trial_expires_at).getTime() < Date.now()) {
        const p = new URL(c.req.url).pathname
        const allowed = p.startsWith('/api/auth/') || p === '/api/company/branding' ||
                        p.startsWith('/api/companies/') || p === '/api/events/poll'
        if (!allowed) return err(c, 'trial_expired', 402)
      }
    } catch (_) { /* trial columns missing — skip gate */ }
  }
  c.set('repId',        row.rep_id)
  c.set('companyId',    resolvedCompanyId)
  c.set('role',         row.role)
  c.set('isSuperAdmin', !!row.is_super_admin)
  await next()
}

// requireAuth's {ok:false} JSON response is correct for the finance JSON
// API (/finance/api/*) — existing callers expect it. It's wrong for the six
// finance HTML pages (/finance/money-loop, /recovery, /budget, /queue,
// /job-costing, /config): a user who clicked an in-app nav link and hit an
// expired/missing session should land on the same app shell every other
// page in this CRM sends them to (it has no server-side auth gate of its
// own — the client handles the logged-out state), not a raw JSON dead end.
// requireAuth itself is untouched; this only changes what happens with its
// failure response, and only for the page routes.
async function requireAuthFinance(c: any, next: any) {
  if (c.req.path.startsWith('/finance/api/')) return requireAuth(c, next)
  const authFailure = await requireAuth(c, next)
  if (authFailure) return c.redirect('/')
}

// ── Finance OS write-through helpers ─────────────────────────────────────────
// Since migrations/0057_finance_merge.sql (2026-08-09), Finance OS's tables
// live in this same DB — these replace the old cross-database
// src/bridge/finance-sync.ts (deleted). All three are best-effort: a Finance
// OS write failure must never break the CRM request that triggered it.

/** Mirrors a work order's estimate/completion state onto its own
 * estimate_cents/finance_completed_at columns (work_item's old columns,
 * folded onto work_orders — id/job_id were always the same value). Called
 * from both work-order create and update. */
async function syncWorkOrderFinanceColumns(db: D1Database, companyId: string, woId: string): Promise<void> {
  try {
    const wo = await db.prepare(
      `SELECT id, crew_id, opp_id, estimate_id, status FROM work_orders WHERE id = ? AND company_id = ?`,
    ).bind(woId, companyId).first<{ id: string; crew_id: string | null; opp_id: string | null; estimate_id: string | null; status: string }>()
    if (!wo) return

    // Resolve the linked estimate: work_orders.estimate_id (rarely set by
    // the create/update handlers) -> the reverse FK estimates.work_order_id
    // (set by the estimate->work-order conversion flow) -> the most recent
    // accepted estimate on the same opportunity -> none.
    let estimateTotalCents: number | null = null
    if (wo.estimate_id) {
      const est = await db.prepare(`SELECT total_cents FROM estimates WHERE id = ? AND company_id = ?`)
        .bind(wo.estimate_id, companyId).first<{ total_cents: number }>()
      estimateTotalCents = est?.total_cents ?? null
    }
    if (estimateTotalCents === null) {
      const est = await db.prepare(
        `SELECT total_cents FROM estimates WHERE work_order_id = ? AND company_id = ? ORDER BY created_at DESC LIMIT 1`,
      ).bind(woId, companyId).first<{ total_cents: number }>()
      estimateTotalCents = est?.total_cents ?? null
    }
    if (estimateTotalCents === null && wo.opp_id) {
      const est = await db.prepare(
        `SELECT total_cents FROM estimates WHERE opp_id = ? AND company_id = ? AND status = 'accepted' ORDER BY created_at DESC LIMIT 1`,
      ).bind(wo.opp_id, companyId).first<{ total_cents: number }>()
      estimateTotalCents = est?.total_cents ?? null
    }

    // Preserve the original completion timestamp across re-syncs instead of
    // resetting it to "now" every time an already-complete work order is
    // touched again (e.g. a note edit after completion).
    let completedAt: string | null = null
    if (wo.status === 'completed') {
      const existing = await db.prepare(`SELECT finance_completed_at FROM work_orders WHERE id = ? AND company_id = ?`)
        .bind(woId, companyId).first<{ finance_completed_at: string | null }>()
      completedAt = existing?.finance_completed_at ?? new Date().toISOString()
    }

    await updateWorkOrderFinanceColumns(
      db, companyId, woId,
      estimateTotalCents,
      completedAt,
    )
  } catch (e) {
    console.error('syncWorkOrderFinanceColumns failed (non-blocking)', woId, e)
  }
}

/** Posts a just-closed time_entries row onto job_cost_ledger, in place — no
 * separate insert step needed (the row already exists from clock-in). Only
 * called at clock-out, never clock-in: duration/hours aren't known until
 * then. Skipped entirely for general/non-job time (no work_order_id) or
 * when the linked work order's crew has no division set (division is
 * required to post; see src/api/posting.ts). */
async function postWorkOrderTimeEntry(
  db: D1Database, companyId: string, entry: { id: string; work_order_id: string | null },
): Promise<void> {
  try {
    if (!entry.work_order_id) return

    const wo = await db.prepare(`SELECT crew_id FROM work_orders WHERE id = ? AND company_id = ?`)
      .bind(entry.work_order_id, companyId).first<{ crew_id: string | null }>()
    if (!wo?.crew_id) return

    const crew = await db.prepare(`SELECT division FROM crews WHERE id = ? AND company_id = ?`)
      .bind(wo.crew_id, companyId).first<{ division: string | null }>()
    if (!crew?.division) return

    const result = await postTimeEntryToLedger(db, companyId, entry.id, crew.division)
    if (!result.success) {
      // Expected when a tenant hasn't finished Finance OS setup (no rate
      // profile / no overhead allocation for this division yet) — an honest
      // gap, not a bug.
      console.warn('postWorkOrderTimeEntry: posting did not complete', entry.id, result.reason)
    }
  } catch (e) {
    console.error('postWorkOrderTimeEntry failed (non-blocking)', entry.id, e)
  }
}

/** Server-side counterpart to the manual "Payment Collected" checkbox —
 * called from every code path that transitions an invoice to status='paid',
 * so `collected` reflects a real payment event even if nobody ever checks
 * the box by hand. Does not touch commission_approved or any commission
 * math (out of scope, see the finance-merge project notes). */
async function markOpportunityCollectedFromInvoice(
  db: D1Database, companyId: string, invoiceId: string, estimateIdHint?: string | null,
): Promise<void> {
  try {
    let estimateId = estimateIdHint ?? null
    if (!estimateId) {
      const inv = await db.prepare(`SELECT estimate_id FROM invoices WHERE id = ? AND company_id = ?`)
        .bind(invoiceId, companyId).first<{ estimate_id: string | null }>()
      estimateId = inv?.estimate_id ?? null
    }
    if (!estimateId) return // not every invoice traces back to an estimate/opportunity

    const est = await db.prepare(`SELECT opp_id FROM estimates WHERE id = ? AND company_id = ?`)
      .bind(estimateId, companyId).first<{ opp_id: string | null }>()
    if (!est?.opp_id) return

    await db.prepare(`UPDATE opportunities SET collected = 1 WHERE id = ? AND company_id = ?`)
      .bind(est.opp_id, companyId).run()
  } catch (e) {
    console.error('markOpportunityCollectedFromInvoice failed (non-blocking)', invoiceId, e)
  }
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

  // Company suspension check — clearer than letting every later call 403
  try {
    const co = await c.env.DB.prepare('SELECT active FROM companies WHERE id = ? LIMIT 1').bind(rep.company_id).first<any>()
    if (co && co.active === 0 && !rep.is_super_admin) {
      return err(c, 'This account has been suspended. Please contact support.', 403)
    }
  } catch (_) {}

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
  const repId = c.var.repId as string
  const [repsResult, rolesResult, stagesRow, navPermsRow, myRepRow] = await Promise.all([
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
    ).bind(`${companyId}:nav_perms`).first<{ value: string }>(),
    // fetch current rep's preferred_language
    c.env.DB.prepare(
      'SELECT preferred_language FROM reps WHERE id = ? AND company_id = ? LIMIT 1'
    ).bind(repId, companyId).first<{ preferred_language: string }>()
  ])

  const defaultStages = [
    "Lead Intake / Rapport","Mutual Agreement Set","Discovery / CBR Uncovered",
    "Budget & Investment Qualified","Decision Process Qualified",
    "Presentation & SOW Pitch","Deal Closed / Won","On Hold","Closed Lost"
  ]
  const defaultNavPerms = {
    admin: ['today','myDashboard','teamView','pipeline','lead','clients','properties','estimates','proposals','communications','textMessages','templates','sequences','talkTracks','playbooks','aiAssist','automations','campaigns','process','forms','scripts','emailTemplates','objections','calculator','ai','academy','financialHub','invoices','payments','deposits','statements','financialActivity','scheduleBoard','dispatchBoard','recurringServices','crewView','workOrderList','workOrderDetail','assetsHub','assetList','assetDetail','maintenanceQueue','inventoryList','materialAllocation','toolsConsumables','timeTracker','revenueAdmin','teamReports','settings','userManagement','integrations','manager','systemConfig','systemTemplates','opsHub','pricing'],
    office_manager: ['today','myDashboard','teamView','pipeline','lead','clients','properties','estimates','proposals','communications','textMessages','templates','sequences','talkTracks','playbooks','aiAssist','automations','campaigns','process','forms','scripts','emailTemplates','objections','calculator','ai','academy','financialHub','invoices','payments','deposits','statements','financialActivity','scheduleBoard','dispatchBoard','recurringServices','crewView','workOrderList','workOrderDetail','assetsHub','assetList','assetDetail','maintenanceQueue','inventoryList','materialAllocation','toolsConsumables','timeTracker','revenueAdmin','teamReports','settings','userManagement','integrations','manager','pricing'],
    rep: ['today','myDashboard','pipeline','lead','clients','properties','estimates','proposals','communications','textMessages','templates','sequences','talkTracks','playbooks','aiAssist','automations','campaigns','process','forms','scripts','emailTemplates','objections','calculator','ai','academy'],
    estimator: ['today','pipeline','clients','properties','estimates','proposals','calculator','forms','playbooks'],
    foreman: ['today','myDashboard','scheduleBoard','dispatchBoard','recurringServices','crewView','workOrderList','workOrderDetail','assetsHub','assetList','assetDetail','maintenanceQueue','inventoryList','toolsConsumables','timeTracker','teamReports','approvalQueue','fieldMode'],
    laborer: ['today','scheduleBoard','workOrderList','assetsHub','timeTracker','fieldMode'],
    mechanic: ['today','fieldDashboard','assetsHub','assetList','assetDetail','maintenanceQueue','inventoryList','toolsConsumables','timeTracker'],
    division_manager: ['today','fieldDashboard','myDashboard','scheduleBoard','dispatchBoard','recurringServices','crewView','workOrderList','workOrderDetail','assetsHub','assetList','assetDetail','maintenanceQueue','inventoryList','toolsConsumables','timeTracker','teamReports','approvalQueue','fieldMode','userManagement'],
    view_only: ['today','pipeline'],
    // Legacy alias — D1 rows where role='field_supervisor' still resolve correctly
    field_supervisor: ['today','myDashboard','scheduleBoard','dispatchBoard','recurringServices','crewView','workOrderList','workOrderDetail','assetsHub','assetList','assetDetail','maintenanceQueue','inventoryList','toolsConsumables','timeTracker','teamReports','approvalQueue','fieldMode']
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

  // Company + trial + email-verification status (columns may not exist pre-migration)
  let company: any = null
  try {
    company = await c.env.DB.prepare(
      'SELECT id, name, plan, subscription_status, trial_expires_at, active, onboarding_completed, logo_url, brand_color, brand_accent FROM companies WHERE id = ? LIMIT 1'
    ).bind(companyId).first()
  } catch (_) {
    try {
      company = await c.env.DB.prepare('SELECT id, name, plan, active, logo_url, brand_color FROM companies WHERE id = ? LIMIT 1').bind(companyId).first()
    } catch (_) {}
  }
  const verifiedRow = await c.env.DB.prepare('SELECT value FROM settings WHERE key = ? LIMIT 1')
    .bind(`${companyId}:email_verified_${repId}`).first<{ value: string }>()

  const publishedProcess = await c.env.DB.prepare(`SELECT v.* FROM sales_process_versions v
    JOIN sales_processes p ON p.id=v.process_id AND p.company_id=v.company_id
    WHERE v.company_id=? AND v.lifecycle='published' ORDER BY v.published_at DESC LIMIT 1`).bind(companyId).first<any>()
  const publishedStages = publishedProcess
    ? await c.env.DB.prepare('SELECT * FROM sales_process_stages WHERE company_id=? AND process_version_id=? AND state=\'active\' ORDER BY display_order').bind(companyId, publishedProcess.id).all<any>()
    : { results: [] }

  return json(c, {
    reps: repsResult.results || [],
    roles,
    pipelineStages: stages,
    navPerms,
    company,
    salesProcess: publishedProcess ? { process: publishedProcess, stages: publishedStages.results || [] } : null,
    // Include the logged-in rep's language preference so the i18n engine can hydrate on bootstrap
    rep: { preferred_language: myRepRow?.preferred_language || 'en', email_verified: !!verifiedRow }
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// COMPANIES  (super-admin only in future; open for now to bootstrap)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/companies/:id  — read own company info
app.get('/api/companies/:id', requireAuth, async (c) => {
  const id = c.req.param('id')
  if (id !== (c.var.companyId as string) && !c.var.isSuperAdmin) return err(c, 'Forbidden', 403)
  const row = await c.env.DB.prepare(
    'SELECT id, name, slug, plan, phone, website, logo_url, timezone, trial_ends_at, active, created_at FROM companies WHERE id = ? LIMIT 1'
  ).bind(id).first()
  if (!row) return err(c, 'Company not found', 404)
  return json(c, row)
})

// PUT /api/companies/:id  — update own company (admin/office_manager only)
app.put('/api/companies/:id', requireAuth, async (c) => {
  const id = c.req.param('id')
  if (id !== (c.var.companyId as string) && !c.var.isSuperAdmin) return err(c, 'Forbidden', 403)
  const role = c.var.role as string
  if (!c.var.isSuperAdmin && role !== 'admin' && role !== 'office_manager') return err(c, 'Forbidden', 403)
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
  // Optional per-company branding via ?slug= or ?company= — otherwise neutral
  // platform branding. (Multi-tenant: never leak one arbitrary tenant's brand.)
  const slug = c.req.query('slug') || c.req.query('company') || ''
  if (slug) {
    const row: any = await db.prepare(
      `SELECT name, logo_url, brand_color FROM companies WHERE (slug = ? OR id = ?) AND active = 1 LIMIT 1`
    ).bind(slug, slug).first()
    if (row) {
      return c.json({
        name:        row.name        || 'Groundwork',
        logo_url:    row.logo_url    || '',
        brand_color: row.brand_color || '#2D7A55',
      })
    }
  }
  return c.json({ name: 'Groundwork', logo_url: '', brand_color: '#2D7A55' })
})

// GET /api/branding/logo/:id — PUBLIC: serves the company logo as a real image.
// The CRM stores uploaded logos as base64 data: URLs in companies.logo_url;
// email clients (Gmail/Outlook) strip data: images, so branded emails reference
// this endpoint instead. Logos are already public-facing (login page, portal).
app.get('/api/branding/logo/:id', async (c) => {
  const db = c.env.DB as D1Database
  const id = c.req.param('id')
  const row: any = await db.prepare(
    `SELECT logo_url FROM companies WHERE (id = ? OR slug = ?) AND active = 1 LIMIT 1`
  ).bind(id, id).first().catch(() => null)
  const lu = ((row && row.logo_url) || '').trim()
  if (!lu) return c.notFound()
  // Hosted URL — just redirect
  if (/^https?:\/\//.test(lu)) return c.redirect(lu, 302)
  // Base64 data URL — decode and serve as binary with caching
  const m = lu.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/)
  if (!m) return c.notFound()
  try {
    const b64 = m[2].replace(/\s/g, '')
    const bin = Uint8Array.from(atob(b64), (ch: string) => ch.charCodeAt(0))
    return new Response(bin, {
      headers: {
        'Content-Type': m[1],
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch {
    return c.notFound()
  }
})

// GET /api/company/branding  — full branding/identity for authenticated company
app.get('/api/company/branding', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
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
  const companyId = c.var.companyId as string
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
app.post('/api/companies', requireSuperAdmin, async (c) => {
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
  const companyId = c.var.companyId as string
  const rows = await c.env.DB.prepare(
    'SELECT id, name, title, role, color, commission_plan, active, company_id, email, email_signature, invite_accepted, invite_sent_at FROM reps WHERE company_id = ? ORDER BY active DESC, name'
  ).bind(companyId).all()
  return json(c, rows.results)
})

// GET /api/reps/:id
app.get('/api/reps/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
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
// Guards: admins edit anyone; office managers edit non-admins (and cannot grant
// admin); everyone else may only edit their OWN safe profile fields.
app.put('/api/reps/:id', requireAuth, async (c) => {
  const id = c.req.param('id')
  const b  = await c.req.json()
  const companyId = c.var.companyId as string
  const sessionRole = c.var.role as string
  const sessionRepId = c.var.repId as string
  const isSuper = !!c.var.isSuperAdmin
  const isMgr = sessionRole === 'admin' || sessionRole === 'office_manager' || isSuper
  const isSelf = id === sessionRepId
  if (!isMgr && !isSelf) return err(c, 'You can only edit your own profile', 403)
  const PRIVILEGED = ['role', 'active', 'commission_plan']
  if (!isMgr) {
    for (const f of PRIVILEGED) if (b[f] !== undefined) return err(c, 'Not allowed to change ' + f, 403)
  }
  if (sessionRole === 'office_manager' && !isSuper) {
    // OM cannot grant admin, and cannot modify an existing admin account
    if (b.role === 'admin') return err(c, 'Only an admin can grant the admin role', 403)
    const target = await c.env.DB.prepare(
      'SELECT role FROM reps WHERE id = ? AND company_id = ? LIMIT 1'
    ).bind(id, companyId).first<{ role: string }>()
    if (target && target.role === 'admin' && !isSelf) return err(c, 'Only an admin can edit an admin account', 403)
  }
  // Password changes: self, or a manager resetting a team member
  if ((b.password || b.pin) && !isSelf && !isMgr) return err(c, 'Not allowed to change passwords', 403)
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

// ------------------------------------------------------------------------------
// VERSIONED SALES PROCESS
// Normalized process endpoints are additive. The legacy pipeline-stage setting
// remains authoritative until an administrator explicitly publishes a fully
// reviewed version. Platform CRM leads in gw_leads are intentionally never read.
// ------------------------------------------------------------------------------

const SALES_PROCESS_ADMIN_ROLES = new Set(['admin', 'office_manager', 'sales_manager'])
const LEGACY_STAGE_MAP: Record<string, string> = {
  'Lead Intake / Rapport': 'new_lead',
  'Mutual Agreement Set': 'connect_qualify',
  'Discovery / CBR Uncovered': 'connect_qualify',
  'Budget & Investment Qualified': 'connect_qualify',
  'Decision Process Qualified': 'connect_qualify',
  'On Hold': 'decision_pending',
  'Deal Closed / Won': 'closed',
  'Sold / Activation': 'closed',
  'Closed Lost': 'closed'
}

function requireSalesProcessAdmin(c: any) {
  return SALES_PROCESS_ADMIN_ROLES.has(String(c.var.role || ''))
}

async function resolveSalesOpportunityStage(db: any, companyId: string, opportunityId: string) {
  const opportunity = await db.prepare(
    'SELECT id,status,pipeline_stage,sales_process_stage_id FROM opportunities WHERE id=? AND company_id=?'
  ).bind(opportunityId, companyId).first<any>()
  if (!opportunity) return null
  const published = await db.prepare(`SELECT v.id FROM sales_process_versions v
    JOIN sales_processes p ON p.id=v.process_id AND p.company_id=v.company_id
    WHERE v.company_id=? AND v.lifecycle='published' ORDER BY v.published_at DESC LIMIT 1`).bind(companyId).first<any>()
  if (published) {
    const assignment = await db.prepare(`SELECT a.*,s.stable_key,s.display_name,s.semantic_type
      FROM sales_stage_assignments a JOIN sales_process_stages s
        ON s.id=a.stage_id AND s.company_id=a.company_id AND s.process_version_id=a.process_version_id
      WHERE a.company_id=? AND a.opportunity_id=? AND a.process_version_id=?`)
      .bind(companyId, opportunityId, published.id).first<any>()
    if (assignment) return { resolution: 'stable_assignment', resolved: true, ...assignment }
    const mapping = await db.prepare(`SELECT m.*,s.stable_key,s.display_name,s.semantic_type
      FROM sales_migration_mappings m JOIN sales_process_stages s
        ON s.id=m.final_stage_id AND s.company_id=m.company_id AND s.process_version_id=m.process_version_id
      WHERE m.company_id=? AND m.opportunity_id=? AND m.process_version_id=? AND m.review_state='approved'
      ORDER BY m.reviewed_at DESC LIMIT 1`).bind(companyId, opportunityId, published.id).first<any>()
    if (mapping) return { resolution: 'approved_mapping', resolved: true, ...mapping }
    return { resolution: 'needs_restaging', resolved: false, opportunity_id: opportunityId, original_label: opportunity.status || opportunity.pipeline_stage || '' }
  }
  const label = String(opportunity.status || opportunity.pipeline_stage || '')
  const stableKey = LEGACY_STAGE_MAP[label]
  return stableKey
    ? { resolution: 'approved_legacy_mapping', resolved: true, opportunity_id: opportunityId, stable_key: stableKey, original_label: label }
    : { resolution: 'needs_restaging', resolved: false, opportunity_id: opportunityId, original_label: label }
}

app.get('/api/opportunities/:id/sales-process-resolution', requireAuth, async (c) => {
  const resolution = await resolveSalesOpportunityStage(c.env.DB, c.var.companyId as string, c.req.param('id'))
  return resolution ? json(c, resolution) : err(c, 'Opportunity not found', 404)
})

// Keep the published-process stage assignment in step with legacy status-label
// writes (board drag-and-drop, lead form, record editing). When the new status
// label matches an active stage of the published version, the opportunity's
// stable assignment and sales_process_stage_id follow it. Unknown labels leave
// the assignment untouched, so Needs Restaging semantics are preserved.
// The platform-level leads table is intentionally never read or written here.
async function syncPublishedStageAssignment(db: D1Database, companyId: string, opportunityId: string, statusLabel: string, actorId: string) {
  const label = String(statusLabel || '').trim()
  if (!label) return
  const published = await db.prepare(`SELECT v.id FROM sales_process_versions v
    JOIN sales_processes p ON p.id=v.process_id AND p.company_id=v.company_id
    WHERE v.company_id=? AND v.lifecycle='published' ORDER BY v.published_at DESC LIMIT 1`).bind(companyId).first<any>()
  if (!published) return
  const stage = await db.prepare(`SELECT * FROM sales_process_stages
    WHERE company_id=? AND process_version_id=? AND state='active'
      AND (board_label=? OR display_name=?) ORDER BY display_order LIMIT 1`)
    .bind(companyId, published.id, label, label).first<any>()
  if (!stage) return
  const terminal = ['won', 'lost', 'disqualified', 'nurture', 'terminal'].includes(String(stage.semantic_type))
  let outcomeType = ''
  if (terminal) {
    const outcome = await db.prepare(`SELECT semantic_type FROM sales_stage_outcomes
      WHERE company_id=? AND process_version_id=? AND stage_id=? AND active=1 LIMIT 1`)
      .bind(companyId, published.id, stage.id).first<any>()
    outcomeType = String(outcome?.semantic_type || stage.semantic_type)
    if (!['won', 'lost', 'disqualified', 'nurture'].includes(outcomeType)) outcomeType = ''
  }
  await db.batch([
    db.prepare(`INSERT INTO sales_stage_assignments (id,company_id,opportunity_id,process_version_id,stage_id,classification,outcome_type,assigned_by)
      VALUES (?,?,?,?,?,'status_synced',?,?)
      ON CONFLICT(company_id,opportunity_id,process_version_id)
      DO UPDATE SET stage_id=excluded.stage_id,outcome_type=excluded.outcome_type,classification='status_synced',assigned_at=datetime('now'),assigned_by=excluded.assigned_by`)
      .bind(`asg_${uid()}`, companyId, opportunityId, published.id, stage.id, outcomeType, actorId),
    db.prepare('UPDATE opportunities SET sales_process_stage_id=?,updated_at=updated_at WHERE id=? AND company_id=?')
      .bind(stage.id, opportunityId, companyId)
  ])
}

app.get('/api/sales-process/templates', requireAuth, async (c) => {
  const rows = await c.env.DB.prepare(`
    SELECT p.id, p.name, p.description, v.id AS version_id, v.version_number
    FROM sales_processes p
    JOIN sales_process_versions v ON v.process_id = p.id AND v.company_id = p.company_id
    WHERE p.company_id = '__global__' AND p.is_template = 1 AND p.is_immutable = 1
      AND v.version_number = (
        SELECT MAX(v2.version_number) FROM sales_process_versions v2
        WHERE v2.process_id = p.id AND v2.company_id = p.company_id
      )
    ORDER BY p.name
  `).all()
  return json(c, rows.results)
})

app.get('/api/sales-process', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const versions = await c.env.DB.prepare(`
    SELECT v.*, p.name, p.description
    FROM sales_process_versions v JOIN sales_processes p
      ON p.id = v.process_id AND p.company_id = v.company_id
    WHERE v.company_id = ? ORDER BY v.version_number DESC
  `).bind(companyId).all()
  const selected = String(c.req.query('version_id') || '')
  const version = (versions.results as any[]).find(v => v.id === selected)
    || (versions.results as any[]).find(v => v.lifecycle === 'published')
    || (versions.results as any[]).find(v => v.lifecycle === 'draft') || null
  if (!version) return json(c, { process: null, versions: [], stages: [], requirements: [], guides: [], resources: [] })
  const [stages, statuses, outcomes, requirements, guides, resources, transitions, automations, skills, associations, suggestions, publications] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM sales_process_stages WHERE company_id = ? AND process_version_id = ? ORDER BY display_order').bind(companyId, version.id).all(),
    c.env.DB.prepare('SELECT * FROM sales_stage_internal_statuses WHERE company_id = ? AND process_version_id = ? ORDER BY stage_id, display_order').bind(companyId, version.id).all(),
    c.env.DB.prepare('SELECT * FROM sales_stage_outcomes WHERE company_id = ? AND process_version_id = ? ORDER BY stable_key').bind(companyId, version.id).all(),
    c.env.DB.prepare('SELECT * FROM sales_stage_requirements WHERE company_id = ? AND process_version_id = ? ORDER BY stage_id, display_order').bind(companyId, version.id).all(),
    c.env.DB.prepare('SELECT * FROM sales_stage_guides WHERE company_id = ? AND process_version_id = ? ORDER BY stage_id, display_order').bind(companyId, version.id).all(),
    c.env.DB.prepare('SELECT * FROM sales_process_resources WHERE company_id = ? AND process_version_id = ? ORDER BY resource_type, name').bind(companyId, version.id).all(),
    c.env.DB.prepare(`SELECT id,company_id,process_version_id,from_stage_id,to_stage_id,requires_override,active,created_at,outcome_type,display_label,guidance,display_order,override_policy,created_by,updated_by,updated_at
      FROM sales_stage_transition_paths WHERE company_id=? AND process_version_id=? AND active=1
      UNION ALL SELECT id,company_id,process_version_id,from_stage_id,to_stage_id,requires_override,active,created_at,outcome_type,display_label,guidance,display_order,override_policy,created_by,updated_by,updated_at
      FROM sales_stage_transitions WHERE company_id=? AND process_version_id=? AND active=1
      AND NOT EXISTS (SELECT 1 FROM sales_stage_transition_paths WHERE company_id=? AND process_version_id=?)`)
      .bind(companyId, version.id, companyId, version.id, companyId, version.id).all(),
    c.env.DB.prepare('SELECT * FROM sales_process_automations WHERE company_id=? AND process_version_id=? ORDER BY name').bind(companyId, version.id).all(),
    c.env.DB.prepare("SELECT * FROM sales_academy_skills WHERE active=1 AND (company_id=? OR (company_id='__global__' AND is_global=1)) ORDER BY title").bind(companyId).all(),
    c.env.DB.prepare('SELECT * FROM sales_academy_associations WHERE company_id=? AND process_version_id=? ORDER BY display_order').bind(companyId, version.id).all(),
    c.env.DB.prepare('SELECT * FROM sales_ai_suggestions WHERE company_id=? AND process_version_id=? ORDER BY created_at DESC').bind(companyId, version.id).all(),
    c.env.DB.prepare('SELECT * FROM sales_process_publications WHERE company_id=? AND process_id=? ORDER BY created_at DESC').bind(companyId, version.process_id).all()
  ])
  // Migration batch context so the builder can resume a review across page
  // loads instead of forcing a fresh proposal each session. The batch backing
  // the version's approved snapshot wins (it is the publish-ready one);
  // otherwise fall back to the most recently proposed batch.
  const snapshotBatch = version.approved_snapshot_id ? await c.env.DB.prepare(
    "SELECT migration_batch_id FROM sales_migration_snapshots WHERE id=? AND company_id=? AND process_version_id=? AND state='approved'"
  ).bind(version.approved_snapshot_id, companyId, version.id).first<any>() : null
  const resumeBatchId = snapshotBatch?.migration_batch_id ? String(snapshotBatch.migration_batch_id) : ''
  const latestMigration = await c.env.DB.prepare(`SELECT migration_batch_id AS batch_id, COUNT(*) AS total,
      SUM(CASE WHEN review_state!='approved' OR final_stage_id='' THEN 1 ELSE 0 END) AS pending
    FROM sales_migration_mappings WHERE company_id=? AND process_version_id=?
      AND migration_batch_id=CASE WHEN ?!='' THEN ? ELSE (SELECT migration_batch_id FROM sales_migration_mappings
        WHERE company_id=? AND process_version_id=? ORDER BY created_at DESC LIMIT 1) END`)
    .bind(companyId, version.id, resumeBatchId, resumeBatchId, companyId, version.id).first<any>()
  const migrationContext = latestMigration?.batch_id ? { ...latestMigration, snapshot_approved: Boolean(resumeBatchId && resumeBatchId === latestMigration.batch_id) } : null
  return json(c, { process: version, versions: versions.results, stages: stages.results, internal_statuses: statuses.results, outcomes: outcomes.results, requirements: requirements.results, guides: guides.results, resources: resources.results, automations: automations.results, transitions: transitions.results, academy_skills: skills.results, academy_associations: associations.results, ai_suggestions: suggestions.results, publications: publications.results, latest_migration: migrationContext })
})

// Copy-on-adopt guarantees that tenant edits can never mutate the global template.
app.post('/api/sales-process/drafts/from-template', requireAuth, async (c) => {
  if (!requireSalesProcessAdmin(c)) return err(c, 'Administrator or sales manager access required', 403)
  const companyId = c.var.companyId as string
  const actorId = c.var.repId as string
  const body = await c.req.json()
  const templateVersionId = String(body.template_version_id || 'tpl_groundwork_field_service_v2')
  const template = await c.env.DB.prepare(`
    SELECT v.*, p.name, p.description FROM sales_process_versions v
    JOIN sales_processes p ON p.id = v.process_id AND p.company_id = v.company_id
    WHERE v.id = ? AND v.company_id = '__global__' AND p.is_template = 1 AND p.is_immutable = 1
  `).bind(templateVersionId).first<any>()
  if (!template) return err(c, 'Template not found', 404)
  const now = Date.now().toString(36)
  const processId = `sp_${now}_${uid().slice(0, 6)}`
  const versionId = `${processId}_v1`
  const templateStages = await c.env.DB.prepare(
    'SELECT * FROM sales_process_stages WHERE company_id = ? AND process_version_id = ? ORDER BY display_order'
  ).bind('__global__', templateVersionId).all<any>()
  if (!templateStages.results.length) return err(c, 'Template version has no stages', 409)
  const statements: any[] = [
    c.env.DB.prepare(`INSERT INTO sales_processes (id,company_id,name,description,source_template_id,created_by) VALUES (?,?,?,?,?,?)`)
      .bind(processId, companyId, String(body.name || template.name), template.description || '', template.process_id, actorId),
    c.env.DB.prepare(`INSERT INTO sales_process_versions (id,company_id,process_id,version_number,lifecycle,based_on_version_id,created_by) VALUES (?,?,?,1,'draft',?,?)`)
      .bind(versionId, companyId, processId, templateVersionId, actorId)
  ]
  for (const source of templateStages.results as any[]) {
    const stageId = `${versionId}_${source.stable_key}`
    statements.push(c.env.DB.prepare(`
      INSERT INTO sales_process_stages
      (id,company_id,process_version_id,stable_key,display_name,board_label,description,customer_milestone,semantic_type,display_order,state,expected_duration_days,entry_guidance,exit_guidance,manager_override_policy,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(stageId, companyId, versionId, source.stable_key, source.display_name, source.board_label,
      source.description, source.customer_milestone, source.semantic_type, source.display_order, source.state,
      source.expected_duration_days, source.entry_guidance, source.exit_guidance, source.manager_override_policy, actorId))
  }
  const stageIdByTemplateId = new Map((templateStages.results as any[]).map(source => [source.id, `${versionId}_${source.stable_key}`]))
  const templateOutcomes = await c.env.DB.prepare('SELECT * FROM sales_stage_outcomes WHERE company_id=? AND process_version_id=?').bind('__global__', templateVersionId).all<any>()
  for (const outcome of templateOutcomes.results as any[]) {
    const destinationStageId = stageIdByTemplateId.get(outcome.stage_id)
    if (!destinationStageId) return err(c, 'Template outcome references an unknown stage', 409)
    statements.push(c.env.DB.prepare(`INSERT INTO sales_stage_outcomes (id,company_id,process_version_id,stage_id,stable_key,display_name,semantic_type,config_json) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(`${versionId}_outcome_${outcome.stable_key}`, companyId, versionId, destinationStageId, outcome.stable_key, outcome.display_name, outcome.semantic_type, outcome.config_json || '{}'))
  }
  const copyDefinitions = [
    { table: 'sales_stage_internal_statuses', columns: ['stable_key','display_name','display_order','active'] },
    { table: 'sales_stage_requirements', columns: ['requirement_type','stable_key','label','description','required_level','display_order','config_json'] },
    { table: 'sales_stage_guides', columns: ['guide_type','interaction_type','title','purpose','suggested_language','completion_guidance','display_order','config_json'] },
    { table: 'sales_process_resources', columns: ['resource_type','stable_key','name','content_json','active'] },
    { table: 'sales_process_automations', columns: ['name','trigger_type','action_type','config_json','active'] }
  ]
  for (const definition of copyDefinitions) {
    const sourceRows = await c.env.DB.prepare(`SELECT * FROM ${definition.table} WHERE company_id=? AND process_version_id=?`).bind('__global__', templateVersionId).all<any>()
    for (const source of sourceRows.results as any[]) {
      const columns = ['id','company_id','process_version_id','stage_id', ...definition.columns]
      const values = [`${versionId}_${definition.table}_${uid()}`, companyId, versionId, source.stage_id ? stageIdByTemplateId.get(source.stage_id) || '' : '', ...definition.columns.map(column => source[column])]
      statements.push(c.env.DB.prepare(`INSERT INTO ${definition.table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).bind(...values))
    }
  }
  let templateTransitions = await c.env.DB.prepare('SELECT * FROM sales_stage_transition_paths WHERE company_id=? AND process_version_id=?').bind('__global__', templateVersionId).all<any>()
  if (!templateTransitions.results.length) templateTransitions = await c.env.DB.prepare('SELECT * FROM sales_stage_transitions WHERE company_id=? AND process_version_id=?').bind('__global__', templateVersionId).all<any>()
  if (!templateTransitions.results.length) return err(c, 'Template version has no transition graph; choose the latest template version', 409)
  for (const transition of templateTransitions.results as any[]) {
    const fromStageId = stageIdByTemplateId.get(transition.from_stage_id)
    const toStageId = stageIdByTemplateId.get(transition.to_stage_id)
    if (!fromStageId || !toStageId) return err(c, 'Template transition references an unknown stage', 409)
    statements.push(c.env.DB.prepare(`INSERT INTO sales_stage_transition_paths
      (id,company_id,process_version_id,from_stage_id,to_stage_id,requires_override,active,outcome_type,display_label,guidance,display_order,override_policy,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(`${versionId}_transition_${uid()}`, companyId, versionId,
      fromStageId, toStageId,
      transition.requires_override || 0, transition.active, transition.outcome_type || '', transition.display_label || '',
      transition.guidance || '', transition.display_order || 0, transition.override_policy || 'stage_policy', actorId))
  }
  const templateAssociations = await c.env.DB.prepare('SELECT * FROM sales_academy_associations WHERE company_id=? AND process_version_id=?').bind('__global__', templateVersionId).all<any>()
  for (const association of templateAssociations.results as any[]) {
    const destinationStageId = association.stage_id ? stageIdByTemplateId.get(association.stage_id) : ''
    if (association.stage_id && !destinationStageId) return err(c, 'Template Academy association references an unknown stage', 409)
    statements.push(c.env.DB.prepare(`INSERT INTO sales_academy_associations
      (id,company_id,process_version_id,stage_id,internal_status_id,skill_id,visibility,display_order)
      VALUES (?,?,?,?,?,?,?,?)`).bind(`${versionId}_academy_${uid()}`, companyId, versionId, destinationStageId || '', '',
      association.skill_id, association.visibility || 'representative', association.display_order || 0))
  }
  await c.env.DB.batch(statements)
  await logActivity(c.env.DB, { companyId, actorId, actorName: actorId, entityType: 'sales_process', entityId: processId, entityLabel: String(body.name || template.name), action: 'draft_created', afterJson: { versionId, templateVersionId } })
  return json(c, { process_id: processId, version_id: versionId, lifecycle: 'draft' }, 201)
})

// Start a draft directly from the company's live pipeline stage labels so an
// administrator can tune the current board without adopting a template first.
// The generated draft is validation-complete: inferred semantic types, terminal
// won and lost stages, per-terminal outcomes, and an open transition graph.
app.post('/api/sales-process/drafts/from-current-pipeline', requireAuth, async (c) => {
  if (!requireSalesProcessAdmin(c)) return err(c, 'Administrator or sales manager access required', 403)
  const companyId = c.var.companyId as string
  const actorId = c.var.repId as string
  const body = await c.req.json().catch(() => ({}))
  const stagesRow = await c.env.DB.prepare('SELECT value FROM settings WHERE key=? LIMIT 1').bind(`${companyId}:pipeline_stages`).first<{ value: string }>()
  let labels: string[] = []
  try { if (stagesRow?.value) labels = JSON.parse(stagesRow.value) } catch (_) {}
  if (!Array.isArray(labels) || labels.length < 2) labels = [
    'Lead Intake / Rapport','Mutual Agreement Set','Discovery / CBR Uncovered',
    'Budget & Investment Qualified','Decision Process Qualified',
    'Presentation & SOW Pitch','Deal Closed / Won','On Hold','Closed Lost'
  ]
  labels = labels.map(l => String(l).trim()).filter(Boolean)
  const slug = (label: string, index: number) => {
    const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    return base ? `${base}_${index + 1}` : `stage_${index + 1}`
  }
  const inferSemantic = (label: string, index: number): string => {
    const lower = label.toLowerCase()
    if (/\bwon\b|\bsold\b|activation/.test(lower)) return 'won'
    if (/\blost\b/.test(lower)) return 'lost'
    if (index === 0) return 'intake'
    if (/proposal|estimate|presentation|pitch|sow/.test(lower)) return 'proposal_presentation'
    if (/hold|follow|decision/.test(lower)) return 'decision'
    return 'active_qualification'
  }
  const now = Date.now().toString(36)
  const processId = `sp_${now}_${uid().slice(0, 6)}`
  const versionId = `${processId}_v1`
  const terminalSemantics = new Set(['won', 'lost', 'disqualified', 'nurture', 'terminal'])
  const draftStages = labels.map((label, index) => ({
    id: `${versionId}_${slug(label, index)}`,
    stable_key: slug(label, index),
    display_name: label,
    semantic: inferSemantic(label, index)
  }))
  // Guarantee validation gates: an intake stage plus won and lost terminals.
  if (!draftStages.some(s => s.semantic === 'intake')) draftStages[0].semantic = 'intake'
  if (!draftStages.some(s => s.semantic === 'won')) draftStages.push({ id: `${versionId}_stage_won`, stable_key: 'stage_won', display_name: 'Won', semantic: 'won' })
  if (!draftStages.some(s => s.semantic === 'lost')) draftStages.push({ id: `${versionId}_stage_lost`, stable_key: 'stage_lost', display_name: 'Lost', semantic: 'lost' })
  const statements: any[] = [
    c.env.DB.prepare('INSERT INTO sales_processes (id,company_id,name,description,source_template_id,created_by) VALUES (?,?,?,?,?,?)')
      .bind(processId, companyId, String(body.name || 'Company Sales Process'), 'Draft created from the live pipeline stages', '', actorId),
    c.env.DB.prepare("INSERT INTO sales_process_versions (id,company_id,process_id,version_number,lifecycle,based_on_version_id,created_by) VALUES (?,?,?,1,'draft','',?)")
      .bind(versionId, companyId, processId, actorId)
  ]
  draftStages.forEach((stage, index) => {
    statements.push(c.env.DB.prepare(`INSERT INTO sales_process_stages
      (id,company_id,process_version_id,stable_key,display_name,board_label,description,customer_milestone,semantic_type,display_order,state,expected_duration_days,entry_guidance,exit_guidance,manager_override_policy,created_by)
      VALUES (?,?,?,?,?,?,'','',?,?,'active',0,'','','allowed_with_reason',?)`)
      .bind(stage.id, companyId, versionId, stage.stable_key, stage.display_name, stage.display_name, stage.semantic, index + 1, actorId))
    if (terminalSemantics.has(stage.semantic)) {
      statements.push(c.env.DB.prepare(`INSERT INTO sales_stage_outcomes (id,company_id,process_version_id,stage_id,stable_key,display_name,semantic_type,config_json) VALUES (?,?,?,?,?,?,?,'{}')`)
        .bind(`${versionId}_outcome_${stage.stable_key}`, companyId, versionId, stage.id, `outcome_${stage.stable_key}`, stage.display_name, stage.semantic))
    }
  })
  // Open transition graph: every non-terminal stage can reach every other stage,
  // mirroring the freedom of the legacy drag-and-drop board.
  let transitionOrder = 0
  for (const from of draftStages) {
    if (terminalSemantics.has(from.semantic)) continue
    for (const to of draftStages) {
      if (from.id === to.id) continue
      transitionOrder += 1
      statements.push(c.env.DB.prepare(`INSERT INTO sales_stage_transition_paths
        (id,company_id,process_version_id,from_stage_id,to_stage_id,outcome_type,display_label,guidance,active,display_order,override_policy,requires_override,created_by)
        VALUES (?,?,?,?,?,?,'','',1,?,'allowed_with_reason',0,?)`)
        .bind(`${versionId}_transition_${transitionOrder}`, companyId, versionId, from.id, to.id, terminalSemantics.has(to.semantic) ? to.semantic : '', transitionOrder, actorId))
    }
  }
  await c.env.DB.batch(statements)
  await logActivity(c.env.DB, { companyId, actorId, actorName: actorId, entityType: 'sales_process', entityId: processId, entityLabel: String(body.name || 'Company Sales Process'), action: 'draft_created', afterJson: { versionId, source: 'current_pipeline', labels } })
  return json(c, { process_id: processId, version_id: versionId, lifecycle: 'draft' }, 201)
})

app.put('/api/sales-process/drafts/:versionId/stages', requireAuth, async (c) => {
  if (!requireSalesProcessAdmin(c)) return err(c, 'Administrator or sales manager access required', 403)
  const companyId = c.var.companyId as string
  const versionId = c.req.param('versionId')
  const version = await c.env.DB.prepare("SELECT * FROM sales_process_versions WHERE id=? AND company_id=? AND lifecycle='draft'").bind(versionId, companyId).first<any>()
  if (!version) return err(c, 'Editable draft not found', 404)
  const body = await c.req.json()
  const expectedRevision = Number(body.content_revision || 0)
  if (!expectedRevision || expectedRevision !== Number(version.content_revision || 1)) {
    return err(c, 'Draft changed since it was loaded', 409)
  }
  const stages = Array.isArray(body.stages) ? body.stages : []
  if (!stages.length) return err(c, 'At least one stage is required')
  const existing = await c.env.DB.prepare('SELECT id FROM sales_process_stages WHERE company_id=? AND process_version_id=?').bind(companyId, versionId).all<any>()
  const existingIds = new Set((existing.results as any[]).map(s => s.id))
  const submittedIds = new Set(stages.map((s: any) => String(s.id || '')))
  for (const stageId of existingIds) {
    if (!submittedIds.has(stageId)) {
      const occupied = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM sales_stage_assignments WHERE company_id=? AND stage_id=?').bind(companyId, stageId).first<any>()
      if (Number(occupied?.n || 0) > 0) return err(c, 'A stage containing opportunities cannot be deleted; map or restage them first', 409)
    }
  }
  for (const stage of stages) if (stage.state === 'archived' && existingIds.has(String(stage.id))) {
    const occupied = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM sales_stage_assignments WHERE company_id=? AND stage_id=?').bind(companyId, String(stage.id)).first<any>()
    if (Number(occupied?.n || 0) > 0) return err(c, 'A stage containing opportunities cannot be archived; map or restage them first', 409)
  }
  const allowedSemantics = new Set(['intake','active_qualification','consultation','estimate_development','proposal_presentation','decision','terminal','won','lost','disqualified','nurture'])
  const statements: any[] = [
    c.env.DB.prepare("UPDATE sales_process_versions SET content_revision=content_revision+1,updated_at=datetime('now') WHERE id=? AND company_id=? AND lifecycle='draft' AND content_revision=?").bind(versionId, companyId, expectedRevision),
    c.env.DB.prepare("INSERT INTO sales_process_versions (id,company_id,process_id,version_number,lifecycle) SELECT id,company_id,process_id,version_number,lifecycle FROM sales_process_versions WHERE id=? AND company_id=? AND changes()=0").bind(versionId, companyId),
    c.env.DB.prepare('DELETE FROM sales_process_stages WHERE company_id=? AND process_version_id=?').bind(companyId, versionId)
  ]
  stages.forEach((stage: any, index: number) => {
    const semantic = String(stage.semantic_type || '')
    if (!allowedSemantics.has(semantic)) throw new Error(`Invalid semantic type: ${semantic}`)
    const id = existingIds.has(String(stage.id)) ? String(stage.id) : `${versionId}_${uid()}`
    statements.push(c.env.DB.prepare(`INSERT INTO sales_process_stages
      (id,company_id,process_version_id,stable_key,display_name,board_label,description,customer_milestone,semantic_type,display_order,state,expected_duration_days,entry_guidance,exit_guidance,manager_override_policy,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, companyId, versionId, String(stage.stable_key || id), String(stage.display_name || '').trim(), String(stage.board_label || ''), String(stage.description || ''), String(stage.customer_milestone || ''), semantic, index + 1, stage.state === 'archived' ? 'archived' : 'active', Number(stage.expected_duration_days || 0), String(stage.entry_guidance || ''), String(stage.exit_guidance || ''), String(stage.manager_override_policy || 'allowed_with_reason'), c.var.repId))
  })
  try { await c.env.DB.batch(statements) }
  catch (error: any) {
    if (/UNIQUE constraint|constraint failed/i.test(String(error?.message || error))) return err(c, 'Draft changed since it was loaded', 409)
    throw error
  }
  return json(c, { updated: stages.length, content_revision: expectedRevision + 1 })
})

// Field-specific Builder panels share one optimistic mutation boundary. Tables
// and columns are selected server-side; callers can never supply SQL names.
app.put('/api/sales-process/drafts/:versionId/components/:component', requireAuth, async (c) => {
  if (!requireSalesProcessAdmin(c)) return err(c, 'Administrator or sales manager access required', 403)
  const companyId = c.var.companyId as string
  const versionId = c.req.param('versionId')
  const component = c.req.param('component')
  const definitions: Record<string, { table: string, columns: string[], stageColumns: string[] }> = {
    internal_statuses: { table: 'sales_stage_internal_statuses', columns: ['stage_id','stable_key','display_name','display_order','active'], stageColumns: ['stage_id'] },
    requirements: { table: 'sales_stage_requirements', columns: ['stage_id','requirement_type','stable_key','label','description','required_level','display_order','config_json'], stageColumns: ['stage_id'] },
    guides: { table: 'sales_stage_guides', columns: ['stage_id','guide_type','interaction_type','title','purpose','suggested_language','completion_guidance','display_order','config_json'], stageColumns: ['stage_id'] },
    resources: { table: 'sales_process_resources', columns: ['stage_id','resource_type','stable_key','name','content_json','active'], stageColumns: ['stage_id'] },
    automations: { table: 'sales_process_automations', columns: ['stage_id','name','trigger_type','action_type','config_json','active'], stageColumns: ['stage_id'] },
    academy: { table: 'sales_academy_associations', columns: ['stage_id','internal_status_id','skill_id','visibility','display_order'], stageColumns: ['stage_id'] },
    transitions: { table: 'sales_stage_transition_paths', columns: ['from_stage_id','to_stage_id','requires_override','active','outcome_type','display_label','guidance','display_order','override_policy','created_by'], stageColumns: ['from_stage_id','to_stage_id'] },
    outcomes: { table: 'sales_stage_outcomes', columns: ['stage_id','stable_key','display_name','semantic_type','active','config_json'], stageColumns: ['stage_id'] }
  }
  const definition = definitions[component]
  if (!definition) return err(c, 'Unknown Builder component', 404)
  const version = await c.env.DB.prepare("SELECT * FROM sales_process_versions WHERE id=? AND company_id=? AND lifecycle='draft'").bind(versionId, companyId).first<any>()
  if (!version) return err(c, 'Editable draft not found', 404)
  const body = await c.req.json()
  const expectedRevision = Number(body.content_revision || 0)
  if (!expectedRevision || expectedRevision !== Number(version.content_revision || 1)) return err(c, 'Draft changed since it was loaded', 409)
  const items = Array.isArray(body.items) ? body.items : []
  const stageRows = await c.env.DB.prepare('SELECT id FROM sales_process_stages WHERE company_id=? AND process_version_id=?').bind(companyId, versionId).all<any>()
  const stageIds = new Set((stageRows.results as any[]).map(row => String(row.id)))
  const skillRows = component === 'academy' ? await c.env.DB.prepare("SELECT id FROM sales_academy_skills WHERE active=1 AND (company_id=? OR (company_id='__global__' AND is_global=1))").bind(companyId).all<any>() : { results: [] }
  const skillIds = new Set((skillRows.results as any[]).map(row => String(row.id)))
  for (const item of items) {
    for (const column of definition.stageColumns) if (!stageIds.has(String(item[column] || ''))) return err(c, `${component} references an unknown stage`)
    if (component === 'academy' && !skillIds.has(String(item.skill_id || ''))) return err(c, 'Academy association references an unavailable skill')
    if (component === 'outcomes' && !['won','lost','disqualified','nurture'].includes(String(item.semantic_type || ''))) return err(c, 'Invalid terminal outcome')
    if (component === 'requirements' && !['entry','exit','required','recommended','optional','manager_review'].includes(String(item.required_level || ''))) return err(c, 'Invalid requirement level')
  }
  const statements: any[] = [
    c.env.DB.prepare("UPDATE sales_process_versions SET content_revision=content_revision+1,updated_at=datetime('now') WHERE id=? AND company_id=? AND lifecycle='draft' AND content_revision=?").bind(versionId, companyId, expectedRevision),
    c.env.DB.prepare("INSERT INTO sales_process_versions (id,company_id,process_id,version_number,lifecycle) SELECT id,company_id,process_id,version_number,lifecycle FROM sales_process_versions WHERE id=? AND company_id=? AND changes()=0").bind(versionId, companyId),
    c.env.DB.prepare(`DELETE FROM ${definition.table} WHERE company_id=? AND process_version_id=?`).bind(companyId, versionId)
  ]
  items.forEach((item: any, index: number) => {
    const id = String(item.id || `${versionId}_${component}_${uid()}`)
    const values = definition.columns.map(column => column === 'created_by' ? c.var.repId : (item[column] ?? (column === 'display_order' ? index + 1 : '')))
    statements.push(c.env.DB.prepare(`INSERT INTO ${definition.table} (id,company_id,process_version_id,${definition.columns.join(',')}) VALUES (?,?,?,${definition.columns.map(() => '?').join(',')})`).bind(id, companyId, versionId, ...values))
  })
  try { await c.env.DB.batch(statements) }
  catch (error: any) {
    if (/UNIQUE constraint|constraint failed/i.test(String(error?.message || error))) return err(c, 'Draft changed since it was loaded', 409)
    throw error
  }
  return json(c, { component, updated: items.length, content_revision: expectedRevision + 1 })
})

// ── LIVE EDITING OF THE PUBLISHED PROCESS ────────────────────────────────────
// Content edits (names, order, guidance, durations, milestones, new stages)
// apply directly to the published version and cascade to the live board:
// the pipeline_stages setting is rewritten and renamed stages carry their
// leads' status/pipeline_stage text with them. Structural lead moves still
// require the draft -> review -> publish flow. Stages holding opportunities
// can never be deleted or archived here.
app.put('/api/sales-process/live/:versionId/stages', requireAuth, async (c) => {
  if (!requireSalesProcessAdmin(c)) return err(c, 'Administrator or sales manager access required', 403)
  const companyId = c.var.companyId as string
  const versionId = c.req.param('versionId')
  const version = await c.env.DB.prepare("SELECT * FROM sales_process_versions WHERE id=? AND company_id=? AND lifecycle='published'").bind(versionId, companyId).first<any>()
  if (!version) return err(c, 'Published version not found', 404)
  const body = await c.req.json()
  const expectedRevision = Number(body.content_revision || 0)
  if (!expectedRevision || expectedRevision !== Number(version.content_revision || 1)) return err(c, 'The process changed since it was loaded', 409)
  const stages = Array.isArray(body.stages) ? body.stages : []
  if (!stages.length) return err(c, 'At least one stage is required')
  const allowedSemantics = new Set(['intake','active_qualification','consultation','estimate_development','proposal_presentation','decision','terminal','won','lost','disqualified','nurture'])
  const terminalSemantics = new Set(['terminal','won','lost','disqualified','nurture'])
  for (const stage of stages) if (!allowedSemantics.has(String(stage.semantic_type || ''))) return err(c, `Invalid semantic type: ${stage.semantic_type}`)
  const activeStages = stages.filter((s: any) => s.state !== 'archived')
  if (activeStages.length < 2) return err(c, 'A live process needs at least two active stages')
  if (!activeStages.some((s: any) => String(s.semantic_type) === 'intake')) return err(c, 'One active stage must have the intake type so new leads have a home')
  if (!activeStages.some((s: any) => terminalSemantics.has(String(s.semantic_type)))) return err(c, 'At least one active closing stage (won, lost, or terminal) is required')
  const existing = await c.env.DB.prepare('SELECT * FROM sales_process_stages WHERE company_id=? AND process_version_id=?').bind(companyId, versionId).all<any>()
  const existingById = new Map((existing.results as any[]).map(s => [String(s.id), s]))
  const submittedIds = new Set(stages.map((s: any) => String(s.id || '')))
  // Occupied-stage guard for deletion and archival. Occupied CLOSING stages
  // are allowed to be removed or archived when every lead in them has a
  // recorded outcome AND the submitted list still contains active closing
  // stages that can absorb those outcomes (e.g. splitting "Closed" into
  // "Won" and "Lost"). Anything else stays blocked.
  const terminalRedistributions: { stageId: string, priorLabel: string }[] = []
  for (const [stageId, priorRow] of existingById) {
    const submitted: any = stages.find((s: any) => String(s.id) === stageId)
    if (!submitted || submitted.state === 'archived') {
      const occupied = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM sales_stage_assignments WHERE company_id=? AND stage_id=?').bind(companyId, stageId).first<any>()
      if (Number(occupied?.n || 0) > 0) {
        if (terminalSemantics.has(String((priorRow as any).semantic_type || ''))) {
          terminalRedistributions.push({ stageId, priorLabel: String((priorRow as any).display_name || stageId) })
          continue
        }
        return err(c, 'A stage that contains leads cannot be removed or archived. Move those leads first (drag them on the Pipeline board), or use a new draft with lead review for a bigger restructure.', 409)
      }
    }
  }
  const statements: any[] = [
    c.env.DB.prepare("UPDATE sales_process_versions SET content_revision=content_revision+1,updated_at=datetime('now') WHERE id=? AND company_id=? AND lifecycle='published' AND content_revision=?").bind(versionId, companyId, expectedRevision),
    c.env.DB.prepare("INSERT INTO sales_process_versions (id,company_id,process_id,version_number,lifecycle) SELECT id,company_id,process_id,version_number,lifecycle FROM sales_process_versions WHERE id=? AND company_id=? AND changes()=0").bind(versionId, companyId),
    c.env.DB.prepare('DELETE FROM sales_process_stages WHERE company_id=? AND process_version_id=?').bind(companyId, versionId)
  ]
  const finalStages: any[] = []
  let activeOrder = 0
  stages.forEach((stage: any, index: number) => {
    const isNew = !existingById.has(String(stage.id))
    const id = isNew ? `${versionId}_${uid()}` : String(stage.id)
    const label = String(stage.display_name || '').trim()
    const record = { id, isNew, label, semantic: String(stage.semantic_type), state: stage.state === 'archived' ? 'archived' : 'active' }
    finalStages.push(record)
    if (record.state === 'active') activeOrder += 1
    const prior: any = existingById.get(String(stage.id)) || {}
    statements.push(c.env.DB.prepare(`INSERT INTO sales_process_stages
      (id,company_id,process_version_id,stable_key,display_name,board_label,description,customer_milestone,semantic_type,display_order,state,expected_duration_days,entry_guidance,exit_guidance,manager_override_policy,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, companyId, versionId, String(stage.stable_key || prior.stable_key || id), label, label,
        String(stage.description ?? prior.description ?? ''), String(stage.customer_milestone ?? ''), record.semantic, index + 1, record.state,
        Number(stage.expected_duration_days || 0), String(stage.entry_guidance ?? ''), String(stage.exit_guidance ?? ''),
        String(prior.manager_override_policy || 'allowed_with_reason'), c.var.repId))
    // New terminal stages need a recordable outcome.
    if (isNew && terminalSemantics.has(record.semantic)) {
      const outcomeSemantic = ['won','lost','disqualified','nurture'].includes(record.semantic) ? record.semantic : 'won'
      statements.push(c.env.DB.prepare(`INSERT INTO sales_stage_outcomes (id,company_id,process_version_id,stage_id,stable_key,display_name,semantic_type,config_json) VALUES (?,?,?,?,?,?,?,'{}')`)
        .bind(`${versionId}_outcome_${uid()}`, companyId, versionId, id, `outcome_${uid()}`, label, outcomeSemantic))
    }
  })
  // Remove orphaned rows for deleted stages; wire new stages into the graph.
  const keptIds = finalStages.map(s => s.id)
  const keptPlaceholders = keptIds.map(() => '?').join(',')
  statements.push(c.env.DB.prepare(`DELETE FROM sales_stage_transition_paths WHERE company_id=? AND process_version_id=? AND (from_stage_id NOT IN (${keptPlaceholders}) OR to_stage_id NOT IN (${keptPlaceholders}))`).bind(companyId, versionId, ...keptIds, ...keptIds))
  statements.push(c.env.DB.prepare(`DELETE FROM sales_stage_outcomes WHERE company_id=? AND process_version_id=? AND stage_id NOT IN (${keptPlaceholders})`).bind(companyId, versionId, ...keptIds))
  let transitionOrder = 900
  for (const s of finalStages.filter(x => x.isNew && x.state === 'active')) {
    for (const other of finalStages.filter(x => x.state === 'active' && x.id !== s.id)) {
      transitionOrder += 1
      if (!terminalSemantics.has(other.semantic) || !terminalSemantics.has(s.semantic)) {
        if (!terminalSemantics.has(other.semantic)) statements.push(c.env.DB.prepare(`INSERT INTO sales_stage_transition_paths (id,company_id,process_version_id,from_stage_id,to_stage_id,outcome_type,display_label,guidance,active,display_order,override_policy,requires_override,created_by) VALUES (?,?,?,?,?,?,'','',1,?,'allowed_with_reason',0,?)`)
          .bind(`${versionId}_lt_${uid()}`, companyId, versionId, other.id, s.id, terminalSemantics.has(s.semantic) ? (['won','lost','disqualified','nurture'].includes(s.semantic) ? s.semantic : '') : '', transitionOrder, c.var.repId))
        if (!terminalSemantics.has(s.semantic)) statements.push(c.env.DB.prepare(`INSERT INTO sales_stage_transition_paths (id,company_id,process_version_id,from_stage_id,to_stage_id,outcome_type,display_label,guidance,active,display_order,override_policy,requires_override,created_by) VALUES (?,?,?,?,?,?,'','',1,?,'allowed_with_reason',0,?)`)
          .bind(`${versionId}_lt_${uid()}`, companyId, versionId, s.id, other.id, terminalSemantics.has(other.semantic) ? (['won','lost','disqualified','nurture'].includes(other.semantic) ? other.semantic : '') : '', transitionOrder + 500, c.var.repId))
      }
    }
  }
  // Live cascade: board columns follow the new labels and order; leads in a
  // renamed stage carry the new label. The platform-level leads table is never touched.
  const newLabels = finalStages.filter(s => s.state === 'active').map(s => s.label).filter(Boolean)
  if (newLabels.length >= 2) statements.push(c.env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").bind(`${companyId}:pipeline_stages`, JSON.stringify(newLabels)))
  for (const s of finalStages) {
    const prior: any = existingById.get(s.id)
    const priorLabel = prior ? String(prior.board_label || prior.display_name || '').trim() : ''
    if (prior && priorLabel && s.label && priorLabel !== s.label) {
      statements.push(c.env.DB.prepare('UPDATE opportunities SET status=?,pipeline_stage=?,updated_at=updated_at WHERE company_id=? AND sales_process_stage_id=?').bind(s.label, s.label, companyId, s.id))
    }
  }
  // Splitting or retiring a closing stage: every lead in it moves to the
  // active closing stage that matches its recorded outcome (won leads to the
  // won stage, lost to lost, and so on). Blocked when an outcome has no home.
  let redistributedLeads = 0
  if (terminalRedistributions.length) {
    const activeClosers = finalStages.filter(s => s.state === 'active' && terminalSemantics.has(s.semantic))
    const preferenceChains: Record<string, string[]> = {
      won: ['won', 'terminal'],
      lost: ['lost', 'terminal'],
      disqualified: ['disqualified', 'lost', 'terminal'],
      nurture: ['nurture', 'terminal', 'lost']
    }
    const targetFor = (outcome: string) => {
      for (const semantic of (preferenceChains[outcome] || [])) {
        const found = activeClosers.find(s => s.semantic === semantic)
        if (found) return found
      }
      return null
    }
    for (const retired of terminalRedistributions) {
      const groups = await c.env.DB.prepare('SELECT outcome_type, COUNT(*) AS n FROM sales_stage_assignments WHERE company_id=? AND stage_id=? GROUP BY outcome_type').bind(companyId, retired.stageId).all<any>()
      for (const group of (groups.results as any[])) {
        const outcome = String(group.outcome_type || '')
        const target = outcome ? targetFor(outcome) : null
        if (!target) return err(c, `"${retired.priorLabel}" holds ${Number(group.n)} lead(s) with ${outcome ? `the "${outcome}" outcome` : 'no recorded outcome'} and there is no closing stage to move them to. Keep an active closing stage for that outcome, or use a new draft with lead review.`, 409)
        statements.push(c.env.DB.prepare('UPDATE opportunities SET sales_process_stage_id=?,status=?,pipeline_stage=?,updated_at=updated_at WHERE company_id=? AND id IN (SELECT opportunity_id FROM sales_stage_assignments WHERE company_id=? AND stage_id=? AND outcome_type=?)').bind(target.id, target.label, target.label, companyId, companyId, retired.stageId, outcome))
        statements.push(c.env.DB.prepare('UPDATE sales_stage_assignments SET stage_id=? WHERE company_id=? AND stage_id=? AND outcome_type=?').bind(target.id, companyId, retired.stageId, outcome))
        redistributedLeads += Number(group.n || 0)
      }
    }
  }
  try { await c.env.DB.batch(statements) }
  catch (error: any) {
    if (/UNIQUE constraint|constraint failed/i.test(String(error?.message || error))) return err(c, 'The process changed since it was loaded', 409)
    throw error
  }
  await logActivity(c.env.DB, { companyId, actorId: c.var.repId, actorName: c.var.repId, entityType: 'sales_process', entityId: version.process_id, entityLabel: 'Live process stages', action: 'live_updated', afterJson: { stages: newLabels, redistributed_leads: redistributedLeads } })
  return json(c, { updated: stages.length, content_revision: expectedRevision + 1, pipeline_stages: newLabels, redistributed_leads: redistributedLeads })
})

app.put('/api/sales-process/live/:versionId/components/:component', requireAuth, async (c) => {
  if (!requireSalesProcessAdmin(c)) return err(c, 'Administrator or sales manager access required', 403)
  const companyId = c.var.companyId as string
  const versionId = c.req.param('versionId')
  const component = c.req.param('component')
  const definitions: Record<string, { table: string, columns: string[], stageColumns: string[] }> = {
    internal_statuses: { table: 'sales_stage_internal_statuses', columns: ['stage_id','stable_key','display_name','display_order','active'], stageColumns: ['stage_id'] },
    requirements: { table: 'sales_stage_requirements', columns: ['stage_id','requirement_type','stable_key','label','description','required_level','display_order','config_json'], stageColumns: ['stage_id'] },
    guides: { table: 'sales_stage_guides', columns: ['stage_id','guide_type','interaction_type','title','purpose','suggested_language','completion_guidance','display_order','config_json'], stageColumns: ['stage_id'] },
    resources: { table: 'sales_process_resources', columns: ['stage_id','resource_type','stable_key','name','content_json','active'], stageColumns: ['stage_id'] },
    automations: { table: 'sales_process_automations', columns: ['stage_id','name','trigger_type','action_type','config_json','active'], stageColumns: ['stage_id'] },
    academy: { table: 'sales_academy_associations', columns: ['stage_id','internal_status_id','skill_id','visibility','display_order'], stageColumns: ['stage_id'] }
  }
  const definition = definitions[component]
  if (!definition) return err(c, 'Unknown component', 404)
  const version = await c.env.DB.prepare("SELECT * FROM sales_process_versions WHERE id=? AND company_id=? AND lifecycle='published'").bind(versionId, companyId).first<any>()
  if (!version) return err(c, 'Published version not found', 404)
  const body = await c.req.json()
  const expectedRevision = Number(body.content_revision || 0)
  if (!expectedRevision || expectedRevision !== Number(version.content_revision || 1)) return err(c, 'The process changed since it was loaded', 409)
  const items = Array.isArray(body.items) ? body.items : []
  const stageRows = await c.env.DB.prepare('SELECT id FROM sales_process_stages WHERE company_id=? AND process_version_id=?').bind(companyId, versionId).all<any>()
  const stageIds = new Set((stageRows.results as any[]).map(row => String(row.id)))
  const skillRows = component === 'academy' ? await c.env.DB.prepare("SELECT id FROM sales_academy_skills WHERE active=1 AND (company_id=? OR (company_id='__global__' AND is_global=1))").bind(companyId).all<any>() : { results: [] }
  const skillIds = new Set((skillRows.results as any[]).map(row => String(row.id)))
  for (const item of items) {
    for (const column of definition.stageColumns) if (!stageIds.has(String(item[column] || ''))) return err(c, `${component} references an unknown stage`)
    if (component === 'academy' && !skillIds.has(String(item.skill_id || ''))) return err(c, 'Academy association references an unavailable skill')
    if (component === 'requirements' && !['entry','exit','required','recommended','optional','manager_review'].includes(String(item.required_level || ''))) return err(c, 'Invalid requirement level')
  }
  const statements: any[] = [
    c.env.DB.prepare("UPDATE sales_process_versions SET content_revision=content_revision+1,updated_at=datetime('now') WHERE id=? AND company_id=? AND lifecycle='published' AND content_revision=?").bind(versionId, companyId, expectedRevision),
    c.env.DB.prepare("INSERT INTO sales_process_versions (id,company_id,process_id,version_number,lifecycle) SELECT id,company_id,process_id,version_number,lifecycle FROM sales_process_versions WHERE id=? AND company_id=? AND changes()=0").bind(versionId, companyId),
    c.env.DB.prepare(`DELETE FROM ${definition.table} WHERE company_id=? AND process_version_id=?`).bind(companyId, versionId)
  ]
  items.forEach((item: any, index: number) => {
    const id = String(item.id || `${versionId}_${component}_${uid()}`)
    const values = definition.columns.map(column => item[column] ?? (column === 'display_order' ? index + 1 : ''))
    statements.push(c.env.DB.prepare(`INSERT INTO ${definition.table} (id,company_id,process_version_id,${definition.columns.join(',')}) VALUES (?,?,?,${definition.columns.map(() => '?').join(',')})`).bind(id, companyId, versionId, ...values))
  })
  try { await c.env.DB.batch(statements) }
  catch (error: any) {
    if (/UNIQUE constraint|constraint failed/i.test(String(error?.message || error))) return err(c, 'The process changed since it was loaded', 409)
    throw error
  }
  return json(c, { component, updated: items.length, content_revision: expectedRevision + 1 })
})

const SALES_AI_DRAFT_TYPES = new Set(['guided_interview','business_type','simplification','duplicate_stage','name','purpose','milestone','internal_status','condition','checklist','qualification_field','call_guide','email_template','academy_association','automation','stagnation_review','migration_suggestion','impact_explanation'])
const SALES_AI_ADVISORY_TYPES = new Set(['guided_interview','business_type','simplification','duplicate_stage','stagnation_review','migration_suggestion','impact_explanation'])

app.post('/api/sales-process/drafts/:versionId/ai-suggestions/generate', requireAuth, async (c) => {
  if (!requireSalesProcessAdmin(c)) return err(c, 'Administrator or sales manager access required', 403)
  const companyId = c.var.companyId as string
  const versionId = c.req.param('versionId')
  const version = await c.env.DB.prepare("SELECT id,content_revision FROM sales_process_versions WHERE id=? AND company_id=? AND lifecycle='draft'").bind(versionId, companyId).first<any>()
  if (!version) return err(c, 'Editable draft not found', 404)
  const body = await c.req.json<any>()
  const interview = {
    business_type: String(body.business_type || '').slice(0, 120),
    average_cycle_days: Math.max(0, Number(body.average_cycle_days || 0)),
    primary_bottleneck: String(body.primary_bottleneck || '').slice(0, 500),
    required_qualification: String(body.required_qualification || '').slice(0, 500)
  }
  const [stages, statuses, requirements, guides, resources, automations, academy] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM sales_process_stages WHERE company_id=? AND process_version_id=? ORDER BY display_order').bind(companyId, versionId).all<any>(),
    c.env.DB.prepare('SELECT * FROM sales_stage_internal_statuses WHERE company_id=? AND process_version_id=? ORDER BY display_order').bind(companyId, versionId).all<any>(),
    c.env.DB.prepare('SELECT * FROM sales_stage_requirements WHERE company_id=? AND process_version_id=? ORDER BY display_order').bind(companyId, versionId).all<any>(),
    c.env.DB.prepare('SELECT * FROM sales_stage_guides WHERE company_id=? AND process_version_id=? ORDER BY display_order').bind(companyId, versionId).all<any>(),
    c.env.DB.prepare('SELECT * FROM sales_process_resources WHERE company_id=? AND process_version_id=? ORDER BY id').bind(companyId, versionId).all<any>(),
    c.env.DB.prepare('SELECT * FROM sales_process_automations WHERE company_id=? AND process_version_id=? ORDER BY id').bind(companyId, versionId).all<any>(),
    c.env.DB.prepare('SELECT * FROM sales_academy_associations WHERE company_id=? AND process_version_id=? ORDER BY display_order').bind(companyId, versionId).all<any>()
  ])
  const stageRows = stages.results as any[]
  const firstStage = stageRows.find(stage => stage.state === 'active')
  if (!firstStage) return err(c, 'Draft requires an active stage before generating suggestions', 409)
  const currentRevision = Number(version.content_revision || 1)
  const advisory = (suggestion_type: string, proposed: any, reason: string) => ({ suggestion_type, current: { interview, _content_revision: currentRevision }, proposed: { advisory: true, ...proposed }, reason })
  const component = (suggestion_type: string, name: string, items: any[], reason: string) => ({ suggestion_type, current: { interview, _content_revision: currentRevision }, proposed: { component: name, items }, reason })
  const suggestions: any[] = [
    advisory('guided_interview', { answers: interview }, 'Use these interview answers as the review boundary for every generated proposal.'),
    advisory('business_type', { recommendation: interview.business_type || 'Field service', emphasis: interview.primary_bottleneck || 'Define a consistent next action at every stage.' }, 'Tailor the process without changing live opportunities.'),
    advisory('simplification', { active_stage_count: stageRows.filter(stage => stage.state === 'active').length, recommendation: stageRows.length > 8 ? 'Consider consolidating stages with the same customer milestone.' : 'The current stage count is reasonable.' }, 'Excessive stages increase ambiguity and reporting friction.'),
    advisory('duplicate_stage', { duplicate_keys: stageRows.filter((stage, index) => stageRows.findIndex(other => String(other.purpose || other.display_name).trim().toLowerCase() === String(stage.purpose || stage.display_name).trim().toLowerCase()) !== index).map(stage => stage.stable_key) }, 'Review repeated purposes before changing the graph.'),
    component('name', 'stages', stageRows.map(stage => ({ ...stage, display_name: String(stage.display_name || stage.stable_key).trim() })), 'Normalize stage names while preserving stable identifiers.'),
    component('purpose', 'stages', stageRows.map(stage => ({ ...stage, description: stage.description || `Define the customer commitment required for ${stage.display_name}.` })), 'Give every stage a customer-centered purpose.'),
    component('milestone', 'stages', stageRows.map(stage => ({ ...stage, customer_milestone: stage.customer_milestone || `Customer completes the ${stage.display_name} milestone.` })), 'Make stage movement observable and rename invariant.'),
    component('internal_status', 'internal_statuses', statuses.results.length ? statuses.results : [{ stage_id:firstStage.id, stable_key:'working', display_name:'Working', description:'Active work is underway.', display_order:1 }], 'Add a useful internal working state without creating another pipeline stage.'),
    component('condition', 'requirements', requirements.results as any[], 'Review entry and exit conditions against the guided interview.'),
    component('checklist', 'requirements', [...requirements.results as any[], { stage_id:firstStage.id, requirement_type:'checklist', stable_key:'confirm_next_step', label:'Confirm the next step', description:'Record the next action before moving forward.', required_level:'recommended', display_order:(requirements.results as any[]).length+1, config_json:'{}' }], 'Add explicit next-step guidance to reduce stalled opportunities.'),
    component('qualification_field', 'requirements', [...requirements.results as any[], { stage_id:firstStage.id, requirement_type:'field', stable_key:'qualification_summary', label:'Qualification summary', description:interview.required_qualification || 'Record fit, urgency, authority, and investment context.', required_level:'recommended', display_order:(requirements.results as any[]).length+1, config_json:'{"representative_editable":true}' }], 'Capture the company-specific qualification standard.'),
    component('call_guide', 'guides', guides.results.length ? guides.results : [{ stage_id:firstStage.id, guide_type:'call_guide', interaction_type:'qualification_call', title:'Qualification conversation', purpose:'Confirm fit and agree on the next step.', suggested_language:'What outcome matters most, and what must happen next?', completion_guidance:'Record the customer milestone and next action.', display_order:1, config_json:'{}' }], 'Provide stage-owned guidance rather than relying on label matching.'),
    component('email_template', 'resources', resources.results.length ? resources.results : [{ stage_id:firstStage.id, resource_type:'email_template', stable_key:'next_step_recap', name:'Next-step recap', content_json:'{"subject":"Next steps","body":"Thank you for your time. Here is the agreed next step."}', active:1 }], 'Create a reviewable draft email resource; no communication is sent.'),
    component('academy_association', 'academy', academy.results as any[], 'Review training associations for each stage.'),
    component('automation', 'automations', automations.results.length ? automations.results : [{ stage_id:firstStage.id, name:'Suggest next-step task', trigger_type:'stage_entered', action_type:'suggest_task', config_json:'{}', active:1, display_order:1 }], 'Automations remain suggestion-only and cannot communicate or transition opportunities.'),
    advisory('stagnation_review', { expected_cycle_days: interview.average_cycle_days, bottleneck: interview.primary_bottleneck || 'No bottleneck supplied' }, 'Compare expected duration and movement data before changing stage aging.'),
    advisory('migration_suggestion', { strategy:'Keep unknown, blank, conflicting, and ambiguous labels in Needs Restaging.' }, 'Migration suggestions never remap live opportunities.'),
    advisory('impact_explanation', { reporting:'Stage renames preserve semantic reporting.', automation:'Review every stage and outcome reference.', training:'Review guide and Academy associations.', live_data_changed:false }, 'Explain expected impact before any optimistic mutation or publication decision.')
  ]
  const statements = suggestions.map(suggestion => c.env.DB.prepare(`INSERT INTO sales_ai_suggestions
    (id,company_id,process_version_id,user_id,suggestion_type,current_json,proposed_json,reason,decision)
    VALUES (?,?,?,?,?,?,?,?,'pending')`).bind(`suggestion_${uid()}`, companyId, versionId, c.var.repId, suggestion.suggestion_type, JSON.stringify(suggestion.current), JSON.stringify(suggestion.proposed), suggestion.reason))
  await c.env.DB.batch(statements)
  return json(c, { generated: suggestions.length, content_revision: currentRevision }, 201)
})

app.post('/api/sales-process/drafts/:versionId/ai-suggestions', requireAuth, async (c) => {
  if (!requireSalesProcessAdmin(c)) return err(c, 'Administrator or sales manager access required', 403)
  const companyId = c.var.companyId as string
  const versionId = c.req.param('versionId')
  const version = await c.env.DB.prepare("SELECT id,content_revision FROM sales_process_versions WHERE id=? AND company_id=? AND lifecycle='draft'").bind(versionId, companyId).first<any>()
  if (!version) return err(c, 'Editable draft not found', 404)
  const body = await c.req.json()
  const suggestionType = String(body.suggestion_type || '')
  if (!SALES_AI_DRAFT_TYPES.has(suggestionType)) return err(c, 'Unsupported draft suggestion type')
  const suggestionId = `suggestion_${uid()}`
  await c.env.DB.prepare(`INSERT INTO sales_ai_suggestions
    (id,company_id,process_version_id,user_id,suggestion_type,current_json,proposed_json,reason,decision)
    VALUES (?,?,?,?,?,?,?,?,'pending')`).bind(suggestionId, companyId, versionId, c.var.repId, suggestionType,
      JSON.stringify({ ...(body.current || {}), _content_revision: Number(version.content_revision || 1) }), JSON.stringify(body.proposed || {}), String(body.reason || '')).run()
  return json(c, { id: suggestionId, decision: 'pending' }, 201)
})

app.put('/api/sales-process/drafts/:versionId/ai-suggestions/:suggestionId', requireAuth, async (c) => {
  if (!requireSalesProcessAdmin(c)) return err(c, 'Administrator or sales manager access required', 403)
  const companyId = c.var.companyId as string
  const versionId = c.req.param('versionId')
  const body = await c.req.json()
  const decision = String(body.decision || '')
  if (!['accepted','rejected'].includes(decision)) return err(c, 'Decision must be accepted or rejected')
  const suggestion = await c.env.DB.prepare(`SELECT s.*,v.lifecycle,v.content_revision FROM sales_ai_suggestions s
    JOIN sales_process_versions v ON v.id=s.process_version_id AND v.company_id=s.company_id
    WHERE s.id=? AND s.company_id=? AND s.process_version_id=? AND s.decision='pending'`)
    .bind(c.req.param('suggestionId'), companyId, versionId).first<any>()
  if (!suggestion || suggestion.lifecycle !== 'draft') return err(c, 'Pending draft suggestion not found', 404)
  let suggestionRevision = 0
  try { suggestionRevision = Number(JSON.parse(suggestion.current_json || '{}')._content_revision || 0) } catch (_) {}
  let proposed: any = {}
  try { proposed = JSON.parse(suggestion.proposed_json || '{}') } catch (_) {}
  const advisoryAcceptance = decision === 'accepted' && SALES_AI_ADVISORY_TYPES.has(String(suggestion.suggestion_type)) && proposed.advisory === true
  if (advisoryAcceptance && Number(body.applied_revision || 0) !== Number(suggestion.content_revision || 0)) return err(c, 'Draft changed since this advisory was generated', 409)
  if (decision === 'accepted' && (!advisoryAcceptance && (Number(body.applied_revision || 0) !== Number(suggestion.content_revision || 0) || Number(body.applied_revision || 0) <= suggestionRevision))) {
    return err(c, 'Apply the suggestion through an optimistic draft mutation before accepting it', 409)
  }
  await c.env.DB.prepare("UPDATE sales_ai_suggestions SET decision=?,decided_by=?,decided_at=datetime('now') WHERE id=? AND company_id=? AND process_version_id=? AND decision='pending'")
    .bind(decision, c.var.repId, suggestion.id, companyId, versionId).run()
  return json(c, { id: suggestion.id, decision })
})

app.post('/api/sales-process/versions/:versionId/validate', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const versionId = c.req.param('versionId')
  const stages = await c.env.DB.prepare('SELECT * FROM sales_process_stages WHERE company_id=? AND process_version_id=? ORDER BY display_order').bind(companyId, versionId).all<any>()
  if (!stages.results.length) return err(c, 'Version not found', 404)
  const errors: string[] = []
  const warnings: string[] = []
  const active = (stages.results as any[]).filter(s => s.state === 'active')
  const keys = active.map(s => s.stable_key)
  if (new Set(keys).size !== keys.length) errors.push('Stable stage identifiers must be unique')
  if (!active.some(s => s.semantic_type === 'intake')) errors.push('An active Intake stage is required')
  if (active.some((s, index) => Number(s.display_order) !== index + 1)) errors.push('Active stage order must be unique and contiguous')
  const outcomes = await c.env.DB.prepare('SELECT * FROM sales_stage_outcomes WHERE company_id=? AND process_version_id=? AND active=1').bind(companyId, versionId).all<any>()
  if (!(outcomes.results as any[]).some(o => o.semantic_type === 'won')) errors.push('A Won terminal outcome is required')
  if (!(outcomes.results as any[]).some(o => o.semantic_type === 'lost')) errors.push('A Lost terminal outcome is required')
  active.forEach(s => {
    if (!s.display_name) errors.push(`Stage ${s.stable_key} requires a display name`)
    if (!s.exit_guidance && !['won','lost','disqualified','nurture'].includes(s.semantic_type)) warnings.push(`${s.display_name} has no exit guidance`)
  })
  const stageIds = new Set(active.map(s => String(s.id)))
  const transitions = await c.env.DB.prepare('SELECT * FROM sales_stage_transition_paths WHERE company_id=? AND process_version_id=? AND active=1').bind(companyId, versionId).all<any>()
  const outgoing = new Map<string, any[]>()
  for (const transition of transitions.results as any[]) {
    if (!stageIds.has(String(transition.from_stage_id)) || !stageIds.has(String(transition.to_stage_id))) errors.push(`Transition ${transition.id} references an inactive or unknown stage`)
    outgoing.set(String(transition.from_stage_id), [...(outgoing.get(String(transition.from_stage_id)) || []), transition])
  }
  const intake = active.find(s => s.semantic_type === 'intake')
  if (intake) {
    const reached = new Set<string>([String(intake.id)])
    const queue = [String(intake.id)]
    while (queue.length) for (const edge of outgoing.get(queue.shift() as string) || []) if (!reached.has(String(edge.to_stage_id))) { reached.add(String(edge.to_stage_id)); queue.push(String(edge.to_stage_id)) }
    active.filter(s => !reached.has(String(s.id))).forEach(s => errors.push(`${s.display_name} is not reachable from Intake`))
  }
  active.filter(s => !['terminal','won','lost','disqualified','nurture'].includes(s.semantic_type) && !(outgoing.get(String(s.id)) || []).length).forEach(s => errors.push(`${s.display_name} requires an exit path`))
  const requirements = await c.env.DB.prepare('SELECT * FROM sales_stage_requirements WHERE company_id=? AND process_version_id=?').bind(companyId, versionId).all<any>()
  const requirementKeys = new Set<string>()
  for (const requirement of requirements.results as any[]) {
    const key = `${requirement.stage_id}:${requirement.stable_key}`
    if (requirementKeys.has(key)) errors.push(`Requirement key ${requirement.stable_key} is duplicated within a stage`)
    requirementKeys.add(key)
    if (!stageIds.has(String(requirement.stage_id))) errors.push(`Requirement ${requirement.label} references an inactive or unknown stage`)
    let config: any = {}; try { config = JSON.parse(requirement.config_json || '{}') } catch (_) { errors.push(`Requirement ${requirement.label} has invalid configuration`) }
    if (requirement.required_level === 'required' && config.representative_can_edit === false) warnings.push(`${requirement.label} is required but representatives cannot edit it`)
  }
  const purposes = active.map(s => String(s.description || '').trim().toLowerCase()).filter(Boolean)
  if (new Set(purposes).size !== purposes.length) warnings.push('Multiple stages have duplicate purposes')
  active.filter(s => s.semantic_type === 'decision' && !(requirements.results as any[]).some(r => r.stage_id === s.id && ['next_action','next_action_date','follow_up_plan'].includes(r.stable_key))).forEach(s => warnings.push(`${s.display_name} has no follow-up requirement`))
  active.filter(s => !s.manager_override_policy).forEach(s => warnings.push(`${s.display_name} has no ownership or override policy`))
  if (active.filter(s => !['won','lost','disqualified','nurture'].includes(s.semantic_type)).length > 9) warnings.push('The process has an excessive number of active stages')
  const result = { valid: errors.length === 0, errors, warnings }
  await c.env.DB.prepare("UPDATE sales_process_versions SET validation_json=?, updated_at=datetime('now') WHERE id=? AND company_id=?").bind(JSON.stringify(result), versionId, companyId).run()
  return json(c, result)
})

// Read-only pre-migration snapshot. Every base and related query is company scoped.
app.get('/api/sales-process/migration/inventory', requireAuth, async (c) => {
  if (!requireSalesProcessAdmin(c)) return err(c, 'Administrator or sales manager access required', 403)
  const companyId = c.var.companyId as string
  const rows = await c.env.DB.prepare(`
    SELECT o.*,
      (SELECT COUNT(*) FROM tasks t WHERE t.company_id=o.company_id AND t.linked_record_type='lead' AND t.linked_record_id=o.id) AS task_count,
      (SELECT COUNT(*) FROM activity_log a WHERE a.company_id=o.company_id AND a.entity_type='opportunity' AND a.entity_id=o.id) AS activity_count,
      (SELECT COUNT(*) FROM calendar_events ce WHERE ce.company_id=o.company_id AND ce.opp_id=o.id) AS appointment_count,
      (SELECT e.status FROM estimates e WHERE e.company_id=o.company_id AND e.opp_id=o.id ORDER BY e.updated_at DESC LIMIT 1) AS linked_estimate_status,
      (SELECT e.total_cents / 100.0 FROM estimates e WHERE e.company_id=o.company_id AND e.opp_id=o.id ORDER BY e.updated_at DESC LIMIT 1) AS linked_estimate_amount,
      (SELECT e.sent_at FROM estimates e WHERE e.company_id=o.company_id AND e.opp_id=o.id ORDER BY e.updated_at DESC LIMIT 1) AS linked_estimate_sent_at
    FROM opportunities o WHERE o.company_id=? ORDER BY o.created_at, o.id
  `).bind(companyId).all<any>()
  const items = rows.results as any[]
  const isWon = (o: any) => ['Deal Closed / Won','Sold / Activation'].includes(String(o.status || o.pipeline_stage || ''))
  const isLost = (o: any) => String(o.status || o.pipeline_stage || '') === 'Closed Lost'
  const open = items.filter(o => !isWon(o) && !isLost(o))
  const countsByStatus: Record<string, number> = {}
  items.forEach(o => { const key = String(o.status || '(blank)'); countsByStatus[key] = (countsByStatus[key] || 0) + 1 })
  return json(c, { company_id: companyId, captured_at: new Date().toISOString(), opportunities: items, reconciliation: {
    total_opportunity_count: items.length, count_by_current_status: countsByStatus,
    total_open_pipeline_value: open.reduce((n,o) => n + Number(o.job_value_cents || 0), 0) / 100,
    total_won_value: items.filter(isWon).reduce((n,o) => n + Number(o.sold_amount_cents || o.job_value_cents || 0), 0) / 100,
    total_lost_count: items.filter(isLost).length,
    without_assigned_representative: items.filter(o => !o.assigned_to_rep_id && !o.rep_id).length,
    without_next_action: items.filter(o => !o.next_follow_up && Number(o.task_count || 0) === 0).length,
    without_next_action_date: items.filter(o => !o.next_follow_up).length,
    unknown_or_blank_stage: items.filter(o => !LEGACY_STAGE_MAP[String(o.status || o.pipeline_stage || '')]).length
  } })
})

app.post('/api/sales-process/migration/propose', requireAuth, async (c) => {
  if (!requireSalesProcessAdmin(c)) return err(c, 'Administrator or sales manager access required', 403)
  const companyId = c.var.companyId as string
  const actorId = c.var.repId as string
  const body = await c.req.json()
  const versionId = String(body.process_version_id || '')
  const stages = await c.env.DB.prepare('SELECT * FROM sales_process_stages WHERE company_id=? AND process_version_id=?').bind(companyId, versionId).all<any>()
  if (!stages.results.length) return err(c, 'Company-owned process version not found', 404)
  const byKey = new Map((stages.results as any[]).map(s => [s.stable_key, s]))
  const opps = await c.env.DB.prepare(`SELECT o.*,
    (SELECT COUNT(*) FROM calendar_events ce WHERE ce.company_id=o.company_id AND ce.opp_id=o.id AND ce.status!='cancelled' AND ce.start_at <= datetime('now')) AS completed_appointments,
    (SELECT COUNT(*) FROM calendar_events ce WHERE ce.company_id=o.company_id AND ce.opp_id=o.id AND ce.status!='cancelled' AND ce.start_at > datetime('now')) AS future_appointments,
    (SELECT e.status FROM estimates e WHERE e.company_id=o.company_id AND e.opp_id=o.id ORDER BY e.updated_at DESC LIMIT 1) AS current_estimate_status,
    (SELECT e.sent_at FROM estimates e WHERE e.company_id=o.company_id AND e.opp_id=o.id ORDER BY e.updated_at DESC LIMIT 1) AS current_estimate_sent_at
    FROM opportunities o WHERE o.company_id=? ORDER BY o.created_at,o.id`).bind(companyId).all<any>()
  const batchId = `mig_${Date.now().toString(36)}_${uid().slice(0, 6)}`
  const statements: any[] = []
  for (const o of opps.results as any[]) {
    const status = String(o.status || '')
    const pipelineStage = String(o.pipeline_stage || '')
    const conflict = status && pipelineStage && status !== pipelineStage
    let stableKey = !conflict ? LEGACY_STAGE_MAP[status || pipelineStage] : ''
    let presentationReason = ''
    if (!conflict && (status || pipelineStage) === 'Presentation & SOW Pitch') {
      const estimateStatus = String(o.current_estimate_status || '').toLowerCase()
      if (Number(o.completed_appointments || 0) === 0) { stableKey = 'onsite_consultation'; presentationReason = 'No completed on-site appointment was found' }
      else if (!['sent','viewed','accepted','declined'].includes(estimateStatus)) { stableKey = 'estimate_development'; presentationReason = 'The on-site visit is complete but the estimate is not ready' }
      else if (Number(o.future_appointments || 0) > 0 && !o.current_estimate_sent_at) { stableKey = 'estimate_presentation'; presentationReason = 'The estimate is ready and a future appointment exists' }
      else if (o.current_estimate_sent_at && o.next_follow_up) { stableKey = 'decision_pending'; presentationReason = 'The estimate was sent and a future follow-up is recorded' }
      else { stableKey = ''; presentationReason = 'Available estimate and activity evidence is insufficient' }
    }
    const destination: any = stableKey ? byKey.get(stableKey) : null
    const ambiguous = conflict || !destination || status === 'Presentation & SOW Pitch'
    const outcomeType = ['Deal Closed / Won','Sold / Activation'].includes(status || pipelineStage) ? 'won' : (status || pipelineStage) === 'Closed Lost' ? 'lost' : ''
    const method = conflict ? 'conflicting_legacy_fields' : destination ? 'approved_legacy_mapping' : 'unknown_legacy_label'
    const reason = conflict ? `status (${status}) conflicts with pipeline_stage (${pipelineStage})` : presentationReason || (destination ? `Approved legacy mapping from ${status || pipelineStage}` : 'No approved legacy mapping exists')
    statements.push(c.env.DB.prepare(`INSERT INTO sales_migration_mappings
      (id,company_id,opportunity_id,migration_batch_id,previous_stage_id,previous_label,proposed_stage_id,final_stage_id,proposed_outcome_type,final_outcome_type,mapping_method,mapping_confidence,suggestion_reason,review_state,reviewer_id,reviewed_at,process_version_id,rollback_value,opportunity_updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(`map_${uid()}`, companyId, o.id, batchId, o.sales_process_stage_id || '', status || pipelineStage, destination?.id || '', ambiguous ? '' : destination.id, outcomeType, ambiguous ? '' : outcomeType, method, ambiguous ? 0.35 : 1, reason, ambiguous ? 'pending' : 'approved', ambiguous ? '' : actorId, ambiguous ? '' : new Date().toISOString(), versionId, o.sales_process_stage_id || status || pipelineStage, o.updated_at || ''))
  }
  if (statements.length) await c.env.DB.batch(statements)
  return json(c, { migration_batch_id: batchId, total: statements.length, pending: (opps.results as any[]).filter(o => {
    const status = String(o.status || ''); const ps = String(o.pipeline_stage || ''); return (status && ps && status !== ps) || !LEGACY_STAGE_MAP[status || ps] || status === 'Presentation & SOW Pitch'
  }).length })
})

app.get('/api/sales-process/migration/:batchId', requireAuth, async (c) => {
  if (!requireSalesProcessAdmin(c)) return err(c, 'Administrator or sales manager access required', 403)
  const companyId = c.var.companyId as string
  const rows = await c.env.DB.prepare(`SELECT m.*, o.client, o.rep_id, o.assigned_to_rep_id, o.next_follow_up, o.job_value_cents / 100.0 AS job_value,
    o.estimate_amount_cents / 100.0 AS estimate_amount, o.estimate_sent_date, o.updated_at AS last_activity,
    (SELECT e.status FROM estimates e WHERE e.company_id=o.company_id AND e.opp_id=o.id ORDER BY e.updated_at DESC LIMIT 1) AS estimate_status,
    (SELECT e.sent_at FROM estimates e WHERE e.company_id=o.company_id AND e.opp_id=o.id ORDER BY e.updated_at DESC LIMIT 1) AS linked_estimate_sent_date,
    (SELECT COUNT(*) FROM calendar_events ce WHERE ce.company_id=o.company_id AND ce.opp_id=o.id AND ce.status!='cancelled') AS appointment_count,
    (SELECT substr(n.body,1,180) FROM notes n WHERE n.company_id=o.company_id AND n.opp_id=o.id ORDER BY n.created_at DESC LIMIT 1) AS notes_preview
    FROM sales_migration_mappings m JOIN opportunities o ON o.id=m.opportunity_id AND o.company_id=m.company_id
    WHERE m.company_id=? AND m.migration_batch_id=? ORDER BY m.review_state DESC, o.client`)
    .bind(companyId, c.req.param('batchId')).all()
  return json(c, rows.results)
})

app.put('/api/sales-process/migration/:batchId/:opportunityId', requireAuth, async (c) => {
  if (!requireSalesProcessAdmin(c)) return err(c, 'Administrator or sales manager access required', 403)
  const companyId = c.var.companyId as string
  const body = await c.req.json()
  const mapping = await c.env.DB.prepare('SELECT * FROM sales_migration_mappings WHERE company_id=? AND migration_batch_id=? AND opportunity_id=?').bind(companyId, c.req.param('batchId'), c.req.param('opportunityId')).first<any>()
  if (!mapping) return err(c, 'Mapping not found', 404)
  const stage = await c.env.DB.prepare('SELECT id FROM sales_process_stages WHERE company_id=? AND process_version_id=? AND id=? AND state=\'active\'').bind(companyId, mapping.process_version_id, String(body.final_stage_id || '')).first()
  if (!stage) return err(c, 'Choose an active stage in this company process')
  const outcomeType = String(body.final_outcome_type || '')
  if (outcomeType && !['won','lost','disqualified','nurture'].includes(outcomeType)) return err(c, 'Invalid terminal outcome')
  await c.env.DB.prepare("UPDATE sales_migration_mappings SET final_stage_id=?,final_outcome_type=?,review_state='approved',reviewer_id=?,reviewed_at=datetime('now'),mapping_method='manual_review',mapping_confidence=1 WHERE company_id=? AND migration_batch_id=? AND opportunity_id=?")
    .bind(String(body.final_stage_id), outcomeType, c.var.repId, companyId, c.req.param('batchId'), c.req.param('opportunityId')).run()
  return json(c, { approved: c.req.param('opportunityId') })
})

app.post('/api/sales-process/versions/:versionId/snapshots', requireAuth, async (c) => {
  if (!requireSalesProcessAdmin(c)) return err(c, 'Administrator or sales manager access required', 403)
  const companyId = c.var.companyId as string
  const versionId = c.req.param('versionId')
  const body = await c.req.json()
  const batchId = String(body.migration_batch_id || '')
  const version = await c.env.DB.prepare("SELECT id FROM sales_process_versions WHERE id=? AND company_id=? AND lifecycle='draft'").bind(versionId, companyId).first()
  if (!version) return err(c, 'Draft version not found', 404)
  const mappings = await c.env.DB.prepare('SELECT opportunity_id FROM sales_migration_mappings WHERE company_id=? AND process_version_id=? AND migration_batch_id=?').bind(companyId, versionId, batchId).all<any>()
  if (!mappings.results.length) return err(c, 'Migration batch not found', 404)
  const opportunities = await c.env.DB.prepare('SELECT * FROM opportunities WHERE company_id=? ORDER BY id').bind(companyId).all<any>()
  const snapshotId = `snapshot_${uid()}`
  const totalValue = (opportunities.results as any[]).reduce((sum, opportunity) => sum + Number(opportunity.job_value_cents || 0), 0) / 100
  const sourceRevision = JSON.stringify((opportunities.results as any[]).map(opportunity => [opportunity.id, opportunity.updated_at || '']))
  const reconciliation = { opportunity_count: opportunities.results.length, total_value: totalValue, mapping_count: mappings.results.length }
  const statements: any[] = [c.env.DB.prepare(`INSERT INTO sales_migration_snapshots
    (id,company_id,process_version_id,migration_batch_id,state,source_revision,reconciliation_json,created_by)
    VALUES (?,?,?,?,'captured',?,?,?)`).bind(snapshotId, companyId, versionId, batchId, sourceRevision, JSON.stringify(reconciliation), c.var.repId)]
  for (const opportunity of opportunities.results as any[]) statements.push(c.env.DB.prepare(`INSERT INTO sales_migration_snapshot_items
    (id,company_id,snapshot_id,opportunity_id,source_updated_at,original_status,original_pipeline_stage,original_stage_id,snapshot_json)
    VALUES (?,?,?,?,?,?,?,?,?)`).bind(`snapshot_item_${uid()}`, companyId, snapshotId, opportunity.id, opportunity.updated_at || '', opportunity.status || '', opportunity.pipeline_stage || '', opportunity.sales_process_stage_id || '', JSON.stringify({
      job_value: Number(opportunity.job_value || 0), rep_id: opportunity.rep_id || '', assigned_to_rep_id: opportunity.assigned_to_rep_id || '', next_follow_up: opportunity.next_follow_up || ''
    })))
  await c.env.DB.batch(statements)
  return json(c, { snapshot_id: snapshotId, state: 'captured', reconciliation }, 201)
})

app.post('/api/sales-process/snapshots/:snapshotId/approve', requireAuth, async (c) => {
  if (!requireSalesProcessAdmin(c)) return err(c, 'Administrator or sales manager access required', 403)
  const companyId = c.var.companyId as string
  const snapshot = await c.env.DB.prepare("SELECT * FROM sales_migration_snapshots WHERE id=? AND company_id=? AND state='captured'").bind(c.req.param('snapshotId'), companyId).first<any>()
  if (!snapshot) return err(c, 'Captured snapshot not found', 404)
  const drift = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM sales_migration_snapshot_items i
    LEFT JOIN opportunities o ON o.id=i.opportunity_id AND o.company_id=i.company_id
    WHERE i.company_id=? AND i.snapshot_id=? AND (o.id IS NULL OR coalesce(o.updated_at,'')!=coalesce(i.source_updated_at,''))`).bind(companyId, snapshot.id).first<any>()
  const currentCount = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM opportunities WHERE company_id=?').bind(companyId).first<any>()
  const itemCount = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM sales_migration_snapshot_items WHERE company_id=? AND snapshot_id=?').bind(companyId, snapshot.id).first<any>()
  const pending = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM sales_migration_mappings WHERE company_id=? AND process_version_id=? AND migration_batch_id=? AND (review_state!='approved' OR final_stage_id='')").bind(companyId, snapshot.process_version_id, snapshot.migration_batch_id).first<any>()
  const issues: any[] = []
  if (Number(drift?.n || 0)) issues.push({ code: 'snapshot_drift', count: Number(drift.n) })
  if (Number(currentCount?.n || 0) !== Number(itemCount?.n || 0)) issues.push({ code: 'snapshot_count_mismatch' })
  if (Number(pending?.n || 0)) issues.push({ code: 'mapping_not_approved', count: Number(pending.n) })
  if (issues.length) return c.json({ ok: false, error: 'Snapshot approval checks failed', data: { issues } }, 409)
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE sales_migration_snapshots SET state='approved',approved_by=?,approved_at=datetime('now') WHERE id=? AND company_id=? AND state='captured'").bind(c.var.repId, snapshot.id, companyId),
    c.env.DB.prepare("UPDATE sales_process_versions SET approved_snapshot_id=?,approved_by=?,approved_at=datetime('now') WHERE id=? AND company_id=? AND lifecycle='draft'").bind(snapshot.id, c.var.repId, snapshot.process_version_id, companyId)
  ])
  return json(c, { snapshot_id: snapshot.id, state: 'approved' })
})

app.get('/api/sales-process/versions/:versionId/preview', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const versionId = c.req.param('versionId')
  const batchId = String(c.req.query('migration_batch_id') || '')
  const version = await c.env.DB.prepare('SELECT * FROM sales_process_versions WHERE id=? AND company_id=?').bind(versionId, companyId).first<any>()
  if (!version) return err(c, 'Process version not found', 404)
  const [stages, mappings, opportunities, automations, associations, transitions] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM sales_process_stages WHERE company_id=? AND process_version_id=? AND state=\'active\' ORDER BY display_order').bind(companyId, versionId).all<any>(),
    c.env.DB.prepare('SELECT * FROM sales_migration_mappings WHERE company_id=? AND process_version_id=? AND migration_batch_id=?').bind(companyId, versionId, batchId).all<any>(),
    c.env.DB.prepare('SELECT id,job_value_cents FROM opportunities WHERE company_id=?').bind(companyId).all<any>(),
    c.env.DB.prepare('SELECT id,name,trigger_type,action_type FROM sales_process_automations WHERE company_id=? AND process_version_id=? AND active=1').bind(companyId, versionId).all<any>(),
    c.env.DB.prepare('SELECT id,stage_id,skill_id FROM sales_academy_associations WHERE company_id=? AND process_version_id=?').bind(companyId, versionId).all<any>(),
    c.env.DB.prepare(`SELECT t.id,t.from_stage_id,t.to_stage_id,t.outcome_type,t.requires_override,
      fs.display_name AS from_stage_name,ts.display_name AS to_stage_name
      FROM sales_stage_transition_paths t
      JOIN sales_process_stages fs ON fs.id=t.from_stage_id AND fs.company_id=t.company_id AND fs.process_version_id=t.process_version_id
      JOIN sales_process_stages ts ON ts.id=t.to_stage_id AND ts.company_id=t.company_id AND ts.process_version_id=t.process_version_id
      WHERE t.company_id=? AND t.process_version_id=? AND t.active=1 ORDER BY fs.display_order,ts.display_order LIMIT 12`).bind(companyId, versionId).all<any>()
  ])
  const methods: Record<string, number> = { automatic: 0, manual: 0, unknown: 0 }
  for (const mapping of mappings.results as any[]) {
    if (mapping.review_state !== 'approved') methods.unknown++
    else if (mapping.mapping_method === 'manual_review') methods.manual++
    else methods.automatic++
  }
  return json(c, { version, stages: stages.results, sample_transitions: transitions.results, impact: {
    opportunities_affected: opportunities.results.length,
    value_affected: (opportunities.results as any[]).reduce((sum, opportunity) => sum + Number(opportunity.job_value_cents || 0), 0) / 100,
    mappings: methods, reporting_changes: stages.results.length, automation_changes: automations.results, training_changes: associations.results
  }, surfaces: ['pipeline','opportunity_detail','stage_guide','call_companion','representative_view','reporting','mobile'] })
})

async function salesProcessPublicationReadiness(db: D1Database, companyId: string, versionId: string, batchId: string) {
  const version = await db.prepare("SELECT * FROM sales_process_versions WHERE id=? AND company_id=? AND lifecycle='draft'").bind(versionId, companyId).first<any>()
  if (!version) return null
  let validationValid = false
  try { validationValid = JSON.parse(version.validation_json || '{}').valid === true } catch (_) {}
  const opportunities = await db.prepare('SELECT id,updated_at FROM opportunities WHERE company_id=? ORDER BY id').bind(companyId).all<any>()
  const mappings = batchId ? await db.prepare(`SELECT m.*,s.semantic_type AS stage_semantic,
      CASE WHEN m.final_outcome_type='' THEN 1 WHEN EXISTS (
        SELECT 1 FROM sales_stage_outcomes so WHERE so.company_id=m.company_id
          AND so.process_version_id=m.process_version_id AND so.semantic_type=m.final_outcome_type AND so.active=1
      ) THEN 1 ELSE 0 END AS outcome_valid
    FROM sales_migration_mappings m
    LEFT JOIN sales_process_stages s ON s.id=m.final_stage_id AND s.company_id=m.company_id AND s.process_version_id=m.process_version_id AND s.state='active'
    WHERE m.company_id=? AND m.migration_batch_id=? AND m.process_version_id=?`).bind(companyId, batchId, versionId).all<any>() : { results: [] as any[] }
  const byOpportunity = new Map((mappings.results as any[]).map(m => [String(m.opportunity_id), m]))
  const terminal = new Set(['won','lost','disqualified','nurture','terminal'])
  const issues: any[] = []
  if (!validationValid) issues.push({ code: 'version_not_validated' })
  const snapshot = version.approved_snapshot_id ? await db.prepare("SELECT * FROM sales_migration_snapshots WHERE id=? AND company_id=? AND process_version_id=? AND migration_batch_id=? AND state='approved'").bind(version.approved_snapshot_id, companyId, versionId, batchId).first<any>() : null
  if (!snapshot) issues.push({ code: 'approved_snapshot_required' })
  if (snapshot) {
    const drift = await db.prepare(`SELECT COUNT(*) AS n FROM sales_migration_snapshot_items i
      LEFT JOIN opportunities o ON o.id=i.opportunity_id AND o.company_id=i.company_id
      WHERE i.company_id=? AND i.snapshot_id=? AND (o.id IS NULL OR coalesce(o.updated_at,'')!=coalesce(i.source_updated_at,''))`).bind(companyId, snapshot.id).first<any>()
    if (Number(drift?.n || 0)) issues.push({ code: 'snapshot_drift', count: Number(drift.n) })
    let reconciliation: any = {}; try { reconciliation = JSON.parse(snapshot.reconciliation_json || '{}') } catch (_) {}
    if (Number(reconciliation.opportunity_count) !== Number(opportunities.results.length) || Number(reconciliation.mapping_count) !== Number(mappings.results.length)) issues.push({ code: 'reconciliation_difference' })
  }
  for (const opportunity of opportunities.results as any[]) {
    const mapping: any = byOpportunity.get(String(opportunity.id))
    if (!mapping) { issues.push({ code: 'missing_mapping', opportunity_id: opportunity.id }); continue }
    if (mapping.review_state !== 'approved' || !mapping.final_stage_id) issues.push({ code: 'mapping_not_approved', opportunity_id: opportunity.id })
    if (!mapping.stage_semantic) issues.push({ code: 'invalid_stage', opportunity_id: opportunity.id })
    if (String(mapping.opportunity_updated_at || '') !== String(opportunity.updated_at || '')) issues.push({ code: 'stale_mapping', opportunity_id: opportunity.id })
    const outcome = String(mapping.final_outcome_type || '')
    if (!Number(mapping.outcome_valid)) issues.push({ code: 'invalid_outcome', opportunity_id: opportunity.id })
    if (terminal.has(String(mapping.stage_semantic || '')) !== Boolean(outcome)) issues.push({ code: 'terminal_outcome_mismatch', opportunity_id: opportunity.id })
    if (outcome && outcome !== mapping.stage_semantic && !(['terminal','closed'].includes(String(mapping.stage_semantic)) && ['won','lost','disqualified','nurture'].includes(outcome))) issues.push({ code: 'outcome_stage_mismatch', opportunity_id: opportunity.id })
  }
  if ((mappings.results as any[]).some(m => !(opportunities.results as any[]).some(o => o.id === m.opportunity_id))) issues.push({ code: 'unknown_opportunity' })
  return { ready: issues.length === 0, company_id: companyId, process_version_id: versionId, migration_batch_id: batchId, opportunity_count: opportunities.results.length, mapping_count: mappings.results.length, issues }
}

app.get('/api/sales-process/versions/:versionId/publication-readiness', requireAuth, async (c) => {
  if (!requireSalesProcessAdmin(c)) return err(c, 'Administrator or sales manager access required', 403)
  const companyId = c.var.companyId as string
  const readiness = await salesProcessPublicationReadiness(c.env.DB, companyId, c.req.param('versionId'), String(c.req.query('migration_batch_id') || ''))
  if (!readiness) return err(c, 'Draft version not found', 404)
  return json(c, readiness)
})

app.post('/api/sales-process/versions/:versionId/publish', requireAuth, async (c) => {
  if (!requireSalesProcessAdmin(c)) return err(c, 'Administrator or sales manager access required', 403)
  const companyId = c.var.companyId as string
  const actorId = c.var.repId as string
  const versionId = c.req.param('versionId')
  const body = await c.req.json()
  if (body.confirm !== true) return err(c, 'Explicit publication confirmation is required')
  const version = await c.env.DB.prepare("SELECT * FROM sales_process_versions WHERE id=? AND company_id=? AND lifecycle='draft'").bind(versionId, companyId).first<any>()
  if (!version) return err(c, 'Draft version not found', 404)
  const batchId = String(body.migration_batch_id || '')
  const readiness = await salesProcessPublicationReadiness(c.env.DB, companyId, versionId, batchId)
  if (!readiness?.ready) return json(c, { error: 'Publication readiness checks failed', readiness }, 409)
  const mappings = await c.env.DB.prepare('SELECT * FROM sales_migration_mappings WHERE company_id=? AND migration_batch_id=? AND process_version_id=?').bind(companyId, batchId, versionId).all<any>()
  const previous = await c.env.DB.prepare("SELECT * FROM sales_process_versions WHERE company_id=? AND lifecycle='published' LIMIT 1").bind(companyId).first<any>()
  const previousAssignments = previous ? await c.env.DB.prepare('SELECT * FROM sales_stage_assignments WHERE company_id=? AND process_version_id=?').bind(companyId, previous.id).all<any>() : { results: [] }
  const previousAssignmentByOpportunity = new Map((previousAssignments.results as any[]).map(assignment => [String(assignment.opportunity_id), assignment]))
  // Live cutover inputs: the published stage labels replace the legacy
  // pipeline_stages setting, and each mapped opportunity's status text moves to
  // its new stage label so the board, lead flow, and reports reshape instantly.
  // Prior values are captured for exact rollback.
  const newStages = await c.env.DB.prepare("SELECT * FROM sales_process_stages WHERE company_id=? AND process_version_id=? AND state='active' ORDER BY display_order").bind(companyId, versionId).all<any>()
  const stageById = new Map((newStages.results as any[]).map(stage => [String(stage.id), stage]))
  const newStageLabels = (newStages.results as any[]).map(stage => String(stage.board_label || stage.display_name || '').trim()).filter(Boolean)
  const previousStagesRow = await c.env.DB.prepare('SELECT value FROM settings WHERE key=? LIMIT 1').bind(`${companyId}:pipeline_stages`).first<{ value: string }>()
  let previousPipelineStages: any = null
  try { if (previousStagesRow?.value) previousPipelineStages = JSON.parse(previousStagesRow.value) } catch (_) {}
  const previousOpportunities = await c.env.DB.prepare('SELECT id,status,pipeline_stage FROM opportunities WHERE company_id=?').bind(companyId).all<any>()
  const previousOppById = new Map((previousOpportunities.results as any[]).map(o => [String(o.id), o]))
  const publicationId = `pub_${uid()}`
  const statements: any[] = []
  if (previous) statements.push(c.env.DB.prepare("UPDATE sales_process_versions SET lifecycle='superseded',updated_at=datetime('now') WHERE id=? AND company_id=?").bind(previous.id, companyId))
  statements.push(c.env.DB.prepare("UPDATE sales_process_versions SET lifecycle='published',published_at=datetime('now'),published_by=?,updated_at=datetime('now') WHERE id=? AND company_id=? AND lifecycle='draft'").bind(actorId, versionId, companyId))
  if (newStageLabels.length >= 2) statements.push(c.env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").bind(`${companyId}:pipeline_stages`, JSON.stringify(newStageLabels)))
  for (const m of mappings.results as any[]) {
    const previousAssignment: any = previousAssignmentByOpportunity.get(String(m.opportunity_id))
    const previousOpp: any = previousOppById.get(String(m.opportunity_id))
    const targetStage: any = stageById.get(String(m.final_stage_id))
    const targetLabel = targetStage ? String(targetStage.board_label || targetStage.display_name || '').trim() : ''
    const assignmentId = `asg_${uid()}`
    statements.push(c.env.DB.prepare(`INSERT INTO sales_stage_assignments (id,company_id,opportunity_id,process_version_id,stage_id,classification,outcome_type,assigned_by) VALUES (?,?,?,?,?,'mapped',?,?)`).bind(assignmentId, companyId, m.opportunity_id, versionId, m.final_stage_id, m.final_outcome_type || '', actorId))
    if (targetLabel) statements.push(c.env.DB.prepare('UPDATE opportunities SET sales_process_stage_id=?,status=?,pipeline_stage=?,updated_at=updated_at WHERE id=? AND company_id=?').bind(m.final_stage_id, targetLabel, targetLabel, m.opportunity_id, companyId))
    else statements.push(c.env.DB.prepare('UPDATE opportunities SET sales_process_stage_id=?,updated_at=updated_at WHERE id=? AND company_id=?').bind(m.final_stage_id, m.opportunity_id, companyId))
    statements.push(c.env.DB.prepare(`INSERT INTO sales_migration_history (id,company_id,migration_batch_id,opportunity_id,previous_process_version_id,new_process_version_id,previous_stage_id,previous_label,new_stage_id,mapping_id,actor_id,event_type,event_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,'published',?)`).bind(`hist_${uid()}`, companyId, batchId, m.opportunity_id, previous?.id || '', versionId, previousAssignment?.stage_id || m.previous_stage_id || '', m.previous_label || '', m.final_stage_id, m.id, actorId, JSON.stringify({ previous_outcome_type: previousAssignment?.outcome_type || '', previous_classification: previousAssignment?.classification || '', previous_status: previousOpp?.status ?? null, previous_pipeline_stage: previousOpp?.pipeline_stage ?? null })))
  }
  statements.push(c.env.DB.prepare(`INSERT INTO sales_process_publications (id,company_id,process_id,process_version_id,previous_version_id,migration_batch_id,action,actor_id,impact_json) VALUES (?,?,?,?,?,?,'publish',?,?)`).bind(publicationId, companyId, version.process_id, versionId, previous?.id || '', batchId, actorId, JSON.stringify({ opportunity_count: mappings.results.length, pipeline_stages: newStageLabels, previous_pipeline_stages: previousPipelineStages })))
  await c.env.DB.batch(statements)
  return json(c, { published: versionId, publication_id: publicationId, pipeline_stages: newStageLabels })
})

app.post('/api/sales-process/publications/:publicationId/rollback', requireAuth, async (c) => {
  if (!requireSalesProcessAdmin(c)) return err(c, 'Administrator or sales manager access required', 403)
  const companyId = c.var.companyId as string
  const actorId = c.var.repId as string
  const publication = await c.env.DB.prepare("SELECT * FROM sales_process_publications WHERE id=? AND company_id=? AND action='publish'").bind(c.req.param('publicationId'), companyId).first<any>()
  if (!publication?.previous_version_id) return err(c, 'No previous published version is available', 409)
  const history = await c.env.DB.prepare('SELECT * FROM sales_migration_history WHERE company_id=? AND migration_batch_id=?').bind(companyId, publication.migration_batch_id).all<any>()
  const statements: any[] = [
    c.env.DB.prepare("UPDATE sales_process_versions SET lifecycle='rolled_back',updated_at=datetime('now') WHERE id=? AND company_id=?").bind(publication.process_version_id, companyId),
    c.env.DB.prepare("UPDATE sales_process_versions SET lifecycle='published',updated_at=datetime('now') WHERE id=? AND company_id=?").bind(publication.previous_version_id, companyId)
  ]
  // Restore the legacy pipeline_stages setting captured at publish time so the
  // live board columns revert together with the process version.
  let publicationImpact: any = {}; try { publicationImpact = JSON.parse(publication.impact_json || '{}') } catch (_) {}
  if (Array.isArray(publicationImpact.previous_pipeline_stages) && publicationImpact.previous_pipeline_stages.length >= 2) {
    statements.push(c.env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").bind(`${companyId}:pipeline_stages`, JSON.stringify(publicationImpact.previous_pipeline_stages)))
  } else if (publicationImpact.previous_pipeline_stages === null) {
    statements.push(c.env.DB.prepare('DELETE FROM settings WHERE key=?').bind(`${companyId}:pipeline_stages`))
  }
  for (const h of history.results as any[]) {
    let historyEvent: any = {}; try { historyEvent = JSON.parse(h.event_json || '{}') } catch (_) {}
    if (h.event_type === 'published' && (typeof historyEvent.previous_status === 'string' || typeof historyEvent.previous_pipeline_stage === 'string')) {
      statements.push(c.env.DB.prepare('UPDATE opportunities SET sales_process_stage_id=?,status=?,pipeline_stage=?,updated_at=updated_at WHERE id=? AND company_id=?').bind(h.previous_stage_id || '', historyEvent.previous_status ?? '', historyEvent.previous_pipeline_stage ?? '', h.opportunity_id, companyId))
    } else {
      statements.push(c.env.DB.prepare('UPDATE opportunities SET sales_process_stage_id=?,updated_at=updated_at WHERE id=? AND company_id=?').bind(h.previous_stage_id || '', h.opportunity_id, companyId))
    }
    statements.push(c.env.DB.prepare(`UPDATE sales_stage_assignments SET stage_id=?,outcome_type=?,classification=?,assigned_at=datetime('now'),assigned_by=?
      WHERE company_id=? AND opportunity_id=? AND process_version_id=?`).bind(h.previous_stage_id || '', historyEvent.previous_outcome_type || '', historyEvent.previous_classification || 'rollback_restored', actorId, companyId, h.opportunity_id, publication.previous_version_id))
    statements.push(c.env.DB.prepare(`INSERT INTO sales_migration_history (id,company_id,migration_batch_id,opportunity_id,previous_process_version_id,new_process_version_id,previous_stage_id,previous_label,new_stage_id,actor_id,event_type,event_json) VALUES (?,?,?,?,?,?,?,?,?,?,'rollback','{}')`).bind(`hist_${uid()}`, companyId, publication.migration_batch_id, h.opportunity_id, publication.process_version_id, publication.previous_version_id, h.new_stage_id, h.previous_label, h.previous_stage_id || '', actorId))
  }
  statements.push(c.env.DB.prepare(`INSERT INTO sales_process_publications (id,company_id,process_id,process_version_id,previous_version_id,migration_batch_id,action,actor_id,impact_json) VALUES (?,?,?,?,?,?,'rollback',?,?)`).bind(`pub_${uid()}`, companyId, publication.process_id, publication.previous_version_id, publication.process_version_id, publication.migration_batch_id, actorId, JSON.stringify({ restored_opportunities: history.results.length })))
  await c.env.DB.batch(statements)
  return json(c, { rolled_back_to: publication.previous_version_id, restored_opportunities: history.results.length })
})

// Company-scoped runtime context shared by Stage Guide, Call Companion, and Academy.
app.get('/api/opportunities/:id/sales-context', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const opportunityId = c.req.param('id')
  const opportunity = await c.env.DB.prepare('SELECT id,status,pipeline_stage,sales_process_stage_id FROM opportunities WHERE id=? AND company_id=?').bind(opportunityId, companyId).first<any>()
  if (!opportunity) return err(c, 'Opportunity not found', 404)
  const assignment = await c.env.DB.prepare(`SELECT a.*,v.lifecycle FROM sales_stage_assignments a
    JOIN sales_process_versions v ON v.id=a.process_version_id AND v.company_id=a.company_id
    WHERE a.company_id=? AND a.opportunity_id=? AND v.lifecycle='published' LIMIT 1`).bind(companyId, opportunityId).first<any>()
  if (!assignment) {
    const status = String(opportunity.status || '')
    const pipelineStage = String(opportunity.pipeline_stage || '')
    const conflict = Boolean(status && pipelineStage && status !== pipelineStage)
    const legacyLabel = status || pipelineStage
    return json(c, {
      normalized: false,
      legacy_label: legacyLabel,
      needs_restaging: conflict || !LEGACY_STAGE_MAP[legacyLabel],
      restaging_reason: conflict ? 'conflicting_legacy_fields' : (!LEGACY_STAGE_MAP[legacyLabel] ? 'unknown_legacy_label' : '')
    })
  }
  const stage = await c.env.DB.prepare('SELECT * FROM sales_process_stages WHERE company_id=? AND process_version_id=? AND id=?').bind(companyId, assignment.process_version_id, assignment.stage_id).first<any>()
  if (!stage) return json(c, { normalized: false, legacy_label: opportunity.status || opportunity.pipeline_stage || '', needs_restaging: true })
  const [requirements, guides, resources, transitions, skills] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM sales_stage_requirements WHERE company_id=? AND process_version_id=? AND stage_id=? ORDER BY display_order').bind(companyId, assignment.process_version_id, stage.id).all(),
    c.env.DB.prepare('SELECT * FROM sales_stage_guides WHERE company_id=? AND process_version_id=? AND stage_id=? ORDER BY display_order').bind(companyId, assignment.process_version_id, stage.id).all(),
    c.env.DB.prepare("SELECT * FROM sales_process_resources WHERE company_id=? AND process_version_id=? AND active=1 AND (stage_id='' OR stage_id=?) ORDER BY resource_type,name").bind(companyId, assignment.process_version_id, stage.id).all(),
    c.env.DB.prepare(`SELECT t.to_stage_id,s.display_name,s.stable_key,s.semantic_type,t.requires_override,t.outcome_type,t.display_label,t.guidance FROM sales_stage_transition_paths t
      JOIN sales_process_stages s ON s.id=t.to_stage_id AND s.company_id=t.company_id AND s.process_version_id=t.process_version_id
      WHERE t.company_id=? AND t.process_version_id=? AND t.from_stage_id=? AND t.active=1 ORDER BY s.display_order`).bind(companyId, assignment.process_version_id, stage.id).all(),
    c.env.DB.prepare(`SELECT sk.*,a.visibility,a.display_order AS association_order FROM sales_academy_associations a
      JOIN sales_academy_skills sk ON sk.id=a.skill_id AND sk.active=1 AND (sk.company_id=? OR (sk.company_id='__global__' AND sk.is_global=1))
      WHERE a.company_id=? AND a.process_version_id=? AND a.stage_id=?
        AND (a.internal_status_id='' OR a.internal_status_id=?) ORDER BY a.display_order,sk.title`)
      .bind(companyId, companyId, assignment.process_version_id, stage.id, assignment.internal_status_id || '').all()
  ])
  return json(c, { normalized: true, assignment, stage, requirements: requirements.results, guides: guides.results, resources: resources.results, transitions: transitions.results, academy_skills: skills.results })
})

app.get('/api/sales-process/playbook', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const version = await c.env.DB.prepare("SELECT * FROM sales_process_versions WHERE company_id=? AND lifecycle='published' ORDER BY published_at DESC LIMIT 1").bind(companyId).first<any>()
  if (!version) return json(c, { normalized: false, stages: [] })
  const [stages, guides, associations] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM sales_process_stages WHERE company_id=? AND process_version_id=? AND state='active' ORDER BY display_order").bind(companyId, version.id).all<any>(),
    c.env.DB.prepare('SELECT * FROM sales_stage_guides WHERE company_id=? AND process_version_id=? ORDER BY stage_id,display_order').bind(companyId, version.id).all<any>(),
    c.env.DB.prepare(`SELECT a.stage_id,a.internal_status_id,a.visibility,a.display_order,sk.id AS skill_id,sk.stable_key,sk.title,sk.content_json
      FROM sales_academy_associations a JOIN sales_academy_skills sk ON sk.id=a.skill_id AND sk.active=1
        AND (sk.company_id=? OR (sk.company_id='__global__' AND sk.is_global=1))
      WHERE a.company_id=? AND a.process_version_id=? ORDER BY a.stage_id,a.display_order`).bind(companyId, companyId, version.id).all<any>()
  ])
  return json(c, { normalized: true, version_id: version.id, stages: (stages.results as any[]).map(stage => ({
    ...stage,
    guides: (guides.results as any[]).filter(guide => guide.stage_id === stage.id),
    training: (associations.results as any[]).filter(association => association.stage_id === stage.id)
  })) })
})

// Stable transitions update only normalized assignments. Legacy stage text stays
// untouched throughout the compatibility period and every transition is audited.
app.on(['PUT', 'POST'], ['/api/opportunities/:id/sales-stage', '/api/opportunities/:id/stage-transition'], requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const actorId = c.var.repId as string
  const opportunityId = c.req.param('id')
  const body = await c.req.json()
  const assignment = await c.env.DB.prepare(`SELECT a.* FROM sales_stage_assignments a
    JOIN sales_process_versions v ON v.id=a.process_version_id AND v.company_id=a.company_id
    WHERE a.company_id=? AND a.opportunity_id=? AND v.lifecycle='published' LIMIT 1`).bind(companyId, opportunityId).first<any>()
  if (!assignment) return err(c, 'Opportunity needs an approved published-process assignment', 409)
  const expectedStageId = String(body.expected_stage_id || '')
  if (!expectedStageId) return err(c, 'The current stable stage is required', 400)
  if (expectedStageId !== String(assignment.stage_id || '')) return err(c, 'The opportunity stage changed; refresh before transitioning', 409)
  const targetId = String(body.stage_id || '')
  const target = await c.env.DB.prepare("SELECT * FROM sales_process_stages WHERE company_id=? AND process_version_id=? AND id=? AND state='active'").bind(companyId, assignment.process_version_id, targetId).first<any>()
  if (!target) return err(c, 'Target stage is not active in this company process', 400)
  const outcomeType = String(body.outcome_type || '')
  let allowed = await c.env.DB.prepare(`SELECT requires_override,override_policy,outcome_type FROM sales_stage_transition_paths
    WHERE company_id=? AND process_version_id=? AND from_stage_id=? AND to_stage_id=? AND active=1
      AND (outcome_type='' OR outcome_type=?) ORDER BY CASE WHEN outcome_type=? THEN 0 ELSE 1 END LIMIT 1`)
    .bind(companyId, assignment.process_version_id, assignment.stage_id, targetId, outcomeType, outcomeType).first<any>()
  if (!allowed) allowed = await c.env.DB.prepare(`SELECT requires_override,'stage_policy' AS override_policy,'' AS outcome_type FROM sales_stage_transitions
    WHERE company_id=? AND process_version_id=? AND from_stage_id=? AND to_stage_id=? AND active=1`).bind(companyId, assignment.process_version_id, assignment.stage_id, targetId).first<any>()
  const overrideReason = String(body.override_reason || '').trim()
  const isManager = requireSalesProcessAdmin(c)
  const configuredManagerOverride = Boolean(allowed && (Number(allowed.requires_override) || ['manager_required','manager_only'].includes(String(allowed.override_policy || ''))))
  const managerRequired = !allowed || configuredManagerOverride
  const overrideResponse = (message: string, status: number, details: any = {}) => c.json({ ok: false, error: message, data: {
    code: 'sales_transition_override_required', override_required: true, manager_required: true,
    from_stage_id: assignment.stage_id || '', to_stage_id: targetId, ...details
  } }, status)
  if (managerRequired && !isManager) return overrideResponse('This stage transition requires a manager override', 403)
  if (managerRequired && !overrideReason) return overrideResponse('An override reason is required', 409)
  if (outcomeType && !['won','lost','disqualified','nurture'].includes(outcomeType)) return err(c, 'Invalid terminal outcome', 400)
  const terminalSemantics = ['terminal','won','lost','disqualified','nurture']
  if (terminalSemantics.includes(String(target.semantic_type)) && !outcomeType) return err(c, 'A terminal outcome is required', 400)
  if (!terminalSemantics.includes(String(target.semantic_type)) && outcomeType) return err(c, 'An outcome can only be recorded at a terminal stage', 400)
  if (outcomeType) {
    const configuredOutcome = await c.env.DB.prepare(`SELECT id FROM sales_stage_outcomes
      WHERE company_id=? AND process_version_id=? AND stage_id=? AND semantic_type=? AND active=1`)
      .bind(companyId, assignment.process_version_id, targetId, outcomeType).first()
    if (!configuredOutcome) return err(c, 'The selected outcome is not configured for this terminal stage', 400)
  }
  const requirementRows = await c.env.DB.prepare(`SELECT * FROM sales_stage_requirements
    WHERE company_id=? AND process_version_id=? AND required_level IN ('required','manager_review')
      AND (stage_id=? OR stage_id=?) ORDER BY stage_id,display_order`)
    .bind(companyId, assignment.process_version_id, assignment.stage_id, targetId).all<any>()
  const managerOnlyRequirements = (requirementRows.results as any[]).filter(requirement => {
    try { return requirement.required_level === 'manager_review' || JSON.parse(requirement.config_json || '{}').manager_only === true }
    catch (_) { return requirement.required_level === 'manager_review' }
  })
  if (managerOnlyRequirements.length && !isManager) return overrideResponse('This transition contains manager-only requirements', 403, {
    missing_requirements: managerOnlyRequirements.map(requirement => ({ id: requirement.id, stable_key: requirement.stable_key, label: requirement.label, required_level: requirement.required_level }))
  })
  const evidenceRows = await c.env.DB.prepare(`SELECT * FROM sales_stage_checklist_evidence
    WHERE company_id=? AND opportunity_id=? AND process_version_id=? AND (stage_id=? OR stage_id=?)`)
    .bind(companyId, opportunityId, assignment.process_version_id, assignment.stage_id, targetId).all<any>()
  const evidenceByRequirement = new Map((evidenceRows.results as any[]).map(row => [String(row.requirement_id), row]))
  const opportunity = await c.env.DB.prepare('SELECT * FROM opportunities WHERE id=? AND company_id=?').bind(opportunityId, companyId).first<any>()
  const nextTask = await c.env.DB.prepare(`SELECT title,due_date FROM tasks WHERE company_id=? AND linked_record_id=?
    AND linked_record_type IN ('lead','opportunity') AND status='open' ORDER BY CASE WHEN due_date IS NULL OR due_date='' THEN 1 ELSE 0 END,due_date LIMIT 1`)
    .bind(companyId, opportunityId).first<any>()
  const hasEvidenceValue = (value: any): boolean => {
    if (value === false || value === null || value === undefined || value === '') return false
    if (Array.isArray(value)) return value.length > 0 && value.every(hasEvidenceValue)
    if (typeof value === 'object') return Object.keys(value).length > 0 && Object.values(value).every(hasEvidenceValue)
    return true
  }
  const opportunityEvidence: Record<string, any> = {
    lead_source: opportunity?.source, assigned_owner: opportunity?.assigned_to_rep_id || opportunity?.rep_id,
    contact_details: opportunity?.email || opportunity?.phone, property_address: opportunity?.address,
    requested_service: opportunity?.service_line || opportunity?.project,
    next_action: opportunity?.next_action || opportunity?.next_follow_up || nextTask?.title,
    next_action_date: opportunity?.next_action_date || opportunity?.next_follow_up || nextTask?.due_date
  }
  const missingRequirements = (requirementRows.results as any[]).filter(requirement => {
    let config: any = {}; try { config = JSON.parse(requirement.config_json || '{}') } catch (_) {}
    const phase = String(config.phase || 'general')
    if (requirement.stage_id === assignment.stage_id && !['general','exit'].includes(phase)) return false
    if (requirement.stage_id === targetId && !['general','entry'].includes(phase)) return false
    const evidence: any = evidenceByRequirement.get(String(requirement.id))
    if (evidence && Number(evidence.completed) === 1) {
      let detail: any = {}; try { detail = JSON.parse(evidence.evidence_json || '{}') } catch (_) { return true }
      if (!Object.keys(detail).length || hasEvidenceValue(detail)) return false
    }
    return !hasEvidenceValue(opportunityEvidence[String(requirement.stable_key || '')])
  }).map(requirement => ({ id: requirement.id, stable_key: requirement.stable_key, label: requirement.label, required_level: requirement.required_level }))
  if (missingRequirements.length) {
    if (!isManager) return overrideResponse('Required transition evidence is incomplete', 409, { code: 'sales_transition_evidence_incomplete', missing_requirements: missingRequirements })
    if (!overrideReason) return overrideResponse('An override reason is required for incomplete transition evidence', 409, { code: 'sales_transition_evidence_incomplete', missing_requirements: missingRequirements })
  }
  const eventId = `transition_${uid()}`
  const transitionResults = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO sales_stage_transition_events (id,company_id,opportunity_id,process_version_id,from_stage_id,to_stage_id,outcome_type,actor_id,override_reason)
      SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (
        SELECT 1 FROM sales_stage_assignments WHERE id=? AND company_id=? AND stage_id=?
      ) AND EXISTS (
        SELECT 1 FROM opportunities WHERE id=? AND company_id=? AND sales_process_stage_id=?
      )`).bind(eventId, companyId, opportunityId, assignment.process_version_id, assignment.stage_id || '', targetId, outcomeType, actorId, overrideReason, assignment.id, companyId, expectedStageId, opportunityId, companyId, expectedStageId),
    c.env.DB.prepare(`UPDATE sales_stage_assignments SET stage_id=?,outcome_type=?,classification='transitioned',assigned_at=datetime('now'),assigned_by=? WHERE id=? AND company_id=? AND stage_id=?`).bind(targetId, outcomeType, actorId, assignment.id, companyId, expectedStageId),
    // The legacy status and pipeline_stage labels follow the stable transition so
    // the pipeline board, lead flow, and reports stay aligned with the process.
    c.env.DB.prepare('UPDATE opportunities SET sales_process_stage_id=?,status=?,pipeline_stage=?,updated_at=datetime(\'now\') WHERE id=? AND company_id=? AND sales_process_stage_id=?').bind(targetId, String(target.board_label || target.display_name || ''), String(target.board_label || target.display_name || ''), opportunityId, companyId, expectedStageId)
  ])
  if (Number((transitionResults[0] as any)?.meta?.changes || 0) !== 1) return err(c, 'The opportunity stage changed; refresh before transitioning', 409)
  await logActivity(c.env.DB, { companyId, actorId, actorName: actorId, entityType: 'opportunity', entityId: opportunityId, entityLabel: opportunityId, action: 'sales_stage_transitioned', beforeJson: { stage_id: assignment.stage_id }, afterJson: { stage_id: targetId, outcome_type: outcomeType, override_reason: overrideReason } })
  return json(c, { transitioned: opportunityId, event_id: eventId, stage: target })
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
    admin: ['gwDashboard','gwSales','gwFinancial','gwOperations','gwMarketing','gwAdmin',
      'gwMarketing','marketingCampaigns','marketingAudiences','marketingBrand','marketingMedia','marketingForms','marketingAnalytics',
      'today','myDashboard','teamView','pipeline','lead','clients','properties','estimates','proposals',
      'communications','textMessages','templates','sequences','talkTracks','playbooks','aiAssist',
      'automations','campaigns','process','forms','scripts','emailTemplates','objections','calculator','ai','academy',
      'financialHub','invoices','payments','deposits','statements','financialActivity',
      'scheduleBoard','dispatchBoard','recurringServices','crewView','workOrderList','workOrderDetail',
      'assetsHub','assetList','assetDetail','maintenanceQueue','inventoryList','materialAllocation','toolsConsumables','timeTracker',
      'revenueAdmin','teamReports',
      'settings','userManagement','integrations','manager','systemConfig','systemTemplates','opsHub','pricing',
      'approvalQueue','auditLog','portalAdmin','automationCenter','fieldMode'],
    office_manager: ['gwDashboard','gwSales','gwFinancial','gwOperations','gwMarketing','gwAdmin',
      'gwMarketing','marketingCampaigns','marketingAudiences','marketingBrand','marketingMedia','marketingForms','marketingAnalytics',
      'today','myDashboard','teamView','pipeline','lead','clients','properties','estimates','proposals',
      'communications','textMessages','templates','sequences','talkTracks','playbooks','aiAssist',
      'automations','campaigns','process','forms','scripts','emailTemplates','objections','calculator','ai','academy',
      'financialHub','invoices','payments','deposits','statements','financialActivity',
      'scheduleBoard','dispatchBoard','recurringServices','crewView','workOrderList','workOrderDetail',
      'assetsHub','assetList','assetDetail','maintenanceQueue','inventoryList','materialAllocation','toolsConsumables','timeTracker',
      'revenueAdmin','teamReports',
      'settings','userManagement','integrations','manager','pricing','approvalQueue','auditLog','portalAdmin','automationCenter','fieldMode'],
    rep: ['gwDashboard','gwSales','gwMarketing',
      'marketingCampaigns','marketingAnalytics',
      'today','myDashboard','pipeline','lead','clients','properties','estimates','proposals',
      'communications','textMessages','templates','sequences','talkTracks','playbooks','aiAssist',
      'automations','campaigns','process','forms','scripts','emailTemplates','objections','calculator','ai','academy'],
    estimator: ['gwDashboard','gwSales','today','pipeline','clients','properties','estimates','proposals','calculator','forms','playbooks'],
    foreman: ['gwDashboard','gwOperations','gwAdmin',
      'today','fieldDashboard','myDashboard','scheduleBoard','dispatchBoard','recurringServices','crewView',
      'workOrderList','workOrderDetail','assetsHub','assetList','assetDetail',
      'maintenanceQueue','inventoryList','toolsConsumables','timeTracker',
      'teamReports','approvalQueue','fieldMode','gwTimesheetAdmin'],
    laborer: ['gwDashboard','gwOperations','today','fieldDashboard','scheduleBoard','workOrderList','assetsHub','timeTracker','fieldMode'],
    mechanic: ['gwDashboard','gwOperations','today','fieldDashboard','assetsHub','assetList','assetDetail','maintenanceQueue','inventoryList','toolsConsumables','timeTracker'],
    division_manager: ['gwDashboard','gwOperations','gwAdmin',
      'today','fieldDashboard','myDashboard','scheduleBoard','dispatchBoard','recurringServices','crewView',
      'workOrderList','workOrderDetail','assetsHub','assetList','assetDetail',
      'maintenanceQueue','inventoryList','toolsConsumables','timeTracker',
      'teamReports','approvalQueue','fieldMode','gwTimesheetAdmin','userManagement'],
    view_only: ['gwDashboard','today','pipeline'],
    // Legacy alias — field_supervisor rows in D1 still get correct permissions
    field_supervisor: ['gwDashboard','gwOperations','gwAdmin',
      'today','fieldDashboard','myDashboard','scheduleBoard','dispatchBoard','recurringServices','crewView',
      'workOrderList','workOrderDetail','assetsHub','assetList','assetDetail',
      'maintenanceQueue','inventoryList','toolsConsumables','timeTracker',
      'teamReports','approvalQueue','fieldMode','gwTimesheetAdmin']
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
    : role === 'division_manager' ? 'Division Manager'
    : role === 'estimator' ? 'Estimator'
    : role === 'foreman' ? 'Foreman'
    : role === 'field_supervisor' ? 'Foreman'
    : role === 'laborer' ? 'Laborer'
    : role === 'mechanic' ? 'Mechanic'
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
      <div style="font-size:22px;font-weight:800;color:#e8e4d9;letter-spacing:-0.5px">Groundwork CRM</div>
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
  {
    const _b = await c.req.raw.clone().json().catch(() => ({} as any))
    if (role === 'office_manager' && !c.var.isSuperAdmin && _b && _b.role === 'admin')
      return err(c, 'Only an admin can invite another admin', 403)
  }

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
    : rep.role === 'division_manager' ? 'Division Manager'
    : rep.role === 'estimator' ? 'Estimator'
    : rep.role === 'foreman' ? 'Foreman'
    : rep.role === 'field_supervisor' ? 'Foreman'
    : rep.role === 'laborer' ? 'Laborer'
    : rep.role === 'mechanic' ? 'Mechanic'
    : rep.role === 'view_only' ? 'View Only' : 'Sales Rep'

  if (!rep) {
    return c.html(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invalid Invite — Groundwork CRM</title>
<style>*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1510;color:#e8e4d9;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}</style>
</head><body>
<div style="text-align:center;max-width:420px">
  <div style="margin-bottom:16px"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#4D8A86" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></div>
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
    <div style="font-size:20px;font-weight:800;color:#e8e4d9;letter-spacing:-0.5px;margin-bottom:4px;display:flex;align-items:center;justify-content:center;gap:8px"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4D8A86" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/></svg>Groundwork CRM</div>
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
  const companyId = c.var.companyId as string
  await ensurePortfolioSchema(c.env.DB)
  const repId     = c.req.query('repId')
  const status    = c.req.query('status')
  let q = `SELECT o.*,
    (SELECT a.outcome_type FROM sales_stage_assignments a JOIN sales_process_versions v ON v.id=a.process_version_id AND v.company_id=a.company_id
      WHERE a.company_id=o.company_id AND a.opportunity_id=o.id AND v.lifecycle='published' LIMIT 1) AS sales_process_outcome_type,
    (SELECT a.process_version_id FROM sales_stage_assignments a JOIN sales_process_versions v ON v.id=a.process_version_id AND v.company_id=a.company_id
      WHERE a.company_id=o.company_id AND a.opportunity_id=o.id AND v.lifecycle='published' LIMIT 1) AS sales_process_version_id,
    (SELECT a.assigned_at FROM sales_stage_assignments a JOIN sales_process_versions v ON v.id=a.process_version_id AND v.company_id=a.company_id
      WHERE a.company_id=o.company_id AND a.opportunity_id=o.id AND v.lifecycle='published' LIMIT 1) AS sales_process_assigned_at,
    (SELECT e.status FROM estimates e WHERE e.company_id=o.company_id AND e.opp_id=o.id ORDER BY e.updated_at DESC LIMIT 1) AS linked_estimate_status
    FROM opportunities o WHERE o.company_id = ?`
  const params: any[] = [companyId]
  // When filtering by rep: show leads where rep_id = X OR assigned_to_rep_id = X
  // This ensures a lead created by Jen but assigned to Tyler appears in Tyler's list
  if (repId)  {
    q += ' AND (o.rep_id = ? OR (o.assigned_to_rep_id != \'\' AND o.assigned_to_rep_id = ?))'
    params.push(repId, repId)
  }
  if (status) { q += ' AND o.status = ?';  params.push(status) }
  q += ' ORDER BY o.updated_at DESC'
  const rows = await c.env.DB.prepare(q).bind(...params).all()
  return json(c, rows.results)
})

// GET /api/opportunities/:id?companyId=
app.get('/api/opportunities/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
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
  await ensurePortfolioSchema(c.env.DB)
  const id        = b.id || ('opp_' + uid())
  // Session company_id is authoritative — body companyId is a hint only
  const companyId = c.var.companyId as string
  const effRepId = b.repId||b.rep_id||null
  // assigned_to_rep_id: if Jen creates and assigns to Tyler, set to Tyler's id
  // defaults to same as rep_id (owner = assignee for reps creating their own leads)
  const assignedTo = b.assignedToRepId||b.assigned_to_rep_id||effRepId||''
  // New-lead default stage: first label of the company's live pipeline setting
  // (kept in sync with the published sales process on publish), falling back to
  // the legacy nine-stage default only when the setting is absent.
  // Shared with the public inquiry form via src/marketing/leads.ts so a form
  // submission lands in the same stage a rep-created lead would.
  const effStatus = b.status || await resolveDefaultPipelineStage(c.env.DB, companyId)
  await insertOpportunityRow(c.env.DB, companyId, {
    id, repId: effRepId, assignedToRepId: assignedTo,
    client: b.client||'', phone: b.phone||'', email: b.email||'',
    address: b.address||'', serviceLine: b.serviceLine||b.service_line||'', source: b.source||'',
    status: effStatus, jobValue: Number(b.jobValue||b.job_value||0),
    project: b.project||'', urgency: b.urgency||'', decisionMaker: b.decisionMaker||b.decision_maker||'',
    budgetRange: b.budgetRange||b.budget_range||'', nextFollowUp: b.nextFollowUp||b.next_follow_up||'',
    pipelineStage: b.pipelineStage||b.pipeline_stage||'',
    estimateAmount: Number(b.estimateAmount||b.estimate_amount||0),
    estimateSentDate: b.estimateSentDate||b.estimate_sent_date||'',
    estimateCount: Number(b.estimateCount||b.estimate_count||0),
    workType: b.workType||b.work_type||'', clientType: b.clientType||b.client_type||'',
    prompt: b.prompt||'', desiredOutcome: b.desiredOutcome||b.desired_outcome||'',
    fitConcerns: b.fitConcerns||b.fit_concerns||'',
    commissionApproved: !!(b.commissionApproved||b.commission_approved),
    collected: !!b.collected, soldDate: b.soldDate||b.sold_date||'',
    soldAmount: Number(b.soldAmount||b.sold_amount||0),
    clientId: b.clientId||b.client_id||''
  })
  // Published-process lead flow: a brand new lead is immediately assigned to the
  // published stage whose label matches its status (default: the first stage),
  // so it participates in stage tracking without needing restaging review.
  try { await syncPublishedStageAssignment(c.env.DB, companyId, id, effStatus, c.var.repId as string) } catch (_) {}
  // Broadcast + activity log (non-blocking)
  c.executionCtx?.waitUntil?.(Promise.all([
    c.env.DB.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    ).bind(`${companyId}:last_write`, `${new Date().toISOString()}|${c.var.repId}`).run(),
    logActivity(c.env.DB, {
      companyId, actorId: c.var.repId, actorName: c.var.repId,
      entityType: 'opportunity', entityId: id,
      entityLabel: b.client || id,
      action: 'created', afterJson: { client: b.client, status: effStatus, repId: effRepId }
    })
  ]))
  return json(c, { id }, 201)
})

// PUT /api/opportunities/:id
app.put('/api/opportunities/:id', requireAuth, async (c) => {
  const id        = c.req.param('id')
  const b         = await c.req.json()
  const companyId = c.var.companyId as string
  await ensurePortfolioSchema(c.env.DB)
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
    commission_approved:'commission_approved', sold_date:'sold_date', sold_amount:'sold_amount',
    clientId:'client_id', client_id:'client_id'
  }
  // Dual-write: every money column below also gets its *_cents twin set in
  // the same statement (migrations/0058_money_cents.sql, Stage 2 of the
  // money-representation migration — additive only, readers still use the
  // float column this stage).
  const MONEY_CENTS_COLS: Record<string,string> = {
    job_value: 'job_value_cents', estimate_amount: 'estimate_amount_cents', sold_amount: 'sold_amount_cents',
  }
  const updates: string[] = []
  const vals: any[] = []
  for (const [key, col] of Object.entries(fieldMap)) {
    if (b[key] !== undefined && !updates.includes(`${col} = ?`)) {
      updates.push(`${col} = ?`)
      vals.push(b[key])
      if (MONEY_CENTS_COLS[col]) {
        updates.push(`${MONEY_CENTS_COLS[col]} = ?`)
        vals.push(Math.round(Number(b[key]) * 100))
      }
    }
  }
  if (!updates.length) return err(c, 'Nothing to update')
  await c.env.DB.prepare(
    `UPDATE opportunities SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ? AND company_id = ?`
  ).bind(...vals, id, companyId).run()
  // Board drag-and-drop and record edits write legacy status labels; keep the
  // published-process stable assignment in step when the label matches a stage.
  if (b.status !== undefined || b.pipelineStage !== undefined || b.pipeline_stage !== undefined) {
    try { await syncPublishedStageAssignment(c.env.DB, companyId, id, String(b.status ?? b.pipelineStage ?? b.pipeline_stage ?? ''), c.var.repId as string) } catch (_) {}
  }
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
  const companyId = c.var.companyId as string
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
  const companyId = c.var.companyId as string
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
    const bulkJobValueNum = Number(opp.jobValue||opp.job_value||0)
    const bulkEstimateAmountNum = Number(opp.estimateAmount||opp.estimate_amount||0)
    const bulkSoldAmountNum = Number(opp.soldAmount||opp.sold_amount||0)
    await c.env.DB.prepare(`
      INSERT INTO opportunities (
        id, company_id, rep_id, client, phone, email, address, service_line, source, status,
        job_value, job_value_cents, project, urgency, decision_maker, budget_range, next_follow_up,
        pipeline_stage, estimate_amount, estimate_amount_cents, estimate_sent_date, estimate_count,
        work_type, client_type, prompt, desired_outcome, fit_concerns,
        commission_approved, collected, sold_date, sold_amount, sold_amount_cents,
        created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
        COALESCE(?,datetime('now')), COALESCE(?,datetime('now')))
    `).bind(
      opp.id, companyId, effRepId, opp.client||'', opp.phone||'', opp.email||'',
      opp.address||'', opp.serviceLine||opp.service_line||'', opp.source||'',
      opp.status||'New Lead', bulkJobValueNum, Math.round(bulkJobValueNum * 100),
      opp.project||'', opp.urgency||'', opp.decisionMaker||opp.decision_maker||'',
      opp.budgetRange||opp.budget_range||'', opp.nextFollowUp||opp.next_follow_up||'',
      opp.pipelineStage||opp.pipeline_stage||'',
      bulkEstimateAmountNum, Math.round(bulkEstimateAmountNum * 100),
      opp.estimateSentDate||opp.estimate_sent_date||'',
      Number(opp.estimateCount||opp.estimate_count||0),
      opp.workType||opp.work_type||'', opp.clientType||opp.client_type||'',
      opp.prompt||'', opp.desiredOutcome||opp.desired_outcome||'',
      opp.fitConcerns||opp.fit_concerns||'',
      opp.commissionApproved||opp.commission_approved?1:0,
      opp.collected?1:0, opp.soldDate||opp.sold_date||'',
      bulkSoldAmountNum, Math.round(bulkSoldAmountNum * 100),
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

app.get('/api/academy/progress/:repId', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const rows = await c.env.DB.prepare(
    'SELECT * FROM academy_progress WHERE rep_id = ? AND company_id = ?'
  ).bind(c.req.param('repId'), companyId).all()
  return json(c, rows.results)
})

app.put('/api/academy/progress', requireAuth, async (c) => {
  const b = await c.req.json()
  const { repId, moduleId, sectionId, completed, score } = b
  const companyId = c.var.companyId as string
  const id = `acad-${companyId}-${repId}-${moduleId}-${sectionId||'_'}`
  await c.env.DB.prepare(`
    INSERT INTO academy_progress (id, rep_id, module_id, section_id, completed, score, company_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(rep_id, module_id, section_id) DO UPDATE SET
      completed = excluded.completed, score = excluded.score, updated_at = datetime('now')
  `).bind(id, repId, moduleId, sectionId||null, completed?1:0, score||0, companyId).run()
  return json(c, { id })
})

app.get('/api/academy/quiz/:repId', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const rows = await c.env.DB.prepare(
    'SELECT * FROM quiz_attempts WHERE rep_id = ? AND company_id = ? ORDER BY attempted_at DESC'
  ).bind(c.req.param('repId'), companyId).all()
  return json(c, rows.results)
})

app.post('/api/academy/quiz', requireAuth, async (c) => {
  const b = await c.req.json()
  const companyId = c.var.companyId as string
  const id = 'quiz_' + uid()
  await c.env.DB.prepare(
    'INSERT INTO quiz_attempts (id, rep_id, module_id, score, total, passed, answers, company_id) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(id, b.repId, b.moduleId, b.score||0, b.total||0, b.passed?1:0, JSON.stringify(b.answers||[]), companyId).run()
  return json(c, { id }, 201)
})

app.get('/api/academy/badges/:repId', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const rows = await c.env.DB.prepare(
    'SELECT * FROM badges WHERE rep_id = ? AND company_id = ?'
  ).bind(c.req.param('repId'), companyId).all()
  return json(c, rows.results)
})

app.post('/api/academy/badges', requireAuth, async (c) => {
  const b = await c.req.json()
  const { repId, badgeId } = b
  const companyId = c.var.companyId as string
  const id = `badge-${companyId}-${repId}-${badgeId}`
  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO badges (id, rep_id, badge_id, company_id) VALUES (?,?,?,?)'
  ).bind(id, repId, badgeId, companyId).run()
  return json(c, { id }, 201)
})

app.get('/api/academy/certs/:repId', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const rows = await c.env.DB.prepare(
    'SELECT * FROM certifications WHERE rep_id = ? AND company_id = ?'
  ).bind(c.req.param('repId'), companyId).all()
  return json(c, rows.results)
})

app.put('/api/academy/certs', requireAuth, async (c) => {
  const b = await c.req.json()
  const { repId, phaseId, status } = b
  const companyId = c.var.companyId as string
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

// Rich contact fields without dedicated columns ride in clients.extra (JSON).
const CLIENT_EXTRA_FIELDS = ['company','firstName','lastName','homeworksId','ccEmails','phone2','mailingStreet','mailingCity','mailingState','mailingZip','poc','billingContact','siteContact','paymentMethod'] as const
function _packClientExtra(b: any): string | null {
  const extra: Record<string, any> = {}
  let any = false
  for (const f of CLIENT_EXTRA_FIELDS) {
    if (b[f] !== undefined) { extra[f] = b[f]; any = true }
  }
  return any ? JSON.stringify(extra) : null
}
function _unpackClientRow(row: any): any {
  const out: any = { ...row }
  try { out.tags = JSON.parse(row.tags || '[]') } catch { out.tags = [] }
  try { out.properties = JSON.parse(row.properties || '[]') } catch { out.properties = [] }
  try { Object.assign(out, JSON.parse(row.extra || '{}')) } catch {}
  delete out.extra
  return out
}

app.get('/api/clients', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  await ensurePortfolioSchema(c.env.DB)
  const rows = await c.env.DB.prepare(
    'SELECT * FROM clients WHERE company_id = ? ORDER BY name ASC'
  ).bind(companyId).all()
  return json(c, (rows.results as any[]).map(_unpackClientRow))
})

app.post('/api/clients', requireAuth, async (c) => {
  const b = await c.req.json()
  const id        = b.id || ('client_' + uid())
  const companyId = c.var.companyId as string
  await ensurePortfolioSchema(c.env.DB)
  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO clients (
       id, name, phone, email, address, type, notes, company_id,
       street, street2, city, state, zip, mobile, email2, since, tags, properties, status, extra,
       created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`
  ).bind(
    id, b.name||'', b.phone||'', b.email||'', b.address||'', b.type||'Residential', b.notes||'', companyId,
    b.street||'', b.street2||'', b.city||'', b.state||'', b.zip||'', b.mobile||'', b.email2||'', b.since||'',
    JSON.stringify(b.tags||[]), JSON.stringify(b.properties||[]), b.status||'Active', _packClientExtra(b)
  ).run()
  return json(c, { id }, 201)
})

// NOTE: this is an UPSERT, not a plain UPDATE. Root-cause fix (2026-07-31):
// the frontend assigns a client-side id the moment a new client is created
// (before any network round-trip), so DB.clients.save() sees client.id
// truthy and calls PUT on the very first save — a POST never happens. A
// plain "UPDATE ... WHERE id=?" against a row that doesn't exist yet
// silently matches 0 rows and still returns 200 OK, leaving the client
// stranded in localStorage forever (invisible to any real D1 query, e.g.
// the staff Preview Portal endpoint, while still rendering fine elsewhere
// via the app's localStorage fallback). INSERT ... ON CONFLICT DO UPDATE
// makes this self-healing: first save creates the row, later saves update it.
app.put('/api/clients/:id', requireAuth, async (c) => {
  const id        = c.req.param('id')
  const b         = await c.req.json()
  const companyId = c.var.companyId as string
  await ensurePortfolioSchema(c.env.DB)
  // Merge extra so a partial payload never wipes previously saved rich fields
  let extra = _packClientExtra(b)
  const prev: any = await c.env.DB.prepare('SELECT extra FROM clients WHERE id=? AND company_id=?').bind(id, companyId).first()
  if (extra !== null && prev?.extra) {
    try { extra = JSON.stringify({ ...JSON.parse(prev.extra), ...JSON.parse(extra) }) } catch {}
  }
  await c.env.DB.prepare(
    `INSERT INTO clients (
       id, name, phone, email, address, type, notes, company_id,
       street, street2, city, state, zip, mobile, email2, since, tags, properties, status, extra,
       created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,?, datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, phone=excluded.phone, email=excluded.email, address=excluded.address,
       type=excluded.type, notes=excluded.notes,
       street=COALESCE(excluded.street, clients.street), street2=COALESCE(excluded.street2, clients.street2),
       city=COALESCE(excluded.city, clients.city), state=COALESCE(excluded.state, clients.state),
       zip=COALESCE(excluded.zip, clients.zip), mobile=COALESCE(excluded.mobile, clients.mobile),
       email2=COALESCE(excluded.email2, clients.email2), since=COALESCE(excluded.since, clients.since),
       tags=COALESCE(excluded.tags, clients.tags), properties=COALESCE(excluded.properties, clients.properties),
       status=COALESCE(excluded.status, clients.status), extra=COALESCE(excluded.extra, clients.extra),
       updated_at=datetime('now')
     WHERE clients.company_id = excluded.company_id`
  ).bind(
    id, b.name||'', b.phone||'', b.email||'', b.address||'', b.type||'Residential', b.notes||'', companyId,
    b.street !== undefined ? (b.street||'') : null,
    b.street2 !== undefined ? (b.street2||'') : null,
    b.city !== undefined ? (b.city||'') : null,
    b.state !== undefined ? (b.state||'') : null,
    b.zip !== undefined ? (b.zip||'') : null,
    b.mobile !== undefined ? (b.mobile||'') : null,
    b.email2 !== undefined ? (b.email2||'') : null,
    b.since !== undefined ? (b.since||'') : null,
    b.tags !== undefined ? JSON.stringify(b.tags||[]) : null,
    b.properties !== undefined ? JSON.stringify(b.properties||[]) : null,
    b.status !== undefined ? (b.status||'Active') : null,
    extra
  ).run()
  return json(c, { updated: id, wasCreated: !prev })
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
  await ensurePortfolioSchema(c.env.DB)
  const row: any = await c.env.DB.prepare(
    'SELECT * FROM clients WHERE id = ? AND company_id = ?'
  ).bind(id, companyId).first()
  if (!row) return c.json({ ok: false, error: 'Not found' }, 404)
  return json(c, _unpackClientRow(row))
})

// PUT /api/customers/:id — update a client with all fields
// UPSERT (see comment on PUT /api/clients/:id above) — a plain UPDATE here
// silently no-ops for a client whose first-ever save never went through
// POST, leaving it permanently invisible to D1 despite looking fine in the
// UI (localStorage fallback). INSERT ... ON CONFLICT DO UPDATE self-heals it.
app.put('/api/customers/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const id = c.req.param('id')
  const b: any = await c.req.json()
  await ensurePortfolioSchema(c.env.DB)
  let extra = _packClientExtra(b)
  const prev: any = await c.env.DB.prepare('SELECT extra FROM clients WHERE id=? AND company_id=?').bind(id, companyId).first()
  if (extra !== null && prev?.extra) {
    try { extra = JSON.stringify({ ...JSON.parse(prev.extra), ...JSON.parse(extra) }) } catch {}
  }
  await c.env.DB.prepare(`
    INSERT INTO clients (
      id, name, phone, email, address, type, notes, company_id,
      street, street2, city, state, zip, mobile, email2, since, tags, properties, status, extra,
      created_at, updated_at
    ) VALUES (?, COALESCE(?,''), ?,?,?,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,?, datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name    = CASE WHEN excluded.name = '' THEN clients.name ELSE excluded.name END,
      phone   = COALESCE(excluded.phone, clients.phone),
      email   = COALESCE(excluded.email, clients.email),
      address = COALESCE(excluded.address, clients.address),
      type    = COALESCE(excluded.type, clients.type),
      notes   = COALESCE(excluded.notes, clients.notes),
      street  = COALESCE(excluded.street, clients.street),
      street2 = COALESCE(excluded.street2, clients.street2),
      city    = COALESCE(excluded.city, clients.city),
      state   = COALESCE(excluded.state, clients.state),
      zip     = COALESCE(excluded.zip, clients.zip),
      mobile  = COALESCE(excluded.mobile, clients.mobile),
      email2  = COALESCE(excluded.email2, clients.email2),
      since   = COALESCE(excluded.since, clients.since),
      tags    = COALESCE(excluded.tags, clients.tags),
      properties = COALESCE(excluded.properties, clients.properties),
      status  = COALESCE(excluded.status, clients.status),
      extra   = COALESCE(excluded.extra, clients.extra),
      updated_at = datetime('now')
    WHERE clients.company_id = excluded.company_id
  `).bind(
    id,
    // "!== undefined" (not ||) so an inline edit can clear a field to ''
    b.name || null, // name may never be blanked
    b.phone !== undefined ? b.phone : null, b.email !== undefined ? b.email : null,
    b.address !== undefined ? b.address : null, b.type || null,
    b.notes !== undefined ? b.notes : null,
    companyId,
    b.street !== undefined ? b.street : null, b.street2 !== undefined ? b.street2 : null,
    b.city !== undefined ? b.city : null, b.state !== undefined ? b.state : null,
    b.zip !== undefined ? b.zip : null, b.mobile !== undefined ? b.mobile : null,
    b.email2 !== undefined ? b.email2 : null, b.since !== undefined ? b.since : null,
    b.tags !== undefined ? JSON.stringify(b.tags) : null,
    b.properties !== undefined ? JSON.stringify(b.properties) : null,
    b.status||null,
    extra
  ).run()
  return json(c, { updated: id, wasCreated: !prev })
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

// GET /api/payments — list payments (optionally filtered by client) for the
// client portfolio page and financial views. Joins invoice numbers for display.
app.get('/api/payments', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const clientId  = c.req.query('client_id')
  const limit     = Math.min(Number(c.req.query('limit') || 200), 500)
  let q = `SELECT p.*, COALESCE(NULLIF(p.invoice_number,''), i.invoice_number) AS invoice_number_display
           FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
           WHERE p.company_id = ?`
  const params: any[] = [companyId]
  if (clientId) { q += ` AND p.client_id = ?`; params.push(clientId) }
  q += ` ORDER BY p.created_at DESC LIMIT ?`
  params.push(limit)
  const rows = await c.env.DB.prepare(q).bind(...params).all()
  return json(c, rows.results || [])
})

// GET /api/customers/:id/media — site photos linked to this client across all
// jobs (project_media rows carry client_id). Thumbnails render via the staff
// media route /api/admin/portal/media/:id.
app.get('/api/customers/:id/media', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const clientId  = c.req.param('id')
  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.work_order_id, m.file_name, m.kind, m.caption, m.created_at, w.title AS wo_title, w.wo_number
     FROM project_media m LEFT JOIN work_orders w ON w.id = m.work_order_id
     WHERE m.company_id = ? AND m.client_id = ? AND m.kind = 'photo'
     ORDER BY m.created_at DESC LIMIT 60`
  ).bind(companyId, clientId).all()
  return json(c, rows.results || [])
})

// POST /api/customers/:id/photos — upload a site photo directly for a client
// (no work order required; stored in project_media with work_order_id='').
app.post('/api/customers/:id/photos', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const clientId  = c.req.param('id')
  const db = c.env.DB
  const cl: any = await db.prepare('SELECT id FROM clients WHERE id=? AND company_id=?').bind(clientId, companyId).first()
  if (!cl) return c.json({ error: 'Client not found' }, 404)
  let form: FormData | null = null
  try { form = await c.req.formData() } catch {}
  if (!form) return c.json({ error: 'multipart/form-data required' }, 400)
  const file = form.get('file') as unknown as File | null
  if (!file || typeof (file as any).arrayBuffer !== 'function') return c.json({ error: 'file field required' }, 400)
  const MAX = 15 * 1024 * 1024
  if ((file as any).size > MAX) return c.json({ error: 'File too large (max 15 MB)' }, 413)
  const ct = (file as any).type || 'application/octet-stream'
  if (!ct.startsWith('image/')) return c.json({ error: 'Only images allowed' }, 400)
  const caption = String(form.get('caption') || '').slice(0, 300)
  const id = 'med_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const safeName = String((file as any).name || 'upload').replace(/[^\w.\- ]/g, '_').slice(0, 120)
  const key = `projects/${companyId}/client_${clientId}/${id}_${safeName}`
  await (c.env.MEDIA as R2Bucket).put(key, await (file as any).arrayBuffer(), { httpMetadata: { contentType: ct } })
  await db.prepare(`INSERT INTO project_media (id, company_id, work_order_id, update_id, client_id, r2_key, file_name, content_type, size_bytes, kind, caption, visibility, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'internal',?)`)
    .bind(id, companyId, '', '', clientId, key, safeName, ct, (file as any).size || 0, 'photo', caption, (c.var.repId as string) || '').run()
  return json(c, { id, file_name: safeName })
})

// ══════════════════════════════════════════════════════════════════════════════
// SETTINGS  — namespaced per company: key stored as "{companyId}:{key}"
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/settings', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const prefix    = `${companyId}:`
  const rows = await c.env.DB.prepare(
    "SELECT key, value FROM settings WHERE key LIKE ? AND key NOT LIKE 'session_%'"
  ).bind(`${prefix}%`).all()
  const obj: Record<string,string> = {}
  const roleForRedact = c.var.role as string
  const canSeeSecrets = !!c.var.isSuperAdmin || roleForRedact === 'admin' || roleForRedact === 'office_manager'
  for (const r of (rows.results as any[])) {
    // Strip the company prefix before returning to client
    const bare = r.key.slice(prefix.length)
    obj[bare] = (!canSeeSecrets && SECRET_SETTINGS.includes(bare)) ? '' : r.value
  }
  // Legacy unprefixed keys are Avalon-era only — expose them solely to Avalon
  if (companyId === 'avalon') {
    const legacy = await c.env.DB.prepare(
      "SELECT key, value FROM settings WHERE key NOT LIKE '%:%' AND key NOT LIKE 'session_%' AND key NOT LIKE 'db_%' AND key NOT LIKE '#_%' ESCAPE '#'"
    ).all()
    for (const r of (legacy.results as any[])) obj[r.key] = r.value
  }
  return json(c, obj)
})

// Setting keys that only admins may write (permission/role control surface)
const ADMIN_ONLY_SETTINGS = ['nav_perms', 'um_company_role_defaults']
// Setting keys that admins or office managers may write (company configuration
// and credentials). Everything else (per-user prefs like bookings_*) stays open
// to any authenticated user in the company.
const MANAGER_ONLY_SETTINGS = [
  'company_divisions', 'company_intake_config', 'pipeline_stages', 'commission_enabled',
  'google_client_id', 'google_client_secret', 'openai_api_key',
  'twilio_account_sid', 'twilio_auth_token', 'twilio_from_number',
  'fin_annual_overrides', 'fin_division_actuals', 'fin_revenue_actuals'
]
// Setting values redacted from GET /api/settings for non-manager roles
const SECRET_SETTINGS = ['google_client_secret', 'openai_api_key', 'sendgrid_api_key', 'twilio_auth_token', 'stripe_secret_key']

app.put('/api/settings', requireAuth, async (c) => {
  const b = await c.req.json()
  if (!b.key) return err(c, 'key required')
  const companyId = c.var.companyId as string
  const role = c.var.role as string
  const isSuper = !!c.var.isSuperAdmin
  const bareKey = String(b.key).includes(':') ? String(b.key).split(':').slice(1).join(':') : String(b.key)
  if (!isSuper) {
    if (ADMIN_ONLY_SETTINGS.includes(bareKey) && role !== 'admin')
      return err(c, 'Only admins can change this setting', 403)
    if (MANAGER_ONLY_SETTINGS.includes(bareKey) && role !== 'admin' && role !== 'office_manager')
      return err(c, 'Admin or office manager access required for this setting', 403)
  }
  // Keys are always written under the caller's own company prefix.
  // A pre-prefixed key is only honored if it matches the session's company.
  let scopedKey: string
  if (b.key.includes(':')) {
    if (!String(b.key).startsWith(`${companyId}:`)) return err(c, 'Key prefix does not match your company', 403)
    scopedKey = b.key
  } else {
    scopedKey = `${companyId}:${b.key}`
  }
  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
  ).bind(scopedKey, String(b.value)).run()
  return json(c, { key: b.key })
})

// ══════════════════════════════════════════════════════════════════════════════
// REVENUE ACTUALS  — scoped by company_id
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/revenue', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const rows = await c.env.DB.prepare(
    'SELECT * FROM revenue_actuals WHERE company_id = ? ORDER BY year, month'
  ).bind(companyId).all()
  return json(c, rows.results)
})

app.put('/api/revenue', requireAuth, async (c) => {
  const b         = await c.req.json()
  const companyId = c.var.companyId as string
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

app.post('/api/sync', requireAuth, async (c) => {
  const b = await c.req.json()
  const { opportunities = [], notes = [], communications = [], clients = [] } = b
  const companyId = c.var.companyId as string
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

// GET /onboard — legacy admin-style onboarding page (used POST /api/companies,
// which is now super-admin only). Public signups go through /signup instead.
app.get('/onboard', (c) => c.redirect('/signup', 301))

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
  await postWorkOrderTimeEntry(c.env.DB, companyId, entry)
  return json(c, { id: entry.id, duration_min: durMin })
})

// POST /api/time/clock-out/:entryId   { notes? }
// Closes the SPECIFIED entry. Frontend callers (time_tracker.js, field_workday.js)
// all use this path-param form. Permission: own entry, or admin/office_manager
// for other reps' entries (admin force-close of missed clock-outs).
app.post('/api/time/clock-out/:entryId', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId as string
  const role      = c.var.role as string
  const entryId   = c.req.param('entryId')
  const b = await c.req.json().catch(() => ({})) as any
  const entry = await c.env.DB.prepare(
    `SELECT * FROM time_entries WHERE id=? AND company_id=? LIMIT 1`
  ).bind(entryId, companyId).first<any>()
  if (!entry) return err(c, 'Entry not found', 404)
  if (entry.rep_id !== repId && role !== 'admin' && role !== 'office_manager')
    return err(c, 'Forbidden', 403)
  if (entry.clock_out) return err(c, 'Already clocked out', 409)
  const now     = new Date()
  const clockIn = new Date(entry.clock_in)
  const durMin  = Math.max(0, Math.round((now.getTime() - clockIn.getTime()) / 60000))
  await c.env.DB.prepare(
    `UPDATE time_entries SET clock_out=?, duration_min=?, notes=?, updated_at=datetime('now')
     WHERE id=? AND company_id=?`
  ).bind(now.toISOString(), durMin, b.notes ?? entry.notes, entry.id, companyId).run()
  await postWorkOrderTimeEntry(c.env.DB, companyId, entry)
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
       missed_punch_flag, prompt_clock_in, productive_minutes_per_day, updated_at)
    VALUES ('default_'||?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(company_id) DO UPDATE SET
      working_days=excluded.working_days, shift_start=excluded.shift_start,
      shift_end=excluded.shift_end, lunch_minutes=excluded.lunch_minutes,
      grace_period_minutes=excluded.grace_period_minutes,
      late_threshold_minutes=excluded.late_threshold_minutes,
      overtime_threshold_hours=excluded.overtime_threshold_hours,
      missed_punch_flag=excluded.missed_punch_flag,
      prompt_clock_in=excluded.prompt_clock_in,
      productive_minutes_per_day=excluded.productive_minutes_per_day,
      updated_at=datetime('now')
  `).bind(
    companyId, companyId,
    b.working_days||'1,2,3,4,5', b.shift_start||'07:00', b.shift_end||'17:00',
    b.lunch_minutes??30, b.grace_period_minutes??10, b.late_threshold_minutes??15,
    b.overtime_threshold_hours??8.0, b.missed_punch_flag??1, b.prompt_clock_in??1,
    // Migration 0060 added this column and no endpoint ever wrote it, so every
    // tenant has been permanently pinned to the 450-minute default — the single
    // number the entire capacity denominator is built on was not adjustable.
    // Clamped to a real working day: 0 would make every crew read as infinitely
    // over capacity, and anything past 24h is a typo.
    Math.max(30, Math.min(1440, Number(b.productive_minutes_per_day) || 450))
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

// DELETE /api/admin/companies/:id — hard-delete a company and ALL its data
// Requires confirm=<company_id> query param as a safety interlock.
const TENANT_TABLES = [
  'reps','opportunities','notes','communications','files','checklist_progress','academy_progress',
  'quiz_attempts','badges','certifications','clients','revenue_actuals','time_entries','roles',
  'activity_log','break_entries','workday_settings','tasks','crews','crew_members','work_orders',
  'work_order_employees','customer_notes','recurring_plans','client_plan_subscriptions','plan_visits',
  'field_reports','aar_templates','aar_submissions','estimates','payments','invoices','invoice_counters',
  'onboarding_responses','review_requests','review_settings','referrals','notifications','estimate_portal_tokens'
]
app.delete('/api/admin/companies/:id', requireSuperAdmin, async (c) => {
  const id = c.req.param('id')
  if (!id || id === 'avalon' || id === 'groundwork_platform') return err(c, 'This company cannot be deleted', 400)
  if (c.req.query('confirm') !== id) return err(c, 'Confirmation mismatch: pass ?confirm=<company_id>', 400)
  const co = await c.env.DB.prepare('SELECT id, name FROM companies WHERE id = ? LIMIT 1').bind(id).first<any>()
  if (!co) return err(c, 'Company not found', 404)

  // Delete tenant rows table-by-table (some tables may not exist on older DBs)
  let purged: Record<string, number> = {}
  for (const t of TENANT_TABLES) {
    try {
      const r = await c.env.DB.prepare(`DELETE FROM ${t} WHERE company_id = ?`).bind(id).run()
      if (r.meta.changes) purged[t] = r.meta.changes
    } catch (_) {}
  }
  // Settings: company-prefixed keys + any sessions scoped to this company
  await c.env.DB.prepare("DELETE FROM settings WHERE key LIKE ?").bind(`${id}:%`).run()
  const coSessions = await c.env.DB.prepare(
    "SELECT key FROM settings WHERE key LIKE 'session_company_%' AND value = ?"
  ).bind(id).all()
  for (const s of (coSessions.results || []) as any[]) {
    const tok = String(s.key).replace('session_company_', '')
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(`session_${tok}`),
      c.env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(`session_company_${tok}`)
    ])
  }
  await c.env.DB.prepare('DELETE FROM companies WHERE id = ?').bind(id).run()
  return json(c, { deleted: id, name: co.name, purged })
})

// GET /api/company/export — full JSON export of the caller's own company data
// Admin/office_manager only. Returns { company, exported_at, tables: {name: rows[]} }
app.get('/api/company/export', requireAuth, async (c) => {
  const role = c.var.role as string
  if (!(role === 'admin' || role === 'office_manager' || c.var.isSuperAdmin)) return err(c, 'Forbidden', 403)
  const companyId = c.var.companyId as string
  const co = await c.env.DB.prepare('SELECT * FROM companies WHERE id = ? LIMIT 1').bind(companyId).first()
  const tables: Record<string, any[]> = {}
  for (const t of TENANT_TABLES) {
    try {
      const r = await c.env.DB.prepare(`SELECT * FROM ${t} WHERE company_id = ?`).bind(companyId).all()
      tables[t] = (r.results || []).map((row: any) => {
        // Strip credential material from the export
        if (t === 'reps') { delete row.pin; delete row.pin_hash; delete row.reset_token; delete row.reset_token_exp; delete row.invite_token }
        return row
      })
    } catch (_) { tables[t] = [] }
  }
  const settings = await c.env.DB.prepare('SELECT key, value, updated_at FROM settings WHERE key LIKE ?').bind(`${companyId}:%`).all()
  tables['settings'] = (settings.results || []) as any[]
  c.header('Content-Disposition', `attachment; filename="groundwork-export-${companyId}-${new Date().toISOString().slice(0,10)}.json"`)
  return c.json({ company: co, exported_at: new Date().toISOString(), tables })
})

// ── PLATFORM AI ADMINISTRATION ────────────────────────────────────────────────
// The platform owner stores ONE master OpenAI key under groundwork_platform:openai_api_key
// (saved via the normal PUT /api/settings while signed in on the platform side).
// Tenants only get access when ai_enabled is switched on for them here, and every
// call is metered in ai_usage so usage can be billed back.

// GET /api/admin/ai — platform key status + per-tenant AI state + 30-day usage
app.get('/api/admin/ai', requireSuperAdmin, async (c) => {
  const db = c.env.DB as D1Database
  await ensureAiSchema(db)
  const platKey = await db.prepare("SELECT value FROM settings WHERE key = 'groundwork_platform:openai_api_key' LIMIT 1").first<any>()
  const platModel = await db.prepare("SELECT value FROM settings WHERE key = 'groundwork_platform:openai_model' LIMIT 1").first<any>()
  const companies = await db.prepare(`
    SELECT c.id, c.name, c.plan, c.active,
           (SELECT value FROM settings WHERE key = c.id || ':ai_enabled' LIMIT 1) AS ai_enabled,
           (SELECT CASE WHEN EXISTS (SELECT 1 FROM settings WHERE key = c.id || ':openai_api_key' AND value != '') THEN 1 ELSE 0 END) AS has_byok
    FROM companies c WHERE c.id != 'groundwork_platform' ORDER BY c.name
  `).all()
  const usage = await db.prepare(`
    SELECT company_id, key_source, COUNT(*) AS actions, SUM(total_tokens) AS tokens
    FROM ai_usage WHERE created_at >= datetime('now','-30 days')
    GROUP BY company_id, key_source
  `).all()
  const usageMap: Record<string, any> = {}
  for (const u of (usage.results as any[])) {
    const m = usageMap[u.company_id] || (usageMap[u.company_id] = { actions: 0, tokens: 0, platform_actions: 0, platform_tokens: 0 })
    m.actions += u.actions; m.tokens += u.tokens || 0
    if (u.key_source === 'platform') { m.platform_actions += u.actions; m.platform_tokens += u.tokens || 0 }
  }
  const platKeyVal = String(platKey?.value || '')
  // Plan + month-to-date quota per company (Phase 2)
  const planRows = await db.prepare(`SELECT key, value FROM settings WHERE key LIKE '%:ai_plan' OR key LIKE '%:ai_custom_cap'`).all()
  const planMap: Record<string, string> = {}, capMap: Record<string, string> = {}
  for (const r of (planRows.results as any[])) {
    if (r.key.endsWith(':ai_plan')) planMap[r.key.slice(0, -8)] = String(r.value || '')
    else if (r.key.endsWith(':ai_custom_cap')) capMap[r.key.slice(0, -14)] = String(r.value || '')
  }
  const mtd = await db.prepare(`
    SELECT company_id, COUNT(*) AS actions FROM ai_usage
    WHERE key_source = 'platform' AND created_at >= datetime('now','start of month')
    GROUP BY company_id
  `).all()
  const mtdMap: Record<string, number> = {}
  for (const m of (mtd.results as any[])) mtdMap[m.company_id] = Number(m.actions) || 0
  return json(c, {
    platform_key_set: !!platKeyVal,
    platform_key_masked: platKeyVal ? (platKeyVal.length > 10 ? platKeyVal.slice(0, 7) + '…' + platKeyVal.slice(-4) : 'sk-…') : '',
    platform_model: String(platModel?.value || 'gpt-5-mini'),
    companies: (companies.results as any[]).map((co: any) => ({
      id: co.id, name: co.name, plan: co.plan, active: co.active,
      ai_enabled: co.ai_enabled === '1', has_byok: !!co.has_byok,
      usage_30d: usageMap[co.id] || { actions: 0, tokens: 0, platform_actions: 0, platform_tokens: 0 },
      ai_plan: (planMap[co.id] in AI_PLAN_CAPS) ? planMap[co.id] : 'starter',
      ai_cap: (() => {
        const p = (planMap[co.id] in AI_PLAN_CAPS) ? planMap[co.id] : 'starter'
        const cc = capMap[co.id]
        return (cc !== undefined && cc !== '' && isFinite(Number(cc))) ? Number(cc) : AI_PLAN_CAPS[p]
      })(),
      ai_used_mtd: mtdMap[co.id] || 0,
    })),
  })
})

// POST /api/admin/ai/test — fires a real 1-shot completion with the platform
// master key so the owner can verify the key + billing credits work end-to-end.
app.post('/api/admin/ai/test', requireSuperAdmin, async (c) => {
  const db = c.env.DB as D1Database
  const { apiKey, baseUrl, model, keySource } = await _aiCreds(db, 'groundwork_platform', c.env)
  if (!apiKey) return c.json({ ok: false, error: 'no_key', message: 'No master key saved yet.' }, 400)
  try {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: "Reply with exactly: GROUNDWORK AI ONLINE" }],
      }),
    })
    const bodyText = await r.text().catch(() => '')
    if (!r.ok) {
      let hint = `OpenAI returned HTTP ${r.status}.`
      if (r.status === 401) hint = 'OpenAI rejected the key (401). The key is wrong, revoked, or was pasted incompletely.'
      else if (r.status === 429) hint = 'OpenAI says 429 — usually NO BILLING CREDITS on the account (or rate limit). Add credits at platform.openai.com → Settings → Billing.'
      else if (r.status === 404) hint = `Model "${model}" not found (404) — the account may not have access to it.`
      return c.json({ ok: false, error: 'upstream', status: r.status, message: hint, detail: bodyText.slice(0, 300) }, 502)
    }
    const j: any = JSON.parse(bodyText)
    const reply = j?.choices?.[0]?.message?.content || ''
    await _logAiUsage(db, 'groundwork_platform', c.var.repId as string, 'test', model, j?.usage, keySource)
    return json(c, {
      reply: String(reply).slice(0, 120),
      model: j?.model || model,
      tokens: j?.usage?.total_tokens || 0,
      key_source: keySource,
    })
  } catch (e: any) {
    return c.json({ ok: false, error: 'network', message: 'Could not reach OpenAI: ' + String(e?.message || e).slice(0, 200) }, 502)
  }
})

// PUT /api/admin/ai/company/:id — { ai_enabled: true|false } toggle platform-key access
app.put('/api/admin/ai/company/:id', requireSuperAdmin, async (c) => {
  const id = c.req.param('id')
  const b: any = await c.req.json().catch(() => ({}))
  const co = await c.env.DB.prepare('SELECT id FROM companies WHERE id = ? LIMIT 1').bind(id).first()
  if (!co) return err(c, 'Company not found', 404)
  const stmts: any[] = []
  if ('ai_enabled' in b) stmts.push(c.env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))")
    .bind(`${id}:ai_enabled`, b.ai_enabled ? '1' : '0'))
  if ('ai_plan' in b) {
    const plan = String(b.ai_plan || 'starter')
    if (!(plan in AI_PLAN_CAPS)) return err(c, 'Invalid plan — use starter, core, growth, pro, enterprise, essentials, plus, max, or unlimited', 400)
    stmts.push(c.env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))")
      .bind(`${id}:ai_plan`, plan))
  }
  if ('ai_custom_cap' in b) {
    const v = b.ai_custom_cap === null || b.ai_custom_cap === '' ? '' : String(Math.max(0, Number(b.ai_custom_cap) || 0))
    stmts.push(c.env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))")
      .bind(`${id}:ai_custom_cap`, v))
  }
  if (stmts.length) await c.env.DB.batch(stmts)
  return json(c, { id, ai_enabled: b.ai_enabled, ai_plan: b.ai_plan, ai_custom_cap: b.ai_custom_cap })
})

// GET /api/ai/quota — tenant-facing month-to-date AI quota (for 80% warnings in the UI)
app.get('/api/ai/quota', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const { keySource, aiEnabled } = await _aiCreds(db, companyId, c.env)
  if (keySource === 'byok' || keySource === 'env') {
    return json(c, { metered: false, key_source: keySource })
  }
  if (!aiEnabled) return json(c, { metered: false, key_source: '', ai_enabled: false })
  const q = await _aiQuota(db, companyId)
  return json(c, { metered: true, key_source: 'platform', ai_enabled: true, ...q })
})

// GET /api/admin/ai/usage?company_id=&days=30 — detailed usage rows for billing
app.get('/api/admin/ai/usage', requireSuperAdmin, async (c) => {
  const db = c.env.DB as D1Database
  await ensureAiSchema(db)
  const days = Math.min(Number(c.req.query('days')) || 30, 365)
  const companyId = c.req.query('company_id') || ''
  const rows = companyId
    ? await db.prepare(`SELECT * FROM ai_usage WHERE company_id = ? AND created_at >= datetime('now', ?) ORDER BY created_at DESC LIMIT 500`)
        .bind(companyId, `-${days} days`).all()
    : await db.prepare(`SELECT company_id, feature, key_source, COUNT(*) AS actions, SUM(total_tokens) AS tokens,
                               MIN(created_at) AS first_at, MAX(created_at) AS last_at
                        FROM ai_usage WHERE created_at >= datetime('now', ?)
                        GROUP BY company_id, feature, key_source ORDER BY tokens DESC`)
        .bind(`-${days} days`).all()
  return json(c, rows.results)
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

// ── GW Ops schema (migration 0037: gw_demos + gw_pricing_plans) ─────────────
// Auto-creates in prod on first demos/pricing request (self-heal pattern).
let _gwOps37Ok = false
async function ensureGwOpsSchema(db: D1Database): Promise<void> {
  if (_gwOps37Ok) return
  // v5 flag: 0037 (tables) + 0038 (pricing) + 0039 (onboarding) + 0040 (buildout)
  // v5 = re-run after 0039 inline-semicolon fix so template seed succeeds in prod
  const flag = await db.prepare("SELECT value FROM settings WHERE key = '_schema_gwops_v5' LIMIT 1").first<any>()
  if (flag) { _gwOps37Ok = true; return }
  const sql = mig0037 + '\n' + mig0038 + '\n' + mig0039 + '\n' + mig0040
  const stmts = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .split(';').map(x => x.trim()).filter(x => x.length > 0)
  for (const stmt of stmts) {
    try { await db.prepare(stmt).run() } catch (e: any) {
      const msg = String(e?.message || e)
      if (!/already exists|duplicate/i.test(msg)) console.error('[ensureGwOpsSchema]', msg)
    }
  }
  await db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('_schema_gwops_v5', ?, datetime('now'))").bind(new Date().toISOString()).run()
  _gwOps37Ok = true
}

// Demo Requests  (/api/platform/demos)
app.get('/api/platform/demos', requireSuperAdmin, async (c) => {
  await ensureGwOpsSchema(c.env.DB)
  const limit  = parseInt(c.req.query('limit')||'200')
  const status = c.req.query('status')
  const rows = status
    ? await c.env.DB.prepare(`SELECT * FROM gw_demos WHERE status = ? ORDER BY created_at DESC LIMIT ?`).bind(status, limit).all()
    : await c.env.DB.prepare(`SELECT * FROM gw_demos ORDER BY created_at DESC LIMIT ?`).bind(limit).all()
  return json(c, rows.results || [])
})
app.post('/api/platform/demos', requireSuperAdmin, async (c) => {
  await ensureGwOpsSchema(c.env.DB)
  const b = await c.req.json()
  const id = uid()
  const { company_name, contact_name, email, phone, message, status, scheduled_at, source, notes, lead_id } = b as any
  await c.env.DB.prepare(
    `INSERT INTO gw_demos (id, lead_id, company_name, contact_name, email, phone, message, status, scheduled_at, source, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).bind(id, lead_id||null, company_name||'', contact_name||'', email||'', phone||'', message||'', status||'requested', scheduled_at||null, source||'manual', notes||'').run()
  return json(c, { id })
})
app.put('/api/platform/demos/:id', requireSuperAdmin, async (c) => {
  await ensureGwOpsSchema(c.env.DB)
  const id = c.req.param('id')
  const b  = await c.req.json()
  const allowed = ['company_name','contact_name','email','phone','message','status','scheduled_at','source','notes','lead_id','assigned_to']
  const updates = allowed.filter(f => (b as any)[f] !== undefined)
  if (!updates.length) return err(c, 'Nothing to update')
  const set  = updates.map(f => `${f} = ?`).join(', ')
  const vals = updates.map(f => (b as any)[f])
  await c.env.DB.prepare(
    `UPDATE gw_demos SET ${set}, updated_at = datetime('now') WHERE id = ?`
  ).bind(...vals, id).run()
  return json(c, { updated: id })
})
app.delete('/api/platform/demos/:id', requireSuperAdmin, async (c) => {
  await ensureGwOpsSchema(c.env.DB)
  await c.env.DB.prepare(`DELETE FROM gw_demos WHERE id = ?`).bind(c.req.param('id')).run()
  return json(c, { deleted: c.req.param('id') })
})
// Convert a demo request into a gw_leads pipeline entry
app.post('/api/platform/demos/:id/convert', requireSuperAdmin, async (c) => {
  await ensureGwOpsSchema(c.env.DB)
  const id = c.req.param('id')
  const demo = await c.env.DB.prepare(`SELECT * FROM gw_demos WHERE id = ?`).bind(id).first<any>()
  if (!demo) return err(c, 'Demo not found', 404)
  if (demo.lead_id) return json(c, { leadId: demo.lead_id, existing: true })
  const leadId = uid()
  await c.env.DB.prepare(
    `INSERT INTO gw_leads (id, company_name, contact_name, email, phone, stage, priority, deal_value, next_action, notes, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'demo', 'high', 0, 'Run demo & follow up', ?, 'demo_request', datetime('now'), datetime('now'))`
  ).bind(leadId, demo.company_name||'', demo.contact_name||'', demo.email||'', demo.phone||'', demo.message ? ('Demo request message: ' + demo.message) : '').run()
  await c.env.DB.prepare(`UPDATE gw_demos SET lead_id = ?, updated_at = datetime('now') WHERE id = ?`).bind(leadId, id).run()
  return json(c, { leadId })
})

// Pricing Plans  (/api/platform/pricing-plans)
app.get('/api/platform/pricing-plans', requireSuperAdmin, async (c) => {
  await ensureGwOpsSchema(c.env.DB)
  const rows = await c.env.DB.prepare(`SELECT * FROM gw_pricing_plans ORDER BY sort ASC, monthly_price ASC`).all()
  return json(c, rows.results || [])
})
app.post('/api/platform/pricing-plans', requireSuperAdmin, async (c) => {
  await ensureGwOpsSchema(c.env.DB)
  const b = await c.req.json()
  const { id, name, monthly_price, annual_price, ai_credits, max_reps, features, highlight, active, sort, tagline, seat_rep, seat_field, seat_office, seat_viewonly, viewonly_included, extra_seats_available, is_custom } = b as any
  const planId = String(id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
  if (!planId || !name) return err(c, 'id and name required')
  await c.env.DB.prepare(
    `INSERT INTO gw_pricing_plans (id, name, monthly_price, annual_price, ai_credits, max_reps, features, highlight, active, sort, tagline, seat_rep, seat_field, seat_office, seat_viewonly, viewonly_included, extra_seats_available, is_custom, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).bind(planId, name, monthly_price||0, annual_price||0, ai_credits||0, max_reps||0, typeof features === 'string' ? features : JSON.stringify(features||[]), highlight?1:0, active??1, sort||0, tagline||'', seat_rep||0, seat_field||0, seat_office||0, seat_viewonly||0, viewonly_included||0, extra_seats_available??1, is_custom?1:0).run()
  return json(c, { id: planId })
})
app.put('/api/platform/pricing-plans/:id', requireSuperAdmin, async (c) => {
  await ensureGwOpsSchema(c.env.DB)
  const id = c.req.param('id')
  const b  = await c.req.json()
  const allowed = ['name','monthly_price','annual_price','ai_credits','max_reps','features','highlight','active','sort','tagline','seat_rep','seat_field','seat_office','seat_viewonly','viewonly_included','extra_seats_available','is_custom']
  const updates = allowed.filter(f => (b as any)[f] !== undefined)
  if (!updates.length) return err(c, 'Nothing to update')
  const set  = updates.map(f => `${f} = ?`).join(', ')
  const vals = updates.map(f => {
    const v = (b as any)[f]
    if (f === 'features' && typeof v !== 'string') return JSON.stringify(v||[])
    return v
  })
  await c.env.DB.prepare(
    `UPDATE gw_pricing_plans SET ${set}, updated_at = datetime('now') WHERE id = ?`
  ).bind(...vals, id).run()
  return json(c, { updated: id })
})
app.delete('/api/platform/pricing-plans/:id', requireSuperAdmin, async (c) => {
  await ensureGwOpsSchema(c.env.DB)
  await c.env.DB.prepare(`DELETE FROM gw_pricing_plans WHERE id = ?`).bind(c.req.param('id')).run()
  return json(c, { deleted: c.req.param('id') })
})

// AI Packages  (/api/platform/ai-packages)
app.get('/api/platform/ai-packages', requireSuperAdmin, async (c) => {
  await ensureGwOpsSchema(c.env.DB)
  const rows = await c.env.DB.prepare(`SELECT * FROM gw_ai_packages ORDER BY sort ASC, monthly_price ASC`).all()
  return json(c, rows.results || [])
})
app.post('/api/platform/ai-packages', requireSuperAdmin, async (c) => {
  await ensureGwOpsSchema(c.env.DB)
  const b = await c.req.json()
  const { id, name, monthly_price, ai_actions, description, features, highlight, is_custom, active, sort } = b as any
  const pkgId = String(id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
  if (!pkgId || !name) return err(c, 'id and name required')
  await c.env.DB.prepare(
    `INSERT INTO gw_ai_packages (id, name, monthly_price, ai_actions, description, features, highlight, is_custom, active, sort, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).bind(pkgId, name, monthly_price||0, ai_actions||0, description||'', typeof features === 'string' ? features : JSON.stringify(features||[]), highlight?1:0, is_custom?1:0, active??1, sort||0).run()
  return json(c, { id: pkgId })
})
app.put('/api/platform/ai-packages/:id', requireSuperAdmin, async (c) => {
  await ensureGwOpsSchema(c.env.DB)
  const id = c.req.param('id')
  const b  = await c.req.json()
  const allowed = ['name','monthly_price','ai_actions','description','features','highlight','is_custom','active','sort']
  const updates = allowed.filter(f => (b as any)[f] !== undefined)
  if (!updates.length) return err(c, 'Nothing to update')
  const set  = updates.map(f => `${f} = ?`).join(', ')
  const vals = updates.map(f => {
    const v = (b as any)[f]
    if (f === 'features' && typeof v !== 'string') return JSON.stringify(v||[])
    return v
  })
  await c.env.DB.prepare(
    `UPDATE gw_ai_packages SET ${set}, updated_at = datetime('now') WHERE id = ?`
  ).bind(...vals, id).run()
  return json(c, { updated: id })
})
app.delete('/api/platform/ai-packages/:id', requireSuperAdmin, async (c) => {
  await ensureGwOpsSchema(c.env.DB)
  await c.env.DB.prepare(`DELETE FROM gw_ai_packages WHERE id = ?`).bind(c.req.param('id')).run()
  return json(c, { deleted: c.req.param('id') })
})

// ═══════════════════════════════════════════════════════════════════════════
// ONBOARDING SYSTEM  (/api/platform/onboarding/*)  — migration 0039
// Templates (sales | customer_wizard | tenant_checklist) → steps → progress
// ═══════════════════════════════════════════════════════════════════════════

// GET all templates with their steps
app.get('/api/platform/onboarding/templates', requireSuperAdmin, async (c) => {
  await ensureGwOpsSchema(c.env.DB)
  const tpls = await c.env.DB.prepare(`SELECT * FROM gw_onboarding_templates ORDER BY sort, name`).all()
  const steps = await c.env.DB.prepare(`SELECT * FROM gw_onboarding_steps ORDER BY sort, title`).all()
  return json(c, { templates: tpls.results || [], steps: steps.results || [] })
})

// POST create step  { template_id, title, description?, fields?, required?, sort?, active? }
app.post('/api/platform/onboarding/steps', requireSuperAdmin, async (c) => {
  await ensureGwOpsSchema(c.env.DB)
  const b = await c.req.json().catch(() => ({}))
  if (!b.template_id || !b.title) return err(c, 'template_id and title required')
  const tpl = await c.env.DB.prepare(`SELECT id FROM gw_onboarding_templates WHERE id = ?`).bind(b.template_id).first()
  if (!tpl) return err(c, 'Unknown template')
  const id = 'st_' + uid()
  await c.env.DB.prepare(
    `INSERT INTO gw_onboarding_steps (id, template_id, title, description, fields, required, locked, active, sort)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).bind(
    id, b.template_id, String(b.title).slice(0, 200), String(b.description || '').slice(0, 1000),
    typeof b.fields === 'string' ? b.fields : JSON.stringify(b.fields ?? []),
    b.required ? 1 : 0, (b.active ?? 1) ? 1 : 0, Number(b.sort) || 0
  ).run()
  return json(c, { id })
})

// PUT update step
app.put('/api/platform/onboarding/steps/:id', requireSuperAdmin, async (c) => {
  await ensureGwOpsSchema(c.env.DB)
  const b = await c.req.json().catch(() => ({}))
  const id = c.req.param('id')
  const allowed = ['title', 'description', 'fields', 'required', 'active', 'sort']
  const sets: string[] = []; const vals: any[] = []
  for (const f of allowed) {
    if (b[f] === undefined) continue
    sets.push(`${f} = ?`)
    if (f === 'fields') vals.push(typeof b[f] === 'string' ? b[f] : JSON.stringify(b[f]))
    else if (f === 'required' || f === 'active') vals.push(b[f] ? 1 : 0)
    else if (f === 'sort') vals.push(Number(b[f]) || 0)
    else vals.push(String(b[f]))
  }
  if (!sets.length) return err(c, 'Nothing to update')
  vals.push(id)
  await c.env.DB.prepare(`UPDATE gw_onboarding_steps SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).bind(...vals).run()
  return json(c, { updated: id })
})

// DELETE step (locked steps are protected)
app.delete('/api/platform/onboarding/steps/:id', requireSuperAdmin, async (c) => {
  await ensureGwOpsSchema(c.env.DB)
  const id = c.req.param('id')
  const row = await c.env.DB.prepare(`SELECT locked FROM gw_onboarding_steps WHERE id = ?`).bind(id).first<any>()
  if (!row) return err(c, 'Step not found')
  if (row.locked) return err(c, 'Built-in wizard steps cannot be deleted (you can deactivate custom ones instead)')
  await c.env.DB.prepare(`DELETE FROM gw_onboarding_steps WHERE id = ?`).bind(id).run()
  await c.env.DB.prepare(`DELETE FROM gw_onboarding_progress WHERE step_id = ?`).bind(id).run()
  return json(c, { deleted: id })
})

// GET progress for a subject (demo or company): ?subject_type=demo&subject_id=xyz
// Or all progress for a template type (playbook board): ?template_id=sales_default
app.get('/api/platform/onboarding/progress', requireSuperAdmin, async (c) => {
  await ensureGwOpsSchema(c.env.DB)
  const st = c.req.query('subject_type'); const sid = c.req.query('subject_id')
  const tid = c.req.query('template_id')
  if (st && sid) {
    const rows = await c.env.DB.prepare(`SELECT * FROM gw_onboarding_progress WHERE subject_type = ? AND subject_id = ?`).bind(st, sid).all()
    return json(c, rows.results || [])
  }
  if (tid) {
    const rows = await c.env.DB.prepare(`SELECT * FROM gw_onboarding_progress WHERE template_id = ?`).bind(tid).all()
    return json(c, rows.results || [])
  }
  const rows = await c.env.DB.prepare(`SELECT * FROM gw_onboarding_progress ORDER BY completed_at DESC LIMIT 500`).all()
  return json(c, rows.results || [])
})

// POST toggle progress  { step_id, subject_type, subject_id, done, notes? }
app.post('/api/platform/onboarding/progress', requireSuperAdmin, async (c) => {
  await ensureGwOpsSchema(c.env.DB)
  const b = await c.req.json().catch(() => ({}))
  if (!b.step_id || !b.subject_type || !b.subject_id) return err(c, 'step_id, subject_type, subject_id required')
  const step = await c.env.DB.prepare(`SELECT template_id FROM gw_onboarding_steps WHERE id = ?`).bind(b.step_id).first<any>()
  if (!step) return err(c, 'Unknown step')
  if (b.done === false) {
    await c.env.DB.prepare(`DELETE FROM gw_onboarding_progress WHERE step_id = ? AND subject_type = ? AND subject_id = ?`)
      .bind(b.step_id, b.subject_type, b.subject_id).run()
    return json(c, { done: false })
  }
  const repId = (c as any).get?.('repId') || 'platform'
  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO gw_onboarding_progress (id, template_id, step_id, subject_type, subject_id, status, completed_by, notes, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).bind(
    'pg_' + uid(), step.template_id, b.step_id, String(b.subject_type), String(b.subject_id),
    b.status === 'skipped' ? 'skipped' : 'done', String(repId), String(b.notes || '').slice(0, 500)
  ).run()
  return json(c, { done: true })
})

// GET tenant funnel — companies + wizard state + checklist counts + custom answers
app.get('/api/platform/onboarding/funnel', requireSuperAdmin, async (c) => {
  await ensureGwOpsSchema(c.env.DB)
  const companies = await c.env.DB.prepare(
    `SELECT id, name, plan, subscription_status, onboarding_completed, onboarding_step, onboarding_data, created_at
     FROM companies WHERE id != 'groundwork_platform' ORDER BY created_at DESC LIMIT 100`
  ).all()
  const prog = await c.env.DB.prepare(
    `SELECT subject_id, COUNT(*) AS done FROM gw_onboarding_progress WHERE subject_type = 'company' GROUP BY subject_id`
  ).all()
  const totalSteps = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM gw_onboarding_steps WHERE template_id = 'checklist_default' AND active = 1`
  ).first<any>()
  const answers = await c.env.DB.prepare(
    `SELECT company_id, question, answer FROM onboarding_responses ORDER BY created_at DESC LIMIT 500`
  ).all().catch(() => ({ results: [] as any[] }))
  return json(c, {
    companies: companies.results || [],
    checklist_progress: prog.results || [],
    checklist_total: totalSteps?.n || 0,
    responses: (answers as any).results || [],
  })
})

// ── TENANT-FACING (requireAuth): wizard config + Getting Started checklist ──

// Custom wizard questions for the signup wizard (any authenticated user)
app.get('/api/onboarding/wizard-config', requireAuth, async (c) => {
  await ensureGwOpsSchema(c.env.DB)
  const rows = await c.env.DB.prepare(
    `SELECT id, title, description, fields, sort FROM gw_onboarding_steps
     WHERE template_id = 'wizard_default' AND locked = 0 AND active = 1 ORDER BY sort`
  ).all()
  return json(c, rows.results || [])
})

// Save custom wizard answers  { answers: [{key, question, answer}] }
app.post('/api/onboarding/wizard-answers', requireAuth, async (c) => {
  await ensureGwOpsSchema(c.env.DB)
  const cid = (c as any).get('companyId')
  const b = await c.req.json().catch(() => ({}))
  const answers = Array.isArray(b.answers) ? b.answers.slice(0, 20) : []
  for (const a of answers) {
    await c.env.DB.prepare(
      `INSERT INTO onboarding_responses (id, company_id, step, question, answer) VALUES (?, ?, ?, ?, ?)`
    ).bind('or_' + uid(), cid, 99, String(a.question || a.key || '').slice(0, 300), String(a.answer || '').slice(0, 1000)).run()
  }
  return json(c, { saved: answers.length })
})

// Getting Started checklist w/ auto-detection (admin of the tenant)
app.get('/api/onboarding/checklist', requireAuth, async (c) => {
  await ensureGwOpsSchema(c.env.DB)
  const cid = (c as any).get('companyId')
  const steps = await c.env.DB.prepare(
    `SELECT id, title, description, fields, sort FROM gw_onboarding_steps
     WHERE template_id = 'checklist_default' AND active = 1 ORDER BY sort`
  ).all()
  const manual = await c.env.DB.prepare(
    `SELECT step_id FROM gw_onboarding_progress WHERE subject_type = 'company' AND subject_id = ?`
  ).bind(cid).all()
  const manualDone = new Set((manual.results || []).map((r: any) => r.step_id))

  // Auto-detection counts (cheap single-row queries, tolerate missing tables)
  const cnt = async (sql: string) => {
    try { const r = await c.env.DB.prepare(sql).bind(cid).first<any>(); return Number(r?.n) || 0 } catch { return 0 }
  }
  const co = await c.env.DB.prepare(`SELECT onboarding_completed, logo_url, brand_color, stripe_account_id, stripe_onboarded FROM companies WHERE id = ?`).bind(cid).first<any>()
  const auto: Record<string, boolean> = {
    wizard:      !!co?.onboarding_completed,
    branding:    !!(co?.logo_url || co?.brand_color),
    clients:     (await cnt(`SELECT COUNT(*) n FROM clients WHERE company_id = ?`)) > 0,
    price_items: (await cnt(`SELECT COUNT(*) n FROM price_items WHERE company_id = ?`)) > 0,
    estimates:   (await cnt(`SELECT COUNT(*) n FROM estimates WHERE company_id = ?`)) > 0,
    work_orders: (await cnt(`SELECT COUNT(*) n FROM work_orders WHERE company_id = ?`)) > 0,
    invoices:    (await cnt(`SELECT COUNT(*) n FROM invoices WHERE company_id = ?`)) > 0,
    stripe:      !!(co?.stripe_account_id && co?.stripe_onboarded),
    reps:        (await cnt(`SELECT COUNT(*) n FROM reps WHERE company_id = ? AND active = 1`)) > 1,
    google:      (await cnt(`SELECT COUNT(*) n FROM google_tokens WHERE company_id = ?`)) > 0,
  }
  const items = (steps.results || []).map((s: any) => {
    let meta: any = {}; try { meta = JSON.parse(s.fields || '{}') } catch {}
    const autoKey = meta.auto || 'manual'
    const autoDone = autoKey !== 'manual' && auto[autoKey] !== undefined ? !!auto[autoKey] : false
    const manualIsDone = manualDone.has(s.id)
    // A manual "Mark done" ALWAYS counts — auto-detection can only add, never
    // silently undo a user's explicit completion (this was the "Done doesn't
    // stick" bug: manual marks on auto-detected items were discarded).
    const done = autoDone || manualIsDone
    return { id: s.id, title: s.title, description: s.description, view: meta.view || '', cta: meta.cta || 'Open', done, auto_done: autoDone, manual_done: manualIsDone }
  })
  return json(c, { items, done: items.filter((i: any) => i.done).length, total: items.length })
})

// Tenant marks a manual checklist item done/undone
app.post('/api/onboarding/checklist/:stepId', requireAuth, async (c) => {
  await ensureGwOpsSchema(c.env.DB)
  const cid = (c as any).get('companyId')
  const repId = (c as any).get('repId')
  const stepId = c.req.param('stepId')
  const b = await c.req.json().catch(() => ({}))
  const step = await c.env.DB.prepare(`SELECT template_id FROM gw_onboarding_steps WHERE id = ? AND template_id = 'checklist_default'`).bind(stepId).first<any>()
  if (!step) return err(c, 'Unknown checklist item')
  if (b.done === false) {
    await c.env.DB.prepare(`DELETE FROM gw_onboarding_progress WHERE step_id = ? AND subject_type = 'company' AND subject_id = ?`).bind(stepId, cid).run()
    return json(c, { done: false })
  }
  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO gw_onboarding_progress (id, template_id, step_id, subject_type, subject_id, status, completed_by, completed_at)
     VALUES (?, 'checklist_default', ?, 'company', ?, 'done', ?, datetime('now'))`
  ).bind('pg_' + uid(), stepId, cid, String(repId || '')).run()
  return json(c, { done: true })
})

// ── AI Setup Copilot chat — POST /api/ai/copilot ─────────────────────────────
// { question, view, checklist:[{id,title,done}] } → { answer, tour? }
// `tour` is a Getting Started step id (cl_*) when a guided spotlight tour
// exists for what the user asked about; the frontend renders a "Show me" button.
// ── Marketing campaign copilot ────────────────────────────────────────────────
// Drafts a campaign from the tenant's own brand, services, media and past
// results. Lives here rather than in src/marketing/api.ts only because the AI
// credential resolution, quota gate and usage metering are all defined in this
// file; the tool registry, draft schema and prompt are in
// src/marketing/ai-tools.ts. The registry contains no tool that can send,
// schedule or approve — see the boundary test in ai-tools.test.ts.
app.post('/api/marketing/ai/copilot', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId = c.var.repId as string
  const role = c.var.role as string
  if (!c.var.isSuperAdmin && !['admin', 'office_manager'].includes(role)) return err(c, 'forbidden', 403)

  const db = c.env.DB as D1Database
  const { apiKey, baseUrl, model, keySource } = await _aiCreds(db, companyId, c.env)
  if (!apiKey) return c.json({ ok: false, error: 'no_api_key', message: 'AI is not enabled for your company yet.' }, 400)
  const _qg = await _aiQuotaGate(db, companyId, keySource)
  if (_qg) return c.json(_qg.body, _qg.status as any)

  const b: any = await c.req.json().catch(() => ({}))
  const prompt = String(b.prompt || '').slice(0, 2000)
  if (!prompt) return err(c, 'prompt required')
  const campaignId = String(b.campaign_id || '').slice(0, 60)

  const messages: any[] = [
    { role: 'system', content: COPILOT_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]
  const toolsCalled: string[] = []
  let usage: any = null

  try {
    // Bounded tool loop. Six rounds is enough to read the brand, a service, the
    // media library and an audience count; the cap stops a model that keeps
    // calling tools from burning the request's CPU budget.
    for (let round = 0; round < 6; round++) {
      const r = await _aiChatJson(baseUrl, apiKey, model, messages, undefined, toolSpecs())
      if (!r.ok) return c.json({ ok: false, error: 'ai_error', message: (await r.text()).slice(0, 300) }, 502)
      const data: any = await r.json()
      usage = data?.usage || usage
      const msg = data?.choices?.[0]?.message
      if (!msg) break
      const calls = msg.tool_calls
      if (!Array.isArray(calls) || calls.length === 0) break
      messages.push(msg)
      for (const call of calls.slice(0, 6)) {
        const name = String(call?.function?.name || '')
        let args: any = {}
        try { args = JSON.parse(call?.function?.arguments || '{}') } catch {}
        toolsCalled.push(name)
        const result = await runTool(db, companyId, name, args)
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 6000) })
      }
    }

    // Final turn: no tools, schema-constrained, must return the draft.
    messages.push({ role: 'user', content: 'Now return the finished campaign draft as JSON matching the required schema.' })
    const fin = await _aiChatJson(baseUrl, apiKey, model, messages, CAMPAIGN_DRAFT_SCHEMA)
    if (!fin.ok) return c.json({ ok: false, error: 'ai_error', message: (await fin.text()).slice(0, 300) }, 502)
    const finData: any = await fin.json()
    usage = finData?.usage || usage
    const draft = normalizeDraft(_aiParseJson(finData?.choices?.[0]?.message?.content || '{}'))

    await _logAiUsage(db, companyId, repId, 'marketing_campaign', model, usage, keySource)
    try {
      await db.prepare(`INSERT INTO marketing_ai_generation
        (id, company_id, campaign_id, rep_id, kind, prompt, tools_called_json, draft_json, model, tokens)
        VALUES (?,?,?,?,'campaign_draft',?,?,?,?,?)`)
        .bind('aig_' + uid(), companyId, campaignId || null, repId, prompt,
              JSON.stringify(toolsCalled), JSON.stringify(draft), model || '',
              Number(usage?.total_tokens) || 0).run()
    } catch (e: any) { console.error('[marketing_ai_generation]', e?.message || e) }

    return json(c, { ok: true, draft, tools_called: toolsCalled })
  } catch (e: any) {
    return c.json({ ok: false, error: 'ai_error', message: String(e?.message || e).slice(0, 300) }, 502)
  }
})

app.post('/api/ai/copilot', requireAuth, async (c) => {
  const companyId = (c as any).get('companyId') as string
  const repId = (c as any).get('repId') as string
  const db = c.env.DB as D1Database
  const { apiKey, baseUrl, model, keySource } = await _aiCreds(db, companyId, c.env)
  if (!apiKey) {
    return c.json({ ok: false, error: 'no_api_key', message: 'AI chat is not enabled for your company yet — but the guided tours below work without it!' }, 400)
  }
  const _qg = await _aiQuotaGate(db, companyId, keySource)
  if (_qg) return c.json(_qg.body, _qg.status as any)

  const b: any = await c.req.json().catch(() => ({}))
  const question = String(b.question || '').slice(0, 1500)
  if (!question) return err(c, 'question required')
  const checklist = Array.isArray(b.checklist) ? b.checklist.slice(0, 20) : []
  const co: any = await db.prepare('SELECT name, business_type FROM companies WHERE id = ? LIMIT 1').bind(companyId).first().catch(() => null)

  const sys = `You are the Groundwork AI Setup Copilot — a friendly, encouraging in-app guide inside Groundwork CRM, a field-services CRM (clients, estimates, proposals, invoices, work orders/dispatch, price book, Stripe payments, Google Calendar/Gmail sync, review requests, team roles with a mobile field mode).

Your job: help a NEW company get set up fast, answer how-to questions, and share tips. Be warm, concise (2-5 short sentences or a tight numbered list), and use the user's business context. Celebrate progress. Never invent features not listed above.

App navigation facts you may reference:
- Clients page: add clients (+ Add Client) or import CSV
- Services & Pricing: build the price book (+ Add Item or Import CSV/Excel)
- Estimates: New Estimate → pick client → add price-book lines → email to client; client can accept online; accepted estimates convert to invoices and can schedule jobs
- Invoices: New Invoice, or convert from estimate; Pay Now appears when Stripe is connected
- Dispatch board: New Work Order, drag between days, assign crews (yellow=hold, green=scheduled)
- Integrations: Connect Stripe (online payments), Connect Google (calendar + email sync)
- Employees: Send Invite with a role; field roles get a simplified mobile view
- Settings: upload logo + brand color (shows on all documents)
- Reviews: automatic review requests after jobs complete

GUIDED TOURS: these tour ids exist — cl_branding (logo/branding), cl_client (add first client), cl_pricebook (price book), cl_estimate (first estimate), cl_workorder (schedule a job), cl_invoice (first invoice), cl_payments (connect Stripe), cl_team (invite team), cl_google (connect Google), cl_reviews (review requests).
If the user's question maps clearly to ONE of these setup tasks, include its id in "tour" so the app can offer a click-by-click walkthrough. Otherwise use null.

Return ONLY valid JSON: {"answer":"string","tour":"cl_xxx or null"}`

  const ctx = [
    `Company: ${co?.name || 'Unknown'}${co?.business_type ? ' (' + co.business_type + ')' : ''}`,
    `User is currently on view: ${String(b.view || 'dashboard').slice(0, 60)}`,
    checklist.length ? `Getting Started checklist status:\n${checklist.map((i: any) => `- [${i.done ? 'x' : ' '}] ${String(i.title || '').slice(0, 80)} (${String(i.id || '')})`).join('\n')}` : '',
    `Question: ${question}`,
  ].filter(Boolean).join('\n\n')

  try {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: ctx }] }),
    })
    if (!r.ok) {
      const errText = await r.text().catch(() => '')
      console.error('[ai/copilot] upstream', r.status, errText.slice(0, 300))
      return c.json({ ok: false, error: 'ai_upstream', message: `AI service error (${r.status}).` }, 502)
    }
    const data: any = await r.json()
    await _logAiUsage(db, companyId, repId, 'copilot', model, data?.usage, keySource)
    let parsed: any = null
    try {
      const raw = String(data?.choices?.[0]?.message?.content || '').replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '')
      parsed = JSON.parse(raw)
    } catch {}
    if (!parsed || !parsed.answer) {
      const plain = String(data?.choices?.[0]?.message?.content || '').trim()
      parsed = { answer: plain || 'Sorry — I hit a snag. Try asking again.', tour: null }
    }
    if (parsed.tour && !/^cl_[a-z_]+$/.test(String(parsed.tour))) parsed.tour = null
    return json(c, { answer: String(parsed.answer).slice(0, 3000), tour: parsed.tour || null })
  } catch (e: any) {
    console.error('[ai/copilot]', e?.message || e)
    return c.json({ ok: false, error: 'ai_error', message: 'AI request failed — try again.' }, 502)
  }
})


// ═══════════════════════════════════════════════════════════════════════════
// GROUNDWORK AI ASSISTANT — persistent in-app copilot + business coach
// ─────────────────────────────────────────────────────────────────────────────
// Deterministic signal engine + structured recommendation cards + AI chat.
// All queries are hard-scoped to the session company; non-admin reps only see
// their own leads/tasks (rep_id OR assigned_to_rep_id), matching app rules.
// ═══════════════════════════════════════════════════════════════════════════

const GW_ASSIST_LEGACY_TERMINAL = "('Deal Closed / Won','Sold / Activation','Closed Lost')"

// Normalized companies classify terminal state from their published assignment.
// Legacy labels are consulted only when no published process exists. Unassigned
// published opportunities remain open overall, but resolvedOnly excludes them
// from stage-specific coaching such as stagnation.
function gwAssistOpenPredicate(alias: string, resolvedOnly = false) {
  const published = `EXISTS (SELECT 1 FROM sales_process_versions gpv JOIN sales_processes gp ON gp.id=gpv.process_id AND gp.company_id=gpv.company_id WHERE gpv.company_id=${alias}.company_id AND gpv.lifecycle='published')`
  const assignment = `EXISTS (SELECT 1 FROM sales_stage_assignments gsa WHERE gsa.company_id=${alias}.company_id AND gsa.opportunity_id=${alias}.id AND gsa.process_version_id=(SELECT id FROM sales_process_versions WHERE company_id=${alias}.company_id AND lifecycle='published' ORDER BY published_at DESC LIMIT 1) AND COALESCE(gsa.outcome_type,'') NOT IN ('won','lost','disqualified'))`
  const terminal = `EXISTS (SELECT 1 FROM sales_stage_assignments gsa WHERE gsa.company_id=${alias}.company_id AND gsa.opportunity_id=${alias}.id AND gsa.process_version_id=(SELECT id FROM sales_process_versions WHERE company_id=${alias}.company_id AND lifecycle='published' ORDER BY published_at DESC LIMIT 1) AND COALESCE(gsa.outcome_type,'') IN ('won','lost','disqualified'))`
  const normalizedOpen = resolvedOnly ? assignment : `NOT ${terminal}`
  return `((${published} AND ${normalizedOpen}) OR (NOT ${published} AND ${alias}.status NOT IN ${GW_ASSIST_LEGACY_TERMINAL}))`
}

// Tunable signal thresholds. Defaults chosen for field-services sales cycles;
// per-company overrides live in settings key `gwai_thresholds_<companyId>`
// (JSON, same keys) so tuning never needs a redeploy.
const GW_ASSIST_DEFAULTS = {
  fu_high_days: 7,      // overdue follow-up becomes HIGH after N days
  stale_days: 14,       // no-activity threshold for stale leads
  stale_high_value: 5000,   // stale lead is HIGH above this job value
  est_days: 5,          // estimate sent/viewed with no response
  est_high_total: 3000, // estimate signal is HIGH above this total
  inv_high_owed: 2000,  // overdue invoices HIGH above this combined balance
  stag_days: 21,        // stage stagnation window
  stag_min_deals: 3,    // deals stuck in one stage to trigger stagnation
}

async function gwAssistThresholds(db: D1Database, companyId: string) {
  const t: any = { ...GW_ASSIST_DEFAULTS }
  try {
    const row: any = await db.prepare('SELECT value FROM settings WHERE key = ? LIMIT 1')
      .bind('gwai_thresholds_' + companyId).first()
    if (row?.value) {
      const o = JSON.parse(row.value)
      for (const k of Object.keys(GW_ASSIST_DEFAULTS)) {
        if (o[k] !== undefined && Number.isFinite(Number(o[k]))) t[k] = Number(o[k])
      }
    }
  } catch {}
  return t
}

// Per-rep snoozes: settings key `gwai_snooze_<companyId>_<repId>` holds a JSON
// map { recId: expiresAtISO }. Expired entries are pruned on read.
async function gwAssistSnoozes(db: D1Database, companyId: string, repId: string): Promise<Record<string, string>> {
  try {
    const row: any = await db.prepare('SELECT value FROM settings WHERE key = ? LIMIT 1')
      .bind(`gwai_snooze_${companyId}_${repId}`).first()
    if (!row?.value) return {}
    const map = JSON.parse(row.value) || {}
    const now = new Date().toISOString()
    const live: Record<string, string> = {}
    for (const k of Object.keys(map)) { if (String(map[k]) > now) live[k] = map[k] }
    return live
  } catch { return {} }
}

async function gwAssistSignals(db: D1Database, companyId: string, repId: string, role: string) {
  const isMgr = role === 'admin' || role === 'office_manager'
  const T = await gwAssistThresholds(db, companyId)
  // Rep scope clause for opportunities (admins/office managers see all)
  const oppScope = isMgr ? '' : ' AND (rep_id = ?2 OR (assigned_to_rep_id != \'\' AND assigned_to_rep_id = ?2))'
  const q = async (sql: string, ...binds: any[]) => {
    // D1 rejects bind counts that don't match placeholders — trim unused binds
    // (manager-scoped queries drop the ?2 rep clause but callers always pass repId).
    const need = sql.includes('?2') ? binds.length : Math.min(binds.length, 1)
    try { const r = await db.prepare(sql).bind(...binds.slice(0, need)).all(); return r.results || [] } catch (e: any) { console.error('[gwAssistSignals]', e?.message || e); return [] }
  }
  const recs: any[] = []
  const push = (r: any) => recs.push(r)

  // 1. OVERDUE FOLLOW-UPS — next_follow_up date in the past on open leads
  const overdueFu = await q(
    `SELECT o.id, o.client, o.status, o.job_value_cents, o.next_follow_up FROM opportunities o
     WHERE o.company_id = ?1 AND ${gwAssistOpenPredicate('o')}
       AND o.next_follow_up != '' AND date(o.next_follow_up) < date('now')${oppScope}
     ORDER BY date(o.next_follow_up) ASC LIMIT 5`, companyId, repId)
  for (const o of overdueFu) {
    const days = Math.floor((Date.now() - new Date(String(o.next_follow_up)).getTime()) / 86400000)
    push({
      id: 'fu_' + o.id, type: 'follow_up_overdue', priority: days > T.fu_high_days ? 'high' : 'medium',
      title: `Follow up with ${o.client}`,
      summary: `Follow-up was due ${days === 0 ? 'today' : days + ' day' + (days === 1 ? '' : 's') + ' ago'} — lead is in "${o.status}"${o.job_value_cents ? ' worth $' + (Number(o.job_value_cents) / 100).toLocaleString() : ''}.`,
      why: 'Leads contacted within a day of their follow-up date close at a much higher rate. Every day past due drops your odds.',
      action_kind: 'open_lead', action_payload: { oppId: o.id },
      actions: [
        { kind: 'open_lead', label: 'Open lead', payload: { oppId: o.id } },
        { kind: 'draft_email', label: 'Draft follow-up', payload: { oppId: o.id, oppLabel: o.client } },
      ],
    })
  }

  // 2. STALE LEADS — open, no activity (updated_at) in 14+ days
  const stale = await q(
    `SELECT o.id, o.client, o.status, o.job_value_cents, o.updated_at FROM opportunities o
     WHERE o.company_id = ?1 AND ${gwAssistOpenPredicate('o', true)}
       AND julianday('now') - julianday(o.updated_at) >= ${Number(T.stale_days)}${oppScope}
     ORDER BY o.job_value_cents DESC LIMIT 5`, companyId, repId)
  for (const o of stale) {
    const days = Math.floor((Date.now() - new Date(String(o.updated_at).replace(' ', 'T') + 'Z').getTime()) / 86400000)
    push({
      id: 'stale_' + o.id, type: 'stale_lead', priority: Number(o.job_value_cents || 0) > Math.round(T.stale_high_value * 100) ? 'high' : 'medium',
      title: `${o.client} has gone quiet`,
      summary: `No activity in ${days} days. Stuck in "${o.status}"${o.job_value_cents ? ' — $' + (Number(o.job_value_cents) / 100).toLocaleString() + ' at risk' : ''}.`,
      why: 'Stalled deals rarely revive themselves. A quick check-in call or a fresh angle (new option, small discount, deadline) restarts the conversation.',
      action_kind: 'open_lead', action_payload: { oppId: o.id },
      actions: [
        { kind: 'open_lead', label: 'Open lead', payload: { oppId: o.id } },
        { kind: 'create_task', label: 'Schedule follow-up', payload: { title: 'Re-engage ' + o.client, linkedRecordType: 'opportunity', linkedRecordId: o.id, linkedRecordLabel: o.client } },
      ],
    })
  }

  // 3. NO NEXT STEP — open leads with no follow-up date scheduled at all
  const noNext = await q(
    `SELECT o.id, o.client, o.status, o.job_value_cents FROM opportunities o
     WHERE o.company_id = ?1 AND ${gwAssistOpenPredicate('o')}
       AND (o.next_follow_up IS NULL OR o.next_follow_up = '')${oppScope}
     ORDER BY o.job_value_cents DESC LIMIT 3`, companyId, repId)
  if (noNext.length) {
    const names = noNext.map((o: any) => o.client).join(', ')
    push({
      id: 'nonext', type: 'no_next_step', priority: 'medium',
      title: `${noNext.length} lead${noNext.length > 1 ? 's have' : ' has'} no next step scheduled`,
      summary: `${names} — open deals with no follow-up date set.`,
      why: 'A deal without a scheduled next step is a deal drifting. Always leave every touch with the next one on the calendar.',
      action_kind: 'open_lead', action_payload: { oppId: noNext[0].id },
      actions: noNext.slice(0, 3).map((o: any) => ({ kind: 'open_lead', label: 'Open ' + String(o.client).slice(0, 18), payload: { oppId: o.id } })),
    })
  }

  // 4. ESTIMATES SENT, NO RESPONSE — sent/viewed 5+ days ago, still not accepted
  const coldEst = await q(
    `SELECT id, client_name, title, total_cents, status, sent_at, opp_id FROM estimates
     WHERE company_id = ?1 AND status IN ('sent','viewed') AND sent_at != ''
       AND julianday('now') - julianday(sent_at) >= ${Number(T.est_days)}
     ORDER BY total_cents DESC LIMIT 4`, companyId)
  for (const e of coldEst) {
    const days = Math.floor((Date.now() - new Date(String(e.sent_at).replace(' ', 'T') + 'Z').getTime()) / 86400000)
    push({
      id: 'est_' + e.id, type: 'estimate_no_response', priority: Number(e.total_cents || 0) > Math.round(T.est_high_total * 100) ? 'high' : 'medium',
      title: `Estimate for ${e.client_name} is sitting unanswered`,
      summary: `"${String(e.title || 'Estimate').slice(0, 50)}" ($${(Number(e.total_cents || 0) / 100).toLocaleString()}) was ${e.status === 'viewed' ? 'VIEWED but not accepted' : 'sent'} ${days} days ago.`,
      why: e.status === 'viewed'
        ? 'They opened it — something is holding them back. A quick "any questions?" call catches objections while the job is still top of mind.'
        : 'Estimates go cold fast. Following up within a week can double acceptance rates.',
      action_kind: 'open_view', action_payload: { view: 'estimates' },
      actions: [
        { kind: 'open_view', label: 'Open estimates', payload: { view: 'estimates' } },
        ...(e.opp_id ? [{ kind: 'draft_email', label: 'Draft nudge', payload: { oppId: e.opp_id, oppLabel: e.client_name } }] : []),
      ],
    })
  }

  // 5. OVERDUE TASKS (assigned to this rep, or all for managers)
  const taskScope = isMgr ? '' : ' AND assigned_user_id = ?2'
  const lateTasks = await q(
    `SELECT id, title, due_date, linked_record_label FROM tasks
     WHERE company_id = ?1 AND status = 'open' AND due_date IS NOT NULL AND due_date != ''
       AND date(due_date) < date('now')${taskScope}
     ORDER BY due_date ASC LIMIT 5`, companyId, repId)
  if (lateTasks.length) {
    push({
      id: 'tasks_overdue', type: 'overdue_tasks', priority: lateTasks.length >= 3 ? 'high' : 'medium',
      title: `${lateTasks.length} overdue task${lateTasks.length > 1 ? 's' : ''}`,
      summary: lateTasks.slice(0, 3).map((t: any) => `"${String(t.title).slice(0, 40)}"${t.linked_record_label ? ' (' + t.linked_record_label + ')' : ''}`).join(' · '),
      why: 'Overdue tasks pile up and bury the important ones. Knock out or reschedule these to keep the system trustworthy.',
      action_kind: 'open_view', action_payload: { view: 'tasks' },
      actions: [{ kind: 'open_view', label: 'Open tasks', payload: { view: 'tasks' } }],
    })
  }

  // 6. OVERDUE INVOICES — money you are owed (managers/admins only)
  if (isMgr) {
    const lateInv = await q(
      `SELECT id, client_name, invoice_number, balance_due_cents, due_date FROM invoices
       WHERE company_id = ?1 AND status IN ('sent','viewed','partial','overdue')
         AND balance_due_cents > 0 AND due_date != '' AND date(due_date) < date('now')
       ORDER BY balance_due_cents DESC LIMIT 4`, companyId)
    const owedCents = lateInv.reduce((s: number, i: any) => s + Number(i.balance_due_cents || 0), 0)
    if (lateInv.length) {
      push({
        id: 'inv_overdue', type: 'overdue_invoices', priority: owedCents > Math.round(T.inv_high_owed * 100) ? 'high' : 'medium',
        title: `$${(owedCents / 100).toLocaleString()} in overdue invoices`,
        summary: lateInv.slice(0, 3).map((i: any) => `${i.client_name} ($${(Number(i.balance_due_cents || 0) / 100).toLocaleString()})`).join(' · '),
        why: 'Cash flow is oxygen. The older an invoice gets, the harder it is to collect — a friendly reminder now beats an awkward call later.',
        action_kind: 'open_view', action_payload: { view: 'invoices' },
        actions: [{ kind: 'open_view', label: 'Open invoices', payload: { view: 'invoices' } }],
      })
    }
  }

  // 7. STAGE STAGNATION — pipeline concentration warning (managers only)
  if (isMgr) {
    const stuck = await q(
      `SELECT COALESCE(s.display_name,o.status) status, COUNT(*) n, SUM(o.job_value_cents) v FROM opportunities o
       LEFT JOIN sales_stage_assignments a ON a.company_id=o.company_id AND a.opportunity_id=o.id
         AND a.process_version_id=(SELECT id FROM sales_process_versions WHERE company_id=o.company_id AND lifecycle='published' ORDER BY published_at DESC LIMIT 1)
       LEFT JOIN sales_process_stages s ON s.company_id=a.company_id AND s.process_version_id=a.process_version_id AND s.id=a.stage_id
       WHERE o.company_id = ?1 AND ${gwAssistOpenPredicate('o', true)}
         AND julianday('now') - julianday(o.updated_at) >= ${Number(T.stag_days)}
       GROUP BY COALESCE(a.stage_id,o.status) ORDER BY n DESC LIMIT 1`, companyId)
    const st: any = stuck[0]
    if (st && Number(st.n) >= T.stag_min_deals) {
      push({
        id: 'stage_stuck', type: 'stage_stagnation', priority: 'medium',
        title: `${st.n} deals stuck in "${st.status}" for ${Math.round(Number(T.stag_days) / 7)}+ weeks`,
        summary: `$${(Number(st.v || 0) / 100).toLocaleString()} in combined value hasn't moved. This stage may be a process bottleneck.`,
        why: 'When deals cluster in one stage, the issue is usually process (slow estimates, unclear next steps), not the customers. Fix the stage, not just the deals.',
        action_kind: 'open_view', action_payload: { view: 'pipeline' },
        actions: [{ kind: 'open_view', label: 'Open pipeline', payload: { view: 'pipeline' } }],
      })
    }
  }

  // Sort: high first, keep insertion order within a band
  const rank: any = { high: 0, medium: 1, low: 2 }
  recs.sort((a, b) => (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1))
  return recs.slice(0, 10)
}

// GET /api/ai/assistant/context — deterministic snapshot + recommendations.
// No LLM call: fast, free, always available (works even with no AI key).
app.get('/api/ai/assistant/context', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId as string
  const role      = c.var.role as string
  const db = c.env.DB as D1Database

  const co: any = await db.prepare('SELECT name, business_type FROM companies WHERE id = ? LIMIT 1').bind(companyId).first().catch(() => null)
  const allRecs = await gwAssistSignals(db, companyId, repId, role)

  // Filter out suggestions this rep snoozed (server-persisted, per-rep)
  const snoozes = await gwAssistSnoozes(db, companyId, repId)
  const recs = allRecs.filter((r: any) => !snoozes[r.id])

  // Pipeline pulse (tenant-scoped headline numbers)
  const pulse: any = await db.prepare(
    `SELECT COUNT(*) n, COALESCE(SUM(o.job_value_cents),0) v FROM opportunities o
     WHERE o.company_id = ? AND ${gwAssistOpenPredicate('o')}`
  ).bind(companyId).first().catch(() => ({ n: 0, v: 0 }))

  // Getting Started progress (reuse the checklist logic result shape cheaply)
  let setup = { done: 0, total: 0 }
  try {
    const steps: any = await db.prepare(`SELECT COUNT(*) n FROM gw_onboarding_steps WHERE template_id = 'checklist_default' AND active = 1`).first()
    setup.total = Number(steps?.n) || 0
  } catch {}

  const { apiKey } = await _aiCreds(db, companyId, c.env)

  return json(c, {
    company: co?.name || '',
    company_id: companyId,
    business_type: co?.business_type || '',
    role,
    ai_enabled: !!apiKey,
    pipeline: { open: Number(pulse?.n) || 0, value: (Number(pulse?.v) || 0) / 100 },
    setup_total: setup.total,
    recommendations: recs,
    snoozed: Object.keys(snoozes).length,
  })
})

// POST /api/ai/assistant/snooze — { recId, days? } snoozes a suggestion for
// this rep (default 7 days); { recId, clear:true } un-snoozes. Per-rep,
// per-company, server-persisted in the settings KV table.
app.post('/api/ai/assistant/snooze', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId as string
  const db = c.env.DB as D1Database
  const b: any = await c.req.json().catch(() => ({}))
  const recId = String(b.recId || '').slice(0, 80)
  if (!recId || !/^[a-z0-9_-]+$/i.test(recId)) return err(c, 'recId required')
  const key = `gwai_snooze_${companyId}_${repId}`
  const map = await gwAssistSnoozes(db, companyId, repId) // already pruned
  if (b.clear) {
    delete map[recId]
  } else {
    const days = Math.min(90, Math.max(1, Number(b.days) || 7))
    map[recId] = new Date(Date.now() + days * 86400000).toISOString()
  }
  await db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))")
    .bind(key, JSON.stringify(map)).run()
  return json(c, { snoozed: !b.clear, recId, until: map[recId] || null })
})

// POST /api/ai/assistant — context-aware chat for the Groundwork AI panel.
// { question, view, oppId? } → { answer, tour?, actions? }
app.post('/api/ai/assistant', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId as string
  const role      = c.var.role as string
  const db = c.env.DB as D1Database
  const { apiKey, baseUrl, model, keySource } = await _aiCreds(db, companyId, c.env)
  if (!apiKey) return c.json({ ok: false, error: 'no_api_key', message: 'AI chat is not enabled for your company yet — the Suggestions and Setup tabs work without it.' }, 400)
  const _qg = await _aiQuotaGate(db, companyId, keySource)
  if (_qg) return c.json(_qg.body, _qg.status as any)

  const b: any = await c.req.json().catch(() => ({}))
  const question = String(b.question || '').slice(0, 1500)
  if (!question) return err(c, 'question required')

  const co: any = await db.prepare('SELECT name, business_type FROM companies WHERE id = ? LIMIT 1').bind(companyId).first().catch(() => null)
  const recs = await gwAssistSignals(db, companyId, repId, role)

  // Optional record context — validate tenant ownership before including
  let recordCtx = ''
  if (b.oppId) {
    const opp: any = await db.prepare(
      `SELECT id, client, status, job_value_cents, next_follow_up, updated_at, service_line, project FROM opportunities
       WHERE id = ? AND company_id = ? LIMIT 1`
    ).bind(String(b.oppId), companyId).first().catch(() => null)
    if (opp) {
      const comms = await db.prepare(
        `SELECT type, direction, subject, substr(body, 1, 200) body, ts FROM communications
         WHERE opp_id = ? AND company_id = ? ORDER BY ts DESC LIMIT 6`
      ).bind(opp.id, companyId).all().catch(() => ({ results: [] }))
      recordCtx = `CURRENTLY VIEWING LEAD: ${opp.client} — status "${opp.status}", value $${(Number(opp.job_value_cents || 0) / 100).toLocaleString()}, next follow-up: ${opp.next_follow_up || 'none scheduled'}, service: ${opp.service_line || 'n/a'}${opp.project ? ', project: ' + String(opp.project).slice(0, 100) : ''}\nRecent activity:\n` +
        ((comms.results || []) as any[]).map((m: any) => `- [${String(m.ts).slice(0, 10)}] ${m.type}/${m.direction}${m.subject ? ' "' + m.subject + '"' : ''}: ${String(m.body || '').replace(/\s+/g, ' ').slice(0, 120)}`).join('\n')
    }
  }

  const sys = `You are Groundwork AI — the in-app copilot and business coach inside Groundwork CRM, a field-services CRM (clients, estimates, proposals, invoices, work orders/dispatch, price book, Stripe payments, Google Calendar/Gmail sync, review requests, team roles, mobile field mode).

You help the user run their business: answer how-to questions, interpret their pipeline, prioritize follow-ups, coach on sales process, and point them at the right screen. Be direct, concise (2-6 short sentences or a tight list), and always ground advice in the CRM DATA provided below. Never invent data or features.

App navigation: Clients (add/import), Services & Pricing (price book), Estimates (create → email → client accepts online → converts to invoice), Invoices (Pay Now via Stripe), Dispatch board (work orders, crews), Integrations (Stripe, Google), Employees (invites/roles), Settings (branding), Reviews (auto review requests), My Day (personal dashboard), Pipeline (leads by stage), Tasks.

GUIDED TOURS available (return the id in "tour" ONLY if the question maps clearly to one setup task): cl_branding, cl_client, cl_pricebook, cl_estimate, cl_workorder, cl_invoice, cl_payments, cl_team, cl_google, cl_reviews.

Return ONLY valid JSON: {"answer":"string","tour":"cl_xxx or null"}`

  const ctx = [
    `Company: ${co?.name || 'Unknown'}${co?.business_type ? ' (' + co.business_type + ')' : ''} · User role: ${role}`,
    `User is on view: ${String(b.view || 'dashboard').slice(0, 60)}`,
    recordCtx,
    recs.length ? `CURRENT CRM SIGNALS (deterministic, real data):\n${recs.map((r: any) => `- [${r.priority}] ${r.title}: ${r.summary}`).join('\n')}` : 'No urgent CRM signals right now.',
    `Question: ${question}`,
  ].filter(Boolean).join('\n\n')

  try {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: ctx }] }),
    })
    if (!r.ok) {
      const errText = await r.text().catch(() => '')
      console.error('[ai/assistant] upstream', r.status, errText.slice(0, 300))
      return c.json({ ok: false, error: 'ai_upstream', message: `AI service error (${r.status}).` }, 502)
    }
    const data: any = await r.json()
    await _logAiUsage(db, companyId, repId, 'assistant', model, data?.usage, keySource)
    let parsed: any = null
    try {
      const raw = String(data?.choices?.[0]?.message?.content || '').replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '')
      parsed = JSON.parse(raw)
    } catch {}
    if (!parsed || !parsed.answer) {
      const plain = String(data?.choices?.[0]?.message?.content || '').trim()
      parsed = { answer: plain || 'Sorry — I hit a snag. Try asking again.', tour: null }
    }
    if (parsed.tour && !/^cl_[a-z_]+$/.test(String(parsed.tour))) parsed.tour = null
    return json(c, { answer: String(parsed.answer).slice(0, 3000), tour: parsed.tour || null })
  } catch (e: any) {
    console.error('[ai/assistant]', e?.message || e)
    return c.json({ ok: false, error: 'ai_error', message: 'AI request failed — try again.' }, 502)
  }
})

// ── PUBLIC: demo request intake from groundwork-crm.info ────────────────────
// No auth — CORS-restricted to the marketing site (+ prod/local origins).
// Includes a honeypot field and a light per-email rate limit.
const DEMO_ALLOWED_ORIGINS = [
  'https://groundwork-crm.info',
  'https://www.groundwork-crm.info',
  'https://groundwork-crm.com',
  'https://www.groundwork-crm.com',
]
app.use('/api/public/demo-request', cors({
  origin: (origin) => {
    if (!origin) return undefined
    if (DEMO_ALLOWED_ORIGINS.includes(origin)) return origin
    if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return origin
    return undefined
  },
  allowMethods: ['POST', 'OPTIONS'],
}))
app.post('/api/public/demo-request', async (c) => {
  await ensureGwOpsSchema(c.env.DB)
  let b: any
  try { b = await c.req.json() } catch { return err(c, 'Invalid JSON body') }
  // Honeypot: bots fill every field — silently accept but drop
  if (b.website_url) return json(c, { received: true })
  const email = String(b.email || '').trim().slice(0, 200)
  const contact = String(b.name || b.contact_name || '').trim().slice(0, 200)
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(c, 'Valid email required')
  if (!contact) return err(c, 'Name required')
  // Rate limit: max 3 requests per email per day
  const recent = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM gw_demos WHERE email = ? AND created_at > datetime('now','-1 day')`
  ).bind(email).first<any>()
  if ((recent?.n || 0) >= 3) return err(c, 'Too many requests — please try again tomorrow', 429)
  const id = uid()
  await c.env.DB.prepare(
    `INSERT INTO gw_demos (id, company_name, contact_name, email, phone, message, status, source, source_page, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'requested', 'website', ?, datetime('now'), datetime('now'))`
  ).bind(
    id,
    String(b.company || b.company_name || '').trim().slice(0, 200),
    contact,
    email,
    String(b.phone || '').trim().slice(0, 50),
    String(b.message || '').trim().slice(0, 2000),
    String(b.source_page || '').trim().slice(0, 300)
  ).run()
  return json(c, { received: true, id })
})

// GET /demo-request — public branded demo-request form (no auth).
// Link this from groundwork-crm.info ("Request a Demo" buttons) or embed via
// iframe (?embed=1 hides the header/footer chrome). Posts to the existing
// /api/public/demo-request intake (honeypot + rate limit already enforced).
app.get('/demo-request', (c) => {
  const embed = c.req.query('embed') === '1'
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Request a Demo — Groundwork CRM</title>
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:${embed ? 'transparent' : 'linear-gradient(160deg,#0D2318,#1C3A2B 60%,#2D7A55)'}; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:${embed ? '0' : '24px'}; }
  .dr-card { background:#fff; border-radius:20px; width:100%; max-width:480px; padding:34px 32px; ${embed ? '' : 'box-shadow:0 28px 90px rgba(0,0,0,.4);'} }
  .dr-brand { display:flex; align-items:center; gap:11px; margin-bottom:20px; }
  .dr-mark { width:40px; height:40px; border-radius:11px; background:#2D7A55; display:flex; align-items:center; justify-content:center; color:#fff; font-weight:900; font-size:19px; }
  .dr-title { font-size:20px; font-weight:800; color:#1C3A2B; letter-spacing:-.02em; }
  .dr-sub { font-size:13px; color:#6B7280; margin-top:2px; }
  label { display:block; font-size:12px; font-weight:800; color:#374151; margin:14px 0 5px; }
  input, textarea { width:100%; border:1.5px solid #D1D5DB; border-radius:11px; padding:11px 13px; font-size:14px; font-family:inherit; outline:none; transition:border-color .15s; }
  input:focus, textarea:focus { border-color:#2D7A55; }
  textarea { resize:vertical; min-height:80px; }
  .dr-req::after { content:' *'; color:#C0392B; }
  .dr-hp { position:absolute; left:-9999px; opacity:0; height:0; overflow:hidden; }
  button { width:100%; margin-top:20px; background:linear-gradient(135deg,#1C3A2B,#2D7A55); border:none; border-radius:12px; color:#fff; font-size:15px; font-weight:800; padding:14px; cursor:pointer; font-family:inherit; transition:transform .12s; }
  button:hover { transform:translateY(-1px); }
  button:disabled { opacity:.6; cursor:default; transform:none; }
  .dr-msg { margin-top:14px; font-size:13px; font-weight:700; padding:11px 14px; border-radius:10px; display:none; }
  .dr-msg.ok { display:block; background:#F0FAF4; color:#1C6B45; border:1.5px solid rgba(45,122,85,.3); }
  .dr-msg.err { display:block; background:#FDF0EE; color:#A93226; border:1.5px solid rgba(192,57,43,.3); }
  .dr-done { text-align:center; padding:26px 8px; display:none; }
  .dr-done-icon { width:58px; height:58px; border-radius:50%; background:#F0FAF4; display:flex; align-items:center; justify-content:center; margin:0 auto 16px; font-size:26px; color:#2D7A55; font-weight:900; }
  .dr-foot { text-align:center; font-size:11px; color:${embed ? '#9CA3AF' : 'rgba(255,255,255,.7)'}; margin-top:16px; }
</style>
</head>
<body>
<main>
<section class="dr-card" id="demo-request-card">
  <form id="demoForm" novalidate>
    <header class="dr-brand">
      <div class="dr-mark">G</div>
      <div><div class="dr-title">See Groundwork in action</div><div class="dr-sub">Tell us a little about your business — we'll reach out within one business day.</div></div>
    </header>
    <label class="dr-req" for="drName">Your name</label>
    <input id="drName" name="name" autocomplete="name" maxlength="200" required>
    <label class="dr-req" for="drEmail">Work email</label>
    <input id="drEmail" name="email" type="email" autocomplete="email" maxlength="200" required>
    <label for="drCompany">Company</label>
    <input id="drCompany" name="company" autocomplete="organization" maxlength="200">
    <label for="drPhone">Phone</label>
    <input id="drPhone" name="phone" type="tel" autocomplete="tel" maxlength="50">
    <label for="drMessage">What are you hoping to solve?</label>
    <textarea id="drMessage" name="message" maxlength="2000" placeholder="Estimates, scheduling, invoicing, follow-ups…"></textarea>
    <div class="dr-hp" aria-hidden="true"><label for="drWebsite">Website</label><input id="drWebsite" name="website_url" tabindex="-1" autocomplete="off"></div>
    <button type="submit" id="drSubmit">Request my demo</button>
    <div class="dr-msg" id="drMsg" role="alert"></div>
  </form>
  <div class="dr-done" id="drDone">
    <div class="dr-done-icon">✓</div>
    <div style="font-size:19px;font-weight:800;color:#1C3A2B">Request received!</div>
    <div style="font-size:13.5px;color:#6B7280;margin-top:9px;line-height:1.6">Thanks — we'll reach out within one business day to schedule your walkthrough.</div>
  </div>
</section>
</main>
${embed ? '' : '<div class="dr-foot" style="position:fixed;bottom:14px;left:0;right:0">Groundwork CRM — built for field-services teams</div>'}
<script>
(function(){
  var f = document.getElementById('demoForm');
  f.addEventListener('submit', function(e){
    e.preventDefault();
    var btn = document.getElementById('drSubmit'), msg = document.getElementById('drMsg');
    msg.className = 'dr-msg';
    var body = {
      name: document.getElementById('drName').value.trim(),
      email: document.getElementById('drEmail').value.trim(),
      company: document.getElementById('drCompany').value.trim(),
      phone: document.getElementById('drPhone').value.trim(),
      message: document.getElementById('drMessage').value.trim(),
      website_url: document.getElementById('drWebsite').value,
      source_page: document.referrer || location.href
    };
    if (!body.name) { msg.textContent = 'Please enter your name.'; msg.className = 'dr-msg err'; return; }
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(body.email)) { msg.textContent = 'Please enter a valid email.'; msg.className = 'dr-msg err'; return; }
    btn.disabled = true; btn.textContent = 'Sending…';
    fetch('/api/public/demo-request', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) })
      .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
      .then(function(res){
        if (res.ok) { f.style.display = 'none'; document.getElementById('drDone').style.display = 'block'; }
        else { msg.textContent = (res.j && (res.j.error || res.j.message)) || 'Something went wrong — try again.'; msg.className = 'dr-msg err'; btn.disabled = false; btn.textContent = 'Request my demo'; }
      })
      .catch(function(){ msg.textContent = 'Network error — please try again.'; msg.className = 'dr-msg err'; btn.disabled = false; btn.textContent = 'Request my demo'; });
  });
})();
</script>
</body>
</html>`)
})

// POST /api/admin/clear-sessions — revoke sessions for ONE company (default: caller's own).
// Pass { companyId, all: true } to wipe platform-wide (explicit opt-in).
app.post('/api/admin/clear-sessions', requireSuperAdmin, async (c) => {
  const b: any = await c.req.json().catch(() => ({}))
  if (b.all === true) {
    await c.env.DB.prepare(`DELETE FROM settings WHERE key LIKE 'session_%'`).run()
    return json(c, { cleared: 'all' })
  }
  const target = String(b.companyId || c.var.companyId)
  // Delete session_<token> rows whose companion session_company_<token> matches target
  const rows = await c.env.DB.prepare(
    `SELECT key FROM settings WHERE key LIKE 'session_company_%' AND value = ?`
  ).bind(target).all()
  const stmts: D1PreparedStatement[] = []
  for (const r of (rows.results as any[])) {
    const token = String(r.key).slice('session_company_'.length)
    stmts.push(c.env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(`session_${token}`))
    stmts.push(c.env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(r.key))
  }
  if (stmts.length) await c.env.DB.batch(stmts)
  return json(c, { cleared: target, sessions: (rows.results as any[]).length })
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

// ── ASSETS HUB (D1) ───────────────────────────────────────────────────────────
// Unified equipment / maintenance / stock tracking. All roles with nav access
// can read; writes allowed for admin, office_manager, division_manager,
// mechanic, foreman (field logging: meter updates + service log entries).

const ASSET_WRITE_ROLES = ['admin', 'office_manager', 'division_manager', 'mechanic']
const ASSET_LOG_ROLES   = [...ASSET_WRITE_ROLES, 'foreman', 'field_supervisor', 'laborer']

// GET /api/assets — all assets + service plans (joined client-side by asset_id)
app.get('/api/assets', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensureAssetsSchema(db)
  const [assets, plans] = await Promise.all([
    db.prepare(`SELECT * FROM assets WHERE company_id = ? AND active = 1 ORDER BY category, name`).bind(companyId).all(),
    db.prepare(`SELECT * FROM asset_service_plans WHERE company_id = ? ORDER BY asset_id, sort_order`).bind(companyId).all(),
  ])
  return c.json({ ok: true, data: { assets: assets.results || [], plans: plans.results || [] } })
})

// POST /api/assets — create or update an asset (upsert by id)
app.post('/api/assets', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role = c.var.role as string
  if (!ASSET_WRITE_ROLES.includes(role)) return c.json({ ok: false, error: 'Not permitted' }, 403)
  const db = c.env.DB as D1Database
  await ensureAssetsSchema(db)
  const b: any = await c.req.json()
  const id = b.id || ('ast_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7))
  const name = (b.name || '').trim()
  if (!name) return c.json({ ok: false, error: 'Asset name required' }, 400)
  await db.prepare(`
    INSERT INTO assets (id, company_id, asset_tag, name, category, year, make, model, vin,
      engine_notes, meter_type, current_meter, meter_updated_at, status, assigned_to, location, notes, active, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      asset_tag=excluded.asset_tag, name=excluded.name, category=excluded.category,
      year=excluded.year, make=excluded.make, model=excluded.model, vin=excluded.vin,
      engine_notes=excluded.engine_notes, meter_type=excluded.meter_type,
      current_meter=excluded.current_meter, meter_updated_at=excluded.meter_updated_at,
      status=excluded.status, assigned_to=excluded.assigned_to, location=excluded.location,
      notes=excluded.notes, active=1, updated_at=datetime('now')
  `).bind(
    id, companyId, b.assetTag || b.asset_tag || '', name, b.category || 'equipment',
    b.year ? Number(b.year) : null, b.make || '', b.model || '', b.vin || '',
    b.engineNotes || b.engine_notes || '', b.meterType || b.meter_type || 'hours',
    (b.currentMeter ?? b.current_meter) != null ? Number(b.currentMeter ?? b.current_meter) : null,
    b.meterUpdatedAt || b.meter_updated_at || null,
    b.status || 'active', b.assignedTo || b.assigned_to || '', b.location || '', b.notes || ''
  ).run()
  return c.json({ ok: true, data: { id } })
})

// PUT /api/assets/:id/meter — quick meter update (field roles allowed)
app.put('/api/assets/:id/meter', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role = c.var.role as string
  if (!ASSET_LOG_ROLES.includes(role)) return c.json({ ok: false, error: 'Not permitted' }, 403)
  const db = c.env.DB as D1Database
  await ensureAssetsSchema(db)
  const id = c.req.param('id')
  const b: any = await c.req.json()
  const meter = Number(b.currentMeter ?? b.meter)
  if (!isFinite(meter)) return c.json({ ok: false, error: 'Invalid meter value' }, 400)
  const r = await db.prepare(`UPDATE assets SET current_meter=?, meter_updated_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND company_id=?`)
    .bind(meter, id, companyId).run()
  if (!r.meta.changes) return c.json({ ok: false, error: 'Asset not found' }, 404)
  return c.json({ ok: true })
})

// DELETE /api/assets/:id — soft delete
app.delete('/api/assets/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role = c.var.role as string
  if (!ASSET_WRITE_ROLES.includes(role)) return c.json({ ok: false, error: 'Not permitted' }, 403)
  const db = c.env.DB as D1Database
  await ensureAssetsSchema(db)
  const assetId = c.req.param('id')
  await db.prepare(`UPDATE assets SET active=0, updated_at=datetime('now') WHERE id=? AND company_id=?`)
    .bind(assetId, companyId).run()
  // Remove its service plans so they don't linger as orphans in list payloads
  await db.prepare(`DELETE FROM asset_service_plans WHERE asset_id=? AND company_id=?`)
    .bind(assetId, companyId).run()
  return c.json({ ok: true })
})

// PUT /api/assets/:id/plans — replace all service plans for an asset
app.put('/api/assets/:id/plans', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role = c.var.role as string
  if (!ASSET_WRITE_ROLES.includes(role)) return c.json({ ok: false, error: 'Not permitted' }, 403)
  const db = c.env.DB as D1Database
  await ensureAssetsSchema(db)
  const assetId = c.req.param('id')
  const b: any = await c.req.json()
  const plans: any[] = Array.isArray(b.plans) ? b.plans : []
  const stmts: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM asset_service_plans WHERE asset_id = ? AND company_id = ?`).bind(assetId, companyId)
  ]
  plans.forEach((p, i) => {
    const pid = p.id || ('plan_' + Date.now() + '_' + i + '_' + Math.random().toString(36).slice(2, 5))
    stmts.push(db.prepare(`
      INSERT INTO asset_service_plans (id, company_id, asset_id, service_type, label, material_spec,
        interval_meter, interval_months, last_date, last_meter, next_date, next_meter, sort_order, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    `).bind(
      pid, companyId, assetId, p.serviceType || p.service_type || 'custom',
      p.label || '', p.materialSpec || p.material_spec || '',
      p.intervalMeter != null ? Number(p.intervalMeter) : (p.interval_meter != null ? Number(p.interval_meter) : null),
      p.intervalMonths != null ? Number(p.intervalMonths) : (p.interval_months != null ? Number(p.interval_months) : null),
      p.lastDate || p.last_date || null,
      (p.lastMeter ?? p.last_meter) != null ? Number(p.lastMeter ?? p.last_meter) : null,
      p.nextDate || p.next_date || null,
      (p.nextMeter ?? p.next_meter) != null ? Number(p.nextMeter ?? p.next_meter) : null,
      i
    ))
  })
  await db.batch(stmts)
  return c.json({ ok: true })
})

// GET /api/assets/:id/log — service history for one asset
app.get('/api/assets/:id/log', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensureAssetsSchema(db)
  const log = await db.prepare(`SELECT * FROM asset_service_log WHERE asset_id = ? AND company_id = ? ORDER BY performed_date DESC, created_at DESC LIMIT 200`)
    .bind(c.req.param('id'), companyId).all()
  return c.json({ ok: true, data: log.results || [] })
})

// GET /api/service-log — recent service activity across all assets
app.get('/api/service-log', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensureAssetsSchema(db)
  const log = await db.prepare(`SELECT * FROM asset_service_log WHERE company_id = ? ORDER BY performed_date DESC, created_at DESC LIMIT 100`)
    .bind(companyId).all()
  return c.json({ ok: true, data: log.results || [] })
})

// POST /api/assets/:id/log — record a completed service (field roles allowed).
// Also rolls the matching service plan forward (last/next date + meter).
app.post('/api/assets/:id/log', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role = c.var.role as string
  if (!ASSET_LOG_ROLES.includes(role)) return c.json({ ok: false, error: 'Not permitted' }, 403)
  const db = c.env.DB as D1Database
  await ensureAssetsSchema(db)
  const assetId = c.req.param('id')
  const b: any = await c.req.json()
  const id = 'svc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)
  const performedDate = b.performedDate || b.performed_date || new Date().toISOString().slice(0, 10)
  const performedMeter = (b.performedMeter ?? b.performed_meter) != null ? Number(b.performedMeter ?? b.performed_meter) : null
  await db.prepare(`
    INSERT INTO asset_service_log (id, company_id, asset_id, plan_id, service_type, performed_date, performed_meter, performed_by, cost, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).bind(
    id, companyId, assetId, b.planId || b.plan_id || null, b.serviceType || b.service_type || '',
    performedDate, performedMeter, b.performedBy || b.performed_by || '',
    b.cost != null ? Number(b.cost) : null, b.notes || ''
  ).run()
  // Roll the plan forward
  const planId = b.planId || b.plan_id
  if (planId) {
    const plan = await db.prepare(`SELECT * FROM asset_service_plans WHERE id = ? AND company_id = ?`).bind(planId, companyId).first<any>()
    if (plan) {
      let nextDate: string | null = null
      if (plan.interval_months) {
        const d = new Date(performedDate + 'T12:00:00')
        d.setMonth(d.getMonth() + Math.round(plan.interval_months))
        nextDate = d.toISOString().slice(0, 10)
      }
      const nextMeter = (performedMeter != null && plan.interval_meter) ? performedMeter + plan.interval_meter : null
      await db.prepare(`UPDATE asset_service_plans SET last_date=?, last_meter=?, next_date=?, next_meter=?, updated_at=datetime('now') WHERE id=?`)
        .bind(performedDate, performedMeter, nextDate, nextMeter, planId).run()
    }
  }
  // Update asset meter if provided and higher than current
  if (performedMeter != null) {
    await db.prepare(`UPDATE assets SET current_meter = CASE WHEN current_meter IS NULL OR current_meter < ? THEN ? ELSE current_meter END, meter_updated_at=datetime('now') WHERE id=? AND company_id=?`)
      .bind(performedMeter, performedMeter, assetId, companyId).run()
  }
  return c.json({ ok: true, data: { id } })
})

// POST /api/assets/import-bulk — bulk import assets w/ service plans (spreadsheet import)
app.post('/api/assets/import-bulk', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role = c.var.role as string
  if (!ASSET_WRITE_ROLES.includes(role)) return c.json({ ok: false, error: 'Not permitted' }, 403)
  const db = c.env.DB as D1Database
  await ensureAssetsSchema(db)
  const b: any = await c.req.json()
  const rows: any[] = Array.isArray(b.assets) ? b.assets : []
  if (!rows.length) return c.json({ ok: false, error: 'No assets to import' }, 400)
  if (rows.length > 500) return c.json({ ok: false, error: 'Max 500 assets per import' }, 400)
  let imported = 0
  for (const a of rows) {
    const name = (a.name || '').trim()
    if (!name) continue
    const id = a.id || ('ast_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7))
    await db.prepare(`
      INSERT INTO assets (id, company_id, asset_tag, name, category, year, make, model, vin,
        engine_notes, meter_type, current_meter, status, assigned_to, location, notes, active, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,datetime('now'))
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=datetime('now')
    `).bind(
      id, companyId, a.assetTag || '', name, a.category || 'equipment',
      a.year ? Number(a.year) : null, a.make || '', a.model || '', String(a.vin || ''),
      a.engineNotes || '', a.meterType || 'hours',
      a.currentMeter != null ? Number(a.currentMeter) : null,
      a.status || 'active', a.assignedTo || '', a.location || '', a.notes || ''
    ).run()
    const plans: any[] = Array.isArray(a.plans) ? a.plans : []
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i]
      const pid = 'plan_' + Date.now() + '_' + imported + '_' + i + '_' + Math.random().toString(36).slice(2, 5)
      await db.prepare(`
        INSERT INTO asset_service_plans (id, company_id, asset_id, service_type, label, material_spec,
          interval_meter, interval_months, last_date, last_meter, next_date, next_meter, sort_order)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        pid, companyId, id, p.serviceType || 'custom', p.label || '', p.materialSpec || '',
        p.intervalMeter != null ? Number(p.intervalMeter) : null,
        p.intervalMonths != null ? Number(p.intervalMonths) : null,
        p.lastDate || null, p.lastMeter != null ? Number(p.lastMeter) : null,
        p.nextDate || null, p.nextMeter != null ? Number(p.nextMeter) : null, i
      ).run()
    }
    imported++
  }
  return c.json({ ok: true, data: { imported } })
})

// ── STOCK ITEMS (unified inventory + tools + consumables) ─────────────────────

// GET /api/stock — all stock items
app.get('/api/stock', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensureAssetsSchema(db)
  const items = await db.prepare(`SELECT * FROM stock_items WHERE company_id = ? AND active = 1 ORDER BY item_type, name`).bind(companyId).all()
  return c.json({ ok: true, data: items.results || [] })
})

// POST /api/stock — create/update stock item (upsert by id)
app.post('/api/stock', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role = c.var.role as string
  if (!ASSET_WRITE_ROLES.includes(role)) return c.json({ ok: false, error: 'Not permitted' }, 403)
  const db = c.env.DB as D1Database
  await ensureAssetsSchema(db)
  const b: any = await c.req.json()
  const id = b.id || ('stk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7))
  const name = (b.name || '').trim()
  if (!name) return c.json({ ok: false, error: 'Item name required' }, 400)
  await db.prepare(`
    INSERT INTO stock_items (id, company_id, name, item_type, on_hand, unit, reorder_at, vendor, location, unit_cost, notes, active, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,1,datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, item_type=excluded.item_type, on_hand=excluded.on_hand,
      unit=excluded.unit, reorder_at=excluded.reorder_at, vendor=excluded.vendor,
      location=excluded.location, unit_cost=excluded.unit_cost, notes=excluded.notes,
      active=1, updated_at=datetime('now')
  `).bind(
    id, companyId, name, b.itemType || b.item_type || 'material',
    Number(b.onHand ?? b.on_hand ?? 0), b.unit || 'ea', Number(b.reorderAt ?? b.reorder_at ?? 0),
    b.vendor || '', b.location || '', (b.unitCost ?? b.unit_cost) != null ? Number(b.unitCost ?? b.unit_cost) : null, b.notes || ''
  ).run()
  return c.json({ ok: true, data: { id } })
})

// PUT /api/stock/:id/qty — quick quantity adjust (field roles allowed)
app.put('/api/stock/:id/qty', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role = c.var.role as string
  if (!ASSET_LOG_ROLES.includes(role)) return c.json({ ok: false, error: 'Not permitted' }, 403)
  const db = c.env.DB as D1Database
  await ensureAssetsSchema(db)
  const b: any = await c.req.json()
  const qty = Number(b.onHand ?? b.qty)
  if (!isFinite(qty) || qty < 0) return c.json({ ok: false, error: 'Invalid quantity' }, 400)
  const r = await db.prepare(`UPDATE stock_items SET on_hand=?, updated_at=datetime('now') WHERE id=? AND company_id=?`)
    .bind(qty, c.req.param('id'), companyId).run()
  if (!r.meta.changes) return c.json({ ok: false, error: 'Item not found' }, 404)
  return c.json({ ok: true })
})

// DELETE /api/stock/:id — soft delete
app.delete('/api/stock/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role = c.var.role as string
  if (!ASSET_WRITE_ROLES.includes(role)) return c.json({ ok: false, error: 'Not permitted' }, 403)
  const db = c.env.DB as D1Database
  await ensureAssetsSchema(db)
  await db.prepare(`UPDATE stock_items SET active=0, updated_at=datetime('now') WHERE id=? AND company_id=?`)
    .bind(c.req.param('id'), companyId).run()
  return c.json({ ok: true })
})

// POST /api/stock/import-bulk — bulk import stock items
app.post('/api/stock/import-bulk', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role = c.var.role as string
  if (!ASSET_WRITE_ROLES.includes(role)) return c.json({ ok: false, error: 'Not permitted' }, 403)
  const db = c.env.DB as D1Database
  await ensureAssetsSchema(db)
  const b: any = await c.req.json()
  const rows: any[] = Array.isArray(b.items) ? b.items : []
  if (!rows.length) return c.json({ ok: false, error: 'No items to import' }, 400)
  if (rows.length > 1000) return c.json({ ok: false, error: 'Max 1000 items per import' }, 400)
  const stmts: D1PreparedStatement[] = []
  let n = 0
  for (const it of rows) {
    const name = (it.name || '').trim()
    if (!name) continue
    const id = it.id || ('stk_' + Date.now() + '_' + (n++) + '_' + Math.random().toString(36).slice(2, 5))
    stmts.push(db.prepare(`
      INSERT INTO stock_items (id, company_id, name, item_type, on_hand, unit, reorder_at, vendor, location, unit_cost, notes, active)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=datetime('now')
    `).bind(
      id, companyId, name, it.itemType || 'material', Number(it.onHand || 0), it.unit || 'ea',
      Number(it.reorderAt || 0), it.vendor || '', it.location || '',
      it.unitCost != null ? Number(it.unitCost) : null, it.notes || ''
    ))
  }
  if (stmts.length) await db.batch(stmts)
  return c.json({ ok: true, data: { imported: stmts.length } })
})

// ── ESTIMATES (D1) ────────────────────────────────────────────────────────────

// GET /api/estimates — list estimates with optional filters
app.get('/api/estimates', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  // Backfill portal tokens for rows created before tokens were introduced —
  // empty tokens produce dead /portal links, so heal them on read.
  await db.prepare(`UPDATE estimates SET portal_token = lower(hex(randomblob(16))) WHERE company_id=? AND (portal_token IS NULL OR portal_token='')`).bind(companyId).run().catch(() => {})
  const status  = c.req.query('status')
  const repId   = c.req.query('rep_id')
  const search  = c.req.query('q')
  const limit   = Math.min(Number(c.req.query('limit') || 200), 500)
  const offset  = Number(c.req.query('offset') || 0)

  const oppId   = c.req.query('opp_id')
  const estClientId = c.req.query('client_id')
  let q = `SELECT * FROM estimates WHERE company_id = ?`
  const params: any[] = [companyId]
  if (status) { q += ` AND status = ?`; params.push(status) }
  if (repId)  { q += ` AND rep_id = ?`; params.push(repId) }
  if (oppId)  { q += ` AND opp_id = ?`; params.push(oppId) }
  if (estClientId) { q += ` AND client_id = ?`; params.push(estClientId) }
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
    SELECT status, COUNT(*) as cnt, COALESCE(SUM(total_cents),0) as total_val_cents
    FROM estimates WHERE company_id = ?
    GROUP BY status
  `).bind(companyId).all()
  const kpis: Record<string,{cnt:number;val:number}> = {}
  for (const r of (rows.results||[]) as any[]) {
    kpis[r.status] = { cnt: r.cnt, val: Number(r.total_val_cents || 0) / 100 }
  }
  return c.json({ ok: true, data: kpis })
})

// GET /api/estimates/:id
app.get('/api/estimates/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await db.prepare(`UPDATE estimates SET portal_token = lower(hex(randomblob(16))) WHERE id=? AND company_id=? AND (portal_token IS NULL OR portal_token='')`).bind(c.req.param('id'), companyId).run().catch(() => {})
  const row: any = await db.prepare(`SELECT * FROM estimates WHERE id=? AND company_id=?`)
    .bind(c.req.param('id'), companyId).first()
  if (!row) return c.json({ ok: false, error: 'Not found' }, 404)
  return c.json({ ok: true, data: {
    ...row,
    line_items:  JSON.parse(row.line_items  || '[]'),
    attachments: JSON.parse(row.attachments || '[]'),
    payment_schedule: JSON.parse(row.payment_schedule || '[]'),
  }})
})

// PUT /api/estimates/:id/payment-schedule — save custom payment splits
app.put('/api/estimates/:id/payment-schedule', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensureProposalsSchema(db)
  const b: any = await c.req.json()
  const sched: any[] = Array.isArray(b.payment_schedule) ? b.payment_schedule : []
  const totalPct = sched.reduce((s, p) => s + Number(p.pct || 0), 0)
  if (sched.length && Math.abs(totalPct - 100) > 0.01) {
    return c.json({ ok: false, error: `Payment schedule must total 100% (currently ${totalPct.toFixed(1)}%)` }, 400)
  }
  const r = await db.prepare(`UPDATE estimates SET payment_schedule=?, updated_at=datetime('now') WHERE id=? AND company_id=?`)
    .bind(JSON.stringify(sched), c.req.param('id'), companyId).run()
  if (!r.meta.changes) return c.json({ ok: false, error: 'Estimate not found' }, 404)
  return c.json({ ok: true })
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
  let _brand: any = null
  try {
    _brand = await db.prepare(
      'SELECT name, logo_url, tagline, brand_color, brand_accent, phone, website, address_line1, address_city, address_state, address_zip FROM companies WHERE id = ? LIMIT 1'
    ).bind(row.company_id).first()
  } catch (_) {}
  return c.json({ ok: true, data: {
    ...row,
    line_items:  JSON.parse(row.line_items  || '[]'),
    attachments: JSON.parse(row.attachments || '[]'),
    _brand,
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
      status,subtotal,subtotal_cents,discount_pct,discount_amt,discount_amt_cents,
      tax_pct,tax_amt,tax_amt_cents,total,total_cents,
      deposit_pct,deposit_amt,deposit_amt_cents,line_items,attachments,
      internal_notes,customer_notes,terms,portal_token,
      estimate_date,expiry_date,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
  `).bind(
    id,companyId,estNumber,
    b.title||'',b.scope_of_work||'',
    b.client_id||'',b.client_name||'',b.client_email||'',b.client_phone||'',b.client_address||'',
    b.property_id||'',b.property_addr||'',b.opp_id||'',
    repId,b.assigned_to||repId,
    b.status||'draft',
    subtotal,Math.round(subtotal*100),Number(b.discount_pct||0),discAmt,Math.round(discAmt*100),
    Number(b.tax_pct||0),taxAmt,Math.round(taxAmt*100),total,Math.round(total*100),
    Number(b.deposit_pct||30),depAmt,Math.round(depAmt*100),
    JSON.stringify(items),JSON.stringify(b.attachments||[]),
    b.internal_notes||'',b.customer_notes||'',b.terms||'',
    portalToken,
    b.estimate_date||new Date().toISOString().slice(0,10),
    b.expiry_date||''
  ).run()
  // Merge-extension fields (mode/tiers/cost engine/recurring) — best-effort secondary update
  await _estApplyExtFields(db, id, companyId, b)
  return c.json({ ok: true, data: { id, est_number: estNumber, portal_token: portalToken } }, 201)
})

// Persist estimate merge-extension columns when present in the payload (0034)
async function _estApplyExtFields(db: D1Database, id: string, companyId: string, b: any) {
  const sets: string[] = []; const binds: any[] = []
  const push = (col: string, v: any) => { sets.push(`${col}=?`); binds.push(v) }
  if (b.mode !== undefined)           push('mode', b.mode === 'advanced' ? 'advanced' : 'simple')
  if (b.doc_type !== undefined)       push('doc_type', b.doc_type === 'recurring' ? 'recurring' : 'onetime')
  if (b.overview !== undefined)       push('overview', String(b.overview || ''))
  if (b.sections !== undefined)       push('sections', JSON.stringify(b.sections || []))
  if (b.tiers !== undefined)          push('tiers', JSON.stringify(b.tiers || []))
  if (b.accepted_tier !== undefined)  push('accepted_tier', String(b.accepted_tier || ''))
  if (b.payment_schedule !== undefined) push('payment_schedule', JSON.stringify(b.payment_schedule || []))
  if (b.cost_data !== undefined)      push('cost_data', JSON.stringify(b.cost_data || {}))
  if (b.recurring_data !== undefined) push('recurring_data', JSON.stringify(b.recurring_data || {}))
  if (b.ai_meta !== undefined)        push('ai_meta', JSON.stringify(b.ai_meta || {}))
  if (b.price_display !== undefined)  push('price_display', b.price_display === 'total_only' ? 'total_only' : 'itemized')
  if (!sets.length) return
  try {
    await ensurePriceBookSchema(db)
    await db.prepare(`UPDATE estimates SET ${sets.join(',')} WHERE id=? AND company_id=?`).bind(...binds, id, companyId).run()
  } catch (e: any) { console.log('estExtFields err', String(e?.message || e).slice(0, 120)) }
}

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
      status=?,subtotal=?,subtotal_cents=?,discount_pct=?,discount_amt=?,discount_amt_cents=?,
      tax_pct=?,tax_amt=?,tax_amt_cents=?,total=?,total_cents=?,
      deposit_pct=?,deposit_amt=?,deposit_amt_cents=?,line_items=?,attachments=?,
      internal_notes=?,customer_notes=?,terms=?,
      estimate_date=?,expiry_date=?,updated_at=datetime('now')
    WHERE id=? AND company_id=?
  `).bind(
    b.title||'',b.scope_of_work||'',
    b.client_id||'',b.client_name||'',b.client_email||'',b.client_phone||'',b.client_address||'',
    b.property_id||'',b.property_addr||'',b.assigned_to||'',
    b.status||'draft',
    subtotal,Math.round(subtotal*100),Number(b.discount_pct||0),discAmt,Math.round(discAmt*100),
    Number(b.tax_pct||0),taxAmt,Math.round(taxAmt*100),total,Math.round(total*100),
    Number(b.deposit_pct||30),depAmt,Math.round(depAmt*100),
    JSON.stringify(items),JSON.stringify(b.attachments||[]),
    b.internal_notes||'',b.customer_notes||'',b.terms||'',
    b.estimate_date||'',b.expiry_date||'',
    id,companyId
  ).run()
  await _estApplyExtFields(db, id, companyId, b)
  return c.json({ ok: true, data: { id, subtotal, total } })
})

// POST /api/estimates/:id/send — send the estimate to the customer (real email)
// Body: { to_email?, subject?, message?, method? }
// Composes a fully personalized branded email server-side: client name, estimate
// number, total, and the right portal link (client portal dashboard when the
// client has an active portal login, tokenized estimate page otherwise), then
// marks the estimate as sent. Returns { ok, emailed, fallback?, portal_link }.
app.post('/api/estimates/:id/send', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const estId = c.req.param('id')
  const b: any = await c.req.json().catch(()=>({}))

  // Ensure a portal token exists, then load the estimate
  await db.prepare(`UPDATE estimates SET portal_token = lower(hex(randomblob(16))) WHERE id=? AND company_id=? AND (portal_token IS NULL OR portal_token='')`).bind(estId, companyId).run().catch(() => {})
  const est: any = await db.prepare(`SELECT * FROM estimates WHERE id=? AND company_id=?`).bind(estId, companyId).first()
  if (!est) return c.json({ ok: false, error: 'Estimate not found' }, 404)

  const toEmail = String(b.to_email || est.client_email || '').trim()
  const clientName = String(est.client_name || '').trim()
  const origin = new URL(c.req.url).origin

  // Portal link: if the client has an active portal login, send them to their
  // full portal dashboard (personalized). Otherwise use the tokenized public
  // estimate page which needs no login.
  let portalLink = est.portal_token ? `${origin}/estimates/portal/${est.portal_token}` : ''
  let hasPortalLogin = false
  if (est.client_id) {
    try {
      const pm: any = await db.prepare(`
        SELECT pu.id FROM portal_memberships m
        JOIN portal_users pu ON pu.id = m.portal_user_id
        WHERE m.client_id=? AND m.company_id=? AND m.active=1 AND pu.status='active'
        LIMIT 1`).bind(est.client_id, companyId).first()
      if (pm) { hasPortalLogin = true; portalLink = `${origin}/portal/home#estimates` }
    } catch { /* portal tables may not exist yet — tokenized link is fine */ }
  }

  const co: any = await db.prepare(`SELECT name FROM companies WHERE id=? LIMIT 1`).bind(companyId).first().catch(() => null)
  const coName = (co && co.name) || 'Groundwork CRM'
  const estNum = est.est_number || est.id
  const total = Number(est.total_cents || 0) / 100
  const totalFmt = total ? '$' + total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''

  let emailed = false, fallback = false
  if (toEmail) {
    const subject = String(b.subject || '').trim() || `Your Estimate from ${coName} — ${estNum}`
    const intro = String(b.message || '').trim() ||
      `Hi ${clientName || 'there'},\n\nThank you for the opportunity to work with you! Your estimate${est.title ? ` for ${est.title}` : ''} is ready for review.`
    const bodyText = `${intro}\n\nEstimate: ${estNum}${totalFmt ? `\nTotal: ${totalFmt}` : ''}\n\n` +
      (hasPortalLogin
        ? `You can review, approve, and track everything in your client portal:\n${portalLink}`
        : `You can review and approve your estimate online:\n${portalLink}`) +
      `\n\nIf you have any questions or would like changes, just reply to this email.\n\n${coName}`
    const r = await sendCompanyEmail(c, db, {
      companyId, repId: c.var.repId as string,
      to: toEmail, subject, body: bodyText, entityType: 'estimate',
    })
    emailed = r.sent
    fallback = !!r.fallback
    if (!emailed && !fallback) return c.json({ ok: false, error: 'Email delivery failed' }, 500)
  }

  await db.prepare(`UPDATE estimates SET status='sent', sent_at=datetime('now'), send_method=?, updated_at=datetime('now') WHERE id=? AND company_id=?`)
    .bind(b.method||'email', estId, companyId).run()
  return c.json({ ok: true, emailed, fallback, to: toEmail || null, portal_link: portalLink })
})

// ── Hold → traffic-light helper ─────────────────────────────────────────────
// Jobs scheduled BEFORE the client accepts sit in status 'hold' (yellow).
// When the client accepts, holds flip to 'scheduled' (green). Decline → 'cancelled' (red).
async function _woFlipHolds(db: D1Database, estimateId: string, companyId: string, toStatus: 'scheduled' | 'cancelled') {
  try {
    const holds = await db.prepare(`SELECT id, timeline FROM work_orders WHERE estimate_id=? AND company_id=? AND status='hold'`)
      .bind(estimateId, companyId).all()
    for (const wo of (holds.results || []) as any[]) {
      let tl: any[] = []
      try { tl = JSON.parse(wo.timeline || '[]') } catch {}
      tl.push({ at: new Date().toISOString(), event: toStatus === 'scheduled' ? 'Hold confirmed — client accepted the estimate' : 'Hold released — client declined the estimate' })
      await db.prepare(`UPDATE work_orders SET status=?, timeline=?, updated_at=datetime('now') WHERE id=? AND company_id=?`)
        .bind(toStatus, JSON.stringify(tl), wo.id, companyId).run()
    }
  } catch (e: any) { console.log('woFlipHolds err', String(e?.message || e).slice(0, 120)) }
}

// POST /api/estimates/:id/accept — portal or internal accept
app.post('/api/estimates/:id/accept', requireAuth, async (c) => {
  const db = c.env.DB as D1Database
  const r = await db.prepare(`UPDATE estimates SET status='accepted', accepted_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND company_id=?`)
    .bind(c.req.param('id'), c.var.companyId as string).run()
  if (!r.meta.changes) return c.json({ ok: false, error: 'Not found' }, 404)
  await _woFlipHolds(db, c.req.param('id'), c.var.companyId as string, 'scheduled')
  return c.json({ ok: true })
})

// POST /api/estimates/:id/decline
app.post('/api/estimates/:id/decline', requireAuth, async (c) => {
  const db = c.env.DB as D1Database
  const b: any = await c.req.json().catch(()=>({}))
  const r = await db.prepare(`UPDATE estimates SET status='declined', declined_at=datetime('now'), decline_reason=?, updated_at=datetime('now') WHERE id=? AND company_id=?`)
    .bind(b.reason||'', c.req.param('id'), c.var.companyId as string).run()
  if (!r.meta.changes) return c.json({ ok: false, error: 'Not found' }, 404)
  await _woFlipHolds(db, c.req.param('id'), c.var.companyId as string, 'cancelled')
  return c.json({ ok: true })
})

// POST /api/estimates/:id/changes — request changes
app.post('/api/estimates/:id/changes', requireAuth, async (c) => {
  const db = c.env.DB as D1Database
  const b: any = await c.req.json().catch(()=>({}))
  const r = await db.prepare(`UPDATE estimates SET status='changes_requested', changes_at=datetime('now'), change_request=?, updated_at=datetime('now') WHERE id=? AND company_id=?`)
    .bind(b.message||'', c.req.param('id'), c.var.companyId as string).run()
  if (!r.meta.changes) return c.json({ ok: false, error: 'Not found' }, 404)
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
      status,subtotal,subtotal_cents,discount_pct,discount_amt,discount_amt_cents,
      tax_pct,tax_amt,tax_amt_cents,total,total_cents,
      deposit_pct,deposit_amt,deposit_amt_cents,line_items,attachments,
      internal_notes,customer_notes,terms,portal_token,
      estimate_date,expiry_date,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
  `).bind(
    newId,companyId,`EST-${num}`,
    `Copy of ${row.title||''}`,row.scope_of_work||'',
    row.client_id||'',row.client_name||'',row.client_email||'',row.client_phone||'',row.client_address||'',
    row.property_id||'',row.property_addr||'',row.opp_id||'',
    row.rep_id||'',row.assigned_to||'',
    'draft',
    row.subtotal||0,Math.round((row.subtotal||0)*100),row.discount_pct||0,row.discount_amt||0,Math.round((row.discount_amt||0)*100),
    row.tax_pct||0,row.tax_amt||0,Math.round((row.tax_amt||0)*100),row.total||0,Math.round((row.total||0)*100),
    row.deposit_pct||30,row.deposit_amt||0,Math.round((row.deposit_amt||0)*100),
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

// ══════════════════════════════════════════════════════════════════════════════
// PRICE BOOK — company services & pricing catalog (replaces "Service Data" sheet)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/price-items?category=&q=&all=1
app.get('/api/price-items', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensurePriceBookSchema(db)
  const cat = c.req.query('category') || ''
  const q   = (c.req.query('q') || '').trim()
  const showAll = c.req.query('all') === '1'
  let sql = `SELECT * FROM price_items WHERE company_id=?`
  const binds: any[] = [companyId]
  if (!showAll) sql += ` AND active=1`
  if (cat) { sql += ` AND category=?`; binds.push(cat) }
  if (q)   { sql += ` AND name LIKE ?`; binds.push(`%${q}%`) }
  sql += ` ORDER BY category, sort_order, name LIMIT 3000`
  const rows = await db.prepare(sql).bind(...binds).all()
  // Distinct categories for tab UI
  const cats = await db.prepare(`SELECT DISTINCT category FROM price_items WHERE company_id=? ORDER BY category`).bind(companyId).all()
  return c.json({ ok: true, data: rows.results || [], categories: (cats.results || []).map((r: any) => r.category) })
})

// POST /api/price-items — create one item
app.post('/api/price-items', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensurePriceBookSchema(db)
  const b: any = await c.req.json()
  const name = (b.name || '').trim()
  if (!name) return c.json({ ok: false, error: 'Name required' }, 400)
  const id = 'pi_' + uid()
  const itemUnitCost = Number(b.unit_cost || 0)
  await db.prepare(`
    INSERT INTO price_items (id,company_id,category,name,unit,unit_cost,unit_cost_cents,unit_time,item_type,sku,vendor,notes,active,sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(id, companyId, (b.category || 'General').trim(), name, b.unit || '',
    itemUnitCost, Math.round(itemUnitCost * 100), Number(b.unit_time || 0), b.item_type || 'material',
    b.sku || '', b.vendor || '', b.notes || '', b.active === 0 ? 0 : 1, Number(b.sort_order || 0)).run()
  return c.json({ ok: true, id }, 201)
})

// PUT /api/price-items/:id
app.put('/api/price-items/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensurePriceBookSchema(db)
  const b: any = await c.req.json()
  const fields = ['category','name','unit','unit_cost','unit_time','item_type','sku','vendor','notes','active','sort_order']
  const sets: string[] = []; const binds: any[] = []
  for (const f of fields) {
    if (b[f] !== undefined) {
      sets.push(`${f}=?`); binds.push(['unit_cost','unit_time','active','sort_order'].includes(f) ? Number(b[f]) : b[f])
      if (f === 'unit_cost') { sets.push('unit_cost_cents=?'); binds.push(Math.round(Number(b[f]) * 100)) }
    }
  }
  if (!sets.length) return c.json({ ok: false, error: 'No fields' }, 400)
  sets.push(`updated_at=datetime('now')`)
  binds.push(c.req.param('id'), companyId)
  const r = await db.prepare(`UPDATE price_items SET ${sets.join(',')} WHERE id=? AND company_id=?`).bind(...binds).run()
  if (!r.meta.changes) return c.json({ ok: false, error: 'Not found' }, 404)
  return c.json({ ok: true })
})

// DELETE /api/price-items/:id
app.delete('/api/price-items/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensurePriceBookSchema(db)
  await db.prepare(`DELETE FROM price_items WHERE id=? AND company_id=?`).bind(c.req.param('id'), companyId).run()
  return c.json({ ok: true })
})

// POST /api/price-items/import — bulk import from parsed CSV/Excel rows
// { rows: [{category?,name,unit?,unit_cost?,unit_time?,item_type?}], mode: 'merge'|'replace' }
// merge: upsert by (category,name) — update cost/time if exists, insert if new
// replace: wipe the company's price book (or just the categories present) and insert fresh
app.post('/api/price-items/import', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensurePriceBookSchema(db)
  const b: any = await c.req.json()
  const rows: any[] = Array.isArray(b.rows) ? b.rows : []
  if (!rows.length) return c.json({ ok: false, error: 'No rows' }, 400)
  if (rows.length > 5000) return c.json({ ok: false, error: 'Too many rows (max 5000)' }, 400)
  const mode = b.mode === 'replace' ? 'replace' : 'merge'

  const clean = rows.map((r: any) => ({
    category:  String(r.category || 'General').trim().slice(0, 80) || 'General',
    name:      String(r.name || '').trim().slice(0, 200),
    unit:      String(r.unit || '').trim().slice(0, 80),
    unit_cost: Number(r.unit_cost || 0) || 0,
    unit_time: Number(r.unit_time || 0) || 0,
    item_type: ['material','labor','service','equipment','plant'].includes(r.item_type) ? r.item_type : 'material',
  })).filter((r: any) => r.name)
  if (!clean.length) return c.json({ ok: false, error: 'No valid rows (name required)' }, 400)

  let inserted = 0, updated = 0
  if (mode === 'replace') {
    const cats = [...new Set(clean.map((r: any) => r.category))]
    for (const cat of cats) {
      await db.prepare(`DELETE FROM price_items WHERE company_id=? AND category=?`).bind(companyId, cat).run()
    }
  }
  // Existing (category|name) → id map for merge
  const existing = await db.prepare(`SELECT id, category, name FROM price_items WHERE company_id=?`).bind(companyId).all()
  const byKey = new Map<string, string>()
  for (const r of (existing.results || []) as any[]) byKey.set(`${r.category}|${r.name.toLowerCase()}`, r.id)

  // Batch in chunks of 40 statements
  let batch: any[] = []
  const flush = async () => { if (batch.length) { await db.batch(batch); batch = [] } }
  for (let i = 0; i < clean.length; i++) {
    const r = clean[i]
    const key = `${r.category}|${r.name.toLowerCase()}`
    const exId = mode === 'merge' ? byKey.get(key) : undefined
    const rUnitCostCents = Math.round(Number(r.unit_cost) * 100)
    if (exId) {
      batch.push(db.prepare(`UPDATE price_items SET unit=?, unit_cost=?, unit_cost_cents=?, unit_time=?, item_type=?, updated_at=datetime('now') WHERE id=? AND company_id=?`)
        .bind(r.unit, r.unit_cost, rUnitCostCents, r.unit_time, r.item_type, exId, companyId))
      updated++
    } else {
      const id = 'pi_' + uid() + i.toString(36)
      byKey.set(key, id)
      batch.push(db.prepare(`INSERT INTO price_items (id,company_id,category,name,unit,unit_cost,unit_cost_cents,unit_time,item_type,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, companyId, r.category, r.name, r.unit, r.unit_cost, rUnitCostCents, r.unit_time, r.item_type, i))
      inserted++
    }
    if (batch.length >= 40) await flush()
  }
  await flush()
  return c.json({ ok: true, inserted, updated, total: clean.length })
})

// ── Pricing settings (labor rate, OHR, profit %, tax %, warranty %, non-productive) ──
const PRICING_DEFAULTS = {
  labor_rate: 27.25,          // $/man-hour direct labor cost
  ohr_rate: 35.08,            // $/budgeted-hour overhead recovery
  setup_pay_rate: 35.58,      // owner/estimator setup pay per hour
  setup_hours_default: 0,
  profit_pct: 22,             // target profit on BEP
  tax_pct: 6,                 // sales tax on materials
  warranty_pct: 10,           // warranty reserve on plant material
  nonprod_hours_per_person_day: 1.5,
  crew_size_default: 3,
  workday_hours: 10,
  rev_per_hour_goal: 86.13,   // budgeted revenue per man-hour
  maint_labor_rate: 26.83,    // maintenance division labor rate
  maint_ohr_rate: 22.62,
  maint_profit_pct: 22,
  escalation_pct: 3,          // yearly contract escalation
  contingency_default: 50,
  disposal_default: 35,
  pickup_default: 10,
}
app.get('/api/pricing-settings', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const row: any = await db.prepare(`SELECT value FROM settings WHERE key=? LIMIT 1`).bind(`${companyId}:pricing_settings`).first().catch(() => null)
  let saved = {}
  try { saved = row?.value ? JSON.parse(row.value) : {} } catch {}
  return c.json({ ok: true, data: { ...PRICING_DEFAULTS, ...saved } })
})
app.put('/api/pricing-settings', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role = c.var.role as string
  if (!['admin', 'office_manager'].includes(role)) return c.json({ ok: false, error: 'Admin only' }, 403)
  const db = c.env.DB as D1Database
  const b: any = await c.req.json()
  const merged: any = {}
  for (const k of Object.keys(PRICING_DEFAULTS)) {
    if (b[k] !== undefined && isFinite(Number(b[k]))) merged[k] = Number(b[k])
  }
  await db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
    .bind(`${companyId}:pricing_settings`, JSON.stringify(merged)).run()
  return c.json({ ok: true })
})

// ── Estimate defaults (company-wide) — default Terms & Conditions etc. ──
// Stored in settings under {companyId}:estimate_defaults. New estimates in the
// builder auto-fill from these.
app.get('/api/estimate-defaults', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const row: any = await db.prepare(`SELECT value FROM settings WHERE key=? LIMIT 1`).bind(`${companyId}:estimate_defaults`).first().catch(() => null)
  let saved: any = {}
  try { saved = row?.value ? JSON.parse(row.value) : {} } catch {}
  return c.json({ ok: true, data: { terms: saved.terms || '', customer_notes: saved.customer_notes || '' } })
})
app.put('/api/estimate-defaults', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const role = c.var.role as string
  if (!['admin', 'office_manager'].includes(role)) return c.json({ ok: false, error: 'Admin only' }, 403)
  const db = c.env.DB as D1Database
  const b: any = await c.req.json().catch(() => ({}))
  const merged = {
    terms: typeof b.terms === 'string' ? b.terms.slice(0, 20000) : '',
    customer_notes: typeof b.customer_notes === 'string' ? b.customer_notes.slice(0, 20000) : '',
  }
  await db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
    .bind(`${companyId}:estimate_defaults`, JSON.stringify(merged)).run()
  return c.json({ ok: true })
})

// ── Convert estimate → job (work order + optional schedule) ──
app.post('/api/estimates/:id/convert-to-job', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId = c.var.repId as string
  const db = c.env.DB as D1Database
  await ensurePriceBookSchema(db)
  const est: any = await db.prepare(`SELECT * FROM estimates WHERE id=? AND company_id=?`).bind(c.req.param('id'), companyId).first()
  if (!est) return c.json({ ok: false, error: 'Not found' }, 404)
  if (est.work_order_id) {
    const exists: any = await db.prepare(`SELECT id, wo_number FROM work_orders WHERE id=? AND company_id=?`).bind(est.work_order_id, companyId).first()
    if (exists) return c.json({ ok: false, error: 'already_converted', work_order_id: exists.id, wo_number: exists.wo_number }, 409)
  }
  const b: any = await c.req.json().catch(() => ({}))

  // Materials from line items (and accepted tier if advanced)
  let items: any[] = []
  try { items = JSON.parse(est.line_items || '[]') } catch {}
  if (est.accepted_tier) {
    try {
      const tiers = JSON.parse(est.tiers || '[]')
      const t = tiers.find((x: any) => x.id === est.accepted_tier || x.name === est.accepted_tier)
      if (t && Array.isArray(t.line_items) && t.line_items.length) items = t.line_items
    } catch {}
  }
  const materials = items.map((i: any) => ({ name: i.name || i.desc || '', qty: Number(i.qty || 1), unit: i.unit || '' })).filter((m: any) => m.name)

  // Budgeted hours from the cost engine if present.
  //
  // A recurring estimate never populates cost_data — its numbers live in
  // recurring_data — so this read returned 0 and every recurring job converted
  // with no budget hours at all. See src/recurring/estimate_hours.ts for why the
  // fix is per-visit hours and NOT recurring_data.rollup.yearly_hours, which is
  // a whole year of visits and would be far more wrong than the zero.
  let budgetHours = 0
  try { budgetHours = Number(JSON.parse(est.cost_data || '{}')?.rollup?.budgeted_hours || 0) } catch {}
  if (!budgetHours && est.doc_type === 'recurring') {
    budgetHours = hoursPerVisitFromRecurringData(est.recurring_data) || 0
  }

  // SOLD labor, in minutes, on its own column.
  //
  // budget_minutes had exactly one writer in the entire codebase: migration
  // 0063's one-time backfill. Nothing has written it since, so every job created
  // after that migration ran carries NULL and the Hours card reports "vs sold"
  // as null forever — the card works and the number it exists to show is never
  // there. This is the missing writer.
  //
  // Note what does NOT happen here: budgetHours is no longer pushed into
  // duration_hours as well. 0063's header says it separated these two meanings;
  // it separated the column but not this write, so the same figure kept landing
  // in both. duration_hours is read as CALENDAR duration in five places, so a
  // 72-hour labor budget was blocking 72 hours on the grid — three people on a
  // 4-hour job showed as a 12-hour block. Calendar duration now comes only from
  // what the scheduler is actually told, and is null until someone says.
  const budgetMinutes = budgetHours > 0 ? Math.round(budgetHours * 60) : null
  const calendarHours = Number(b.duration_hours || 0) || null

  const woNumber = await nextWorkOrderNumber(db, companyId)
  const woId = 'wo_' + uid()
  const woAmountEstCents = Number(est.total_cents || 0)
  const woAmountEst = woAmountEstCents / 100
  await db.prepare(`
    INSERT INTO work_orders (id,company_id,wo_number,opp_id,estimate_id,client_name,client_id,property_addr,
      title,type,status,scheduled_date,scheduled_time,duration_hours,budget_minutes,notes,amount_est,amount_est_cents,materials,checklist,timeline,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    woId, companyId, woNumber, est.opp_id || null, est.id,
    est.client_name || '', est.client_id || null, est.property_addr || est.client_address || '',
    est.title || `Job from ${est.est_number}`,
    b.type || (est.doc_type === 'recurring' ? 'Maintenance' : 'Install'),
    // Traffic-light hold: scheduling before the client accepts puts the job on
    // a yellow "hold" — it flips green (scheduled) automatically on acceptance.
    (b.hold === true || (b.hold !== false && est.status !== 'accepted' && est.status !== 'approved' && est.status !== 'invoiced')) ? 'hold' : 'scheduled',
    b.scheduled_date || null, b.scheduled_time || null,
    calendarHours, budgetMinutes,
    (est.scope_of_work || '') + (est.internal_notes ? `\n\n[Internal] ${est.internal_notes}` : ''),
    woAmountEst, woAmountEstCents, JSON.stringify(materials),
    JSON.stringify([]), JSON.stringify([{ at: new Date().toISOString(), event: `Created from estimate ${est.est_number}`, by: repId }]),
    repId
  ).run()

  // Give the new job its primary wo_days row so it appears on the scheduling
  // grid. Migration 0061 backfilled history only; without this, every job
  // created from then on would be invisible in the Week view. No-ops when the
  // job has no date yet — a backlog job gets its row when it is scheduled.
  await ensurePrimaryDay(db, companyId, woId)
  // And staff it, so the day carries planned labor rather than being an empty
  // block on the grid. No-ops until the job has a crew or a named employee list.
  await syncDayEmployees(db, companyId, woId)

  await db.prepare(`UPDATE estimates SET work_order_id=?, updated_at=datetime('now') WHERE id=? AND company_id=?`)
    .bind(woId, est.id, companyId).run()

  const woRow: any = await db.prepare(`SELECT status FROM work_orders WHERE id=? AND company_id=?`).bind(woId, companyId).first()
  return c.json({ ok: true, work_order_id: woId, wo_number: woNumber, status: woRow?.status || 'scheduled', hold: woRow?.status === 'hold' }, 201)
})

// ══════════════════════════════════════════════════════════════════════════════
// PROPOSALS (D1) — high-level, estimate-like documents with template support
// ══════════════════════════════════════════════════════════════════════════════

function _parseProposal(row: any) {
  return {
    ...row,
    sections: JSON.parse(row.sections || '[]'),
    payment_schedule: JSON.parse(row.payment_schedule || '[]'),
  }
}

// GET /api/proposals — list (optional ?opp_id= / ?status= / ?q=)
app.get('/api/proposals', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensureProposalsSchema(db)
  await db.prepare(`UPDATE proposals SET portal_token = lower(hex(randomblob(16))) WHERE company_id=? AND (portal_token IS NULL OR portal_token='')`).bind(companyId).run().catch(() => {})
  const oppId  = c.req.query('opp_id')
  const status = c.req.query('status')
  const search = c.req.query('q')
  let q = `SELECT * FROM proposals WHERE company_id = ?`
  const params: any[] = [companyId]
  if (oppId)  { q += ` AND opp_id = ?`; params.push(oppId) }
  if (status) { q += ` AND status = ?`; params.push(status) }
  if (search) { q += ` AND (client_name LIKE ? OR prop_number LIKE ? OR title LIKE ?)`; const s = `%${search}%`; params.push(s,s,s) }
  q += ` ORDER BY updated_at DESC LIMIT 300`
  const rows = await db.prepare(q).bind(...params).all()
  return c.json({ ok: true, data: (rows.results || []).map(_parseProposal) })
})

// GET /api/proposals/:id
app.get('/api/proposals/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensureProposalsSchema(db)
  const row: any = await db.prepare(`SELECT * FROM proposals WHERE id=? AND company_id=?`)
    .bind(c.req.param('id'), companyId).first()
  if (!row) return c.json({ ok: false, error: 'Not found' }, 404)
  return c.json({ ok: true, data: _parseProposal(row) })
})

// POST /api/proposals — create
app.post('/api/proposals', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId as string
  const db = c.env.DB as D1Database
  await ensureProposalsSchema(db)
  const b: any = await c.req.json()
  const countRow: any = await db.prepare(`SELECT COUNT(*) as n FROM proposals WHERE company_id=?`).bind(companyId).first()
  const num = ((countRow?.n || 0) + 1).toString().padStart(4,'0')
  const propNumber = b.prop_number || `PROP-${num}`
  const id = b.id || ('prop_' + uid())
  const portalToken = uid() + uid()
  // Validate payment schedule sums to 100 when present
  const sched: any[] = Array.isArray(b.payment_schedule) ? b.payment_schedule : []
  const totalPct = sched.reduce((s, p) => s + Number(p.pct || 0), 0)
  if (sched.length && Math.abs(totalPct - 100) > 0.01) {
    return c.json({ ok: false, error: `Payment schedule must total 100% (currently ${totalPct.toFixed(1)}%)` }, 400)
  }
  const propTotal = Number(b.total||0)
  await db.prepare(`
    INSERT INTO proposals (id,company_id,prop_number,title,subtitle,overview,
      client_id,client_name,client_email,client_phone,property_addr,
      opp_id,estimate_id,rep_id,status,sections,payment_schedule,total,total_cents,
      terms,internal_notes,portal_token,proposal_date,valid_through,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
  `).bind(
    id, companyId, propNumber,
    b.title||'', b.subtitle||'', b.overview||'',
    b.client_id||'', b.client_name||'', b.client_email||'', b.client_phone||'', b.property_addr||'',
    b.opp_id||'', b.estimate_id||'', repId,
    b.status||'draft',
    JSON.stringify(b.sections||[]), JSON.stringify(sched),
    propTotal, Math.round(propTotal * 100),
    b.terms||'', b.internal_notes||'', portalToken,
    b.proposal_date || new Date().toISOString().slice(0,10),
    b.valid_through || ''
  ).run()
  return c.json({ ok: true, data: { id, prop_number: propNumber, portal_token: portalToken } }, 201)
})

// PUT /api/proposals/:id — update
app.put('/api/proposals/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensureProposalsSchema(db)
  const b: any = await c.req.json()
  const sched: any[] = Array.isArray(b.payment_schedule) ? b.payment_schedule : []
  const totalPct = sched.reduce((s, p) => s + Number(p.pct || 0), 0)
  if (sched.length && Math.abs(totalPct - 100) > 0.01) {
    return c.json({ ok: false, error: `Payment schedule must total 100% (currently ${totalPct.toFixed(1)}%)` }, 400)
  }
  const updProposalTotal = Number(b.total||0)
  const r = await db.prepare(`
    UPDATE proposals SET
      title=?, subtitle=?, overview=?,
      client_id=?, client_name=?, client_email=?, client_phone=?, property_addr=?,
      opp_id=?, estimate_id=?, status=?, sections=?, payment_schedule=?, total=?, total_cents=?,
      terms=?, internal_notes=?, proposal_date=?, valid_through=?,
      sent_at=CASE WHEN ?='sent' AND (sent_at IS NULL OR sent_at='') THEN datetime('now') ELSE sent_at END,
      updated_at=datetime('now')
    WHERE id=? AND company_id=?
  `).bind(
    b.title||'', b.subtitle||'', b.overview||'',
    b.client_id||'', b.client_name||'', b.client_email||'', b.client_phone||'', b.property_addr||'',
    b.opp_id||'', b.estimate_id||'', b.status||'draft',
    JSON.stringify(b.sections||[]), JSON.stringify(sched), updProposalTotal, Math.round(updProposalTotal * 100),
    b.terms||'', b.internal_notes||'',
    b.proposal_date||'', b.valid_through||'',
    b.status||'draft',
    c.req.param('id'), companyId
  ).run()
  if (!r.meta.changes) return c.json({ ok: false, error: 'Not found' }, 404)
  return c.json({ ok: true })
})

// DELETE /api/proposals/:id
app.delete('/api/proposals/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensureProposalsSchema(db)
  await db.prepare(`DELETE FROM proposals WHERE id=? AND company_id=?`)
    .bind(c.req.param('id'), companyId).run()
  return c.json({ ok: true })
})

// GET /api/proposals/portal/:token — public (no auth) portal JSON
app.get('/api/proposals/portal/:token', async (c) => {
  const db = c.env.DB as D1Database
  await ensureProposalsSchema(db)
  const row: any = await db.prepare(`SELECT * FROM proposals WHERE portal_token=? LIMIT 1`)
    .bind(c.req.param('token')).first()
  if (!row) return c.json({ ok: false, error: 'Not found' }, 404)
  if (!row.viewed_at) {
    await db.prepare(`UPDATE proposals SET viewed_at=datetime('now'), status=CASE WHEN status='sent' THEN 'viewed' ELSE status END, updated_at=datetime('now') WHERE portal_token=?`)
      .bind(c.req.param('token')).run()
  }
  let _brand: any = null
  try {
    _brand = await db.prepare(
      'SELECT name, logo_url, tagline, brand_color, brand_accent, phone, website, address_line1, address_city, address_state, address_zip FROM companies WHERE id = ? LIMIT 1'
    ).bind(row.company_id).first()
  } catch (_) {}
  return c.json({ ok: true, data: { ..._parseProposal(row), _brand } })
})

// POST /api/proposals/portal/:token/respond — client accepts/declines (public)
app.post('/api/proposals/portal/:token/respond', async (c) => {
  const db = c.env.DB as D1Database
  await ensureProposalsSchema(db)
  const b: any = await c.req.json()
  const action = b.action === 'accept' ? 'accept' : b.action === 'decline' ? 'decline' : ''
  if (!action) return c.json({ ok: false, error: 'Invalid action' }, 400)
  const row: any = await db.prepare(`SELECT id, status FROM proposals WHERE portal_token=? LIMIT 1`)
    .bind(c.req.param('token')).first()
  if (!row) return c.json({ ok: false, error: 'Not found' }, 404)
  if (['accepted','declined'].includes(row.status)) return c.json({ ok: false, error: 'Already responded' }, 409)
  if (action === 'accept') {
    await db.prepare(`UPDATE proposals SET status='accepted', accepted_at=datetime('now'), accepted_option=?, updated_at=datetime('now') WHERE id=?`)
      .bind(String(b.option || ''), row.id).run()
    // Proposal acts like an estimate: accepting it also accepts the linked estimate
    const full: any = await db.prepare(`SELECT estimate_id, company_id FROM proposals WHERE id=?`).bind(row.id).first()
    if (full?.estimate_id) {
      await db.prepare(`UPDATE estimates SET status='accepted', accepted_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND company_id=?`)
        .bind(full.estimate_id, full.company_id).run().catch(() => {})
      await _woFlipHolds(db, full.estimate_id, full.company_id, 'scheduled')
    }
  } else {
    await db.prepare(`UPDATE proposals SET status='declined', declined_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
      .bind(row.id).run()
  }
  return c.json({ ok: true })
})

// GET /portal/proposal/:token — public client-facing proposal page
app.get('/portal/proposal/:token', async (c) => {
  const db = c.env.DB as D1Database
  await ensureProposalsSchema(db)
  const row: any = await db.prepare(`SELECT * FROM proposals WHERE portal_token=? LIMIT 1`)
    .bind(c.req.param('token')).first()
  if (!row) return c.html(`<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Link not found</h2><p>This proposal link is invalid or has expired.</p></body></html>`, 404)
  if (!row.viewed_at) {
    await db.prepare(`UPDATE proposals SET viewed_at=datetime('now'), status=CASE WHEN status='sent' THEN 'viewed' ELSE status END, updated_at=datetime('now') WHERE id=?`)
      .bind(row.id).run()
  }
  let brand: any = null
  try {
    brand = await db.prepare('SELECT name, logo_url, tagline, brand_color, phone, website FROM companies WHERE id = ? LIMIT 1').bind(row.company_id).first()
  } catch {}
  const esc = (s: any) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
  const money = (n: number) => '$' + Number(n||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})
  const fmtDate = (d: string) => { try { return new Date(d + 'T12:00:00').toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'}) } catch { return d } }
  let sections: any[] = []
  let sched: any[] = []
  try { sections = JSON.parse(row.sections || '[]') } catch {}
  try { sched = JSON.parse(row.payment_schedule || '[]') } catch {}
  const brandColor = brand?.brand_color || '#113931'
  const companyName = brand?.name || 'Groundwork'
  const isDone = ['accepted','declined'].includes(row.status)
  const optionSections = sections.filter((s:any) => s.type === 'option')

  // Bullet items support a "bold lead-in:" pattern — text before the first
  // colon renders bold (matches the style of formal scope/exclusion lists).
  // Also scrubs literal "Bold lead-in:" prompt leakage in older saved drafts.
  const bulletItem = (raw: string) => {
    const t = String(raw || '').replace(/^\s*bold\s+lead[- ]?in\s*:\s*/i, '')
    const ci = t.indexOf(':')
    if (ci > 0 && ci < 90) return `<strong>${esc(t.slice(0, ci))}:</strong>${esc(t.slice(ci + 1))}`
    return esc(t)
  }

  const sectionHtml = sections.map((s: any, si: number) => {
    if (s.type === 'text' || (!s.type)) {
      return `<div class="pp-section"><h2>${esc(s.title||'')}</h2><p class="pp-body-text">${esc(s.body||'').replace(/\n/g,'<br>')}</p></div>`
    }
    if (s.type === 'bullets') {
      const items = (Array.isArray(s.items) ? s.items : []).filter((it: any) => String(it||'').trim())
      return `<div class="pp-section"><h2>${esc(s.title||'')}</h2>
        ${s.intro ? `<p class="pp-body-text" style="margin-bottom:10px">${esc(s.intro)}</p>` : ''}
        <ul class="pp-bullets">${items.map((it: any) => `<li>${bulletItem(it)}</li>`).join('')}</ul>
      </div>`
    }
    if (s.type === 'option') {
      const rows = Array.isArray(s.rows) ? s.rows : []
      const subtotal = rows.reduce((t: number, r: any) => t + Number(r.price||0), 0)
      return `<div class="pp-section pp-option">
        <h2>${esc(s.title || `Option ${si+1}`)}</h2>
        ${s.goal ? `<p class="pp-goal">${esc(s.goal)}</p>` : ''}
        <table class="pp-table">
          <thead><tr><th>${esc(s.col1 || 'Application')}</th><th>${esc(s.col2 || 'Included Service')}</th><th class="pp-price-col">${esc(s.col3 || 'Price')}</th></tr></thead>
          <tbody>
            ${rows.map((r: any) => `<tr><td>${esc(r.app||'')}</td><td>${esc(r.service||'')}</td><td class="pp-price-col">${r.price !== '' && r.price != null ? money(Number(r.price)) : ''}</td></tr>`).join('')}
          </tbody>
          ${subtotal > 0 ? `<tfoot><tr><td colspan="2"><strong>Option Total</strong></td><td class="pp-price-col"><strong>${money(subtotal)}</strong></td></tr></tfoot>` : ''}
        </table>
        ${s.footnote ? `<p class="pp-footnote">${esc(s.footnote)}</p>` : ''}
        ${!isDone && optionSections.length > 1 ? `<button class="pp-accept-btn" onclick="ppRespond('accept','${esc(s.title || `Option ${si+1}`)}')">Accept ${esc(s.title || `Option ${si+1}`)}</button>` : ''}
      </div>`
    }
    if (s.type === 'table') {
      const cols = Array.isArray(s.columns) && s.columns.length ? s.columns : ['Item','Description']
      const rows = Array.isArray(s.rows) ? s.rows : []
      return `<div class="pp-section">
        <h2>${esc(s.title||'')}</h2>
        <table class="pp-table">
          <thead><tr>${cols.map((cName: any) => `<th>${esc(cName)}</th>`).join('')}</tr></thead>
          <tbody>${rows.map((r: any) => `<tr>${cols.map((_: any, ci: number) => `<td>${esc((r.cells||[])[ci]||'').replace(/\n/g,'<br>')}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>
        ${s.footnote ? `<p class="pp-footnote">${esc(s.footnote)}</p>` : ''}
      </div>`
    }
    if (s.type === 'cards') {
      const cards = (Array.isArray(s.cards) ? s.cards : []).filter((cd: any) => (cd.head||'').trim() || (cd.body||'').trim())
      return `<div class="pp-section">
        <h2>${esc(s.title||'')}</h2>
        ${s.intro ? `<p class="pp-body-text" style="margin-bottom:14px">${esc(s.intro)}</p>` : ''}
        <div class="pp-cards">${cards.map((cd: any) => `
          <div class="pp-card">
            <div class="pp-card-head">${esc(cd.head||'')}</div>
            ${cd.price ? `<div class="pp-card-price">${esc(cd.price)}</div>` : ''}
            ${cd.body ? `<div class="pp-card-body">${esc(cd.body).replace(/\n/g,'<br>')}</div>` : ''}
          </div>`).join('')}
        </div>
      </div>`
    }
    if (s.type === 'fields') {
      const pairs = (Array.isArray(s.pairs) ? s.pairs : []).filter((pv: any) => (pv.k||'').trim() || (pv.v||'').trim())
      return `<div class="pp-section">
        ${s.title ? `<h2>${esc(s.title)}</h2>` : ''}
        <div class="pp-fields">${pairs.map((pv: any) => `
          <div class="pp-field"><div class="k">${esc(pv.k||'')}</div><div class="v">${esc(pv.v||'')}</div></div>`).join('')}
        </div>
      </div>`
    }
    if (s.type === 'price') {
      return `<div class="pp-price-callout">
        ${s.title ? `<div class="pp-price-title">${esc(s.title)}</div>` : ''}
        <div class="pp-price-line">${s.label ? `<span class="pp-price-label">${esc(s.label)}:</span> ` : ''}<span class="pp-price-amount">${esc(s.amount||'')}</span></div>
        ${s.note ? `<div class="pp-price-note">${esc(s.note)}</div>` : ''}
      </div>`
    }
    if (s.type === 'signature') {
      const sigLines = (party: string) => `
        <div class="pp-sig-party">
          <div class="pp-sig-name">${esc(party)}</div>
          <div class="pp-sig-line"><span>Signature</span></div>
          <div class="pp-sig-line"><span>Printed Name</span></div>
          <div class="pp-sig-row"><div class="pp-sig-line" style="flex:1"><span>Title</span></div><div class="pp-sig-line" style="flex:1"><span>Date</span></div></div>
        </div>`
      return `<div class="pp-section">
        <h2>${esc(s.title || 'Acceptance & Authorization')}</h2>
        ${s.body ? `<p class="pp-body-text" style="margin-bottom:18px;font-size:12.5px">${esc(s.body).replace(/\n/g,'<br>')}</p>` : ''}
        <div class="pp-sig-grid" style="grid-template-columns:${s.party2 ? '1fr 1fr' : '1fr'}">
          ${sigLines(s.party1 || 'Client')}
          ${s.party2 ? sigLines(s.party2) : ''}
        </div>
      </div>`
    }
    return ''
  }).join('')

  return c.html(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(row.title || 'Proposal')} — ${esc(companyName)}</title>
<meta name="robots" content="noindex,nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',-apple-system,sans-serif;background:#F5F3EE;color:#1F2A2B;line-height:1.6}
  .pp-hero{background:${brandColor};color:#fff;padding:44px 24px 36px;text-align:center}
  ${brand?.logo_url ? '.pp-logo{height:52px;max-width:280px;object-fit:contain;margin-bottom:14px;background:#fff;padding:9px 16px;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,.12)}' : ''}
  .pp-hero .pp-co{font-size:13px;letter-spacing:.24em;text-transform:uppercase;opacity:.85;font-weight:600}
  .pp-hero h1{font-size:26px;font-weight:800;margin-top:10px;letter-spacing:.02em}
  .pp-hero .pp-sub{font-size:14px;opacity:.8;margin-top:6px}
  .pp-wrap{max-width:760px;margin:0 auto;padding:0 20px 80px}
  .pp-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:#DDD8CE;border:1px solid #DDD8CE;margin:-26px auto 34px;max-width:720px;border-radius:12px;overflow:hidden;box-shadow:0 8px 32px rgba(17,57,49,.12)}
  .pp-meta-cell{background:#fff;padding:16px 18px}
  .pp-meta-cell .k{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#6F7E6A;margin-bottom:4px}
  .pp-meta-cell .v{font-size:14px;font-weight:600;color:#1F2A2B}
  .pp-section{background:#fff;border:1px solid #E4E0D6;border-radius:12px;padding:26px 28px;margin-bottom:20px}
  .pp-section h2{font-size:15px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:${brandColor};border-bottom:2px solid ${brandColor}22;padding-bottom:9px;margin-bottom:14px}
  .pp-body-text{font-size:14px;color:#3D4A46}
  .gw-rt-view p{margin:0 0 8px}.gw-rt-view ul,.gw-rt-view ol{margin:4px 0 10px;padding-left:22px}.gw-rt-view li{margin:2px 0}.gw-rt-view h1,.gw-rt-view h2,.gw-rt-view h3,.gw-rt-view h4{margin:10px 0 6px;line-height:1.3;font-size:1.05em}
  .pp-goal{font-size:13px;color:#5A675F;margin-bottom:14px}
  .pp-table{width:100%;border-collapse:collapse;font-size:13.5px}
  .pp-table th{text-align:left;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#fff;background:${brandColor};padding:9px 12px}
  .pp-table td{padding:10px 12px;border-bottom:1px solid #EDEAE2;color:#37423E;vertical-align:top}
  .pp-table tfoot td{border-top:2px solid ${brandColor}33;border-bottom:none;padding-top:12px}
  .pp-price-col{text-align:right;white-space:nowrap;width:110px}
  .pp-footnote{font-size:12px;color:#77826F;margin-top:10px;font-style:italic}
  .pp-accept-btn{margin-top:16px;background:${brandColor};color:#fff;border:none;border-radius:8px;padding:11px 22px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit}
  .pp-accept-btn:hover{opacity:.9}
  .pp-actions{background:#fff;border:1px solid #E4E0D6;border-radius:12px;padding:26px 28px;text-align:center}
  .pp-actions .pp-accept-btn{margin:6px 8px}
  .pp-decline-btn{background:transparent;color:#8B5A4A;border:1.5px solid #D8BBB0;border-radius:8px;padding:10px 22px;font-size:13px;font-weight:600;cursor:pointer;margin:6px 8px;font-family:inherit}
  .pp-status-banner{border-radius:12px;padding:20px 24px;text-align:center;font-weight:700;font-size:15px;margin-bottom:20px}
  .pp-status-accepted{background:#E5F2E9;color:#1E5E3E;border:1px solid #BFDCC8}
  .pp-status-declined{background:#F7E8E3;color:#8B4432;border:1px solid #E4C4B8}
  .pp-sched-row{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #EDEAE2;font-size:13.5px}
  .pp-sched-row:last-child{border-bottom:none}
  .pp-bullets{padding-left:20px;font-size:14px;color:#3D4A46}
  .pp-bullets li{margin-bottom:8px}
  .pp-bullets li:last-child{margin-bottom:0}
  .pp-bullets b,.pp-bullets strong{color:#1F2A2B}
  .pp-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin-top:4px}
  .pp-card{border:1px solid #E4E0D6;border-radius:10px;padding:16px 18px;background:#FBFAF7}
  .pp-card-head{font-size:13.5px;font-weight:700;color:#1F2A2B;margin-bottom:4px}
  .pp-card-price{font-size:14px;font-weight:800;color:${brandColor};margin-bottom:8px}
  .pp-card-body{font-size:12.5px;color:#5A675F;line-height:1.55}
  .pp-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1px;background:#EDEAE2;border:1px solid #EDEAE2;border-radius:10px;overflow:hidden}
  .pp-field{background:#fff;padding:13px 16px}
  .pp-field .k{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#6F7E6A;margin-bottom:3px}
  .pp-field .v{font-size:13.5px;font-weight:600;color:#1F2A2B}
  .pp-price-callout{background:#fff;border:1px solid #E4E0D6;border-left:4px solid ${brandColor};border-radius:12px;padding:26px 28px;margin-bottom:20px;text-align:center}
  .pp-price-title{font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#6F7E6A;margin-bottom:10px}
  .pp-price-line{display:flex;align-items:baseline;justify-content:center;gap:14px;flex-wrap:wrap}
  .pp-price-label{font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#6F7E6A}
  .pp-price-amount{font-size:30px;font-weight:800;color:${brandColor};letter-spacing:-.01em}
  .pp-price-note{font-size:12.5px;color:#77826F;margin-top:8px;font-style:italic}
  .pp-sig-grid{display:grid;gap:34px;margin-top:22px}
  .pp-sig-party{min-width:0}
  .pp-sig-name{font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#5A675F;margin-bottom:34px}
  .pp-sig-row{display:flex;gap:22px}
  .pp-sig-line{flex:1;border-bottom:1.5px solid #B8B2A4;padding-bottom:4px;margin-bottom:18px;min-height:34px;display:flex;align-items:flex-end}
  .pp-sig-line span{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#8A948C}
  .pp-footer{text-align:center;font-size:12px;color:#8A948C;margin-top:34px}
</style></head>
<body>
  <div class="pp-hero">
    ${brand?.logo_url ? `<img class="pp-logo" src="${esc(brand.logo_url)}" alt="${esc(companyName)}">` : ''}
    <div class="pp-co">${esc(companyName)}${brand?.tagline ? ' — ' + esc(brand.tagline) : ''}</div>
    <h1>${esc(row.title || 'Service Proposal')}</h1>
    ${row.subtitle ? `<div class="pp-sub">${esc(row.subtitle)}</div>` : ''}
  </div>
  <div class="pp-wrap">
    <div class="pp-meta">
      <div class="pp-meta-cell"><div class="k">Prepared For</div><div class="v">${esc(row.client_name)}</div></div>
      <div class="pp-meta-cell"><div class="k">Proposal Date</div><div class="v">${esc(fmtDate(row.proposal_date))}</div></div>
      ${row.property_addr ? `<div class="pp-meta-cell"><div class="k">Property</div><div class="v">${esc(row.property_addr)}</div></div>` : ''}
      ${row.valid_through ? `<div class="pp-meta-cell"><div class="k">Valid Through</div><div class="v">${esc(fmtDate(row.valid_through))}</div></div>` : ''}
    </div>
    <div id="pp-status-slot">
      ${row.status === 'accepted' ? `<div class="pp-status-banner pp-status-accepted">✓ Proposal accepted${row.accepted_option ? ' — ' + esc(row.accepted_option) : ''}. We'll be in touch shortly to schedule.</div>` : ''}
      ${row.status === 'declined' ? `<div class="pp-status-banner pp-status-declined">This proposal was declined.</div>` : ''}
    </div>
    ${row.overview ? `<div class="pp-section"><h2>Overview</h2><p class="pp-body-text">${esc(row.overview).replace(/\n/g,'<br>')}</p></div>` : ''}
    ${sectionHtml}
    ${sched.length ? `<div class="pp-section"><h2>Payment Schedule</h2>${sched.map((p:any) =>
      `<div class="pp-sched-row"><span>${esc(p.label||'Payment')}</span><strong>${Number(p.pct||0)}%${row.total ? ' — ' + money(Number(row.total) * Number(p.pct||0) / 100) : ''}</strong></div>`).join('')}</div>` : ''}
    ${row.terms ? `<div class="pp-section"><h2>Terms</h2><div class="pp-body-text gw-rt-view" style="font-size:12.5px">${richTextHtml(row.terms)}</div></div>` : ''}
    ${!isDone ? `<div class="pp-actions">
      <div style="font-size:14px;font-weight:600;margin-bottom:8px">Ready to move forward?</div>
      ${optionSections.length <= 1 ? `<button class="pp-accept-btn" onclick="ppRespond('accept','')">Accept Proposal</button>` : `<div style="font-size:12.5px;color:#6F7E6A;margin-bottom:4px">Choose an option above, or accept as-is:</div><button class="pp-accept-btn" onclick="ppRespond('accept','')">Accept Proposal</button>`}
      <button class="pp-decline-btn" onclick="ppRespond('decline','')">Decline</button>
    </div>` : ''}
    <div class="pp-footer">${esc(companyName)}${brand?.phone ? ' · ' + esc(brand.phone) : ''}${brand?.website ? ' · ' + esc(brand.website) : ''}</div>
  </div>
  <script>
    async function ppRespond(action, option) {
      if (action === 'decline' && !confirm('Decline this proposal?')) return;
      if (action === 'accept' && !confirm('Accept this proposal' + (option ? ' (' + option + ')' : '') + '?')) return;
      try {
        const r = await fetch('/api/proposals/portal/${esc(row.portal_token)}/respond', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, option })
        });
        const j = await r.json();
        if (!j.ok) { alert(j.error || 'Something went wrong'); return; }
        location.reload();
      } catch (e) { alert('Network error — please try again'); }
    }
  </script>
</body></html>`)
})

// ── Proposal templates ────────────────────────────────────────────────────────

app.get('/api/proposal-templates', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensureProposalsSchema(db)
  const rows = await db.prepare(`SELECT * FROM proposal_templates WHERE company_id=? ORDER BY updated_at DESC`)
    .bind(companyId).all()
  return c.json({ ok: true, data: (rows.results||[]).map((r:any)=>({ ...r, content: JSON.parse(r.content||'{}') })) })
})

app.post('/api/proposal-templates', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId = c.var.repId as string
  const db = c.env.DB as D1Database
  await ensureProposalsSchema(db)
  const b: any = await c.req.json()
  const name = (b.name||'').trim()
  if (!name) return c.json({ ok: false, error: 'Template name required' }, 400)
  const id = b.id || ('ptpl_' + uid())
  await db.prepare(`
    INSERT INTO proposal_templates (id, company_id, name, description, content, created_by, updated_at)
    VALUES (?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
      content=excluded.content, updated_at=datetime('now')
  `).bind(id, companyId, name, b.description||'', JSON.stringify(b.content||{}), repId).run()
  return c.json({ ok: true, data: { id } })
})

app.delete('/api/proposal-templates/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensureProposalsSchema(db)
  await db.prepare(`DELETE FROM proposal_templates WHERE id=? AND company_id=?`)
    .bind(c.req.param('id'), companyId).run()
  return c.json({ ok: true })
})

// ══════════════════════════════════════════════════════════════════════════════
// AI PROPOSAL GENERATION — drafts a full proposal from lead context via an
// OpenAI-compatible endpoint. API key resolution: company setting
// `openai_api_key` (admin pastes in Integrations) → env OPENAI_API_KEY.
// Base URL: company setting `openai_base_url` → env OPENAI_BASE_URL → api.openai.com.
// ══════════════════════════════════════════════════════════════════════════════

// ── AI usage schema (migration 0036) — auto-creates in prod on first AI request ──
let _ai36SchemaOk = false
async function ensureAiSchema(db: D1Database): Promise<void> {
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
async function _aiCreds(db: D1Database, companyId: string, env: any): Promise<{ apiKey: string; baseUrl: string; model: string; keySource: string; aiEnabled: boolean }> {
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
function _aiParseJson(rawIn: string): any {
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
async function _aiChatJson(baseUrl: string, apiKey: string, model: string, messages: any[], schema?: { name: string; schema: any }, tools?: any[]): Promise<any> {
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
async function _logAiUsage(db: D1Database, companyId: string, repId: string, feature: string, model: string, usage: any, keySource: string): Promise<void> {
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
const AI_PLAN_CAPS: Record<string, number> = {
  starter: 50, core: 100, growth: 250, pro: 500, enterprise: 0,
  essentials: 500, plus: 1500, max: 5000,
  unlimited: 0,
}

async function _aiQuota(db: D1Database, companyId: string): Promise<{ plan: string; cap: number; used: number; remaining: number; warn: boolean; blocked: boolean }> {
  await ensureAiSchema(db)
  const rows = await db.prepare(`SELECT key, value FROM settings WHERE key IN (?,?)`)
    .bind(`${companyId}:ai_plan`, `${companyId}:ai_custom_cap`).all()
  let plan = 'starter', customCap = ''
  for (const r of (rows.results as any[])) {
    if (r.key === `${companyId}:ai_plan`) plan = String(r.value || 'starter')
    else if (r.key === `${companyId}:ai_custom_cap`) customCap = String(r.value || '')
  }
  if (!(plan in AI_PLAN_CAPS)) plan = 'starter'
  let cap = AI_PLAN_CAPS[plan]
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
async function _aiQuotaGate(db: D1Database, companyId: string, keySource: string): Promise<{ status: number; body: any } | null> {
  if (keySource !== 'platform') return null
  const q = await _aiQuota(db, companyId)
  if (q.blocked) {
    return { status: 429, body: { ok: false, error: 'quota_exceeded', message: `Your team has used all ${q.cap} AI actions in your ${q.plan} plan this month. Upgrade your AI plan or wait for the monthly reset.`, quota: q } }
  }
  return null
}

// POST /api/ai/generate-proposal — { lead:{...}, notes, instructions, estimate:{...}? }
app.post('/api/ai/generate-proposal', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const { apiKey, baseUrl, model, keySource } = await _aiCreds(db, companyId, c.env)
  if (!apiKey) {
    return c.json({ ok: false, error: 'no_api_key', message: 'AI is not enabled for your company yet. Ask your Groundwork rep to enable it, or add your own OpenAI key under Integrations → Admin Setup.' }, 400)
  }
  const _qg = await _aiQuotaGate(db, companyId, keySource)
  if (_qg) return c.json(_qg.body, _qg.status as any)

  const b: any = await c.req.json().catch(() => ({}))
  const lead = b.lead || {}
  const brand: any = await db.prepare('SELECT name, tagline, phone, website FROM companies WHERE id=? LIMIT 1').bind(companyId).first().catch(() => null)

  const context = [
    `Company: ${brand?.name || 'the company'}${brand?.tagline ? ' — ' + brand.tagline : ''}`,
    `Client name: ${lead.client || 'Unknown'}`,
    lead.address ? `Property address: ${lead.address}` : '',
    lead.project ? `Requested work / project: ${lead.project}` : '',
    lead.serviceLine ? `Service line: ${lead.serviceLine}` : '',
    lead.stage ? `Pipeline stage: ${lead.stage}` : '',
    lead.value ? `Estimated deal value: $${lead.value}` : '',
    b.notes ? `Lead notes and communication history:\n${String(b.notes).slice(0, 6000)}` : '',
    b.estimate ? `Existing linked estimate (use these services/prices as the basis for one option):\n${JSON.stringify(b.estimate).slice(0, 3000)}` : '',
    b.instructions ? `Rep's specific instructions for this proposal:\n${String(b.instructions).slice(0, 2000)}` : '',
  ].filter(Boolean).join('\n')

  const sys = `You are an expert proposal writer for a professional services business. You write warm, confident, client-facing proposals that close deals — specific, benefit-oriented, never generic filler. Adapt tone and structure to the company's industry and the type of document the rep asks for (a priced quote, a formal bid, an options menu, or a preliminary planning framework with investment ranges).

Return ONLY valid JSON (no markdown fences, no commentary) matching exactly this schema:
{
  "title": "string — proposal title",
  "subtitle": "string — one warm personalized line, e.g. 'Prepared exclusively for the Smith Residence'",
  "overview": "string — 2-3 short paragraphs: thank them, what you understood about their goals, what you recommend and why. Use \\n\\n between paragraphs.",
  "sections": [ /* ordered array of content blocks; each block is one of the 8 shapes below */ ],
  "payment_schedule": [ { "label": "string", "pct": 0 } ],
  "terms": "string — brief professional terms (validity, dependencies, payment)"
}

Available section block shapes (choose the right ones for this document):
1. { "type": "text", "title": "string", "body": "paragraphs, \\n between them" } — narrative sections (project understanding, approach, why us).
2. { "type": "bullets", "title": "string", "intro": "optional lead-in sentence or ''", "items": ["string"] } — scope lists, inclusions/exclusions, assumptions. Items may follow the pattern "Short label: details" — anything before the first colon renders bold (e.g. "Site assessment: full visual review of drainage, grading and settlement"). The label must be real content words; NEVER write placeholder text like "Bold lead-in" in an item.
3. { "type": "option", "title": "OPTION 1: <name>", "goal": "one-line goal", "col1": "first column header e.g. 'Visit'", "col2": "second header e.g. 'Included Services'", "col3": "price header e.g. 'Price'", "rows": [ { "app": "row label", "service": "what's included, specific", "price": 0 } ], "footnote": "fine print or ''" } — a priced, acceptable package. Every row needs a numeric price; the client can accept an option on the portal.
4. { "type": "table", "title": "string", "columns": ["string"], "rows": [ { "cells": ["string"] } ], "footnote": "''" } — free-form data table (no math), e.g. project areas with preliminary investment ranges, schedules, spec matrices. Each row's cells array must match columns length.
5. { "type": "cards", "title": "string", "intro": "''", "cards": [ { "head": "card name", "price": "free text e.g. '$4,500–$6,500'", "body": "short description" } ] } — an options menu with price ranges (planning frameworks, add-on menus).
6. { "type": "fields", "title": "string", "pairs": [ { "k": "label", "v": "value" } ] } — formal metadata grid (Proposal #, Project Location, Bid Due, Design Stage…). Use for formal/government-style bids.
7. { "type": "price", "title": "string or ''", "label": "e.g. 'Total Investment'", "amount": "free text — '$15,000' or '$28,000–$41,500'", "note": "optional qualifier or ''" } — big price callout for single-price or range-based documents.
8. { "type": "signature", "title": "Acceptance & Authorization", "body": "one-line acceptance statement", "party1": "Client", "party2": "company name or '' for single-party" } — signature lines. Include for formal proposals.

Rules:
- Pick block types that fit the document: a standard quote = option blocks; a formal bid = fields + text + bullets + option/price + signature; a planning framework = text + table/cards with ranges + price callout; an options menu = cards.
- Default (no contrary instructions): 2 option blocks (a standard and a premium tier).
- If a linked estimate is provided, its line items and prices MUST form the basis of one option (keep its prices); another option can be an upsell tier.
- Prices must be realistic for the industry and consistent with any deal value or estimate given.
- payment_schedule percentages MUST sum to exactly 100. Use [] if a simple pay-on-completion makes more sense.
- Never invent client personal details not provided. Keep the overview grounded in the actual notes.`

  try {
    const r = await _aiChatJson(baseUrl, apiKey, model, [
      { role: 'system', content: sys },
      { role: 'user', content: `Draft the proposal from this lead context:\n\n${context}` },
    ])
    if (!r.ok) {
      const errText = await r.text().catch(() => '')
      console.error('[ai/generate-proposal] upstream', r.status, errText.slice(0, 300))
      return c.json({ ok: false, error: 'ai_upstream', message: `AI service error (${r.status}). Check the API key/model in Admin Setup.` }, 502)
    }
    const j: any = await r.json()
    await _logAiUsage(db, companyId, c.var.repId as string, 'proposal', model, j?.usage, keySource)
    const raw = j?.choices?.[0]?.message?.content || ''
    // Fence-tolerant + truncation-tolerant parse (salvages partial drafts)
    const draft = _aiParseJson(raw)

    // Sanitize to the exact shapes the builder expects (8 block types)
    const S = (v: any) => String(v ?? '')
    const sections = (Array.isArray(draft.sections) ? draft.sections : []).map((s: any) => {
      const t = s?.type
      if (t === 'text') return { type: 'text', title: S(s.title), body: S(s.body) }
      if (t === 'bullets') return { type: 'bullets', title: S(s.title), intro: S(s.intro),
        // Strip literal schema-instruction leakage ("Bold lead-in: ...") some
        // models echo from the prompt's formatting example.
        items: (Array.isArray(s.items) ? s.items : []).map((it: any) => S(it).replace(/^\s*bold\s+lead[- ]?in\s*:\s*/i, '')).filter(Boolean) }
      if (t === 'table') {
        const columns = (Array.isArray(s.columns) ? s.columns : []).map((cn: any) => S(cn))
        const cols = columns.length ? columns : ['Item', 'Description']
        return { type: 'table', title: S(s.title), columns: cols,
          rows: (Array.isArray(s.rows) ? s.rows : []).map((row: any) => {
            const cells = (Array.isArray(row?.cells) ? row.cells : []).map((cell: any) => S(cell))
            while (cells.length < cols.length) cells.push('')
            return { cells: cells.slice(0, cols.length) }
          }), footnote: S(s.footnote) }
      }
      if (t === 'cards') return { type: 'cards', title: S(s.title), intro: S(s.intro),
        cards: (Array.isArray(s.cards) ? s.cards : []).map((cd: any) => ({ head: S(cd?.head), price: S(cd?.price), body: S(cd?.body) })) }
      if (t === 'fields') return { type: 'fields', title: S(s.title),
        pairs: (Array.isArray(s.pairs) ? s.pairs : []).map((p: any) => ({ k: S(p?.k), v: S(p?.v) })) }
      if (t === 'price') return { type: 'price', title: S(s.title), label: S(s.label || 'Total Investment'), amount: S(s.amount), note: S(s.note) }
      if (t === 'signature') return { type: 'signature', title: S(s.title || 'Acceptance & Authorization'), body: S(s.body), party1: S(s.party1 || 'Client'), party2: S(s.party2) }
      // default / 'option'
      return { type: 'option', title: S(s?.title || 'OPTION'), goal: S(s?.goal),
        col1: S(s?.col1), col2: S(s?.col2), col3: S(s?.col3),
        rows: (Array.isArray(s?.rows) ? s.rows : []).map((row: any) => ({
          app: S(row?.app), service: S(row?.service), price: Number(row?.price) || 0 })),
        footnote: S(s?.footnote) }
    })
    let sched = Array.isArray(draft.payment_schedule) ? draft.payment_schedule
      .map((p: any) => ({ label: String(p?.label || 'Payment'), pct: Number(p?.pct) || 0 }))
      .filter((p: any) => p.pct > 0) : []
    const sum = sched.reduce((s: number, p: any) => s + p.pct, 0)
    if (sched.length && Math.abs(sum - 100) > 0.01) {
      // Normalize to 100 rather than reject the whole draft
      sched = sched.map((p: any, i: number) => ({ ...p, pct: Math.round((p.pct / sum) * 1000) / 10 }))
      const fix = 100 - sched.reduce((s: number, p: any) => s + p.pct, 0)
      sched[sched.length - 1].pct = Math.round((sched[sched.length - 1].pct + fix) * 10) / 10
    }

    return c.json({ ok: true, data: {
      title: String(draft.title || ''),
      subtitle: String(draft.subtitle || ''),
      overview: String(draft.overview || ''),
      sections, payment_schedule: sched,
      terms: String(draft.terms || ''),
    }})
  } catch (e: any) {
    console.error('[ai/generate-proposal]', e?.message || e)
    return c.json({ ok: false, error: 'ai_parse', message: 'The AI returned an unusable draft — please try again.' }, 502)
  }
})

// POST /api/ai/draft-followup — AI Phase 1: meeting transcript → follow-up email.
// { opp_id, transcript, instructions?, task_id? }
// Pulls full lead context (profile + recent communications + company brand) so the
// rep never has to re-explain the deal. Returns { subject, body_html }.
app.post('/api/ai/draft-followup', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const { apiKey, baseUrl, model, keySource } = await _aiCreds(db, companyId, c.env)
  if (!apiKey) {
    return c.json({ ok: false, error: 'no_api_key', message: 'AI is not enabled for your company yet. Ask your Groundwork rep to enable it, or add your own OpenAI key under Integrations → Admin Setup.' }, 400)
  }
  const _qg = await _aiQuotaGate(db, companyId, keySource)
  if (_qg) return c.json(_qg.body, _qg.status as any)
  const b: any = await c.req.json().catch(() => ({}))
  const transcript = String(b.transcript || '').trim()
  if (!transcript) return err(c, 'transcript required')

  // ── Lead context ──
  let opp: any = null, comms = ''
  if (b.opp_id) {
    opp = await db.prepare('SELECT * FROM opportunities WHERE id=? AND company_id=? LIMIT 1').bind(b.opp_id, companyId).first().catch(() => null)
    if (opp) {
      const rows = await db.prepare(
        "SELECT type, direction, subject, body, ts FROM communications WHERE opp_id=? AND company_id=? ORDER BY ts DESC LIMIT 8"
      ).bind(b.opp_id, companyId).all().catch(() => ({ results: [] as any[] }))
      comms = ((rows.results || []) as any[]).reverse().map((r: any) =>
        `[${String(r.ts).slice(0, 10)} ${r.direction === 'out' ? 'us→client' : 'client→us'} ${r.type}] ${r.subject ? r.subject + ' — ' : ''}${String(r.body || '').slice(0, 400)}`
      ).join('\n')
    }
  }
  const brand: any = await db.prepare('SELECT name, tagline, phone, website FROM companies WHERE id=? LIMIT 1').bind(companyId).first().catch(() => null)
  const rep: any = await db.prepare('SELECT name, title, email FROM reps WHERE id=? LIMIT 1').bind(c.var.repId as string).first().catch(() => null)

  const context = [
    `Our company: ${brand?.name || 'the company'}${brand?.tagline ? ' — ' + brand.tagline : ''}${brand?.phone ? ' · ' + brand.phone : ''}${brand?.website ? ' · ' + brand.website : ''}`,
    rep ? `Sender (the rep writing this email): ${rep.name}${rep.title ? ', ' + rep.title : ''}` : '',
    opp ? `Client: ${opp.client || 'Unknown'}${opp.email ? ' <' + opp.email + '>' : ''}` : '',
    opp?.address ? `Property address: ${opp.address}` : '',
    opp?.project ? `Project: ${opp.project}` : '',
    opp?.stage ? `Pipeline stage: ${opp.stage}` : '',
    opp?.value ? `Estimated deal value: $${opp.value}` : '',
    comms ? `Recent communication history (oldest first):\n${comms.slice(0, 4000)}` : '',
    `Meeting transcript / rep's meeting notes:\n${transcript.slice(0, 12000)}`,
    b.instructions ? `Rep's specific instructions for this email:\n${String(b.instructions).slice(0, 1000)}` : '',
  ].filter(Boolean).join('\n\n')

  const sys = `You are an expert client-relations writer for a professional services business. Draft the post-meeting follow-up email the rep will send to the client.

Rules:
- Ground EVERYTHING in the transcript and context. Never invent commitments, prices, or dates that weren't discussed.
- Warm, confident, concise. Sound like a real person, not a template. No corporate filler.
- Structure: quick thanks referencing something specific from the meeting → clear recap of what was discussed/decided → concrete next steps (who does what, by when) → easy closing question or CTA.
- Keep it scannable: short paragraphs; use a short bullet list for next steps if there are 2+.
- Sign off with the rep's first name only (no full signature block — their Gmail signature is appended automatically).
- Write in the same language the transcript is in.

Return ONLY valid JSON (no markdown fences): { "subject": "string — specific, references the project/meeting", "body_html": "string — email body as simple HTML using <p>, <ul>, <li>, <strong> only" }`

  try {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: context },
        ],
      }),
    })
    if (!r.ok) {
      const errText = await r.text().catch(() => '')
      console.error('[ai/draft-followup] upstream', r.status, errText.slice(0, 300))
      return c.json({ ok: false, error: 'ai_upstream', message: `AI service error (${r.status}).` }, 502)
    }
    const j: any = await r.json()
    await _logAiUsage(db, companyId, c.var.repId as string, 'followup_email', model, j?.usage, keySource)
    let raw = (j?.choices?.[0]?.message?.content || '').trim()
      .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
    const start = raw.indexOf('{'); const end = raw.lastIndexOf('}')
    if (start === -1 || end === -1) throw new Error('No JSON in AI response')
    const draft = JSON.parse(raw.slice(start, end + 1))
    return json(c, {
      subject: String(draft.subject || 'Following up on our meeting'),
      body_html: String(draft.body_html || ''),
      to_email: opp?.email || '',
      client: opp?.client || '',
      model: j?.model || model,
      tokens: j?.usage?.total_tokens || 0,
    })
  } catch (e: any) {
    console.error('[ai/draft-followup]', e?.message || e)
    return c.json({ ok: false, error: 'ai_error', message: String(e?.message || e).slice(0, 200) }, 500)
  }
})

// POST /api/ai/parse-lead — AI Lead Import.
// Paste raw email text (or a dropped .eml file's contents) and get back a
// structured lead: contact info + EVERY property address mentioned (commercial
// property managers often send one email covering multiple sites to bid).
// { email_text }
app.post('/api/ai/parse-lead', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const { apiKey, baseUrl, model, keySource } = await _aiCreds(db, companyId, c.env)
  if (!apiKey) {
    return c.json({ ok: false, error: 'no_api_key', message: 'AI is not enabled for your company yet. Ask your Groundwork rep to enable it, or add your own OpenAI key under Integrations → Admin Setup.' }, 400)
  }
  const _qg = await _aiQuotaGate(db, companyId, keySource)
  if (_qg) return c.json(_qg.body, _qg.status as any)
  const b: any = await c.req.json().catch(() => ({}))
  const emailText = String(b.email_text || '').trim()
  if (!emailText) return err(c, 'email_text required')

  const sys = `You are a CRM intake assistant for a landscaping / commercial grounds maintenance company. The user pastes a raw email (possibly with headers, signatures, forwarded chains). Extract the NEW LEAD it describes.

Critical rules:
- Extract EVERY distinct property/site address mentioned as work to bid or service. Commercial property managers often list several properties in one email — capture each one separately with its own site-specific notes (e.g. "no mowing needed", "meet here first", exclusions).
- The CONTACT is the prospective client (the person/company asking for the work), never the recipient or the sender's own company if the email was forwarded by a company employee.
- Pull phone numbers from signature blocks (prefer cell/direct lines). Pull the company name from the signature or domain.
- client_type is "Commercial" when the sender represents a business/property-management firm or the properties are commercial sites; otherwise "Residential".
- contract_hint: "annual", "multi_year", "one_time", or "unknown" — based on any mention of annual contracts, seasons, multi-year terms.
- Do NOT invent data. Use "" for anything not present.

Return ONLY valid JSON:
{
  "contact": { "name": "person's full name", "company": "their company", "phone": "", "email": "" },
  "client_type": "Commercial" | "Residential",
  "properties": [ { "label": "short site name e.g. Yorktowne Shopping Center", "address": "full street address", "notes": "site-specific instructions/exclusions" } ],
  "project": "one-line summary of the requested work/scope",
  "urgency": "any timing/meeting requests mentioned, e.g. 'Meet Tue Aug 4, 9am at Yorktowne'",
  "contract_hint": "annual" | "multi_year" | "one_time" | "unknown",
  "summary_note": "2-4 sentence plain-text summary of the email: who, what they want, key dates, site specifics"
}`

  try {
    const r = await _aiChatJson(baseUrl, apiKey, model, [
      { role: 'system', content: sys },
      { role: 'user', content: emailText.slice(0, 16000) },
    ])
    if (!r.ok) {
      const errText = await r.text().catch(() => '')
      console.error('[ai/parse-lead] upstream', r.status, errText.slice(0, 300))
      return c.json({ ok: false, error: 'ai_upstream', message: `AI service error (${r.status}).` }, 502)
    }
    const j: any = await r.json()
    await _logAiUsage(db, companyId, c.var.repId as string, 'lead_import', model, j?.usage, keySource)
    const raw = (j?.choices?.[0]?.message?.content || '').trim()
    const draft: any = _aiParseJson(raw)
    const props = Array.isArray(draft.properties) ? draft.properties : []
    return json(c, {
      contact: {
        name: String(draft?.contact?.name || ''),
        company: String(draft?.contact?.company || ''),
        phone: String(draft?.contact?.phone || ''),
        email: String(draft?.contact?.email || ''),
      },
      client_type: draft?.client_type === 'Residential' ? 'Residential' : 'Commercial',
      properties: props.slice(0, 25).map((p: any) => ({
        label: String(p?.label || ''), address: String(p?.address || ''), notes: String(p?.notes || ''),
      })),
      project: String(draft?.project || ''),
      urgency: String(draft?.urgency || ''),
      contract_hint: String(draft?.contract_hint || 'unknown'),
      summary_note: String(draft?.summary_note || ''),
      model: j?.model || model,
      tokens: j?.usage?.total_tokens || 0,
    })
  } catch (e: any) {
    console.error('[ai/parse-lead]', e?.message || e)
    return c.json({ ok: false, error: 'ai_error', message: String(e?.message || e).slice(0, 200) }, 500)
  }
})

// POST /api/ai/generate-quote — the AI Quote Generator.
// Inputs: lead conversation history + the company's OWN price book + brand +
// (optional) live market-rate search. Output: a tiered quote whose line items
// reference real price_items (AI never invents unit prices for known items),
// priced through the company's job-cost settings, plus a ready-to-send email.
// { opp_id?, notes?, instructions?, tier_count?, market_check? }
app.post('/api/ai/generate-quote', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensurePriceBookSchema(db)
  const { apiKey, baseUrl, model, keySource } = await _aiCreds(db, companyId, c.env)
  if (!apiKey) {
    return c.json({ ok: false, error: 'no_api_key', message: 'AI is not enabled for your company yet. Ask your Groundwork rep to enable it, or add your own OpenAI key under Integrations → Admin Setup.' }, 400)
  }
  const _qg = await _aiQuotaGate(db, companyId, keySource)
  if (_qg) return c.json(_qg.body, _qg.status as any)
  const b: any = await c.req.json().catch(() => ({}))

  // 1. Lead + conversation context
  let lead: any = null
  let comms = ''
  if (b.opp_id) {
    lead = await db.prepare(`SELECT * FROM opportunities WHERE id=? AND company_id=? LIMIT 1`).bind(b.opp_id, companyId).first().catch(() => null)
    if (lead) {
      // Pull the lead's actual conversation history (calls, emails, texts, notes)
      const cr = await db.prepare(`SELECT type, direction, subject, body, ts FROM communications WHERE opp_id=? AND company_id=? ORDER BY ts DESC LIMIT 40`)
        .bind(b.opp_id, companyId).all().catch(() => ({ results: [] }))
      const list = ((cr.results || []) as any[]).reverse()
      comms = list.map((n: any) =>
        `[${String(n.ts || '').slice(0, 10)} ${n.type || 'note'}${n.direction ? '/' + n.direction : ''}]${n.subject ? ' ' + n.subject + ' —' : ''} ${String(n.body || '').slice(0, 500)}`).join('\n')
      // Lead intake fields are context too
      const intake = [lead.prompt, lead.desired_outcome, lead.project].filter(Boolean).join(' | ')
      if (intake) comms = `[Lead intake] ${intake}\n` + comms
    }
  }
  if (b.notes) comms = (comms ? comms + '\n' : '') + String(b.notes).slice(0, 6000)

  // 2. The company's price book (compact catalog for the model)
  const pbRows = await db.prepare(`SELECT id, category, name, unit, unit_cost_cents, unit_time FROM price_items WHERE company_id=? AND active=1 ORDER BY category, name LIMIT 1200`).bind(companyId).all()
  const priceBook = (pbRows.results || []) as any[]
  const pbCompact = priceBook.map((p: any) => `${p.id}|${p.category}|${p.name}|${p.unit || ''}|$${(Number(p.unit_cost_cents || 0) / 100)}|${p.unit_time}h`).join('\n')

  // 3. Pricing settings (job cost engine parameters)
  const psRow: any = await db.prepare(`SELECT value FROM settings WHERE key=? LIMIT 1`).bind(`${companyId}:pricing_settings`).first().catch(() => null)
  let ps: any = {}
  try { ps = psRow?.value ? JSON.parse(psRow.value) : {} } catch {}
  ps = { ...PRICING_DEFAULTS, ...ps }

  // 4. Brand
  const brand: any = await db.prepare('SELECT name, tagline, phone, website FROM companies WHERE id=? LIMIT 1').bind(companyId).first().catch(() => null)

  const context = [
    `Company: ${brand?.name || 'the company'}${brand?.tagline ? ' — ' + brand.tagline : ''}`,
    lead ? `Client: ${lead.client || ''} | Address: ${lead.address || ''} | Project: ${lead.project || lead.service_line || ''} | Stage: ${lead.pipeline_stage || lead.status || ''}${lead.job_value_cents ? ' | Est. value: $' + (Number(lead.job_value_cents) / 100) : ''}` : '',
    comms ? `CONVERSATION HISTORY (what the client asked for — extract scope and quantities from this):\n${comms}` : '',
    b.instructions ? `Rep's instructions: ${String(b.instructions).slice(0, 2000)}` : '',
    `\nJOB COST PARAMETERS (for pricing sanity — sell price must recover these):`,
    `Labor $${ps.labor_rate}/hr + Overhead $${ps.ohr_rate}/budgeted-hr, target profit ${ps.profit_pct}%, materials tax ${ps.tax_pct}%, plant warranty ${ps.warranty_pct}%, revenue/man-hour goal $${ps.rev_per_hour_goal}`,
    pbCompact ? `\nPRICE BOOK (id|category|name|unit|unit_cost|unit_time) — line items for known services/materials MUST use these ids and costs:\n${pbCompact.slice(0, 60000)}` : '\n(No price book yet — estimate reasonable market prices and mark every line "custom":true.)',
  ].filter(Boolean).join('\n')

  const tierCount = Math.min(3, Math.max(1, Number(b.tier_count || 3)))
  const sys = `You are an expert estimator for a service business. Read what the client asked for in the conversation, match it against the company's price book, and build a ${tierCount}-tier quote (${tierCount === 3 ? 'Good / Better / Best' : tierCount === 2 ? 'Standard / Premium' : 'single option'}).

PRICING METHOD (the company's own formula):
- For each line: total_cost = qty × unit_cost (from price book), total_time = qty × unit_time.
- Job direct expense = materials(+${ps.tax_pct}% tax; plants also +${ps.warranty_pct}% warranty) + labor(total man-hours × $${ps.labor_rate}).
- Overhead = total man-hours × $${ps.ohr_rate}. Break-even = direct + overhead. Sell price ≈ break-even × ${(1 + ps.profit_pct / 100).toFixed(2)}.
- Set each tier's "client_price" near that sell price (round to a clean number). Sanity-check: client_price / total man-hours should be ≥ $${ps.rev_per_hour_goal}.

Return ONLY valid JSON:
{
 "title": "quote title",
 "scope_summary": "2-3 sentence plain-language summary of what the client asked for",
 "tiers": [
   { "id": "tier1", "name": "string e.g. 'Essential'", "desc": "1-2 sentences on what this tier delivers and who it's for",
     "line_items": [ { "price_item_id": "pi_xxx or ''", "custom": false, "name": "string", "qty": 0, "unit": "string", "unit_cost": 0, "unit_time": 0, "rate": 0, "note": "" } ],
     "man_hours": 0, "direct_cost": 0, "client_price": 0, "recommended": false }
 ],
 "email": { "subject": "string", "body": "ready-to-send email presenting the tiers, warm and specific, with prices; \\n between paragraphs. Do NOT include a link — the CRM appends the client portal link." },
 "sms": "string — a 2-3 sentence text-message version with tier prices",
 "pricing_notes": "internal: how you derived the numbers, which price book items you matched, assumptions on quantities, anything the rep should verify"
}
Rules:
- "rate" is the per-unit CLIENT price for that line (line client subtotal = qty × rate); the sum over lines should equal client_price for the tier.
- Use price_item_id + real unit_cost/unit_time from the price book whenever the item exists there. Only set custom:true for items truly absent.
- Quantities must come from the conversation (sq ft, yards, counts). If unknown, make a clearly-stated assumption in pricing_notes and choose sensible defaults.
- Tiers must be meaningfully different (scope, materials grade, or extras) — not just the same list at 3 prices. Mark exactly one tier recommended:true${tierCount === 1 ? ' (the only one)' : ''}.
- Never quote below break-even.`

  // 5. Optional market-rate cross-reference — a second lightweight model pass
  //    (uses the model's knowledge; flagged clearly as an estimate, not live data)
  let marketNote = ''
  if (b.market_check) {
    marketNote = `\nAfter pricing, add to pricing_notes a short "MARKET CHECK" paragraph: typical current market price ranges for the main services in this quote for the client's region, and whether this quote sits low / mid / high in that range.`
  }

  try {
    const r = await _aiChatJson(baseUrl, apiKey, model, [
      { role: 'system', content: sys + marketNote },
      { role: 'user', content: `Build the tiered quote from this context:\n\n${context}` },
    ])
    if (!r.ok) {
      const errText = await r.text().catch(() => '')
      console.error('[ai/generate-quote] upstream', r.status, errText.slice(0, 300))
      return c.json({ ok: false, error: 'ai_upstream', message: `AI service error (${r.status}). Check the API key/model in Admin Setup.` }, 502)
    }
    const j: any = await r.json()
    await _logAiUsage(db, companyId, c.var.repId as string, 'quote', model, j?.usage, keySource)
    const raw = j?.choices?.[0]?.message?.content || ''
    // Fence-tolerant + truncation-tolerant parse (salvages partial drafts)
    const draft = _aiParseJson(raw)

    // Sanitize + re-verify price book references (AI must not drift stored costs)
    const pbById = new Map(priceBook.map((p: any) => [p.id, p]))
    const S = (v: any) => String(v ?? '')
    const N = (v: any) => (isFinite(Number(v)) ? Number(v) : 0)
    const tiers = (Array.isArray(draft.tiers) ? draft.tiers : []).slice(0, 3).map((t: any, ti: number) => {
      const lines = (Array.isArray(t.line_items) ? t.line_items : []).slice(0, 60).map((li: any) => {
        const pb: any = li.price_item_id ? pbById.get(li.price_item_id) : null
        return {
          id: 'li_' + uid(),
          price_item_id: pb ? li.price_item_id : '',
          custom: !pb,
          name: S(li.name || (pb && pb.name)).slice(0, 200),
          qty: N(li.qty) || 1,
          unit: S(li.unit || (pb && pb.unit)).slice(0, 60),
          unit_cost: pb ? (Number(pb.unit_cost_cents || 0) / 100) : N(li.unit_cost),
          unit_time: pb ? N(pb.unit_time) : N(li.unit_time),
          rate: N(li.rate),
          note: S(li.note).slice(0, 300),
        }
      }).filter((li: any) => li.name)
      const clientPrice = N(t.client_price) || lines.reduce((s: number, li: any) => s + li.qty * li.rate, 0)
      return {
        id: t.id || `tier${ti + 1}`,
        name: S(t.name || `Option ${ti + 1}`).slice(0, 80),
        desc: S(t.desc).slice(0, 500),
        line_items: lines,
        man_hours: N(t.man_hours) || lines.reduce((s: number, li: any) => s + li.qty * li.unit_time, 0),
        direct_cost: N(t.direct_cost),
        total: clientPrice,
        recommended: !!t.recommended,
      }
    })
    if (!tiers.length) throw new Error('No tiers in AI response')
    if (!tiers.some((t: any) => t.recommended)) tiers[Math.min(1, tiers.length - 1)].recommended = true

    return c.json({ ok: true, data: {
      title: S(draft.title || 'Custom Quote'),
      scope_summary: S(draft.scope_summary),
      tiers,
      email: { subject: S(draft.email?.subject), body: S(draft.email?.body) },
      sms: S(draft.sms),
      pricing_notes: S(draft.pricing_notes),
      ai_meta: { model, generated_at: new Date().toISOString(), used_price_book: priceBook.length > 0, market_check: !!b.market_check, opp_id: b.opp_id || '' },
    }})
  } catch (e: any) {
    console.error('[ai/generate-quote]', e?.message || e)
    return c.json({ ok: false, error: 'ai_parse', message: 'The AI returned an unusable draft — please try again.' }, 502)
  }
})

// ══════════════════════════════════════════════════════════════════════════════
// GOOGLE AUTH — persistent per-rep connection via authorization-code + refresh
// The client secret lives in company settings (admin pastes it once alongside
// the Client ID). Refresh tokens are stored server-side in google_tokens so the
// connection survives logins and browser changes — until manual disconnect.
// ══════════════════════════════════════════════════════════════════════════════

async function _googleClientCreds(db: D1Database, companyId: string, env?: Bindings): Promise<{ clientId: string; clientSecret: string; source: string }> {
  const rows = await db.prepare(
    `SELECT key, value FROM settings WHERE key IN (?,?,?,?)`
  ).bind(
    `${companyId}:google_client_id`, `${companyId}:google_client_secret`,
    'google_client_id', 'google_client_secret'
  ).all()
  let clientId = '', clientSecret = ''
  for (const r of (rows.results as any[])) {
    const k = r.key.includes(':') ? r.key.split(':').pop() : r.key
    if (k === 'google_client_id' && (!clientId || r.key.includes(':'))) clientId = r.value
    if (k === 'google_client_secret' && (!clientSecret || r.key.includes(':'))) clientSecret = r.value
  }
  let source = clientId ? 'company' : ''
  // Platform-level fallback: shared OAuth app owned by Groundwork itself.
  // Set once as Cloudflare Pages secrets (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)
  // and every company gets Google integration with ZERO Google Cloud setup.
  // A company that saves its own creds in Admin Setup still overrides this.
  if (!clientId && env?.GOOGLE_CLIENT_ID) { clientId = env.GOOGLE_CLIENT_ID; source = 'platform' }
  if (!clientSecret && env?.GOOGLE_CLIENT_SECRET) clientSecret = env.GOOGLE_CLIENT_SECRET
  return { clientId, clientSecret, source }
}

// GET /api/google/client-id — effective Google OAuth Client ID for this company
// (company-scoped setting → legacy unscoped setting → platform default env secret).
// Lets every tenant's browser start the OAuth flow without any admin setup when
// the platform-level shared OAuth app is configured. Never exposes the secret.
app.get('/api/google/client-id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const { clientId, source } = await _googleClientCreds(c.env.DB as D1Database, companyId, c.env)
  return c.json({ ok: true, data: { client_id: clientId || '', source: source || 'none' } })
})

// POST /api/google/exchange — swap authorization code for tokens; store refresh token
app.post('/api/google/exchange', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId = c.var.repId as string
  const db = c.env.DB as D1Database
  await ensureProposalsSchema(db)
  const b: any = await c.req.json()
  const code = String(b.code || '')
  const redirectUri = String(b.redirect_uri || '')
  if (!code) return c.json({ ok: false, error: 'code required' }, 400)
  const { clientId, clientSecret } = await _googleClientCreds(db, companyId, c.env)
  if (!clientId || !clientSecret) {
    return c.json({ ok: false, error: 'Google Client ID/Secret not configured — set both in Integrations → Admin Setup' }, 400)
  }
  const tr = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirectUri, grant_type: 'authorization_code'
    })
  })
  const tj: any = await tr.json()
  if (!tr.ok || !tj.access_token) {
    return c.json({ ok: false, error: tj.error_description || tj.error || 'Token exchange failed' }, 400)
  }
  // Fetch the user email
  let email = ''
  try {
    const ur = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tj.access_token}` }
    })
    const uj: any = await ur.json()
    email = uj.email || ''
  } catch {}
  // Persist refresh token (only returned on first consent — keep existing if absent)
  if (tj.refresh_token) {
    await db.prepare(`
      INSERT INTO google_tokens (rep_id, company_id, refresh_token, email, connected_at, updated_at)
      VALUES (?,?,?,?,datetime('now'),datetime('now'))
      ON CONFLICT(rep_id) DO UPDATE SET refresh_token=excluded.refresh_token, email=excluded.email, updated_at=datetime('now')
    `).bind(repId, companyId, tj.refresh_token, email).run()
  } else {
    await db.prepare(`UPDATE google_tokens SET email=?, updated_at=datetime('now') WHERE rep_id=?`)
      .bind(email, repId).run()
  }
  return c.json({ ok: true, data: {
    access_token: tj.access_token,
    expires_in: tj.expires_in || 3600,
    email,
    has_refresh: !!tj.refresh_token
  }})
})

// POST /api/google/refresh — mint a fresh access token from the stored refresh token
app.post('/api/google/refresh', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId = c.var.repId as string
  const db = c.env.DB as D1Database
  await ensureProposalsSchema(db)
  const rec: any = await db.prepare(`SELECT refresh_token, email FROM google_tokens WHERE rep_id=? LIMIT 1`)
    .bind(repId).first()
  if (!rec) return c.json({ ok: false, error: 'not_connected' }, 404)
  const { clientId, clientSecret } = await _googleClientCreds(db, companyId, c.env)
  if (!clientId || !clientSecret) return c.json({ ok: false, error: 'Google Client ID/Secret not configured' }, 400)
  const tr = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: rec.refresh_token, client_id: clientId,
      client_secret: clientSecret, grant_type: 'refresh_token'
    })
  })
  const tj: any = await tr.json()
  if (!tr.ok || !tj.access_token) {
    // Refresh token revoked/expired — clear it so the client can prompt reconnect
    if (tj.error === 'invalid_grant') {
      await db.prepare(`DELETE FROM google_tokens WHERE rep_id=?`).bind(repId).run()
    }
    return c.json({ ok: false, error: tj.error_description || tj.error || 'refresh_failed' }, 400)
  }
  return c.json({ ok: true, data: {
    access_token: tj.access_token,
    expires_in: tj.expires_in || 3600,
    email: rec.email || ''
  }})
})

// GET /api/google/status — is this rep persistently connected?
app.get('/api/google/status', requireAuth, async (c) => {
  const repId = c.var.repId as string
  const db = c.env.DB as D1Database
  await ensureProposalsSchema(db)
  const rec: any = await db.prepare(`SELECT email, connected_at FROM google_tokens WHERE rep_id=? LIMIT 1`)
    .bind(repId).first()
  return c.json({ ok: true, data: { connected: !!rec, email: rec?.email || '', connected_at: rec?.connected_at || '' } })
})

// DELETE /api/google/disconnect — manual disconnect (the ONLY way to disconnect)
app.delete('/api/google/disconnect', requireAuth, async (c) => {
  const repId = c.var.repId as string
  const db = c.env.DB as D1Database
  await ensureProposalsSchema(db)
  // Best-effort revoke at Google
  const rec: any = await db.prepare(`SELECT refresh_token FROM google_tokens WHERE rep_id=? LIMIT 1`).bind(repId).first()
  if (rec?.refresh_token) {
    try { await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(rec.refresh_token)}`, { method: 'POST' }) } catch {}
  }
  await db.prepare(`DELETE FROM google_tokens WHERE rep_id=?`).bind(repId).run()
  return c.json({ ok: true })
})

// ══════════════════════════════════════════════════════════════════════════════
// GOOGLE CALENDAR SYNC — pull events server-side (via stored refresh token),
// store in D1, match attendees to leads, drive post-meeting task automation.
// ══════════════════════════════════════════════════════════════════════════════
let _cal35SchemaOk = false
async function ensureCalendarSchema(db: D1Database): Promise<void> {
  if (_cal35SchemaOk) return
  const flag = await db.prepare("SELECT value FROM settings WHERE key = '_schema_cal_v1' LIMIT 1").first<any>()
  if (flag) { _cal35SchemaOk = true; return }
  const stmts = mig0035.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .split(';').map(x => x.trim()).filter(x => x.length > 0)
  for (const stmt of stmts) {
    try { await db.prepare(stmt).run() } catch (e: any) {
      const msg = String(e?.message || e)
      if (!/duplicate column|already exists/i.test(msg)) console.log('ensureCalendarSchema err', msg.slice(0, 120))
    }
  }
  try {
    await db.prepare('INSERT INTO d1_migrations (name, applied_at) SELECT ?, CURRENT_TIMESTAMP WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = ?)').bind('0035_calendar_sync.sql', '0035_calendar_sync.sql').run()
  } catch {}
  await db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('_schema_cal_v1', ?, datetime('now'))").bind(new Date().toISOString()).run()
  _cal35SchemaOk = true
}

// Mint a Google access token server-side from the rep's stored refresh token
async function _googleAccessToken(db: D1Database, companyId: string, repId: string, env?: Bindings): Promise<{ token?: string; email?: string; error?: string }> {
  const rec: any = await db.prepare(`SELECT refresh_token, email FROM google_tokens WHERE rep_id=? LIMIT 1`).bind(repId).first()
  if (!rec) return { error: 'not_connected' }
  const { clientId, clientSecret } = await _googleClientCreds(db, companyId, env)
  if (!clientId || !clientSecret) return { error: 'client_not_configured' }
  const tr = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: rec.refresh_token, client_id: clientId,
      client_secret: clientSecret, grant_type: 'refresh_token'
    })
  })
  const tj: any = await tr.json()
  if (!tr.ok || !tj.access_token) {
    if (tj.error === 'invalid_grant') await db.prepare(`DELETE FROM google_tokens WHERE rep_id=?`).bind(repId).run()
    return { error: tj.error_description || tj.error || 'refresh_failed' }
  }
  return { token: tj.access_token, email: rec.email || '' }
}

// POST /api/calendar/sync — fetch Google events (past 30d → next 90d), upsert
// into calendar_events, auto-match attendee emails to leads, and create
// post-meeting follow-up tasks for matched meetings that have ended.
app.post('/api/calendar/sync', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId as string
  const db = c.env.DB as D1Database
  await ensureProposalsSchema(db)
  await ensureCalendarSchema(db)

  const auth = await _googleAccessToken(db, companyId, repId, c.env)
  if (!auth.token) return c.json({ ok: false, error: auth.error }, auth.error === 'not_connected' ? 404 : 400)

  const now = new Date()
  const timeMin = new Date(now.getTime() - 30 * 86400000).toISOString()
  const timeMax = new Date(now.getTime() + 90 * 86400000).toISOString()

  // Fetch events (paginate up to 3 pages / 750 events)
  const events: any[] = []
  let pageToken = ''
  for (let p = 0; p < 3; p++) {
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=250&singleEvents=true&orderBy=startTime` +
      `&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '')
    const r = await fetch(url, { headers: { Authorization: `Bearer ${auth.token}` } })
    if (!r.ok) {
      const ej: any = await r.json().catch(() => ({}))
      return c.json({ ok: false, error: ej?.error?.message || `google_http_${r.status}` }, 400)
    }
    const j: any = await r.json()
    events.push(...(j.items || []))
    pageToken = j.nextPageToken || ''
    if (!pageToken) break
  }

  // Lead email index for attendee matching (case-insensitive)
  const { results: opps } = await db.prepare(
    `SELECT id, client, email, status, pipeline_stage FROM opportunities WHERE company_id=? AND email != ''`
  ).bind(companyId).all()
  const oppByEmail = new Map<string, any>()
  for (const o of (opps as any[])) oppByEmail.set(String(o.email).trim().toLowerCase(), o)

  // Existing rows: preserve manual links + automation flags
  const { results: existing } = await db.prepare(
    `SELECT id, opp_id, opp_match_how, automation_done FROM calendar_events WHERE company_id=? AND rep_id=?`
  ).bind(companyId, repId).all()
  const prior = new Map<string, any>()
  for (const e of (existing as any[])) prior.set(e.id, e)

  let synced = 0, matched = 0, cancelled = 0
  const nowIso = now.toISOString()
  const seenIds: string[] = []

  for (const ev of events) {
    if (!ev.id) continue
    seenIds.push(ev.id)
    const isCancelled = ev.status === 'cancelled'
    if (isCancelled) cancelled++
    const allDay = !!(ev.start?.date && !ev.start?.dateTime)
    const startAt = ev.start?.dateTime || ev.start?.date || ''
    const endAt   = ev.end?.dateTime || ev.end?.date || ''
    const attendees = (ev.attendees || []).map((a: any) => ({
      email: a.email || '', name: a.displayName || '', response: a.responseStatus || ''
    }))
    // Booking-page bookings: Google marks appointment-schedule events with
    // eventType, and the description usually carries "Booked via" + the
    // booker's form answers.
    const desc = String(ev.description || '')
    const isBooking = ev.eventType === 'appointment' ||
      /booked via|appointment schedule|booking page|this event was created from/i.test(desc)

    // Attendee → lead match (skip the rep's own email)
    const pr = prior.get(ev.id)
    let oppId = pr?.opp_id || ''
    let matchHow = pr?.opp_match_how || ''
    if (!oppId || matchHow === 'attendee_email') {
      // Try description tag "[opp_xxx]" first (events created from Groundwork)
      const tagM = desc.match(/\[(opp_[A-Za-z0-9_-]+)\]/)
      if (tagM) { oppId = tagM[1]; matchHow = 'description_tag' }
      else {
        for (const a of attendees) {
          const em = String(a.email || '').trim().toLowerCase()
          if (!em || em === String(auth.email).toLowerCase()) continue
          const o = oppByEmail.get(em)
          if (o) { oppId = o.id; matchHow = 'attendee_email'; break }
        }
      }
    }
    if (oppId) matched++

    await db.prepare(`
      INSERT INTO calendar_events (
        id, company_id, rep_id, rep_email, summary, description, location,
        start_at, end_at, all_day, attendees, organizer_email, hangout_link,
        html_link, color_id, status, event_type, is_booking, opp_id,
        opp_match_how, automation_done, synced_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        summary=excluded.summary, description=excluded.description,
        location=excluded.location, start_at=excluded.start_at,
        end_at=excluded.end_at, all_day=excluded.all_day,
        attendees=excluded.attendees, hangout_link=excluded.hangout_link,
        html_link=excluded.html_link, color_id=excluded.color_id,
        status=excluded.status, is_booking=excluded.is_booking,
        opp_id=CASE WHEN calendar_events.opp_match_how='manual' THEN calendar_events.opp_id ELSE excluded.opp_id END,
        opp_match_how=CASE WHEN calendar_events.opp_match_how='manual' THEN 'manual' ELSE excluded.opp_match_how END,
        synced_at=excluded.synced_at, updated_at=excluded.updated_at
    `).bind(
      ev.id, companyId, repId, auth.email || '',
      ev.summary || '(no title)', desc.slice(0, 4000), ev.location || '',
      startAt, endAt, allDay ? 1 : 0, JSON.stringify(attendees),
      ev.organizer?.email || '', ev.hangoutLink || '', ev.htmlLink || '',
      ev.colorId || '', ev.status || 'confirmed', ev.eventType || '',
      isBooking ? 1 : 0, oppId, matchHow, pr?.automation_done || 0,
      nowIso, nowIso
    ).run()
    synced++
  }

  // ── Post-meeting automation: matched, ended, not yet automated ────────────
  // Creates a "Send post-meeting follow-up email" task on the lead.
  let tasksCreated = 0
  const { results: ended } = await db.prepare(`
    SELECT ce.id, ce.summary, ce.opp_id, ce.end_at, ce.is_booking
    FROM calendar_events ce
    WHERE ce.company_id=? AND ce.rep_id=? AND ce.opp_id != ''
      AND ce.automation_done=0 AND ce.status='confirmed'
      AND ce.end_at != '' AND ce.end_at <= ? AND ce.end_at >= ?
  `).bind(companyId, repId, nowIso, timeMin).all()

  for (const m of (ended as any[])) {
    const opp: any = await db.prepare(`SELECT id, client FROM opportunities WHERE id=? AND company_id=? LIMIT 1`)
      .bind(m.opp_id, companyId).first()
    if (!opp) continue
    // Dedupe: don't create if an open task already references this event
    const dupe: any = await db.prepare(
      `SELECT id FROM tasks WHERE company_id=? AND description LIKE ? LIMIT 1`
    ).bind(companyId, `%[cal:${m.id}]%`).first()
    if (!dupe) {
      const taskId = 'task_' + uid()
      // ── Meeting-type rules (Phase 3) ──────────────────────────────────────
      // Classify the meeting from its title/booking flag and tailor the task.
      const sm = String(m.summary || '').toLowerCase()
      let mType = 'meeting'   // generic default
      if (/estimate|quote|bid|proposal/.test(sm))                        mType = 'estimate'
      else if (/site visit|site-visit|walkthrough|walk-through|assessment|consult/.test(sm) || m.is_booking) mType = 'site_visit'
      else if (/kickoff|kick-off|project start|onboard/.test(sm))        mType = 'kickoff'
      else if (/check[- ]?in|review|status/.test(sm))                    mType = 'checkin'
      const RULES: Record<string, { title: string; hint: string; priority: string }> = {
        estimate:   { title: 'Send estimate follow-up email',    hint: 'They are waiting on pricing — recap the scope discussed and confirm when the estimate will land.', priority: 'high' },
        site_visit: { title: 'Send post-site-visit follow-up email', hint: 'Recap what you saw on site, the recommended work, and clear next steps.', priority: 'high' },
        kickoff:    { title: 'Send project kickoff recap email', hint: 'Confirm the start date, crew details, prep the client needs to do, and points of contact.', priority: 'high' },
        checkin:    { title: 'Send check-in recap email',        hint: 'Summarize status, decisions made, and any changes to scope or schedule.', priority: 'normal' },
        meeting:    { title: 'Send post-meeting follow-up email', hint: 'Send the post-meeting email recapping next steps.', priority: 'high' },
      }
      const rule = RULES[mType]
      // ── Due date: next business MORNING after the meeting ends ───────────
      // Same-day meetings that end before 2pm → due 9am next business day still
      // gives breathing room; anything later also lands next business morning.
      // Skips Sat/Sun. Times are kept in the meeting's own UTC frame (matches
      // how due 4h-after used to behave — dates here are advisory).
      const endD = new Date(m.end_at)
      const due = new Date(endD)
      due.setUTCDate(due.getUTCDate() + 1)
      while (due.getUTCDay() === 0 || due.getUTCDay() === 6) due.setUTCDate(due.getUTCDate() + 1)  // 0=Sun 6=Sat
      due.setUTCHours(9, 0, 0, 0)
      await db.prepare(`
        INSERT INTO tasks (
          id, company_id, title, description, task_type,
          linked_record_type, linked_record_id, linked_record_label,
          assigned_user_id, assigned_user_label, created_by,
          due_date, due_time, priority, status,
          calendar_sync_state, source, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        taskId, companyId,
        `${rule.title} — ${opp.client || 'client'}`,
        `Auto-created after "${m.summary}" ended. ${rule.hint} [cal:${m.id}]`,
        'follow_up', 'opportunity', opp.id, opp.client || '',
        repId, '', repId,
        due.toISOString().slice(0, 10), due.toISOString().slice(11, 16),
        rule.priority, 'open', 'none', 'calendar_automation', nowIso, nowIso
      ).run()
      tasksCreated++
    }
    await db.prepare(`UPDATE calendar_events SET automation_done=1, updated_at=? WHERE id=?`).bind(nowIso, m.id).run()
  }

  return c.json({ ok: true, data: { synced, matched, cancelled, tasksCreated, syncedAt: nowIso } })
})

// GET /api/calendar/events?from=&to=&oppId= — synced events from D1 (fast, no Google call)
app.get('/api/calendar/events', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensureCalendarSchema(db)
  const from  = c.req.query('from') || ''
  const to    = c.req.query('to') || ''
  const oppId = c.req.query('oppId') || ''
  let q = `SELECT * FROM calendar_events WHERE company_id=? AND status != 'cancelled'`
  const params: any[] = [companyId]
  if (oppId) { q += ` AND opp_id=?`; params.push(oppId) }
  if (from)  { q += ` AND start_at >= ?`; params.push(from) }
  if (to)    { q += ` AND start_at <= ?`; params.push(to) }
  q += ` ORDER BY start_at ASC LIMIT 500`
  const { results } = await db.prepare(q).bind(...params).all()
  ;(results as any[]).forEach(r => { try { r.attendees = JSON.parse(r.attendees || '[]') } catch { r.attendees = [] } })
  return c.json({ ok: true, data: results })
})

// PUT /api/calendar/events/:id/link — manually link/unlink an event to a lead
app.put('/api/calendar/events/:id/link', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensureCalendarSchema(db)
  const id = c.req.param('id')
  const b = await c.req.json() as any
  const oppId = String(b.oppId || '')
  await db.prepare(`UPDATE calendar_events SET opp_id=?, opp_match_how=?, updated_at=datetime('now') WHERE id=? AND company_id=?`)
    .bind(oppId, oppId ? 'manual' : '', id, companyId).run()
  return c.json({ ok: true })
})

// ── INVOICES (D1) ─────────────────────────────────────────────────────────────

// GET /api/invoices — list invoices with filters
app.get('/api/invoices', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await db.prepare(`UPDATE invoices SET portal_token = lower(hex(randomblob(16))) WHERE company_id=? AND (portal_token IS NULL OR portal_token='')`).bind(companyId).run().catch(() => {})
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
  await db.prepare(`UPDATE invoices SET portal_token = lower(hex(randomblob(16))) WHERE id=? AND company_id=? AND (portal_token IS NULL OR portal_token='')`).bind(c.req.param('id'), companyId).run().catch(() => {})
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
  // Attach the tenant's branding so the public portal shows THEIR logo/colors
  // (client has no session — /api/company/branding requires auth and would 401)
  try {
    const co: any = await db.prepare(
      'SELECT name, logo_url, tagline, brand_color, brand_accent, phone, website, address_line1, address_city, address_state, address_zip FROM companies WHERE id = ? LIMIT 1'
    ).bind(row.company_id).first()
    if (co) row._brand = co
  } catch (_) {}
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

  const amountPaid = b.amount_paid || 0
  await db.prepare(`
    INSERT INTO invoices (id, company_id, invoice_number, estimate_id, client_id, client_name,
      client_email, client_phone, client_address, title, status, subtotal, subtotal_cents,
      tax_rate, tax_amount, tax_amount_cents, discount_amount, discount_amount_cents,
      total, total_cents, amount_paid, amount_paid_cents, balance_due, balance_due_cents,
      due_date, line_items, notes, internal_notes,
      terms, footer_note, portal_token, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
  `).bind(id, companyId, invoiceNumber,
    b.estimate_id||'', b.client_id||'', b.client_name||'', b.client_email||'',
    b.client_phone||'', b.client_address||'', b.title||`Invoice ${invoiceNumber}`,
    b.status||'draft', subtotal, Math.round(subtotal*100),
    b.tax_rate||0, taxAmount, Math.round(taxAmount*100),
    discountAmount, Math.round(discountAmount*100),
    total, Math.round(total*100), amountPaid, Math.round(amountPaid*100),
    balanceDue, Math.round(balanceDue*100), b.due_date||'',
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
  // Dual-write: every money column also gets its *_cents twin set in the
  // same statement (migrations/0058_money_cents.sql, Stage 2).
  const MONEY_CENTS_COLS: Record<string,string> = {
    subtotal:'subtotal_cents', tax_amount:'tax_amount_cents', discount_amount:'discount_amount_cents',
    total:'total_cents', amount_paid:'amount_paid_cents', balance_due:'balance_due_cents',
  }
  const sets: string[] = []
  const vals: any[] = []
  for (const key of allowed) {
    if (key in b) {
      sets.push(`${key} = ?`)
      vals.push(key === 'line_items' && Array.isArray(b[key]) ? JSON.stringify(b[key]) : b[key])
      if (MONEY_CENTS_COLS[key]) {
        sets.push(`${MONEY_CENTS_COLS[key]} = ?`)
        vals.push(Math.round(Number(b[key]) * 100))
      }
    }
  }
  if (!sets.length) return c.json({ error: 'Nothing to update' }, 400)
  sets.push(`updated_at = datetime('now')`)
  vals.push(id, companyId)
  await db.prepare(`UPDATE invoices SET ${sets.join(', ')} WHERE id = ? AND company_id = ?`)
    .bind(...vals).run()
  if (b.status === 'paid') {
    await markOpportunityCollectedFromInvoice(db, companyId, id)
  }
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
// If the client enabled autopay in the portal, the open balance is charged to
// their chosen saved payment method automatically (respecting max_amount cap).
app.post('/api/invoices/:id/send', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const invoiceId = c.req.param('id')
  await db.prepare(`UPDATE invoices SET status='sent', sent_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND company_id=?`)
    .bind(invoiceId, companyId).run()

  // Autopay: best-effort, never blocks the send
  let autopay: any = null
  try {
    const stripeKey = (c.env as any).STRIPE_SECRET_KEY as string | undefined
    const inv: any = await db.prepare(`SELECT * FROM invoices WHERE id=? AND company_id=? LIMIT 1`).bind(invoiceId, companyId).first()
    if (stripeKey && inv?.client_id) {
      const ap: any = await db.prepare(`SELECT * FROM client_autopay WHERE client_id=? AND company_id=? AND enabled=1 LIMIT 1`).bind(inv.client_id, companyId).first()
      const owedCents = Math.max(0, Number(inv.total_cents || 0) - Number(inv.amount_paid_cents || 0))
      const apMaxAmountCents = Number(ap?.max_amount_cents || 0)
      if (ap?.stripe_pm_id && owedCents >= 50) {
        if (apMaxAmountCents > 0 && owedCents > apMaxAmountCents) {
          autopay = { attempted: false, reason: `Balance exceeds the client's autopay cap of $${(apMaxAmountCents / 100)}` }
        } else {
          const company: any = await db.prepare(`SELECT stripe_account_id, stripe_onboarded, stripe_platform_fee_pct FROM companies WHERE id=? LIMIT 1`).bind(companyId).first()
          const client: any = await db.prepare(`SELECT stripe_customer_id FROM clients WHERE id=? AND company_id=? LIMIT 1`).bind(inv.client_id, companyId).first()
          if (company?.stripe_account_id && company.stripe_onboarded && client?.stripe_customer_id) {
            const feePct = company.stripe_platform_fee_pct || 2.9
            const form = new URLSearchParams({
              amount: String(owedCents), currency: 'usd', customer: client.stripe_customer_id,
              payment_method: ap.stripe_pm_id, confirm: 'true', 'off_session': 'true',
              'application_fee_amount': String(Math.round(owedCents * feePct / 100)),
              'transfer_data[destination]': company.stripe_account_id,
              'metadata[invoice_id]': invoiceId, 'metadata[company_id]': companyId, 'metadata[source]': 'autopay',
            })
            const piRes = await fetch('https://api.stripe.com/v1/payment_intents', {
              method: 'POST', headers: { 'Authorization': `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString()
            })
            const pi: any = await piRes.json()
            if (piRes.ok && pi.status === 'succeeded') {
              const amountCents = owedCents
              const amountDollars = amountCents / 100
              const newPaidCents = Number(inv.amount_paid_cents || 0) + amountCents
              const newBalanceCents = Math.max(0, Number(inv.total_cents || 0) - newPaidCents)
              const newPaid = newPaidCents / 100
              const newBalance = newBalanceCents / 100
              await db.prepare(`UPDATE invoices SET amount_paid=?, amount_paid_cents=?, balance_due=?, balance_due_cents=?, status=?, updated_at=datetime('now') WHERE id=? AND company_id=?`)
                .bind(newPaid, newPaidCents, newBalance, newBalanceCents, newBalanceCents <= 0 ? 'paid' : 'partial', invoiceId, companyId).run()
              await db.prepare(
                `INSERT INTO payments (id, company_id, invoice_id, client_id, amount, amount_cents, net_amount, net_amount_cents, status, payment_method, stripe_payment_intent_id, description, invoice_number, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`
              ).bind(`py_${Date.now()}_${Math.random().toString(36).slice(2,7)}`, companyId, invoiceId, inv.client_id, amountDollars, amountCents, amountDollars, amountCents,
                'succeeded', 'card', pi.id, `Autopay — ${ap.pm_label || 'saved method'}`, inv.invoice_number || '').run()
              if (newBalance <= 0) {
                await markOpportunityCollectedFromInvoice(db, companyId, invoiceId, inv.estimate_id)
              }
              autopay = { attempted: true, paid: true, amount: amountDollars, pm_label: ap.pm_label || '' }
            } else {
              autopay = { attempted: true, paid: false, reason: pi?.error?.message || `Payment status: ${pi?.status || 'failed'}` }
            }
          }
        }
      }
    }
  } catch (e: any) {
    autopay = { attempted: true, paid: false, reason: e.message }
  }
  return c.json({ ok: true, autopay })
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

  const paymentAmountCents = Math.round((b.amount || 0) * 100)
  const newPaidCents = Number(inv.amount_paid_cents || 0) + paymentAmountCents
  const newBalanceCents = Number(inv.total_cents || 0) - newPaidCents
  const newStatus = newBalanceCents <= 0 ? 'paid' : 'partial'
  const clampedBalanceCents = Math.max(0, newBalanceCents)
  const newPaid = newPaidCents / 100
  const clampedBalance = clampedBalanceCents / 100

  await db.prepare(`UPDATE invoices SET amount_paid=?, amount_paid_cents=?, balance_due=?, balance_due_cents=?, status=?, updated_at=datetime('now') WHERE id=? AND company_id=?`)
    .bind(newPaid, newPaidCents, clampedBalance, clampedBalanceCents, newStatus, id, companyId).run()

  // Log to payments table
  const payId = `pay_${Date.now()}_${Math.random().toString(36).slice(2,8)}`
  const paymentAmount = paymentAmountCents / 100
  await db.prepare(`INSERT INTO payments (id, company_id, invoice_id, client_id, amount, amount_cents, net_amount, net_amount_cents, status, payment_method, description, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`)
    .bind(payId, companyId, id, inv.client_id||'', paymentAmount, paymentAmountCents, paymentAmount, paymentAmountCents, 'succeeded',
      b.method||'check', b.note||'Manual payment recorded').run()

  if (newStatus === 'paid') {
    await markOpportunityCollectedFromInvoice(db, companyId, id, inv.estimate_id)
  }

  return c.json({ ok: true, status: newStatus, balance_due: clampedBalance })
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
  // Balance-due derivation done in integer cents (not float dollars) —
  // subtracting est.total - est.deposit_paid_amount in float would carry
  // fractional-cent drift into the new invoice's balance_due.
  const subtotalCents = Number(est.subtotal_cents || 0)
  const taxAmountCents = Number(est.tax_amt_cents || 0)
  const totalCents = Number(est.total_cents || 0)
  const depositPaidCents = Number(est.deposit_paid_amount_cents || 0)
  const balanceDueCentsClamped = Math.max(0, totalCents - depositPaidCents)
  const total = totalCents / 100
  const depositPaid = depositPaidCents / 100
  const balanceDueClamped = balanceDueCentsClamped / 100

  // Get due date = today + 30 days
  const due = new Date(); due.setDate(due.getDate() + 30)
  const dueDate = due.toISOString().split('T')[0]

  await db.prepare(`
    INSERT INTO invoices (id, company_id, invoice_number, estimate_id, client_id, client_name,
      client_email, client_phone, title, status, subtotal, subtotal_cents, tax_rate, tax_amount, tax_amount_cents,
      total, total_cents, amount_paid, amount_paid_cents, balance_due, balance_due_cents, due_date, line_items, notes, portal_token,
      created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
  `).bind(id, companyId, invoiceNumber, est.id, est.client_id||'', est.client_name||'',
    est.client_email||'', est.client_phone||'',
    `Invoice for ${est.title || est.estimate_number}`, 'draft',
    subtotalCents / 100, subtotalCents, est.tax_pct||0, taxAmountCents / 100, taxAmountCents,
    total, totalCents, depositPaid, depositPaidCents, balanceDueClamped, balanceDueCentsClamped, dueDate,
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

    // Record payment and update invoice — amount is already cents (client-
    // supplied charge amount), so the running balance stays in cents too.
    const chargeAmountCents = Math.round(amount)
    const newPaidCents = Number(inv.amount_paid_cents || 0) + chargeAmountCents
    const newBalanceCents = Math.max(0, Number(inv.total_cents || inv.balance_due_cents || 0) - newPaidCents)
    const newStatus = newBalanceCents <= 0 ? 'paid' : 'partial'
    const newPaid = newPaidCents / 100
    const newBalance = newBalanceCents / 100
    const amountDollars = chargeAmountCents / 100

    await db.prepare(
      `UPDATE invoices SET amount_paid=?, amount_paid_cents=?, balance_due=?, balance_due_cents=?, status=?, updated_at=datetime('now') WHERE id=? AND company_id=?`
    ).bind(newPaid, newPaidCents, newBalance, newBalanceCents, newStatus, invoiceId, companyId).run()

    const pymtId = `py_${Date.now()}_${Math.random().toString(36).slice(2,7)}`
    await db.prepare(
      `INSERT INTO payments (id, company_id, invoice_id, client_id, amount, amount_cents, net_amount, net_amount_cents, status, payment_method, description, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`
    ).bind(pymtId, companyId, invoiceId, inv.client_id||'', amountDollars, chargeAmountCents, amountDollars, chargeAmountCents,
      'succeeded', 'card', `Stripe charge — ${pi.id}`).run()

    if (newStatus === 'paid') {
      await markOpportunityCollectedFromInvoice(db, companyId, invoiceId, inv.estimate_id)
    }

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
// Self-healing: ensures required companies columns exist (older prod DBs may
// not have run migrations 0021/0025). Uses the same pin_hash format and
// settings-table session pattern as /api/auth/login so signup→login just works.
async function ensureSignupSchema(db: D1Database) {
  const flag = await db.prepare("SELECT value FROM settings WHERE key = '_schema_signup_v1' LIMIT 1").first()
  if (flag) return
  const alters = [
    "ALTER TABLE companies ADD COLUMN business_type TEXT DEFAULT 'home_services'",
    "ALTER TABLE companies ADD COLUMN brand_color TEXT DEFAULT '#2D7A55'",
    "ALTER TABLE companies ADD COLUMN brand_accent TEXT DEFAULT '#4D8A86'",
    "ALTER TABLE companies ADD COLUMN onboarding_completed INTEGER DEFAULT 0",
    "ALTER TABLE companies ADD COLUMN onboarding_step INTEGER DEFAULT 0",
    "ALTER TABLE companies ADD COLUMN onboarding_data TEXT DEFAULT '{}'",
    "ALTER TABLE companies ADD COLUMN trial_started_at TEXT DEFAULT ''",
    "ALTER TABLE companies ADD COLUMN trial_expires_at TEXT DEFAULT ''",
    "ALTER TABLE companies ADD COLUMN trial_plan TEXT DEFAULT 'growth'",
    "ALTER TABLE companies ADD COLUMN subscription_status TEXT DEFAULT 'trial'",
    "ALTER TABLE companies ADD COLUMN subscription_plan TEXT DEFAULT ''",
    "ALTER TABLE companies ADD COLUMN stripe_customer_id TEXT DEFAULT ''",
  ]
  for (const sql of alters) {
    try { await db.prepare(sql).run() } catch (_) { /* column already exists */ }
  }
  await db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('_schema_signup_v1','1',datetime('now'))").run()
}

app.post('/api/auth/signup', async (c) => {
  const db = c.env.DB as D1Database
  let b: any
  try { b = await c.req.json() } catch (_) { return c.json({ error: 'Invalid request body' }, 400) }
  const companyName = String(b.company_name || b.companyName || '').trim()
  const email       = String(b.email || '').toLowerCase().trim()
  const password    = String(b.password || '')
  const ownerName   = String(b.owner_name || b.ownerName || '').trim()
  const businessType = String(b.business_type || b.businessType || 'home_services')

  // Honeypot: hidden field bots fill out. Pretend success, create nothing.
  if (String(b.website_url || b.hp_field || '').trim() !== '') {
    return c.json({ ok: true, company_id: 'co_' + Date.now(), rep_id: 'rep_' + Date.now(), slug: 'ok' })
  }

  if (!companyName || !email || !password) {
    return c.json({ error: 'Company name, email, and password are required' }, 400)
  }
  if (password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400)
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.json({ error: 'Please enter a valid email address' }, 400)
  }

  // IP rate limit: max 3 signups per IP per hour (settings-based sliding window)
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown'
  if (ip !== 'unknown') {
    const rlKey = `_signup_rl_${ip}`
    const rl = await db.prepare('SELECT value FROM settings WHERE key = ? LIMIT 1').bind(rlKey).first<any>()
    const now = Date.now()
    let hits: number[] = []
    try { hits = JSON.parse(rl?.value || '[]').filter((t: number) => now - t < 60 * 60 * 1000) } catch {}
    if (hits.length >= 3) {
      return c.json({ error: 'Too many signups from this location. Please try again in an hour.' }, 429)
    }
    hits.push(now)
    await db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))")
      .bind(rlKey, JSON.stringify(hits)).run()
  }

  // Email must be unique across all tenants (login is email-based)
  const existing = await db.prepare('SELECT id FROM reps WHERE email = ? LIMIT 1').bind(email).first()
  if (existing) return c.json({ error: 'An account with this email already exists' }, 409)

  await ensureSignupSchema(db)
  await ensureFullSchema(db)

  // Company id + unique slug
  const baseSlug = companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'company'
  let slug = baseSlug
  for (let i = 2; i < 50; i++) {
    const taken = await db.prepare('SELECT id FROM companies WHERE slug = ? LIMIT 1').bind(slug).first()
    if (!taken) break
    slug = `${baseSlug}-${i}`
  }
  const companyId = `co_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  const now = new Date().toISOString()
  const trialEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()

  await db.prepare(`
    INSERT INTO companies (id, name, slug, plan, owner_email, business_type, brand_color, brand_accent,
      subscription_status, trial_plan, trial_started_at, trial_expires_at,
      onboarding_completed, onboarding_step, active, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,0,1,datetime('now'),datetime('now'))
  `).bind(companyId, companyName, slug, 'trial', email, businessType,
    '#2D7A55', '#4D8A86', 'trial', 'growth', now, trialEnd).run()

  // Seed the company settings "folder" (same as admin-created tenants)
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").bind(`${companyId}:created_at`, now),
    db.prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").bind(`${companyId}:last_write`, `${now}|signup`),
    db.prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").bind(`${companyId}:plan`, 'trial'),
  ])

  // Owner account — same hash format the login verifier expects
  const pinHash = await hashPin(password)
  const repId = `rep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const displayName = ownerName || email.split('@')[0]

  await db.prepare(`
    INSERT INTO reps (id, company_id, name, email, pin, pin_hash, role, active, created_at, updated_at)
    VALUES (?,?,?,?,'',?,'admin',1,datetime('now'),datetime('now'))
  `).bind(repId, companyId, displayName, email, pinHash).run()

  // Session — same settings-table pattern as /api/auth/login
  const token = secureToken()
  await db.batch([
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").bind(`session_${token}`, repId),
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").bind(`session_company_${token}`, companyId),
  ])
  setCookie(c, 'avalon_session', token, {
    httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 60 * 60 * 24 * 30
  })

  // Email verification (soft gate): send a verify link; app shows a banner until verified.
  let verifySent = false
  if (c.env.SENDGRID_API_KEY) {
    const vToken = secureToken(24)
    await db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))")
      .bind(`_verify_${vToken}`, JSON.stringify({ repId, companyId, email, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })).run()
    const origin = new URL(c.req.url).origin
    const verifyUrl = `${origin}/api/auth/verify-email?token=${vToken}`
    verifySent = await sendEmail(c.env.SENDGRID_API_KEY, email,
      'Verify your email — Groundwork CRM',
      `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F5F9F7;font-family:Inter,Arial,sans-serif">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F9F7;padding:48px 20px"><tr><td align="center">
        <table width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 8px 40px rgba(30,70,56,.10)">
          <tr><td style="background:linear-gradient(135deg,#0E372F,#1A4740);padding:32px 40px;text-align:center">
            <div style="color:#fff;font-size:20px;font-weight:800">Groundwork CRM</div></td></tr>
          <tr><td style="padding:36px 40px">
            <h2 style="margin:0 0 12px;color:#0E372F;font-size:19px">Welcome, ${displayName}!</h2>
            <p style="margin:0 0 24px;color:#4a5f58;font-size:14px;line-height:1.6">Your 14-day free trial of <strong>${companyName}</strong> has started. Please confirm your email address to secure your account.</p>
            <div style="text-align:center;margin:0 0 24px"><a href="${verifyUrl}" style="display:inline-block;background:#2D7A55;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 36px;border-radius:12px">Verify My Email</a></div>
            <p style="margin:0;color:#8aa39a;font-size:12px;line-height:1.5">This link expires in 7 days. If you didn't create this account, you can ignore this email.</p>
          </td></tr>
        </table></td></tr></table></body></html>`)
  }

  return c.json({
    ok: true,
    company_id: companyId,
    rep_id: repId,
    slug,
    trial_expires_at: trialEnd,
    onboarding_step: 0,
    verify_email_sent: verifySent
  })
})

// GET /api/auth/verify-email?token=xxx — marks the rep's email verified, redirects to app
app.get('/api/auth/verify-email', async (c) => {
  const vToken = c.req.query('token') || ''
  if (!vToken || !/^[a-f0-9]{16,64}$/.test(vToken)) return c.redirect('/?verify=invalid')
  const db = c.env.DB as D1Database
  const row = await db.prepare('SELECT value FROM settings WHERE key = ? LIMIT 1').bind(`_verify_${vToken}`).first<any>()
  if (!row) return c.redirect('/?verify=invalid')
  let data: any = null
  try { data = JSON.parse(row.value) } catch {}
  if (!data || (data.exp && Date.now() > data.exp)) {
    await db.prepare('DELETE FROM settings WHERE key = ?').bind(`_verify_${vToken}`).run()
    return c.redirect('/?verify=expired')
  }
  await db.batch([
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, 'true', datetime('now'))")
      .bind(`${data.companyId}:email_verified_${data.repId}`),
    db.prepare('DELETE FROM settings WHERE key = ?').bind(`_verify_${vToken}`)
  ])
  return c.redirect('/?verify=ok')
})

// POST /api/auth/resend-verification — authed; resends the verify link
app.post('/api/auth/resend-verification', requireAuth, async (c) => {
  const db = c.env.DB as D1Database
  const repId = c.var.repId as string
  const companyId = c.var.companyId as string
  const already = await db.prepare('SELECT value FROM settings WHERE key = ? LIMIT 1')
    .bind(`${companyId}:email_verified_${repId}`).first()
  if (already) return json(c, { verified: true })
  if (!c.env.SENDGRID_API_KEY) return json(c, { sent: false, reason: 'email_not_configured' })
  const rep = await db.prepare('SELECT email, name FROM reps WHERE id = ? AND company_id = ? LIMIT 1').bind(repId, companyId).first<any>()
  if (!rep?.email) return json(c, { sent: false, reason: 'no_email' })
  const vToken = secureToken(24)
  await db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))")
    .bind(`_verify_${vToken}`, JSON.stringify({ repId, companyId, email: rep.email, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })).run()
  const origin = new URL(c.req.url).origin
  const verifyUrl = `${origin}/api/auth/verify-email?token=${vToken}`
  const sent = await sendEmail(c.env.SENDGRID_API_KEY, rep.email,
    'Verify your email — Groundwork CRM',
    `<p style="font-family:Arial,sans-serif;font-size:14px;color:#333">Hi ${rep.name || ''}, please verify your Groundwork CRM email:</p><p><a href="${verifyUrl}" style="display:inline-block;background:#2D7A55;color:#fff;text-decoration:none;font-weight:700;padding:12px 28px;border-radius:10px;font-family:Arial,sans-serif">Verify My Email</a></p>`)
  return json(c, { sent })
})

// ── RECURRING PLANS (D1) ──────────────────────────────────────────────────────

// GET /api/recurring-plans — list all plans for company
app.get('/api/recurring-plans', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensurePortfolioSchema(db)
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
  await ensurePortfolioSchema(db)
  const body = await c.req.json() as any
  const {
    name, description, frequency, frequency_unit, price, visit_duration_minutes,
    services_included, is_active,
    // These were accepted by neither the destructure nor the INSERT, so the plan
    // builder's task checklist, estimated hours and crew size were silently
    // discarded on every save — the form collects them and posts them, and they
    // simply never reached a column. See recurring_plans.js plan builder.
    service_type, frequency_days, price_type, unit_label, estimated_hours, crew_size, tasks,
  } = body
  if (!name || !frequency || !price) return c.json({ error: 'name, frequency, price required' }, 400)
  const id = Date.now()
  await db.prepare(`
    INSERT INTO recurring_plans (id, company_id, name, description, frequency, frequency_unit, price, price_cents, visit_duration_minutes, services_included, is_active,
                                 service_type, frequency_days, price_type, unit_label, estimated_hours, crew_size, tasks)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(id, companyId, name, description||'', frequency, frequency_unit||'weeks', price, Math.round(Number(price) * 100), visit_duration_minutes||60, services_included||'', is_active??1,
          service_type||'', frequency_days ?? null, price_type||'per_visit', unit_label||'',
          estimated_hours ?? null, crew_size ?? null,
          // tasks arrives as an array from the builder; the column is TEXT JSON.
          typeof tasks === 'string' ? tasks : JSON.stringify(tasks || [])).run()
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
  // Mirrors the create handler. The second row was missing entirely, so editing a
  // plan silently dropped its task list, hours and crew size the same way creating
  // one did.
  const fields = ['name','description','frequency','frequency_unit','price','visit_duration_minutes','services_included','is_active',
                  'service_type','frequency_days','price_type','unit_label','estimated_hours','crew_size','tasks']
  const setClauses: string[] = []
  const vals: any[] = []
  fields.forEach(f => {
    if (body[f] !== undefined) {
      setClauses.push(`${f}=?`)
      // tasks is a TEXT JSON column; the builder sends an array.
      vals.push(f === 'tasks' && typeof body[f] !== 'string' ? JSON.stringify(body[f] || []) : body[f])
      if (f === 'price') { setClauses.push('price_cents=?'); vals.push(Math.round(Number(body[f]) * 100)) }
    }
  })
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
  await ensurePortfolioSchema(db)
  const status   = c.req.query('status')
  const upcoming = c.req.query('upcoming') // '1' = only next 30 days
  let sql = `
    SELECT cs.*, rp.name as plan_name, rp.frequency, rp.frequency_unit, rp.price_cents / 100.0 as plan_price,
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
  await ensurePortfolioSchema(db)
  const subId = parseInt(c.req.param('id'))
  const sub = await db.prepare(`
    SELECT cs.*, rp.name as plan_name, rp.frequency, rp.frequency_unit, rp.price_cents / 100.0 as plan_price,
           cl.name as client_display_name, cl.phone as client_phone
    FROM client_plan_subscriptions cs
    LEFT JOIN recurring_plans rp ON rp.id = cs.plan_id
    LEFT JOIN clients cl ON cl.id = cs.client_id
    WHERE cs.id=? AND cs.company_id=?`).bind(subId, companyId).first()
  if (!sub) return c.json({ error: 'Not found' }, 404)
  // Also fetch visit history
  // Was ORDER BY visit_date — no such column on plan_visits, so this endpoint
  // errored for any subscription that existed. The real column is scheduled_date.
  const visits = await db.prepare(`SELECT * FROM plan_visits WHERE subscription_id=? ORDER BY scheduled_date DESC LIMIT 50`).bind(subId).all()
  return c.json({ ...sub, visits: visits.results || [] })
})

// POST /api/recurring-subscriptions — create subscription
app.post('/api/recurring-subscriptions', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const body = await c.req.json() as any
  const { plan_id, client_id, client_name, start_date, next_visit_date, notes } = body
  // The enrolment form posts `custom_price` (matching the column name) while this
  // handler only ever read `price_override`, so a per-client price typed into the
  // modal was silently discarded and the plan's list price used instead. Accept
  // both: `custom_price` is what the UI sends, `price_override` is kept working
  // for anything already calling the API.
  const price_override = body.custom_price ?? body.price_override
  if (!plan_id || !client_id) return c.json({ error: 'plan_id and client_id required' }, 400)
  // Verify plan belongs to this company
  const plan = await db.prepare(`SELECT * FROM recurring_plans WHERE id=? AND company_id=?`).bind(plan_id, companyId).first() as any
  if (!plan) return c.json({ error: 'Plan not found' }, 404)
  const id = Date.now()
  const startDate = start_date || new Date().toISOString().split('T')[0]
  const nextVisit = next_visit_date || startDate
  // price_override (if given) is fresh request input, converted once; falling
  // back to the plan's own price reads plan.price_cents directly rather than
  // round-tripping through the float plan.price column.
  const finalPriceCents = price_override != null ? Math.round(Number(price_override) * 100) : Number(plan.price_cents || 0)
  const finalPrice = finalPriceCents / 100
  // Was writing to price_override, which isn't a real column on
  // client_plan_subscriptions (the real one is custom_price) -- this INSERT
  // always failed. Fixed as part of adding custom_price_cents (Stage 2 of
  // the money-representation migration, 2026-08-10): there was no working
  // custom_price write to dual-write alongside otherwise.
  await db.prepare(`
    INSERT INTO client_plan_subscriptions (id, company_id, plan_id, client_id, client_name, start_date, next_visit_date, custom_price, custom_price_cents, notes, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,'active')
  `).bind(id, companyId, plan_id, client_id, client_name||'', startDate, nextVisit, finalPrice, finalPriceCents, notes||'').run()
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
  // price_override -> custom_price: see the matching note on the POST
  // handler above (create).
  const fields = ['status','next_visit_date','notes']
  const setClauses: string[] = []
  const vals: any[] = []
  fields.forEach(f => { if (body[f] !== undefined) { setClauses.push(`${f}=?`); vals.push(body[f]) } })
  // Accepts both keys for the same reason as the POST above.
  const priceInput = body.custom_price ?? body.price_override
  if (priceInput !== undefined) {
    setClauses.push('custom_price=?'); vals.push(priceInput)
    setClauses.push('custom_price_cents=?'); vals.push(Math.round(Number(priceInput) * 100))
  }
  if (!setClauses.length) return c.json({ error: 'No fields to update' }, 400)
  // `cancelled_at` is not a column on client_plan_subscriptions, so writing it
  // made every cancellation fail outright. The cancellation date is recoverable
  // from updated_at, which the UPDATE already sets, so this drops the write
  // rather than adding a column nothing reads.
  if (body.status === 'cancelled') { setClauses.push("updated_at=datetime('now')") }
  vals.push(subId, companyId)
  await db.prepare(`UPDATE client_plan_subscriptions SET ${setClauses.join(',')} WHERE id=? AND company_id=?`).bind(...vals).run()
  const updated = await db.prepare(`SELECT * FROM client_plan_subscriptions WHERE id=?`).bind(subId).first()
  return c.json(updated)
})

/**
 * Days between visits for a subscription's plan.
 *
 * Single source of truth for cadence. There used to be two implementations that
 * disagreed: /complete's named-bucket day map (below), and a /log-visit endpoint
 * that multiplied `frequency` by a unit — but `frequency` holds a string like
 * 'monthly', so `'monthly' * 7` was NaN and the following toISOString() threw.
 * That endpoint was unreachable from the UI and has been deleted; the generator
 * work landing next needs exactly one answer to "when is the next visit", so it
 * lives here.
 *
 * `frequency_days` wins when set, so a custom cadence is honoured; otherwise the
 * named bucket maps to days. Falls back to monthly rather than throwing.
 */
function planFrequencyDays(row: any): number {
  const map: Record<string, number> = {
    weekly: 7, biweekly: 14, monthly: 30, bimonthly: 60,
    quarterly: 91, semiannual: 182, annual: 365,
  }
  const explicit = Number(row?.frequency_days)
  if (Number.isFinite(explicit) && explicit > 0) return Math.trunc(explicit)
  return map[String(row?.frequency || '').toLowerCase()] ?? 30
}

/** Add `days` to a YYYY-MM-DD string, returning YYYY-MM-DD. */
function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// POST /api/recurring-subscriptions/:id/log-visit was DELETED rather than repaired.
//
// It was unreachable — nothing in public/js/recurring_plans.js or anywhere else
// in the client called it — and it was broken three separate ways: it INSERTed
// `visit_date` and `technician_name` (neither is a column on plan_visits), and
// its cadence arithmetic threw before it could return. Every possible call was a
// 500, so there is no caller to preserve compatibility with.
//
// The working path is POST /api/plan-visits/:id/complete below, which records
// actual hours, the checklist state and photos as well as the date. Repairing
// this one would have left a second, thinner completion path for someone to wire
// a button to later, and the two would drift apart again.

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
    // Was an inline copy of the day map plus local-time date maths: `new
    // Date(today + 'T00:00:00')` is midnight in the RUNTIME's zone, and the
    // toISOString() that followed reads it back as UTC, so east of Greenwich
    // every next-visit date landed a day early. planFrequencyDays/addDaysIso are
    // UTC throughout and are the one cadence answer the generator will share.
    nextDateStr = addDaysIso(today, planFrequencyDays(sub))
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

// ── SMS (Twilio) ──────────────────────────────────────────────────────────────
// Per-company two-way texting. Each company configures its own Twilio account
// SID, auth token, and sending number (Settings -> Text Messaging). Outbound
// sends go through the Twilio REST API; delivery receipts and inbound replies
// arrive on per-company webhooks validated with the Twilio request signature.

const SMS_SEGMENT = 160

function smsNormalizePhone(raw: string): string {
  const digits = String(raw || '').replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (String(raw || '').trim().startsWith('+') && digits.length >= 8) return `+${digits}`
  return ''
}

async function smsGetConfig(db: D1Database, companyId: string): Promise<{ sid: string; token: string; from: string }> {
  const rows = await db.prepare(
    "SELECT key, value FROM settings WHERE key IN (?, ?, ?)"
  ).bind(`${companyId}:twilio_account_sid`, `${companyId}:twilio_auth_token`, `${companyId}:twilio_from_number`).all<any>()
  const map: Record<string, string> = {}
  for (const r of rows.results as any[]) map[String(r.key).split(':').slice(1).join(':')] = String(r.value || '')
  return { sid: map.twilio_account_sid || '', token: map.twilio_auth_token || '', from: map.twilio_from_number || '' }
}

// Twilio webhook signature: base64(HMAC-SHA1(url + sortedParamsConcat, authToken))
async function smsValidTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string): Promise<boolean> {
  try {
    let data = url
    for (const k of Object.keys(params).sort()) data += k + params[k]
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
    const expected = btoa(String.fromCharCode(...new Uint8Array(mac)))
    return expected === signature
  } catch { return false }
}

async function smsFindOrCreateConversation(db: D1Database, companyId: string, phone: string, hints?: { name?: string; clientId?: string; oppId?: string }): Promise<any> {
  let conv = await db.prepare('SELECT * FROM sms_conversations WHERE company_id=? AND phone_e164=? LIMIT 1').bind(companyId, phone).first<any>()
  if (conv) {
    // Backfill identity hints if the conversation was created from a bare number
    if ((hints?.name && !conv.display_name) || (hints?.clientId && !conv.client_id) || (hints?.oppId && !conv.opp_id)) {
      await db.prepare('UPDATE sms_conversations SET display_name=CASE WHEN display_name=\'\' THEN ? ELSE display_name END, client_id=CASE WHEN client_id=\'\' THEN ? ELSE client_id END, opp_id=CASE WHEN opp_id=\'\' THEN ? ELSE opp_id END WHERE id=?')
        .bind(hints?.name || '', hints?.clientId || '', hints?.oppId || '', conv.id).run()
      conv = await db.prepare('SELECT * FROM sms_conversations WHERE id=?').bind(conv.id).first<any>()
    }
    return conv
  }
  // Try to identify the client by phone digits
  let name = hints?.name || '', clientId = hints?.clientId || ''
  if (!name) {
    const digits = phone.replace(/\D/g, '').slice(-10)
    if (digits.length === 10) {
      const client = await db.prepare(
        "SELECT id, name FROM clients WHERE company_id=? AND replace(replace(replace(replace(phone,'-',''),'(',''),')',''),' ','') LIKE ? LIMIT 1"
      ).bind(companyId, `%${digits}`).first<any>()
      if (client) { name = client.name || ''; clientId = clientId || client.id }
    }
  }
  const id = 'smsc_' + uid()
  await db.prepare(
    "INSERT INTO sms_conversations (id, company_id, phone_e164, display_name, client_id, opp_id) VALUES (?,?,?,?,?,?)"
  ).bind(id, companyId, phone, name, clientId, hints?.oppId || '').run()
  return await db.prepare('SELECT * FROM sms_conversations WHERE id=?').bind(id).first<any>()
}

async function smsTouchConversation(db: D1Database, convId: string, preview: string, direction: string, incrementUnread: boolean): Promise<void> {
  await db.prepare(
    `UPDATE sms_conversations SET last_message_at=datetime('now'), last_message_preview=?, last_direction=?, status='active',
       unread_count=CASE WHEN ? THEN unread_count+1 ELSE unread_count END WHERE id=?`
  ).bind(String(preview || '').slice(0, 140), direction, incrementUnread ? 1 : 0, convId).run()
}

// GET /api/sms/status — is texting configured for this company?
app.get('/api/sms/status', requireAuth, async (c) => {
  const cfg = await smsGetConfig(c.env.DB, c.var.companyId as string)
  return json(c, { configured: !!(cfg.sid && cfg.token && cfg.from), from_number: cfg.from })
})

// GET /api/sms/config — admin view of config (token redacted)
app.get('/api/sms/config', requireAuth, async (c) => {
  const role = c.var.role as string
  if (role !== 'admin' && role !== 'office_manager' && !c.var.isSuperAdmin) return err(c, 'Admin access required', 403)
  const cfg = await smsGetConfig(c.env.DB, c.var.companyId as string)
  return json(c, { account_sid: cfg.sid, from_number: cfg.from, token_set: !!cfg.token })
})

// PUT /api/sms/config — save Twilio credentials for the company
app.put('/api/sms/config', requireAuth, async (c) => {
  const role = c.var.role as string
  if (role !== 'admin' && role !== 'office_manager' && !c.var.isSuperAdmin) return err(c, 'Admin access required', 403)
  const companyId = c.var.companyId as string
  const b = await c.req.json()
  const sets: Array<[string, string]> = []
  if (b.account_sid !== undefined) sets.push(['twilio_account_sid', String(b.account_sid).trim()])
  if (b.auth_token !== undefined && String(b.auth_token).trim() !== '') sets.push(['twilio_auth_token', String(b.auth_token).trim()])
  if (b.from_number !== undefined) {
    const from = smsNormalizePhone(String(b.from_number))
    if (String(b.from_number).trim() && !from) return err(c, 'From number must be a valid phone number', 400)
    sets.push(['twilio_from_number', from])
  }
  for (const [k, v] of sets) {
    await c.env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))")
      .bind(`${companyId}:${k}`, v).run()
  }
  const cfg = await smsGetConfig(c.env.DB, companyId)
  return json(c, { configured: !!(cfg.sid && cfg.token && cfg.from), from_number: cfg.from })
})

// POST /api/sms/send — send a text (creates/reuses the conversation thread)
app.post('/api/sms/send', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const b = await c.req.json()
  const body = String(b.body || '').trim()
  if (!body) return err(c, 'Message body required', 400)
  if (body.length > 1600) return err(c, 'Message too long (max 1600 characters)', 400)
  const to = smsNormalizePhone(String(b.to || ''))
  if (!to) return err(c, 'A valid destination phone number is required', 400)
  const cfg = await smsGetConfig(c.env.DB, companyId)
  const mock = (c.env as any).SMS_MOCK === '1'
  if (!mock && !(cfg.sid && cfg.token && cfg.from)) return err(c, 'Text messaging is not configured. Add Twilio credentials in Settings.', 503)

  const conv = await smsFindOrCreateConversation(c.env.DB, companyId, to, {
    name: String(b.to_name || ''), clientId: String(b.client_id || ''), oppId: String(b.opp_id || '')
  })
  const msgId = 'smsm_' + uid()
  const repId = String(c.var.repId || '')
  await c.env.DB.prepare(
    "INSERT INTO sms_messages (id, company_id, conversation_id, direction, body, from_number, to_number, status, rep_id) VALUES (?,?,?,?,?,?,?,'queued',?)"
  ).bind(msgId, companyId, conv.id, 'out', body, cfg.from || 'mock', to, repId).run()

  let status = 'sent', twilioSid = '', errorCode = '', errorMessage = ''
  if (mock) {
    twilioSid = 'SM_mock_' + uid()
  } else {
    try {
      const origin = new URL(c.req.url).origin
      const form = new URLSearchParams({
        To: to, From: cfg.from, Body: body,
        StatusCallback: `${origin}/api/sms/webhook/status/${companyId}`
      })
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.sid}/Messages.json`, {
        method: 'POST',
        headers: { 'Authorization': 'Basic ' + btoa(`${cfg.sid}:${cfg.token}`), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString()
      })
      const data: any = await res.json().catch(() => ({}))
      if (res.ok) {
        twilioSid = String(data.sid || '')
        status = String(data.status || 'sent')
        if (status === 'queued' || status === 'accepted') status = 'sent'
      } else {
        status = 'failed'
        errorCode = String(data.code || res.status)
        errorMessage = String(data.message || 'Twilio request failed')
      }
    } catch (e: any) {
      status = 'failed'
      errorMessage = String(e?.message || 'Network error reaching Twilio')
    }
  }
  await c.env.DB.prepare(
    "UPDATE sms_messages SET status=?, twilio_sid=?, error_code=?, error_message=?, updated_at=datetime('now') WHERE id=?"
  ).bind(status, twilioSid, errorCode, errorMessage, msgId).run()
  await smsTouchConversation(c.env.DB, conv.id, body, 'out', false)

  // Mirror into the opportunity communications timeline when linked
  const oppId = String(b.opp_id || conv.opp_id || '')
  if (oppId && status !== 'failed') {
    await c.env.DB.prepare(
      "INSERT INTO communications (id, opp_id, rep_id, type, direction, subject, body, ts, company_id) VALUES (?,?,?,?,?,?,?,datetime('now'),?)"
    ).bind('comm_' + uid(), oppId, repId || null, 'sms', 'out', '', body, companyId).run()
  }
  if (status === 'failed') return err(c, errorMessage || 'Send failed', 502)
  return json(c, { id: msgId, conversation_id: conv.id, status, twilio_sid: twilioSid }, 201)
})

// GET /api/sms/conversations — inbox list (search + unread filter)
app.get('/api/sms/conversations', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const search = String(c.req.query('q') || '').trim()
  const unreadOnly = c.req.query('unread') === '1'
  let q = 'SELECT * FROM sms_conversations WHERE company_id=?'
  const binds: any[] = [companyId]
  if (unreadOnly) q += ' AND unread_count > 0'
  if (search) {
    q += ' AND (display_name LIKE ? OR phone_e164 LIKE ? OR last_message_preview LIKE ?)'
    binds.push(`%${search}%`, `%${search}%`, `%${search}%`)
  }
  q += " ORDER BY CASE WHEN last_message_at='' THEN created_at ELSE last_message_at END DESC LIMIT 200"
  const rows = await c.env.DB.prepare(q).bind(...binds).all()
  return json(c, rows.results)
})

// GET /api/sms/conversations/:id/messages — thread (marks as read)
app.get('/api/sms/conversations/:id/messages', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const convId = c.req.param('id')
  const conv = await c.env.DB.prepare('SELECT * FROM sms_conversations WHERE id=? AND company_id=?').bind(convId, companyId).first<any>()
  if (!conv) return err(c, 'Conversation not found', 404)
  const rows = await c.env.DB.prepare(
    'SELECT * FROM sms_messages WHERE conversation_id=? AND company_id=? ORDER BY created_at ASC, id ASC LIMIT 500'
  ).bind(convId, companyId).all()
  if (Number(conv.unread_count) > 0) {
    await c.env.DB.prepare('UPDATE sms_conversations SET unread_count=0 WHERE id=?').bind(convId).run()
  }
  return json(c, { conversation: conv, messages: rows.results })
})

// POST /api/sms/conversations/:id/archive
app.post('/api/sms/conversations/:id/archive', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  await c.env.DB.prepare("UPDATE sms_conversations SET status='archived', unread_count=0 WHERE id=? AND company_id=?")
    .bind(c.req.param('id'), companyId).run()
  return json(c, { ok: true })
})

// ── SMS templates ──
app.get('/api/sms/templates', requireAuth, async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM sms_templates WHERE company_id=? ORDER BY name').bind(c.var.companyId as string).all()
  return json(c, rows.results)
})
app.post('/api/sms/templates', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const b = await c.req.json()
  if (!String(b.name || '').trim() || !String(b.body || '').trim()) return err(c, 'Name and body required', 400)
  const id = 'smst_' + uid()
  await c.env.DB.prepare(
    'INSERT INTO sms_templates (id, company_id, name, body, category, created_by) VALUES (?,?,?,?,?,?)'
  ).bind(id, companyId, String(b.name).trim(), String(b.body).trim(), String(b.category || 'general'), String(c.var.repId || '')).run()
  return json(c, { id }, 201)
})
app.put('/api/sms/templates/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const b = await c.req.json()
  await c.env.DB.prepare(
    "UPDATE sms_templates SET name=COALESCE(?,name), body=COALESCE(?,body), category=COALESCE(?,category), updated_at=datetime('now') WHERE id=? AND company_id=?"
  ).bind(b.name != null ? String(b.name).trim() : null, b.body != null ? String(b.body).trim() : null, b.category != null ? String(b.category) : null, c.req.param('id'), companyId).run()
  return json(c, { ok: true })
})
app.delete('/api/sms/templates/:id', requireAuth, async (c) => {
  await c.env.DB.prepare('DELETE FROM sms_templates WHERE id=? AND company_id=?').bind(c.req.param('id'), c.var.companyId as string).run()
  return json(c, { ok: true })
})

// GET /api/sms/errors — failed and undelivered messages (error log)
app.get('/api/sms/errors', requireAuth, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT m.*, v.display_name, v.phone_e164 FROM sms_messages m
     JOIN sms_conversations v ON v.id = m.conversation_id
     WHERE m.company_id=? AND m.status IN ('failed','undelivered')
     ORDER BY m.created_at DESC LIMIT 200`
  ).bind(c.var.companyId as string).all()
  return json(c, rows.results)
})

// GET /api/sms/unread-count — badge for nav
app.get('/api/sms/unread-count', requireAuth, async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(unread_count),0) AS n FROM sms_conversations WHERE company_id=? AND status='active'"
  ).bind(c.var.companyId as string).first<any>()
  return json(c, { unread: Number(row?.n || 0) })
})

// ── Twilio webhooks (no session auth; validated by Twilio signature) ──

// POST /api/sms/webhook/status/:companyId — delivery receipts
app.post('/api/sms/webhook/status/:companyId', async (c) => {
  const companyId = c.req.param('companyId')
  const cfg = await smsGetConfig(c.env.DB, companyId)
  const form = await c.req.parseBody()
  const params: Record<string, string> = {}
  for (const [k, v] of Object.entries(form)) params[k] = String(v)
  const mock = (c.env as any).SMS_MOCK === '1'
  if (!mock) {
    if (!cfg.token) return c.text('no config', 403)
    const ok = await smsValidTwilioSignature(cfg.token, c.req.url, params, c.req.header('X-Twilio-Signature') || '')
    if (!ok) return c.text('invalid signature', 403)
  }
  const sid = params.MessageSid || params.SmsSid || ''
  const status = params.MessageStatus || params.SmsStatus || ''
  if (sid && status) {
    await c.env.DB.prepare(
      "UPDATE sms_messages SET status=?, error_code=COALESCE(NULLIF(?,''), error_code), error_message=COALESCE(NULLIF(?,''), error_message), updated_at=datetime('now') WHERE twilio_sid=? AND company_id=?"
    ).bind(status, params.ErrorCode || '', params.ErrorMessage || '', sid, companyId).run()
  }
  return c.text('ok')
})

// POST /api/sms/webhook/inbound/:companyId — incoming replies
app.post('/api/sms/webhook/inbound/:companyId', async (c) => {
  const companyId = c.req.param('companyId')
  const cfg = await smsGetConfig(c.env.DB, companyId)
  const form = await c.req.parseBody()
  const params: Record<string, string> = {}
  for (const [k, v] of Object.entries(form)) params[k] = String(v)
  const mock = (c.env as any).SMS_MOCK === '1'
  if (!mock) {
    if (!cfg.token) return c.text('no config', 403)
    const ok = await smsValidTwilioSignature(cfg.token, c.req.url, params, c.req.header('X-Twilio-Signature') || '')
    if (!ok) return c.text('invalid signature', 403)
  }
  const from = smsNormalizePhone(params.From || '')
  const body = String(params.Body || '').trim()
  if (from && body) {
    const conv = await smsFindOrCreateConversation(c.env.DB, companyId, from)
    await c.env.DB.prepare(
      "INSERT INTO sms_messages (id, company_id, conversation_id, direction, body, from_number, to_number, status, twilio_sid) VALUES (?,?,?,?,?,?,?,'received',?)"
    ).bind('smsm_' + uid(), companyId, conv.id, 'in', body, from, params.To || cfg.from, params.MessageSid || '').run()
    await smsTouchConversation(c.env.DB, conv.id, body, 'in', true)
    // Mirror inbound texts into the opportunity timeline when the thread is linked
    if (conv.opp_id) {
      await c.env.DB.prepare(
        "INSERT INTO communications (id, opp_id, rep_id, type, direction, subject, body, ts, company_id) VALUES (?,?,?,?,?,?,?,datetime('now'),?)"
      ).bind('comm_' + uid(), conv.opp_id, null, 'sms', 'in', '', body, companyId).run()
    }
  }
  // Empty TwiML response — no auto-reply
  return c.body('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', 200, { 'Content-Type': 'text/xml' })
})

// ── EMAIL (SendGrid) ─────────────────────────────────────────────────────────

// GET /api/email/status — check if SendGrid is configured
app.get('/api/email/status', requireAuth, async (c) => {
  const configured = !!(c.env as any).SENDGRID_API_KEY
  return c.json({ configured })
})

// ── CUSTOM EMAIL TEMPLATES (My Templates) ────────────────────────────────────

// GET /api/email-templates — list company's custom templates
app.get('/api/email-templates', requireAuth, async (c) => {
  const db = c.env.DB as D1Database
  await ensureEmailTplSchema(db)
  const rows = await db.prepare(
    `SELECT * FROM email_templates WHERE company_id=? ORDER BY updated_at DESC`
  ).bind(c.var.companyId as string).all()
  return c.json({ templates: rows.results || [] })
})

// POST /api/email-templates — create a template
app.post('/api/email-templates', requireAuth, async (c) => {
  const db = c.env.DB as D1Database
  await ensureEmailTplSchema(db)
  const b = await c.req.json() as any
  const title = (b.title || '').trim()
  if (!title) return c.json({ error: 'title required' }, 400)
  const id = `etpl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  await db.prepare(
    `INSERT INTO email_templates (id, company_id, title, category, subject, body, created_by)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(id, c.var.companyId as string, title, (b.category || 'My Templates').trim() || 'My Templates',
         b.subject || '', b.body || '', c.var.repId as string).run()
  return c.json({ ok: true, id }, 201)
})

// PUT /api/email-templates/:id — update a template
app.put('/api/email-templates/:id', requireAuth, async (c) => {
  const db = c.env.DB as D1Database
  await ensureEmailTplSchema(db)
  const id = c.req.param('id')
  const b = await c.req.json() as any
  const existing = await db.prepare(`SELECT id FROM email_templates WHERE id=? AND company_id=? LIMIT 1`)
    .bind(id, c.var.companyId as string).first()
  if (!existing) return c.json({ error: 'not found' }, 404)
  await db.prepare(
    `UPDATE email_templates SET title=?, category=?, subject=?, body=?, updated_at=datetime('now')
     WHERE id=? AND company_id=?`
  ).bind((b.title || '').trim() || 'Untitled', (b.category || 'My Templates').trim() || 'My Templates',
         b.subject || '', b.body || '', id, c.var.companyId as string).run()
  return c.json({ ok: true })
})

// DELETE /api/email-templates/:id — delete a template
app.delete('/api/email-templates/:id', requireAuth, async (c) => {
  const db = c.env.DB as D1Database
  await ensureEmailTplSchema(db)
  await db.prepare(`DELETE FROM email_templates WHERE id=? AND company_id=?`)
    .bind(c.req.param('id'), c.var.companyId as string).run()
  return c.json({ ok: true })
})

// GET /api/service-packages — list company's saved packages (Schedule board's
// visit editor "Add Package" picker)
app.get('/api/service-packages', requireAuth, async (c) => {
  const db = c.env.DB as D1Database
  await ensureServicePackagesSchema(db)
  const rows = await db.prepare(
    `SELECT * FROM service_packages WHERE company_id=? ORDER BY updated_at DESC`
  ).bind(c.var.companyId as string).all()
  return c.json({ packages: rows.results || [] })
})

// POST /api/service-packages — create a package
app.post('/api/service-packages', requireAuth, async (c) => {
  const db = c.env.DB as D1Database
  await ensureServicePackagesSchema(db)
  const b = await c.req.json() as any
  const name = (b.name || '').trim()
  if (!name) return c.json({ error: 'name required' }, 400)
  const id = `pkg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  await db.prepare(
    `INSERT INTO service_packages (id, company_id, name, category, materials, equipment, checklist, created_by)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(id, c.var.companyId as string, name, (b.category || 'My Packages').trim() || 'My Packages',
         JSON.stringify(b.materials || []), JSON.stringify(b.equipment || []), JSON.stringify(b.checklist || []),
         c.var.repId as string).run()
  return c.json({ ok: true, id }, 201)
})

// PUT /api/service-packages/:id — update a package
app.put('/api/service-packages/:id', requireAuth, async (c) => {
  const db = c.env.DB as D1Database
  await ensureServicePackagesSchema(db)
  const id = c.req.param('id')
  const b = await c.req.json() as any
  const existing = await db.prepare(`SELECT id FROM service_packages WHERE id=? AND company_id=? LIMIT 1`)
    .bind(id, c.var.companyId as string).first()
  if (!existing) return c.json({ error: 'not found' }, 404)
  await db.prepare(
    `UPDATE service_packages SET name=?, category=?, materials=?, equipment=?, checklist=?, updated_at=datetime('now')
     WHERE id=? AND company_id=?`
  ).bind((b.name || '').trim() || 'Untitled', (b.category || 'My Packages').trim() || 'My Packages',
         JSON.stringify(b.materials || []), JSON.stringify(b.equipment || []), JSON.stringify(b.checklist || []),
         id, c.var.companyId as string).run()
  return c.json({ ok: true })
})

// DELETE /api/service-packages/:id — delete a package
app.delete('/api/service-packages/:id', requireAuth, async (c) => {
  const db = c.env.DB as D1Database
  await ensureServicePackagesSchema(db)
  await db.prepare(`DELETE FROM service_packages WHERE id=? AND company_id=?`)
    .bind(c.req.param('id'), c.var.companyId as string).run()
  return c.json({ ok: true })
})

// ── Branded company email composer + sender ──────────────────────────────────
// Shared by POST /api/email/send and the server-side estimate send. Composes a
// company-branded HTML email (logo header, CTA button promoted from the first
// URL in the body, footer) and delivers via SendGrid.
async function sendCompanyEmail(c: any, db: D1Database, opts: {
  companyId: string; repId?: string;
  to: string; cc?: string; subject: string; body: string; entityType?: string;
}): Promise<{ sent: boolean; fallback?: boolean }> {
  const apiKey = (c.env as any).SENDGRID_API_KEY as string | undefined
  if (!apiKey) return { sent: false, fallback: true }
  const { companyId, to, cc, subject, body: msgBody, entityType } = opts

  // Brand the email with the sender's company (and reply-to their own address)
  const co = await db.prepare(`SELECT name, logo_url, brand_color, phone, website FROM companies WHERE id=? LIMIT 1`).bind(companyId).first<any>().catch(() => null)
  const rep = opts.repId ? await db.prepare(`SELECT email, name FROM reps WHERE id=? AND company_id=? LIMIT 1`).bind(opts.repId, companyId).first<any>().catch(() => null) : null
  const coName = (co && co.name) || 'Groundwork CRM'
  const esc = (s: string) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  const bc = (co && /^#[0-9a-fA-F]{3,8}$/.test(co.brand_color || '') ? co.brand_color : '#2D7A55')
  // Logo for email: hosted URLs pass through; base64 data-URL uploads (the CRM's
  // Choose File flow) are served via the public logo endpoint — email clients
  // strip inline data: images, so we must reference a real https URL.
  const luRaw = (co && co.logo_url) || ''
  const reqUrl = new URL(c.req.url)
  const logo = /^https?:\/\//.test(luRaw) ? luRaw
    : /^data:image\//.test(luRaw) ? `${reqUrl.origin}/api/branding/logo/${companyId}`
    : ''

  // Pull the first portal/CTA link out of the body and promote it to a button.
  // The paragraph that is *only* that URL gets dropped from the text (no dupes).
  const urlRe = /(https?:\/\/[^\s]+)/
  const ctaMatch = msgBody.match(urlRe)
  const ctaUrl = ctaMatch ? ctaMatch[1] : ''
  let textBody = msgBody
  if (ctaUrl) {
    textBody = textBody.split('\n').filter((l: string) => l.trim() !== ctaUrl).join('\n')
      .replace(/\n{3,}/g, '\n\n').trim()
  }
  const ctaLabel = entityType === 'proposal' ? 'View Your Proposal'
    : entityType === 'invoice' ? 'View & Pay Invoice'
    : entityType === 'estimate' ? 'View Your Estimate'
    : 'View Details'

  // Escape remaining text, auto-link any other URLs
  const linked = esc(textBody).replace(/(https?:\/\/[^\s]+)/g, `<a href="$1" style="color:${bc};font-weight:600">$1</a>`)

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F2F4F3">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F4F3;padding:32px 12px"><tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">
      <tr><td style="background:${bc};padding:26px 32px" align="left">
        ${logo
          ? `<img src="${esc(logo)}" alt="${esc(coName)}" height="44" style="display:inline-block;max-height:44px;width:auto;border:0;background:#ffffff;padding:8px 14px;border-radius:10px">`
          : `<span style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;font-size:20px;font-weight:800;color:#ffffff;letter-spacing:.3px">${esc(coName)}</span>`}
      </td></tr>
      <tr><td style="padding:32px 32px 8px">
        <div style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.7;color:#374151;white-space:pre-wrap">${linked}</div>
      </td></tr>
      ${ctaUrl ? `
      <tr><td style="padding:22px 32px 30px" align="center">
        <a href="${esc(ctaUrl)}" style="display:inline-block;background:${bc};color:#ffffff;font-family:-apple-system,'Segoe UI',Arial,sans-serif;font-size:15px;font-weight:700;text-decoration:none;padding:13px 34px;border-radius:9px">${ctaLabel}</a>
        <div style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;font-size:11px;color:#9CA3AF;margin-top:12px">Or copy this link: <a href="${esc(ctaUrl)}" style="color:${bc}">${esc(ctaUrl)}</a></div>
      </td></tr>` : ''}
      <tr><td style="padding:18px 32px;border-top:1px solid #E9ECEB;background:#FAFBFA">
        <div style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;font-size:12px;color:#6B7280;font-weight:600">${esc(coName)}</div>
        <div style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;font-size:11px;color:#9CA3AF;margin-top:2px">
          ${[co?.phone, co?.website].filter(Boolean).map(esc).join(' · ')}
        </div>
        <div style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;font-size:10px;color:#C2C8C5;margin-top:8px">Sent via Groundwork CRM</div>
      </td></tr>
    </table>
  </td></tr></table>
  </body></html>`

  const sent = await sendEmail(apiKey, to, subject, html, { cc: cc || undefined, fromName: coName, replyTo: (rep && rep.email) || undefined })
  return { sent }
}

// POST /api/email/send — send a transactional email
app.post('/api/email/send', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const body = await c.req.json() as any
  const { to_email, cc_email, subject, body: msgBody, entity_type } = body
  if (!to_email || !subject || !msgBody) return c.json({ error: 'to_email, subject, body required' }, 400)

  const r = await sendCompanyEmail(c, db, {
    companyId, repId: c.var.repId as string,
    to: to_email, cc: cc_email || undefined, subject, body: msgBody, entityType: entity_type,
  })
  if (r.fallback) return c.json({ fallback: true, message: 'SendGrid not configured — use mailto fallback' })
  if (!r.sent) return c.json({ error: 'Email delivery failed' }, 500)
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

// ── LANGUAGE PREFERENCE ──────────────────────────────────────────────────────

// GET /api/me/language — return current rep's preferred language
app.get('/api/me/language', requireAuth, async (c) => {
  const db = c.env.DB as D1Database
  const companyId = c.var.companyId as string
  const repId = c.var.repId as string
  const row: any = await db.prepare(
    'SELECT preferred_language FROM reps WHERE id=? AND company_id=? LIMIT 1'
  ).bind(repId, companyId).first()
  return c.json({ ok: true, language: row?.preferred_language || 'en' })
})

// PATCH /api/me/language — update rep's preferred language
app.patch('/api/me/language', requireAuth, async (c) => {
  const db = c.env.DB as D1Database
  const companyId = c.var.companyId as string
  const repId = c.var.repId as string
  const body: any = await c.req.json()
  const lang = body.language
  if (lang !== 'en' && lang !== 'es') return c.json({ ok: false, error: 'Invalid language. Supported: en, es' }, 400)
  await db.prepare(
    'UPDATE reps SET preferred_language=? WHERE id=? AND company_id=?'
  ).bind(lang, repId, companyId).run()
  return c.json({ ok: true, language: lang })
})

// ── ESTIMATE PORTAL (public — no auth) ───────────────────────────────────────

// GET /estimates/portal/:token — public estimate approval page
app.get('/estimates/portal/:token', async (c) => {
  const token = c.req.param('token')
  const db = c.env.DB as D1Database
  // Look up token — supports two token types:
  //  1) estimate_portal_tokens rows (ept_...) created via /api/estimates/:id/portal-token
  //  2) the estimate row's own portal_token column (used by "Copy portal link" and email links)
  let pt = await db.prepare(`SELECT * FROM estimate_portal_tokens WHERE token=?`).bind(token).first() as any
  let est: any = null
  if (pt) {
    est = await db.prepare(`SELECT * FROM estimates WHERE id=? AND company_id=?`).bind(pt.estimate_id, pt.company_id).first() as any
  } else {
    est = await db.prepare(`SELECT * FROM estimates WHERE portal_token=? LIMIT 1`).bind(token).first() as any
    if (est) pt = { estimate_id: est.id, company_id: est.company_id }
  }
  if (!pt) return c.html(`<html><body style="font-family:sans-serif;text-align:center;padding:60px">
    <h2>Link not found</h2><p>This estimate link is invalid or has expired.</p></body></html>`, 404)
  if (!est) return c.html(`<html><body style="font-family:sans-serif;text-align:center;padding:60px">
    <h2>Estimate not found</h2></body></html>`, 404)
  const company = await db.prepare(`SELECT * FROM companies WHERE id=?`).bind(pt.company_id).first() as any

  const statusLabel = { draft:'Draft', sent:'Sent', approved:'Approved ✓', declined:'Declined', expired:'Expired' }[est.status] || est.status
  const canAct = ['sent','draft'].includes(est.status)
  const lineItems = (() => { try { return JSON.parse(est.line_items||'[]') } catch { return [] } })()
  const total = (Number(est.total_cents || 0) / 100) || lineItems.reduce((s: number, i: any) => s + (Number(i.qty||1) * Number(i.rate ?? i.unit_price ?? i.unit ?? 0)), 0)

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
    .portal-card-header{background:${company?.brand_color || '#2D7A55'};padding:20px 24px}
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
  <div class="portal-logo">${company?.logo_url ? `<img src="${company.logo_url}" alt="" style="height:40px;object-fit:contain;border-radius:8px;margin-right:4px;background:#fff;padding:5px 10px">` : ''}${company?.name || 'Groundwork'}</div>
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

    ${lineItems.length ? (est.price_display === 'total_only' ? `
    <div class="portal-section">
      <div style="text-align:center;padding:6px 0 14px">
        <div style="font-size:12px;color:#9CA3AF;letter-spacing:.05em;text-transform:uppercase;font-weight:600;margin-bottom:4px">Total Investment</div>
        <div style="font-size:32px;font-weight:800;color:#111827">$${total.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
      </div>
      <div class="portal-label" style="margin-bottom:10px">What's Included</div>
      ${lineItems.map((li: any) => `
      <div style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid #F3F4F6">
        <span style="color:${company?.brand_color || '#2D7A55'};font-weight:800;line-height:1.4">&#10003;</span>
        <div>
          <div style="font-size:14px;color:#111827;font-weight:600">${li.name||li.description||'Service'}</div>
          ${li.desc ? `<div style="font-size:12.5px;color:#6B7280;margin-top:2px">${li.desc}</div>` : ''}
        </div>
      </div>`).join('')}
    </div>` : `
    <div class="portal-section">
      <div class="portal-label" style="margin-bottom:12px">Line Items</div>
      <table>
        <thead><tr><th>Item</th><th>Qty</th><th style="text-align:right">Total</th></tr></thead>
        <tbody>
          ${lineItems.map((li: any) => {
            const qty = Number(li.qty||1)
            const price = Number(li.rate ?? li.unit_price ?? li.unit ?? 0)
            return `<tr>
              <td>${li.name||li.description||'Service'}</td>
              <td>${qty}</td>
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
    </div>`) : ''}

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

// GET /portal/estimate/:token — alias for the estimate portal (this is the URL
// format that the "Copy portal link" button and emailed links use)
app.get('/portal/estimate/:token', (c) => {
  return c.redirect(`/estimates/portal/${c.req.param('token')}`, 302)
})

// GET /invoices/portal/:token — public client-facing invoice page (no auth)
app.get('/invoices/portal/:token', async (c) => {
  const token = c.req.param('token')
  const db = c.env.DB as D1Database
  const inv: any = await db.prepare(`SELECT * FROM invoices WHERE portal_token=? LIMIT 1`).bind(token).first()
  if (!inv) return c.html(`<html><body style="font-family:sans-serif;text-align:center;padding:60px">
    <h2>Link not found</h2><p>This invoice link is invalid or has expired.</p></body></html>`, 404)
  // Mark viewed
  if (inv.status === 'sent') {
    await db.prepare(`UPDATE invoices SET status='viewed', viewed_at=datetime('now') WHERE portal_token=?`).bind(token).run()
    inv.status = 'viewed'
  }
  let lineItems: any[] = []
  try { lineItems = JSON.parse(inv.line_items || '[]') } catch {}
  const company: any = await db.prepare(`SELECT name, logo_url, brand_color, phone, website FROM companies WHERE id=? LIMIT 1`).bind(inv.company_id).first().catch(() => null)
  const stripeReady: any = await db.prepare(`SELECT stripe_account_id, stripe_onboarded FROM companies WHERE id=? LIMIT 1`).bind(inv.company_id).first().catch(() => null)
  const canPayOnline = !!(stripeReady?.stripe_account_id && stripeReady?.stripe_onboarded && (c.env as any).STRIPE_SECRET_KEY)
  const esc2 = (v: any) => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  const bc = (company && /^#[0-9a-fA-F]{3,8}$/.test(company.brand_color || '') ? company.brand_color : '#2D7A55')
  const total = Number(inv.total_cents || 0) / 100
  const paid = Number(inv.amount_paid_cents || 0) / 100
  const owed = Math.max(0, Number(inv.total_cents || 0) - Number(inv.amount_paid_cents || 0)) / 100
  const isPaid = inv.status === 'paid' || (total > 0 && owed <= 0)
  const statusLabel = isPaid ? 'Paid' : inv.status === 'partial' ? 'Partially Paid' : inv.status === 'overdue' ? 'Overdue' : 'Due'
  const fmt = (n: number) => '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return c.html(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Invoice ${esc2(inv.invoice_number)} — ${esc2(company?.name || 'Groundwork')}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F9FAFB;color:#111827}
    .portal-header{background:#111827;padding:20px 24px;display:flex;align-items:center;gap:12px}
    .portal-logo{font-size:18px;font-weight:800;color:#fff;display:flex;align-items:center;gap:10px}
    .portal-wrap{max-width:680px;margin:32px auto;padding:0 16px 60px}
    .portal-card{background:#fff;border:1px solid #E5E7EB;border-radius:14px;overflow:hidden;margin-bottom:20px}
    .portal-card-header{background:${bc};padding:20px 24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px}
    .portal-card-title{font-size:20px;font-weight:700;color:#fff}
    .portal-card-sub{font-size:13px;color:rgba(255,255,255,.78);margin-top:4px}
    .status-badge{display:inline-flex;padding:5px 16px;border-radius:99px;font-size:12px;font-weight:700;background:rgba(255,255,255,.92)}
    .status-paid{color:#1E5E3E}.status-due{color:#B45309}.status-overdue{color:#DC2626}
    .portal-section{padding:20px 24px;border-bottom:1px solid #F3F4F6}
    .portal-section:last-child{border-bottom:none}
    .portal-label{font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
    .portal-value{font-size:15px;color:#111827}
    .portal-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    table{width:100%;border-collapse:collapse}
    th{text-align:left;font-size:12px;font-weight:600;color:#6B7280;padding:8px 0;border-bottom:1px solid #E5E7EB}
    td{padding:10px 0;font-size:14px;color:#374151;border-bottom:1px solid #F3F4F6}
    tr:last-child td{border-bottom:none}
    .amount-summary{background:#FAFBFA;border-radius:10px;padding:16px 20px;margin-top:8px}
    .amount-row{display:flex;justify-content:space-between;font-size:14px;color:#4B5563;padding:4px 0}
    .amount-row.owed{font-size:19px;font-weight:800;color:#111827;border-top:1px solid #E5E7EB;margin-top:8px;padding-top:12px}
    .action-section{padding:24px;text-align:center}
    .btn-pay{background:${bc};color:#fff;border:none;border-radius:10px;padding:15px 40px;font-size:16px;font-weight:700;cursor:pointer;transition:.15s}
    .btn-pay:hover{opacity:.9}
    .btn-pay:disabled{opacity:.6;cursor:default}
    .pay-note{font-size:12px;color:#9CA3AF;margin-top:10px}
    .paid-banner{background:#E5F2E9;color:#1E5E3E;border:1px solid #BFDCC8;border-radius:10px;padding:16px;text-align:center;font-weight:700;font-size:15px}
    @media(max-width:480px){.portal-grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
<div class="portal-header">
  <div class="portal-logo">${company?.logo_url ? `<img src="${esc2(company.logo_url)}" alt="" style="height:40px;object-fit:contain;border-radius:8px;background:#fff;padding:5px 10px">` : ''}${esc2(company?.name || 'Groundwork')}</div>
</div>
<div class="portal-wrap">
  <div class="portal-card">
    <div class="portal-card-header">
      <div>
        <div class="portal-card-title">Invoice ${esc2(inv.invoice_number)}</div>
        <div class="portal-card-sub">${esc2(inv.title || '')}</div>
      </div>
      <span class="status-badge ${isPaid ? 'status-paid' : inv.status==='overdue' ? 'status-overdue' : 'status-due'}">${statusLabel}</span>
    </div>
    <div class="portal-section portal-grid">
      <div><div class="portal-label">Billed To</div><div class="portal-value">${esc2(inv.client_name || '—')}</div></div>
      <div><div class="portal-label">Due Date</div><div class="portal-value">${inv.due_date ? esc2(new Date(inv.due_date).toLocaleDateString()) : '—'}</div></div>
    </div>
    ${lineItems.length ? `
    <div class="portal-section">
      <div class="portal-label" style="margin-bottom:12px">Details</div>
      <table>
        <thead><tr><th>Item</th><th>Qty</th><th style="text-align:right">Amount</th></tr></thead>
        <tbody>
          ${lineItems.map((li: any) => {
            const qty = Number(li.qty || li.quantity || 1)
            const rate = Number(li.rate ?? li.unit_price ?? li.price ?? 0)
            const amt = li.amount != null ? Number(li.amount) : qty * rate
            return `<tr><td>${esc2(li.name || li.description || 'Service')}</td><td>${qty}</td><td style="text-align:right">${fmt(amt)}</td></tr>`
          }).join('')}
        </tbody>
      </table>
    </div>` : ''}
    <div class="portal-section">
      <div class="amount-summary">
        <div class="amount-row"><span>Subtotal</span><span>${fmt(Number(inv.subtotal_cents || 0) / 100 || total)}</span></div>
        ${Number(inv.tax_amount_cents||0) ? `<div class="amount-row"><span>Tax</span><span>${fmt(Number(inv.tax_amount_cents) / 100)}</span></div>` : ''}
        ${Number(inv.discount_amount_cents||0) ? `<div class="amount-row"><span>Discount</span><span>-${fmt(Number(inv.discount_amount_cents) / 100)}</span></div>` : ''}
        <div class="amount-row"><span>Total</span><span>${fmt(total)}</span></div>
        ${paid > 0 ? `<div class="amount-row"><span>Paid</span><span>-${fmt(paid)}</span></div>` : ''}
        <div class="amount-row owed"><span>${isPaid ? 'Balance' : 'Amount Due'}</span><span>${fmt(owed)}</span></div>
      </div>
    </div>
    ${inv.notes ? `<div class="portal-section"><div class="portal-label">Notes</div><div class="portal-value" style="line-height:1.6;white-space:pre-wrap">${esc2(inv.notes)}</div></div>` : ''}
    <div class="action-section">
      ${isPaid
        ? `<div class="paid-banner">This invoice has been paid in full. Thank you!</div>`
        : canPayOnline && owed >= 0.5
          ? `<button class="btn-pay" id="payBtn" onclick="_payNow()">Pay ${fmt(owed)} Now</button>
             <div class="pay-note">Secured by Stripe — no card data is stored by ${esc2(company?.name || 'us')}</div>`
          : `<div class="pay-note" style="font-size:14px;color:#4B5563">To pay this invoice, please contact ${esc2(company?.phone || company?.name || 'your contractor')}.</div>`}
      <div id="payError" style="color:#DC2626;font-size:13px;margin-top:10px"></div>
    </div>
  </div>
  <p style="text-align:center;font-size:12px;color:#9CA3AF">
    Questions? Contact ${esc2(company?.phone || company?.name || 'your contractor')} · Powered by Groundwork CRM
  </p>
</div>
<script>
async function _payNow() {
  const btn = document.getElementById('payBtn');
  const errEl = document.getElementById('payError');
  if (btn) { btn.disabled = true; btn.textContent = 'Opening secure checkout…'; }
  if (errEl) errEl.textContent = '';
  try {
    const res = await fetch('/api/invoices/portal/${esc2(token)}/pay', { method: 'POST' });
    const d = await res.json();
    if (d.url) { window.location.href = d.url; return; }
    throw new Error(d.error || 'Could not start checkout');
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Pay Now'; }
    if (errEl) errEl.textContent = e.message || 'Payment failed to start. Please try again.';
  }
}
</script>
</body></html>`)
})

// POST /api/invoices/portal/:token/pay — public: start a Stripe Checkout session
// for this invoice. Token-scoped (no auth) — amount comes from the DB, never the client.
app.post('/api/invoices/portal/:token/pay', async (c) => {
  const token = c.req.param('token')
  const db = c.env.DB as D1Database
  const stripeKey = (c.env as any).STRIPE_SECRET_KEY as string | undefined
  if (!stripeKey) return c.json({ error: 'Online payment is not available' }, 503)
  const inv: any = await db.prepare(`SELECT * FROM invoices WHERE portal_token=? LIMIT 1`).bind(token).first()
  if (!inv) return c.json({ error: 'Invalid link' }, 404)
  const company: any = await db.prepare(`SELECT stripe_account_id, stripe_onboarded, stripe_platform_fee_pct FROM companies WHERE id=? LIMIT 1`).bind(inv.company_id).first()
  if (!company?.stripe_account_id || !company.stripe_onboarded) return c.json({ error: 'Online payment is not available' }, 400)
  const owedCents = Math.max(0, Number(inv.total_cents || 0) - Number(inv.amount_paid_cents || 0))
  if (owedCents < 50) return c.json({ error: 'Nothing due on this invoice' }, 400)
  try {
    const origin = new URL(c.req.url).origin
    const feePct = company.stripe_platform_fee_pct || 2.9
    const form = new URLSearchParams({
      'payment_method_types[]': 'card',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': String(owedCents),
      'line_items[0][price_data][product_data][name]': `Invoice ${inv.invoice_number || inv.id}`,
      'line_items[0][quantity]': '1',
      mode: 'payment',
      'success_url': `${origin}/invoices/portal/${token}?paid=1`,
      'cancel_url': `${origin}/invoices/portal/${token}`,
      'payment_intent_data[application_fee_amount]': String(Math.round(owedCents * feePct / 100)),
      'payment_intent_data[metadata][invoice_id]': inv.id,
      'payment_intent_data[metadata][company_id]': inv.company_id,
    })
    if (inv.client_email) form.set('customer_email', inv.client_email)
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Account': company.stripe_account_id },
      body: form.toString()
    })
    const session = await res.json() as any
    if (!res.ok) throw new Error(session.error?.message || 'Checkout creation failed')
    return c.json({ url: session.url })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// POST /api/estimates/portal/:token/approve — client approves estimate
app.post('/api/estimates/portal/:token/approve', async (c) => {
  const token = c.req.param('token')
  const db = c.env.DB as D1Database
  let pt = await db.prepare(`SELECT * FROM estimate_portal_tokens WHERE token=?`).bind(token).first() as any
  if (!pt) {
    const estRow = await db.prepare(`SELECT id, company_id FROM estimates WHERE portal_token=? LIMIT 1`).bind(token).first() as any
    if (estRow) pt = { estimate_id: estRow.id, company_id: estRow.company_id, token }
  }
  if (!pt) return c.json({ error: 'Invalid token' }, 404)
  await db.prepare(`UPDATE estimates SET status='approved' WHERE id=? AND company_id=?`).bind(pt.estimate_id, pt.company_id).run()
  await _woFlipHolds(db, pt.estimate_id, pt.company_id, 'scheduled')
  await db.prepare(`UPDATE estimate_portal_tokens SET used_at=? WHERE token=?`).bind(new Date().toISOString(), token).run().catch(() => {})
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
  let pt = await db.prepare(`SELECT * FROM estimate_portal_tokens WHERE token=?`).bind(token).first() as any
  if (!pt) {
    const estRow = await db.prepare(`SELECT id, company_id FROM estimates WHERE portal_token=? LIMIT 1`).bind(token).first() as any
    if (estRow) pt = { estimate_id: estRow.id, company_id: estRow.company_id, token }
  }
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
          // amountPaid (session.amount_total) is already Stripe cents — kept
          // in cents throughout instead of round-tripping through dollars.
          const newPaidCents = Number(inv.amount_paid_cents || 0) + amountPaid
          // Was comparing against inv.amount_total/inv.amount, neither of which
          // exists on the invoices table (the real column is `total`) — that
          // comparison was always false, so this path never actually reached
          // 'paid'. Fixed as part of wiring the collected-flag write-through
          // below, since this is the primary automated payment path.
          const newStatus = newPaidCents >= Number(inv.total_cents || 0) ? 'paid' : 'partial'
          const newPaid = newPaidCents / 100
          await db.prepare(`UPDATE invoices SET amount_paid=?, amount_paid_cents=?, status=? WHERE id=? AND company_id=?`)
            .bind(newPaid, newPaidCents, newStatus, invoiceId, companyId).run()
          // Log to payments table
          // TODO(bug, found 2026-08-10 during Stage 2 money-cents work, not
          // fixed here -- out of scope): 'method' and 'paid_at' are not real
          // columns on payments (the real ones are payment_method, no
          // paid_at at all) -- this INSERT throws "no such column" every
          // time this webhook fires with a valid invoice, which propagates
          // out of the try/catch below as a 400. Tracked in docs/PUNCHLIST.md.
          const pymtId = `py_${Date.now()}`
          await db.prepare(`INSERT OR IGNORE INTO payments (id, company_id, invoice_id, amount, amount_cents, method, stripe_payment_intent_id, status, paid_at)
            VALUES (?,?,?,?,?,?,?,'completed',?)`).bind(pymtId, companyId, invoiceId, amountPaid/100, Math.round(amountPaid/100*100), 'card',
            session.payment_intent || '', new Date().toISOString()).run()
          if (newStatus === 'paid') {
            await markOpportunityCollectedFromInvoice(db, companyId, invoiceId, inv.estimate_id)
          }
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
// rep_id filter: work orders this rep is on, for field-role scoping.
//
// This used to read `wo.assigned_rep_id`, a column no migration ever creates.
// The TODO here said the branch "will throw the first time it's actually hit" —
// it was already being hit on every page load: public/js/app_premium.js sets
// ?rep_id= for foreman, laborer and field_supervisor, so the schedule board was
// returning 500 for every field user. That is the whole crew.
//
// There is no single "assigned rep" column and there should not be one. A rep is
// on a job three ways, and all three are real: on the job's employee list, on a
// specific day of it, or on the crew running it. wo_day_employees is checked
// because the day is the source of truth for who actually works when — someone
// added to Thursday only must see the job on Thursday.
app.get('/api/work-orders', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensureMultidaySchema(db)
  const status    = c.req.query('status')
  const crewId    = c.req.query('crew_id')
  const repId     = c.req.query('rep_id')
  const clientId  = c.req.query('client_id')
  const dateFrom  = c.req.query('date_from')
  const dateTo    = c.req.query('date_to')
  // limit was interpolated straight into the SQL, so ?limit=abc produced
  // "LIMIT NaN" and a 500. parseInt kept it from being an injection, not from
  // being a crash. Bound and clamped now, with offset actually honoured:
  // public/js/app_premium.js has been sending &offset= from the client detail
  // "load more" since it was written, and getting page one back every time.
  const limitVal  = Math.max(1, Math.min(1000, Number(c.req.query('limit')) || 500))
  const offsetVal = Math.max(0, Number(c.req.query('offset')) || 0)

  // ?expand=days — one row per SCHEDULED DAY instead of one row per work order.
  //
  // The wo_days join carried no is_primary predicate, so a five-day job came
  // back as five rows with identical wo.* and different md_*. The schedule board
  // depends on that: it renders each phase as its own card with a "Day n/N" pill.
  // Every other consumer does not, and silently over-counted — client detail, the
  // Work Orders list, dashboard tallies and the board's own backlog filter all
  // treated one job as several.
  //
  // So the fan-out becomes opt-in rather than the default. "A list of work
  // orders" now means what it says; the board asks for the expansion explicitly.
  const expandDays = c.req.query('expand') === 'days'
  let sql = `SELECT wo.*, COALESCE(md.day_date, wo.scheduled_date) as scheduled_date, COALESCE(md.start_time, wo.scheduled_time) as scheduled_time,
             COALESCE(md.end_time, wo.scheduled_end_time) as scheduled_end_time,
             COALESCE(md.scheduled_duration_minutes, wo.scheduled_duration_minutes) as scheduled_duration_minutes,
             COALESCE(md.schedule_locked, wo.schedule_locked, 0) as schedule_locked,
             COALESCE(NULLIF(md.crew_id,''), wo.crew_id) as crew_id, cr.name as crew_name, cr.color as crew_color,
             md.id as md_day_id,
             md.day_number as md_day_number, md.day_date as md_day_date, md.scope as md_scope,
             md.phase_name as md_phase_name, md.phase_sequence as md_phase_sequence, md.crew_id as md_crew_id,
             md.depends_on_day_number as md_depends_on_day_number, md.dependency_type as md_dependency_type, md.dependency_lag_days as md_dependency_lag_days,
             md.status as md_status
             FROM work_orders wo
             LEFT JOIN wo_days md ON md.work_order_id = wo.id AND md.company_id = wo.company_id${expandDays ? '' : ' AND md.is_primary = 1'}
             LEFT JOIN crews cr ON cr.id = COALESCE(NULLIF(md.crew_id,''), wo.crew_id) AND cr.company_id = wo.company_id
             WHERE wo.company_id = ?`
  const params: any[] = [companyId]
  if (status)   { sql += ` AND wo.status = ?`;          params.push(status) }
  if (crewId)   { sql += ` AND COALESCE(NULLIF(md.crew_id,''), wo.crew_id) = ?`; params.push(crewId) }
  if (clientId) { sql += ` AND wo.client_id = ?`;       params.push(clientId) }
  if (dateFrom) { sql += ` AND COALESCE(md.day_date, wo.scheduled_date) >= ?`; params.push(dateFrom) }
  if (dateTo)   { sql += ` AND COALESCE(md.day_date, wo.scheduled_date) <= ?`; params.push(dateTo) }
  if (repId) {
    sql += ` AND (
      EXISTS (SELECT 1 FROM work_order_employees woe
               WHERE woe.wo_id = wo.id AND woe.rep_id = ? AND woe.company_id = wo.company_id)
      OR EXISTS (SELECT 1 FROM wo_day_employees wde
                   JOIN wo_days wdd ON wdd.id = wde.wo_day_id
                  WHERE wdd.work_order_id = wo.id AND wde.rep_id = ? AND wde.company_id = wo.company_id)
      OR COALESCE(NULLIF(md.crew_id,''), wo.crew_id) IN (
           SELECT cm.crew_id FROM crew_members cm WHERE cm.rep_id = ? AND cm.company_id = ?)
    )`
    params.push(repId, repId, repId, companyId)
  }
  sql += ` ORDER BY COALESCE(md.day_date, wo.scheduled_date) DESC, wo.created_at DESC LIMIT ? OFFSET ?`
  params.push(limitVal, offsetVal)
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
/**
 * Next work order number for a company.
 *
 * Derived from the highest number already issued, not from COUNT(*). The count
 * approach reused a number every time a work order was deleted — production
 * already carries three separate jobs numbered WO-00002 for exactly that reason,
 * which matters the moment a number appears on paperwork or is quoted to a
 * client.
 *
 * Reads the numeric tail rather than MAX(wo_number) so a stray non-conforming
 * value cannot poison the sequence, and ignores anything not shaped 'WO-…'.
 *
 * Not collision-proof under genuinely concurrent creation — two requests can
 * still read the same max. Closing that needs a unique index on
 * (company_id, wo_number), which cannot be added until the existing duplicates
 * are reconciled, and that is a data decision rather than a code one.
 */
async function nextWorkOrderNumber(db: D1Database, companyId: string): Promise<string> {
  const row: any = await db.prepare(
    `SELECT MAX(CAST(SUBSTR(wo_number, 4) AS INTEGER)) AS n
       FROM work_orders
      WHERE company_id=? AND wo_number LIKE 'WO-%'`
  ).bind(companyId).first()
  return 'WO-' + String(Number(row?.n || 0) + 1).padStart(5, '0')
}

app.post('/api/work-orders', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const repId     = c.var.repId as string
  const db = c.env.DB as D1Database
  const body: any = await c.req.json()
  const id = 'wo-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
  // Auto-number
  const woNum = await nextWorkOrderNumber(db, companyId)
  const createAmountEst = body.amount_est || 0
  await db.prepare(`
    INSERT INTO work_orders
      (id, company_id, wo_number, opp_id, crew_id, client_name, client_id, property_addr, title,
       type, status, readiness, scheduled_date, scheduled_time, scheduled_end_time, duration_hours,
       scheduled_duration_minutes, budget_minutes, notes,
       priority, required_completion_date, target_crew_size, access_notes,
       amount_est, amount_est_cents, checklist, materials, equipment, timeline, before_photos, after_photos, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    id, companyId, woNum,
    body.opp_id || null, body.crew_id || null,
    body.client_name || '', body.client_id || null, body.property_addr || '',
    body.title || '', body.type || 'Service',
    body.status || 'scheduled', body.readiness || 'ready',
    body.scheduled_date || null, body.scheduled_time || null,
    body.scheduled_end_time || null,
    body.duration_hours || null,
    // Calendar span and sold labor, each on its own column and each optional.
    // Neither existed on this endpoint before, so the only way to say anything
    // about hours was duration_hours — which the grid reads as the length of the
    // block. The create modal's "Budgeted Hours" field went straight into it, so
    // sold labor and calendar time were the same number from the moment a job
    // was born. See the capacity module header for why they are not the same.
    body.scheduled_duration_minutes != null ? Math.max(15, Math.min(1440, Number(body.scheduled_duration_minutes) || 0)) : null,
    body.budget_minutes != null
      ? Math.max(0, Number(body.budget_minutes) || 0)
      : body.budget_hours != null
        ? Math.round(Math.max(0, Number(body.budget_hours) || 0) * 60)
        : null,
    body.notes || '',
    // Migration 0070. Nullable throughout — a quick-add job says nothing about
    // any of these, and "not stated" has to stay distinguishable from "normal".
    body.priority || null,
    body.required_completion_date || null,
    // A crew size below 1 is not a small crew, it is a cleared field. Clamping
    // it up to 1 would silently assert a one-person crew and feed that into the
    // derived production-day count; null keeps "not stated" saying so.
    Number(body.target_crew_size) >= 1 ? Math.min(50, Math.trunc(Number(body.target_crew_size))) : null,
    body.access_notes || null,
    createAmountEst, Math.round(createAmountEst * 100),
    JSON.stringify(body.checklist || []),
    JSON.stringify(body.materials || []),
    JSON.stringify(body.equipment || []),
    JSON.stringify([{ action: 'Work Order Created', note: `by ${repId}`, at: new Date().toISOString() }]),
    JSON.stringify(body.before_photos || []),
    JSON.stringify(body.after_photos || []),
    repId
  ).run()
  // Primary wo_days row — see the note at the from-estimate conversion.
  await ensurePrimaryDay(db, companyId, id)
  // Add employees if provided
  const employees: string[] = body.employee_ids || []
  for (const eId of employees) {
    const eid = 'woe-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
    await db.prepare(`INSERT OR IGNORE INTO work_order_employees (id, wo_id, rep_id, company_id) VALUES (?,?,?,?)`)
      .bind(eid, id, eId, companyId).run()
  }
  // Per-day labor. Unconditional now: this was gated on `employees.length`, so a
  // job created with a CREW but no explicit employee list got a day row with
  // nobody on it. That is the normal case from the board — you pick a crew, not
  // a list of names — and every such job contributed zero planned minutes, so
  // the crew read as completely idle on the Week view no matter how much work
  // was booked into it. syncDayEmployees derives from the day's crew and no-ops
  // when there is neither a crew nor a job list, so calling it always is safe.
  await syncDayEmployees(db, companyId, id)
  await syncWorkOrderFinanceColumns(db, companyId, id)
  return c.json({ ok: true, id, wo_number: woNum })
})

// GET /api/work-orders/:id — single work order
app.get('/api/work-orders/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensureMultidaySchema(db)
  const woId = c.req.param('id')
  const row: any = await db.prepare(
    `SELECT wo.*, cr.name as crew_name, cr.color as crew_color,
            md.day_number as md_day_number, md.day_date as md_day_date, md.scope as md_scope,
            md.phase_name as md_phase_name, md.phase_sequence as md_phase_sequence, md.crew_id as md_crew_id,
            md.depends_on_day_number as md_depends_on_day_number, md.dependency_type as md_dependency_type, md.dependency_lag_days as md_dependency_lag_days,
            md.status as md_status
     FROM work_orders wo
     LEFT JOIN wo_days md ON md.work_order_id = wo.id AND md.company_id = wo.company_id AND md.day_date = wo.scheduled_date
     LEFT JOIN crews cr ON cr.id = COALESCE(md.crew_id, wo.crew_id) AND cr.company_id = wo.company_id
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
  await ensureMultidaySchema(db)
  const woId = c.req.param('id')
  const body: any = await c.req.json()
  // Get current WO for timeline diff
  const cur: any = await db.prepare(`SELECT status, timeline, schedule_locked FROM work_orders WHERE id=? AND company_id=?`).bind(woId, companyId).first()
  if (!cur) return c.json({ ok: false, error: 'Not found' }, 404)

  // Which of this endpoint's many fields actually move the job on the calendar.
  const SCHEDULING_FIELDS = ['crew_id', 'scheduled_date', 'scheduled_time', 'scheduled_end_time', 'scheduled_duration_minutes', 'schedule_locked'] as const
  const touchesSchedule = SCHEDULING_FIELDS.some(f => body[f] !== undefined)

  // Schedule lock, enforced.
  //
  // PATCH /reschedule has refused a locked job since it was written, but this
  // endpoint writes every one of the same columns and never checked — so the
  // lock could be walked straight past by editing the job instead of dragging
  // it, and the same statement could even clear the lock on the way through.
  // A lock that only stops one of two doors is not a lock.
  if (cur.schedule_locked && !body.force && touchesSchedule) {
    return c.json({ ok: false, error: 'This visit is locked. Unlock it before rescheduling.' }, 409)
  }

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
      scheduled_duration_minutes=COALESCE(?,scheduled_duration_minutes),
      schedule_locked=COALESCE(?,schedule_locked),
      duration_hours=COALESCE(?,duration_hours), notes=COALESCE(?,notes),
      budget_minutes=COALESCE(?,budget_minutes),
      priority=COALESCE(?,priority), required_completion_date=COALESCE(?,required_completion_date),
      target_crew_size=COALESCE(?,target_crew_size), access_notes=COALESCE(?,access_notes),
      completion_notes=COALESCE(?,completion_notes),
      amount_est=COALESCE(?,amount_est), amount_est_cents=COALESCE(?,amount_est_cents),
      amount_actual=COALESCE(?,amount_actual), amount_actual_cents=COALESCE(?,amount_actual_cents),
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
    body.scheduled_duration_minutes !== undefined ? body.scheduled_duration_minutes : null,
    body.schedule_locked !== undefined ? (body.schedule_locked ? 1 : 0) : null,
    body.duration_hours !== undefined ? body.duration_hours : null,
    body.notes !== undefined ? body.notes : null,
    // Sold labor is editable here because a job created by hand has no estimate
    // to inherit it from — accepts minutes or hours, the same as create.
    body.budget_minutes !== undefined
      ? Math.max(0, Number(body.budget_minutes) || 0)
      : body.budget_hours !== undefined
        ? Math.round(Math.max(0, Number(body.budget_hours) || 0) * 60)
        : null,
    body.priority !== undefined ? body.priority : null,
    body.required_completion_date !== undefined ? body.required_completion_date : null,
    body.target_crew_size !== undefined ? Math.max(1, Math.min(50, Number(body.target_crew_size) || 1)) : null,
    body.access_notes !== undefined ? body.access_notes : null,
    body.completion_notes !== undefined ? body.completion_notes : null,
    body.amount_est !== undefined ? body.amount_est : null,
    body.amount_est !== undefined ? Math.round(Number(body.amount_est) * 100) : null,
    body.amount_actual !== undefined ? body.amount_actual : null,
    body.amount_actual !== undefined ? Math.round(Number(body.amount_actual) * 100) : null,
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
    // Mirror the change into per-day labor so crew capacity reflects it.
    // Keeps hand-tuned planned_minutes; see syncDayEmployees.
    await syncDayEmployees(db, companyId, woId)
  }

  // Push the new date/time/crew down onto the day row.
  //
  // This was missing, and it is the mechanism behind "I moved the job to another
  // crew and the people didn't follow". The board's crew drag is two requests:
  // PATCH /reschedule (whose UPDATE has no crew_id column, so the crew in that
  // body is discarded) and then this PUT. Neither one moved wo_days.crew_id, and
  // capacity is computed from wo_days — so the card sat in the new lane while the
  // labor, the people and the utilisation stayed with the old crew, and a refresh
  // could put the card back where it came from.
  //
  // Runs after the employee block above so that when both change at once, the
  // day's own crew roster is the one that wins — the precedence syncDayEmployees
  // documents.
  if (touchesSchedule) await syncPrimaryDayFromWorkOrder(db, companyId, woId)

  await syncWorkOrderFinanceColumns(db, companyId, woId)
  return c.json({ ok: true })
})

// DELETE /api/work-orders/:id
app.delete('/api/work-orders/:id', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const woId = c.req.param('id')
  // wo_days carries no foreign key to work_orders, so deleting the job used to
  // leave its scheduling rows behind forever. They were invisible — every read
  // inner-joins back to work_orders — but they accumulated, and migration 0061
  // made that worse by giving every scheduled job a day row rather than only
  // multi-day ones. wo_day_employees cascades from wo_days, but only if the
  // wo_days row is actually deleted, so it is removed explicitly first for
  // tenants where foreign keys are not enforced.
  await db.batch([
    db.prepare(
      `DELETE FROM wo_day_employees
        WHERE company_id=? AND wo_day_id IN (SELECT id FROM wo_days WHERE work_order_id=?)`
    ).bind(companyId, woId),
    db.prepare(`DELETE FROM wo_days WHERE work_order_id=? AND company_id=?`).bind(woId, companyId),
    db.prepare(`DELETE FROM work_orders WHERE id=? AND company_id=?`).bind(woId, companyId),
  ])
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
  const woNum = await nextWorkOrderNumber(db, companyId)
  const newDate = body.scheduled_date || src.scheduled_date
  await db.prepare(`
    INSERT INTO work_orders
      (id, company_id, wo_number, opp_id, crew_id, client_name, client_id, property_addr, title,
       type, status, readiness, scheduled_date, scheduled_time, scheduled_end_time, duration_hours, notes,
       amount_est, amount_est_cents, checklist, materials, equipment, timeline, before_photos, after_photos, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    newId, companyId, woNum,
    src.opp_id, src.crew_id, src.client_name, src.client_id, src.property_addr,
    src.title, src.type, 'scheduled', 'ready',
    newDate, src.scheduled_time, src.scheduled_end_time, src.duration_hours, src.notes,
    src.amount_est, src.amount_est_cents,
    src.checklist, src.materials, src.equipment || '[]',
    JSON.stringify([{ action: 'Duplicated from ' + src.wo_number, note: `by ${repId}`, at: new Date().toISOString() }]),
    '[]', '[]', repId
  ).run()
  // Primary wo_days row — see the note at the from-estimate conversion.
  await ensurePrimaryDay(db, companyId, newId)
  // Duplicate employee assignments
  const emps = await db.prepare(`SELECT rep_id FROM work_order_employees WHERE wo_id=?`).bind(woId).all()
  for (const e of (emps.results || [])) {
    const eid = 'woe-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
    await db.prepare(`INSERT OR IGNORE INTO work_order_employees (id, wo_id, rep_id, company_id) VALUES (?,?,?,?)`)
      .bind(eid, newId, (e as any).rep_id, companyId).run()
  }
  // Per-day labor. Unconditional for the same reason as POST /api/work-orders:
  // a duplicate that inherits a CREW but no named employees was landing on the
  // grid with nobody on it and zero planned minutes.
  await syncDayEmployees(db, companyId, newId)
  return c.json({ ok: true, id: newId, wo_number: woNum })
})

// PATCH /api/work-orders/:id/reschedule — quick date/time update (drag-drop)
app.patch('/api/work-orders/:id/reschedule', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensureMultidaySchema(db)
  const woId = c.req.param('id')
  const body: any = await c.req.json()
  const current: any = await db.prepare(`SELECT scheduled_date, scheduled_time, scheduled_end_time, scheduled_duration_minutes, schedule_locked, timeline FROM work_orders WHERE id=? AND company_id=?`).bind(woId, companyId).first()
  if (!current) return c.json({ ok: false, error: 'Work order not found' }, 404)
  if (current.schedule_locked && !body.force) return c.json({ ok: false, error: 'This visit is locked. Unlock it before rescheduling.' }, 409)
  const validTime = (value: any) => value === undefined || value === null || value === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))
  if (!validTime(body.scheduled_time) || !validTime(body.scheduled_end_time)) return c.json({ ok: false, error: 'Times must use HH:MM format' }, 400)
  const nextStart = body.scheduled_time || current.scheduled_time
  const nextEnd = body.scheduled_end_time || current.scheduled_end_time
  if (nextStart && nextEnd && nextEnd <= nextStart) return c.json({ ok: false, error: 'End time must be after start time' }, 400)
  const durationMinutes = body.scheduled_duration_minutes !== undefined
    ? Math.max(15, Math.min(1440, Number(body.scheduled_duration_minutes) || 0))
    : current.scheduled_duration_minutes
  const timeline = JSON.parse(current.timeline || '[]')
  timeline.push({ action: 'Schedule updated', note: `Date ${body.scheduled_date || current.scheduled_date || 'unscheduled'}, ${nextStart || 'no start'}-${nextEnd || 'no end'}`, at: new Date().toISOString(), by: c.var.repId })
  await db.prepare(`
    UPDATE work_orders SET
      scheduled_date=COALESCE(?,scheduled_date),
      scheduled_time=COALESCE(?,scheduled_time),
      scheduled_end_time=COALESCE(?,scheduled_end_time),
      scheduled_duration_minutes=COALESCE(?,scheduled_duration_minutes),
      schedule_locked=COALESCE(?,schedule_locked), timeline=?,
      updated_at=datetime('now')
    WHERE id=? AND company_id=?
  `).bind(
    body.scheduled_date || null,
    body.scheduled_time || null,
    body.scheduled_end_time || null,
    durationMinutes || null,
    body.schedule_locked === undefined ? null : (body.schedule_locked ? 1 : 0),
    JSON.stringify(timeline),
    woId, companyId
  ).run()
  // Keep the primary day row in step. Capacity is computed from wo_days, so
  // without this a dragged job moves on the grid while its labor stays
  // attributed to the day it came from.
  await syncPrimaryDayFromWorkOrder(db, companyId, woId)
  return c.json({ ok: true })
})

// ══════════════════════════════════════════════════════════════════════════════
// MULTI-DAY JOBS — per-day crew checklists that auto-publish portal updates
// ══════════════════════════════════════════════════════════════════════════════
// Flow: staff enable multi-day on a job (POST /multiday) → AI generates per-day
// yes/no questions from the day scopes → crew answers each question with a
// required photo (POST /days/:n/answer) → completing a day (POST /days/:n/complete)
// has AI compose the client-facing message and publishes it to project_updates
// (visible in the client portal) with the photos attached.

let _multidaySchemaOk = false
async function ensureMultidaySchema(db: D1Database): Promise<void> {
  if (_multidaySchemaOk) return
  try {
    const flag = await db.prepare("SELECT value FROM settings WHERE key = '_schema_multiday_v3' LIMIT 1").first<any>()
    if (flag) { _multidaySchemaOk = true; return }
  } catch (_) {}
  const stmts = (mig0045 + '\n' + mig0046 + '\n' + mig0047).split('\n').map(l => l.replace(/--.*$/, '')).join('\n')
    .split(';').map(s => s.trim()).filter(s => s.length > 0)
  for (const stmt of stmts) {
    try { await db.prepare(stmt).run() } catch (e: any) {
      const msg = String(e?.message || e)
      if (!/duplicate column|already exists/i.test(msg)) console.log('ensureMultidaySchema', msg.slice(0, 120))
    }
  }
  try {
    await db.prepare('INSERT INTO d1_migrations (name, applied_at) SELECT ?, CURRENT_TIMESTAMP WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = ?)').bind('0045_multiday_jobs.sql', '0045_multiday_jobs.sql').run()
    await db.prepare('INSERT INTO d1_migrations (name, applied_at) SELECT ?, CURRENT_TIMESTAMP WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = ?)').bind('0046_multiday_phase_metadata.sql', '0046_multiday_phase_metadata.sql').run()
    await db.prepare('INSERT INTO d1_migrations (name, applied_at) SELECT ?, CURRENT_TIMESTAMP WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = ?)').bind('0047_schedule_timeline.sql', '0047_schedule_timeline.sql').run()
  } catch (_) {}
  try {
    await db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('_schema_multiday_v3', ?, datetime('now'))").bind(new Date().toISOString()).run()
  } catch (_) {}
  _multidaySchemaOk = true
}

const _mdUid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9)

// Fallback questions when AI is unavailable — derived from the day scope.
function _mdFallbackQuestions(scope: string, dayNumber: number, woTitle: string): string[] {
  const base = scope || woTitle || 'the planned work'
  return [
    `Did the crew complete the planned work for day ${dayNumber} (${base.slice(0, 80)})?`,
    'Was the work area cleaned up and left safe at the end of the day?',
    'Were all materials and equipment secured or removed from the site?',
    'Is the site ready for the next scheduled phase of work?',
  ]
}

// POST /api/work-orders/:id/multiday — enable multi-day mode + generate day plan
// Body: { total_days, start_date?, day_scopes?: [{day_number, scope, day_date?}] }
// AI generates 3-6 yes/no completion questions per day from that day's scope.
app.post('/api/work-orders/:id/multiday', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  const woId = c.req.param('id')
  await ensureMultidaySchema(db)
  const wo: any = await db.prepare(`SELECT * FROM work_orders WHERE id=? AND company_id=?`).bind(woId, companyId).first()
  if (!wo) return c.json({ ok: false, error: 'Work order not found' }, 404)
  const b: any = await c.req.json().catch(() => ({}))
  const totalDays = Math.max(2, Math.min(30, Number(b.total_days) || 2))
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.start_date || '')) ? b.start_date : (wo.scheduled_date || new Date().toISOString().slice(0, 10))
  const scopes: any[] = Array.isArray(b.day_scopes) ? b.day_scopes : []

  // Never wipe crew progress: existing completed/in-progress days are kept.
  const existing = (await db.prepare(`SELECT day_number, status FROM wo_days WHERE work_order_id=? AND company_id=?`).bind(woId, companyId).all()).results as any[] || []
  const protectedDays = new Set(existing.filter(d => d.status !== 'pending').map(d => Number(d.day_number)))

  // AI question generation — one call for all days (cheaper + coherent).
  const phaseDefaults = ['Mobilization', 'Demolition', 'Grading', 'Hardscape', 'Planting', 'Cleanup', 'Final Walkthrough']
  const cleanPhase = (v: any, i: number) => String(v || phaseDefaults[Math.min(i, phaseDefaults.length - 1)] || ('Phase ' + (i + 1))).slice(0, 80)
  const dayPlans: Array<{ day: number; scope: string; date: string; start_time: string | null; end_time: string | null; scheduled_duration_minutes: number | null; phase_name: string; phase_sequence: number; crew_id: string; depends_on_day_number: number | null; dependency_type: string; dependency_lag_days: number; questions: string[] }> = []
  const addDays = (iso: string, n: number) => {
    const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n)
    return d.toISOString().slice(0, 10)
  }
  for (let i = 1; i <= totalDays; i++) {
    const sc = scopes.find(s => Number(s.day_number) === i)
    dayPlans.push({
      day: i,
      scope: String(sc?.scope || '').slice(0, 500),
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(sc?.day_date || '')) ? sc.day_date : addDays(startDate, i - 1),
      start_time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(sc?.start_time || '')) ? sc.start_time : (wo.scheduled_time || null),
      end_time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(sc?.end_time || '')) ? sc.end_time : (wo.scheduled_end_time || null),
      scheduled_duration_minutes: Number(sc?.scheduled_duration_minutes) || wo.scheduled_duration_minutes || null,
      phase_name: cleanPhase(sc?.phase_name || sc?.phase, i - 1),
      phase_sequence: Number(sc?.phase_sequence) || i,
      crew_id: String(sc?.crew_id || wo.crew_id || ''),
      depends_on_day_number: i > 1 ? (Number(sc?.depends_on_day_number) || i - 1) : null,
      dependency_type: String(sc?.dependency_type || 'finish_to_start').slice(0, 40),
      dependency_lag_days: Number(sc?.dependency_lag_days) || 0,
      questions: [],
    })
  }

  let aiUsed = false
  const { apiKey, baseUrl, model, keySource } = await _aiCreds(db, companyId, c.env)
  if (apiKey) {
    const _qg = await _aiQuotaGate(db, companyId, keySource)
    if (!_qg) {
      try {
        const jobCtx = [
          `Job: ${wo.title || wo.wo_number || 'work order'}`,
          wo.type ? `Type: ${wo.type}` : '',
          wo.notes ? `Notes: ${String(wo.notes).slice(0, 800)}` : '',
          `Total days: ${totalDays}`,
          'Daily scopes:',
          ...dayPlans.map(d => `Day ${d.day}: ${d.scope || '(no specific scope given — infer a sensible phase from the job and day number)'}`),
        ].filter(Boolean).join('\n')
        const sys = `You generate end-of-day completion checklists for field service crews (landscaping, construction, property services). For EACH day of a multi-day job, write 3 to 6 yes/no questions the crew foreman answers before closing out that day. Questions must:
- Be specific to that day's scope of work (not generic filler)
- Be answerable yes/no
- Each be verifiable with a single photo
- Cover: work completed per scope, site cleanliness/safety, materials/equipment status, readiness for the next day
Return ONLY valid JSON: { "days": [ { "day": 1, "questions": ["...", "..."] }, ... ] } — one entry per day, no markdown fences.`
        const r = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages: [
            { role: 'system', content: sys },
            { role: 'user', content: jobCtx },
          ]}),
        })
        if (r.ok) {
          const j: any = await r.json()
          await _logAiUsage(db, companyId, c.var.repId as string, 'multiday_questions', model, j?.usage, keySource)
          let raw = String(j?.choices?.[0]?.message?.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
          const s = raw.indexOf('{'), e = raw.lastIndexOf('}')
          if (s >= 0 && e > s) {
            const parsed = JSON.parse(raw.slice(s, e + 1))
            for (const dp of dayPlans) {
              const aiDay = (parsed.days || []).find((x: any) => Number(x.day) === dp.day)
              if (aiDay && Array.isArray(aiDay.questions) && aiDay.questions.length) {
                dp.questions = aiDay.questions.slice(0, 6).map((q: any) => String(q).slice(0, 300))
                aiUsed = true
              }
            }
          }
        }
      } catch (e: any) { console.log('[multiday] AI question gen failed:', String(e?.message || e).slice(0, 120)) }
    }
  }
  for (const dp of dayPlans) {
    if (!dp.questions.length) dp.questions = _mdFallbackQuestions(dp.scope, dp.day, wo.title || '')
  }

  // Upsert wo_days — days with crew progress keep their questions/answers
  for (const dp of dayPlans) {
    if (protectedDays.has(dp.day)) {
      await db.prepare(`UPDATE wo_days SET scope=?, day_date=?, start_time=?, end_time=?, scheduled_duration_minutes=?, phase_name=?, phase_sequence=?, crew_id=?, depends_on_day_number=?, dependency_type=?, dependency_lag_days=?, updated_at=datetime('now') WHERE work_order_id=? AND company_id=? AND day_number=?`)
        .bind(dp.scope, dp.date, dp.start_time, dp.end_time, dp.scheduled_duration_minutes, dp.phase_name, dp.phase_sequence, dp.crew_id, dp.depends_on_day_number, dp.dependency_type, dp.dependency_lag_days, woId, companyId, dp.day).run()
      continue
    }
    const questions = dp.questions.map(q => ({ q, answer: null, photo_media_id: '', answered_at: '', answered_by: '' }))
    await db.prepare(`INSERT INTO wo_days (id, company_id, work_order_id, day_number, day_date, start_time, end_time, scheduled_duration_minutes, scope, phase_name, phase_sequence, crew_id, depends_on_day_number, dependency_type, dependency_lag_days, questions, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending')
      ON CONFLICT(work_order_id, day_number) DO UPDATE SET day_date=excluded.day_date, start_time=excluded.start_time, end_time=excluded.end_time, scheduled_duration_minutes=excluded.scheduled_duration_minutes, scope=excluded.scope, phase_name=excluded.phase_name, phase_sequence=excluded.phase_sequence, crew_id=excluded.crew_id, depends_on_day_number=excluded.depends_on_day_number, dependency_type=excluded.dependency_type, dependency_lag_days=excluded.dependency_lag_days, questions=excluded.questions, updated_at=datetime('now')`)
      .bind('wod_' + _mdUid(), companyId, woId, dp.day, dp.date, dp.start_time, dp.end_time, dp.scheduled_duration_minutes, dp.scope, dp.phase_name, dp.phase_sequence, dp.crew_id, dp.depends_on_day_number, dp.dependency_type, dp.dependency_lag_days, JSON.stringify(questions)).run()
  }
  // Drop pending days beyond the new total (never completed ones)
  await db.prepare(`DELETE FROM wo_days WHERE work_order_id=? AND company_id=? AND day_number>? AND status='pending'`).bind(woId, companyId, totalDays).run()
  await db.prepare(`UPDATE work_orders SET is_multiday=1, total_days=?, updated_at=datetime('now') WHERE id=? AND company_id=?`).bind(totalDays, woId, companyId).run()

  // Staff the days this just created.
  //
  // Without it a freshly split multi-day job has day rows with a crew on them
  // and nobody in wo_day_employees, so every one of those days contributes zero
  // planned minutes and the crew reads as idle across the whole job — the exact
  // "capacity built, never populated" shape the Week view is meant to remove.
  // Covers every day at once rather than per day, so each takes its own crew's
  // roster; hand-tuned minutes and manually-added people survive.
  await syncDayEmployees(db, companyId, woId)

  const days = (await db.prepare(`SELECT * FROM wo_days WHERE work_order_id=? AND company_id=? ORDER BY day_number`).bind(woId, companyId).all()).results as any[] || []
  return c.json({ ok: true, ai_used: aiUsed, data: days.map(d => ({ ...d, questions: JSON.parse(d.questions || '[]') })) })
})

// GET /api/work-orders/:id/days — day list with progress
app.get('/api/work-orders/:id/days', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensureMultidaySchema(db)
  const wo: any = await db.prepare(`SELECT id, is_multiday, total_days FROM work_orders WHERE id=? AND company_id=?`).bind(c.req.param('id'), companyId).first()
  if (!wo) return c.json({ ok: false, error: 'Work order not found' }, 404)
  const days = (await db.prepare(`SELECT * FROM wo_days WHERE work_order_id=? AND company_id=? ORDER BY day_number`).bind(wo.id, companyId).all()).results as any[] || []
  return c.json({ ok: true, is_multiday: !!wo.is_multiday, total_days: wo.total_days || 1,
    data: days.map(d => ({ ...d, questions: JSON.parse(d.questions || '[]') })) })
})


// PATCH /api/work-orders/:id/days/:n — move or update one multi-day phase without changing downstream days.
// Body: { day_date?, start_time?, end_time?, scheduled_duration_minutes?, schedule_locked?, crew_id?, phase_name?, phase_sequence?, depends_on_day_number?, dependency_type?, dependency_lag_days? }
app.patch('/api/work-orders/:id/days/:n', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensureMultidaySchema(db)
  const woId = c.req.param('id')
  const dayN = parseInt(c.req.param('n'))
  const b: any = await c.req.json().catch(() => ({}))
  const day: any = await db.prepare(`SELECT * FROM wo_days WHERE work_order_id=? AND company_id=? AND day_number=?`).bind(woId, companyId, dayN).first()
  if (!day) return c.json({ ok: false, error: 'Day not found' }, 404)
  const dayDate = b.day_date === undefined || b.day_date === null || b.day_date === '' ? day.day_date : String(b.day_date)
  if (dayDate && !/^\d{4}-\d{2}-\d{2}$/.test(dayDate)) return c.json({ ok: false, error: 'Valid day_date is required' }, 400)
  if (day.schedule_locked && !b.force && (b.day_date !== undefined || b.start_time !== undefined || b.end_time !== undefined || b.crew_id !== undefined)) return c.json({ ok: false, error: 'This phase is locked. Unlock it before rescheduling.' }, 409)
  const validTime = (value: any) => value === undefined || value === null || value === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))
  if (!validTime(b.start_time) || !validTime(b.end_time)) return c.json({ ok: false, error: 'Times must use HH:MM format' }, 400)
  const startTime = b.start_time === undefined ? day.start_time : (b.start_time || null)
  const endTime = b.end_time === undefined ? day.end_time : (b.end_time || null)
  if (startTime && endTime && endTime <= startTime) return c.json({ ok: false, error: 'End time must be after start time' }, 400)
  const durationMinutes = b.scheduled_duration_minutes === undefined ? day.scheduled_duration_minutes : Math.max(15, Math.min(1440, Number(b.scheduled_duration_minutes) || 0))
  const crewId = b.crew_id === undefined ? (day.crew_id || '') : String(b.crew_id || '')
  if (crewId) {
    const crew: any = await db.prepare(`SELECT id FROM crews WHERE id=? AND company_id=?`).bind(crewId, companyId).first()
    if (!crew) return c.json({ ok: false, error: 'Crew not found' }, 400)
  }
  const phaseName = b.phase_name === undefined ? (day.phase_name || '') : String(b.phase_name || '').slice(0, 80)
  const phaseSequence = b.phase_sequence === undefined ? (day.phase_sequence || dayN) : (Number(b.phase_sequence) || dayN)
  const dependsOn = b.depends_on_day_number === undefined ? (day.depends_on_day_number ?? null) : (b.depends_on_day_number === null || b.depends_on_day_number === '' ? null : Number(b.depends_on_day_number))
  const depType = b.dependency_type === undefined ? (day.dependency_type || 'finish_to_start') : String(b.dependency_type || 'finish_to_start').slice(0, 40)
  const depLag = b.dependency_lag_days === undefined ? (day.dependency_lag_days || 0) : (Number(b.dependency_lag_days) || 0)
  await db.prepare(`UPDATE wo_days SET day_date=?, start_time=?, end_time=?, scheduled_duration_minutes=?, schedule_locked=?, crew_id=?, phase_name=?, phase_sequence=?, depends_on_day_number=?, dependency_type=?, dependency_lag_days=?, updated_at=datetime('now') WHERE id=? AND company_id=?`)
    .bind(dayDate || '', startTime, endTime, durationMinutes, b.schedule_locked === undefined ? (day.schedule_locked || 0) : (b.schedule_locked ? 1 : 0), crewId, phaseName, phaseSequence, dependsOn, depType, depLag, day.id, companyId).run()
  if (dayN === 1 && dayDate) {
    await db.prepare(`UPDATE work_orders SET scheduled_date=?, updated_at=datetime('now') WHERE id=? AND company_id=?`).bind(dayDate, woId, companyId).run()
  }
  // A multi-day job can be split across days AND crews, so moving one phase to a
  // different crew must restaff that phase without touching the others. Scoped
  // to this day only.
  if (crewId !== (day.crew_id || '')) {
    await syncDayEmployees(db, companyId, woId, day.id)
  }
  const updated: any = await db.prepare(`SELECT * FROM wo_days WHERE id=? AND company_id=?`).bind(day.id, companyId).first()
  return c.json({ ok: true, data: { ...updated, questions: JSON.parse(updated.questions || '[]') } })
})

// POST /api/work-orders/:id/days/:n/shift-downstream — move this day and every dependent downstream day by the same date delta.
// Body: { day_date }
app.post('/api/work-orders/:id/days/:n/shift-downstream', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensureMultidaySchema(db)
  const woId = c.req.param('id')
  const dayN = parseInt(c.req.param('n'))
  const b: any = await c.req.json().catch(() => ({}))
  const newDate = String(b.day_date || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) return c.json({ ok: false, error: 'Valid day_date is required' }, 400)
  const crewId = b.crew_id === undefined ? undefined : String(b.crew_id || '')
  if (crewId) {
    const crew: any = await db.prepare(`SELECT id FROM crews WHERE id=? AND company_id=?`).bind(crewId, companyId).first()
    if (!crew) return c.json({ ok: false, error: 'Crew not found' }, 400)
  }
  const wo: any = await db.prepare(`SELECT id FROM work_orders WHERE id=? AND company_id=?`).bind(woId, companyId).first()
  if (!wo) return c.json({ ok: false, error: 'Work order not found' }, 404)
  const days = (await db.prepare(`SELECT * FROM wo_days WHERE work_order_id=? AND company_id=? ORDER BY day_number`).bind(woId, companyId).all()).results as any[] || []
  const selected = days.find(d => Number(d.day_number) === dayN)
  if (!selected) return c.json({ ok: false, error: 'Day not found' }, 404)
  const lockedDownstream = days.filter(d => Number(d.day_number) >= dayN && d.schedule_locked)
  if (lockedDownstream.length && !b.force) return c.json({ ok: false, error: `Cannot shift locked phase${lockedDownstream.length === 1 ? '' : 's'}: ${lockedDownstream.map(d => d.day_number).join(', ')}` }, 409)
  const oldTime = Date.parse(String(selected.day_date || '') + 'T12:00:00Z')
  const newTime = Date.parse(newDate + 'T12:00:00Z')
  if (!Number.isFinite(oldTime) || !Number.isFinite(newTime)) return c.json({ ok: false, error: 'Selected day does not have a valid current date' }, 400)
  const deltaDays = Math.round((newTime - oldTime) / 86400000)
  const addDays = (iso: string, n: number) => {
    const d = new Date(String(iso) + 'T12:00:00Z')
    if (isNaN(d.getTime())) return iso || ''
    d.setUTCDate(d.getUTCDate() + n)
    return d.toISOString().slice(0, 10)
  }
  const shifted: any[] = []
  const updates: D1PreparedStatement[] = []
  // Where each day lands, by day_number, so a dependent can be placed relative
  // to its predecessor's NEW date rather than its old one.
  const placed = new Map<number, string>()
  for (const day of days) {
    if (Number(day.day_number) < dayN) placed.set(Number(day.day_number), String(day.day_date || ''))
  }
  for (const day of days) {
    if (Number(day.day_number) < dayN) continue

    // Dependencies, actually evaluated.
    //
    // wo_days has carried depends_on_day_number, dependency_type and
    // dependency_lag_days since migration 0046. The multi-day panel writes them
    // and every read echoes them back — and nothing has ever consulted them.
    // A dependency graph that does nothing is worse than not having one: it
    // looks like a promise the scheduler is keeping.
    //
    // finish_to_start with a lag means "start this many days after the one it
    // depends on". Anything else falls back to the blanket delta, which is the
    // old behaviour and the right answer for an unconstrained day.
    const dependsOn = Number(day.depends_on_day_number || 0)
    const lag = Number(day.dependency_lag_days || 0)
    const predecessorDate = dependsOn ? placed.get(dependsOn) : undefined
    const shiftedDate =
      Number(day.day_number) === dayN
        ? newDate
        : (dependsOn && predecessorDate && String(day.dependency_type || 'finish_to_start') === 'finish_to_start')
          ? addDays(predecessorDate, Math.max(1, lag || 1))
          : addDays(day.day_date, deltaDays)
    placed.set(Number(day.day_number), shiftedDate)
    if (Number(day.day_number) === dayN && crewId !== undefined) {
      updates.push(db.prepare(`UPDATE wo_days SET day_date=?, crew_id=?, updated_at=datetime('now') WHERE id=? AND company_id=?`).bind(shiftedDate, crewId, day.id, companyId))
    } else {
      updates.push(db.prepare(`UPDATE wo_days SET day_date=?, updated_at=datetime('now') WHERE id=? AND company_id=?`).bind(shiftedDate, day.id, companyId))
    }
    shifted.push({ day_number: day.day_number, old_date: day.day_date, day_date: shiftedDate, phase_name: day.phase_name || '', phase_sequence: day.phase_sequence || day.day_number, crew_id: Number(day.day_number) === dayN && crewId !== undefined ? crewId : (day.crew_id || ''), depends_on_day_number: day.depends_on_day_number ?? null, dependency_type: day.dependency_type || 'finish_to_start', dependency_lag_days: day.dependency_lag_days || 0 })
  }
  if (dayN === 1) {
    updates.push(db.prepare(`UPDATE work_orders SET scheduled_date=?, updated_at=datetime('now') WHERE id=? AND company_id=?`).bind(newDate, woId, companyId))
  }
  if (updates.length) await db.batch(updates)

  // Re-derive day N's people when this call moved it to a different crew.
  //
  // Migration 0069 exists specifically so a crew change can replace a day's
  // roster without dropping anyone added by hand — but only PATCH /days/:n was
  // ever taught to use it. This endpoint writes the same crew_id column (above)
  // and left wo_day_employees on the previous crew, so shifting a phase to
  // another crew moved the card and not the labor. Same bug, second door.
  //
  // Only day N: the downstream days move in time, not between crews.
  if (crewId !== undefined && selected && String(selected.crew_id || '') !== crewId) {
    await syncDayEmployees(db, companyId, woId, selected.id)
  }

  return c.json({ ok: true, delta_days: deltaDays, shifted })
})

// POST /api/work-orders/:id/days/:n/answer — crew answers one question
// Body: { question_index, answer: true|false, photo_media_id }
// A photo is REQUIRED with every answer; questions must be answered in order.
app.post('/api/work-orders/:id/days/:n/answer', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensureMultidaySchema(db)
  const woId = c.req.param('id')
  const dayN = parseInt(c.req.param('n'))
  const b: any = await c.req.json().catch(() => ({}))
  const qi = Number(b.question_index)
  const day: any = await db.prepare(`SELECT * FROM wo_days WHERE work_order_id=? AND company_id=? AND day_number=?`).bind(woId, companyId, dayN).first()
  if (!day) return c.json({ ok: false, error: 'Day not found' }, 404)
  if (day.status === 'completed') return c.json({ ok: false, error: 'This day is already completed and published' }, 409)
  const questions: any[] = JSON.parse(day.questions || '[]')
  if (!(qi >= 0 && qi < questions.length)) return c.json({ ok: false, error: 'Invalid question index' }, 400)
  // Sequential enforcement: all earlier questions must be answered first
  for (let i = 0; i < qi; i++) {
    if (questions[i].answer === null || questions[i].answer === undefined) {
      return c.json({ ok: false, error: `Answer question ${i + 1} first` }, 400)
    }
  }
  const photoId = String(b.photo_media_id || '').trim()
  if (!photoId) return c.json({ ok: false, error: 'A photo is required with every answer' }, 400)
  const media: any = await db.prepare(`SELECT id FROM project_media WHERE id=? AND company_id=? AND work_order_id=?`).bind(photoId, companyId, woId).first()
  if (!media) return c.json({ ok: false, error: 'Photo not found on this job — upload it first' }, 400)
  questions[qi] = { ...questions[qi], answer: !!b.answer, photo_media_id: photoId,
    answered_at: new Date().toISOString(), answered_by: c.var.repId as string }
  const allAnswered = questions.every(q => q.answer !== null && q.answer !== undefined)
  await db.prepare(`UPDATE wo_days SET questions=?, status=?, updated_at=datetime('now') WHERE id=?`)
    .bind(JSON.stringify(questions), day.status === 'pending' ? 'in_progress' : day.status, day.id).run()
  return c.json({ ok: true, all_answered: allAnswered, next_index: allAnswered ? null : qi + 1 })
})

// POST /api/work-orders/:id/days/:n/complete — close the day: AI composes the
// client-facing message and it publishes automatically to the client portal.
app.post('/api/work-orders/:id/days/:n/complete', requireAuth, async (c) => {
  const companyId = c.var.companyId as string
  const db = c.env.DB as D1Database
  await ensureMultidaySchema(db)
  const woId = c.req.param('id')
  const dayN = parseInt(c.req.param('n'))
  const wo: any = await db.prepare(`SELECT * FROM work_orders WHERE id=? AND company_id=?`).bind(woId, companyId).first()
  if (!wo) return c.json({ ok: false, error: 'Work order not found' }, 404)
  const day: any = await db.prepare(`SELECT * FROM wo_days WHERE work_order_id=? AND company_id=? AND day_number=?`).bind(woId, companyId, dayN).first()
  if (!day) return c.json({ ok: false, error: 'Day not found' }, 404)
  if (day.status === 'completed') return c.json({ ok: false, error: 'Day already completed' }, 409)
  const questions: any[] = JSON.parse(day.questions || '[]')
  const unanswered = questions.filter(q => q.answer === null || q.answer === undefined).length
  if (unanswered > 0) return c.json({ ok: false, error: `${unanswered} question${unanswered === 1 ? '' : 's'} still unanswered — every question needs an answer and photo before completing the day` }, 400)

  const totalDays = wo.total_days || 1
  const co: any = await db.prepare(`SELECT name FROM companies WHERE id=? LIMIT 1`).bind(companyId).first().catch(() => null)
  const coName = (co && co.name) || 'Your contractor'

  // AI composes the client-facing update from the checklist results
  let title = `Day ${dayN} of ${totalDays} complete`
  let bodyText = ''
  const yesCount = questions.filter(q => q.answer === true).length
  const { apiKey, baseUrl, model, keySource } = await _aiCreds(db, companyId, c.env)
  if (apiKey) {
    const _qg = await _aiQuotaGate(db, companyId, keySource)
    if (!_qg) {
      try {
        const ctx = [
          `Company: ${coName}`,
          `Job: ${wo.title || wo.wo_number}`,
          `Client: ${wo.client_name || 'the client'}`,
          `Day ${dayN} of ${totalDays}${day.scope ? ` — planned scope: ${day.scope}` : ''}`,
          `Progress: ${Math.round((dayN / totalDays) * 100)}% of scheduled days done`,
          'Crew end-of-day checklist results:',
          ...questions.map((q, i) => `${i + 1}. ${q.q} — ${q.answer ? 'YES' : 'NO'}`),
        ].join('\n')
        const sys = `You write short, warm, professional daily progress updates that a contractor publishes to their client's portal after each work day of a multi-day job. Based on the crew's end-of-day checklist, write:
- "title": a concise headline (max 70 chars) like "Day 2 complete: patio base graded and compacted"
- "body": 2-3 short paragraphs, client-friendly (no jargon), covering what was accomplished today, honestly noting anything not finished (any NO answers) and what happens next. Mention that photos from today are attached. Never invent details not supported by the checklist. Plain text, \\n\\n between paragraphs.
Return ONLY valid JSON: { "title": "...", "body": "..." } — no markdown fences.`
        const r = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages: [
            { role: 'system', content: sys },
            { role: 'user', content: ctx },
          ]}),
        })
        if (r.ok) {
          const j: any = await r.json()
          await _logAiUsage(db, companyId, c.var.repId as string, 'multiday_update', model, j?.usage, keySource)
          let raw = String(j?.choices?.[0]?.message?.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
          const s = raw.indexOf('{'), e = raw.lastIndexOf('}')
          if (s >= 0 && e > s) {
            const parsed = JSON.parse(raw.slice(s, e + 1))
            if (parsed.title) title = String(parsed.title).slice(0, 160)
            if (parsed.body) bodyText = String(parsed.body).slice(0, 4000)
          }
        }
      } catch (e: any) { console.log('[multiday] AI compose failed:', String(e?.message || e).slice(0, 120)) }
    }
  }
  if (!bodyText) {
    // Deterministic fallback message
    const notDone = questions.filter(q => q.answer === false).map(q => q.q.replace(/\?$/, ''))
    bodyText = `Day ${dayN} of ${totalDays} is complete on ${wo.title || 'your project'}.` +
      (day.scope ? `\n\nToday's focus: ${day.scope}.` : '') +
      `\n\nThe crew completed ${yesCount} of ${questions.length} checklist items today.` +
      (notDone.length ? ` Items to carry forward: ${notDone.join('; ')}.` : ' Everything on today\'s list was finished.') +
      `\n\nPhotos from today's work are attached. ${dayN < totalDays ? `Next up: day ${dayN + 1} of ${totalDays}.` : 'This was the final scheduled day — thank you!'}`
  }

  // Publish to project_updates (client portal) with the day's photos attached
  const updId = 'upd_' + _mdUid()
  const updateDate = day.day_date || new Date().toISOString().slice(0, 10)
  await db.prepare(`INSERT INTO project_updates (id, company_id, work_order_id, client_id, property_id, update_date, title, body, status, published_at, created_by)
    VALUES (?,?,?,?,?,?,?,?,'published',datetime('now'),?)`)
    .bind(updId, companyId, woId, wo.client_id || '', wo.property_id || '', updateDate, title, bodyText, c.var.repId as string).run()
  const photoIds = [...new Set(questions.map(q => q.photo_media_id).filter(Boolean))] as string[]
  for (const pid of photoIds.slice(0, 30)) {
    await db.prepare(`UPDATE project_media SET update_id=? WHERE id=? AND company_id=? AND work_order_id=?`).bind(updId, pid, companyId, woId).run()
  }

  // Mark the day completed + link the published update
  await db.prepare(`UPDATE wo_days SET status='completed', completed_at=datetime('now'), completed_by=?, update_id=?, updated_at=datetime('now') WHERE id=?`)
    .bind(c.var.repId as string, updId, day.id).run()

  // Progress on the WO timeline; final day flips the WO to completed
  let tl: any[] = []
  try { tl = JSON.parse(wo.timeline || '[]') } catch {}
  tl.push({ at: new Date().toISOString(), event: `Day ${dayN} of ${totalDays} completed — client update published to portal` })
  const remaining = (await db.prepare(`SELECT COUNT(*) AS n FROM wo_days WHERE work_order_id=? AND company_id=? AND status!='completed'`).bind(woId, companyId).first<any>())?.n || 0
  const allDone = remaining === 0
  await db.prepare(`UPDATE work_orders SET timeline=?, ${allDone ? "status='completed'," : ''} updated_at=datetime('now') WHERE id=? AND company_id=?`)
    .bind(JSON.stringify(tl), woId, companyId).run()

  // Email portal users (same notification style as manual updates)
  let emailed = 0
  if (wo.client_id && (c.env as any).SENDGRID_API_KEY) {
    try {
      const pus = (await db.prepare(
        `SELECT DISTINCT pu.email, pu.name FROM portal_users pu
         JOIN portal_memberships pm ON pm.portal_user_id=pu.id AND pm.active=1
         WHERE pm.client_id=? AND pu.company_id=? AND pu.status='active' LIMIT 20`
      ).bind(wo.client_id, companyId).all()).results as any[] || []
      const origin = new URL(c.req.url).origin
      const escM = (s: string) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      for (const pu of pus) {
        const ok = await sendEmail((c.env as any).SENDGRID_API_KEY, pu.email,
          `Project update: ${wo.title || wo.wo_number || 'your project'} — day ${dayN} of ${totalDays}`,
          `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
            <h2 style="color:#1F2A2B;margin:0 0 4px">${escM(title)}</h2>
            <p style="font-size:12px;color:#6B7280;margin:0 0 16px">${escM(wo.title || '')} &middot; ${escM(updateDate)}${photoIds.length ? ` &middot; ${photoIds.length} photo${photoIds.length === 1 ? '' : 's'}` : ''}</p>
            <p style="font-size:14px;line-height:1.6;color:#1F2A2B;white-space:pre-wrap">${escM(bodyText.slice(0, 600))}${bodyText.length > 600 ? '&hellip;' : ''}</p>
            <p style="margin:20px 0"><a href="${origin}/portal/home#projects" style="display:inline-block;background:#2D7A55;color:#fff;text-decoration:none;font-weight:700;padding:12px 28px;border-radius:8px">View in Your Portal</a></p>
            <p style="font-size:11px;color:#9CA3AF">Sent by ${escM(coName)} via their client portal.</p>
          </div>`,
          { fromName: coName })
        if (ok) emailed++
      }
    } catch (_) { /* email failures never block completion */ }
  }

  return c.json({ ok: true, update_id: updId, title, body: bodyText, emailed,
    day_completed: dayN, total_days: totalDays, job_completed: allDone })
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
  <link rel="stylesheet" href="/js/premium.css?v=20260814b012">  <style>
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
  <script src="/js/platform_core.js?v=20260814b012"></script>
  <script src="/js/client_portal.js?v=20260814b012"></script>  <script>
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
          <span id="pwEye" style="display:inline-flex"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></span>
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
    var eyeOpen = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
    var eyeOff  = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
    if (inp.type === 'password') { inp.type = 'text'; eye.innerHTML = eyeOff; }
    else                         { inp.type = 'password'; eye.innerHTML = eyeOpen; }
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
  // Self-heal: platform owner's correct name is Tyler Johnson (was seeded as Tyler Grigg)
  if (rep.name === 'Tyler Grigg') {
    await c.env.DB.prepare("UPDATE reps SET name = 'Tyler Johnson' WHERE id = 'gw_tyler'").run()
    rep.name = 'Tyler Johnson'
  }
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
    // AUTH-CODE FLOW (persistent connection): Google redirects here with ?code=…
    // We hand the code to the opener via postMessage AND stash it in the URL hash
    // so legacy polling openers can read it cross-origin-safely (same origin here).
    (function(){
      var params = new URLSearchParams(location.search);
      var code = params.get('code');
      var state = params.get('state') || '';
      var error = params.get('error') || '';
      if (code) {
        // Make the code readable by the opener's polling loop via the hash
        try { location.hash = 'gcode=' + encodeURIComponent(code) + '&state=' + encodeURIComponent(state); } catch(e){}
        try { if (window.opener) window.opener.postMessage({ type:'gw_google_code', code: code, state: state }, location.origin); } catch(e){}
      } else if (error) {
        try { location.hash = 'gerror=' + encodeURIComponent(error); } catch(e){}
        try { if (window.opener) window.opener.postMessage({ type:'gw_google_error', error: error }, location.origin); } catch(e){}
      }
      // LEGACY IMPLICIT FLOW: token arrives in the URL hash — opener polls it. Keep page open briefly.
      if (window.opener) setTimeout(function(){ window.close(); }, 10000);
    })();
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
      <!-- Honeypot: invisible to humans; bots that fill it get a fake success -->
      <div style="position:absolute;left:-9999px;top:-9999px" aria-hidden="true">
        <label for="website_url">Website</label>
        <input type="text" id="website_url" name="website_url" tabindex="-1" autocomplete="off">
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
            business_type: document.getElementById('businessType').value,
            website_url: (document.getElementById('website_url')||{}).value || ''
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
    btn.textContent = 'Scanning local storage…';
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
        setStatus('✓ All ' + allOpps.length + ' lead' + (allOpps.length !== 1 ? 's are' : ' is') + ' already synced to the cloud. Nothing to recover!', 'success');
        btn.textContent = '↑ Recover My Leads Now';
        btn.disabled = false;
        return;
      }

      btn.textContent = 'Syncing ' + localOnly.length + ' lead' + (localOnly.length !== 1 ? 's' : '') + '…';
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
          setStatus('✕ You are not signed in. Please sign in to Groundwork CRM first, then come back to this page.', 'error');
        } else {
          setStatus('✕ Server error (' + res.status + '): ' + errText.slice(0, 200), 'error');
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
        setStatus('✓ Success! ' + inserted + ' lead' + (inserted !== 1 ? 's' : '') + ' recovered to the cloud.' +
          (skipped > 0 ? ' (' + skipped + ' already existed, skipped)' : '') +
          ' Return to the app and hit ⟳ to see them.', 'success');
        btn.textContent = '✓ Recovery Complete — Return to App';
        btn.onclick = function(){ window.location.href = '/'; };
      } else if (skipped > 0) {
        setStatus('✓ All ' + skipped + ' lead' + (skipped !== 1 ? 's were' : ' was') + ' already in the cloud. Nothing new to sync!', 'success');
        btn.textContent = '↑ Recover My Leads Now';
        btn.disabled = false;
      } else {
        setStatus('Nothing was synced. The server returned 0 inserted and 0 skipped. Try signing in to the app again then return here.', 'info');
        btn.textContent = '↑ Try Again';
        btn.disabled = false;
      }

    } catch (err) {
      setStatus('✕ Unexpected error: ' + err.message, 'error');
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
  <link rel="stylesheet" href="/js/premium.css?v=20260814b012">
  <link rel="stylesheet" href="/js/styles.css?v=20260814b012">
  <link rel="stylesheet" href="/js/groundwork-design.css?v=20260814b012">
  <link rel="stylesheet" href="/js/finance-shell.css?v=20260814b012">  <style>
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
        padding-bottom: calc(80px + var(--gw-safe-b, 0px)) !important;
      }

      /* ══════════════════════════════════════════════════════════════════════
         TOUCH SIZING — authoritative, keep last
         This is the final mobile rule in the last-loaded stylesheet, so it is
         the one place that reliably wins. Previously only .primary-btn,
         .secondary-btn and .danger-btn ever reached 44px; .rp-btn, .tab,
         .est-btn-*, .gw-btn-ghost and .topbar-icon-btn sat between 23px and
         34px, and several blocks above actively shrank buttons further on
         mobile. Anything a finger has to hit now clears --gw-tap (44px).
         ══════════════════════════════════════════════════════════════════════ */
      /* Broad by design. Enumerating class names was losing a whack-a-mole game
         (an audit found 66 of 85 on-screen controls still under 44px, including
         all 35 sidebar sub-nav rows). A button element defaults to inline-block
         and vertically centres its own label, so min-height alone is enough and
         we avoid forcing the display property, which would break buttons that
         legitimately lay their contents out as block or grid. */
      button, [role="button"], a.btn, .nav-subtab, select,
      /* The class selectors are repeated here on purpose: a bare element
         selector is specificity (0,0,1) and loses to any existing class-based
         !important rule such as .secondary-btn{min-height:34px!important}. */
      .primary-btn, .secondary-btn, .danger-btn, .install-btn,
      .rp-btn, .rp-btn--primary, .rp-btn--ghost,
      .est-btn-primary, .est-btn-secondary, .est-btn-ghost,
      .gw-btn-ghost, .tab, .int-action-btn, .topbar-new-btn, .topbar-settings,
      .gw-notif-bell, .gw-task-action-btn, .gw-trail-pill, .gw-trail-back {
        min-height: var(--gw-tap, 44px) !important;
      }

      .primary-btn, .secondary-btn, .danger-btn, .install-btn,
      .rp-btn, .rp-btn--primary, .rp-btn--ghost,
      .est-btn-primary, .est-btn-secondary, .est-btn-ghost,
      .gw-btn-ghost, .tab, .int-action-btn,
      .rp-header-actions button, .gw-toolbar button, .filter-row button {
        padding-top: 10px !important;
        padding-bottom: 10px !important;
        font-size: 14px !important;
        display: inline-flex !important;
        align-items: center !important;
      }


      /* The bottom nav sets its own height and must not be stretched by the
         broad rule above. */
      #gw-mobile-nav .gw-mnav-btn { min-height: 0 !important; }

      /* Icon-only controls: square, not stretched */
      .topbar-icon-btn, .menu-btn, .sidebar-close-btn, .rp-icon-btn {
        min-width: var(--gw-tap, 44px) !important;
        min-height: var(--gw-tap, 44px) !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
      }

      /* Small/dense variants stay usable without dominating the row */
      .rp-btn-sm, .est-btn-sm, .small.primary-btn, .small.secondary-btn {
        min-height: var(--gw-tap-sm, 38px) !important;
        font-size: 13px !important;
      }

      /* Sidebar nav rows — these are the primary navigation on a phone and were
         landing near 30px. Overrides the .nav-item rule earlier in this block. */
      .nav-item {
        min-height: var(--gw-tap, 44px) !important;
        padding-top: 11px !important;
        padding-bottom: 11px !important;
        font-size: 14px !important;
        display: flex !important;
        align-items: center !important;
      }
      .nav-item--sub { font-size: 13px !important; }

      /* Native controls: 16px keeps iOS Safari from zooming the page on focus */
      input, select, textarea,
      .search-wrap input, #searchInput {
        font-size: 16px !important;
        min-height: var(--gw-tap, 44px) !important;
      }
      /* Checkboxes and radios must not be stretched by the rule above */
      input[type=checkbox], input[type=radio] {
        min-height: 0 !important;
        width: 22px !important;
        height: 22px !important;
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

      <!-- ── Command Center (single top-level item — no subtabs/chevron; Business -->
      <!-- Pulse / Financial Snapshot / Operations Snapshot retired as separate   -->
      <!-- tabs, content now lives inline as Command Center widgets) ── -->
      <div class="nav-ws-group tenant-nav">
        <button class="nav-item nav-workspace active" data-view="gwDashboard" data-label="Command Center" onclick="show('today')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M5 1v3M11 1v3M2 7h12"/></svg>
          <span class="nav-workspace-label">Command Center</span>
        </button>
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

      <!-- ── Marketing ── -->
      <div class="nav-ws-group tenant-nav">
        <button class="nav-item nav-workspace" data-view="gwMarketing" data-label="Marketing" onclick="_gwTogglePanel('gwMarketing')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6.5l5.4-3.1a1.2 1.2 0 011.2 0L14 6.5v6a1 1 0 01-1 1H3a1 1 0 01-1-1z"/><path d="M2 6.5l6 4 6-4"/></svg>
          <span class="nav-workspace-label">Marketing</span>
          <svg class="nav-chevron-icon" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:auto;opacity:.45"><path d="M2 3.5l3 3 3-3"/></svg>
        </button>
        <div class="nav-subtabs" id="gw-subtabs-gwMarketing"></div>
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
          <button class="nav-item" data-view="gwDemos" onclick="show('gwDemos')">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M5 1.5v3M11 1.5v3M2 7h12"/><circle cx="8" cy="10.5" r="1.4"/></svg>
            Demo Requests
          </button>
          <button class="nav-item" data-view="gwPricing" onclick="show('gwPricing')">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px"><path d="M8.7 1.5H14v5.3l-6.8 6.8a1.5 1.5 0 0 1-2.1 0L1.9 10.4a1.5 1.5 0 0 1 0-2.1L8.7 1.5z"/><circle cx="11" cy="4.8" r="1" fill="currentColor" stroke="none"/></svg>
            Pricing Plans
          </button>
          <button class="nav-item" data-view="gwOnboarding" onclick="show('gwOnboarding')">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px"><path d="M2 8.5l3.5 3.5L14 3.5"/><path d="M2 13h6"/></svg>
            Onboarding
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

      <!-- ── Company identity — full company name + logo (desktop only) ── -->
      <div id="gw-company-badge" style="display:none;align-items:center;gap:9px;white-space:nowrap;overflow:hidden;max-width:340px" title="Current company workspace">
        <img id="gw-company-badge-logo" alt="" style="display:none;width:28px;height:28px;object-fit:contain;border-radius:6px;flex-shrink:0">
        <span id="gw-company-badge-name" style="overflow:hidden;text-overflow:ellipsis;font-size:13.5px;font-weight:800;letter-spacing:.01em"></span>
      </div>
      <style>@media (max-width: 900px){ #gw-company-badge{ display:none !important } }</style>

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

<!-- Calendar dates. Must load before anything that renders one. See the header
     of public/js/gw_date.js for the two day-shift bugs it exists to end. -->
<script src="/js/gw_date.js?v=20260814b012"></script>
<script src="/js/gw-icons.js?v=20260814b012"></script>
<script src="/js/sales-process.js?v=20260814b012"></script>
<script src="/js/richtext.js?v=20260814b012"></script>
<script src="/js/db.js?v=20260814b012"></script>
<script src="/js/data.js?v=20260814b012"></script>
<script src="/js/reps.js?v=20260814b012"></script>
<script src="/js/record-page.js?v=20260814b012"></script>
<script src="/js/academy.js?v=20260814b012"></script>
<script src="/js/task_engine.js?v=20260814b012"></script>
<script src="/js/gw_i18n.js?v=20260814b012"></script>
<script src="/js/app_premium.js?v=20260814b012"></script>
<script src="/js/estimates.js?v=20260814b012"></script>
<script src="/js/multiday.js?v=20260814b012"></script>
<script src="/js/proposals.js?v=20260814b012"></script>
<script src="/js/pricing.js?v=20260814b012"></script>
<script src="/js/invoices.js?v=20260814b012"></script>
<script src="/js/csv_import.js?v=20260814b012"></script>
<script src="/js/onboarding.js?v=20260814b012"></script>
<script src="/js/gw_copilot.js?v=20260814b012"></script>
<script src="/js/groundwork_ai.js?v=20260814b012"></script>
<script src="/js/recurring_plans.js?v=20260814b012"></script>
<script src="/js/reviews.js?v=20260814b012"></script>
<script src="/js/stripe.js?v=20260814b012"></script>
<script src="/js/email.js?v=20260814b012"></script>
<script src="/js/notifications.js?v=20260814b012"></script>
<script src="/js/integrations.js?v=20260814b012"></script>
<script src="/js/sms.js?v=20260814b012"></script>
<script src="/js/calendar_sync.js?v=20260814b012"></script>
<script src="/js/ai_followup.js?v=20260814b012"></script>
<script src="/js/user_management.js?v=20260814b012"></script>
<script src="/js/platform_admin.js?v=20260814b012"></script>
<script src="/js/time_tracker.js?v=20260814b012"></script>
<script src="/js/field_workday.js?v=20260814b012"></script>
<script src="/js/platform_core.js?v=20260814b012"></script>
<script src="/js/approval_engine.js?v=20260814b012"></script>
<script src="/js/automation_engine.js?v=20260814b012"></script>
<script src="/js/client_portal.js?v=20260814b012"></script>
<script src="/js/field_mode.js?v=20260814b012"></script>
<script src="/js/assets_hub.js?v=20260814b012"></script><script src="/js/marketing.js?v=20260814b012"></script><script>
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
        // ── Company context badge: always show which workspace you're in ──
        try {
          const badge = document.getElementById('gw-company-badge');
          const nameEl = document.getElementById('gw-company-badge-name');
          if (badge && nameEl) {
            // Fetch company display name + logo (branding endpoint is session-scoped)
            fetch('/api/company/branding', { credentials: 'include' })
              .then(r => r.ok ? r.json() : null)
              .then(j => {
                const co = j && (j.data || j);
                const label = (co && co.name) || d1Rep.company_id || '';
                if (label) {
                  nameEl.textContent = label;
                  badge.style.display = 'inline-flex';
                  const logoEl = document.getElementById('gw-company-badge-logo');
                  if (logoEl && co && co.logo_url) {
                    logoEl.src = co.logo_url;
                    logoEl.style.display = 'block';
                    logoEl.onerror = function(){ this.style.display = 'none'; };
                  }
                  // Impersonation warning: super-admin inside another tenant
                  if (d1Rep.is_super_admin && d1Rep.company_id !== 'groundwork_platform') {
                    nameEl.style.textDecoration = 'underline dotted #C9A961';
                    nameEl.style.textUnderlineOffset = '3px';
                    badge.title = 'You are working inside ' + label + ' — impersonation/tenant session';
                  }
                }
              }).catch(() => {});
          }
        } catch (_) {}
        // ── Tenant guard: if this browser last cached a DIFFERENT company's
        //    data, wipe it before any view renders (impersonation / shared PCs)
        try {
          const lastCo = localStorage.getItem('gwLastCompany');
          const switched = lastCo !== window._companyId && !(lastCo === null && window._companyId === 'avalon');
          if (switched && typeof window.gwClearTenantState === 'function') {
            window.gwClearTenantState();
            // Restore the auth marker for the CURRENT session (cleared above)
            try { localStorage.setItem('avalonRepAuth', JSON.stringify({ repId: d1Rep.id, loginAt: new Date().toISOString() })); } catch (_) {}
          }
          localStorage.setItem('gwLastCompany', window._companyId);
        } catch (_) {}
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
              // Hydrate language preference from D1 (overrides localStorage default)
              if (bs.data.rep && bs.data.rep.preferred_language) {
                const _bsLang = bs.data.rep.preferred_language;
                if (_bsLang === 'en' || _bsLang === 'es') {
                  window._gwLang = _bsLang;
                  try { localStorage.setItem('gw_lang', _bsLang); } catch(_) {}
                }
              }
              if (typeof window._hydrateRepsFromBootstrap === 'function') {
                window._hydrateRepsFromBootstrap(bs.data.reps);
              }
              if (window.AVALON_DATA && bs.data.pipelineStages) {
                window.AVALON_DATA.statuses = bs.data.pipelineStages;
              }
              // ── Trial status + email-verification UI ─────────────────────
              try {
                const co = bs.data.company;
                if (co && co.subscription_status === 'trial' && co.trial_expires_at) {
                  const msLeft = new Date(co.trial_expires_at).getTime() - Date.now();
                  const daysLeft = Math.ceil(msLeft / 86400000);
                  if (msLeft <= 0) {
                    // Trial expired — full-screen overlay (API is already gated server-side with 402)
                    const ov = document.createElement('div');
                    ov.id = 'gw-trial-expired';
                    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(10,26,22,.96);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px)';
                    ov.innerHTML = '<div style="max-width:440px;background:#fff;border-radius:20px;padding:40px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.4)">' +
                      '<div style="font-size:40px;margin-bottom:14px">⏰</div>' +
                      '<h2 style="margin:0 0 10px;color:#0E372F;font-size:21px;font-weight:800">Your free trial has ended</h2>' +
                      '<p style="margin:0 0 24px;color:#4a5f58;font-size:14px;line-height:1.6">Your 14-day trial of Groundwork CRM is over. Your data is safe — upgrade to keep using your account.</p>' +
                      '<a href="mailto:support@groundwork-crm.com?subject=Upgrade%20my%20Groundwork%20account" style="display:inline-block;background:#2D7A55;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 36px;border-radius:12px;margin-bottom:12px">Contact us to upgrade</a>' +
                      '<div><button onclick="window.logoutRep&&window.logoutRep()" style="background:none;border:none;color:#8aa39a;font-size:13px;cursor:pointer;text-decoration:underline;margin-top:8px">Sign out</button></div></div>';
                    document.body.appendChild(ov);
                  } else if (daysLeft <= 14) {
                    // Trial countdown pill in the topbar (next to company badge)
                    const badge = document.getElementById('gw-company-badge');
                    if (badge) {
                      const pill = document.createElement('span');
                      pill.id = 'gw-trial-pill';
                      const urgent = daysLeft <= 3;
                      pill.style.cssText = 'display:inline-flex;align-items:center;gap:5px;margin-left:8px;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;' +
                        (urgent ? 'background:rgba(201,123,106,.15);color:#C97B6A;border:1px solid rgba(201,123,106,.35)' : 'background:rgba(139,105,20,.12);color:#8B6914;border:1px solid rgba(139,105,20,.3)');
                      pill.textContent = 'Trial · ' + daysLeft + (daysLeft === 1 ? ' day left' : ' days left');
                      badge.after(pill);
                    }
                  }
                }
                // Email-verification banner (soft gate; only when SendGrid sent something)
                const params = new URLSearchParams(location.search);
                if (params.get('verify') === 'ok' && window.showToast) { window.showToast('✓ Email verified — thank you!'); history.replaceState(null,'',location.pathname); }
                if (bs.data.rep && bs.data.rep.email_verified === false && co && co.subscription_status === 'trial' && !document.getElementById('gw-verify-banner')) {
                  const vb = document.createElement('div');
                  vb.id = 'gw-verify-banner';
                  vb.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:9000;background:#0E372F;color:#fff;border-radius:12px;padding:10px 18px;font-size:13px;display:flex;align-items:center;gap:12px;box-shadow:0 8px 30px rgba(0,0,0,.3)';
                  vb.innerHTML = '<span style="display:inline-flex;align-items:center;gap:8px">' + ((typeof gwIcon==='function')?gwIcon('email',15,'#fff'):'') + ' Please verify your email address to secure your account.</span>' +
                    '<button id="gw-verify-resend" style="background:#2D7A55;border:none;color:#fff;font-weight:700;font-size:12px;padding:6px 14px;border-radius:8px;cursor:pointer">Resend link</button>' +
                    '<button onclick="this.parentElement.remove()" style="background:none;border:none;color:rgba(255,255,255,.5);font-size:16px;cursor:pointer;padding:0 2px">×</button>';
                  document.body.appendChild(vb);
                  document.getElementById('gw-verify-resend').addEventListener('click', async function() {
                    this.disabled = true; this.textContent = 'Sending…';
                    try {
                      const r = await fetch('/api/auth/resend-verification', { method:'POST', credentials:'include' });
                      const j = await r.json();
                      this.textContent = (j.data && (j.data.sent || j.data.verified)) ? '✓ Sent' : 'Email not configured';
                    } catch(_) { this.textContent = 'Failed'; this.disabled = false; }
                  });
                }
              } catch(trialErr) { console.warn('[Trial UI]', trialErr.message); }
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
            // Render language toggle above footer after footer.innerHTML is set
            try { if (typeof window._gwRenderLangToggle === 'function') window._gwRenderLangToggle(); } catch(_) {}
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

        // Hydrate financial overrides from D1 settings → localStorage.
        // These were previously localStorage-only, so budget/division edits
        // vanished whenever the browser cleared storage. D1 is now the
        // write-behind authority (saved via PUT /api/settings on every edit).
        try {
          const setRes = await fetch('/api/settings', { credentials: 'include' });
          if (setRes.ok) {
            const setJ = await setRes.json();
            const settings = (setJ && (setJ.data ?? setJ)) || {};
            const FIN_MAP = {
              fin_annual_overrides: 'avalonAnnualOverrides',
              fin_division_actuals: 'avalonDivisionActuals',
              fin_revenue_actuals:  'avalonRevenueActuals',
              company_divisions:    'gwCompanyDivisions',
              company_intake_config:'gwIntakeConfig',
              schedule_preferences: 'gw_schedule_preferences',
            };
            for (const [dk, lk] of Object.entries(FIN_MAP)) {
              if (settings[dk]) {
                try { JSON.parse(settings[dk]); localStorage.setItem(lk, settings[dk]); } catch(_e) {}
              } else if (dk === 'company_divisions' || dk === 'company_intake_config') {
                // No custom config for this company — clear any stale value from a
                // previous session so built-in defaults apply.
                try { localStorage.removeItem(lk); } catch(_e) {}
              }
            }
            console.log('[Bootstrap] Financial overrides hydrated from D1');
          }
        } catch(e) {
          console.warn('[Bootstrap] Could not hydrate financial settings:', e.message);
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
              // Sidebar subtitle shows the real company name (not "Sales CRM")
              const sub = document.querySelector('.brand-subtitle');
              if (sub) sub.textContent = name;
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

// ── Client Portal (Release 1) — auth, scoping, admin, pages ──────────────────
registerPortal(app, { requireStaffAuth: requireAuth, sendEmail, woFlipHolds: _woFlipHolds })

// ── Branded 404 — replaces Hono's bare "404 Not Found" text response ─────────
app.notFound((c) => {
  // API routes still get JSON
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: 'Not found' }, 404)
  }
  return c.html(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Page Not Found — Groundwork CRM</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0F1F1E;color:#E8EDE8;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .nf-card{max-width:440px;width:100%;text-align:center;background:#162927;border:1px solid #2e4040;border-radius:16px;padding:44px 32px}
    .nf-mark{font-size:15px;font-weight:800;letter-spacing:.4px;color:#5CC8A8;margin-bottom:22px}
    h1{font-size:22px;font-weight:800;margin-bottom:10px}
    p{font-size:14px;line-height:1.6;color:rgba(232,237,232,.65);margin-bottom:22px}
    a.nf-btn{display:inline-block;background:#2D7A55;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 26px;border-radius:9px}
  </style>
</head><body>
  <div class="nf-card">
    <div class="nf-mark">GROUNDWORK CRM</div>
    <h1>Page not found</h1>
    <p>This link is invalid or has expired. If you followed a link from an email, please contact your service provider for an updated link.</p>
    <a class="nf-btn" href="/">Go to homepage</a>
  </div>
</body></html>`, 404)
})

export default app
