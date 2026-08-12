/**
 * Authenticated Marketing OS API, mounted at /api/marketing.
 *
 * Mounted rather than inlined into src/index.tsx, following the Finance OS
 * precedent (src/api/rates.ts, src/api/actions.ts). index.tsx is already 1.5 MB
 * and every addition to it raises the cost of the next one.
 *
 * requireAuth is applied at the mount point in index.tsx, so every handler here
 * can rely on c.var.companyId and must scope its queries by it.
 */

import { Hono } from 'hono';
import { parseCampaignDoc, serializeCampaignDoc, newBlock, BLOCK_LABELS, BLOCK_TYPES } from './blocks';
import {
  AUDIENCE_FIELDS, AUDIENCE_HISTORY_FIELDS, compileAudience, compileAudienceCount,
  compileSuppressedCount, describeFilter, parseFilter,
} from './audience';
import { approvalBlockers, composeCampaign, originOf, persistRender, type CampaignRow } from './compose';
import { SendGridProvider } from './providers/sendgrid';
import { addSuppression, drainCampaign, randomToken, snapshotAudience, DEFAULT_BATCH_SIZE } from './send';

export type MarketingBindings = {
  DB: D1Database;
  MEDIA: R2Bucket;
  SENDGRID_API_KEY?: string;
};
export type MarketingVariables = {
  repId: string;
  companyId: string;
  role: string;
  isSuperAdmin: boolean;
};

type Env = { Bindings: MarketingBindings; Variables: MarketingVariables };

export const marketingRouter = new Hono<Env>();

// ── helpers ──────────────────────────────────────────────────────────────────

const nowIso = () => new Date().toISOString();
const newId = (p: string) => `${p}_${randomToken(10)}`;
const s = (v: unknown, max = 2000): string => String(v ?? '').slice(0, max);
const bool = (v: unknown): number => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

/**
 * Roles allowed to touch marketing. Crew roles are excluded entirely rather
 * than given a read-only view: campaign screens show client contact lists and
 * revenue attribution, which UI INVARIANTS keeps away from crew.
 */
const WRITE_ROLES = new Set(['admin', 'office_manager']);
const READ_ROLES = new Set(['admin', 'office_manager', 'rep']);

const canWrite = (c: { var: MarketingVariables }) => c.var.isSuperAdmin || WRITE_ROLES.has(c.var.role);
const canRead = (c: { var: MarketingVariables }) => c.var.isSuperAdmin || READ_ROLES.has(c.var.role);

marketingRouter.use('*', async (c, next) => {
  if (!canRead(c)) return c.json({ error: 'forbidden' }, 403);
  if (c.req.method !== 'GET' && !canWrite(c)) return c.json({ error: 'forbidden' }, 403);
  await next();
});

const body = async (c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> => {
  try {
    const v = await c.req.json();
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const loadCampaign = (db: D1Database, companyId: string, id: string) =>
  db
    .prepare(`SELECT * FROM marketing_campaign WHERE id = ? AND company_id = ? LIMIT 1`)
    .bind(id, companyId)
    .first<CampaignRow>();

// ══ brand kit ════════════════════════════════════════════════════════════════

marketingRouter.get('/brand', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT * FROM marketing_brand_profile WHERE company_id = ? AND active = 1 ORDER BY created_at LIMIT 1`,
  )
    .bind(c.var.companyId)
    .first();
  return c.json({ brand: row ?? null });
});

marketingRouter.put('/brand', async (c) => {
  const b = await body(c);
  const db = c.env.DB;
  const companyId = c.var.companyId;
  const existing = await db
    .prepare(`SELECT id FROM marketing_brand_profile WHERE company_id = ? AND active = 1 LIMIT 1`)
    .bind(companyId)
    .first<{ id: string }>();

  const fields = {
    name: s(b.name, 200),
    colors_json: s(JSON.stringify(b.colors ?? {}), 4000),
    logo_light_asset_id: s(b.logo_light_asset_id, 60) || null,
    logo_dark_asset_id: s(b.logo_dark_asset_id, 60) || null,
    voice_json: s(JSON.stringify(b.voice ?? []), 4000),
    footer_json: s(JSON.stringify(b.footer ?? {}), 4000),
    default_ctas_json: s(JSON.stringify(b.default_ctas ?? []), 4000),
    physical_address: s(b.physical_address, 400),
  };

  if (existing) {
    await db
      .prepare(
        `UPDATE marketing_brand_profile
           SET name=?, colors_json=?, logo_light_asset_id=?, logo_dark_asset_id=?,
               voice_json=?, footer_json=?, default_ctas_json=?, physical_address=?, updated_at=?
         WHERE id=? AND company_id=?`,
      )
      .bind(
        fields.name, fields.colors_json, fields.logo_light_asset_id, fields.logo_dark_asset_id,
        fields.voice_json, fields.footer_json, fields.default_ctas_json, fields.physical_address,
        nowIso(), existing.id, companyId,
      )
      .run();
    return c.json({ id: existing.id });
  }

  const id = newId('brand');
  await db
    .prepare(
      `INSERT INTO marketing_brand_profile
         (id, company_id, name, colors_json, logo_light_asset_id, logo_dark_asset_id,
          voice_json, footer_json, default_ctas_json, physical_address)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      id, companyId, fields.name, fields.colors_json, fields.logo_light_asset_id,
      fields.logo_dark_asset_id, fields.voice_json, fields.footer_json,
      fields.default_ctas_json, fields.physical_address,
    )
    .run();
  return c.json({ id });
});

// ══ service profiles ═════════════════════════════════════════════════════════

marketingRouter.get('/service-profiles', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT * FROM marketing_service_profile WHERE company_id = ? ORDER BY active DESC, name`,
  )
    .bind(c.var.companyId)
    .all();
  return c.json({ profiles: rows.results ?? [] });
});

marketingRouter.post('/service-profiles', async (c) => {
  const b = await body(c);
  const name = s(b.name, 160).trim();
  if (!name) return c.json({ error: 'name is required' }, 400);
  const id = newId('svc');
  await c.env.DB.prepare(
    `INSERT INTO marketing_service_profile
       (id, company_id, name, category, season, customer_type, benefits_json,
        preferred_cta_label, form_id, window_start_month, window_end_month,
        approved_copy, do_not_claim)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id, c.var.companyId, name, s(b.category, 80), s(b.season, 40), s(b.customer_type, 40),
      s(JSON.stringify(b.benefits ?? []), 4000), s(b.preferred_cta_label, 80),
      s(b.form_id, 60) || null,
      b.window_start_month == null ? null : Number(b.window_start_month),
      b.window_end_month == null ? null : Number(b.window_end_month),
      s(b.approved_copy, 4000), s(b.do_not_claim, 2000),
    )
    .run();
  return c.json({ id });
});

