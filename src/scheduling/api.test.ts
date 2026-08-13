/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import {
  schedulingRouter, ensurePrimaryDay, hidesMoney, syncDayEmployees, syncPrimaryDayFromWorkOrder,
} from './api';

const db = () => env.DB;
const CO = 'co-sched';
const CREW = 'crew-sched';
const EMPTY_CREW = 'crew-empty';
const REP_A = 'rep-sched-a';
const REP_B = 'rep-sched-b';
const WO_SCHED = 'wo-sched-1';
const WO_BACKLOG = 'wo-sched-2';
const MONDAY = '2026-08-17'; // a Monday

/**
 * requireAuth is applied at the mount point in src/index.tsx, not inside the
 * router, so tests supply the same context vars a real request would carry.
 */
function appAs(role: string) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('companyId' as never, CO as never);
    c.set('repId' as never, REP_A as never);
    c.set('role' as never, role as never);
    c.set('isSuperAdmin' as never, false as never);
    await next();
  });
  app.route('/', schedulingRouter);
  return app;
}

const req = (path: string, init?: RequestInit, role = 'admin') =>
  appAs(role).request(path, init, { DB: db() } as never);

const json = async (res: Response) => (await res.json()) as any;

async function seedRep(id: string, name: string, role = 'laborer') {
  await db()
    .prepare(`INSERT INTO reps (id, company_id, name, role, pin) VALUES (?,?,?,?,?)`)
    .bind(id, CO, name, role, '0000')
    .run();
}

