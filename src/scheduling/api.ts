/**
 * Authenticated scheduling API, mounted at /api/scheduling.
 *
 * Mounted rather than inlined into src/index.tsx, following the Marketing OS
 * and Finance OS precedent. requireAuth is applied at the mount point, so every
 * handler here can rely on c.var.companyId and must scope its queries by it.
 *
 * The four numbers this API keeps apart — see src/scheduling/capacity.ts:
 *
 *   calendar duration  wo_days.scheduled_duration_minutes (how long it blocks)
 *   labor capacity     crew members x productive minutes (the denominator)
 *   budgeted hours     work_orders.budget_minutes (what we sold, read-only here)
 *   actual hours       time_entries, net of breaks (read-only here)
 */

import { Hono } from 'hono';
import { computeLaborVariance } from '../api/labor_variance';
import { canViewCompensation } from '../api/compensation';
import { resolveLaborRate } from '../api/rates';
import { normalizeStopOrder, reorderStops, summarizeRoute, fromE7 } from '../recurring/routing';
import { summarizeDayEquipment, normalizeStatus } from './equipment';
import {
  DEFAULT_PRODUCTIVE_MINUTES_PER_DAY,
  parseWorkingDays,
  crewDailyCapacityMinutes,
  utilizationPct,
  netActualMinutes,
} from './capacity';

export type SchedulingBindings = { DB: D1Database };
export type SchedulingVariables = {
  repId: string;
  companyId: string;
  role: string;
  isSuperAdmin: boolean;
};
type Env = { Bindings: SchedulingBindings; Variables: SchedulingVariables };

export const schedulingRouter = new Hono<Env>();

// ── helpers ──────────────────────────────────────────────────────────────────