marketingRouter.put('/service-profiles/:id', async (c) => {
  const b = await body(c);
  const res = await c.env.DB.prepare(
    `UPDATE marketing_service_profile
       SET name=?, category=?, season=?, customer_type=?, benefits_json=?,
           preferred_cta_label=?, form_id=?, window_start_month=?, window_end_month=?,
           approved_copy=?, do_not_claim=?, active=?, updated_at=?
     WHERE id=? AND company_id=?`,
  )
    .bind(
      s(b.name, 160), s(b.category, 80), s(b.season, 40), s(b.customer_type, 40),
      s(JSON.stringify(b.benefits ?? []), 4000), s(b.preferred_cta_label, 80),
      s(b.form_id, 60) || null,
      b.window_start_month == null ? null : Number(b.window_start_month),
      b.window_end_month == null ? null : Number(b.window_end_month),
      s(b.approved_copy, 4000), s(b.do_not_claim, 2000),
      b.active === undefined ? 1 : bool(b.active), nowIso(),
      c.req.param('id'), c.var.companyId,
    )
    .run();
  if (!res.meta?.changes) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

marketingRouter.delete('/service-profiles/:id', async (c) => {
  await c.env.DB.prepare(`DELETE FROM marketing_service_profile WHERE id=? AND company_id=?`)
    .bind(c.req.param('id'), c.var.companyId)
    .run();
  return c.json({ ok: true });
});

// ══ media library ════════════════════════════════════════════════════════════

marketingRouter.get('/assets', async (c) => {
  const q = s(c.req.query('q'), 120).trim().toLowerCase();
  const approvedOnly = c.req.query('approved') === '1';
  const binds: unknown[] = [c.var.companyId];
  let sql = `SELECT * FROM marketing_asset WHERE company_id = ?`;
  if (approvedOnly) sql += ` AND approved_for_marketing = 1`;
  if (q) {
    sql += ` AND (lower(file_name) LIKE ? OR lower(alt_text) LIKE ? OR lower(tags_json) LIKE ?)`;
    binds.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += ` ORDER BY created_at DESC LIMIT 300`;
  const rows = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json({ assets: rows.results ?? [] });
});

marketingRouter.post('/assets', async (c) => {
  let form: FormData | null = null;
  try {
    form = await c.req.formData();
  } catch {
    form = null;
  }
  if (!form) return c.json({ error: 'multipart/form-data required' }, 400);

  const file = form.get('file') as unknown as File | null;
  if (!file || typeof file.arrayBuffer !== 'function') return c.json({ error: 'file field required' }, 400);

  const MAX = 10 * 1024 * 1024;
  if (file.size > MAX) return c.json({ error: 'File too large (max 10 MB)' }, 413);
  const contentType = file.type || 'application/octet-stream';
  if (!contentType.startsWith('image/')) return c.json({ error: 'Only images allowed' }, 400);

  const id = newId('mas');
  const safeName = String(file.name || 'upload').replace(/[^\w.\- ]/g, '_').slice(0, 120);
  const key = `marketing/${c.var.companyId}/${id}_${safeName}`;
  await c.env.MEDIA.put(key, await file.arrayBuffer(), { httpMetadata: { contentType } });

  await c.env.DB.prepare(
    `INSERT INTO marketing_asset
       (id, company_id, r2_key, file_name, content_type, size_bytes, width, height,
        alt_text, tags_json, service_profile_id, season, property_type,
        approved_for_marketing, source, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'upload',?)`,
  )
    .bind(
      id, c.var.companyId, key, safeName, contentType, file.size || 0,
      Number(form.get('width') || 0), Number(form.get('height') || 0),
      s(form.get('alt_text'), 300), s(form.get('tags_json'), 2000) || '[]',
      s(form.get('service_profile_id'), 60) || null,
      s(form.get('season'), 40), s(form.get('property_type'), 40),
      bool(form.get('approved_for_marketing')), c.var.repId,
    )
    .run();
  return c.json({ id, r2_key: key });
});

marketingRouter.put('/assets/:id', async (c) => {
  const b = await body(c);
  const res = await c.env.DB.prepare(
    `UPDATE marketing_asset
       SET alt_text=?, tags_json=?, service_profile_id=?, season=?, property_type=?,
           approved_for_marketing=?
     WHERE id=? AND company_id=?`,
  )
    .bind(
      s(b.alt_text, 300), s(JSON.stringify(b.tags ?? []), 2000),
      s(b.service_profile_id, 60) || null, s(b.season, 40), s(b.property_type, 40),
      bool(b.approved_for_marketing), c.req.param('id'), c.var.companyId,
    )
    .run();
  if (!res.meta?.changes) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

marketingRouter.delete('/assets/:id', async (c) => {
  const row = await c.env.DB.prepare(`SELECT r2_key, source FROM marketing_asset WHERE id=? AND company_id=?`)
    .bind(c.req.param('id'), c.var.companyId)
    .first<{ r2_key: string; source: string }>();
  if (!row) return c.json({ error: 'not found' }, 404);
  await c.env.DB.prepare(`DELETE FROM marketing_asset WHERE id=? AND company_id=?`)
    .bind(c.req.param('id'), c.var.companyId)
    .run();
  // An imported job photo shares its object with project_media. Deleting the
  // bytes would blow a hole in the work order's documentation, so only assets
  // uploaded here own their R2 object.
  if (row.source !== 'from_project') {
    try {
      await c.env.MEDIA.delete(row.r2_key);
    } catch {
      /* the row is gone either way; a stray object is harmless */
    }
  }
  return c.json({ ok: true });
});

/** Adopt an existing job photo without copying the bytes in R2. */
marketingRouter.post('/assets/import-from-project', async (c) => {
  const b = await body(c);
  const mediaId = s(b.project_media_id, 60);
  if (!mediaId) return c.json({ error: 'project_media_id is required' }, 400);

  const src = await c.env.DB.prepare(
    `SELECT r2_key, file_name, content_type, size_bytes FROM project_media WHERE id=? AND company_id=?`,
  )
    .bind(mediaId, c.var.companyId)
    .first<{ r2_key: string; file_name: string; content_type: string; size_bytes: number }>();
  if (!src) return c.json({ error: 'not found' }, 404);

  const id = newId('mas');
  await c.env.DB.prepare(
    `INSERT INTO marketing_asset
       (id, company_id, r2_key, file_name, content_type, size_bytes, alt_text,
        tags_json, approved_for_marketing, source, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,'from_project',?)`,
  )
    .bind(
      id, c.var.companyId, src.r2_key, src.file_name, src.content_type, src.size_bytes,
      s(b.alt_text, 300), '[]', bool(b.approved_for_marketing), c.var.repId,
    )
    .run();
  return c.json({ id });
});

// ══ audiences ════════════════════════════════════════════════════════════════

marketingRouter.get('/audiences/fields', (c) =>
  c.json({
    fields: Object.entries(AUDIENCE_FIELDS).map(([key, def]) => ({ key, label: def.label, kind: def.kind })),
    history_fields: AUDIENCE_HISTORY_FIELDS,
  }),
);

marketingRouter.get('/audiences', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT * FROM marketing_audience WHERE company_id = ? ORDER BY name`,
  )
    .bind(c.var.companyId)
    .all<{ filter_json: string }>();
  const audiences = (rows.results ?? []).map((r) => ({ ...r, description_text: describeFilter(r.filter_json) }));
  return c.json({ audiences });
});

marketingRouter.post('/audiences', async (c) => {
  const b = await body(c);
  const name = s(b.name, 160).trim();
  if (!name) return c.json({ error: 'name is required' }, 400);
  const id = newId('aud');
  await c.env.DB.prepare(
    `INSERT INTO marketing_audience (id, company_id, name, description, filter_json, created_by)
     VALUES (?,?,?,?,?,?)`,
  )
    .bind(id, c.var.companyId, name, s(b.description, 400), JSON.stringify(parseFilter(b.filter)), c.var.repId)
    .run();
  return c.json({ id });
});

marketingRouter.put('/audiences/:id', async (c) => {
  const b = await body(c);
  const res = await c.env.DB.prepare(
    `UPDATE marketing_audience SET name=?, description=?, filter_json=?, updated_at=?
     WHERE id=? AND company_id=?`,
  )
    .bind(
      s(b.name, 160), s(b.description, 400), JSON.stringify(parseFilter(b.filter)),
      nowIso(), c.req.param('id'), c.var.companyId,
    )
    .run();
  if (!res.meta?.changes) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

marketingRouter.delete('/audiences/:id', async (c) => {
  await c.env.DB.prepare(`DELETE FROM marketing_audience WHERE id=? AND company_id=?`)
    .bind(c.req.param('id'), c.var.companyId)
    .run();
  return c.json({ ok: true });
});

/**
 * Count and sample an audience without saving it, so the operator can see who
 * they are about to mail before committing to anything.
 */
marketingRouter.post('/audiences/preview', async (c) => {
  const b = await body(c);
  const db = c.env.DB;
  const companyId = c.var.companyId;
  const filter = parseFilter(b.filter);

  const counted = compileAudienceCount(companyId, filter);
  const countRow = await db.prepare(counted.sql).bind(...counted.binds).first<{ n: number }>();

  const suppressedCompiled = compileSuppressedCount(companyId, filter);
  const suppressedRow = await db
    .prepare(suppressedCompiled.sql)
    .bind(...suppressedCompiled.binds)
    .first<{ n: number }>();

  const sample = compileAudience(companyId, filter, { limit: 20 });
  const sampleRows = await db.prepare(sample.sql).bind(...sample.binds).all();

  return c.json({
    count: Number(countRow?.n ?? 0),
    suppressed: Number(suppressedRow?.n ?? 0),
    warnings: counted.warnings,
    description: describeFilter(filter),
    sample: sampleRows.results ?? [],
  });
});

// ══ suppression ══════════════════════════════════════════════════════════════

marketingRouter.get('/suppression', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT * FROM marketing_suppression WHERE company_id = ? ORDER BY created_at DESC LIMIT 500`,
  )
    .bind(c.var.companyId)
    .all();
  return c.json({ suppression: rows.results ?? [] });
});

marketingRouter.post('/suppression', async (c) => {
  const b = await body(c);
  const email = s(b.email, 320).trim();
  if (!email) return c.json({ error: 'email is required' }, 400);
  await addSuppression(c.env.DB, c.var.companyId, email, 'manual', { note: s(b.note, 400) });
  return c.json({ ok: true });
});

/** Resubscribe. Deliberately one row at a time and never automated. */
marketingRouter.delete('/suppression/:id', async (c) => {
  await c.env.DB.prepare(`DELETE FROM marketing_suppression WHERE id=? AND company_id=?`)
    .bind(c.req.param('id'), c.var.companyId)
    .run();
  return c.json({ ok: true });
});

// ══ sender identities ════════════════════════════════════════════════════════

marketingRouter.get('/senders', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT * FROM marketing_sender_identity WHERE company_id = ? ORDER BY is_default DESC, from_email`,
  )
    .bind(c.var.companyId)
    .all();
  return c.json({ senders: rows.results ?? [] });
});

/**
 * Register a from address and start SendGrid domain authentication.
 *
 * This is what frees campaigns from the hardcoded noreply@groundwork-crm.com
 * in the transactional helper: mail has to come from a domain the tenant
 * actually controls, or SPF/DKIM alignment fails and it lands in spam.
 */
marketingRouter.post('/senders', async (c) => {
  const b = await body(c);
  const fromEmail = s(b.from_email, 320).trim().toLowerCase();
  const match = /^[^@\s]+@([^@\s]+\.[^@\s]+)$/.exec(fromEmail);
  if (!match) return c.json({ error: 'a valid from_email is required' }, 400);
  const domain = match[1]!;

  const apiKey = c.env.SENDGRID_API_KEY;
  if (!apiKey) return c.json({ error: 'SENDGRID_API_KEY is not configured' }, 503);

  const provider = new SendGridProvider(apiKey);
  const auth = await provider.createDomainAuth(domain);
  if (!auth.ok) return c.json({ error: `SendGrid rejected the domain: ${auth.error ?? 'unknown error'}` }, 502);

  const id = newId('snd');
  await c.env.DB.prepare(
    `INSERT INTO marketing_sender_identity
       (id, company_id, from_email, from_name, reply_to, domain, provider,
        provider_domain_id, dns_records_json, is_default)
     VALUES (?,?,?,?,?,?,'sendgrid',?,?,?)`,
  )
    .bind(
      id, c.var.companyId, fromEmail, s(b.from_name, 160), s(b.reply_to, 320).trim().toLowerCase(),
      domain, auth.providerDomainId, JSON.stringify(auth.records), bool(b.is_default),
    )
    .run();
  return c.json({ id, records: auth.records });
});

marketingRouter.post('/senders/:id/verify', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT id, provider_domain_id FROM marketing_sender_identity WHERE id=? AND company_id=?`,
  )
    .bind(c.req.param('id'), c.var.companyId)
    .first<{ id: string; provider_domain_id: string }>();
  if (!row) return c.json({ error: 'not found' }, 404);

  const apiKey = c.env.SENDGRID_API_KEY;
  if (!apiKey) return c.json({ error: 'SENDGRID_API_KEY is not configured' }, 503);

  const result = await new SendGridProvider(apiKey).validateDomainAuth(row.provider_domain_id);
  await c.env.DB.prepare(
    `UPDATE marketing_sender_identity
       SET verified=?, verified_at=CASE WHEN ? THEN ? ELSE verified_at END,
           last_checked_at=?, updated_at=?
     WHERE id=? AND company_id=?`,
  )
    .bind(
      result.verified ? 1 : 0, result.verified ? 1 : 0, nowIso(),
      nowIso(), nowIso(), row.id, c.var.companyId,
    )
    .run();
  return c.json({ verified: result.verified, error: result.error ?? null });
});

marketingRouter.delete('/senders/:id', async (c) => {
  await c.env.DB.prepare(`DELETE FROM marketing_sender_identity WHERE id=? AND company_id=?`)
    .bind(c.req.param('id'), c.var.companyId)
    .run();
  return c.json({ ok: true });
});

// ══ campaigns ════════════════════════════════════════════════════════════════

marketingRouter.get('/campaigns', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT c.*, a.name AS audience_name,
            (SELECT COUNT(*) FROM marketing_campaign_recipient r
              WHERE r.campaign_id = c.id AND r.status IN ('sent','delivered')) AS sent_count
       FROM marketing_campaign c
       LEFT JOIN marketing_audience a ON a.id = c.audience_id
      WHERE c.company_id = ?
      ORDER BY c.updated_at DESC LIMIT 200`,
  )
    .bind(c.var.companyId)
    .all();
  return c.json({ campaigns: rows.results ?? [] });
});

marketingRouter.get('/campaigns/blocks', (c) =>
  c.json({ types: BLOCK_TYPES.map((t) => ({ type: t, label: BLOCK_LABELS[t], template: newBlock(t) })) }),
);

marketingRouter.post('/campaigns', async (c) => {
  const b = await body(c);
  const name = s(b.name, 200).trim();
  if (!name) return c.json({ error: 'name is required' }, 400);
  const id = newId('camp');
  const doc = parseCampaignDoc(b.content ?? { version: 1, blocks: [] });
  await c.env.DB.prepare(
    `INSERT INTO marketing_campaign
       (id, company_id, name, campaign_type, goal, subject, preheader, theme,
        content_json, audience_id, service_profile_id, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id, c.var.companyId, name, s(b.campaign_type, 40) || 'custom', s(b.goal, 400),
      s(b.subject, 300), s(b.preheader, 300), s(b.theme, 40) || 'brand_dark',
      serializeCampaignDoc(doc), s(b.audience_id, 60) || null,
      s(b.service_profile_id, 60) || null, c.var.repId,
    )
    .run();
  return c.json({ id });
});