beforeEach(async () => {
  for (const t of [
    'wo_day_employees', 'wo_days', 'time_entries', 'work_orders',
    'crew_members', 'crews', 'reps', 'workday_settings', 'estimates',
  ]) {
    await db().prepare(`DELETE FROM ${t} WHERE company_id=?`).bind(CO).run();
  }

  await db()
    .prepare(
      `INSERT INTO workday_settings (id, company_id, working_days, shift_start, shift_end, productive_minutes_per_day)
       VALUES (?,?,?,?,?,?)`,
    )
    .bind(`ws-${CO}`, CO, '1,2,3,4,5', '07:00', '17:00', 450)
    .run();

  await seedRep(REP_A, 'Alex Foreman', 'foreman');
  await seedRep(REP_B, 'Blake Laborer', 'laborer');

  await db()
    .prepare(`INSERT INTO crews (id, company_id, name, color, active) VALUES (?,?,?,?,1), (?,?,?,?,1)`)
    .bind(CREW, CO, 'Blue Crew', '#3b82f6', EMPTY_CREW, CO, 'Empty Crew', '#ef4444')
    .run();

  // Two people on the Blue Crew, nobody on the Empty Crew.
  await db()
    .prepare(
      `INSERT INTO crew_members (id, crew_id, rep_id, company_id, crew_role)
       VALUES (?,?,?,?,?), (?,?,?,?,?)`,
    )
    .bind(`cm-1`, CREW, REP_A, CO, 'foreman', `cm-2`, CREW, REP_B, CO, 'laborer')
    .run();

  // A scheduled job, and a backlog job with no date.
  await db()
    .prepare(
      `INSERT INTO work_orders
         (id, company_id, wo_number, title, client_name, type, status, crew_id,
          scheduled_date, scheduled_time, scheduled_duration_minutes,
          budget_minutes, amount_est_cents)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      WO_SCHED, CO, 'WO-00001', 'Mulch install', 'Acme HOA', 'Install', 'scheduled', CREW,
      MONDAY, '08:00', 240, 720, 250000,
    )
    .run();
  await db()
    .prepare(
      `INSERT INTO work_orders (id, company_id, wo_number, title, client_name, type, status, amount_est_cents)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .bind(WO_BACKLOG, CO, 'WO-00002', 'Spring cleanup', 'Beta LLC', 'Service', 'scheduled', 180000)
    .run();

  await ensurePrimaryDay(db(), CO, WO_SCHED);
});

const primaryDayId = async (workOrderId: string) => {
  const row = await db()
    .prepare(`SELECT id FROM wo_days WHERE work_order_id=? ORDER BY day_number LIMIT 1`)
    .bind(workOrderId)
    .first<{ id: string }>();
  return row?.id ?? '';
};

const budgetOf = async (workOrderId: string) => {
  const row = await db()
    .prepare(`SELECT budget_minutes FROM work_orders WHERE id=?`)
    .bind(workOrderId)
    .first<{ budget_minutes: number | null }>();
  return row?.budget_minutes ?? null;
};

// ── ensurePrimaryDay ─────────────────────────────────────────────────────────

describe('ensurePrimaryDay', () => {
  it('creates a day row for a scheduled work order', async () => {
    const id = await primaryDayId(WO_SCHED);
    expect(id).toBeTruthy();
    const row = await db().prepare(`SELECT * FROM wo_days WHERE id=?`).bind(id).first<any>();
    expect(row.day_date).toBe(MONDAY);
    expect(row.start_time).toBe('08:00');
    expect(row.scheduled_duration_minutes).toBe(240);
    expect(row.is_primary).toBe(1);
  });

  it('does not create a row for a job with no date', async () => {
    const created = await ensurePrimaryDay(db(), CO, WO_BACKLOG);
    expect(created).toBeNull();
    expect(await primaryDayId(WO_BACKLOG)).toBe('');
  });

  it('is idempotent — calling it twice does not double-insert', async () => {
    await ensurePrimaryDay(db(), CO, WO_SCHED);
    await ensurePrimaryDay(db(), CO, WO_SCHED);
    const r = await db()
      .prepare(`SELECT COUNT(*) AS n FROM wo_days WHERE work_order_id=?`)
      .bind(WO_SCHED)
      .first<{ n: number }>();
    expect(r?.n).toBe(1);
  });

  it('will not touch a work order belonging to another company', async () => {
    expect(await ensurePrimaryDay(db(), 'someone-else', WO_SCHED)).toBeNull();
  });
});

// ── syncPrimaryDayFromWorkOrder ──────────────────────────────────────────────

describe('syncPrimaryDayFromWorkOrder', () => {
  it('moves the day row when the work order is rescheduled', async () => {
    // Simulates the pre-existing /api/work-orders/:id/reschedule path the board
    // uses for drag and drop, which writes work_orders and nothing else.
    await db()
      .prepare(`UPDATE work_orders SET scheduled_date=?, scheduled_time=? WHERE id=?`)
      .bind('2026-08-20', '13:00', WO_SCHED)
      .run();
    await syncPrimaryDayFromWorkOrder(db(), CO, WO_SCHED);

    const day = await db()
      .prepare(`SELECT day_date, start_time FROM wo_days WHERE work_order_id=?`)
      .bind(WO_SCHED)
      .first<any>();
    expect(day.day_date).toBe('2026-08-20');
    expect(day.start_time).toBe('13:00');
  });

  it('stops capacity being attributed to the day the job came from', async () => {
    await putOnJob(WO_SCHED, [REP_A, REP_B]);
    await syncDayEmployees(db(), CO, WO_SCHED);

    // Monday, before the move: both people are booked.
    let body = await json(await req(`/week?start=${MONDAY}`));
    let crew = body.crews.find((c: any) => c.id === CREW);
    expect(crew.days.find((d: any) => d.date === MONDAY).planned_minutes).toBe(480);

    // The job is dragged to Wednesday through the work_orders path.
    await db()
      .prepare(`UPDATE work_orders SET scheduled_date=? WHERE id=?`)
      .bind('2026-08-19', WO_SCHED)
      .run();
    await syncPrimaryDayFromWorkOrder(db(), CO, WO_SCHED);

    body = await json(await req(`/week?start=${MONDAY}`));
    crew = body.crews.find((c: any) => c.id === CREW);
    // Monday is free again and Wednesday carries the labor. Without the sync
    // both figures stay on Monday while the grid shows the job on Wednesday.
    expect(crew.days.find((d: any) => d.date === MONDAY).planned_minutes).toBe(0);
    expect(crew.days.find((d: any) => d.date === '2026-08-19').planned_minutes).toBe(480);
  });

  it('creates the day row when a backlog job is scheduled for the first time', async () => {
    await db()
      .prepare(`UPDATE work_orders SET scheduled_date=? WHERE id=?`)
      .bind(MONDAY, WO_BACKLOG)
      .run();
    await syncPrimaryDayFromWorkOrder(db(), CO, WO_BACKLOG);
    expect(await primaryDayId(WO_BACKLOG)).toBeTruthy();
  });

  it('leaves hand-authored multi-day rows alone', async () => {
    await db()
      .prepare(
        `INSERT INTO wo_days (id, company_id, work_order_id, day_number, day_date, questions, is_primary)
         VALUES (?,?,?,?,?,'[]',0)`,
      )
      .bind('wod-phase-2', CO, WO_SCHED, 2, '2026-08-21')
      .run();
    await db()
      .prepare(`UPDATE work_orders SET scheduled_date=? WHERE id=?`)
      .bind('2026-08-18', WO_SCHED)
      .run();
    await syncPrimaryDayFromWorkOrder(db(), CO, WO_SCHED);

    const phase2 = await db()
      .prepare(`SELECT day_date FROM wo_days WHERE id=?`)
      .bind('wod-phase-2')
      .first<any>();
    // work_orders carries one date and cannot describe a multi-day job; those
    // rows move through the multi-day endpoints instead.
    expect(phase2.day_date).toBe('2026-08-21');
  });
});

// ── syncDayEmployees ─────────────────────────────────────────────────────────

const putOnJob = async (workOrderId: string, repIds: string[]) => {
  await db().prepare(`DELETE FROM work_order_employees WHERE wo_id=?`).bind(workOrderId).run();
  for (const r of repIds) {
    await db()
      .prepare(`INSERT INTO work_order_employees (id, wo_id, rep_id, company_id) VALUES (?,?,?,?)`)
      .bind(`woe-${workOrderId}-${r}`, workOrderId, r, CO)
      .run();
  }
};

const dayAssignments = async (workOrderId: string) => {
  const r = await db()
    .prepare(
      `SELECT e.rep_id, e.planned_minutes, e.crew_role
         FROM wo_day_employees e JOIN wo_days d ON d.id = e.wo_day_id
        WHERE d.work_order_id=? ORDER BY e.rep_id`,
    )
    .bind(workOrderId)
    .all<any>();
  return r.results || [];
};

describe('syncDayEmployees', () => {
  it('gives each person on the job a day row defaulting to the day duration', async () => {
    await putOnJob(WO_SCHED, [REP_A, REP_B]);
    await syncDayEmployees(db(), CO, WO_SCHED);
    const rows = await dayAssignments(WO_SCHED);
    expect(rows).toHaveLength(2);
    // The day is 240 calendar minutes, so two people is 480 people-minutes.
    expect(rows.every((r: any) => r.planned_minutes === 240)).toBe(true);
  });

  it('carries the crew role across so the grid can colour by it', async () => {
    await putOnJob(WO_SCHED, [REP_A]);
    await syncDayEmployees(db(), CO, WO_SCHED);
    const rows = await dayAssignments(WO_SCHED);
    expect(rows[0].crew_role).toBe('foreman');
  });

  it('removes people taken off the job, when the day has no crew of its own', async () => {
    // The job employee list governs staffing only for a day with no crew.
    // Once a day carries a crew, that crew's roster is what staffs it — which is
    // what makes dragging a job into another crew lane move the labor with it.
    await db()
      .prepare(`UPDATE wo_days SET crew_id='' WHERE work_order_id=?`)
      .bind(WO_SCHED)
      .run();
    await putOnJob(WO_SCHED, [REP_A, REP_B]);
    await syncDayEmployees(db(), CO, WO_SCHED);
    await putOnJob(WO_SCHED, [REP_A]);
    await syncDayEmployees(db(), CO, WO_SCHED);
    const rows = await dayAssignments(WO_SCHED);
    expect(rows.map((r: any) => r.rep_id)).toEqual([REP_A]);
  });

  it('staffs from the day crew rather than the job list once a crew is set', async () => {
    // Deliberate behaviour change: the day's crew wins. Previously the job's
    // employee list drove every day regardless of which crew was on it, so
    // moving a job between crews left the labor behind.
    await putOnJob(WO_SCHED, [REP_A]);
    await syncDayEmployees(db(), CO, WO_SCHED);
    const rows = await dayAssignments(WO_SCHED);
    // Blue Crew is REP_A + REP_B, so both are staffed even though only REP_A is
    // on the job's employee list.
    expect(rows.map((r: any) => r.rep_id)).toEqual([REP_A, REP_B]);
  });

  it('does NOT clobber minutes tuned by hand', async () => {
    await putOnJob(WO_SCHED, [REP_A]);
    await syncDayEmployees(db(), CO, WO_SCHED);
    const dayId = await primaryDayId(WO_SCHED);
    // Someone shortens this person's day through the assign endpoint...
    await req(`/days/${dayId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ rep_id: REP_A, planned_minutes: 90 }),
    });
    // ...then a second person is added to the job, re-running the sync.
    await putOnJob(WO_SCHED, [REP_A, REP_B]);
    await syncDayEmployees(db(), CO, WO_SCHED);
    const rows = await dayAssignments(WO_SCHED);
    const a = rows.find((r: any) => r.rep_id === REP_A);
    const b = rows.find((r: any) => r.rep_id === REP_B);
    expect(a.planned_minutes).toBe(90); // preserved
    expect(b.planned_minutes).toBe(240); // new person gets the default
  });

  it('is a no-op for a job with no day rows', async () => {
    await putOnJob(WO_BACKLOG, [REP_A]);
    const written = await syncDayEmployees(db(), CO, WO_BACKLOG);
    expect(written).toBe(0);
    expect(await dayAssignments(WO_BACKLOG)).toHaveLength(0);
  });

  it('makes crew capacity reflect the assignment', async () => {
    await putOnJob(WO_SCHED, [REP_A, REP_B]);
    await syncDayEmployees(db(), CO, WO_SCHED);
    const body = await json(await req(`/week?start=${MONDAY}`));
    const crew = body.crews.find((c: any) => c.id === CREW);
    // Two people x 240 minutes = 480 people-minutes against 4500 capacity.
    expect(crew.week_planned_minutes).toBe(480);
    expect(crew.week_utilization_pct).toBe(11);
  });
});

// ── GET /week ────────────────────────────────────────────────────────────────

describe('GET /week', () => {
  it('returns one payload carrying days, crews, assignments and capacity', async () => {
    const body = await json(await req(`/week?start=${MONDAY}`));
    expect(body.ok).toBe(true);
    expect(body.days).toHaveLength(7);
    expect(body.days[0]).toBe(MONDAY);
    expect(body.crews.length).toBe(2);
    expect(body.assignments.length).toBe(1);
    expect(body.working_hours.productive_minutes_per_day).toBe(450);
  });

  it('computes capacity from crew size, not a hardcoded 40 hours', async () => {
    const body = await json(await req(`/week?start=${MONDAY}`));
    const crew = body.crews.find((c: any) => c.id === CREW);
    // 2 people x 450 productive minutes = 900/day, x5 working days = 4500.
    expect(crew.member_count).toBe(2);
    expect(crew.daily_capacity_minutes).toBe(900);
    expect(crew.week_capacity_minutes).toBe(4500);
    // The Week view's hardcoded assumption is 40h = 2400 minutes.
    expect(crew.week_capacity_minutes).not.toBe(2400);
  });

  it('reports null utilisation for a crew with nobody on it, not 0%', async () => {
    const body = await json(await req(`/week?start=${MONDAY}`));
    const empty = body.crews.find((c: any) => c.id === EMPTY_CREW);
    expect(empty.member_count).toBe(0);
    expect(empty.daily_capacity_minutes).toBe(0);
    expect(empty.week_utilization_pct).toBeNull();
  });

  it('gives weekend days no capacity', async () => {
    const body = await json(await req(`/week?start=${MONDAY}`));
    const crew = body.crews.find((c: any) => c.id === CREW);
    const saturday = crew.days.find((d: any) => d.date === '2026-08-22');
    expect(saturday.is_working_day).toBe(false);
    expect(saturday.capacity_minutes).toBe(0);
    expect(saturday.utilization_pct).toBeNull();
  });

  it('keeps calendar duration and budgeted hours as separate numbers', async () => {
    const body = await json(await req(`/week?start=${MONDAY}`));
    const a = body.assignments[0];
    expect(a.duration_minutes).toBe(240); // blocks 4h on the grid
    expect(a.budget_minutes).toBe(720); // but 12 labor hours were sold
  });

  it('filters to one crew when asked', async () => {
    const body = await json(await req(`/week?start=${MONDAY}&crew_id=${EMPTY_CREW}`));
    expect(body.crews).toHaveLength(1);
    expect(body.assignments).toHaveLength(0);
  });

  it('rolls planned minutes up per crew per day', async () => {
    const dayId = await primaryDayId(WO_SCHED);
    await req(`/days/${dayId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ rep_id: REP_A, planned_minutes: 240 }),
    });
    await req(`/days/${dayId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ rep_id: REP_B, planned_minutes: 180 }),
    });
    const body = await json(await req(`/week?start=${MONDAY}`));
    const crew = body.crews.find((c: any) => c.id === CREW);
    const monday = crew.days.find((d: any) => d.date === MONDAY);
    expect(monday.planned_minutes).toBe(420);
    // 420 of 900 available.
    expect(monday.utilization_pct).toBe(47);
  });
});

// ── money visibility ─────────────────────────────────────────────────────────

describe('job value is stripped server-side for field roles', () => {
  it('classifies the field roles', () => {
    for (const r of ['foreman', 'laborer', 'mechanic', 'field_supervisor']) {
      expect(hidesMoney(r)).toBe(true);
    }
    for (const r of ['admin', 'office_manager', 'division_manager', 'rep']) {
      expect(hidesMoney(r)).toBe(false);
    }
  });

  it('omits value_cents from /week for a foreman but includes it for an admin', async () => {
    const asAdmin = await json(await req(`/week?start=${MONDAY}`, undefined, 'admin'));
    expect(asAdmin.money_visible).toBe(true);
    expect(asAdmin.assignments[0].value_cents).toBe(250000);

    const asForeman = await json(await req(`/week?start=${MONDAY}`, undefined, 'foreman'));
    expect(asForeman.money_visible).toBe(false);
    expect(asForeman.assignments[0]).not.toHaveProperty('value_cents');
    // The number must be absent from the payload, not merely hidden — a field
    // user can read the response.
    expect(JSON.stringify(asForeman)).not.toContain('250000');
  });

  it('omits value_cents from /backlog for a laborer', async () => {
    const asAdmin = await json(await req('/backlog', undefined, 'admin'));
    expect(JSON.stringify(asAdmin)).toContain('180000');

    const asLaborer = await json(await req('/backlog', undefined, 'laborer'));
    expect(asLaborer.money_visible).toBe(false);
    expect(JSON.stringify(asLaborer)).not.toContain('180000');
  });

  it('still shows budgeted and planned minutes to field roles', async () => {
    // Hours are the crew's own work. It is money they must not see.
    const asForeman = await json(await req(`/week?start=${MONDAY}`, undefined, 'foreman'));
    expect(asForeman.assignments[0].budget_minutes).toBe(720);
    expect(asForeman.assignments[0].duration_minutes).toBe(240);
  });
});

// ── budget_minutes is never written by scheduling ────────────────────────────

describe('nothing in the scheduling path writes work_orders.budget_minutes', () => {
  it('leaves it untouched when a day is rescheduled', async () => {
    const dayId = await primaryDayId(WO_SCHED);
    expect(await budgetOf(WO_SCHED)).toBe(720);
    const res = await req(`/days/${dayId}/schedule`, {
      method: 'POST',
      body: JSON.stringify({ date: '2026-08-19', start_time: '09:00', duration_minutes: 300 }),
    });
    expect(res.status).toBe(200);
    // The calendar moved and the block resized...
    const row = await db().prepare(`SELECT * FROM wo_days WHERE id=?`).bind(dayId).first<any>();
    expect(row.day_date).toBe('2026-08-19');
    expect(row.scheduled_duration_minutes).toBe(300);
    // ...but what we sold did not change.
    expect(await budgetOf(WO_SCHED)).toBe(720);
  });

  it('leaves it untouched when people are assigned and removed', async () => {
    const dayId = await primaryDayId(WO_SCHED);
    await req(`/days/${dayId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ rep_id: REP_A, planned_minutes: 600 }),
    });
    expect(await budgetOf(WO_SCHED)).toBe(720);
    await req(`/days/${dayId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ rep_id: REP_A, remove: true }),
    });
    expect(await budgetOf(WO_SCHED)).toBe(720);
  });

  it('leaves it untouched when a job is returned to the backlog', async () => {
    const dayId = await primaryDayId(WO_SCHED);
    await req(`/days/${dayId}/schedule`, { method: 'DELETE' });
    expect(await budgetOf(WO_SCHED)).toBe(720);
  });

  it('leaves it untouched when a backlog job is scheduled', async () => {
    await db()
      .prepare(`UPDATE work_orders SET budget_minutes=? WHERE id=?`)
      .bind(480, WO_BACKLOG)
      .run();
    await req(`/work-orders/${WO_BACKLOG}/schedule`, {
      method: 'POST',
      body: JSON.stringify({ date: MONDAY, start_time: '13:00', duration_minutes: 120 }),
    });
    expect(await budgetOf(WO_BACKLOG)).toBe(480);
  });
});

// ── assignment ───────────────────────────────────────────────────────────────

describe('POST /days/:id/assign', () => {
  it('updates rather than stacking a second row for the same person', async () => {
    const dayId = await primaryDayId(WO_SCHED);
    await req(`/days/${dayId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ rep_id: REP_A, planned_minutes: 240 }),
    });
    await req(`/days/${dayId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ rep_id: REP_A, planned_minutes: 480 }),
    });
    const rows = await db()
      .prepare(`SELECT planned_minutes FROM wo_day_employees WHERE wo_day_id=? AND rep_id=?`)
      .bind(dayId, REP_A)
      .all<{ planned_minutes: number }>();
    // A second row here would silently double this person's capacity.
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].planned_minutes).toBe(480);
  });

  it('removes an assignment', async () => {
    const dayId = await primaryDayId(WO_SCHED);
    await req(`/days/${dayId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ rep_id: REP_B, planned_minutes: 120 }),
    });
    await req(`/days/${dayId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ rep_id: REP_B, remove: true }),
    });
    const r = await db()
      .prepare(`SELECT COUNT(*) AS n FROM wo_day_employees WHERE wo_day_id=?`)
      .bind(dayId)
      .first<{ n: number }>();
    expect(r?.n).toBe(0);
  });

  it('rejects an out-of-range duration', async () => {
    const dayId = await primaryDayId(WO_SCHED);
    const res = await req(`/days/${dayId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ rep_id: REP_A, planned_minutes: 2000 }),
    });
    expect(res.status).toBe(400);
  });

  it('404s for a day in another company', async () => {
    const res = await req('/days/does-not-exist/assign', {
      method: 'POST',
      body: JSON.stringify({ rep_id: REP_A, planned_minutes: 60 }),
    });
    expect(res.status).toBe(404);
  });
});

