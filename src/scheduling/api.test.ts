/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { schedulingRouter, ensurePrimaryDay, hidesMoney } from './api';

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