marketingRouter.get('/campaigns/:id', async (c) => {
  const row = await loadCampaign(c.env.DB, c.var.companyId, c.req.param('id'));
  if (!row) return c.json({ error: 'not found' }, 404);
  const blockers = await approvalBlockers(c.env.DB, c.var.companyId, row);
  return c.json({ campaign: { ...row, content: parseCampaignDoc(row.content_json) }, blockers });
});

/**
 * Save a draft.
 *
 * content_revision is optimistic concurrency: the editor sends the revision it
 * loaded, and a mismatch is a 409 rather than a silent overwrite. Two people —
 * or a person and the AI copilot — editing one draft is the expected case, not
 * an exotic one.
 */
marketingRouter.put('/campaigns/:id', async (c) => {
  const b = await body(c);
  const db = c.env.DB;
  const existing = await loadCampaign(db, c.var.companyId, c.req.param('id'));
  if (!existing) return c.json({ error: 'not found' }, 404);
  if (['sending', 'sent'].includes(existing.status)) {
    return c.json({ error: `a campaign that is ${existing.status} can no longer be edited` }, 409);
  }
  if (b.content_revision !== undefined && Number(b.content_revision) !== existing.content_revision) {
    return c.json(
      { error: 'this campaign changed in another tab or window', current_revision: existing.content_revision },
      409,
    );
  }

  const doc = b.content === undefined ? parseCampaignDoc(existing.content_json) : parseCampaignDoc(b.content);
  await db
    .prepare(
      `UPDATE marketing_campaign
         SET name=?, campaign_type=?, goal=?, subject=?, preheader=?, theme=?,
             content_json=?, audience_id=?, service_profile_id=?, sender_identity_id=?,
             from_email=?, from_name=?, reply_to=?, scheduled_at=?,
             content_revision=content_revision+1, updated_at=?
       WHERE id=? AND company_id=?`,
    )
    .bind(
      s(b.name, 200) || existing.name, s(b.campaign_type, 40) || 'custom', s(b.goal, 400),
      s(b.subject, 300), s(b.preheader, 300), s(b.theme, 40) || 'brand_dark',
      serializeCampaignDoc(doc), s(b.audience_id, 60) || null,
      s(b.service_profile_id, 60) || null, s(b.sender_identity_id, 60) || null,
      s(b.from_email, 320), s(b.from_name, 160), s(b.reply_to, 320),
      s(b.scheduled_at, 40) || null, nowIso(),
      existing.id, c.var.companyId,
    )
    .run();
  return c.json({ ok: true, content_revision: existing.content_revision + 1 });
});