// ── backlog ──────────────────────────────────────────────────────────────────

describe('GET /backlog', () => {
  it('buckets a dateless job under needs_scheduling', async () => {
    const body = await json(await req('/backlog'));
    const ids = body.needs_scheduling.map((c: any) => c.work_order_id);
    expect(ids).toContain(WO_BACKLOG);
  });

  it('buckets a dated job with no crew under needs_crew', async () => {
    // crew_id carries a FK to crews, so "no crew" is NULL — an empty string is
    // rejected outright. The backlog query COALESCEs so it catches both.
    await db()
      .prepare(`UPDATE work_orders SET scheduled_date=?, crew_id=NULL WHERE id=?`)
      .bind(MONDAY, WO_BACKLOG)
      .run();
    const body = await json(await req('/backlog'));
    expect(body.needs_crew.map((c: any) => c.work_order_id)).toContain(WO_BACKLOG);
  });

  it('buckets a held job under tentative', async () => {
    await db().prepare(`UPDATE work_orders SET status='hold' WHERE id=?`).bind(WO_BACKLOG).run();
    const body = await json(await req('/backlog'));
    expect(body.tentative.map((c: any) => c.work_order_id)).toContain(WO_BACKLOG);
  });
});

// ── hours ────────────────────────────────────────────────────────────────────

