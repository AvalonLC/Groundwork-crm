/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { marketingPublicRouter } from './public';
import { randomToken } from './send';

const db = () => env.DB;
const CO = 'co-public';
const CAMPAIGN = 'camp-public';
const RCPT = 'rcpt-public';
const UNSUB = 'a'.repeat(32);
const TRACK = 'b'.repeat(32);
const FORM_TOKEN = 'formtoken123';

// ── signing helpers (SendGrid emits DER; WebCrypto signs P1363) ──────────────

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function derInt(v: Uint8Array): number[] {
  let i = 0;
  while (i < v.length - 1 && v[i] === 0x00) i += 1;
  const body = Array.from(v.slice(i));
  if ((body[0] ?? 0) & 0x80) body.unshift(0x00);
  return [0x02, body.length, ...body];
}
function p1363ToDer(raw: Uint8Array): Uint8Array {
  const content = [...derInt(raw.slice(0, 32)), ...derInt(raw.slice(32, 64))];
  const header = content.length > 127 ? [0x30, 0x81, content.length] : [0x30, content.length];
  return new Uint8Array([...header, ...content]);
}

let keyPair: CryptoKeyPair;
let publicKeyB64: string;

const signed = async (payload: unknown) => {
  const rawBody = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keyPair.privateKey,
    new TextEncoder().encode(ts + rawBody),
  );
  return {
    body: rawBody,
    headers: {
      'X-Twilio-Email-Event-Webhook-Signature': toB64(p1363ToDer(new Uint8Array(sig))),
      'X-Twilio-Email-Event-Webhook-Timestamp': ts,
      'Content-Type': 'application/json',
    },
  };
};

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign', 'verify',
  ])) as CryptoKeyPair;
  publicKeyB64 = toB64(new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey)));
});

const testEnv = () => ({ DB: db(), SENDGRID_WEBHOOK_PUBLIC_KEY: publicKeyB64 });

const req = (path: string, init?: RequestInit, over: Record<string, unknown> = {}) =>
  marketingPublicRouter.request(path, init, { ...testEnv(), ...over } as never);

const suppressionRows = async () => {
  const r = await db()
    .prepare(`SELECT email, reason FROM marketing_suppression WHERE company_id=?`)
    .bind(CO)
    .all<{ email: string; reason: string }>();
  return r.results ?? [];
};

const recipient = async () =>
  await db()
    .prepare(`SELECT * FROM marketing_campaign_recipient WHERE id=?`)
    .bind(RCPT)
    .first<Record<string, unknown>>();

beforeEach(async () => {
  for (const t of [
    'marketing_campaign_recipient', 'marketing_campaign', 'marketing_suppression',
    'marketing_email_event', 'marketing_link', 'marketing_form', 'marketing_form_submission',
    'marketing_attribution', 'marketing_brand_profile', 'opportunities', 'communications', 'companies',
  ]) {
    await db().prepare(`DELETE FROM ${t}`).run();
  }
  // settings carries the per-company pipeline stages these tests set.
  await db().prepare(`DELETE FROM settings WHERE key LIKE ?`).bind(`${CO}:%`).run();

  await db()
    .prepare(`INSERT INTO companies (id, name, slug) VALUES (?,?,?)`)
    .bind(CO, 'Avalon Landscape', 'avalon-landscape')
    .run();
  await db()
    .prepare(
      `INSERT INTO marketing_brand_profile (id, company_id, name, physical_address, colors_json)
       VALUES (?,?,?,?,?)`,
    )
    .bind('brand-1', CO, 'Avalon Landscape', '1420 Old Bridge Rd, Woodbridge VA', '{"accent":"#2f6b4a"}')
    .run();
  await db()
    .prepare(
      `INSERT INTO marketing_campaign (id, company_id, name, status, subject)
       VALUES (?,?,?,?,?)`,
    )
    .bind(CAMPAIGN, CO, 'Fall cleanup', 'sending', 'Book now')
    .run();
  await db()
    .prepare(
      `INSERT INTO marketing_campaign_recipient
         (id, company_id, campaign_id, email, first_name, unsub_token, track_token, status)
       VALUES (?,?,?,?,?,?,?,'sent')`,
    )
    .bind(RCPT, CO, CAMPAIGN, 'dana@example.com', 'Dana', UNSUB, TRACK)
    .run();
  await db()
    .prepare(
      `INSERT INTO marketing_link (id, company_id, campaign_id, label, target_url, link_key)
       VALUES (?,?,?,?,?,?)`,
    )
    .bind(`${CAMPAIGN}_lnk_1`, CO, CAMPAIGN, 'Get a quote', 'https://avalon-lc.com/fall', 'lnk_1')
    .run();
});

