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
    productive_minutes_per_day:
      Number(row?.productive_minutes_per_day) > 0
        ? Number(row.productive_minutes_per_day)
        : DEFAULT_PRODUCTIVE_MINUTES_PER_DAY,
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

  const existing = await db
    .prepare(`SELECT id FROM wo_days WHERE work_order_id=? ORDER BY day_number LIMIT 1`)
    .bind(workOrderId)
    .first<{ id: string }>();
  if (existing) return existing.id;

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
 * The board's drag, drop and resize all write through the pre-existing
 * /api/work-orders/:id/reschedule, which updates work_orders and nothing else.
 * Capacity is computed from wo_days, so without this a dragged job moves on the
 * grid while its labor stays attributed to the day it came from — the grid and
 * the capacity figure beside it disagree, and no amount of refetching fixes it
 * because the underlying row is stale.
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
    db.prepare(
      `SELECT woe.rep_id, COALESCE(cm.crew_role, 'laborer') AS crew_role
         FROM work_order_employees woe
         LEFT JOIN crew_members cm ON cm.rep_id = woe.rep_id AND cm.company_id = woe.company_id
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

    const defaultMinutes =
      day.scheduled_duration_minutes != null
        ? int(day.scheduled_duration_minutes)
        : day.duration_hours != null
          ? Math.round(Number(day.duration_hours) * 60)
          : 0;

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
  const dayIds = dayRows.map((d: any) => d.id);
  let assignmentRows: any[] = [];
  if (dayIds.length) {
    const placeholders = dayIds.map(() => '?').join(',');
    const res = await db
      .prepare(
        `SELECT e.wo_day_id, e.rep_id, e.planned_minutes, e.crew_role, r.name AS rep_name
           FROM wo_day_employees e
           JOIN reps r ON r.id = e.rep_id
          WHERE e.company_id=? AND e.wo_day_id IN (${placeholders})`,
      )
      .bind(companyId, ...dayIds)
      .all<any>();
    assignmentRows = res.results || [];
  }

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

  return c.json({
    ok: true,
    start,
    end,
    days,
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
              crew_id, scheduled_date, duration_hours, budget_minutes, amount_est_cents
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

  const buckets: Record<string, any[]> = { needs_scheduling: [], needs_crew: [], tentative: [] };
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
      ...(stripMoney ? {} : { value_cents: int(wo.amount_est_cents, 0) }),
    };
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

  // Set the date first so ensurePrimaryDay has something to copy from.
  await db
    .prepare(`UPDATE work_orders SET scheduled_date=?, updated_at=datetime('now') WHERE id=? AND company_id=?`)
    .bind(date, workOrderId, companyId)
    .run();

  const dayId = await ensurePrimaryDay(db, companyId, workOrderId);
  if (!dayId) return c.json({ ok: false, error: 'Could not create a day row' }, 500);

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

  const day = await db
    .prepare(`SELECT id, work_order_id, schedule_locked, crew_id FROM wo_days WHERE id=? AND company_id=? LIMIT 1`)
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

  sets.push("updated_at=datetime('now')");
  await db
    .prepare(`UPDATE wo_days SET ${sets.join(', ')} WHERE id=? AND company_id=?`)
    .bind(...binds, dayId, companyId)
    .run();

  // Dropping a job into a different crew lane has to move the people too,
  // otherwise the card appears under the new crew while its planned labor stays
  // attributed to the old one. Scoped to this day, so one day of a multi-day job
  // can change crew without disturbing the others.
  if (crewChanged) await syncDayEmployees(db, companyId, day.work_order_id, dayId);

  // Keep the work order's own scheduling columns in step for the primary day,
  // so screens still reading work_orders directly do not go stale.
  //
  // budget_minutes is deliberately absent from this UPDATE and from every other
  // write in this router. Scheduling changes when a job happens and who is on
  // it — never what we sold.
  const isPrimary = await db
    .prepare(`SELECT is_primary FROM wo_days WHERE id=? AND company_id=?`)
    .bind(dayId, companyId)
    .first<{ is_primary: number }>();
  if (int(isPrimary?.is_primary, 0) === 1) {
    const fresh = await db
      .prepare(
        `SELECT day_date, start_time, end_time, scheduled_duration_minutes, crew_id
           FROM wo_days WHERE id=? AND company_id=?`,
      )
      .bind(dayId, companyId)
      .first<any>();
    await db
      .prepare(
        `UPDATE work_orders
            SET scheduled_date=?, scheduled_time=?, scheduled_end_time=?,
                scheduled_duration_minutes=?, crew_id=?, updated_at=datetime('now')
          WHERE id=? AND company_id=?`,
      )
      .bind(
        fresh.day_date,
        fresh.start_time,
        fresh.end_time,
        fresh.scheduled_duration_minutes,
        s(fresh.crew_id || '') || null,
        day.work_order_id,
        companyId,
      )
      .run();
  }

  return c.json({ ok: true, day_id: dayId, work_order_id: day.work_order_id });
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
schedulingRouter.get('/work-orders/:id/hours', async (c) => {
  const db = c.env.DB;
  const companyId = c.var.companyId;
  const workOrderId = c.req.param('id');

  const wo = await db
    .prepare(
      `SELECT id, wo_number, title, budget_minutes, duration_hours
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
  });
});
