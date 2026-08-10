# Stage 2 verification queries — run these yourself against production

Migration: `migrations/0058_money_cents.sql` (branch `stage-2-money-cents`).
Applied and verified clean against local D1 (0 mismatches on every table
below). These are the same checks, pointed at production instead — run
after the branch is merged to `main` and `deploy.yml` has applied the
migration.

Every query below is designed to return **zero rows** on success. Any row
returned is a mismatch: `float_value * 100` (rounded) does not equal the
backfilled `*_cents` value. Do not proceed to Stage 3 until every single one
comes back empty.

```
npx wrangler d1 execute avalon-sales-hub-production --remote --command "SELECT id, job_value, job_value_cents FROM opportunities WHERE job_value_cents != ROUND(job_value*100) LIMIT 20"

npx wrangler d1 execute avalon-sales-hub-production --remote --command "SELECT id, estimate_amount, estimate_amount_cents FROM opportunities WHERE estimate_amount_cents != ROUND(estimate_amount*100) LIMIT 20"

npx wrangler d1 execute avalon-sales-hub-production --remote --command "SELECT id, sold_amount, sold_amount_cents FROM opportunities WHERE sold_amount_cents != ROUND(sold_amount*100) LIMIT 20"

npx wrangler d1 execute avalon-sales-hub-production --remote --command "SELECT id, subtotal, subtotal_cents FROM estimates WHERE subtotal_cents != ROUND(subtotal*100) LIMIT 20"

npx wrangler d1 execute avalon-sales-hub-production --remote --command "SELECT id, discount_amt, discount_amt_cents FROM estimates WHERE discount_amt_cents != ROUND(discount_amt*100) LIMIT 20"

npx wrangler d1 execute avalon-sales-hub-production --remote --command "SELECT id, tax_amt, tax_amt_cents FROM estimates WHERE tax_amt_cents != ROUND(tax_amt*100) LIMIT 20"

npx wrangler d1 execute avalon-sales-hub-production --remote --command "SELECT id, total, total_cents FROM estimates WHERE total_cents != ROUND(total*100) LIMIT 20"

npx wrangler d1 execute avalon-sales-hub-production --remote --command "SELECT id, deposit_amt, deposit_amt_cents FROM estimates WHERE deposit_amt_cents != ROUND(deposit_amt*100) LIMIT 20"

npx wrangler d1 execute avalon-sales-hub-production --remote --command "SELECT id, deposit_paid_amount, deposit_paid_amount_cents FROM estimates WHERE deposit_paid_amount_cents != ROUND(deposit_paid_amount*100) LIMIT 20"

npx wrangler d1 execute avalon-sales-hub-production --remote --command "SELECT id, subtotal, subtotal_cents FROM invoices WHERE subtotal_cents != ROUND(subtotal*100) LIMIT 20"

npx wrangler d1 execute avalon-sales-hub-production --remote --command "SELECT id, tax_amount, tax_amount_cents FROM invoices WHERE tax_amount_cents != ROUND(tax_amount*100) LIMIT 20"

npx wrangler d1 execute avalon-sales-hub-production --remote --command "SELECT id, discount_amount, discount_amount_cents FROM invoices WHERE discount_amount_cents != ROUND(discount_amount*100) LIMIT 20"

npx wrangler d1 execute avalon-sales-hub-production --remote --command "SELECT id, total, total_cents FROM invoices WHERE total_cents != ROUND(total*100) LIMIT 20"

npx wrangler d1 execute avalon-sales-hub-production --remote --command "SELECT id, amount_paid, amount_paid_cents FROM invoices WHERE amount_paid_cents != ROUND(amount_paid*100) LIMIT 20"

npx wrangler d1 execute avalon-sales-hub-production --remote --command "SELECT id, balance_due, balance_due_cents FROM invoices WHERE balance_due_cents != ROUND(balance_due*100) LIMIT 20"

npx wrangler d1 execute avalon-sales-hub-production --remote --command "SELECT id, amount, amount_cents FROM payments WHERE amount_cents != ROUND(amount*100) LIMIT 20"

npx wrangler d1 execute avalon-sales-hub-production --remote --command "SELECT id, fee_amount, fee_amount_cents FROM payments WHERE fee_amount_cents != ROUND(fee_amount*100) LIMIT 20"

npx wrangler d1 execute avalon-sales-hub-production --remote --command "SELECT id, net_amount, net_amount_cents FROM payments WHERE net_amount_cents != ROUND(net_amount*100) LIMIT 20"

npx wrangler d1 execute avalon-sales-hub-production --remote --command "SELECT id, amount_est, amount_est_cents FROM work_orders WHERE amount_est_cents != ROUND(amount_est*100) LIMIT 20"

npx wrangler d1 execute avalon-sales-hub-production --remote --command "SELECT id, amount_actual, amount_actual_cents FROM work_orders WHERE amount_actual_cents != ROUND(amount_actual*100) LIMIT 20"

npx wrangler d1 execute avalon-sales-hub-production --remote --command "SELECT id, price, price_cents FROM recurring_plans WHERE price_cents != ROUND(price*100) LIMIT 20"

npx wrangler d1 execute avalon-sales-hub-production --remote --command "SELECT id, custom_price, custom_price_cents FROM client_plan_subscriptions WHERE custom_price_cents != ROUND(custom_price*100) LIMIT 20"

npx wrangler d1 execute avalon-sales-hub-production --remote --command "SELECT id, total, total_cents FROM proposals WHERE total_cents != ROUND(total*100) LIMIT 20"

npx wrangler d1 execute avalon-sales-hub-production --remote --command "SELECT id, unit_cost, unit_cost_cents FROM price_items WHERE unit_cost_cents != ROUND(unit_cost*100) LIMIT 20"

npx wrangler d1 execute avalon-sales-hub-production --remote --command "SELECT id, max_amount, max_amount_cents FROM client_autopay WHERE max_amount_cents != ROUND(max_amount*100) LIMIT 20"
```

## Also worth a spot check: new writes since the migration applied

The queries above verify the ROUND-based *backfill*. To confirm the
dual-write code paths (every INSERT/UPDATE in `src/index.tsx` and
`src/portal.tsx`) are also writing correct `_cents` values going forward,
re-run the same 22 queries a day or two after merge — any row created or
updated through the app after the migration ran should still show zero
mismatches. A mismatch appearing only in *new* rows (not in the original
backfill) would point at a dual-write bug rather than a backfill bug.
