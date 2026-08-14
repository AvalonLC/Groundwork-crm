/**
 * When a subscription's visits fall. Pure functions, no I/O.
 *
 * The two-tier horizon is the whole design, and it exists because the obvious
 * version does not survive contact with a real customer list:
 *
 *   plan_visits    materialised 12 months out. Cheap rows. This is what the
 *                  client sees as "your schedule", what routing plans against,
 *                  and what tells you in March that August is full.
 *
 *   work_orders    only for visits inside a rolling window of a few weeks. A
 *                  work order is expensive — it carries a number, a wo_days
 *                  row, staffing, and a place on the board.
 *
 * A weekly mow for 60 clients is ~3,000 visits a year. As work orders that is
 * 3,000 numbers burned out of the same WO- series used for install paperwork,
 * 3,000 rows in every backlog query, and a Work Orders list nobody can read.
 * With a 28-day window it is around 240 live at a time, which is a real week's
 * work times four.
 */

/** Days between visits, by named cadence. Mirrors planFrequencyDays in index.tsx. */
const CADENCE_DAYS: Record<string, number> = {
  weekly: 7, biweekly: 14, monthly: 30, bimonthly: 60,
  quarterly: 91, semiannual: 182, annual: 365,
};

export interface VisitPlan {
  /** YYYY-MM-DD */
  date: string;
  /** 1-based, within this generation run. */
  sequence: number;
}

export interface SubscriptionCadence {
  frequency?: string | null;
  frequency_days?: number | string | null;
}

/**
 * Days between visits.
 *
 * An explicit frequency_days wins so a custom cadence ("every 10 days") is
 * honoured; otherwise the named bucket. Falls back to monthly rather than
 * throwing, and never returns 0 — a zero interval would make the loop below
 * generate the same date forever.
 */
export function cadenceDays(sub: SubscriptionCadence): number {
  const explicit = Number(sub?.frequency_days);
  if (Number.isFinite(explicit) && explicit >= 1) return Math.trunc(explicit);
  const named = CADENCE_DAYS[String(sub?.frequency || '').toLowerCase()];
  return named && named >= 1 ? named : 30;
}

/** Add whole days to a YYYY-MM-DD, in UTC. Calendar arithmetic, not duration. */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `a` to `b`, negative when b is earlier. */
export function daysBetween(a: string, b: string): number {
  const ta = Date.parse(`${a}T12:00:00Z`);
  const tb = Date.parse(`${b}T12:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return Math.round((tb - ta) / 86400000);
}

export interface PlanVisitsInput {
  /** Where the cursor starts. Usually next_visit_date, else start_date. */
  from: string;
  /** Generate no visit before this. Usually today. */
  notBefore: string;
  /** Generate no visit after this. Usually today + 12 months. */
  through: string;
  /** The subscription's own window. end_date null means open-ended. */
  startDate?: string | null;
  endDate?: string | null;
  cadence: number;
  /** Hard stop, so a bad cadence cannot spin. */
  max?: number;
}

/**
 * Every visit date for one subscription inside the horizon.
 *
 * The cursor is advanced rather than multiplied so a subscription whose
 * next_visit_date has drifted into the past catches up to today instead of
 * generating a year of visits nobody is going to do. That case is common: a
 * client pauses over winter and nobody touches the record until spring.
 */
export function planVisits(input: PlanVisitsInput): VisitPlan[] {
  const cadence = Math.max(1, Math.trunc(input.cadence || 0) || 30);
  const max = Math.max(0, input.max ?? 400);
  const out: VisitPlan[] = [];
  if (!input.from || !input.through) return out;

  // Never start before the subscription itself does.
  let cursor = input.from;
  if (input.startDate && daysBetween(input.startDate, cursor) < 0) cursor = input.startDate;

  // Catch a stale cursor up to the present in whole cadence steps, so the
  // rhythm of the visits is preserved rather than reset to today.
  if (daysBetween(cursor, input.notBefore) > 0) {
    const behind = daysBetween(cursor, input.notBefore);
    cursor = addDays(cursor, Math.ceil(behind / cadence) * cadence);
  }

  let guard = 0;
  while (out.length < max && guard++ < max + 10) {
    if (!cursor) break;
    if (daysBetween(cursor, input.through) < 0) break;          // past the horizon
    if (input.endDate && daysBetween(cursor, input.endDate) < 0) break; // subscription ended
    out.push({ date: cursor, sequence: out.length + 1 });
    cursor = addDays(cursor, cadence);
  }
  return out;
}

/**
 * A visit's id, derived from what it IS rather than when it was made.
 *
 * Two identical runs produce identical ids, so re-running is a no-op at the
 * database level rather than something the generator has to reason about. This
 * is the same trick ensurePrimaryDay uses (`wod_bf_${workOrderId}`) and for the
 * same reason.
 *
 * Keyed on the PLANNED date, deliberately. Moving a visit on the calendar must
 * not make the generator think it is missing and create it again — so the id
 * keeps pointing at the slot it was generated for, and the row's own
 * scheduled_date is free to move.
 */
export function visitId(subscriptionId: string, plannedDate: string): string {
  return `pv_${subscriptionId}_${plannedDate}`;
}

/** True when a visit is close enough to deserve a real work order. */
export function withinWorkOrderHorizon(date: string, today: string, horizonDays: number): boolean {
  const delta = daysBetween(today, date);
  return delta >= 0 && delta <= horizonDays;
}