marketingRouter.delete('/campaigns/:id', async (c) => {
  const existing = await loadCampaign(c.env.DB, c.var.companyId, c.req.param('id'));
  if (!existing) return c.json({ error: 'not found' }, 404);
  if (['sending', 'sent'].includes(existing.status)) {
    return c.json({ error: 'a campaign that has been sent is kept as a record' }, 409);
  }
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM marketing_campaign_recipient WHERE campaign_id=?`).bind(existing.id),
    c.env.DB.prepare(`DELETE FROM marketing_link WHERE campaign_id=?`).bind(existing.id),
    c.env.DB.prepare(`DELETE FROM marketing_campaign WHERE id=? AND company_id=?`).bind(existing.id, c.var.companyId),
  ]);
  return c.json({ ok: true });
});

/**
 * Render the in-flight document server-side and hand back HTML for the
 * editor's iframe.
 *
 * This endpoint is the reason there is no second renderer in the browser. The
 * editor posts whatever is on screen — saved or not — and displays exactly the
 * bytes that the send path would produce.
 */
marketingRouter.post('/campaigns/:id/preview', async (c) => {
  const b = await body(c);
  const campaign = await loadCampaign(c.env.DB, c.var.companyId, c.req.param('id'));
  if (!campaign) return c.json({ error: 'not found' }, 404);

  const doc = b.content === undefined ? undefined : parseCampaignDoc(b.content);
  const merged: CampaignRow = {
    ...campaign,
    subject: b.subject === undefined ? campaign.subject : s(b.subject, 300),
    preheader: b.preheader === undefined ? campaign.preheader : s(b.preheader, 300),
    theme: b.theme === undefined ? campaign.theme : s(b.theme, 40),
  };

  const result = await composeCampaign({
    db: c.env.DB, companyId: c.var.companyId, campaign: merged,
    doc, mode: 'preview', origin: originOf(c.req.url),
  });
  return c.json({ html: result.html, text: result.text, links: result.links });
});

/** Send one copy to a named address, with real rendering but no snapshot. */
marketingRouter.post('/campaigns/:id/test-send', async (c) => {
  const b = await body(c);
  const to = s(b.to, 320).trim();
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return c.json({ error: 'a valid "to" address is required' }, 400);

  const campaign = await loadCampaign(c.env.DB, c.var.companyId, c.req.param('id'));
  if (!campaign) return c.json({ error: 'not found' }, 404);

  const apiKey = c.env.SENDGRID_API_KEY;
  if (!apiKey) return c.json({ error: 'SENDGRID_API_KEY is not configured' }, 503);

  const sender = campaign.sender_identity_id
    ? await c.env.DB.prepare(
        `SELECT from_email, from_name, reply_to, verified FROM marketing_sender_identity WHERE id=? AND company_id=?`,
      )
        .bind(campaign.sender_identity_id, c.var.companyId)
        .first<{ from_email: string; from_name: string; reply_to: string; verified: number }>()
    : null;
  if (!sender) return c.json({ error: 'choose a sender address before sending a test' }, 400);

  const origin = originOf(c.req.url);
  const rendered = await composeCampaign({
    db: c.env.DB, companyId: c.var.companyId, campaign,
    mode: 'send', origin,
  });

  // A test send uses throwaway tokens: it must never mint a real unsubscribe
  // token, or clicking the footer in a test would suppress a live address.
  const provider = new SendGridProvider(apiKey);
  const result = await provider.sendBatch({
    from: { email: sender.from_email, name: sender.from_name || campaign.from_name },
    replyTo: sender.reply_to || undefined,
    subject: `[TEST] ${campaign.subject}`,
    html: rendered.html,
    text: rendered.text,
    messages: [
      {
        to,
        substitutions: {
          '-firstName-': 'Dana',
          '-lastName-': 'Whitfield',
          '-unsubUrl-': `${origin}/u/test-preview`,
          '-trackBase-': `${origin}/c/test-preview`,
        },
        customArgs: { campaign_id: 'test', recipient_id: 'test', company_id: c.var.companyId },
      },
    ],
  });

  if (!result.ok) return c.json({ error: result.error ?? 'send failed' }, 502);
  await c.env.DB.prepare(`UPDATE marketing_campaign SET test_sent_at=?, updated_at=? WHERE id=?`)
    .bind(nowIso(), nowIso(), campaign.id)
    .run();
  return c.json({ ok: true });
});

/**
 * Freeze the audience and render, without sending anything. This is the screen
 * the operator reviews before approving.
 */
marketingRouter.post('/campaigns/:id/review', async (c) => {
  const db = c.env.DB;
  const campaign = await loadCampaign(db, c.var.companyId, c.req.param('id'));
  if (!campaign) return c.json({ error: 'not found' }, 404);
  if (!campaign.audience_id) return c.json({ error: 'choose an audience first' }, 400);

  const audience = await db
    .prepare(`SELECT filter_json FROM marketing_audience WHERE id=? AND company_id=?`)
    .bind(campaign.audience_id, c.var.companyId)
    .first<{ filter_json: string }>();
  if (!audience) return c.json({ error: 'the chosen audience no longer exists' }, 400);

  let snapshot;
  try {
    snapshot = await snapshotAudience(db, {
      companyId: c.var.companyId, campaignId: campaign.id,
      filter: audience.filter_json, batchSize: DEFAULT_BATCH_SIZE,
    });
  } catch (e) {
    return c.json({ error: String(e instanceof Error ? e.message : e) }, 409);
  }

  const rendered = await composeCampaign({
    db, companyId: c.var.companyId, campaign, mode: 'send', origin: originOf(c.req.url),
  });
  await persistRender(db, c.var.companyId, campaign.id, rendered);

  const fresh = await loadCampaign(db, c.var.companyId, campaign.id);
  const blockers = fresh ? await approvalBlockers(db, c.var.companyId, fresh) : ['campaign disappeared'];

  await db
    .prepare(`UPDATE marketing_campaign SET status = CASE WHEN status='draft' THEN 'ready' ELSE status END WHERE id=?`)
    .bind(campaign.id)
    .run();

  return c.json({
    recipients: snapshot.recipients,
    suppressed: snapshot.suppressed,
    batches: snapshot.batches,
    warnings: snapshot.warnings,
    blockers,
    links: rendered.links,
  });
});

/**
 * Approve and start sending.
 *
 * Two gates the AI copilot cannot pass and a person has to: an explicit
 * confirm, and expected_recipient_count matching the snapshot. The count check
 * is what catches "I reviewed 40 people and the audience quietly became 4,000"
 * — the caller has to state the number they believe they are approving.
 */
marketingRouter.post('/campaigns/:id/approve', async (c) => {
  const b = await body(c);
  const db = c.env.DB;
  const campaign = await loadCampaign(db, c.var.companyId, c.req.param('id'));
  if (!campaign) return c.json({ error: 'not found' }, 404);

  if (b.confirm !== true) return c.json({ error: 'confirm must be true' }, 400);
  if (!['draft', 'ready', 'paused'].includes(campaign.status)) {
    return c.json({ error: `campaign is ${campaign.status}` }, 409);
  }

  const blockers = await approvalBlockers(db, c.var.companyId, campaign);
  if (blockers.length) return c.json({ error: 'campaign is not ready', blockers }, 400);

  const queued = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM marketing_campaign_recipient
       WHERE campaign_id=? AND status='queued'`,
    )
    .bind(campaign.id)
    .first<{ n: number }>();
  const actual = Number(queued?.n ?? 0);
  if (actual === 0) return c.json({ error: 'no recipients queued — run review first' }, 400);

  const expected = Number(b.expected_recipient_count);
  if (!Number.isFinite(expected)) return c.json({ error: 'expected_recipient_count is required' }, 400);
  if (expected !== actual) {
    return c.json(
      {
        error: 'the audience changed since you reviewed it',
        expected_recipient_count: expected,
        actual_recipient_count: actual,
      },
      409,
    );
  }

  if (!campaign.rendered_html) return c.json({ error: 'campaign has not been rendered — run review first' }, 400);

  const sender = await db
    .prepare(`SELECT from_email, from_name, reply_to FROM marketing_sender_identity WHERE id=? AND company_id=?`)
    .bind(campaign.sender_identity_id, c.var.companyId)
    .first<{ from_email: string; from_name: string; reply_to: string }>();
  if (!sender) return c.json({ error: 'sender identity missing' }, 400);

  await db
    .prepare(
      `UPDATE marketing_campaign
         SET status='scheduled', from_email=?, from_name=?, reply_to=?,
             approved_by=?, approved_at=?, updated_at=?
       WHERE id=? AND company_id=?`,
    )
    .bind(
      sender.from_email, sender.from_name, sender.reply_to,
      c.var.repId, nowIso(), nowIso(), campaign.id, c.var.companyId,
    )
    .run();

  const apiKey = c.env.SENDGRID_API_KEY;
  if (!apiKey) return c.json({ error: 'SENDGRID_API_KEY is not configured' }, 503);

  // Kick the first batches off immediately so the operator sees movement, then
  // let the scheduled drain finish the rest. waitUntil keeps it off the
  // response path — a 4000-person send must not block this request.
  const provider = new SendGridProvider(apiKey);
  const origin = originOf(c.req.url);
  const kick = drainCampaign(db, provider, {
    companyId: c.var.companyId, campaignId: campaign.id, origin, maxBatches: 2,
  });
  const ctx = c.executionCtx as ExecutionContext | undefined;
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(kick);
  else await kick;

  return c.json({ ok: true, recipients: actual });
});