// ══ unsubscribe ══════════════════════════════════════════════════════════════

describe('unsubscribe', () => {
  it('does NOT unsubscribe on GET, because mail clients prefetch links', async () => {
    const res = await req(`/u/${UNSUB}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Unsubscribe');
    expect(await suppressionRows()).toHaveLength(0);
  });

  it('unsubscribes on POST and records the event', async () => {
    const res = await req(`/u/${UNSUB}`, { method: 'POST' });
    expect(res.status).toBe(200);

    const rows = await suppressionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ email: 'dana@example.com', reason: 'unsubscribe' });
    expect((await recipient())!.unsubscribed_at).toBeTruthy();

    const ev = await db()
      .prepare(`SELECT event_type FROM marketing_email_event WHERE recipient_id=?`)
      .bind(RCPT)
      .first<{ event_type: string }>();
    expect(ev?.event_type).toBe('unsubscribe');
  });

  it('is idempotent when a one-click client posts twice', async () => {
    await req(`/u/${UNSUB}`, { method: 'POST' });
    const second = await req(`/u/${UNSUB}`, { method: 'POST' });
    expect(second.status).toBe(200);
    expect(await suppressionRows()).toHaveLength(1);
  });

  it('returns 200 for an unknown token so the mail provider does not retry', async () => {
    const res = await req('/u/doesnotexist', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('shows the resubscribe option once already unsubscribed', async () => {
    await req(`/u/${UNSUB}`, { method: 'POST' });
    const res = await req(`/u/${UNSUB}`);
    expect(await res.text()).toContain('resubscribe');
  });

  it('resubscribe undoes an unsubscribe but never a hard bounce', async () => {
    await req(`/u/${UNSUB}`, { method: 'POST' });
    await req(`/u/${UNSUB}/resubscribe`, { method: 'POST' });
    expect(await suppressionRows()).toHaveLength(0);

    await db()
      .prepare(`INSERT INTO marketing_suppression (id, company_id, email, reason) VALUES (?,?,?,?)`)
      .bind('sup-hb', CO, 'dana@example.com', 'hard_bounce')
      .run();
    await req(`/u/${UNSUB}/resubscribe`, { method: 'POST' });
    // A dead mailbox is a deliverability fact, not a preference to be undone.
    expect(await suppressionRows()).toHaveLength(1);
  });

  it('escapes the address rather than reflecting markup into the page', async () => {
    await db()
      .prepare(`UPDATE marketing_campaign_recipient SET email=? WHERE id=?`)
      .bind('<script>alert(1)</script>@x.com', RCPT)
      .run();
    const html = await (await req(`/u/${UNSUB}`)).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

// ══ click tracking ═══════════════════════════════════════════════════════════

describe('click redirect', () => {
  it('records the click and forwards to the target', async () => {
    const res = await req(`/c/${TRACK}/lnk_1`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://avalon-lc.com/fall');
    expect((await recipient())!.first_clicked_at).toBeTruthy();

    const ev = await db()
      .prepare(`SELECT event_type, url, ip_hash FROM marketing_email_event WHERE recipient_id=?`)
      .bind(RCPT)
      .first<{ event_type: string; url: string; ip_hash: string }>();
    expect(ev?.event_type).toBe('click');
    expect(ev?.url).toBe('lnk_1');
  });

  it('keeps the first click timestamp when the same link is clicked again', async () => {
    await req(`/c/${TRACK}/lnk_1`);
    const first = (await recipient())!.first_clicked_at;
    await req(`/c/${TRACK}/lnk_1`);
    expect((await recipient())!.first_clicked_at).toBe(first);
    const n = await db()
      .prepare(`SELECT COUNT(*) AS n FROM marketing_email_event WHERE recipient_id=?`)
      .bind(RCPT)
      .first<{ n: number }>();
    expect(Number(n?.n)).toBe(2);
  });

  it('redirects home rather than 404ing on an unknown token or link', async () => {
    expect((await req('/c/nope/lnk_1')).headers.get('location')).toBe('/');
    expect((await req(`/c/${TRACK}/lnk_missing`)).headers.get('location')).toBe('/');
  });

  it('will not resolve a link belonging to another campaign', async () => {
    await db()
      .prepare(
        `INSERT INTO marketing_link (id, company_id, campaign_id, label, target_url, link_key)
         VALUES (?,?,?,?,?,?)`,
      )
      .bind('other-campaign_lnk_1', CO, 'other-campaign', 'Elsewhere', 'https://evil.example', 'lnk_1')
      .run();
    const res = await req(`/c/${TRACK}/lnk_1`);
    expect(res.headers.get('location')).toBe('https://avalon-lc.com/fall');
  });

  it('carries the recipient token into our own inquiry forms', async () => {
    await db()
      .prepare(`UPDATE marketing_link SET target_url=? WHERE campaign_id=? AND link_key=?`)
      .bind('http://localhost/f/abc', CAMPAIGN, 'lnk_1')
      .run();
    const res = await req(`/c/${TRACK}/lnk_1`);
    expect(res.headers.get('location')).toBe(`http://localhost/f/abc?c=${TRACK}`);
  });
});

// ══ inquiry forms ════════════════════════════════════════════════════════════

describe('inquiry form', () => {
  const seedForm = (over: Record<string, unknown> = {}) =>
    db()
      .prepare(
        `INSERT INTO marketing_form
           (id, company_id, name, public_token, headline, intro, fields_json,
            submit_label, success_message, create_lead, default_service_line, active)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        'form-1', CO, 'Fall cleanup inquiry', FORM_TOKEN, 'Book your fall cleanup', 'Tell us about your property',
        JSON.stringify([{ key: 'message', label: 'What do you need?', type: 'textarea', required: false }]),
        'Request a quote', 'Thanks, we will call you.',
        over.create_lead === undefined ? 1 : over.create_lead,
        'Fall Cleanup', over.active === undefined ? 1 : over.active,
      )
      .run();

  const submit = (payload: Record<string, unknown>) =>
    req(`/api/public/forms/${FORM_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  beforeEach(seedForm);

  it('renders the configured fields plus the standard ones', async () => {
    const html = await (await req(`/f/${FORM_TOKEN}`)).text();
    expect(html).toContain('Book your fall cleanup');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="phone"');
    expect(html).toContain('What do you need?');
    expect(html).toContain('Request a quote');
    // Honeypot present but hidden.
    expect(html).toContain('website_url');
  });

  it('404s for an unknown or deactivated form', async () => {
    expect((await req('/f/nope')).status).toBe(404);
    await db().prepare(`UPDATE marketing_form SET active=0 WHERE id='form-1'`).run();
    expect((await req(`/f/${FORM_TOKEN}`)).status).toBe(404);
  });

  it('creates a lead at the company first pipeline stage', async () => {
    await db()
      .prepare(`INSERT INTO settings (key, value) VALUES (?,?)`)
      .bind(`${CO}:pipeline_stages`, JSON.stringify(['First Contact', 'Site Visit']))
      .run();

    const res = await submit({ name: 'Marcus Bell', email: 'marcus@example.com', phone: '703-555-0100' });
    expect(res.status).toBe(200);

    const opp = await db()
      .prepare(`SELECT * FROM opportunities WHERE company_id=?`)
      .bind(CO)
      .first<Record<string, unknown>>();
    expect(opp!.client).toBe('Marcus Bell');
    expect(opp!.email).toBe('marcus@example.com');
    expect(opp!.status).toBe('First Contact');
    expect(opp!.service_line).toBe('Fall Cleanup');
    expect(opp!.source).toBe('Website form');
    // Cents columns are the source of truth for every reader since stage 3a.
    expect(opp!.job_value_cents).toBe(0);
  });

  it('falls back to the legacy stage when the company has no pipeline setting', async () => {
    await submit({ name: 'Marcus Bell', email: 'marcus@example.com' });
    const opp = await db().prepare(`SELECT status FROM opportunities`).first<{ status: string }>();
    expect(opp!.status).toBe('Lead Intake / Rapport');
  });

  it('writes a submission row and a timeline entry', async () => {
    await submit({ name: 'Marcus Bell', email: 'marcus@example.com', message: 'Half acre, lots of oak' });
    const sub = await db().prepare(`SELECT * FROM marketing_form_submission`).first<Record<string, unknown>>();
    expect(sub!.email).toBe('marcus@example.com');
    expect(sub!.opportunity_id).toBeTruthy();
    expect(String(sub!.payload_json)).toContain('Half acre');

    const com = await db().prepare(`SELECT * FROM communications`).first<Record<string, unknown>>();
    expect(com!.type).toBe('form');
    expect(com!.direction).toBe('inbound');
  });

  it('attributes the inquiry when the visitor arrived through a campaign link', async () => {
    await submit({ name: 'Dana', email: 'dana@example.com', c: TRACK });
    const attr = await db().prepare(`SELECT * FROM marketing_attribution`).first<Record<string, unknown>>();
    expect(attr!.campaign_id).toBe(CAMPAIGN);
    expect(attr!.event).toBe('inquiry');
    expect(attr!.recipient_id).toBe(RCPT);
    expect(attr!.amount_cents).toBe(0);

    const sub = await db().prepare(`SELECT source FROM opportunities`).first<{ source: string }>();
    expect(sub!.source).toBe('Marketing campaign');
  });

  it('ignores a tracking token belonging to another company', async () => {
    await db().prepare(`UPDATE marketing_campaign_recipient SET company_id='someone-else' WHERE id=?`).bind(RCPT).run();
    await submit({ name: 'Dana', email: 'dana@example.com', c: TRACK });
    const attr = await db().prepare(`SELECT COUNT(*) AS n FROM marketing_attribution`).first<{ n: number }>();
    expect(Number(attr?.n)).toBe(0);
  });

  it('silently drops a submission that filled the honeypot', async () => {
    const res = await submit({ name: 'Bot', email: 'bot@example.com', website_url: 'http://spam' });
    expect(res.status).toBe(200);
    const n = await db().prepare(`SELECT COUNT(*) AS n FROM marketing_form_submission`).first<{ n: number }>();
    expect(Number(n?.n)).toBe(0);
  });

  it('requires a name and a plausible email', async () => {
    expect((await submit({ name: '', email: 'a@b.com' })).status).toBe(400);
    expect((await submit({ name: 'X', email: 'not-an-email' })).status).toBe(400);
    expect((await submit({ name: 'X', email: '' })).status).toBe(400);
  });

  it('rate limits to three submissions per address per day', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await submit({ name: 'Marcus', email: 'marcus@example.com' })).status).toBe(200);
    }
    const fourth = await submit({ name: 'Marcus', email: 'marcus@example.com' });
    expect(fourth.status).toBe(429);
  });

  it('skips lead creation when the form is configured not to', async () => {
    await db().prepare(`UPDATE marketing_form SET create_lead=0 WHERE id='form-1'`).run();
    await submit({ name: 'Marcus', email: 'marcus@example.com' });
    const n = await db().prepare(`SELECT COUNT(*) AS n FROM opportunities`).first<{ n: number }>();
    expect(Number(n?.n)).toBe(0);
    const sub = await db().prepare(`SELECT COUNT(*) AS n FROM marketing_form_submission`).first<{ n: number }>();
    expect(Number(sub?.n)).toBe(1);
  });
});

