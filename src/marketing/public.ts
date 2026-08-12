/**
 * Public, unauthenticated Marketing OS routes.
 *
 * Everything here is reachable by anyone with a link, so each handler either
 * resolves an unguessable token or exposes nothing that is not already
 * intended to be public:
 *
 *   GET  /m/a/:id                      image referenced by an email
 *   GET  /u/:token                     unsubscribe confirmation page
 *   POST /u/:token                     perform the unsubscribe (RFC 8058)
 *   POST /u/:token/resubscribe         undo, for the person who misclicked
 *   GET  /c/:track_token/:link_id      click redirect
 *   GET  /f/:public_token              inquiry form
 *   POST /api/public/forms/:token      form submission
 *   POST /api/webhooks/sendgrid        delivery events
 */

import { Hono } from 'hono';
import { addSuppression, randomToken } from './send';
import { insertOpportunityRow, resolveDefaultPipelineStage } from './leads';
import { mapSendGridEvents, verifySendGridSignature } from './providers/sendgrid';
import { escapeHtml } from './render';
import { loadBrand } from './compose';

export type PublicBindings = {
  DB: D1Database;
  MEDIA: R2Bucket;
  SENDGRID_WEBHOOK_PUBLIC_KEY?: string;
};

export const marketingPublicRouter = new Hono<{ Bindings: PublicBindings }>();

const nowIso = () => new Date().toISOString();
const newId = (p: string) => `${p}_${randomToken(10)}`;
const s = (v: unknown, max = 500): string => String(v ?? '').slice(0, max);

/**
 * A salted, truncated hash. Enough to spot one address hammering a form or to
 * count distinct openers, without keeping a raw IP against a named person.
 */
