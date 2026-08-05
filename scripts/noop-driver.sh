#!/usr/bin/env bash
# Stand-in for an agent during harness self-test. Writes the KNOWN-CORRECT
# burden engine so BH-01..BH-14 pass. Proves gate/merge/tag mechanics.
set -euo pipefail
TASK="$1"
[ "$TASK" = "E2-burden" ] || { echo "noop driver only implements E2-burden"; exit 1; }

mkdir -p src/engines
cat > src/engines/types.ts <<'TS'
export interface BurdenInput {
  wage: number; paid: number; pto: number; shop: number; idle: number;
  tax: number; comp: number; ben_mo: number;
  truck: number; equip: number; tools: number;
  equipment_engine_active: boolean;
}
export interface BurdenResult {
  billable_hours: number; utilization: number;
  payroll_pool: number; support_pool: number; total_annual_cost: number;
  burdened_rate: number; burden_multiplier: number;
  support_equipment_annual_used: number;
  config_error: boolean; config_warning: boolean;
  suspect: boolean; requires_review: boolean; publishable: boolean;
}
TS

cat > src/engines/burden.ts <<'TS'
import type { BurdenInput, BurdenResult } from "./types";

/** Pure function. No DB, no I/O. See docs/spec/BH-TESTS.md. */
export function computeBurden(i: BurdenInput): BurdenResult {
  // RULE: when the equipment engine owns machine cost, labor sheds it entirely.
  // Failing to do this double-charges equipment on every crew hour.
  const equipUsed = i.equipment_engine_active ? 0 : i.equip;

  const rawBillable = i.paid - (i.pto + i.shop + i.idle);
  const configError = rawBillable <= 0;
  const billable = configError ? 1 : rawBillable;

  const wageCost = i.wage * i.paid;
  const payroll = wageCost * (1 + i.tax) + wageCost * i.comp + i.ben_mo * 12;
  const support = i.truck + equipUsed + i.tools;
  const total = payroll + support;

  const rate = total / billable;
  const multiplier = rate / i.wage;
  const utilization = billable / i.paid;
  const suspect = utilization < 0.55;
  const warning = multiplier > 2.5 || multiplier < 1.15;

  return {
    billable_hours: billable,
    utilization,
    payroll_pool: payroll,
    support_pool: support,
    total_annual_cost: total,
    burdened_rate: rate,
    burden_multiplier: multiplier,
    support_equipment_annual_used: equipUsed,
    config_error: configError,
    config_warning: warning,
    suspect,
    requires_review: suspect || configError || warning,
    publishable: !configError && !suspect,
  };
}
TS
git add -A && git commit -q -m "[$TASK] burden engine (noop-driver reference impl)"
echo "noop driver wrote burden engine and committed"