marketingRouter.post('/campaigns/:id/pause', async (c) => {
  const res = await c.env.DB.prepare(
    `UPDATE marketing_campaign SET status='paused', updated_at=?
     WHERE id=? AND company_id=? AND status IN ('scheduled','sending')`,
  )
    .bind(nowIso(), c.req.param('id'), c.var.companyId)
    .run();
  if (!res.meta?.changes) return c.json({ error: 'campaign is not in a pausable state' }, 409);
  return c.json({ ok: true });
});

marketingRouter.post('/campaigns/:id/resume', async (c) => {
  const res = await c.env.DB.prepare(
    `UPDATE marketing_campaign SET status='sending', updated_at=?
     WHERE id=? AND company_id=? AND status='paused'`,
  )
    .bind(nowIso(), c.req.param('id'), c.var.companyId)
    .run();
  if (!res.meta?.changes) return c.json({ error: 'campaign is not paused' }, 409);
  return c.json({ ok: true });
});

marketingRouter.post('/campaigns/:id/cancel', async (c) => {
  const db = c.env.DB;
  const res = await db
    .prepare(
      `UPDATE marketing_campaign SET status='cancelled', updated_at=?
       WHERE id=? AND company_id=? AND status IN ('draft','ready','scheduled','paused')`,
    )
    .bind(nowIso(), c.req.param('id'), c.var.companyId)
    .run();
  if (!res.meta?.changes) return c.json({ error: 'campaign cannot be cancelled from its current state' }, 409);
  // Anything already sent stays as it is; only unsent work is withdrawn.
  await db
    .prepare(`UPDATE marketing_campaign_recipient SET status='failed', error='campaign cancelled'
              WHERE campaign_id=? AND status='queued'`)
    .bind(c.req.param('id'))
    .run();
  return c.json({ ok: true });
});

