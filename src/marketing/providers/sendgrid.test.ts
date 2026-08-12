import { describe, it, expect, beforeAll } from 'vitest';
import {
  SendGridProvider,
  derToP1363,
  mapSendGridEvents,
  verifySendGridSignature,
  MAX_BATCH,
} from './sendgrid';
import type { OutboundMessage } from './types';

// ── test-only signing helpers ────────────────────────────────────────────────
// SendGrid signs with DER-encoded ECDSA, but WebCrypto's sign() emits the
// fixed-width P1363 form. To exercise the real verification path the test has
// to re-encode its own signatures the way SendGrid would.

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** DER INTEGER: minimal big-endian, with a 0x00 pad when the high bit is set. */
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

const sign = async (timestamp: string, body: string): Promise<string> => {
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keyPair.privateKey,
    new TextEncoder().encode(timestamp + body),
  );
  return toB64(p1363ToDer(new Uint8Array(sig)));
};

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  publicKeyB64 = toB64(new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey)));
});

describe('derToP1363', () => {
  it('round-trips a signature through DER back to fixed width', () => {
    const raw = new Uint8Array(64);
    crypto.getRandomValues(raw);
    // Force a high bit so the DER encoder has to insert a 0x00 pad.
    raw[0] = 0xff;
    raw[32] = 0xff;
    const back = derToP1363(p1363ToDer(raw));
    expect(back).not.toBeNull();
    expect(Array.from(back!)).toEqual(Array.from(raw));
  });

  it('left-pads short r and s values back to 32 bytes', () => {
    const raw = new Uint8Array(64);
    raw[31] = 0x07; // r = 7
    raw[63] = 0x09; // s = 9
    const back = derToP1363(p1363ToDer(raw));
    expect(back).not.toBeNull();
    expect(back![31]).toBe(0x07);
    expect(back![63]).toBe(0x09);
    expect(back!.slice(0, 31).every((b) => b === 0)).toBe(true);
  });

  it('returns null for input that is not a DER sequence', () => {
    expect(derToP1363(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(derToP1363(new Uint8Array(new ArrayBuffer(16)))).toBeNull();
  });
});

describe('verifySendGridSignature', () => {
  const body = JSON.stringify([{ event: 'delivered', email: 'a@b.com' }]);

  it('accepts a correctly signed, fresh request', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    expect(await verifySendGridSignature(body, await sign(ts, body), ts, publicKeyB64)).toBe(true);
  });

  it('rejects a body that was altered after signing', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await sign(ts, body);
    const tampered = JSON.stringify([{ event: 'delivered', email: 'attacker@evil.com' }]);
    expect(await verifySendGridSignature(tampered, sig, ts, publicKeyB64)).toBe(false);
  });

  it('rejects a replayed request older than the tolerance window', async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 20 * 60);
    expect(await verifySendGridSignature(body, await sign(stale, body), stale, publicKeyB64)).toBe(false);
  });

  it('rejects a signature made with a different key', async () => {
    const other = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      other.privateKey,
      new TextEncoder().encode(ts + body),
    );
    const der = toB64(p1363ToDer(new Uint8Array(sig)));
    expect(await verifySendGridSignature(body, der, ts, publicKeyB64)).toBe(false);
  });

  it('rejects when any part is missing or malformed', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await sign(ts, body);
    expect(await verifySendGridSignature('', sig, ts, publicKeyB64)).toBe(false);
    expect(await verifySendGridSignature(body, '', ts, publicKeyB64)).toBe(false);
    expect(await verifySendGridSignature(body, sig, '', publicKeyB64)).toBe(false);
    expect(await verifySendGridSignature(body, sig, ts, '')).toBe(false);
    expect(await verifySendGridSignature(body, sig, 'not-a-number', publicKeyB64)).toBe(false);
    expect(await verifySendGridSignature(body, 'not base64 !!', ts, publicKeyB64)).toBe(false);
  });
});

describe('mapSendGridEvents', () => {
  const base = {
    email: 'Dana@Example.com',
    timestamp: 1754000000,
    sg_event_id: 'evt-1',
    campaign_id: 'camp-1',
    recipient_id: 'rcpt-1',
    company_id: 'co-1',
  };

  it('normalizes an event and lowercases the address', () => {
    const [e] = mapSendGridEvents([{ ...base, event: 'delivered' }]);
    expect(e!.email).toBe('dana@example.com');
    expect(e!.eventType).toBe('delivered');
    expect(e!.providerEventId).toBe('evt-1');
    expect(e!.occurredAt).toBe(new Date(1754000000 * 1000).toISOString());
  });

  it('drops events with no campaign or recipient custom args', () => {
    // Transactional mail sent through the same SendGrid account arrives on the
    // same webhook; it has no campaign_id and must not create marketing rows.
    expect(mapSendGridEvents([{ ...base, campaign_id: '', event: 'delivered' }])).toEqual([]);
    expect(mapSendGridEvents([{ ...base, recipient_id: '', event: 'delivered' }])).toEqual([]);
    expect(mapSendGridEvents([{ ...base, company_id: '', event: 'delivered' }])).toEqual([]);
  });

  it('drops event types we do not model', () => {
    expect(mapSendGridEvents([{ ...base, event: 'teleported' }])).toEqual([]);
  });

  it('flags a true bounce as hard but a block as not', () => {
    expect(mapSendGridEvents([{ ...base, event: 'bounce', type: 'bounce' }])[0]!.hardBounce).toBe(true);
    expect(mapSendGridEvents([{ ...base, event: 'bounce', type: 'blocked' }])[0]!.hardBounce).toBe(false);
    expect(
      mapSendGridEvents([{ ...base, event: 'dropped', reason: 'Invalid SMTPAPI header' }])[0]!.hardBounce,
    ).toBe(true);
  });

  it('tolerates junk payloads', () => {
    expect(mapSendGridEvents(null)).toEqual([]);
    expect(mapSendGridEvents({})).toEqual([]);
    expect(mapSendGridEvents([null, 'nope', 42])).toEqual([]);
  });
});

