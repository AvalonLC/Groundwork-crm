#!/usr/bin/env node
/**
 * Find Stripe payments that never reached the CRM.
 *
 * DRY RUN ONLY. This script never writes — not to Stripe, not to the database.
 * It reports three buckets and stops. Backfilling is a separate, explicit step
 * that must be run with the counts from here in front of you.
 *
 *   node scripts/stripe-reconcile.mjs --account acct_xxx [--since 2026-01-01]
 *
 * Requires STRIPE_SECRET_KEY in the environment. Never pass it as an argument —
 * arguments show up in shell history and process listings.
 *
 * Why this exists: direct-charge events fired on connected accounts and the
 * platform webhook was scoped to the platform context, so successful payments
 * settled in Stripe with no corresponding row here. Those payments are real and
 * the money moved; only the record is missing.
 */

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') ? 'true' : arr[i + 1]]);
    return acc;
  }, []),
);

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) {
  console.error('STRIPE_SECRET_KEY is not set. Export it; do not pass it as an argument.');
  process.exit(1);
}
if (!args.account) {
  console.error('Usage: node scripts/stripe-reconcile.mjs --account acct_xxx [--since YYYY-MM-DD]');
  process.exit(1);
}

const since = args.since ? Math.floor(new Date(`${args.since}T00:00:00Z`).getTime() / 1000) : undefined;

/** Direct charges live on the connected account, so every read is scoped to it. */
async function stripe(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`https://api.stripe.com/v1/${path}${qs ? `?${qs}` : ''}`, {
    headers: { Authorization: `Bearer ${KEY}`, 'Stripe-Account': args.account },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${path}: ${body.error?.message || res.status}`);
  return body;
}

const intents = [];
let starting_after;
do {
  const page = await stripe('payment_intents', {
    limit: '100',
    ...(since ? { 'created[gte]': String(since) } : {}),
    ...(starting_after ? { starting_after } : {}),
  });
  intents.push(...page.data.filter((p) => p.status === 'succeeded'));
  starting_after = page.has_more ? page.data[page.data.length - 1].id : undefined;
} while (starting_after);

// Buckets, deliberately not actions.
const withInvoice = intents.filter((p) => p.metadata?.invoice_id);
const withoutInvoice = intents.filter((p) => !p.metadata?.invoice_id);

console.log(`\nConnected account : ${args.account}`);
console.log(`Succeeded intents : ${intents.length}${args.since ? ` since ${args.since}` : ''}`);
console.log(`  carry invoice_id: ${withInvoice.length}  -> matchable automatically`);
console.log(`  no invoice_id   : ${withoutInvoice.length}  -> need matching by amount and date, by hand\n`);

for (const p of withInvoice.slice(0, 50)) {
  const amount = ((p.amount_received ?? p.amount) / 100).toFixed(2);
  const when = new Date(p.created * 1000).toISOString().slice(0, 10);
  console.log(`  ${p.id}  $${amount.padStart(10)}  ${when}  invoice=${p.metadata.invoice_id}`);
}
if (withInvoice.length > 50) console.log(`  … and ${withInvoice.length - 50} more`);

console.log(`
NEXT STEP, NOT TAKEN HERE
  Compare these ids against the payments table:

    SELECT id FROM payments WHERE stripe_payment_intent_id IN (...);

  Anything missing can be backfilled with the deterministic id py_<intent>,
  which is the same id the webhook writes — so a backfill and a later webhook
  redelivery cannot both create a row.

  Nothing has been written. Bring these counts back before backfilling.
`);