const nowIso = () => new Date().toISOString();
const newId = (p: string) =>
  `${p}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
const s = (v: unknown, max = 500): string => String(v ?? '').slice(0, max);
const int = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

/**
 * Roles that must never see job value.
 *
 * CLAUDE.md: "Crew role: never render margin, wage, or rate fields." Stripped
 * server-side rather than hidden with CSS — a field user can open devtools, and
 * a payload that carries the number has already leaked it.
 *
 * NOTE: the codebase carries two different field-role lists that disagree with
 * each other and with this one — public/js/app_premium.js uses
 * _GW_FIELD_ROLES = foreman/laborer/field_supervisor (no mechanic), while
 * DEFAULT_NAV_PERMS in src/index.tsx defines mechanic separately. This list is
 * deliberately the widest reading for money specifically. Worth reconciling the
 * three in one place later.
 */
export const NO_MONEY_ROLES = ['foreman', 'laborer', 'mechanic', 'field_supervisor'];

export const hidesMoney = (role: string): boolean => NO_MONEY_ROLES.includes(String(role || ''));

/** YYYY-MM-DD for `offset` days after `startIso`. */
function addDays(startIso: string, offset: number): string {
  const d = new Date(`${startIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

/** Validate a YYYY-MM-DD, falling back to today rather than throwing. */
function isoDateOr(value: unknown, fallback: string): string {
  const v = s(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fallback;
}

/** HH:MM or null. Rejects anything else rather than storing junk. */
function timeOrNull(value: unknown): string | null {
  const v = s(value, 5);
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null;
}

interface WorkdaySettings {
  working_days: string;
  shift_start: string;
  shift_end: string;
  productive_minutes_per_day: number;
}

async function loadWorkdaySettings(db: D1Database, companyId: string): Promise<WorkdaySettings> {
  const row = await db
    .prepare(
      `SELECT working_days, shift_start, shift_end, productive_minutes_per_day
         FROM workday_settings WHERE company_id=? LIMIT 1`,
    )
    .bind(companyId)
    .first<WorkdaySettings>();
  return {
    working_days: row?.working_days ?? '1,2,3,4,5',
    shift_start: row?.shift_start ?? '07:00',
    shift_end: row?.shift_end ?? '17:00',
    // A NULL here would make every crew's capacity 0 and render 0% everywhere,
    // which is the exact bug this module exists to remove.
    // Read once and narrow, rather than checking row?.x and then reading row.x —
    // which typechecks only because nothing was checking this file.
    productive_minutes_per_day: (() => {
      const configured = Number(row?.productive_minutes_per_day);
      return configured > 0 ? configured : DEFAULT_PRODUCTIVE_MINUTES_PER_DAY;
    })(),
  };
}

/**
 * Ensure a work order has its primary wo_days row.
 *
 * Migration 0061 backfilled history only, so without this every job created
 * after that migration would be invisible on the grid. Exported so the
 * work-order creation paths in src/index.tsx can call it at the moment of
 * creation rather than the grid having to self-heal on read.
 *
 * Returns the day id, or null when the work order is not scheduled — a backlog
 * job legitimately has no day row until someone schedules it.
 */
export async function ensurePrimaryDay(
  db: D1Database,
  companyId: string,
  workOrderId: string,
): Promise<string | null> {
  const wo = await db
    .prepare(
      `SELECT id, company_id, crew_id, scheduled_date, scheduled_time, scheduled_end_time,
              scheduled_duration_minutes, duration_hours, schedule_locked, status
         FROM work_orders WHERE id=? AND company_id=? LIMIT 1`,
    )
    .bind(workOrderId, companyId)
    .first<any>();
  if (!wo) return null;
  if (!s(wo.scheduled_date)) return null;

  // Scoped to this company and to the PRIMARY row specifically.
  //
  // This used to be `WHERE work_order_id=? ORDER BY day_number LIMIT 1` with
  // neither predicate, which had two consequences. A multi-day job matched its
  // hand-authored day 1 (is_primary=0), so this returned that id and the caller
  // believed a primary row existed — syncPrimaryDayFromWorkOrder then found no
  // is_primary row, called this, got day 1 back, and updated nothing at all.
  // Rescheduling a multi-day job silently did nothing to any wo_days row.
  const existing = await db
    .prepare(
      `SELECT id FROM wo_days
        WHERE work_order_id=? AND company_id=? AND is_primary=1
        ORDER BY day_number LIMIT 1`,
    )
    .bind(workOrderId, companyId)
    .first<{ id: string }>();
  if (existing) return existing.id;

  // A multi-day job's days are authored deliberately, each with its own date,
  // phase and crew. work_orders carries a single date that cannot describe them,
  // so there is nothing for a primary row to mirror — creating one would invent
  // a day the user never scheduled. Those jobs move through the multi-day
  // endpoints, which write wo_days directly.
  const multiDay = await db
    .prepare(`SELECT id FROM wo_days WHERE work_order_id=? AND company_id=? LIMIT 1`)
    .bind(workOrderId, companyId)
    .first<{ id: string }>();
  if (multiDay) return null;

  // Same deterministic id shape as migration 0061, so a row created here and a
  // row created by the backfill are indistinguishable and cannot collide.
  const dayId = `wod_bf_${workOrderId}`;
  const duration =
    wo.scheduled_duration_minutes != null
      ? int(wo.scheduled_duration_minutes)
      : wo.duration_hours != null
        ? Math.round(Number(wo.duration_hours) * 60)
        : null;

  await db
    .prepare(
      `INSERT INTO wo_days (id, company_id, work_order_id, day_number, day_date, scope, questions,
                            status, phase_name, phase_sequence, crew_id,
                            start_time, end_time, scheduled_duration_minutes, schedule_locked, is_primary)
       VALUES (?,?,?,1,?,'','[]',?,'',1,?,?,?,?,?,1)`,
    )
    .bind(
      dayId,
      companyId,
      workOrderId,
      s(wo.scheduled_date, 10),
      wo.status === 'completed' ? 'completed' : wo.status === 'in-progress' ? 'in_progress' : 'pending',
      s(wo.crew_id ?? ''),
      wo.scheduled_time ?? null,
      wo.scheduled_end_time ?? null,
      duration,
      int(wo.schedule_locked, 0),
    )
    .run();

  return dayId;
}

/**
 * Push a work order's scheduling columns onto its primary day row.
 *
 * Capacity is computed from wo_days, so any endpoint that moves a job by writing
 * work_orders has to call this or the grid and the capacity figure beside it
 * disagree — and no amount of refetching fixes it, because the underlying row is
 * the thing that is stale.
 *
 * Callers, and why the list matters: this originally covered only
 * PATCH /api/work-orders/:id/reschedule, and an earlier version of this comment
 * claimed it covered "every path that changes a work order's crew" including the
 * work-order PUT. It did not. PUT /api/work-orders/:id writes every scheduling
 * column this function mirrors and called nothing, which is exactly how a crew
 * drag — PATCH then PUT — left wo_days pointing at the old crew. Both call it now.
 * If a third write path appears, it needs to be added here too.
 *
 * Only the primary (backfilled) day is synced. Multi-day jobs have hand-authored
 * rows with their own dates and phases, and work_orders carries a single date
 * that cannot describe them — those are moved through the multi-day endpoints,
 * which already write wo_days directly.
 */
export async function syncPrimaryDayFromWorkOrder(
  db: D1Database,
  companyId: string,
  workOrderId: string,
): Promise<void> {
  const wo = await db
    .prepare(
      `SELECT scheduled_date, scheduled_time, scheduled_end_time,
              scheduled_duration_minutes, crew_id, schedule_locked
         FROM work_orders WHERE id=? AND company_id=? LIMIT 1`,
    )
    .bind(workOrderId, companyId)
    .first<any>();
  if (!wo) return;

  const day = await db
    .prepare(`SELECT id, crew_id FROM wo_days WHERE work_order_id=? AND company_id=? AND is_primary=1 LIMIT 1`)
    .bind(workOrderId, companyId)
    .first<{ id: string; crew_id: string | null }>();

  // No primary row yet — a job scheduled for the first time. Create it.
  if (!day) {
    const created = await ensurePrimaryDay(db, companyId, workOrderId);
    if (created) await syncDayEmployees(db, companyId, workOrderId, created);
    return;
  }

  const crewChanged = s(wo.crew_id ?? '') !== s(day.crew_id ?? '');

  await db
    .prepare(
      `UPDATE wo_days
          SET day_date=?, start_time=?, end_time=?, scheduled_duration_minutes=?,
              crew_id=?, schedule_locked=?, updated_at=datetime('now')
        WHERE id=? AND company_id=?`,
    )
    .bind(
      s(wo.scheduled_date ?? '', 10),
      wo.scheduled_time ?? null,
      wo.scheduled_end_time ?? null,
      wo.scheduled_duration_minutes == null ? null : int(wo.scheduled_duration_minutes),
      s(wo.crew_id ?? ''),
      int(wo.schedule_locked, 0),
      day.id,
      companyId,
    )
    .run();

  // Reassigning a single-day job to another crew has to move its people too.
  // Handled here rather than at each call site so every path that changes a work
  // order's crew — the reschedule endpoint, the work-order PUT, drag and drop —
  // gets it without having to remember.
  if (crewChanged) await syncDayEmployees(db, companyId, workOrderId, day.id);
}

/**
 * Put the right people on each day, derived from that day's own crew.
 *
 * Precedence, stated once so three modules do not each invent their own:
 *
 *   1. wo_day_employees rows marked 'manual' — someone deliberately put this
 *      person on this day. Never removed by a crew change.
 *   2. The roster of the day's own crew (wo_days.crew_id -> crew_members).
 *   3. The job's employee list (work_order_employees) when the day has no crew.
 *
 * Deriving per DAY rather than per JOB is what makes two things work:
 *
 *   - Dragging a job to another crew lane moves the labor with it. Previously
 *     only wo_days.crew_id changed, so the card appeared under the new crew
 *     while its planned minutes stayed attributed to the old one.
 *   - A multi-day job can be split across days AND crews. Each wo_days row
 *     carries its own crew_id, so day 1 can run with one crew and day 2 with
 *     another, each staffed correctly.
 *
 * Minutes tuned by hand survive as long as the person is still on the day —
 * only the set of people is re-derived, never their planned_minutes.
 *
 * Pass `dayId` to re-derive a single day (a crew change on one day of a
 * multi-day job); omit it to do every day of the work order.
 */
export async function syncDayEmployees(
  db: D1Database,
  companyId: string,
  workOrderId: string,
  dayId?: string,
): Promise<number> {
  const dayFilter = dayId ? ' AND d.id = ?' : '';
  const dayBinds = dayId ? [workOrderId, companyId, dayId] : [workOrderId, companyId];

  const [dayRes, jobEmpRes, existingRes] = await Promise.all([
    db.prepare(
      `SELECT d.id, d.crew_id, d.scheduled_duration_minutes, wo.duration_hours
         FROM wo_days d
         JOIN work_orders wo ON wo.id = d.work_order_id
        WHERE d.work_order_id=? AND d.company_id=?${dayFilter}`,
    ).bind(...dayBinds).all<any>(),
    // Fallback roster for days that carry no crew of their own.
    //
    // The crew_role subquery is scoped to the WORK ORDER's crew. It used to join
    // crew_members on rep_id alone, and nothing stops a rep being on several
    // crews (the unique index is on (crew_id, rep_id), not rep_id) — so a person
    // on two crews produced one row per crew, made the returned crew_role
    // whichever SQLite happened to emit first, and inflated the inserted count.
    // Only ON CONFLICT DO NOTHING kept it from writing a duplicate.
    //
    // MIN() rather than an arbitrary pick so the answer is at least stable
    // between runs; 'foreman' sorts before 'laborer', which is the useful tie-break.
    db.prepare(
      `SELECT woe.rep_id,
              COALESCE((SELECT MIN(cm.crew_role) FROM crew_members cm
                         WHERE cm.rep_id = woe.rep_id
                           AND cm.company_id = woe.company_id
                           AND cm.crew_id = (SELECT crew_id FROM work_orders WHERE id = woe.wo_id)),
                       'laborer') AS crew_role
         FROM work_order_employees woe
        WHERE woe.wo_id=? AND woe.company_id=?`,
    ).bind(workOrderId, companyId).all<any>(),
    db.prepare(
      `SELECT e.wo_day_id, e.rep_id, e.source
         FROM wo_day_employees e
         JOIN wo_days d ON d.id = e.wo_day_id
        WHERE d.work_order_id=? AND e.company_id=?${dayFilter}`,
    ).bind(...dayBinds).all<any>(),
  ]);

  const days = dayRes.results || [];
  if (!days.length) return 0;

  // Only read once we know there is work to do, and only for the fallback below.
  const { productive_minutes_per_day: productiveMinutes } = await loadWorkdaySettings(db, companyId);

  // One read for every crew involved, rather than one per day.
  const crewIds = [...new Set(days.map((d: any) => s(d.crew_id || '')).filter(Boolean))];
  const rosterByCrew = new Map<string, any[]>();
  if (crewIds.length) {
    const placeholders = crewIds.map(() => '?').join(',');
    const rosterRes = await db
      .prepare(
        `SELECT crew_id, rep_id, COALESCE(crew_role,'laborer') AS crew_role
           FROM crew_members WHERE company_id=? AND crew_id IN (${placeholders})`,
      )
      .bind(companyId, ...crewIds)
      .all<any>();
    for (const m of rosterRes.results || []) {
      if (!rosterByCrew.has(m.crew_id)) rosterByCrew.set(m.crew_id, []);
      rosterByCrew.get(m.crew_id)!.push(m);
    }
  }

  const existingByDay = new Map<string, Map<string, string>>();
  for (const e of existingRes.results || []) {
    if (!existingByDay.has(e.wo_day_id)) existingByDay.set(e.wo_day_id, new Map());
    existingByDay.get(e.wo_day_id)!.set(e.rep_id, s(e.source || 'roster'));
  }

  const statements: D1PreparedStatement[] = [];
  let written = 0;

  for (const day of days) {
    const crewId = s(day.crew_id || '');
    const desired = crewId ? (rosterByCrew.get(crewId) || []) : (jobEmpRes.results || []);
    const desiredIds = new Set(desired.map((r: any) => r.rep_id));
    const existing = existingByDay.get(day.id) || new Map<string, string>();

    // Drop roster-derived people who are no longer on this day's crew. A
    // 'manual' row is a deliberate choice and stays.
    for (const [repId, source] of existing) {
      if (source !== 'roster') continue;
      if (desiredIds.has(repId)) continue;
      statements.push(
        db.prepare(`DELETE FROM wo_day_employees WHERE wo_day_id=? AND rep_id=? AND company_id=?`)
          .bind(day.id, repId, companyId),
      );
    }

    // How much labor to plan for each person on this day.
    //
    // The day's own calendar duration wins, then the job's. The last resort used
    // to be 0, which is a claim nobody would make out loud: it says this crew is
    // on site and doing nothing. A job scheduled straight off the Job Pool has no
    // stated duration yet, so every person landed at 0 and the crew read as
    // completely idle on a day it was fully booked — capacity was 0% next to a
    // grid full of cards.
    //
    // Falling back to the company's productive day is the honest default: you
    // have put a crew on a job for a day, and absent any other information they
    // are on it for the day. Correct it by resizing the block or by tuning a
    // person's minutes, both of which this function preserves.
    const defaultMinutes =
      day.scheduled_duration_minutes != null
        ? int(day.scheduled_duration_minutes)
        : day.duration_hours != null
          ? Math.round(Number(day.duration_hours) * 60)
          : productiveMinutes;

    for (const rep of desired) {
      if (existing.has(rep.rep_id)) continue; // keeps hand-tuned planned_minutes
      statements.push(
        db.prepare(
          `INSERT INTO wo_day_employees (id, company_id, wo_day_id, rep_id, planned_minutes, crew_role, source)
           VALUES (?,?,?,?,?,?, 'roster')
           ON CONFLICT(wo_day_id, rep_id) DO NOTHING`,
        ).bind(newId('wde'), companyId, day.id, rep.rep_id, defaultMinutes, rep.crew_role || 'laborer'),
      );
      written += 1;
    }
  }

  if (statements.length) await db.batch(statements);
  return written;
}

// ── GET /week ────────────────────────────────────────────────────────────────

/**
 * One payload for the whole week.
 *
 * Deliberately a fixed number of queries regardless of how many crews or jobs
 * are in range: five reads, then assembly in memory. The grid must never issue
 * a query per crew — that is what makes a week view feel slow, and it gets
 * worse exactly as a company grows.
 */
schedulingRouter.get('/week', async (c) => {
  const db = c.env.DB;
  const companyId = c.var.companyId;
  const role = c.var.role;

  const today = nowIso().slice(0, 10);
  const start = isoDateOr(c.req.query('start'), today);
  const end = addDays(start, 6);
  const crewFilter = s(c.req.query('crew_id'), 64);

  const settings = await loadWorkdaySettings(db, companyId);
  const workingDays = parseWorkingDays(settings.working_days);

  const [crewsRes, membersRes, daysRes] = await Promise.all([
    db.prepare(`SELECT id, name, color FROM crews WHERE company_id=? AND active=1 ORDER BY name`)
      .bind(companyId).all<any>(),
    db.prepare(
      `SELECT cm.crew_id, cm.rep_id, cm.crew_role, r.name AS rep_name
         FROM crew_members cm
         JOIN reps r ON r.id = cm.rep_id
        WHERE cm.company_id=?`,
    ).bind(companyId).all<any>(),
    db.prepare(
      `SELECT d.id, d.work_order_id, d.day_number, d.day_date, d.start_time, d.end_time,
              d.scheduled_duration_minutes, d.schedule_locked, d.status AS day_status,
              d.crew_id AS day_crew_id, d.phase_name,
              wo.wo_number, wo.title, wo.client_name, wo.property_addr, wo.type,
              wo.status AS wo_status, wo.crew_id AS wo_crew_id,
              wo.budget_minutes, wo.amount_est_cents, wo.duration_hours
         FROM wo_days d
         JOIN work_orders wo ON wo.id = d.work_order_id AND wo.company_id = d.company_id
        WHERE d.company_id=? AND d.day_date >= ? AND d.day_date <= ?
        ORDER BY d.day_date, d.start_time`,
    ).bind(companyId, start, end).all<any>(),
  ]);

  const dayRows = (daysRes.results || []).filter((d: any) => {
    if (!crewFilter) return true;
    return s(d.day_crew_id || d.wo_crew_id) === crewFilter;
  });

  // One extra read for assignments across every day in range — still not per crew.
  //
  // Joins back to wo_days on the date range rather than binding one parameter per
  // day id. The IN-list version blew D1's bound-parameter cap the moment a week
  // held more than about a hundred day rows: /week returned 500 and the board
  // died outright. Verified — 120 day rows in one week reproduced it exactly.
  // Three bound parameters now, regardless of how busy the week is.
  const dayIds = new Set(dayRows.map((d: any) => d.id));
  const assignmentsRes = await db
    .prepare(
      `SELECT e.wo_day_id, e.rep_id, e.planned_minutes, e.crew_role, r.name AS rep_name
         FROM wo_day_employees e
         JOIN wo_days d ON d.id = e.wo_day_id
         JOIN reps r ON r.id = e.rep_id
        WHERE e.company_id=? AND d.day_date >= ? AND d.day_date <= ?`,
    )
    .bind(companyId, start, end)
    .all<any>();
  // Kept to the days actually being rendered, so a crew_id filter still narrows
  // the result the same way the old id-list did.
  const assignmentRows = (assignmentsRes.results || []).filter((a: any) => dayIds.has(a.wo_day_id));

  const assignmentsByDay = new Map<string, any[]>();
  for (const a of assignmentRows) {
    if (!assignmentsByDay.has(a.wo_day_id)) assignmentsByDay.set(a.wo_day_id, []);
    assignmentsByDay.get(a.wo_day_id)!.push({
      rep_id: a.rep_id,
      rep_name: a.rep_name,
      crew_role: a.crew_role,
      planned_minutes: int(a.planned_minutes),
    });
  }

  const membersByCrew = new Map<string, any[]>();
  for (const m of membersRes.results || []) {
    if (!membersByCrew.has(m.crew_id)) membersByCrew.set(m.crew_id, []);
    membersByCrew.get(m.crew_id)!.push({ rep_id: m.rep_id, rep_name: m.rep_name, crew_role: m.crew_role });
  }

  const stripMoney = hidesMoney(role);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));

  const assignments = dayRows.map((d: any) => {
    const crewId = s(d.day_crew_id || d.wo_crew_id || '');
    const planned = (assignmentsByDay.get(d.id) || []).reduce(
      (sum, a) => sum + a.planned_minutes,
      0,
    );
    return {
      day_id: d.id,
      work_order_id: d.work_order_id,
      wo_number: d.wo_number,
      title: d.title,
      client_name: d.client_name,
      property_addr: d.property_addr,
      type: d.type,
      status: d.wo_status,
      day_status: d.day_status,
      day_number: d.day_number,
      phase_name: d.phase_name,
      date: d.day_date,
      crew_id: crewId,
      start_time: d.start_time,
      end_time: d.end_time,
      // Calendar duration — how long this blocks on the grid.
      duration_minutes:
        d.scheduled_duration_minutes != null
          ? int(d.scheduled_duration_minutes)
          : d.duration_hours != null
            ? Math.round(Number(d.duration_hours) * 60)
            : null,
      schedule_locked: int(d.schedule_locked, 0),
      // Labor planned for this day, summed across the people on it.
      planned_minutes: planned,
      // What we sold. Read-only here; scheduling never writes it.
      budget_minutes: d.budget_minutes == null ? null : int(d.budget_minutes),
      employees: assignmentsByDay.get(d.id) || [],
      ...(stripMoney ? {} : { value_cents: int(d.amount_est_cents, 0) }),
    };
  });

  // Capacity per crew per day: people on the crew x productive minutes, against
  // the labor actually planned for that crew that day.
  const crews = (crewsRes.results || [])
    .filter((cr: any) => !crewFilter || cr.id === crewFilter)
    .map((cr: any) => {
      const members = membersByCrew.get(cr.id) || [];
      const dailyCapacity = crewDailyCapacityMinutes(members.length, settings.productive_minutes_per_day);
      const byDay = days.map((date) => {
        const isWorkingDay = workingDays.includes(new Date(`${date}T00:00:00Z`).getUTCDay());
        const capacity = isWorkingDay ? dailyCapacity : 0;
        const planned = assignments
          .filter((a) => a.crew_id === cr.id && a.date === date)
          .reduce((sum, a) => sum + a.planned_minutes, 0);
        return {
          date,
          is_working_day: isWorkingDay,
          capacity_minutes: capacity,
          planned_minutes: planned,
          // null, not 0, when there is nobody to divide by — see capacity.ts.
          utilization_pct: utilizationPct(planned, capacity),
        };
      });
      const weekCapacity = byDay.reduce((sum, d) => sum + d.capacity_minutes, 0);
      const weekPlanned = byDay.reduce((sum, d) => sum + d.planned_minutes, 0);
      return {
        id: cr.id,
        name: cr.name,
        color: cr.color,
        members,
        member_count: members.length,
        daily_capacity_minutes: dailyCapacity,
        week_capacity_minutes: weekCapacity,
        week_planned_minutes: weekPlanned,
        week_utilization_pct: utilizationPct(weekPlanned, weekCapacity),
        days: byDay,
      };
    });

  // ── Conflicts ──────────────────────────────────────────────────────────────
  //
  // Computed here rather than behind their own endpoint because everything they
  // need is already loaded, and because a warning that arrives in a second
  // request is a warning the grid can render without.
  //
  // Every one of these is derived from data that exists. There is deliberately
  // no "materials not ready" or "equipment already assigned" until the columns
  // behind them are real — a warning that cannot fire is worse than no warning,
  // because it teaches people the check is running when it is not.
  const warnings: Array<{ type: string; severity: 'warn' | 'error'; date: string; crew_id?: string; day_id?: string; rep_id?: string; message: string }> = [];

  for (const cr of crews) {
    for (const d of cr.days) {
      if (d.utilization_pct != null && d.utilization_pct > 100) {
        warnings.push({
          type: 'crew_over_capacity', severity: 'warn', date: d.date, crew_id: cr.id,
          message: `${cr.name} is booked to ${d.utilization_pct}% of capacity`,
        });
      }
      if (!d.is_working_day && d.planned_minutes > 0) {
        warnings.push({
          type: 'outside_working_days', severity: 'warn', date: d.date, crew_id: cr.id,
          message: `${cr.name} has work booked on a non-working day`,
        });
      }
    }
  }

  // One person, two jobs, same date. Distinct DAYS, so a person legitimately
  // listed once is never flagged — this is about two separate commitments.
  const repDay = new Map<string, { name: string; days: Set<string> }>();
  for (const a of assignments) {
    for (const e of a.employees) {
      const key = `${e.rep_id}|${a.date}`;
      if (!repDay.has(key)) repDay.set(key, { name: e.rep_name, days: new Set() });
      repDay.get(key)!.days.add(a.day_id);
    }
  }
  for (const [key, v] of repDay) {
    if (v.days.size < 2) continue;
    // split() is typed as possibly-undefined per element; the key is built
    // immediately above as `${rep_id}|${date}` so both halves exist.
    const [rep_id = '', date = ''] = key.split('|');
    warnings.push({
      type: 'employee_double_booked', severity: 'error', date, rep_id,
      message: `${v.name} is on ${v.days.size} jobs on this day`,
    });
  }

  // Planned labor short of what was sold, on a job whose days are all in view.
  // Only flagged when the job actually has a sold figure — a null budget means
  // "never costed", which is not the same as "under-planned".
  const byWorkOrder = new Map<string, { planned: number; budget: number | null; last: string; day_id: string }>();
  for (const a of assignments) {
    const cur = byWorkOrder.get(a.work_order_id) || { planned: 0, budget: a.budget_minutes, last: a.date, day_id: a.day_id };
    cur.planned += a.planned_minutes;
    if (a.date > cur.last) cur.last = a.date;
    byWorkOrder.set(a.work_order_id, cur);
  }
  for (const [, v] of byWorkOrder) {
    if (v.budget == null || v.budget <= 0) continue;
    if (v.planned === 0) continue; // unstaffed is its own, more obvious, problem
    if (v.planned < v.budget * 0.75) {
      warnings.push({
        type: 'under_planned', severity: 'warn', date: v.last, day_id: v.day_id,
        message: `Only ${Math.round((v.planned / v.budget) * 100)}% of the sold labor is on the schedule`,
      });
    }
  }

  return c.json({
    ok: true,
    start,
    end,
    days,
    warnings,
    working_hours: {
      working_days: workingDays,
      shift_start: settings.shift_start,
      shift_end: settings.shift_end,
      productive_minutes_per_day: settings.productive_minutes_per_day,
    },
    crews,
    assignments,
    money_visible: !stripMoney,
  });
});