describe('SendGridProvider.sendBatch', () => {
  const msg = (to: string): OutboundMessage => ({
    to,
    substitutions: { '-firstName-': 'Dana', '-unsubUrl-': 'https://x.example/u/t' },
    customArgs: { campaign_id: 'camp-1', recipient_id: 'r-1', company_id: 'co-1' },
    headers: { 'List-Unsubscribe': '<https://x.example/u/t>' },
  });

  const input = (n = 1) => ({
    from: { email: 'hello@avalon-lc.com', name: 'Avalon' },
    subject: 'Fall cleanup',
    html: '<p>hi</p>',
    text: 'hi',
    category: 'camp-1',
    messages: Array.from({ length: n }, (_, i) => msg(`p${i}@example.com`)),
  });

  const capture = () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response('', { status: 202, headers: { 'X-Message-Id': 'msg-99' } });
    }) as unknown as typeof fetch;
    return { calls, impl };
  };

  it('sends one personalization per recipient with its own substitutions', async () => {
    const { calls, impl } = capture();
    const res = await new SendGridProvider('key', impl).sendBatch(input(3));
    expect(res.ok).toBe(true);
    expect(res.providerMessageId).toBe('msg-99');
    const p = calls[0]!.body.personalizations as Array<Record<string, unknown>>;
    expect(p).toHaveLength(3);
    expect(p[0]!.to).toEqual([{ email: 'p0@example.com' }]);
    expect(p[0]!.substitutions).toMatchObject({ '-firstName-': 'Dana' });
    expect(p[0]!.custom_args).toMatchObject({ campaign_id: 'camp-1' });
    expect(p[0]!.headers).toMatchObject({ 'List-Unsubscribe': '<https://x.example/u/t>' });
  });

  it('turns SendGrid click tracking off so our redirect is not double-wrapped', async () => {
    const { calls, impl } = capture();
    await new SendGridProvider('key', impl).sendBatch(input());
    const ts = calls[0]!.body.tracking_settings as Record<string, { enable: boolean }>;
    expect(ts.click_tracking!.enable).toBe(false);
    expect(ts.subscription_tracking!.enable).toBe(false);
    expect(ts.open_tracking!.enable).toBe(true);
  });

  it('puts the html alternative last', async () => {
    const { calls, impl } = capture();
    await new SendGridProvider('key', impl).sendBatch(input());
    const content = calls[0]!.body.content as Array<{ type: string }>;
    expect(content.map((c) => c.type)).toEqual(['text/plain', 'text/html']);
  });

  it('refuses a batch larger than the provider limit without calling out', async () => {
    const { calls, impl } = capture();
    const res = await new SendGridProvider('key', impl).sendBatch(input(MAX_BATCH + 1));
    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('is a no-op for an empty batch', async () => {
    const { calls, impl } = capture();
    expect((await new SendGridProvider('key', impl).sendBatch(input(0))).ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('marks throttling and provider outages retryable, and bad requests not', async () => {
    const make = (status: number) =>
      new SendGridProvider('key', (async () => new Response('boom', { status })) as unknown as typeof fetch);
    expect((await make(429).sendBatch(input())).retryable).toBe(true);
    expect((await make(503).sendBatch(input())).retryable).toBe(true);
    expect((await make(400).sendBatch(input())).retryable).toBe(false);
    expect((await make(401).sendBatch(input())).retryable).toBe(false);
  });

  it('treats a network throw as retryable rather than losing the batch', async () => {
    const provider = new SendGridProvider('key', (async () => {
      throw new Error('connection reset');
    }) as unknown as typeof fetch);
    const res = await provider.sendBatch(input());
    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(true);
    expect(res.error).toContain('connection reset');
  });
});

describe('SendGridProvider domain authentication', () => {
  it('returns the DNS records the tenant has to publish', async () => {
    const impl = (async () =>
      new Response(
        JSON.stringify({
          id: 42,
          dns: {
            mail_cname: { type: 'cname', host: 'em1.avalon-lc.com', data: 'u1.wl.sendgrid.net' },
            dkim1: { type: 'cname', host: 's1._domainkey.avalon-lc.com', data: 's1.domainkey.u1.wl.sendgrid.net' },
          },
        }),
        { status: 201 },
      )) as unknown as typeof fetch;
    const res = await new SendGridProvider('key', impl).createDomainAuth('avalon-lc.com');
    expect(res.ok).toBe(true);
    expect(res.providerDomainId).toBe('42');
    expect(res.records).toHaveLength(2);
    expect(res.records[0]!.host).toBe('em1.avalon-lc.com');
  });

  it('reports verification state without inventing success', async () => {
    const mk = (valid: boolean) =>
      new SendGridProvider('key', (async () =>
        new Response(JSON.stringify({ valid }), { status: 200 })) as unknown as typeof fetch);
    expect((await mk(true).validateDomainAuth('42')).verified).toBe(true);
    expect((await mk(false).validateDomainAuth('42')).verified).toBe(false);

    const failing = new SendGridProvider('key', (async () =>
      new Response('{"errors":[]}', { status: 404 })) as unknown as typeof fetch);
    const res = await failing.validateDomainAuth('42');
    expect(res.ok).toBe(false);
    expect(res.verified).toBe(false);
  });
});
