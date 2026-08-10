-- Stage 2 of the money-representation migration (2026-08-10): add a parallel
-- INTEGER cents column next to every float dollar column, backfilled from
-- the existing value. Additive only -- no existing column is modified,
-- renamed, or dropped. Every reader keeps reading the float column this
-- stage; only Stage 3 switches readers over, and only a later, separate,
-- explicitly-approved migration drops the float columns.
--
-- Mechanical suffix naming: <column> -> <column>_cents, no renaming.
-- Backfill uses ROUND, not truncation -- 19.99 * 100 must land on 1999,
-- not 1998 from float imprecision (verified per-table in Step 4's queries).
--
-- Not converted (percentages/rates, not money amounts -- "cents" is
-- meaningless for these): estimates.discount_pct/tax_pct/deposit_pct,
-- invoices.tax_rate. Not converted (hours, not money):
-- work_orders.duration_hours/actual_hours, recurring_plans.estimated_hours.

-- ---- opportunities ----
ALTER TABLE opportunities ADD COLUMN job_value_cents INTEGER;
ALTER TABLE opportunities ADD COLUMN estimate_amount_cents INTEGER;
ALTER TABLE opportunities ADD COLUMN sold_amount_cents INTEGER;
UPDATE opportunities SET
  job_value_cents = ROUND(job_value * 100),
  estimate_amount_cents = ROUND(estimate_amount * 100),
  sold_amount_cents = ROUND(sold_amount * 100);

-- ---- estimates ----
ALTER TABLE estimates ADD COLUMN subtotal_cents INTEGER;
ALTER TABLE estimates ADD COLUMN discount_amt_cents INTEGER;
ALTER TABLE estimates ADD COLUMN tax_amt_cents INTEGER;
ALTER TABLE estimates ADD COLUMN total_cents INTEGER;
ALTER TABLE estimates ADD COLUMN deposit_amt_cents INTEGER;
ALTER TABLE estimates ADD COLUMN deposit_paid_amount_cents INTEGER;
UPDATE estimates SET
  subtotal_cents = ROUND(subtotal * 100),
  discount_amt_cents = ROUND(discount_amt * 100),
  tax_amt_cents = ROUND(tax_amt * 100),
  total_cents = ROUND(total * 100),
  deposit_amt_cents = ROUND(deposit_amt * 100),
  deposit_paid_amount_cents = ROUND(deposit_paid_amount * 100);

-- ---- invoices ----
ALTER TABLE invoices ADD COLUMN subtotal_cents INTEGER;
ALTER TABLE invoices ADD COLUMN tax_amount_cents INTEGER;
ALTER TABLE invoices ADD COLUMN discount_amount_cents INTEGER;
ALTER TABLE invoices ADD COLUMN total_cents INTEGER;
ALTER TABLE invoices ADD COLUMN amount_paid_cents INTEGER;
ALTER TABLE invoices ADD COLUMN balance_due_cents INTEGER;
UPDATE invoices SET
  subtotal_cents = ROUND(subtotal * 100),
  tax_amount_cents = ROUND(tax_amount * 100),
  discount_amount_cents = ROUND(discount_amount * 100),
  total_cents = ROUND(total * 100),
  amount_paid_cents = ROUND(amount_paid * 100),
  balance_due_cents = ROUND(balance_due * 100);

-- ---- payments ----
ALTER TABLE payments ADD COLUMN amount_cents INTEGER;
ALTER TABLE payments ADD COLUMN fee_amount_cents INTEGER;
ALTER TABLE payments ADD COLUMN net_amount_cents INTEGER;
UPDATE payments SET
  amount_cents = ROUND(amount * 100),
  fee_amount_cents = ROUND(fee_amount * 100),
  net_amount_cents = ROUND(net_amount * 100);

-- ---- work_orders ----
-- (estimate_cents already exists here from migrations/0057_finance_merge.sql
-- -- that one is Finance OS's own column, unrelated to this stage. amount_est/
-- amount_actual are the CRM's original estimate/actual-cost columns.)
ALTER TABLE work_orders ADD COLUMN amount_est_cents INTEGER;
ALTER TABLE work_orders ADD COLUMN amount_actual_cents INTEGER;
UPDATE work_orders SET
  amount_est_cents = ROUND(amount_est * 100),
  amount_actual_cents = ROUND(amount_actual * 100);

-- ---- recurring_plans ----
ALTER TABLE recurring_plans ADD COLUMN price_cents INTEGER;
UPDATE recurring_plans SET price_cents = ROUND(price * 100);

-- ---- client_plan_subscriptions ----
ALTER TABLE client_plan_subscriptions ADD COLUMN custom_price_cents INTEGER;
UPDATE client_plan_subscriptions SET custom_price_cents = ROUND(custom_price * 100);

-- ---- proposals ----
ALTER TABLE proposals ADD COLUMN total_cents INTEGER;
UPDATE proposals SET total_cents = ROUND(total * 100);

-- ---- price_items ----
ALTER TABLE price_items ADD COLUMN unit_cost_cents INTEGER;
UPDATE price_items SET unit_cost_cents = ROUND(unit_cost * 100);

-- ---- client_autopay ----
ALTER TABLE client_autopay ADD COLUMN max_amount_cents INTEGER;
UPDATE client_autopay SET max_amount_cents = ROUND(max_amount * 100);