describe('GET /work-orders/:id/hours', () => {
  it('sums actual minutes NET of breaks', async () => {
    await db()
      .prepare(
        `INSERT INTO time_entries (id, rep_id, company_id, work_order_id, clock_in, clock_out, duration_min, break_minutes)
         VALUES (?,?,?,?,?,?,?,?), (?,?,?,?,?,?,?,?)`,
      )
      .bind(
        'te-1', REP_A, CO, WO_SCHED, '2026-08-17T08:00:00Z', '2026-08-17T16:00:00Z', 480, 30,
        'te-2', REP_B, CO, WO_SCHED, '2026-08-17T08:00:00Z', '2026-08-17T12:00:00Z', 240, 15,
      )
      .run();

    const body = await json(await req(`/work-orders/${WO_SCHED}/hours`));
    // duration_min is gross; break_minutes accumulates separately and is never
    // subtracted anywhere in the CRM.
    expect(body.actual_minutes_gross).toBe(720);
    expect(body.break_minutes).toBe(45);
    expect(body.actual_minutes).toBe(675);
  });

  it('reports variance against the sold figure', async () => {
    await db()
      .prepare(
        `INSERT INTO time_entries (id, rep_id, company_id, work_order_id, clock_in, clock_out, duration_min, break_minutes)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .bind('te-3', REP_A, CO, WO_SCHED, '2026-08-17T08:00:00Z', '2026-08-17T21:00:00Z', 780, 0)
      .run();
    const body = await json(await req(`/work-orders/${WO_SCHED}/hours`));
    expect(body.budget_minutes).toBe(720);
    expect(body.variance_minutes).toBe(60);
    expect(body.over_budget).toBe(true);
  });

  it('returns a null variance when the job carries no budget', async () => {
    const body = await json(await req(`/work-orders/${WO_BACKLOG}/hours`));
    // No estimate rollup means nothing to compare against — which is not the
    // same as landing exactly on target.
    expect(body.budget_minutes).toBeNull();
    expect(body.variance_minutes).toBeNull();
    expect(body.over_budget).toBe(false);
  });

  it('ignores entries that are still clocked in', async () => {
    await db()
      .prepare(
        `INSERT INTO time_entries (id, rep_id, company_id, work_order_id, clock_in, duration_min)
         VALUES (?,?,?,?,?,?)`,
      )
      .bind('te-open', REP_A, CO, WO_SCHED, '2026-08-17T08:00:00Z', 0)
      .run();
    const body = await json(await req(`/work-orders/${WO_SCHED}/hours`));
    expect(body.actual_minutes).toBe(0);
  });
});

// ── returning to the backlog ─────────────────────────────────────────────────

describe('DELETE /days/:id/schedule', () => {
  it('clears the date on both the day and the work order but keeps the row', async () => {
    const dayId = await primaryDayId(WO_SCHED);
    const res = await req(`/days/${dayId}/schedule`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    const day = await db().prepare(`SELECT * FROM wo_days WHERE id=?`).bind(dayId).first<any>();
    expect(day).toBeTruthy();
    expect(day.day_date).toBe('');

    const wo = await db()
      .prepare(`SELECT scheduled_date FROM work_orders WHERE id=?`)
      .bind(WO_SCHED)
      .first<any>();
    expect(wo.scheduled_date).toBeNull();
  });

  it('keeps the people assigned so re-scheduling does not lose them', async () => {
    const dayId = await primaryDayId(WO_SCHED);
    await req(`/days/${dayId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ rep_id: REP_A, planned_minutes: 240 }),
    });
    await req(`/days/${dayId}/schedule`, { method: 'DELETE' });
    const r = await db()
      .prepare(`SELECT COUNT(*) AS n FROM wo_day_employees WHERE wo_day_id=?`)
      .bind(dayId)
      .first<{ n: number }>();
    expect(r?.n).toBe(1);
  });
});