// ── GET /route?date=&crew_id= ────────────────────────────────────────────────

/**
 * One crew's stops for one day, in order, with the on-site total.
 *
 * Ordering is the half of routing that works with no external service, and it
 * is useful the day it ships: a crew driving its stops in a sensible order
 * saves more time than any optimiser will find on top of that.
 */
schedulingRouter.get('/route', async (c) => {
  const db = c.env.DB;
  const companyId = c.var.companyId;
  const date = isoDateOr(c.req.query('date'), nowIso().slice(0, 10));
  const crewId = s(c.req.query('crew_id'), 64);
  if (!crewId) return c.json({ ok: false, error: 'crew_id is required' }, 400);

  const rows = await db
    .prepare(
      `SELECT d.id AS day_id, d.work_order_id, d.stop_order, d.lat_e7, d.lng_e7, d.drive_minutes,
              d.start_time, d.scheduled_duration_minutes,
              wo.wo_number, wo.client_name, wo.property_addr, wo.duration_hours
         FROM wo_days d
         JOIN work_orders wo ON wo.id = d.work_order_id AND wo.company_id = d.company_id
        WHERE d.company_id=? AND d.day_date=? AND d.crew_id=?`,
    )
    .bind(companyId, date, crewId)
    .all<any>();

  const raw = (rows.results || []).map((r: any) => ({
    day_id: r.day_id,
    work_order_id: r.work_order_id,
    wo_number: r.wo_number,
    client_name: r.client_name,
    address: r.property_addr,
    stop_order: r.stop_order,
    // Degrees out, scaled integers in the column. See migration 0073.
    lat: fromE7(r.lat_e7),
    lng: fromE7(r.lng_e7),
    drive_minutes: r.drive_minutes,
    start_time: r.start_time,
    duration_minutes:
      r.scheduled_duration_minutes != null
        ? int(r.scheduled_duration_minutes)
        : r.duration_hours != null
          ? Math.round(Number(r.duration_hours) * 60)
          : null,
  }));
  const startTimes: Record<string, string | null> = {};
  for (const r of rows.results || []) startTimes[r.day_id] = r.start_time ?? null;

  const stops = normalizeStopOrder(raw, startTimes);
  return c.json({ ok: true, date, crew_id: crewId, stops, summary: summarizeRoute(stops) });
});