// ══ reporting ════════════════════════════════════════════════════════════════

marketingRouter.get('/campaigns/:id/report', async (c) => {
  const db = c.env.DB;
  const companyId = c.var.companyId;
  const id = c.req.param('id');
  const campaign = await loadCampaign(db, companyId, id);
  if (!campaign) return c.json({ error: 'not found' }, 404);

  const delivery = await db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status IN ('sent','delivered') THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END) AS delivered,
         SUM(CASE WHEN status='bounced' THEN 1 ELSE 0 END) AS bounced,
         SUM(CASE WHEN status='suppressed' THEN 1 ELSE 0 END) AS suppressed,
         SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status IN ('queued','sending') THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN first_opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
         SUM(CASE WHEN first_clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked,
         SUM(CASE WHEN unsubscribed_at IS NOT NULL THEN 1 ELSE 0 END) AS unsubscribed,
         SUM(CASE WHEN complained_at IS NOT NULL THEN 1 ELSE 0 END) AS complained
       FROM marketing_campaign_recipient WHERE campaign_id=?`,
    )
    .bind(id)
    .first<Record<string, number>>();

  // Business outcomes. amount_cents is INTEGER cents throughout; the UI
  // divides at the boundary and nothing here uses a float.
  const outcomes = await db
    .prepare(
      `SELECT event, COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS cents
         FROM marketing_attribution
        WHERE company_id=? AND campaign_id=?
        GROUP BY event`,
    )
    .bind(companyId, id)
    .all<{ event: string; n: number; cents: number }>();

  const byEvent: Record<string, { count: number; amount_cents: number }> = {};
  for (const row of outcomes.results ?? []) {
    byEvent[row.event] = { count: Number(row.n), amount_cents: Number(row.cents) };
  }

  const links = await db
    .prepare(
      `SELECT l.id, l.label, l.target_url,
              (SELECT COUNT(DISTINCT e.recipient_id) FROM marketing_email_event e
                WHERE e.campaign_id=l.campaign_id AND e.event_type='click' AND e.url=l.link_key) AS clicks
         FROM marketing_link l WHERE l.campaign_id=? ORDER BY l.id`,
    )
    .bind(id)
    .all();

  const sent = Number(delivery?.sent ?? 0);
  const soldCents = byEvent.job_sold?.amount_cents ?? 0;

  return c.json({
    campaign: { id: campaign.id, name: campaign.name, status: campaign.status, subject: campaign.subject },
    delivery: delivery ?? {},
    outcomes: byEvent,
    links: links.results ?? [],
    // Revenue per recipient, in cents, so the UI never sees a float from us.
    revenue_per_recipient_cents: sent > 0 ? Math.round(soldCents / sent) : 0,
  });
});

marketingRouter.get('/campaigns/:id/recipients', async (c) => {
  const status = s(c.req.query('status'), 20);
  const binds: unknown[] = [c.var.companyId, c.req.param('id')];
  let sql =
    `SELECT id, email, first_name, last_name, status, sent_at, delivered_at,
            first_opened_at, first_clicked_at, error
       FROM marketing_campaign_recipient WHERE company_id=? AND campaign_id=?`;
  if (status) {
    sql += ` AND status=?`;
    binds.push(status);
  }
  sql += ` ORDER BY email LIMIT 500`;
  const rows = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json({ recipients: rows.results ?? [] });
});

// ══ forms ════════════════════════════════════════════════════════════════════

marketingRouter.get('/forms', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT f.*,
            (SELECT COUNT(*) FROM marketing_form_submission s WHERE s.form_id=f.id) AS submission_count
       FROM marketing_form f WHERE f.company_id=? ORDER BY f.active DESC, f.name`,
  )
    .bind(c.var.companyId)
    .all();
  return c.json({ forms: rows.results ?? [] });
});

