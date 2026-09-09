#!/usr/bin/env node
/**
 * Report payments whose invoice_id points at no invoice. READ ONLY.
 *
 * Why this exists rather than a foreign key: `payments.invoice_id` is a bare
 * TEXT column (migrations/0022_stripe_connect.sql) with no constraint, and
 * dangling references already exist — so adding `REFERENCES invoices(id)` with
 * RESTRICT would simply fail to apply. The order has to be: report, resolve,
 * then constrain.
 *
 * This script NEVER writes. It has no UPDATE, no DELETE, no INSERT, and it
 * refuses --remote outright: reading production is a human's call, and
 * repairing live financial rows is not something to automate at all. Point it
 * at a local database, or hand the emitted SQL to someone who can run it
 * against production themselves.
 *
 *   node scripts/reconcile-orphan-payments.mjs            # run it locally
 *   node scripts/reconcile-orphan-payments.mjs --sql      # print the query only
 *
 * Output is grouped by company_id, because an orphan in one tenant tells you
 * nothing about another and every remediation decision is per-tenant.
 */
import { execFileSync } from 'node:child_process';

const DB = 'avalon-sales-hub-production';

const QUERY = `
SELECT p.company_id,
       COUNT(*)                      AS orphan_rows,
       SUM(COALESCE(p.amount_cents, ROUND(COALESCE(p.amount,0) * 100))) AS orphan_cents,
       MIN(p.created_at)             AS oldest,
       MAX(p.created_at)             AS newest,
       SUM(CASE WHEN COALESCE(p.stripe_payment_intent_id,'') != ''
                  OR COALESCE(p.stripe_charge_id,'') != ''
                THEN 1 ELSE 0 END)   AS with_processor_ref
  FROM payments p
  LEFT JOIN invoices i
    ON i.id = p.invoice_id AND i.company_id = p.company_id
 WHERE COALESCE(p.invoice_id,'') != ''
   AND i.id IS NULL
 GROUP BY p.company_id
 ORDER BY orphan_rows DESC`.trim();

const argv = process.argv.slice(2);

if (argv.some(a => a === '--remote')) {
  console.error('Refusing --remote. This reads a live financial table; run it yourself, or use --sql.');
  process.exit(2);
}

if (argv.includes('--sql')) {
  console.log(QUERY);
  process.exit(0);
}

let rows = [];
try {
  const out = execFileSync('npx', [
    'wrangler', 'd1', 'execute', DB, '--local', '--json', `--command=${QUERY}`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  rows = JSON.parse(out)[0]?.results ?? [];
} catch (e) {
  console.error('Could not query the local database. Is it migrated? (npm run db:migrate:local)');
  process.exit(1);
}

if (!rows.length) {
  console.log('No orphaned payment references. A foreign key on payments.invoice_id could be considered.');
  process.exit(0);
}

const money = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
let totalRows = 0, totalCents = 0, totalRefs = 0;

console.log('Orphaned payment references — payments pointing at an invoice that does not exist.');
console.log('These are REPORTED, not repaired. Each needs a human decision per tenant.\n');
for (const r of rows) {
  totalRows += Number(r.orphan_rows || 0);
  totalCents += Number(r.orphan_cents || 0);
  totalRefs += Number(r.with_processor_ref || 0);
  console.log(`  company ${r.company_id}`);
  console.log(`    rows              ${r.orphan_rows}`);
  console.log(`    value             ${money(r.orphan_cents)}`);
  console.log(`    with Stripe ref   ${r.with_processor_ref}  (money really moved — do not discard)`);
  console.log(`    span              ${r.oldest} .. ${r.newest}\n`);
}
console.log(`  ${rows.length} tenant(s), ${totalRows} rows, ${money(totalCents)}, ${totalRefs} carrying a processor reference.`);
console.log('\nNext: for each tenant decide whether the invoice was deleted (restore or re-link),');
console.log('or the payment was recorded against a typo (correct the reference). Neither is');
console.log('automatable, and no foreign key can be added until this list is empty.');