// ── POST /route/reorder ──────────────────────────────────────────────────────

/**
 * Move one stop to a new position and persist the whole resulting order.
 *
 * The whole order, not just the moved row: renumbering one and leaving the rest
 * is how a list ends up with two stop 3s and no stop 5. Written in one batch so
 * the day is never half-reordered.
 */
schedulingRouter.post('/route/reorder', async (c) => {
  const db = c.env.DB;
  const companyId = c.var.companyId;
  const body = (await c.req.json().catch(() => ({}))) as any;
  const date = isoDateOr(body.date, '');
  const crewId = s(body.crew_id, 64);
  const dayId = s(body.day_id, 64);
  const toPosition = int(body.to_position, 0);
  if (!date || !crewId || !dayId || toPosition < 1) {
    return c.json({ ok: false, error: 'date, crew_id, day_id and to_position are required' }, 400);
  }

  const rows = await db
    .prepare(
      `SELECT id AS day_id, work_order_id, stop_order, start_time, scheduled_duration_minutes
         FROM wo_days WHERE company_id=? AND day_date=? AND crew_id=?`,
    )
    .bind(companyId, date, crewId)
    .all<any>();
  const list = rows.results || [];
  if (!list.some((r: any) => r.day_id === dayId)) {
    return c.json({ ok: false, error: 'That stop is not on this crew this day' }, 404);
  }

  const startTimes: Record<string, string | null> = {};
  for (const r of list) startTimes[r.day_id] = r.start_time ?? null;
  const current = normalizeStopOrder(
    list.map((r: any) => ({ day_id: r.day_id, work_order_id: r.work_order_id, stop_order: r.stop_order })),
    startTimes,
  );
  const next = reorderStops(current, dayId, toPosition);

  await db.batch(
    next.map((st) =>
      db
        .prepare(`UPDATE wo_days SET stop_order=?, updated_at=datetime('now') WHERE id=? AND company_id=?`)
        .bind(st.position, st.day_id, companyId),
    ),
  );

  return c.json({ ok: true, date, crew_id: crewId, stops: next });
});