marketingRouter.post('/forms', async (c) => {
  const b = await body(c);
  const name = s(b.name, 160).trim();
  if (!name) return c.json({ error: 'name is required' }, 400);
  const id = newId('frm');
  await c.env.DB.prepare(
    `INSERT INTO marketing_form
       (id, company_id, name, public_token, service_profile_id, headline, intro,
        fields_json, submit_label, success_message, notify_rep_id, create_lead,
        default_service_line, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id, c.var.companyId, name, randomToken(12), s(b.service_profile_id, 60) || null,
      s(b.headline, 200), s(b.intro, 1000),
      s(JSON.stringify(b.fields ?? []), 8000), s(b.submit_label, 60) || 'Submit',
      s(b.success_message, 400) || 'Thank you. We will be in touch shortly.',
      s(b.notify_rep_id, 60) || null, b.create_lead === undefined ? 1 : bool(b.create_lead),
      s(b.default_service_line, 80), c.var.repId,
    )
    .run();
  return c.json({ id });
});

marketingRouter.put('/forms/:id', async (c) => {
  const b = await body(c);
  const res = await c.env.DB.prepare(
    `UPDATE marketing_form
       SET name=?, service_profile_id=?, headline=?, intro=?, fields_json=?,
           submit_label=?, success_message=?, notify_rep_id=?, create_lead=?,
           default_service_line=?, active=?, updated_at=?
     WHERE id=? AND company_id=?`,
  )
    .bind(
      s(b.name, 160), s(b.service_profile_id, 60) || null, s(b.headline, 200), s(b.intro, 1000),
      s(JSON.stringify(b.fields ?? []), 8000), s(b.submit_label, 60) || 'Submit',
      s(b.success_message, 400), s(b.notify_rep_id, 60) || null,
      b.create_lead === undefined ? 1 : bool(b.create_lead),
      s(b.default_service_line, 80), b.active === undefined ? 1 : bool(b.active),
      nowIso(), c.req.param('id'), c.var.companyId,
    )
    .run();
  if (!res.meta?.changes) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

marketingRouter.delete('/forms/:id', async (c) => {
  await c.env.DB.prepare(`DELETE FROM marketing_form WHERE id=? AND company_id=?`)
    .bind(c.req.param('id'), c.var.companyId)
    .run();
  return c.json({ ok: true });
});

marketingRouter.get('/forms/:id/submissions', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT * FROM marketing_form_submission WHERE company_id=? AND form_id=?
     ORDER BY created_at DESC LIMIT 300`,
  )
    .bind(c.var.companyId, c.req.param('id'))
    .all();
  return c.json({ submissions: rows.results ?? [] });
});