// ── crew reassignment moves the people, not just the card ────────────────────

describe('moving a job to another crew restaffs it', () => {
  const rosterOf = async (dayId: string) => {
    const r = await db()
      .prepare(`SELECT rep_id, source, planned_minutes FROM wo_day_employees WHERE wo_day_id=? ORDER BY rep_id`)
      .bind(dayId)
      .all<any>();
    return r.results || [];
  };

  it('replaces the old crew roster with the new one', async () => {
    // Blue Crew is REP_A + REP_B; put a third person on their own crew.
    await seedRep('rep-solo', 'Casey Solo', 'foreman');
    await db()
      .prepare(`INSERT INTO crew_members (id, crew_id, rep_id, company_id, crew_role) VALUES (?,?,?,?,?)`)
      .bind('cm-solo', EMPTY_CREW, 'rep-solo', CO, 'foreman')
      .run();

    const dayId = await primaryDayId(WO_SCHED);
    await syncDayEmployees(db(), CO, WO_SCHED);
    expect((await rosterOf(dayId)).map((r: any) => r.rep_id)).toEqual([REP_A, REP_B]);

    // Drag it into the other crew's lane.
    const res = await req(`/days/${dayId}/schedule`, {
      method: 'POST',
      body: JSON.stringify({ crew_id: EMPTY_CREW }),
    });
    expect(res.status).toBe(200);

    // The people came with it — the old crew no longer carries this labor.
    expect((await rosterOf(dayId)).map((r: any) => r.rep_id)).toEqual(['rep-solo']);
  });

  it('moves the planned labor to the new crew in the week payload', async () => {
    await seedRep('rep-solo2', 'Dana Solo', 'foreman');
    await db()
      .prepare(`INSERT INTO crew_members (id, crew_id, rep_id, company_id, crew_role) VALUES (?,?,?,?,?)`)
      .bind('cm-solo2', EMPTY_CREW, 'rep-solo2', CO, 'foreman')
      .run();
    const dayId = await primaryDayId(WO_SCHED);
    await syncDayEmployees(db(), CO, WO_SCHED);

    let body = await json(await req(`/week?start=${MONDAY}`));
    expect(body.crews.find((c: any) => c.id === CREW).week_planned_minutes).toBe(480);
    expect(body.crews.find((c: any) => c.id === EMPTY_CREW).week_planned_minutes).toBe(0);

    await req(`/days/${dayId}/schedule`, { method: 'POST', body: JSON.stringify({ crew_id: EMPTY_CREW }) });

    body = await json(await req(`/week?start=${MONDAY}`));
    // Old crew is free again; the new crew carries it.
    expect(body.crews.find((c: any) => c.id === CREW).week_planned_minutes).toBe(0);
    expect(body.crews.find((c: any) => c.id === EMPTY_CREW).week_planned_minutes).toBe(240);
  });

  it('keeps a deliberately added person through a crew change', async () => {
    const dayId = await primaryDayId(WO_SCHED);
    await syncDayEmployees(db(), CO, WO_SCHED);
    // Someone on NEITHER crew, put on this day deliberately. A person who is on
    // the day's own crew stays 'roster' — tuning their minutes should not pin
    // them through a crew change.
    await seedRep('rep-outsider', '外 Outsider', 'laborer');
    await req(`/days/${dayId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ rep_id: 'rep-outsider', planned_minutes: 120 }),
    });
    await seedRep('rep-solo3', 'Eli Solo', 'foreman');
    await db()
      .prepare(`INSERT INTO crew_members (id, crew_id, rep_id, company_id, crew_role) VALUES (?,?,?,?,?)`)
      .bind('cm-solo3', EMPTY_CREW, 'rep-solo3', CO, 'foreman')
      .run();

    await req(`/days/${dayId}/schedule`, { method: 'POST', body: JSON.stringify({ crew_id: EMPTY_CREW }) });

    const roster = await rosterOf(dayId);
    const ids = roster.map((r: any) => r.rep_id).sort();
    // The new crew's person arrives; the deliberate addition survives; the old
    // crew's roster-derived people are gone.
    expect(ids).toContain('rep-solo3');
    expect(ids).toContain('rep-outsider');
    expect(ids).not.toContain(REP_A);
    expect(roster.find((r: any) => r.rep_id === 'rep-outsider').planned_minutes).toBe(120);
    expect(roster.find((r: any) => r.rep_id === 'rep-outsider').source).toBe('manual');
  });

  it('staffs each day of a multi-day job from its own crew', async () => {
    await seedRep('rep-solo4', 'Fran Solo', 'foreman');
    await db()
      .prepare(`INSERT INTO crew_members (id, crew_id, rep_id, company_id, crew_role) VALUES (?,?,?,?,?)`)
      .bind('cm-solo4', EMPTY_CREW, 'rep-solo4', CO, 'foreman')
      .run();
    // Day 2 runs with the other crew.
    await db()
      .prepare(
        `INSERT INTO wo_days (id, company_id, work_order_id, day_number, day_date, questions, crew_id, scheduled_duration_minutes, is_primary)
         VALUES (?,?,?,?,?,'[]',?,?,0)`,
      )
      .bind('wod-day2', CO, WO_SCHED, 2, '2026-08-18', EMPTY_CREW, 240)
      .run();

    await syncDayEmployees(db(), CO, WO_SCHED);

    const day1 = await primaryDayId(WO_SCHED);
    // Each day is staffed from its OWN crew, not the job's employee list.
    expect((await rosterOf(day1)).map((r: any) => r.rep_id)).toEqual([REP_A, REP_B]);
    expect((await rosterOf('wod-day2')).map((r: any) => r.rep_id)).toEqual(['rep-solo4']);
  });

  it('restaffs only the day that moved, leaving other phases alone', async () => {
    await db()
      .prepare(
        `INSERT INTO wo_days (id, company_id, work_order_id, day_number, day_date, questions, crew_id, scheduled_duration_minutes, is_primary)
         VALUES (?,?,?,?,?,'[]',?,?,0)`,
      )
      .bind('wod-day3', CO, WO_SCHED, 2, '2026-08-18', CREW, 240)
      .run();
    await seedRep('rep-solo5', 'Gus Solo', 'foreman');
    await db()
      .prepare(`INSERT INTO crew_members (id, crew_id, rep_id, company_id, crew_role) VALUES (?,?,?,?,?)`)
      .bind('cm-solo5', EMPTY_CREW, 'rep-solo5', CO, 'foreman')
      .run();
    await syncDayEmployees(db(), CO, WO_SCHED);

    await req(`/days/wod-day3/schedule`, { method: 'POST', body: JSON.stringify({ crew_id: EMPTY_CREW }) });

    const day1 = await primaryDayId(WO_SCHED);
    expect((await rosterOf(day1)).map((r: any) => r.rep_id)).toEqual([REP_A, REP_B]);
    expect((await rosterOf('wod-day3')).map((r: any) => r.rep_id)).toEqual(['rep-solo5']);
  });
});
