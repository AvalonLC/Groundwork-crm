/**
 * SendGrid implementation of the provider seam.
 *
 * Differs from the CRM's existing transactional helper (src/index.tsx
 * sendEmail) in every way that matters for campaigns: it batches, it varies
 * content per recipient through substitutions, it tags each message with
 * custom_args so webhook events can be traced back to a row, it sends from the
 * tenant's own authenticated domain rather than the hardcoded
 * noreply@groundwork-crm.com, and it turns SendGrid's link wrapping off.
 */

import type {
  DomainAuthResult,
  DomainValidateResult,
  EmailEventType,
  EmailProvider,
  NormalizedEvent,
  SendBatchInput,
  SendBatchResult,
} from './types';

const API = 'https://api.sendgrid.com/v3';

/** SendGrid accepts 1000 personalizations; 250 keeps us clear of the 30 MB cap. */
export const MAX_BATCH = 250;

const EVENT_TYPES: EmailEventType[] = [
  'processed', 'delivered', 'open', 'click', 'bounce',
  'dropped', 'deferred', 'spamreport', 'unsubscribe', 'group_unsubscribe',
];

// ── base64 / DER helpers ─────────────────────────────────────────────────────

// Explicitly ArrayBuffer-backed: WebCrypto's BufferSource will not accept the
// SharedArrayBuffer-possible `Uint8Array<ArrayBufferLike>` that the bare
// constructor infers under TypeScript 5.7.
function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * SendGrid signs with DER-encoded ECDSA. WebCrypto's ECDSA verify expects the
 * IEEE P1363 fixed-width r||s form, so the signature has to be converted or
 * every verification silently fails.
 *
 * DER: 30 <len> 02 <rlen> <r> 02 <slen> <s>, where r and s are signed
 * big-endian integers — so they may carry a leading 0x00 pad, or be shorter
 * than 32 bytes and need left-padding.
 */
export function derToP1363(der: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (der.length < 8 || der[0] !== 0x30) return null;
  let i = 2;
  // Long-form length byte (0x81) shifts the body start by one.
  if (der[1] === 0x81) i = 3;
  else if ((der[1] ?? 0) > 0x80) return null;

  if (der[i] !== 0x02) return null;
  const rLen = der[i + 1] ?? 0;
  const rStart = i + 2;
  const r = der.slice(rStart, rStart + rLen);

  const sTagAt = rStart + rLen;
  if (der[sTagAt] !== 0x02) return null;
  const sLen = der[sTagAt + 1] ?? 0;
  const sStart = sTagAt + 2;
  const s = der.slice(sStart, sStart + sLen);

  if (!r.length || !s.length) return null;

  const fit = (b: Uint8Array): Uint8Array<ArrayBuffer> | null => {
    let v = b;
    while (v.length > 32 && v[0] === 0x00) v = v.slice(1);
    if (v.length > 32) return null;
    const out = new Uint8Array(new ArrayBuffer(32));
    out.set(v, 32 - v.length);
    return out;
  };

  const rr = fit(r);
  const ss = fit(s);
  if (!rr || !ss) return null;

  const out = new Uint8Array(new ArrayBuffer(64));
  out.set(rr, 0);
  out.set(ss, 32);
  return out;
}

/**
 * Verify a SendGrid Event Webhook request.
 *
 * The signed payload is timestamp + rawBody, so the raw text must be used —
 * re-serializing the parsed JSON changes the bytes and breaks the signature.
 */
export async function verifySendGridSignature(
  rawBody: string,
  signatureB64: string,
  timestamp: string,
  publicKeyB64: string,
  nowMs = Date.now(),
): Promise<boolean> {
  try {
    if (!rawBody || !signatureB64 || !timestamp || !publicKeyB64) return false;

    // Reject replays. SendGrid sends seconds since epoch.
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return false;
    const skewMs = Math.abs(nowMs - ts * 1000);
    if (skewMs > 10 * 60 * 1000) return false;

    const key = await crypto.subtle.importKey(
      'spki',
      b64ToBytes(publicKeyB64),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const sig = derToP1363(b64ToBytes(signatureB64));
    if (!sig) return false;

    const data = new TextEncoder().encode(timestamp + rawBody);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, data);
  } catch {
    return false;
  }
}

// ── event mapping ────────────────────────────────────────────────────────────

const s = (v: unknown): string => (v == null ? '' : String(v));

