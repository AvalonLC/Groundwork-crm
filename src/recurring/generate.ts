/**
 * Recurring visit generation.
 *
 * Turns active subscriptions into scheduled work. Two tiers, for the reasons in
 * schedule.ts: plan_visits a year out, work orders only for what is close.
 *
 * Safe to re-run, by design and by database rule. Visit ids are derived from
 * (subscription, planned date), migration 0072 makes that pair unique, and every
 * insert is ON CONFLICT DO NOTHING. Running this twice in a row is a no-op the
 * second time; running it after someone has moved a visit leaves the move alone.
 */

import { ensurePrimaryDay, syncDayEmployees } from '../scheduling/api';
import { cadenceDays, planVisits, visitId, withinWorkOrderHorizon, addDays } from './schedule';

/** How far out plan_visits are materialised. */
export const VISIT_HORIZON_DAYS = 365;
/** How far out a visit also becomes a real work order. */
export const WORK_ORDER_HORIZON_DAYS = 28;

export interface GenerateResult {
  subscriptions: number;
  visits_created: number;
  work_orders_created: number;
  skipped: Array<{ subscription_id: string; reason: string }>;
}

/**
 * Recurring work gets its own number series.
 *
 * A weekly mow for 60 clients is thousands of jobs a year. Sharing the WO-
 * series would burn the numbers that appear on install paperwork and in the
 * client's inbox — WO-00042 should still mean something next year. RC- keeps
 * the two apart while staying obviously a job number.
 */
export async function nextRecurringNumber(db: D1Database, companyId: string): Promise<string> {
  const row: any = await db
    .prepare(
      `SELECT MAX(CAST(SUBSTR(wo_number, 4) AS INTEGER)) AS n
         FROM work_orders WHERE company_id=? AND wo_number LIKE 'RC-%'`,
    )
    .bind(companyId)
    .first();
  return 'RC-' + String(Number(row?.n || 0) + 1).padStart(5, '0');
}

interface Sub {
  id: string; company_id: string; plan_id: string | null; client_id: string | null;
  client_name: string | null; status: string; start_date: string | null; end_date: string | null;
  next_visit_date: string | null; service_address: string | null; property_access: string | null;
  default_crew_id: string | null; custom_price_cents: number | null;
  frequency: string | null; frequency_days: number | null;
  plan_name: string | null; estimated_hours: number | null; plan_tasks: string | null;
  service_type: string | null;
}

/**
 * Generate for one company.
 *
 * `today` is a parameter rather than read from the clock so the whole thing is
 * testable without waiting for tomorrow — and so a caller can generate a window
 * deliberately.
 */