// ══ webhook ══════════════════════════════════════════════════════════════════

describe('SendGrid event webhook', () => {
  const event = (over: Record<string, unknown> = {}) => ({
    email: 'dana@example.com',
    timestamp: Math.floor(Date.now() / 1000),
    sg_event_id: `evt-${randomToken(4)}`,
    campaign_id: CAMPAIGN,
    recipient_id: RCPT,
    company_id: CO,
    event: 'delivered',
    ...over,
  });

  const post = async (payload: unknown, envOver: Record<string, unknown> = {}) => {
    const { body, headers } = await signed(payload);
    return req('/api/webhooks/sendgrid', { method: 'POST', headers, body }, envOver);
  };

  it('rejects an unsigned request', async () => {
    const res = await req('/api/webhooks/sendgrid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([event()]),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a request whose body was altered after signing', async () => {
    const { headers } = await signed([event()]);
    const res = await req('/api/webhooks/sendgrid', {
      method: 'POST',
      headers,
      body: JSON.stringify([event({ email: 'attacker@evil.com' })]),
    });
    expect(res.status).toBe(401);
  });

  it('fails closed when no verification key is configured', async () => {
    const { body, headers } = await signed([event()]);
    const res = await marketingPublicRouter.request(
      '/api/webhooks/sendgrid',
      { method: 'POST', headers, body },
      { DB: db() } as never,
    );
    expect(res.status).toBe(503);
  });

  it('marks a delivery', async () => {
    const res = await post([event({ event: 'delivered' })]);
    expect(res.status).toBe(200);
    const r = await recipient();
    expect(r!.status).toBe('delivered');
    expect(r!.delivered_at).toBeTruthy();
  });

  it('ignores a duplicate event id', async () => {
    const e = event({ event: 'open' });
    expect(await (await post([e])).json()).toMatchObject({ applied: 1 });
    expect(await (await post([e])).json()).toMatchObject({ applied: 0 });
    const n = await db()
      .prepare(`SELECT COUNT(*) AS n FROM marketing_email_event WHERE recipient_id=?`)
      .bind(RCPT)
      .first<{ n: number }>();
    expect(Number(n?.n)).toBe(1);
  });

  it('suppresses a hard bounce but not a transient block', async () => {
    await post([event({ event: 'bounce', type: 'bounce', reason: 'no such mailbox' })]);
    expect((await suppressionRows()).map((r) => r.reason)).toEqual(['hard_bounce']);
    expect((await recipient())!.status).toBe('bounced');

    await db().prepare(`DELETE FROM marketing_suppression`).run();
    await post([event({ event: 'bounce', type: 'blocked', reason: 'mailbox full' })]);
    expect(await suppressionRows()).toHaveLength(0);
  });

  it('suppresses on a spam complaint', async () => {
    await post([event({ event: 'spamreport' })]);
    expect((await suppressionRows()).map((r) => r.reason)).toEqual(['complaint']);
    expect((await recipient())!.complained_at).toBeTruthy();
  });

  it('suppresses on a provider-side unsubscribe', async () => {
    await post([event({ event: 'unsubscribe' })]);
    expect((await suppressionRows()).map((r) => r.reason)).toEqual(['unsubscribe']);
  });

  it('records opens and clicks without changing delivery status', async () => {
    await post([event({ event: 'open' }), event({ event: 'click', url: 'lnk_1' })]);
    const r = await recipient();
    expect(r!.first_opened_at).toBeTruthy();
    expect(r!.first_clicked_at).toBeTruthy();
    expect(r!.status).toBe('sent');
  });

  it('ignores transactional events that carry no campaign args', async () => {
    const res = await post([{ email: 'x@y.com', event: 'delivered', sg_event_id: 'evt-x', timestamp: 1 }]);
    expect(await res.json()).toMatchObject({ received: 0, applied: 0 });
  });
});