// ══ dashboard ════════════════════════════════════════════════════════════════

marketingRouter.get('/overview', async (c) => {
  const db = c.env.DB;
  const companyId = c.var.companyId;
  const campaigns = await db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) AS drafts,
         SUM(CASE WHEN status IN ('scheduled','sending') THEN 1 ELSE 0 END) AS in_flight,
         SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent
       FROM marketing_campaign WHERE company_id=?`,
    )
    .bind(companyId)
    .first<Record<string, number>>();

  const attribution = await db
    .prepare(
      `SELECT event, COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS cents
         FROM marketing_attribution WHERE company_id=? GROUP BY event`,
    )
    .bind(companyId)
    .all<{ event: string; n: number; cents: number }>();

  const suppression = await db
    .prepare(`SELECT COUNT(*) AS n FROM marketing_suppression WHERE company_id=?`)
    .bind(companyId)
    .first<{ n: number }>();

  const byEvent: Record<string, { count: number; amount_cents: number }> = {};
  for (const r of attribution.results ?? []) {
    byEvent[r.event] = { count: Number(r.n), amount_cents: Number(r.cents) };
  }

  return c.json({
    campaigns: campaigns ?? {},
    attribution: byEvent,
    suppressed: Number(suppression?.n ?? 0),
  });
});
