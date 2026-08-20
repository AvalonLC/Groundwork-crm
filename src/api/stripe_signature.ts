/**
 * Stripe webhook signature verification.
 *
 * The webhook handler had this comment and nothing behind it:
 *
 *     // Signature verification requires crypto — simplified check for edge
 *     // In production, use proper Stripe webhook verification library
 *
 * There is no simplified check. The endpoint parsed whatever JSON it was sent
 * and acted on it, which means anyone who could guess an invoice id and a
 * company id could mark an invoice paid by POSTing this route. Both ids appear
 * in URLs the customer already sees.
 *
 * Stripe's scheme, implemented here with Web Crypto because workerd has no
 * node:crypto and the stripe SDK's verifier is Node-only:
 *
 *   Stripe-Signature: t=1614556800,v1=<hex>,v1=<hex>
 *
 *   signed payload = `${t}.${rawBody}`
 *   signature      = HMAC-SHA256(signed payload, endpoint secret), hex
 *
 * Multiple v1 signatures can appear during a secret roll — any one matching is
 * a pass, which is what makes rolling a secret possible without dropping events.
 */

/** Stripe's default tolerance. Rejects replays of an old, valid capture. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface SignatureHeader {
  timestamp: number;
  signatures: string[];
}

/**
 * Pull `t` and every `v1` out of the header.
 *
 * Returns null rather than throwing on anything malformed — a bad header is a
 * failed verification, not an exception to handle somewhere else.
 */
export function parseSignatureHeader(header: string | null | undefined): SignatureHeader | null {
  if (!header) return null;
  let timestamp = NaN;
  const signatures: string[] = [];
  for (const part of String(header).split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't') timestamp = Number(value);
    else if (key === 'v1' && value) signatures.push(value);
  }
  if (!Number.isFinite(timestamp) || !signatures.length) return null;
  return { timestamp, signatures };
}

const enc = new TextEncoder();

const toHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');

/** HMAC-SHA256 of `${timestamp}.${payload}`, hex, as Stripe computes it. */
export async function computeSignature(secret: string, timestamp: number, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${payload}`)));
}

/**
 * Constant-time compare.
 *
 * `a === b` on a hex digest leaks how many leading characters matched through
 * timing, which is enough to forge a signature one character at a time given
 * enough requests. This always walks the whole string.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Verify a Stripe webhook.
 *
 * `payload` MUST be the raw request body, byte for byte. Re-serialising the
 * parsed JSON changes key order and whitespace and every signature fails — the
 * classic way this gets broken later.
 *
 * A missing secret is a failure, not a bypass. That is a deliberate choice: an
 * unauthenticated endpoint that marks invoices paid is worse than a briefly
 * unrecorded payment, and Stripe retries a non-2xx for up to three days, so
 * events that arrive before the secret is configured are delivered again
 * afterwards rather than lost.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null | undefined,
  /**
   * One secret, or several.
   *
   * Connect needs two destinations pointed at this one URL — platform-context
   * events and connected-account events are separate scopes in Stripe — and
   * each destination has its OWN signing secret. Accepting a single secret meant
   * whichever destination was configured second would have every event rejected.
   *
   * Also what makes a secret roll possible without dropping events: configure
   * both, roll one, remove the old.
   */
  secret: string | undefined | Array<string | undefined>,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): Promise<VerifyResult> {
  const secrets = (Array.isArray(secret) ? secret : [secret])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  if (!secrets.length) return { ok: false, reason: 'STRIPE_WEBHOOK_SECRET is not configured' };

  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, reason: 'Missing or malformed Stripe-Signature header' };

  const age = nowSeconds - parsed.timestamp;
  if (Math.abs(age) > toleranceSeconds) {
    return { ok: false, reason: `Timestamp outside tolerance (${age}s)` };
  }

  // Every configured secret against every offered signature. Both lists are
  // tiny — at most two secrets and a couple of v1 values during a roll — and
  // stopping early on the first secret would reject a valid event from the
  // other destination.
  for (const s of secrets) {
    const expected = await computeSignature(s, parsed.timestamp, payload);
    for (const candidate of parsed.signatures) {
      if (timingSafeEqual(expected, candidate)) return { ok: true };
    }
  }
  return { ok: false, reason: 'No signature matched' };
}