export function mapSendGridEvents(payload: unknown): NormalizedEvent[] {
  if (!Array.isArray(payload)) return [];
  const out: NormalizedEvent[] = [];
  for (const raw of payload) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const eventType = s(e.event) as EmailEventType;
    if (!EVENT_TYPES.includes(eventType)) continue;

    // custom_args are echoed at the top level of the event payload.
    const campaignId = s(e.campaign_id);
    const recipientId = s(e.recipient_id);
    const companyId = s(e.company_id);
    if (!campaignId || !recipientId || !companyId) continue;

    const tsNum = Number(e.timestamp);
    const occurredAt = Number.isFinite(tsNum)
      ? new Date(tsNum * 1000).toISOString()
      : new Date().toISOString();

    // SendGrid distinguishes a true bounce from a block; only the former means
    // the address itself is dead and belongs on the suppression list.
    const hardBounce =
      (eventType === 'bounce' && s(e.type).toLowerCase() === 'bounce') ||
      (eventType === 'dropped' && /invalid|bounce/i.test(s(e.reason)));

    out.push({
      providerEventId: s(e.sg_event_id),
      eventType,
      email: s(e.email).trim().toLowerCase(),
      companyId,
      campaignId,
      recipientId,
      url: s(e.url),
      reason: s(e.reason) || s(e.response),
      userAgent: s(e.useragent),
      ip: s(e.ip),
      occurredAt,
      hardBounce,
    });
  }
  return out;
}

// ── provider ─────────────────────────────────────────────────────────────────

export class SendGridProvider implements EmailProvider {
  readonly name = 'sendgrid';

  constructor(private apiKey: string, private fetchImpl: typeof fetch = fetch) {}

  async sendBatch(input: SendBatchInput): Promise<SendBatchResult> {
    if (!input.messages.length) {
      return { ok: true, status: 200, providerMessageId: '' };
    }
    if (input.messages.length > MAX_BATCH) {
      return {
        ok: false, status: 0, providerMessageId: '', retryable: false,
        error: `batch of ${input.messages.length} exceeds ${MAX_BATCH}`,
      };
    }

    const payload: Record<string, unknown> = {
      personalizations: input.messages.map((m) => ({
        to: [{ email: m.to }],
        substitutions: m.substitutions,
        custom_args: m.customArgs,
        ...(m.headers && Object.keys(m.headers).length ? { headers: m.headers } : {}),
      })),
      from: { email: input.from.email, name: input.from.name },
      subject: input.subject,
      // Text first: RFC 2046 says the richest alternative goes last.
      content: [
        { type: 'text/plain', value: input.text || ' ' },
        { type: 'text/html', value: input.html },
      ],
      tracking_settings: {
        // Our own /c/:track_token/:link_id redirect carries recipient identity
        // into the inquiry form. SendGrid's wrapper would nest inside ours and
        // strip that, so it stays off for campaign sends.
        click_tracking: { enable: false, enable_text: false },
        open_tracking: { enable: true },
        subscription_tracking: { enable: false },
      },
    };
    if (input.replyTo) payload.reply_to = { email: input.replyTo };
    if (input.category) payload.categories = [input.category.slice(0, 255)];

    try {
      const res = await this.fetchImpl(`${API}/mail/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const ok = res.status >= 200 && res.status < 300;
      if (ok) {
        return { ok: true, status: res.status, providerMessageId: res.headers.get('X-Message-Id') ?? '' };
      }
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        status: res.status,
        providerMessageId: '',
        error: body.slice(0, 500),
        // 429 and 5xx are worth another pass; 4xx means the payload or the key
        // is wrong and will fail identically forever.
        retryable: res.status === 429 || res.status >= 500,
      };
    } catch (err) {
      return {
        ok: false, status: 0, providerMessageId: '', retryable: true,
        error: String(err instanceof Error ? err.message : err).slice(0, 500),
      };
    }
  }

  async verifyWebhook(rawBody: string, headers: Headers, publicKey: string): Promise<NormalizedEvent[] | null> {
    const sig = headers.get('X-Twilio-Email-Event-Webhook-Signature') ?? '';
    const ts = headers.get('X-Twilio-Email-Event-Webhook-Timestamp') ?? '';
    const valid = await verifySendGridSignature(rawBody, sig, ts, publicKey);
    if (!valid) return null;
    try {
      return mapSendGridEvents(JSON.parse(rawBody));
    } catch {
      return [];
    }
  }

  async createDomainAuth(domain: string): Promise<DomainAuthResult> {
    try {
      const res = await this.fetchImpl(`${API}/whitelabel/domains`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, automatic_security: true }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, providerDomainId: '', records: [], error: JSON.stringify(body).slice(0, 500) };
      }
      const dns = (body.dns ?? {}) as Record<string, { type?: string; host?: string; data?: string }>;
      const records = Object.values(dns)
        .filter((r) => r && r.host && r.data)
        .map((r) => ({ type: s(r.type) || 'CNAME', host: s(r.host), data: s(r.data) }));
      return { ok: true, providerDomainId: s(body.id), records };
    } catch (err) {
      return {
        ok: false, providerDomainId: '', records: [],
        error: String(err instanceof Error ? err.message : err).slice(0, 500),
      };
    }
  }

  async validateDomainAuth(providerDomainId: string): Promise<DomainValidateResult> {
    try {
      const res = await this.fetchImpl(`${API}/whitelabel/domains/${encodeURIComponent(providerDomainId)}/validate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, verified: false, error: JSON.stringify(body).slice(0, 500) };
      }
      return { ok: true, verified: body.valid === true };
    } catch (err) {
      return { ok: false, verified: false, error: String(err instanceof Error ? err.message : err).slice(0, 500) };
    }
  }
}