// ── GET /backlog ─────────────────────────────────────────────────────────────

/**
 * Everything that is not yet on the grid, in three buckets:
 *
 *   needs_scheduling  no date
 *   needs_crew        has a date, nobody assigned to it
 *   tentative         on hold — scheduled before the client accepted
 */
schedulingRouter.get('/backlog', async (c) => {
  const db = c.env.DB;
  const companyId = c.var.companyId;
  const stripMoney = hidesMoney(c.var.role);
  const typeFilter = s(c.req.query('type'), 40);
  const limit = Math.min(500, Math.max(1, int(c.req.query('limit'), 200)));

  const res = await db
    .prepare(
      `SELECT id, wo_number, title, client_name, property_addr, type, status,
              crew_id, scheduled_date, duration_hours, budget_minutes, amount_est_cents,
              priority, required_completion_date, target_crew_size
         FROM work_orders
        WHERE company_id=?
          AND status NOT IN ('completed','cancelled')
          AND (COALESCE(scheduled_date,'') = '' OR COALESCE(crew_id,'') = '' OR status='hold')
          AND (? = '' OR type = ?)
        ORDER BY COALESCE(scheduled_date, '9999-12-31'), wo_number
        LIMIT ?`,
    )
    .bind(companyId, typeFilter, typeFilter, limit)
    .all<any>();

  // A concrete shape, not Record<string, any[]>: the index signature made every
  // bucket possibly-undefined, so `buckets.tentative.push(...)` was unchecked.
  const buckets: { needs_scheduling: any[]; needs_crew: any[]; tentative: any[] } =
    { needs_scheduling: [], needs_crew: [], tentative: [] };
  for (const wo of res.results || []) {
    const card = {
      work_order_id: wo.id,
      wo_number: wo.wo_number,
      title: wo.title,
      client_name: wo.client_name,
      property_addr: wo.property_addr,
      type: wo.type,
      status: wo.status,
      scheduled_date: wo.scheduled_date || null,
      crew_id: s(wo.crew_id || ''),
      duration_minutes: wo.duration_hours == null ? null : Math.round(Number(wo.duration_hours) * 60),
      budget_minutes: wo.budget_minutes == null ? null : int(wo.budget_minutes),
      // Migration 0070. The pool filters and sorts on these, which is the whole
      // reason the columns exist — see the migration header.
      priority: s(wo.priority || '') || null,
      required_completion_date: s(wo.required_completion_date || '', 10) || null,
      target_crew_size: wo.target_crew_size == null ? null : int(wo.target_crew_size),
      ...(stripMoney ? {} : { value_cents: int(wo.amount_est_cents, 0) }),
    };
    // Order matters, and 'hold' deliberately wins.
    //
    // The revamp plan proposed reversing this so a held job with no date would
    // report as needs_scheduling rather than being "swallowed" by tentative.
    // That is wrong, and the existing test caught it. 'hold' is what
    // estimate -> work-order conversion writes when the client has NOT accepted
    // yet (see src/index.tsx, the traffic-light hold). Surfacing unsold work
    // under "needs scheduling" would invite someone to commit a crew to a job
    // the customer has not agreed to buy.
    //
    // Tentative first is the honest answer: the next action on that job is to
    // close the sale, not to find it a Tuesday.
    if (wo.status === 'hold') buckets.tentative.push(card);
    else if (!s(wo.scheduled_date)) buckets.needs_scheduling.push(card);
    else buckets.needs_crew.push(card);
  }

  return c.json({ ok: true, ...buckets, money_visible: !stripMoney });
});

// ── POST /work-orders/:id/schedule ───────────────────────────────────────────

/**
 * Put a backlog job onto the grid.
 *
 * Separate from POST /days/:id/schedule because a backlog job has no day row
 * yet — migration 0061 only backfilled work orders that already had a date.
 * This creates the row, then applies the same scheduling write.
 */
schedulingRouter.post('/work-orders/:id/schedule', async (c) => {
  const db = c.env.DB;
  const companyId = c.var.companyId;
  const workOrderId = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as any;

  const date = isoDateOr(body.date, '');
  if (!date) return c.json({ ok: false, error: 'A valid date (YYYY-MM-DD) is required' }, 400);

  const wo = await db
    .prepare(`SELECT id, schedule_locked FROM work_orders WHERE id=? AND company_id=? LIMIT 1`)
    .bind(workOrderId, companyId)
    .first<any>();
  if (!wo) return c.json({ ok: false, error: 'Work order not found' }, 404);

  // Lock checked HERE, before anything is written.
  //
  // schedule_locked was selected above and never read: the only lock check
  // happened downstream inside applyDaySchedule, by which point the UPDATE below
  // had already committed a new date. A locked job returned 409 and moved
  // anyway — the refusal and the write both happened.
  if (int(wo.schedule_locked, 0) === 1 && body.force !== true) {
    return c.json({ ok: false, error: 'This visit is locked. Unlock it before rescheduling.' }, 409);
  }

  // Set the date first so ensurePrimaryDay has something to copy from.
  await db
    .prepare(`UPDATE work_orders SET scheduled_date=?, updated_at=datetime('now') WHERE id=? AND company_id=?`)
    .bind(date, workOrderId, companyId)
    .run();

  const dayId = await ensurePrimaryDay(db, companyId, workOrderId);
  if (!dayId) return c.json({ ok: false, error: 'Could not create a day row' }, 500);

  // The day was just created from the work order, so it already carries the
  // right crew — but nobody is on it yet. Without this a job scheduled straight
  // off the backlog lands on the grid with zero planned labor.
  await syncDayEmployees(db, companyId, workOrderId, dayId);

  return applyDaySchedule(c, dayId, body);
});

// ── POST /days/:id/schedule ──────────────────────────────────────────────────

/** Drag, drop and resize all land here. */
schedulingRouter.post('/days/:id/schedule', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as any;
  return applyDaySchedule(c, c.req.param('id'), body);
});

