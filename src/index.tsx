import { Hono } from 'hono'
import { serveStatic } from 'hono/cloudflare-workers'
import { cors } from 'hono/cors'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'

type Bindings = { DB: D1Database }
type Variables = { repId: string; companyId: string; role: string }

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

// ── requireAuth middleware ────────────────────────────────────────────────────
// Resolves session cookie → rep → company_id, sets c.var.{repId,companyId,role}
async function requireAuth(c: any, next: any) {
  const token = getCookie(c, 'avalon_session')
  if (!token) return err(c, 'Unauthorized', 401)
  // Session key stores repId; rep row has company_id
  const row = await c.env.DB.prepare(`
    SELECT r.id as rep_id, r.company_id, r.role
    FROM settings s
    JOIN reps r ON r.id = s.value AND r.company_id = (
      SELECT company_id FROM reps WHERE id = s.value LIMIT 1
    )
    WHERE s.key = ? LIMIT 1
  `).bind(`session_${token}`).first<{ rep_id: string; company_id: string; role: string }>()
  if (!row) return err(c, 'Session expired', 401)
  c.set('repId',     row.rep_id)
  c.set('companyId', row.company_id)
  c.set('role',      row.role)
  await next()
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES  (no requireAuth — these establish identity)
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/auth/login  { repId, pin, companyId? }
app.post('/api/auth/login', async (c) => {
  const { repId, pin, companyId } = await c.req.json()
  if (!repId || !pin) return err(c, 'repId and pin required')
  // companyId is optional — if omitted, look up by repId alone (single-tenant mode)
  let rep: any
  if (companyId) {
    rep = await c.env.DB.prepare(
      'SELECT * FROM reps WHERE id = ? AND pin = ? AND company_id = ? AND active = 1 LIMIT 1'
    ).bind(repId, String(pin), companyId).first()
  } else {
    rep = await c.env.DB.prepare(
      'SELECT * FROM reps WHERE id = ? AND pin = ? AND active = 1 LIMIT 1'
    ).bind(repId, String(pin)).first()
  }
  if (!rep) return err(c, 'Invalid credentials', 401)
  const token = uid() + uid()
  // Store session: key = session_{token}, value = repId
  // We also store company_id in a second key for fast lookup
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
  const { pin: _p, ...safeRep } = rep as any
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
    'SELECT id, name, title, role, color, commission_plan, company_id FROM reps WHERE id = ? LIMIT 1'
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
    'SELECT id, name, title, role, color, commission_plan, active, company_id FROM reps WHERE company_id = ? AND active = 1 ORDER BY name'
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
app.post('/api/reps', async (c) => {
  const b = await c.req.json()
  if (!b.id || !b.name || !b.pin || !b.companyId) return err(c, 'id, name, pin, companyId required')
  await c.env.DB.prepare(`
    INSERT INTO reps (id, name, title, role, pin, color, commission_plan, company_id, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).bind(b.id, b.name, b.title||'', b.role||'rep', b.pin, b.color||'#6366f1', b.commissionPlan||'standard', b.companyId).run()
  return json(c, { id: b.id }, 201)
})

// PUT /api/reps/:id
app.put('/api/reps/:id', async (c) => {
  const id = c.req.param('id')
  const b  = await c.req.json()
  const companyId = b.companyId || 'avalon'
  const fields = ['name','title','role','color','pin','commission_plan','active']
  const updates = fields.filter(f => b[f] !== undefined)
  if (!updates.length) return err(c, 'Nothing to update')
  const set = updates.map(f => `${f} = ?`).join(', ')
  const vals = updates.map(f => b[f])
  await c.env.DB.prepare(
    `UPDATE reps SET ${set}, updated_at = datetime('now') WHERE id = ? AND company_id = ?`
  ).bind(...vals, id, companyId).run()
  return json(c, { updated: id })
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
      commission_approved, collected, sold_date, sold_amount, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
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

// Google OAuth2 callback page — receives access token from Google's implicit flow,
// posts it back to the opener window, then closes itself.
app.get('/auth/google/callback', (c) => {
  return c.html(`<!DOCTYPE html>
<html>
<head>
  <title>Connecting to Google…</title>
  <style>
    body { font-family: Inter, sans-serif; background: #0f172a; color: #e2e8f0;
           display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; flex-direction: column; gap: 16px; }
    .spinner { width: 40px; height: 40px; border: 3px solid #334155; border-top-color: #00A7E1; border-radius: 50%; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    p { color: #94a3b8; font-size: 14px; margin: 0; }
  </style>
</head>
<body>
  <div class="spinner"></div>
  <p>Connecting to Google — you can close this window if it doesn't close automatically.</p>
  <script>
    // The access token arrives in the URL hash via Google's implicit flow.
    // The opener (integrations.js) polls this page's location.hash to read it.
    // Nothing needs to happen here — just stay open so the polling can read the hash.
    
    // Auto-close after 5 seconds as a fallback
    if (window.opener) {
      // Let the opener read our hash, then close
      setTimeout(() => window.close(), 5000);
    }
  </script>
</body>
</html>`)
})

// Main app - serve the Avalon Sales Hub
app.get('/', (c) => {
  return c.html(getHtml())
})

function getHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Avalon Sales Hub</title>
  <link rel="icon" type="image/png" href="/static/avalon-logo.png" />
  <meta name="theme-color" content="#00A7E1" />
  <meta name="description" content="Avalon Landscape Construction internal sales operating hub." />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/static/premium.css">
  <link rel="stylesheet" href="/static/styles.css?v=20260624">
</head>
<body>
<div id="sidebarScrim" class="sidebar-scrim"></div>
<div class="app-shell">
  <aside class="sidebar" id="sidebar">
    <div class="brand">
      <div class="brand-mark" onclick="show('today')" style="cursor:pointer" title="Go to Today">
        <img src="/static/avalon-logo.png" alt="Avalon logo" style="width:42px;height:42px;object-fit:contain;">
      </div>
      <div>
        <div class="brand-name">Avalon</div>
        <div class="brand-subtitle">Landscape Construction</div>
        <div class="brand-kicker">Sales Hub</div>
      </div>
    </div>
    <nav class="nav" id="mainNav" role="navigation">

      <details class="nav-group" open>
        <summary class="nav-summary">🏠 Home</summary>
        <div class="nav-items">
          <button class="nav-item active" data-view="today" onclick="show('today')">Today</button>
          <button class="nav-item" data-view="myDashboard" onclick="show('myDashboard')">My Dashboard</button>
        </div>
      </details>

      <details class="nav-group" open>
        <summary class="nav-summary">📊 Pipeline</summary>
        <div class="nav-items">
          <button class="nav-item" data-view="pipeline" onclick="show('pipeline')">Pipeline</button>
          <button class="nav-item" data-view="lead" onclick="show('lead')">Add Lead</button>
          <button class="nav-item" data-view="clients" onclick="show('clients')">Clients &amp; Properties</button>
        </div>
      </details>

      <details class="nav-group">
        <summary class="nav-summary">🛠️ Sales Toolkit</summary>
        <div class="nav-items">
          <button class="nav-item" data-view="process" onclick="show('process')">Sales Process</button>
          <button class="nav-item" data-view="forms" onclick="show('forms')">Forms &amp; Checklists</button>
          <button class="nav-item" data-view="scripts" onclick="show('scripts')">Scripts</button>
          <button class="nav-item" data-view="templates" onclick="show('templates')">Email Templates</button>
          <button class="nav-item" data-view="objections" onclick="show('objections')">Objection Handling</button>
          <button class="nav-item" data-view="calculator" onclick="show('calculator')">Pricing Tools</button>
          <button class="nav-item" data-view="ai" onclick="show('ai')" style="color:#6366f1;font-weight:600">✦ AI Sales Assistant</button>
        </div>
      </details>

      <details class="nav-group">
        <summary class="nav-summary">🎓 Learning</summary>
        <div class="nav-items">
          <button class="nav-item" data-view="academy" onclick="show('academy')">Sales Academy</button>
        </div>
      </details>

      <details class="nav-group">
        <summary class="nav-summary">⚙️ Admin</summary>
        <div class="nav-items">
          <button class="nav-item" data-view="manager" onclick="show('manager')">Manager Tools</button>
          <button class="nav-item" data-view="revenueAdmin" onclick="show('revenueAdmin')">Financial Data Hub</button>
          <button class="nav-item" data-view="integrations" onclick="show('integrations')">Integrations</button>
          <button class="nav-item" data-view="userManagement" onclick="show('userManagement')">User Management</button>
          <button class="nav-item" data-view="settings" onclick="show('settings')">Settings</button>
        </div>
      </details>

    </nav>
    <div class="sidebar-footer">
      <strong>Avalon Sales OS</strong><br>
      Consultative. Profitable.<br>Operationally clean. Easy to trust.
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

<script src="/static/db.js?v=20260627"></script>
<script src="/static/data.js?v=20260624"></script>
<script src="/static/reps.js?v=20260624"></script>
<script src="/static/academy.js?v=20260624"></script>
<script src="/static/app_premium.js?v=20260627"></script>
<script src="/static/integrations.js?v=20260624"></script>
<script src="/static/import_clients_csv.js?v=20260624"></script>
<script src="/static/user_management.js?v=20260624"></script>
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