async function hashIp(ip: string, salt: string): Promise<string> {
  if (!ip) return '';
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

const clientIp = (c: { req: { header: (k: string) => string | undefined } }): string =>
  c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ?? '';

// ── shared page chrome ───────────────────────────────────────────────────────

interface PageBrand {
  name: string;
  accent: string;
  address: string;
}

async function pageBrand(db: D1Database, companyId: string): Promise<PageBrand> {
  const brand = await loadBrand(db, companyId);
  let accent = '#2D7A55';
  try {
    const colors = JSON.parse(brand?.colors_json || '{}') as Record<string, string>;
    if (typeof colors.accent === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(colors.accent)) accent = colors.accent;
  } catch {
    /* keep the default */
  }
  let name = brand?.name ?? '';
  if (!name) {
    const co = await db.prepare('SELECT name FROM companies WHERE id=? LIMIT 1').bind(companyId).first<{ name: string }>();
    name = co?.name ?? 'Our company';
  }
  return { name, accent, address: brand?.physical_address ?? '' };
}

function page(brand: PageBrand, title: string, inner: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
       background:linear-gradient(160deg,#0D2318,#1C3A2B 60%,${escapeHtml(brand.accent)});
       min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:#fff;border-radius:20px;width:100%;max-width:520px;padding:34px 32px;
        box-shadow:0 28px 90px rgba(0,0,0,.4)}
  .brand{font-size:20px;font-weight:800;color:#1C3A2B;letter-spacing:-.02em;margin-bottom:6px}
  .sub{font-size:13px;color:#6B7280;margin-bottom:18px}
  h1{font-size:19px;font-weight:800;color:#111827;margin-bottom:10px}
  p{font-size:14px;line-height:1.6;color:#374151;margin-bottom:12px}
  label{display:block;font-size:12px;font-weight:800;color:#374151;margin:14px 0 5px}
  input,textarea,select{width:100%;border:1.5px solid #D1D5DB;border-radius:11px;padding:11px 13px;
        font-size:14px;font-family:inherit;outline:none}
  input:focus,textarea:focus{border-color:${escapeHtml(brand.accent)}}
  textarea{resize:vertical;min-height:90px}
  .req::after{content:' *';color:#C0392B}
  .hp{position:absolute;left:-9999px;opacity:0;height:0;overflow:hidden}
  button{width:100%;margin-top:20px;background:linear-gradient(135deg,#1C3A2B,${escapeHtml(brand.accent)});
        border:none;border-radius:12px;color:#fff;font-size:15px;font-weight:800;padding:14px;
        cursor:pointer;font-family:inherit}
  .link{background:none;border:none;color:#6B7280;font-size:13px;text-decoration:underline;
        cursor:pointer;padding:0;margin-top:14px;width:auto;font-weight:600}
  .foot{margin-top:22px;font-size:11px;color:#9CA3AF;line-height:1.5}
</style></head>
<body><div class="card">
  <div class="brand">${escapeHtml(brand.name)}</div>
  ${inner}
  <div class="foot">${escapeHtml(brand.address)}</div>
</div></body></html>`;
}

// ══ marketing images ═════════════════════════════════════════════════════════

/**
 * Serve an image referenced by a campaign. Only ids present in marketing_asset
 * resolve, so this cannot be used to read an arbitrary key out of the bucket.
 */
marketingPublicRouter.get('/m/a/:id', async (c) => {
  const row = await c.env.DB.prepare(`SELECT r2_key, content_type FROM marketing_asset WHERE id=? LIMIT 1`)
    .bind(c.req.param('id'))
    .first<{ r2_key: string; content_type: string }>();
  if (!row) return c.notFound();

  const object = await c.env.MEDIA.get(row.r2_key);
  if (!object) return c.notFound();

  return new Response(object.body, {
    headers: {
      'Content-Type': row.content_type || 'application/octet-stream',
      // Inboxes and proxies refetch these constantly; the bytes never change
      // for a given id because a replacement upload gets a new one.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
});

// ══ unsubscribe ══════════════════════════════════════════════════════════════

interface RecipientLookup {
  id: string;
  company_id: string;
  campaign_id: string;
  email: string;
  contact_id: string | null;
  client_id: string | null;
}

const byUnsubToken = (db: D1Database, token: string) =>
  db
    .prepare(
      `SELECT id, company_id, campaign_id, email, contact_id, client_id
         FROM marketing_campaign_recipient WHERE unsub_token=? LIMIT 1`,
    )
    .bind(token)
    .first<RecipientLookup>();

/**
 * GET does not unsubscribe.
 *
 * Mail clients and security scanners prefetch links in messages, and a GET
 * with a side effect would quietly unsubscribe people who never clicked. The
 * page below posts instead. Gmail and Yahoo's native one-click button uses the
 * POST route directly (List-Unsubscribe-Post), so the two-step is only ever
 * seen by someone who clicked the footer link themselves.
 */
marketingPublicRouter.get('/u/:token', async (c) => {
  const r = await byUnsubToken(c.env.DB, c.req.param('token'));
  if (!r) {
    const brand = { name: 'Unsubscribe', accent: '#2D7A55', address: '' };
    return c.html(page(brand, 'Unsubscribe', `<h1>This link has expired</h1><p>We could not find that subscription.</p>`), 404);
  }
  const brand = await pageBrand(c.env.DB, r.company_id);
  const already = await c.env.DB
    .prepare(`SELECT 1 AS x FROM marketing_suppression WHERE company_id=? AND email=? LIMIT 1`)
    .bind(r.company_id, r.email.toLowerCase())
    .first<{ x: number }>();

  if (already) {
    return c.html(
      page(brand, 'Unsubscribed', `
        <h1>You are unsubscribed</h1>
        <p><strong>${escapeHtml(r.email)}</strong> will not receive marketing email from us.</p>
        <form method="POST" action="/u/${encodeURIComponent(c.req.param('token'))}/resubscribe">
          <button class="link" type="submit">Actually, resubscribe me</button>
        </form>`),
    );
  }

  return c.html(
    page(brand, 'Unsubscribe', `
      <h1>Unsubscribe</h1>
      <p>Stop sending marketing email to <strong>${escapeHtml(r.email)}</strong>?</p>
      <p class="sub">You will still receive messages about work we are doing for you, such as estimates and invoices.</p>
      <form method="POST" action="/u/${encodeURIComponent(c.req.param('token'))}">
        <button type="submit">Unsubscribe</button>
      </form>`),
  );
});

marketingPublicRouter.post('/u/:token', async (c) => {
  const token = c.req.param('token');
  const r = await byUnsubToken(c.env.DB, token);
  // One-click clients expect a 2xx regardless; a stale token is not an error
  // worth surfacing to the mail provider.
  if (!r) return c.text('OK', 200);

  await addSuppression(c.env.DB, r.company_id, r.email, 'unsubscribe', {
    campaignId: r.campaign_id,
    contactId: r.contact_id ?? undefined,
    clientId: r.client_id ?? undefined,
  });
  await c.env.DB
    .prepare(`UPDATE marketing_campaign_recipient SET unsubscribed_at=? WHERE id=?`)
    .bind(nowIso(), r.id)
    .run();
  await c.env.DB
    .prepare(
      `INSERT INTO marketing_email_event (id, company_id, campaign_id, recipient_id, event_type, occurred_at)
       VALUES (?,?,?,?,'unsubscribe',?)`,
    )
    .bind(newId('mev'), r.company_id, r.campaign_id, r.id, nowIso())
    .run();

  // RFC 8058 one-click posts with no Accept header worth honouring; a plain
  // 200 satisfies it, and a browser form post gets the page.
  if ((c.req.header('Accept') ?? '').includes('text/html')) {
    const brand = await pageBrand(c.env.DB, r.company_id);
    return c.html(
      page(brand, 'Unsubscribed', `
        <h1>You are unsubscribed</h1>
        <p><strong>${escapeHtml(r.email)}</strong> will not receive marketing email from us.</p>
        <form method="POST" action="/u/${encodeURIComponent(token)}/resubscribe">
          <button class="link" type="submit">Actually, resubscribe me</button>
        </form>`),
    );
  }
  return c.text('OK', 200);
});

marketingPublicRouter.post('/u/:token/resubscribe', async (c) => {
  const r = await byUnsubToken(c.env.DB, c.req.param('token'));
  if (!r) return c.text('OK', 200);
  // Only an unsubscribe is undone here. A hard bounce or a spam complaint
  // stays put — those are not the recipient's preference, they are a fact
  // about deliverability.
  await c.env.DB
    .prepare(`DELETE FROM marketing_suppression WHERE company_id=? AND email=? AND reason='unsubscribe'`)
    .bind(r.company_id, r.email.toLowerCase())
    .run();
  const brand = await pageBrand(c.env.DB, r.company_id);
  return c.html(
    page(brand, 'Resubscribed', `<h1>You are back on the list</h1>
      <p><strong>${escapeHtml(r.email)}</strong> will receive our marketing email again.</p>`),
  );
});

// ══ click tracking ═══════════════════════════════════════════════════════════

/**
 * Record the click and forward. An unknown token redirects to the site root
 * rather than 404ing — the person clicked a link in good faith and a dead end
 * is a worse outcome than a lost data point.
 */
marketingPublicRouter.get('/c/:track/:link', async (c) => {
  const db = c.env.DB;
  const trackToken = c.req.param('track');
  const linkId = c.req.param('link');

  const r = await db
    .prepare(
      `SELECT id, company_id, campaign_id, email FROM marketing_campaign_recipient
       WHERE track_token=? LIMIT 1`,
    )
    .bind(trackToken)
    .first<{ id: string; company_id: string; campaign_id: string; email: string }>();
  if (!r) return c.redirect('/', 302);

  const link = await db
    .prepare(`SELECT target_url FROM marketing_link WHERE campaign_id=? AND link_key=? LIMIT 1`)
    .bind(r.campaign_id, linkId)
    .first<{ target_url: string }>();
  if (!link) return c.redirect('/', 302);

  const ipHash = await hashIp(clientIp(c), r.company_id);
  await db.batch([
    db
      .prepare(
        `INSERT INTO marketing_email_event
           (id, company_id, campaign_id, recipient_id, event_type, url, user_agent, ip_hash, occurred_at)
         VALUES (?,?,?,?,'click',?,?,?,?)`,
      )
      .bind(
        newId('mev'), r.company_id, r.campaign_id, r.id, linkId,
        s(c.req.header('User-Agent'), 300), ipHash, nowIso(),
      ),
    db
      .prepare(
        `UPDATE marketing_campaign_recipient
           SET first_clicked_at = COALESCE(first_clicked_at, ?) WHERE id=?`,
      )
      .bind(nowIso(), r.id),
  ]);

  // Carry the recipient into our own inquiry forms so a submission can be
  // attributed without asking the person to identify themselves twice.
  let target = link.target_url;
  try {
    const url = new URL(target);
    const here = new URL(c.req.url);
    if (url.origin === here.origin && url.pathname.startsWith('/f/')) {
      url.searchParams.set('c', trackToken);
      target = url.toString();
    }
  } catch {
    /* leave the target as stored */
  }
  return c.redirect(target, 302);
});

// ══ inquiry forms ════════════════════════════════════════════════════════════

interface FormRow {
  id: string;
  company_id: string;
  name: string;
  public_token: string;
  headline: string;
  intro: string;
  fields_json: string;
  submit_label: string;
  success_message: string;
  notify_rep_id: string | null;
  create_lead: number;
  default_service_line: string;
  service_profile_id: string | null;
  active: number;
}

interface FormField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  options: string[];
}

/** Standard fields every inquiry form carries, plus whatever was configured. */
const BASE_FIELDS: FormField[] = [
  { key: 'name', label: 'Your name', type: 'text', required: true, options: [] },
  { key: 'email', label: 'Email', type: 'email', required: true, options: [] },
  { key: 'phone', label: 'Phone', type: 'tel', required: false, options: [] },
  { key: 'address', label: 'Property address', type: 'text', required: false, options: [] },
];

function parseFields(json: string): FormField[] {
  try {
    const raw = JSON.parse(json || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 20).map((r) => {
      const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
      return {
        key: String(o.key ?? '').replace(/[^a-z0-9_]/gi, '').slice(0, 40),
        label: String(o.label ?? '').slice(0, 120),
        type: ['text', 'email', 'tel', 'textarea', 'select'].includes(String(o.type)) ? String(o.type) : 'text',
        required: o.required === true,
        options: Array.isArray(o.options) ? o.options.map((x) => String(x).slice(0, 80)).slice(0, 20) : [],
      };
    }).filter((f) => f.key && f.label);
  } catch {
    return [];
  }
}

marketingPublicRouter.get('/f/:token', async (c) => {
  const form = await c.env.DB
    .prepare(`SELECT * FROM marketing_form WHERE public_token=? AND active=1 LIMIT 1`)
    .bind(c.req.param('token'))
    .first<FormRow>();
  if (!form) return c.notFound();

  const brand = await pageBrand(c.env.DB, form.company_id);
  const custom = parseFields(form.fields_json);
  const track = s(c.req.query('c'), 64);

  const field = (f: FormField): string => {
    const req = f.required ? ' required' : '';
    const cls = f.required ? ' class="req"' : '';
    const id = escapeHtml(f.key);
    if (f.type === 'textarea') {
      return `<label${cls} for="${id}">${escapeHtml(f.label)}</label>
              <textarea id="${id}" name="${id}"${req}></textarea>`;
    }
    if (f.type === 'select') {
      const opts = f.options.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
      return `<label${cls} for="${id}">${escapeHtml(f.label)}</label>
              <select id="${id}" name="${id}"${req}><option value=""></option>${opts}</select>`;
    }
    return `<label${cls} for="${id}">${escapeHtml(f.label)}</label>
            <input id="${id}" name="${id}" type="${escapeHtml(f.type)}"${req}>`;
  };

  const inner = `
    <div class="sub">${escapeHtml(form.intro)}</div>
    <h1>${escapeHtml(form.headline || form.name)}</h1>
    <form id="gwForm">
      ${[...BASE_FIELDS, ...custom].map(field).join('\n')}
      <div class="hp"><label for="website_url">Leave this blank</label>
        <input id="website_url" name="website_url" type="text" tabindex="-1" autocomplete="off"></div>
      <button type="submit">${escapeHtml(form.submit_label || 'Submit')}</button>
      <p id="gwMsg" style="margin-top:14px"></p>
    </form>
    <script>
    document.getElementById('gwForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var btn = e.target.querySelector('button');
      var msg = document.getElementById('gwMsg');
      btn.disabled = true; msg.textContent = 'Sending...';
      var data = {};
      new FormData(e.target).forEach(function (v, k) { data[k] = v; });
      data.c = ${JSON.stringify(track)};
      try {
        var res = await fetch('/api/public/forms/${encodeURIComponent(form.public_token)}', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
        });
        var out = await res.json();
        if (!res.ok) { msg.textContent = out.error || 'Something went wrong.'; btn.disabled = false; return; }
        e.target.innerHTML = '<h1>Thank you</h1><p>' + ${JSON.stringify(form.success_message)} + '</p>';
      } catch (err) { msg.textContent = 'Network error — please try again.'; btn.disabled = false; }
    });
    </script>`;

  return c.html(page(brand, form.headline || form.name, inner));
});

marketingPublicRouter.post('/api/public/forms/:token', async (c) => {
  const db = c.env.DB;
  let b: Record<string, unknown>;
  try {
    b = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // Honeypot: bots fill every field. Accept and drop, so the bot does not
  // learn it was detected and retry with the field removed.
  if (b.website_url) return c.json({ received: true });

  const form = await db
    .prepare(`SELECT * FROM marketing_form WHERE public_token=? AND active=1 LIMIT 1`)
    .bind(c.req.param('token'))
    .first<FormRow>();
  if (!form) return c.json({ error: 'This form is no longer available' }, 404);

  const email = s(b.email, 320).trim();
  const name = s(b.name, 200).trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: 'A valid email is required' }, 400);
  if (!name) return c.json({ error: 'Your name is required' }, 400);

  // Rate limit, matching the demo-request intake: three per address per day.
  const recent = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM marketing_form_submission
        WHERE form_id=? AND lower(email)=? AND created_at > datetime('now','-1 day')`,
    )
    .bind(form.id, email.toLowerCase())
    .first<{ n: number }>();
  if (Number(recent?.n ?? 0) >= 3) {
    return c.json({ error: 'Too many submissions — please try again tomorrow' }, 429);
  }

  // Attribution, when the visitor arrived through a tracked campaign link.
  const track = s(b.c, 64);
  const recipient = track
    ? await db
        .prepare(
          `SELECT id, campaign_id, client_id, contact_id FROM marketing_campaign_recipient
           WHERE track_token=? AND company_id=? LIMIT 1`,
        )
        .bind(track, form.company_id)
        .first<{ id: string; campaign_id: string; client_id: string | null; contact_id: string | null }>()
    : null;

  const phone = s(b.phone, 60).trim();
  const address = s(b.address, 300).trim();
  const submissionId = newId('sub');

  let opportunityId: string | null = null;
  if (form.create_lead) {
    const status = await resolveDefaultPipelineStage(db, form.company_id);
    opportunityId = await insertOpportunityRow(db, form.company_id, {
      client: name,
      phone,
      email,
      address,
      serviceLine: form.default_service_line,
      source: recipient ? 'Marketing campaign' : 'Website form',
      status,
      repId: form.notify_rep_id ?? null,
      assignedToRepId: form.notify_rep_id ?? '',
      clientId: recipient?.client_id ?? '',
      project: s(b.message ?? b.project, 2000),
    });
  }

  const ipHash = await hashIp(clientIp(c), form.company_id);
  await db
    .prepare(
      `INSERT INTO marketing_form_submission
         (id, company_id, form_id, campaign_id, recipient_id, opportunity_id, client_id,
          payload_json, name, email, phone, address, ip_hash, user_agent)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      submissionId, form.company_id, form.id,
      recipient?.campaign_id ?? null, recipient?.id ?? null, opportunityId,
      recipient?.client_id ?? null,
      JSON.stringify(b).slice(0, 8000), name, email, phone, address,
      ipHash, s(c.req.header('User-Agent'), 300),
    )
    .run();

  if (recipient) {
    // UNIQUE(campaign_id, entity_type, entity_id, event) makes this safe to
    // repeat if the same person submits twice from the same click.
    await db
      .prepare(
        `INSERT INTO marketing_attribution
           (id, company_id, campaign_id, recipient_id, entity_type, entity_id, event, amount_cents, occurred_at)
         VALUES (?,?,?,?,'opportunity',?,'inquiry',0,?)
         ON CONFLICT(campaign_id, entity_type, entity_id, event) DO NOTHING`,
      )
      .bind(
        newId('attr'), form.company_id, recipient.campaign_id, recipient.id,
        opportunityId ?? submissionId, nowIso(),
      )
      .run();
  }

  // Put it on the client timeline so the rep sees it where they already look.
  if (opportunityId) {
    await db
      .prepare(
        `INSERT INTO communications (id, company_id, opp_id, rep_id, type, direction, subject, body, ts)
         VALUES (?,?,?,?,'form','inbound',?,?,?)`,
      )
      .bind(
        newId('com'), form.company_id, opportunityId, form.notify_rep_id || null,
        `Inquiry: ${form.name}`.slice(0, 200),
        JSON.stringify(b).slice(0, 4000),
        nowIso(),
      )
      .run();
  }

  return c.json({ received: true, id: submissionId });
});

// ══ SendGrid event webhook ═══════════════════════════════════════════════════

/**
 * Delivery events. Public by necessity — SendGrid cannot present a session
 * cookie — so authenticity rests entirely on the ECDSA signature. The raw body
 * text is what was signed, so it must not be re-serialized before verifying.
 */
marketingPublicRouter.post('/api/webhooks/sendgrid', async (c) => {
  const db = c.env.DB;
  const rawBody = await c.req.text();

  let publicKey = c.env.SENDGRID_WEBHOOK_PUBLIC_KEY ?? '';
  if (!publicKey) {
    const row = await db
      .prepare(`SELECT value FROM settings WHERE key='sendgrid_webhook_public_key' LIMIT 1`)
      .first<{ value: string }>();
    publicKey = row?.value ?? '';
  }
  // Fail closed. An unconfigured key must not mean "accept everything".
  if (!publicKey) return c.json({ error: 'webhook verification is not configured' }, 503);

  const valid = await verifySendGridSignature(
    rawBody,
    c.req.header('X-Twilio-Email-Event-Webhook-Signature') ?? '',
    c.req.header('X-Twilio-Email-Event-Webhook-Timestamp') ?? '',
    publicKey,
  );
  if (!valid) return c.json({ error: 'invalid signature' }, 401);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }

  const events = mapSendGridEvents(parsed);
  let applied = 0;

  for (const e of events) {
    // UNIQUE(provider_event_id) absorbs SendGrid's at-least-once delivery.
    const insert = await db
      .prepare(
        `INSERT INTO marketing_email_event
           (id, company_id, campaign_id, recipient_id, event_type, url, reason,
            user_agent, ip_hash, provider_event_id, occurred_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(provider_event_id) WHERE provider_event_id <> '' DO NOTHING`,
      )
      .bind(
        newId('mev'), e.companyId, e.campaignId, e.recipientId, e.eventType,
        e.url.slice(0, 500), e.reason.slice(0, 500), e.userAgent.slice(0, 300),
        await hashIp(e.ip, e.companyId), e.providerEventId, e.occurredAt,
      )
      .run();
    if (!insert.meta?.changes) continue; // already processed
    applied += 1;

    switch (e.eventType) {
      case 'delivered':
        await db
          .prepare(
            `UPDATE marketing_campaign_recipient
               SET status = CASE WHEN status IN ('sent','sending') THEN 'delivered' ELSE status END,
                   delivered_at = COALESCE(delivered_at, ?)
             WHERE id=? AND company_id=?`,
          )
          .bind(e.occurredAt, e.recipientId, e.companyId)
          .run();
        break;

      case 'open':
        await db
          .prepare(
            `UPDATE marketing_campaign_recipient SET first_opened_at = COALESCE(first_opened_at, ?)
             WHERE id=? AND company_id=?`,
          )
          .bind(e.occurredAt, e.recipientId, e.companyId)
          .run();
        break;

      case 'click':
        await db
          .prepare(
            `UPDATE marketing_campaign_recipient SET first_clicked_at = COALESCE(first_clicked_at, ?)
             WHERE id=? AND company_id=?`,
          )
          .bind(e.occurredAt, e.recipientId, e.companyId)
          .run();
        break;

      case 'bounce':
      case 'dropped':
        await db
          .prepare(
            `UPDATE marketing_campaign_recipient SET status='bounced', bounced_at=COALESCE(bounced_at, ?), error=?
             WHERE id=? AND company_id=?`,
          )
          .bind(e.occurredAt, e.reason.slice(0, 500), e.recipientId, e.companyId)
          .run();
        // A dead address stays dead. Continuing to mail it is what destroys a
        // sending reputation, so it goes on the list automatically.
        if (e.hardBounce) {
          await addSuppression(db, e.companyId, e.email, 'hard_bounce', {
            campaignId: e.campaignId,
            note: e.reason.slice(0, 400),
          });
        }
        break;

      case 'spamreport':
        await db
          .prepare(
            `UPDATE marketing_campaign_recipient SET complained_at=COALESCE(complained_at, ?)
             WHERE id=? AND company_id=?`,
          )
          .bind(e.occurredAt, e.recipientId, e.companyId)
          .run();
        await addSuppression(db, e.companyId, e.email, 'complaint', { campaignId: e.campaignId });
        break;

      case 'unsubscribe':
      case 'group_unsubscribe':
        await db
          .prepare(
            `UPDATE marketing_campaign_recipient SET unsubscribed_at=COALESCE(unsubscribed_at, ?)
             WHERE id=? AND company_id=?`,
          )
          .bind(e.occurredAt, e.recipientId, e.companyId)
          .run();
        await addSuppression(db, e.companyId, e.email, 'unsubscribe', { campaignId: e.campaignId });
        break;

      default:
        break;
    }
  }

  return c.json({ received: events.length, applied });
});