async function applyDaySchedule(c: any, dayId: string, body: any) {
  const db = c.env.DB as D1Database;
  const companyId = c.var.companyId as string;

  // Everything needed to decide AND to mirror, in one read. The is_primary flag
  // used to be fetched in a second round trip after the write, along with a
  // third read for the fresh row — see the batch below for why that mattered.
  const day = await db
    .prepare(
      `SELECT id, work_order_id, schedule_locked, crew_id, is_primary,
              day_date, start_time, end_time, scheduled_duration_minutes
         FROM wo_days WHERE id=? AND company_id=? LIMIT 1`,
    )
    .bind(dayId, companyId)
    .first<any>();
  if (!day) return c.json({ ok: false, error: 'Day not found' }, 404);
  if (int(day.schedule_locked, 0) === 1 && body.force !== true) {
    return c.json({ ok: false, error: 'This day is schedule-locked' }, 409);
  }

  const sets: string[] = [];
  const binds: any[] = [];

  if (body.date !== undefined) {
    const date = isoDateOr(body.date, '');
    if (!date) return c.json({ ok: false, error: 'Invalid date' }, 400);
    sets.push('day_date=?');
    binds.push(date);
  }
  if (body.start_time !== undefined) {
    sets.push('start_time=?');
    binds.push(timeOrNull(body.start_time));
  }
  if (body.end_time !== undefined) {
    sets.push('end_time=?');
    binds.push(timeOrNull(body.end_time));
  }
  if (body.duration_minutes !== undefined) {
    const d = int(body.duration_minutes, 0);
    if (d < 0 || d > 24 * 60) return c.json({ ok: false, error: 'duration_minutes out of range' }, 400);
    sets.push('scheduled_duration_minutes=?');
    binds.push(d || null);
  }
  if (body.crew_id !== undefined) {
    sets.push('crew_id=?');
    binds.push(s(body.crew_id, 64));
  }

  if (!sets.length) return c.json({ ok: false, error: 'Nothing to update' }, 400);

  const crewChanged = body.crew_id !== undefined && s(body.crew_id, 64) !== s(day.crew_id || '');

  // What the row will hold once this write lands. Computed here rather than
  // re-read afterwards, which is what lets the mirror share one transaction.
  const next = {
    day_date: body.date !== undefined ? isoDateOr(body.date, '') : s(day.day_date ?? '', 10),
    start_time: body.start_time !== undefined ? timeOrNull(body.start_time) : (day.start_time ?? null),
    end_time: body.end_time !== undefined ? timeOrNull(body.end_time) : (day.end_time ?? null),
    duration:
      body.duration_minutes !== undefined
        ? int(body.duration_minutes, 0) || null
        : day.scheduled_duration_minutes == null
          ? null
          : int(day.scheduled_duration_minutes),
    crew_id: body.crew_id !== undefined ? s(body.crew_id, 64) : s(day.crew_id ?? ''),
  };

  sets.push("updated_at=datetime('now')");

  const statements = [
    db.prepare(`UPDATE wo_days SET ${sets.join(', ')} WHERE id=? AND company_id=?`).bind(...binds, dayId, companyId),
  ];

  // Resizing a job on the grid has to move the labor with it. planned_minutes
  // was seeded from the day's calendar duration and then never revisited, so
  // stretching a 4-hour block to 8 left every person on it still planned for 4
  // and the crew's utilisation unchanged — the grid said one thing and the
  // capacity bar beside it said another.
  //
  // Restricted to rows that still hold the OLD duration exactly: that is the
  // signature of an untouched default. Anyone whose minutes were hand-tuned
  // (someone leaving at noon) keeps them, which is the same rule syncDayEmployees
  // already follows when it re-derives a roster.
  const durationChanged = body.duration_minutes !== undefined && next.duration !== (day.scheduled_duration_minutes ?? null);
  if (durationChanged && next.duration != null) {
    statements.push(
      db
        .prepare(
          `UPDATE wo_day_employees SET planned_minutes=?, updated_at=datetime('now')
            WHERE wo_day_id=? AND company_id=? AND source='roster'
              AND planned_minutes = ?`,
        )
        .bind(next.duration, dayId, companyId, int(day.scheduled_duration_minutes, 0)),
    );
  }

  // Keep the work order's own scheduling columns in step for the primary day, so
  // screens still reading work_orders directly do not go stale.
  //
  // In the SAME batch as the day update. These were two independent statements
  // with two reads between them; a failure in the gap left the day moved and the
  // work order on its old date — precisely the split-brain the day row exists to
  // prevent. D1 runs a batch in one transaction, so now they land together or
  // not at all.
  //
  // budget_minutes is deliberately absent from this UPDATE and from every other
  // write in this router. Scheduling changes when a job happens and who is on
  // it — never what we sold.
  if (int(day.is_primary, 0) === 1) {
    statements.push(
      db
        .prepare(
          `UPDATE work_orders
              SET scheduled_date=?, scheduled_time=?, scheduled_end_time=?,
                  scheduled_duration_minutes=?, crew_id=?, updated_at=datetime('now')
            WHERE id=? AND company_id=?`,
        )
        .bind(
          next.day_date,
          next.start_time,
          next.end_time,
          next.duration,
          next.crew_id || null,
          day.work_order_id,
          companyId,
        ),
    );
  }

  await db.batch(statements);

  // Dropping a job into a different crew lane has to move the people too,
  // otherwise the card appears under the new crew while its planned labor stays
  // attributed to the old one. Scoped to this day, so one day of a multi-day job
  // can change crew without disturbing the others.
  //
  // Outside the batch because it needs to read the new crew's roster first. It is
  // idempotent and derives everything from the day's crew, so a failure here is
  // recoverable by re-running — unlike a half-applied move, which is not.
  if (crewChanged) await syncDayEmployees(db, companyId, day.work_order_id, dayId);

  return c.json({
    ok: true,
    day_id: dayId,
    work_order_id: day.work_order_id,
    // Capacity for every crew and date this touched — the crew it left as well
    // as the one it joined. Without the old crew the sidebar keeps showing labor
    // that has already moved away, and the caller has no way to know which other
    // lane to refresh.
    capacity: await capacityFor(
      db,
      companyId,
      [s(day.crew_id ?? ''), next.crew_id],
      [s(day.day_date ?? '', 10), next.day_date],
    ),
  });
}

/**
 * Capacity and planned labor for a set of (crew, date) pairs.
 *
 * Every scheduling write returns this so the grid and the number beside it
 * cannot disagree. docs/HANDOFF-scheduling.md promised it when the router was
 * designed and it was never built, so the board compensated with a second
 * round trip to /week after every drag — which is both slower and a window in
 * which the two can differ.
 *
 * Blank crew ids and blank dates are dropped: an unassigned or undated day has
 * no lane to report on.
 */
export async function capacityFor(
  db: D1Database,
  companyId: string,
  crewIds: string[],
  dates: string[],
): Promise<Array<{ crew_id: string; date: string; capacity_minutes: number; planned_minutes: number; utilization_pct: number | null }>> {
  const crews = [...new Set(crewIds.map((v) => s(v ?? '')).filter(Boolean))];
  const days = [...new Set(dates.map((v) => s(v ?? '', 10)).filter(Boolean))];
  if (!crews.length || !days.length) return [];

  const settings = await loadWorkdaySettings(db, companyId);
  const workingDays = parseWorkingDays(settings.working_days);

  const crewPlaceholders = crews.map(() => '?').join(',');
  const [membersRes, plannedRes] = await Promise.all([
    db
      .prepare(`SELECT crew_id, COUNT(*) AS n FROM crew_members WHERE company_id=? AND crew_id IN (${crewPlaceholders}) GROUP BY crew_id`)
      .bind(companyId, ...crews)
      .all<any>(),
    db
      .prepare(
        `SELECT d.crew_id, d.day_date, COALESCE(SUM(e.planned_minutes), 0) AS planned
           FROM wo_days d
           LEFT JOIN wo_day_employees e ON e.wo_day_id = d.id AND e.company_id = d.company_id
          WHERE d.company_id=? AND d.crew_id IN (${crewPlaceholders})
            AND d.day_date >= ? AND d.day_date <= ?
          GROUP BY d.crew_id, d.day_date`,
      )
      .bind(companyId, ...crews, days.slice().sort()[0], days.slice().sort().at(-1))
      .all<any>(),
  ]);

  const memberCount = new Map<string, number>();
  for (const m of membersRes.results || []) memberCount.set(m.crew_id, int(m.n, 0));
  const plannedBy = new Map<string, number>();
  for (const p of plannedRes.results || []) plannedBy.set(`${p.crew_id}|${p.day_date}`, int(p.planned, 0));

  const out = [];
  for (const crewId of crews) {
    const daily = crewDailyCapacityMinutes(memberCount.get(crewId) || 0, settings.productive_minutes_per_day);
    for (const date of days) {
      const isWorkingDay = workingDays.includes(new Date(`${date}T00:00:00Z`).getUTCDay());
      const capacity = isWorkingDay ? daily : 0;
      const planned = plannedBy.get(`${crewId}|${date}`) || 0;
      out.push({
        crew_id: crewId,
        date,
        capacity_minutes: capacity,
        planned_minutes: planned,
        utilization_pct: utilizationPct(planned, capacity),
      });
    }
  }
  return out;
}

