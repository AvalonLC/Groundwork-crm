import { describe, it, expect } from 'vitest';
import {
  verifyStripeSignature, parseSignatureHeader, computeSignature, timingSafeEqual,
} from './stripe_signature';

const SECRET = 'whsec_test_secret';
const NOW = 1_700_000_000;
const BODY = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });

/** Sign a payload the way Stripe does, so the tests exercise the real path. */
async function sign(body: string, ts: number, secret = SECRET) {
  return `t=${ts},v1=${await computeSignature(secret, ts, body)}`;
}

describe('parseSignatureHeader', () => {
  it('SIG-01 pulls the timestamp and every v1 out', () => {
    expect(parseSignatureHeader('t=123,v1=aaa,v1=bbb')).toEqual({ timestamp: 123, signatures: ['aaa', 'bbb'] });
  });

  it('SIG-02 ignores schemes it does not implement', () => {
    // v0 is Stripe's Connect-era test signature; only v1 is the real one.
    expect(parseSignatureHeader('t=1,v0=zzz,v1=aaa')).toEqual({ timestamp: 1, signatures: ['aaa'] });
  });

  it('SIG-03 returns null for anything malformed rather than throwing', () => {
    for (const h of [null, undefined, '', 'garbage', 't=abc,v1=aaa', 't=1', 'v1=aaa']) {
      expect(parseSignatureHeader(h), String(h)).toBeNull();
    }
  });
});

describe('timingSafeEqual', () => {
  it('SIG-04 matches equal strings and rejects differences at any position', () => {
    expect(timingSafeEqual('abcdef', 'abcdef')).toBe(true);
    expect(timingSafeEqual('abcdef', 'abcdeg')).toBe(false); // last char
    expect(timingSafeEqual('abcdef', 'zbcdef')).toBe(false); // first char
    expect(timingSafeEqual('abcdef', 'abcde')).toBe(false);  // length
  });
});

describe('verifyStripeSignature', () => {
  it('SIG-05 accepts a signature Stripe would have produced', async () => {
    const header = await sign(BODY, NOW);
    expect(await verifyStripeSignature(BODY, header, SECRET, NOW)).toEqual({ ok: true });
  });

  it('SIG-06 rejects a forged body signed with nothing', async () => {
    // The actual attack: POST a checkout.session.completed for someone else's
    // invoice id. Before this existed, that worked.
    const forged = JSON.stringify({ type: 'checkout.session.completed', data: { object: { metadata: { invoice_id: 'inv-x' } } } });
    const r = await verifyStripeSignature(forged, `t=${NOW},v1=${'0'.repeat(64)}`, SECRET, NOW);
    expect(r).toEqual({ ok: false, reason: 'No signature matched' });
  });

  it('SIG-07 rejects a valid signature over a DIFFERENT body', async () => {
    // Capture a real webhook, swap the invoice id, keep the signature.
    const header = await sign(BODY, NOW);
    const tampered = BODY.replace('cs_1', 'cs_2');
    expect(await verifyStripeSignature(tampered, header, SECRET, NOW)).toEqual({ ok: false, reason: 'No signature matched' });
  });

  it('SIG-08 rejects a signature made with the wrong secret', async () => {
    const header = await sign(BODY, NOW, 'whsec_someone_elses');
    expect(await verifyStripeSignature(BODY, header, SECRET, NOW)).toEqual({ ok: false, reason: 'No signature matched' });
  });

  it('SIG-09 rejects a replay outside the tolerance window', async () => {
    // A genuine, correctly-signed event from an hour ago. Without the timestamp
    // check, anyone who captured one could replay it forever.
    const old = NOW - 3600;
    const header = await sign(BODY, old);
    const r = await verifyStripeSignature(BODY, header, SECRET, NOW);
    expect(r.ok).toBe(false);
    expect((r as any).reason).toMatch(/Timestamp outside tolerance/);
  });

  it('SIG-10 accepts one just inside the window, and rejects one just outside', async () => {
    expect((await verifyStripeSignature(BODY, await sign(BODY, NOW - 299), SECRET, NOW)).ok).toBe(true);
    expect((await verifyStripeSignature(BODY, await sign(BODY, NOW - 301), SECRET, NOW)).ok).toBe(false);
  });

  it('SIG-11 rejects a future timestamp beyond tolerance too', async () => {
    // Clock skew cuts both ways; a far-future stamp is as wrong as a stale one.
    expect((await verifyStripeSignature(BODY, await sign(BODY, NOW + 3600), SECRET, NOW)).ok).toBe(false);
  });

  it('SIG-12 accepts when any one of several v1 signatures matches', async () => {
    // What makes rolling the endpoint secret possible without dropping events.
    const good = await computeSignature(SECRET, NOW, BODY);
    const header = `t=${NOW},v1=${'0'.repeat(64)},v1=${good}`;
    expect(await verifyStripeSignature(BODY, header, SECRET, NOW)).toEqual({ ok: true });
  });

  it('SIG-13 a missing secret FAILS — it is not a bypass', async () => {
    // The decision worth being explicit about. An unauthenticated endpoint that
    // marks invoices paid is worse than a briefly unrecorded payment, and Stripe
    // retries a non-2xx for up to three days, so events arriving before the
    // secret is set are redelivered rather than lost.
    const header = await sign(BODY, NOW);
    expect(await verifyStripeSignature(BODY, header, undefined, NOW))
      .toEqual({ ok: false, reason: 'STRIPE_WEBHOOK_SECRET is not configured' });
  });

  it('SIG-14 a missing header fails even with a secret configured', async () => {
    expect(await verifyStripeSignature(BODY, null, SECRET, NOW))
      .toEqual({ ok: false, reason: 'Missing or malformed Stripe-Signature header' });
  });

  it('SIG-15 signing is over the RAW body, byte for byte', async () => {
    // Re-serialising parsed JSON changes key order and whitespace, and then every
    // signature fails. This is the classic way this gets broken six months later,
    // so it is pinned: same data, different bytes, must not verify.
    const raw = '{"a":1,"b":2}';
    const header = await sign(raw, NOW);
    expect((await verifyStripeSignature(raw, header, SECRET, NOW)).ok).toBe(true);
    expect((await verifyStripeSignature(JSON.stringify(JSON.parse(raw)) + ' ', header, SECRET, NOW)).ok).toBe(false);
    expect((await verifyStripeSignature('{"b":2,"a":1}', header, SECRET, NOW)).ok).toBe(false);
  });
});