export async function generateVisits(
  db: D1Database,
  companyId: string,
  today: string,
  opts: { visitHorizonDays?: number; workOrderHorizonDays?: number; subscriptionId?: string } = {},
): Promise<GenerateResult> {
  const visitHorizon = opts.visitHorizonDays ?? VISIT_HORIZON_DAYS;
  const woHorizon = opts.workOrderHorizonDays ?? WORK_ORDER_HORIZON_DAYS;
  const through = addDays(today, visitHorizon);

  const result: GenerateResult = { subscriptions: 0, visits_created: 0, work_orders_created: 0, skipped: [] };

  const subsRes = await db
    .prepare(
      `SELECT cs.*, rp.frequency, rp.frequency_days, rp.name AS plan_name,
              rp.estimated_hours, rp.tasks AS plan_tasks, rp.service_type
         FROM client_plan_subscriptions cs
         LEFT JOIN recurring_plans rp ON rp.id = cs.plan_id
        WHERE cs.company_id=? AND cs.status='active'
          ${opts.subscriptionId ? 'AND cs.id=?' : ''}`,
    )
    .bind(...(opts.subscriptionId ? [companyId, opts.subscriptionId] : [companyId]))
    .all<Sub>();

  for (const sub of subsRes.results || []) {
    result.subscriptions++;

    // Where the cursor starts: the subscription's own next date, else its start,
    // else today. A subscription with none of the three has never been set up
    // and is skipped loudly rather than silently generating from today.
    const from = sub.next_visit_date || sub.start_date || '';
    if (!from) {
      result.skipped.push({ subscription_id: sub.id, reason: 'no start_date or next_visit_date' });
      continue;
    }

    const cadence = cadenceDays({ frequency: sub.frequency, frequency_days: sub.frequency_days });
    const visits = planVisits({
      from, notBefore: today, through,
      startDate: sub.start_date, endDate: sub.end_date, cadence,
    });
    if (!visits.length) continue;

    // One batch per subscription. Every row carries a deterministic id and
    // DO NOTHING, so a re-run inserts zero and a partial previous run fills in
    // only what is missing.
    const statements = visits.map((v) =>
      db
        .prepare(
          `INSERT INTO plan_visits
             (id, company_id, subscription_id, plan_id, client_id, scheduled_date, status,
              crew_id, address, budgeted_hours, notes)
           VALUES (?,?,?,?,?,?, 'scheduled', ?,?,?,?)
           -- Untargeted ON CONFLICT, deliberately: it covers EVERY unique
           -- constraint, and there are two that matter here. The obvious one is
           -- (subscription_id, scheduled_date) from migration 0072. The one that
           -- bites is the PRIMARY KEY: move a visit from the 17th to the 19th and
           -- the row keeps its id, so the next run re-plans the 17th, collides on
           -- the id rather than on the date pair, and a targeted clause lets that
           -- through as a thrown UNIQUE error — taking the whole run with it.
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          visitId(sub.id, v.date), companyId, sub.id, sub.plan_id ?? null, sub.client_id ?? null,
          v.date, sub.default_crew_id ?? '', sub.service_address ?? '',
          sub.estimated_hours ?? null, '',
        ),
    );
    const inserted = await db.batch(statements);
    result.visits_created += inserted.reduce((n, r: any) => n + (r?.meta?.changes ?? 0), 0);

    // next_visit_date is deliberately NOT touched here.
    //
    // It means "the next visit due", and the completion flow owns it. An earlier
    // version advanced it to the last date this run planned, which read as a
    // sensible cursor and was wrong twice over: it made the field mean "last
    // generated", and it moved the cursor a year ahead so the next run never
    // looked at near-term visits again. Re-walking the same year every run costs
    // ~52 no-op statements per subscription and keeps the field honest.

    // ── Tier two: work orders for the near visits ────────────────────────────
    //
    // Read from the DATABASE, not from `visits`. The rolling window has to roll:
    // a visit generated last month comes into range today, and iterating only
    // what this run planned would never notice it. This is also what makes the
    // tier work at all on a second run, when `visits` is entirely no-ops.
    const dueRes = await db
      .prepare(
        `SELECT id, scheduled_date, work_order_id FROM plan_visits
          WHERE company_id=? AND subscription_id=?
            AND scheduled_date >= ? AND scheduled_date <= ?
            AND COALESCE(work_order_id,'') = ''
            AND status NOT IN ('completed','cancelled')
          ORDER BY scheduled_date`,
      )
      .bind(companyId, sub.id, today, addDays(today, woHorizon))
      .all<{ id: string; scheduled_date: string; work_order_id: string | null }>();

    for (const existing of dueRes.results || []) {
      const v = { date: existing.scheduled_date };

      const woId = `wo_rc_${existing.id}`; // deterministic, same reasoning as the visit id
      const already = await db.prepare(`SELECT id FROM work_orders WHERE id=?`).bind(woId).first();
      if (!already) {
        const number = await nextRecurringNumber(db, companyId);
        const minutes = sub.estimated_hours != null ? Math.round(Number(sub.estimated_hours) * 60) : null;
        await db
          .prepare(
            `INSERT INTO work_orders
               (id, company_id, wo_number, crew_id, client_name, client_id, property_addr, title, type,
                status, readiness, scheduled_date, scheduled_duration_minutes, budget_minutes,
                notes, access_notes, checklist, materials, equipment, timeline, before_photos, after_photos, created_by)
             VALUES (?,?,?,?,?,?,?,?,?, 'scheduled','ready', ?,?,?,?,?,?,?,?,?,?,?,'recurring')`,
          )
          .bind(
            woId, companyId, number, sub.default_crew_id ?? null,
            sub.client_name ?? '', sub.client_id ?? null, sub.service_address ?? '',
            sub.plan_name || 'Recurring service', sub.service_type || 'Maintenance',
            v.date, minutes, minutes,
            '', sub.property_access ?? '',
            sub.plan_tasks && sub.plan_tasks !== '[]' ? sub.plan_tasks : '[]',
            '[]', '[]',
            JSON.stringify([{ at: new Date().toISOString(), event: `Generated from recurring plan`, by: 'recurring' }]),
            '[]', '[]',
          )
          .run();

        // Onto the grid, and staffed — the same two calls every other creation
        // path makes. Without them a generated job is invisible in the Week view
        // and contributes zero planned labor to its crew.
        const dayId = await ensurePrimaryDay(db, companyId, woId);
        if (dayId) await syncDayEmployees(db, companyId, woId, dayId);
        result.work_orders_created++;
      }

      // The link that has existed as a column since migration 0024 and was never
      // once populated.
      await db
        .prepare(`UPDATE plan_visits SET work_order_id=?, updated_at=datetime('now') WHERE id=? AND company_id=?`)
        .bind(woId, existing.id, companyId)
        .run();
    }
  }

  return result;
}