// ── DELETE /days/:id/schedule ────────────────────────────────────────────────

/** Back to the backlog: clear the date but keep the day row and its people. */
schedulingRouter.delete('/days/:id/schedule', async (c) => {
  const db = c.env.DB;
  const companyId = c.var.companyId;
  const dayId = c.req.param('id');

  const day = await db
    .prepare(`SELECT id, work_order_id, is_primary FROM wo_days WHERE id=? AND company_id=? LIMIT 1`)
    .bind(dayId, companyId)
    .first<any>();
  if (!day) return c.json({ ok: false, error: 'Day not found' }, 404);

  await db
    .prepare(
      `UPDATE wo_days SET day_date='', start_time=NULL, end_time=NULL, updated_at=datetime('now')
        WHERE id=? AND company_id=?`,
    )
    .bind(dayId, companyId)
    .run();

  if (int(day.is_primary, 0) === 1) {
    await db
      .prepare(
        `UPDATE work_orders SET scheduled_date=NULL, scheduled_time=NULL, scheduled_end_time=NULL,
                                updated_at=datetime('now')
          WHERE id=? AND company_id=?`,
      )
      .bind(day.work_order_id, companyId)
      .run();
  }

  return c.json({ ok: true, day_id: dayId, work_order_id: day.work_order_id });
});

// ── POST /days/:id/assign ────────────────────────────────────────────────────

/**
 * Add, update or remove one person on one day.
 *
 * planned_minutes is the labor we intend that person to spend. It is not the
 * budget and not the actual — see the module header.
 */
schedulingRouter.post('/days/:id/assign', async (c) => {
  const db = c.env.DB;
  const companyId = c.var.companyId;
  const dayId = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as any;

  const repId = s(body.rep_id, 64);
  if (!repId) return c.json({ ok: false, error: 'rep_id is required' }, 400);

  const day = await db
    .prepare(`SELECT id FROM wo_days WHERE id=? AND company_id=? LIMIT 1`)
    .bind(dayId, companyId)
    .first<{ id: string }>();
  if (!day) return c.json({ ok: false, error: 'Day not found' }, 404);

  if (body.remove === true) {
    await db
      .prepare(`DELETE FROM wo_day_employees WHERE wo_day_id=? AND rep_id=? AND company_id=?`)
      .bind(dayId, repId, companyId)
      .run();
    return c.json({ ok: true, day_id: dayId, rep_id: repId, removed: true });
  }

  const planned = int(body.planned_minutes, 0);
  if (planned < 0 || planned > 24 * 60) {
    return c.json({ ok: false, error: 'planned_minutes out of range' }, 400);
  }
  const crewRole = s(body.crew_role, 32) || 'laborer';

  // Someone on the day's own crew stays 'roster' — they are here because of the
  // crew, and tuning their minutes should not pin them there through a crew
  // change. Anyone else is a deliberate addition and is marked 'manual' so
  // re-deriving the roster cannot silently drop them. See migration 0069.
  const onDayCrew = await db
    .prepare(
      `SELECT 1 AS x FROM wo_days d
         JOIN crew_members cm ON cm.crew_id = d.crew_id AND cm.company_id = d.company_id
        WHERE d.id=? AND d.company_id=? AND cm.rep_id=? LIMIT 1`,
    )
    .bind(dayId, companyId, repId)
    .first<{ x: number }>();
  const source = onDayCrew ? 'roster' : 'manual';

  // The unique index on (wo_day_id, rep_id) is what makes this safe to repeat:
  // re-assigning updates the minutes rather than stacking a second row, which
  // would silently double that person's contribution to capacity.
  await db
    .prepare(
      `INSERT INTO wo_day_employees (id, company_id, wo_day_id, rep_id, planned_minutes, crew_role, source)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(wo_day_id, rep_id)
       DO UPDATE SET planned_minutes=excluded.planned_minutes,
                     crew_role=excluded.crew_role,
                     source=excluded.source,
                     updated_at=datetime('now')`,
    )
    .bind(newId('wde'), companyId, dayId, repId, planned, crewRole, source)
    .run();

  return c.json({ ok: true, day_id: dayId, rep_id: repId, planned_minutes: planned });
});

// ── GET /work-orders/:id/hours ───────────────────────────────────────────────

/**
 * The three hour figures for one job, side by side.
 *
 * `actual_minutes` is summed NET OF BREAKS. time_entries.duration_min is gross
 * — the clock-out handlers store raw wall-clock elapsed and break_minutes
 * accumulates separately without ever being subtracted — so summing duration_min
 * alone overstates actual hours by exactly the break time.
 */
// ── /days/:id/equipment ──────────────────────────────────────────────────────

/**
 * Read, book and release the machines on one day.
 *
 * wo_day_equipment has existed since migration 0071 with no reader anywhere in
 * src/ — the rail has been showing the work order's free-text equipment notes,
 * which cannot be checked against anything. These three handlers are what make
 * the table real.
 *
 * Booking ids are deterministic: `wde_<day>_<asset>`. The table already has a
 * UNIQUE index on (wo_day_id, asset_id), so a random id would turn "book the
 * excavator" pressed twice into a UNIQUE violation. Deriving the id from the
 * pair it is unique on makes the second press an idempotent no-op instead,
 * which is the same reasoning as wod_bf_/pv_/wo_rc_ elsewhere.
 */
const equipmentBookingId = (dayId: string, assetId: string) => `wde_${dayId}_${assetId}`;

/** The day, scoped to the company, plus the date its collisions are judged on. */
async function equipmentDay(db: D1Database, dayId: string, companyId: string) {
  return db
    .prepare(
      `SELECT d.id, d.day_date, d.work_order_id, d.schedule_locked
         FROM wo_days d WHERE d.id=? AND d.company_id=? LIMIT 1`,
    )
    .bind(dayId, companyId)
    .first<any>();
}

/** Bookings for a day, joined to the assets they point at. */
const DAY_EQUIPMENT_SQL = `
  SELECT e.id, e.wo_day_id, e.asset_id, e.status, e.notes,
         a.name AS asset_name, a.asset_tag, a.category,
         d.day_date, d.work_order_id,
         wo.title AS job_title, cr.name AS crew_name
    FROM wo_day_equipment e
    JOIN wo_days d      ON d.id = e.wo_day_id AND d.company_id = e.company_id
    LEFT JOIN assets a  ON a.id = e.asset_id  AND a.company_id = e.company_id
    LEFT JOIN work_orders wo ON wo.id = d.work_order_id AND wo.company_id = d.company_id
    LEFT JOIN crews cr  ON cr.id = d.crew_id AND cr.company_id = d.company_id
   WHERE e.company_id = ?`;

schedulingRouter.get('/days/:id/equipment', async (c) => {
  const db = c.env.DB;
  const companyId = c.var.companyId;
  const dayId = c.req.param('id');

  const day = await equipmentDay(db, dayId, companyId);
  if (!day) return c.json({ ok: false, error: 'Day not found' }, 404);

  const mine = await db.prepare(`${DAY_EQUIPMENT_SQL} AND e.wo_day_id = ? ORDER BY a.name`)
    .bind(companyId, dayId).all<any>();

  // Every booking company-wide on this date, so the same-date collision can be
  // computed. An unscheduled day has day_date '' and collides with nothing.
  const sameDate = day.day_date
    ? await db.prepare(`${DAY_EQUIPMENT_SQL} AND d.day_date = ?`).bind(companyId, day.day_date).all<any>()
    : { results: [] as any[] };

  // The free-text notes this replaces, so nothing typed before 0071 disappears.
  const wo = await db.prepare(`SELECT equipment FROM work_orders WHERE id=? AND company_id=? LIMIT 1`)
    .bind(day.work_order_id, companyId).first<any>();
  let notes: any[] = [];
  try { const p = JSON.parse(wo?.equipment || '[]'); if (Array.isArray(p)) notes = p; } catch { /* free text, not JSON */ }

  return c.json({
    ok: true,
    day_id: dayId,
    day_date: day.day_date || null,
    ...summarizeDayEquipment(dayId, mine.results || [], sameDate.results || [], notes),
  });
});

schedulingRouter.post('/days/:id/equipment', async (c) => {
  const db = c.env.DB;
  const companyId = c.var.companyId;
  const dayId = c.req.param('id');
  const body = await c.req.json<any>().catch(() => ({}));
  const assetId = String(body?.asset_id || '').trim();
  if (!assetId) return c.json({ ok: false, error: 'asset_id is required' }, 400);

  const day = await equipmentDay(db, dayId, companyId);
  if (!day) return c.json({ ok: false, error: 'Day not found' }, 404);
  // A locked day refuses equipment changes for the same reason it refuses a
  // move: somebody has committed to this plan and told the crew.
  if (int(day.schedule_locked, 0) === 1) {
    return c.json({ ok: false, error: 'This day is locked. Unlock it to change equipment.' }, 409);
  }

  const asset = await db.prepare(`SELECT id, name FROM assets WHERE id=? AND company_id=? LIMIT 1`)
    .bind(assetId, companyId).first<any>();
  if (!asset) return c.json({ ok: false, error: 'Equipment not found' }, 404);

  const status = normalizeStatus(body?.status);
  const notes = String(body?.notes || '');
  await db
    .prepare(
      `INSERT INTO wo_day_equipment (id, company_id, wo_day_id, asset_id, status, notes)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(wo_day_id, asset_id)
         DO UPDATE SET status=excluded.status, notes=excluded.notes, updated_at=datetime('now')`,
    )
    .bind(equipmentBookingId(dayId, assetId), companyId, dayId, assetId, status, notes)
    .run();

  // Return the whole day, conflicts included: booking a machine is exactly when
  // somebody needs to be told it is already on another job.
  const mine = await db.prepare(`${DAY_EQUIPMENT_SQL} AND e.wo_day_id = ? ORDER BY a.name`)
    .bind(companyId, dayId).all<any>();
  const sameDate = day.day_date
    ? await db.prepare(`${DAY_EQUIPMENT_SQL} AND d.day_date = ?`).bind(companyId, day.day_date).all<any>()
    : { results: [] as any[] };

  return c.json({
    ok: true, day_id: dayId, day_date: day.day_date || null,
    ...summarizeDayEquipment(dayId, mine.results || [], sameDate.results || [], []),
  });
});

schedulingRouter.delete('/days/:id/equipment/:assetId', async (c) => {
  const db = c.env.DB;
  const companyId = c.var.companyId;
  const dayId = c.req.param('id');
  const assetId = c.req.param('assetId');

  const day = await equipmentDay(db, dayId, companyId);
  if (!day) return c.json({ ok: false, error: 'Day not found' }, 404);
  if (int(day.schedule_locked, 0) === 1) {
    return c.json({ ok: false, error: 'This day is locked. Unlock it to change equipment.' }, 409);
  }

  await db
    .prepare(`DELETE FROM wo_day_equipment WHERE wo_day_id=? AND asset_id=? AND company_id=?`)
    .bind(dayId, assetId, companyId)
    .run();

  return c.json({ ok: true, day_id: dayId, asset_id: assetId });
});

schedulingRouter.get('/work-orders/:id/hours', async (c) => {
  const db = c.env.DB;
  const companyId = c.var.companyId;
  const workOrderId = c.req.param('id');

  const wo = await db
    .prepare(
      // estimate_id and scheduled_date are for the labor variance below: the
      // estimate carries the frozen rate this job was sold at, and the date is
      // which day's rates to cost it against.
      `SELECT id, wo_number, title, budget_minutes, duration_hours, estimate_id, scheduled_date
         FROM work_orders WHERE id=? AND company_id=? LIMIT 1`,
    )
    .bind(workOrderId, companyId)
    .first<any>();
  if (!wo) return c.json({ ok: false, error: 'Work order not found' }, 404);

  const [plannedRes, entriesRes] = await Promise.all([
    db.prepare(
      `SELECT COALESCE(SUM(e.planned_minutes), 0) AS planned
         FROM wo_day_employees e
         JOIN wo_days d ON d.id = e.wo_day_id
        WHERE d.work_order_id=? AND e.company_id=?`,
    ).bind(workOrderId, companyId).first<{ planned: number }>(),
    db.prepare(
      `SELECT duration_min, break_minutes
         FROM time_entries
        WHERE work_order_id=? AND company_id=? AND clock_out IS NOT NULL`,
    ).bind(workOrderId, companyId).all<any>(),
  ]);

  const actualMinutes = (entriesRes.results || []).reduce(
    (sum: number, e: any) => sum + netActualMinutes(int(e.duration_min), int(e.break_minutes)),
    0,
  );
  const grossMinutes = (entriesRes.results || []).reduce(
    (sum: number, e: any) => sum + int(e.duration_min),
    0,
  );

  const budget = wo.budget_minutes == null ? null : int(wo.budget_minutes);
  const variance = budget == null ? null : actualMinutes - budget;

  return c.json({
    ok: true,
    work_order_id: wo.id,
    wo_number: wo.wo_number,
    title: wo.title,
    // What we sold. NULL means the job did not come from an estimate carrying a
    // cost-engine rollup — which is different from a budget of zero.
    budget_minutes: budget,
    // What we intend to spend.
    planned_minutes: int(plannedRes?.planned, 0),
    // What it actually took, net of breaks.
    actual_minutes: actualMinutes,
    // Exposed so a discrepancy against the timesheet screens is explainable
    // rather than looking like a bug.
    actual_minutes_gross: grossMinutes,
    break_minutes: grossMinutes - actualMinutes,
    variance_minutes: variance,
    over_budget: variance != null && variance > 0,
    // What the labor is COSTING against what it was SOLD at.
    //
    // Money, so it is stripped for anyone without the compensation permission —
    // the hours themselves stay visible, because a foreman needs to know a job
    // is running long without being told what the crew is paid.
    ...(await laborVarianceFor(c, wo)),
  });
});

/**
 * Sold-vs-cost for one work order, or an explained absence.
 *
 * Tyler's rule: a sent estimate keeps its blended rate, actual employee rates
 * drive internal costing, and the gap is DISPLAYED rather than reconciled away.
 * So the sold figure comes from the estimate's frozen rate and the cost figure
 * from rates resolved today, and neither is allowed to overwrite the other.
 */
async function laborVarianceFor(c: any, wo: any): Promise<Record<string, unknown>> {
  const allowed = canViewCompensation({
    role: c.var.role, can_view_compensation: c.var.canViewCompensation, is_super_admin: c.var.isSuperAdmin,
  });
  if (!allowed) return {};

  const db = c.env.DB as D1Database;
  const companyId = c.var.companyId as string;
  const est = wo.estimate_id
    ? await db.prepare(`SELECT locked_labor_rate FROM estimates WHERE id=? AND company_id=?`)
        .bind(wo.estimate_id, companyId).first<any>()
    : null;

  let currentRate: number | null = null;
  try {
    const resolved = await resolveLaborRate(db, {
      company_id: companyId, employee_id: '',
      work_date: s(wo.scheduled_date ?? '', 10) || nowIso().slice(0, 10),
    });
    currentRate = resolved?.resolved_rate ?? null;
  } catch (_) { /* no profile configured — variance reports as unknown */ }

  const planned = await db
    .prepare(
      `SELECT COALESCE(SUM(e.planned_minutes),0) AS planned FROM wo_day_employees e
         JOIN wo_days d ON d.id = e.wo_day_id
        WHERE d.work_order_id=? AND e.company_id=?`,
    )
    .bind(wo.id, companyId)
    .first<{ planned: number }>();

  return {
    labor_variance: computeLaborVariance({
      lockedRate: est?.locked_labor_rate ?? null,
      currentRate,
      minutes: int(planned?.planned, 0),
    }),
  };
}
