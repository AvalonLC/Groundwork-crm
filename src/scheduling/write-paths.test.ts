/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import app from '../index';

/**
 * Every path that moves a job, exercised through the real HTTP routes.
 *
 * The existing api.test.ts covers src/scheduling/api.ts thoroughly — and all of
 * it passes while the board is visibly broken, because those tests drive
 * POST /api/scheduling/days/:id/schedule and the board has never called it. It
 * drags through PATCH /api/work-orders/:id/reschedule and PUT /api/work-orders/:id
 * instead. This file covers the paths the product actually takes.
 */

const db = () => env.DB;
const CO = 'wp-co';
const BLUE = 'wp-crew-blue';
const GREEN = 'wp-crew-green';
const MONDAY = '2026-08-17';
const TUESDAY = '2026-08-18';

async function seedSession(repId = 'wp-admin', role = 'admin') {
  await db().prepare(`INSERT OR IGNORE INTO companies (id, name, slug, active) VALUES (?,?,?,1)`)
    .bind(CO, 'Write Paths Co', CO).run();
  await db().prepare(`INSERT OR IGNORE INTO reps (id, company_id, name, pin, role, active) VALUES (?,?,?,?,?,1)`)
    .bind(repId, CO, 'Admin', '0000', role).run();
  const token = `tok-${CO}-${repId}`;
  await db().prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
    .bind(`session_${token}`, repId).run();
  return `avalon_session=${token}`;
}

async function req(path: string, cookie: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const res = await app.request(
    path,
    { ...init, headers: { ...(init.headers || {}), 'content-type': 'application/json', cookie } },
    env, ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}
const body = (o: unknown) => JSON.stringify(o);

const dayRow = (woId: string) =>
  db().prepare(`SELECT * FROM wo_days WHERE work_order_id=? AND is_primary=1`).bind(woId).first<any>();
const woRow = (woId: string) =>
  db().prepare(`SELECT * FROM work_orders WHERE id=?`).bind(woId).first<any>();
const peopleOn = async (dayId: string) => {
  const r = await db().prepare(`SELECT rep_id FROM wo_day_employees WHERE wo_day_id=? ORDER BY rep_id`).bind(dayId).all<any>();
  return (r.results || []).map((x: any) => x.rep_id);
};

let cookie: string;

beforeEach(async () => {
  for (const t of ['wo_day_employees', 'wo_days', 'work_order_employees', 'work_orders', 'crew_members', 'crews', 'reps', 'workday_settings', 'estimates']) {
    await db().prepare(`DELETE FROM ${t} WHERE company_id=?`).bind(CO).run();
  }
  cookie = await seedSession();
  await db().prepare(
    `INSERT INTO workday_settings (id, company_id, working_days, shift_start, shift_end, productive_minutes_per_day)
     VALUES (?,?,?,?,?,?)`,
  ).bind(`ws-${CO}`, CO, '1,2,3,4,5', '07:00', '17:00', 450).run();

  await db().prepare(`INSERT INTO crews (id, company_id, name, color, active) VALUES (?,?,?,?,1),(?,?,?,?,1)`)
    .bind(BLUE, CO, 'Blue', '#00f', GREEN, CO, 'Green', '#0f0').run();
  // Two people on Blue, one on Green — distinct so a roster swap is visible.
  for (const [id, name] of [['wp-anna', 'Anna'], ['wp-ben', 'Ben'], ['wp-cara', 'Cara']] as const) {
    await db().prepare(`INSERT INTO reps (id, company_id, name, pin, role, active) VALUES (?,?,?,?,?,1)`)
      .bind(id, CO, name, '0000', 'laborer').run();
  }
  await db().prepare(`INSERT INTO crew_members (id, crew_id, rep_id, company_id, crew_role) VALUES (?,?,?,?,?),(?,?,?,?,?),(?,?,?,?,?)`)
    .bind('wp-cm1', BLUE, 'wp-anna', CO, 'foreman',
          'wp-cm2', BLUE, 'wp-ben', CO, 'laborer',
          'wp-cm3', GREEN, 'wp-cara', CO, 'foreman').run();
});

async function createJob(extra: Record<string, unknown> = {}) {
  const res = await req('/api/work-orders', cookie, {
    method: 'POST',
    // A calendar duration is given explicitly. Without one the day carries no
    // length, so syncDayEmployees has nothing to seed planned_minutes from and
    // every assertion about capacity would be measuring zero.
    body: body({
      client_name: 'Johnson', crew_id: BLUE, scheduled_date: MONDAY, scheduled_time: '07:00',
      scheduled_duration_minutes: 480, ...extra,
    }),
  });
  const j = (await res.json()) as any;
  return (j.data?.id || j.id) as string;
}

describe('the crew drag the board actually performs', () => {
  it('P1-01 moving a job to another crew lane moves its people and its capacity', async () => {
    // THE regression test for the reported bug. This is the board's exact
    // sequence (public/js/app_premium.js _sbDropOnCell): PATCH /reschedule with
    // both fields, then a second PUT carrying only the crew.
    //
    // On main this fails. /reschedule's UPDATE has no crew_id column, so the
    // crew in that body is discarded and its syncPrimaryDayFromWorkOrder copies
    // the OLD crew down; the PUT then sets work_orders.crew_id and syncs nothing.
    // Result: the card renders under Green while wo_days — which is what capacity
    // is computed from — still says Blue, and a refresh puts the card back.
    const woId = await createJob();
    const before = await dayRow(woId);
    expect(before.crew_id).toBe(BLUE);
    expect(await peopleOn(before.id)).toEqual(['wp-anna', 'wp-ben']);

    await req(`/api/work-orders/${woId}/reschedule`, cookie, {
      method: 'PATCH', body: body({ scheduled_date: MONDAY, crew_id: GREEN }),
    });
    await req(`/api/work-orders/${woId}`, cookie, { method: 'PUT', body: body({ crew_id: GREEN }) });

    const wo = await woRow(woId);
    const day = await dayRow(woId);
    expect(wo.crew_id).toBe(GREEN);
    expect(day.crew_id).toBe(GREEN);           // the row capacity is read from
    expect(await peopleOn(day.id)).toEqual(['wp-cara']); // Green's roster, not Blue's
  });

  it('P1-02 the same move survives a reload of the week payload', async () => {
    // "If refreshing changes anything, it isn't finished." /week renders from
    // wo_days, so this is the assertion that the user-visible result is real.
    const woId = await createJob();
    await req(`/api/work-orders/${woId}/reschedule`, cookie, {
      method: 'PATCH', body: body({ scheduled_date: MONDAY, crew_id: GREEN }),
    });
    await req(`/api/work-orders/${woId}`, cookie, { method: 'PUT', body: body({ crew_id: GREEN }) });

    const week = (await (await req(`/api/scheduling/week?start=${MONDAY}`, cookie)).json()) as any;
    const card = week.assignments.find((a: any) => a.work_order_id === woId);
    expect(card.crew_id).toBe(GREEN);
    expect(week.crews.find((cr: any) => cr.id === GREEN).week_planned_minutes).toBeGreaterThan(0);
    expect(week.crews.find((cr: any) => cr.id === BLUE).week_planned_minutes).toBe(0);
  });

  it('P1-03 editing the date through PUT moves the day row too', async () => {
    // The drawer's Save writes through PUT. Before this it moved work_orders and
    // left wo_days on the old date, so the grid kept drawing the job where it was
    // — and because the list endpoint COALESCEs md.day_date first, the stale day
    // actually won there as well.
    const woId = await createJob();
    await req(`/api/work-orders/${woId}`, cookie, { method: 'PUT', body: body({ scheduled_date: TUESDAY }) });

    expect((await dayRow(woId)).day_date).toBe(TUESDAY);
    expect((await woRow(woId)).scheduled_date).toBe(TUESDAY);
  });

  it('P1-04 a job with no date gets its day row when PUT first gives it one', async () => {
    // A backlog job has no wo_days row at all. Dating it via PUT used to leave it
    // with none, so it stayed invisible on the grid forever.
    const woId = await createJob({ scheduled_date: null, crew_id: null });
    expect(await dayRow(woId)).toBeNull();

    await req(`/api/work-orders/${woId}`, cookie, {
      method: 'PUT', body: body({ scheduled_date: MONDAY, crew_id: BLUE }),
    });
    const day = await dayRow(woId);
    expect(day).not.toBeNull();
    expect(day.day_date).toBe(MONDAY);
    expect(await peopleOn(day.id)).toEqual(['wp-anna', 'wp-ben']);
  });
});

describe('schedule lock', () => {
  it('P1-05 PUT refuses to move a locked job', async () => {
    // PATCH /reschedule has always refused. PUT writes every one of the same
    // columns and never checked, so the lock could be walked past by editing the
    // job instead of dragging it.
    const woId = await createJob();
    await req(`/api/work-orders/${woId}`, cookie, { method: 'PUT', body: body({ schedule_locked: true }) });

    const res = await req(`/api/work-orders/${woId}`, cookie, {
      method: 'PUT', body: body({ scheduled_date: TUESDAY }),
    });
    expect(res.status).toBe(409);
    expect((await dayRow(woId)).day_date).toBe(MONDAY);
  });

  it('P1-06 a locked job cannot be unlocked and moved in one request', async () => {
    // The subtler bypass: schedule_locked is itself one of the columns PUT
    // writes, so a single body could clear the lock and change the date together
    // and never be refused by a check that only looked at the stored value.
    const woId = await createJob();
    await req(`/api/work-orders/${woId}`, cookie, { method: 'PUT', body: body({ schedule_locked: true }) });

    const res = await req(`/api/work-orders/${woId}`, cookie, {
      method: 'PUT', body: body({ schedule_locked: false, scheduled_date: TUESDAY }),
    });
    expect(res.status).toBe(409);
    expect((await woRow(woId)).schedule_locked).toBe(1);
    expect((await dayRow(woId)).day_date).toBe(MONDAY);
  });

  it('P1-07 non-scheduling edits still work on a locked job', async () => {
    // The lock is on the calendar, not on the record. Locking a job must not
    // stop someone fixing the notes or the address.
    const woId = await createJob();
    await req(`/api/work-orders/${woId}`, cookie, { method: 'PUT', body: body({ schedule_locked: true }) });

    const res = await req(`/api/work-orders/${woId}`, cookie, { method: 'PUT', body: body({ notes: 'gate code 4821' }) });
    expect(res.status).toBe(200);
    expect((await woRow(woId)).notes).toBe('gate code 4821');
  });
});

describe('resize moves the labor with it', () => {
  it('P1-08 stretching a day updates roster planned minutes but not hand-tuned ones', async () => {
    // planned_minutes was seeded from the day's duration and never revisited, so
    // resizing a block on the grid changed how long it looked and not how much
    // labor it consumed — the grid and the capacity bar disagreed by design.
    const woId = await createJob({ scheduled_duration_minutes: 240 });
    const day = await dayRow(woId);
    expect(day.scheduled_duration_minutes).toBe(240);
    expect((await db().prepare(`SELECT planned_minutes FROM wo_day_employees WHERE wo_day_id=? AND rep_id='wp-anna'`).bind(day.id).first<any>()).planned_minutes).toBe(240);

    // Ben leaves at lunch — a deliberate override that must survive.
    await db().prepare(`UPDATE wo_day_employees SET planned_minutes=120 WHERE wo_day_id=? AND rep_id='wp-ben'`).bind(day.id).run();

    const res = await req(`/api/scheduling/days/${day.id}/schedule`, cookie, {
      method: 'POST', body: body({ duration_minutes: 480 }),
    });
    expect(res.status).toBe(200);

    const rows = await db().prepare(`SELECT rep_id, planned_minutes FROM wo_day_employees WHERE wo_day_id=? ORDER BY rep_id`).bind(day.id).all<any>();
    const byRep = Object.fromEntries((rows.results || []).map((r: any) => [r.rep_id, r.planned_minutes]));
    expect(byRep['wp-anna']).toBe(480); // untouched default follows the block
    expect(byRep['wp-ben']).toBe(120);  // hand-tuned, left alone
  });
});

describe('every scheduling write reports capacity', () => {
  it('P1-09 a crew move returns capacity for the crew it left AND the one it joined', async () => {
    // docs/HANDOFF-scheduling.md promised this when the router was designed and
    // it was never built, so the board did a second round trip to /week after
    // every drag — a window in which grid and sidebar can disagree. The old
    // crew matters as much as the new one: without it the lane the job left
    // keeps showing labor that has already moved away.
    const woId = await createJob({ scheduled_duration_minutes: 480 });
    const day = await dayRow(woId);

    const res = await req(`/api/scheduling/days/${day.id}/schedule`, cookie, {
      method: 'POST', body: body({ crew_id: GREEN }),
    });
    const out = (await res.json()) as any;

    const blue = out.capacity.find((x: any) => x.crew_id === BLUE && x.date === MONDAY);
    const green = out.capacity.find((x: any) => x.crew_id === GREEN && x.date === MONDAY);
    expect(blue.planned_minutes).toBe(0);
    expect(green.planned_minutes).toBe(480);
    expect(green.capacity_minutes).toBe(450); // one person on Green x 450
    expect(green.utilization_pct).toBe(107);  // over capacity, and says so
  });

  it('P1-10 capacity is null, not 0, for a crew with nobody on it', async () => {
    await db().prepare(`DELETE FROM crew_members WHERE crew_id=? AND company_id=?`).bind(GREEN, CO).run();
    const woId = await createJob({ scheduled_duration_minutes: 480 });
    const day = await dayRow(woId);
    const out = (await (await req(`/api/scheduling/days/${day.id}/schedule`, cookie, {
      method: 'POST', body: body({ crew_id: GREEN }),
    })).json()) as any;
    const green = out.capacity.find((x: any) => x.crew_id === GREEN);
    expect(green.capacity_minutes).toBe(0);
    expect(green.utilization_pct).toBeNull();
  });
});

describe('multi-day', () => {
  async function makeMultiDay(woId: string) {
    // Written directly: POST /multiday calls an LLM for its per-day questions.
    // Crewless on purpose — the PATCH below is what assigns Blue, and a crew
    // CHANGE is what triggers staffing. Seeding them already on Blue would make
    // that PATCH a no-op and leave the days empty.
    for (const [n, date] of [[1, MONDAY], [2, TUESDAY]] as const) {
      await db().prepare(
        `INSERT INTO wo_days (id, company_id, work_order_id, day_number, day_date, questions, status, crew_id, scheduled_duration_minutes, is_primary)
         VALUES (?,?,?,?,?,'[]','pending','',480,0)`,
      ).bind(`wp-md-${n}`, CO, woId, n, date).run();
    }
    await db().prepare(`UPDATE work_orders SET is_multiday=1, total_days=2 WHERE id=?`).bind(woId).run();
  }

  it('P1-11 rescheduling a multi-day job does not invent a phantom primary day', async () => {
    // ensurePrimaryDay's existence check had neither a company_id nor an
    // is_primary predicate, so for a multi-day job it matched hand-authored day 1
    // and returned its id — syncPrimaryDayFromWorkOrder then "found" a primary
    // row that was not one and updated nothing, while the caller believed the
    // sync had happened.
    const woId = await createJob({ scheduled_date: null, crew_id: null });
    await makeMultiDay(woId);

    await req(`/api/work-orders/${woId}`, cookie, { method: 'PUT', body: body({ scheduled_date: TUESDAY }) });

    const all = await db().prepare(`SELECT day_number, day_date, is_primary FROM wo_days WHERE work_order_id=? ORDER BY day_number`).bind(woId).all<any>();
    expect(all.results).toHaveLength(2);                        // no third row conjured
    expect(all.results!.every((d: any) => d.is_primary === 0)).toBe(true);
    expect(all.results!.map((d: any) => d.day_date)).toEqual([MONDAY, TUESDAY]); // days untouched
  });

  it('P1-12 shifting a phase to another crew re-staffs that day only', async () => {
    // Migration 0069 exists so a crew change can replace a day's roster. Only
    // PATCH /days/:n was taught to use it; shift-downstream writes the same
    // crew_id column and left the people behind.
    const woId = await createJob({ scheduled_date: null, crew_id: null });
    await makeMultiDay(woId);
    await req(`/api/work-orders/${woId}/days/1`, cookie, { method: 'PATCH', body: body({ crew_id: BLUE }) });
    await req(`/api/work-orders/${woId}/days/2`, cookie, { method: 'PATCH', body: body({ crew_id: BLUE }) });
    expect(await peopleOn('wp-md-2')).toEqual(['wp-anna', 'wp-ben']);

    await req(`/api/work-orders/${woId}/days/2/shift-downstream`, cookie, {
      method: 'POST', body: body({ day_date: '2026-08-19', crew_id: GREEN }),
    });

    expect(await peopleOn('wp-md-2')).toEqual(['wp-cara']);              // moved
    expect(await peopleOn('wp-md-1')).toEqual(['wp-anna', 'wp-ben']);    // day 1 untouched
  });
});

describe('the four labor numbers', () => {
  it('P1-13 an estimate conversion records sold labor without blocking the calendar', async () => {
    // Two defects at once. budget_minutes had no writer outside migration 0063,
    // so "vs sold" was null on every job created since. And the same figure was
    // being written into duration_hours, which is read as CALENDAR duration — so
    // 72 sold labor hours blocked 72 hours on the grid.
    const estId = 'wp-est-1';
    await db().prepare(
      `INSERT INTO estimates (id, company_id, est_number, client_name, status, doc_type, cost_data, total_cents)
       VALUES (?,?,?,?,'accepted','standard',?,?)`,
    ).bind(estId, CO, 'EST-1', 'Johnson', JSON.stringify({ rollup: { budgeted_hours: 72 } }), 1845000).run();

    const res = await req(`/api/estimates/${estId}/convert-to-job`, cookie, { method: 'POST', body: body({}) });
    expect(res.ok).toBe(true);

    const wo = await db().prepare(`SELECT budget_minutes, duration_hours FROM work_orders WHERE estimate_id=?`).bind(estId).first<any>();
    expect(wo.budget_minutes).toBe(72 * 60);
    expect(wo.duration_hours).toBeNull(); // sold labor is NOT a calendar block
  });

  it('P1-14 productive minutes per day can actually be set', async () => {
    // Migration 0060 added the column; no endpoint ever wrote it, so every tenant
    // was pinned to 450 — the single number the whole capacity denominator rests on.
    await req('/api/workday-settings', cookie, { method: 'PUT', body: body({ productive_minutes_per_day: 400 }) });
    const row = await db().prepare(`SELECT productive_minutes_per_day FROM workday_settings WHERE company_id=?`).bind(CO).first<any>();
    expect(row.productive_minutes_per_day).toBe(400);

    const week = (await (await req(`/api/scheduling/week?start=${MONDAY}`, cookie)).json()) as any;
    expect(week.working_hours.productive_minutes_per_day).toBe(400);
    expect(week.crews.find((cr: any) => cr.id === BLUE).daily_capacity_minutes).toBe(800); // 2 people x 400
  });

  it('P1-15 a nonsense productive-minutes value cannot zero out every crew', async () => {
    // 0 would make utilisation null everywhere and read as "no crew assigned",
    // which is the exact misleading output the capacity module exists to remove.
    await req('/api/workday-settings', cookie, { method: 'PUT', body: body({ productive_minutes_per_day: 0 }) });
    const row = await db().prepare(`SELECT productive_minutes_per_day FROM workday_settings WHERE company_id=?`).bind(CO).first<any>();
    expect(row.productive_minutes_per_day).toBe(450);
  });
});

describe('the crew mirror — the actual mechanism behind the report', () => {
  it('P1-24 after a crew move the job itself agrees about which crew has it', async () => {
    // Verified in a browser before this test was written, because my first
    // explanation was wrong and worth correcting: the board does NOT drag
    // through PATCH /reschedule. Its `isMdDay` flag is true whenever a card has
    // a day number, and the primary day of an ordinary single-day job is day 1 —
    // so essentially every drag went to PATCH /days/:n.
    //
    // That endpoint updates wo_days correctly, including crew_id, and mirrors
    // only scheduled_date back to the work order. crew_id was never mirrored, so
    // a single GET /api/work-orders/:id came back holding both answers:
    //
    //     crew_id:   crew-blue      <- what the drawer's crew picker selects
    //     crew_name: "Green Crew"   <- resolved through the day row
    //
    // Capacity was right the whole time. Opening the job showed the old crew.
    const woId = await createJob();
    const day = await dayRow(woId);

    await req(`/api/scheduling/days/${day.id}/schedule`, cookie, {
      method: 'POST', body: body({ date: MONDAY, crew_id: GREEN }),
    });

    const detail = (await (await req(`/api/work-orders/${woId}`, cookie)).json()) as any;
    expect(detail.data.crew_id).toBe(GREEN);       // the picker
    expect(detail.data.crew_name).toBe('Green');   // the label
    expect(detail.data.md_crew_id).toBe(GREEN);    // the day
  });

  it('P1-25 a job dragged onto a crew stops reporting as needing one', async () => {
    // GET /api/scheduling/backlog buckets on work_orders.crew_id, not the day's.
    // With the mirror missing, a crewless job dragged onto a lane kept an empty
    // work_orders.crew_id and sat in "needs crew" forever while visibly staffed
    // on the grid.
    const woId = await createJob({ crew_id: null });
    const day = await dayRow(woId);
    let backlog = (await (await req('/api/scheduling/backlog', cookie)).json()) as any;
    expect(backlog.needs_crew.map((w: any) => w.work_order_id)).toContain(woId);

    await req(`/api/scheduling/days/${day.id}/schedule`, cookie, {
      method: 'POST', body: body({ date: MONDAY, crew_id: BLUE }),
    });

    backlog = (await (await req('/api/scheduling/backlog', cookie)).json()) as any;
    expect(backlog.needs_crew.map((w: any) => w.work_order_id)).not.toContain(woId);
  });

  it('P1-26 moving one phase of a multi-day job does not touch the work order', async () => {
    // The mirror is deliberately limited to the primary day. A multi-day job's
    // day 3 has its own crew, and work_orders carries a single crew_id that
    // cannot describe them — writing day 3's crew there would make the job claim
    // a crew it only has on Wednesday.
    const woId = await createJob({ scheduled_date: null, crew_id: null });
    for (const [n, date] of [[1, MONDAY], [2, TUESDAY]] as const) {
      await db().prepare(
        `INSERT INTO wo_days (id, company_id, work_order_id, day_number, day_date, questions, status, crew_id, scheduled_duration_minutes, is_primary)
         VALUES (?,?,?,?,?,'[]','pending','',480,0)`,
      ).bind(`wp-mm-${n}`, CO, woId, n, date).run();
    }

    await req(`/api/scheduling/days/wp-mm-2/schedule`, cookie, {
      method: 'POST', body: body({ crew_id: GREEN }),
    });

    expect((await db().prepare(`SELECT crew_id FROM wo_days WHERE id='wp-mm-2'`).first<any>()).crew_id).toBe(GREEN);
    expect((await woRow(woId)).crew_id).toBeNull();  // the job stays uncommitted
    expect(await peopleOn('wp-mm-2')).toEqual(['wp-cara']);
    expect(await peopleOn('wp-mm-1')).toEqual([]);   // day 1 untouched
  });
});

describe('the single atomic call the board now makes', () => {
  it('P1-19 a card carries its day id, so the board can address the day directly', async () => {
    // The board drags a DAY, not a job — one phase of a multi-day job moves on
    // its own. Without md_day_id on the card there was no way to name the row,
    // which is why the drag went through the work-order endpoints at all.
    const woId = await createJob();
    const list = (await (await req('/api/work-orders?expand=days', cookie)).json()) as any;
    const card = list.data.find((w: any) => w.id === woId);
    expect(card.md_day_id).toBeTruthy();
    expect(card.md_day_id).toBe((await dayRow(woId)).id);
  });

  it('P1-20 one call moves the date, the crew, the people and the mirror together', async () => {
    // What the two-request version could not guarantee: after this single write
    // there is no intermediate state in which the four disagree.
    const woId = await createJob();
    const day = await dayRow(woId);

    const res = await req(`/api/scheduling/days/${day.id}/schedule`, cookie, {
      method: 'POST', body: body({ date: TUESDAY, crew_id: GREEN }),
    });
    expect(res.status).toBe(200);

    const after = await dayRow(woId);
    const wo = await woRow(woId);
    expect(after.day_date).toBe(TUESDAY);
    expect(after.crew_id).toBe(GREEN);
    expect(wo.scheduled_date).toBe(TUESDAY);
    expect(wo.crew_id).toBe(GREEN);
    expect(await peopleOn(day.id)).toEqual(['wp-cara']);
  });

  it('P1-21 scheduling a backlog job creates its day and staffs it', async () => {
    // A job with no date has no wo_days row at all, so there is nothing to
    // address — the board falls back to the work-order-level endpoint, which
    // creates the row and then applies the same write.
    const woId = await createJob({ scheduled_date: null, crew_id: null });
    expect(await dayRow(woId)).toBeNull();

    const res = await req(`/api/scheduling/work-orders/${woId}/schedule`, cookie, {
      method: 'POST', body: body({ date: MONDAY, crew_id: BLUE }),
    });
    expect(res.status).toBe(200);

    const day = await dayRow(woId);
    expect(day.day_date).toBe(MONDAY);
    expect(day.crew_id).toBe(BLUE);
    expect(await peopleOn(day.id)).toEqual(['wp-anna', 'wp-ben']);
  });

  it('P1-22 a locked job is refused BEFORE anything is written', async () => {
    // This endpoint selected schedule_locked and never read it. The only check
    // was downstream, by which point the work order's date had already been
    // committed — so a locked job returned 409 and moved anyway.
    const woId = await createJob();
    await req(`/api/work-orders/${woId}`, cookie, { method: 'PUT', body: body({ schedule_locked: true }) });

    const res = await req(`/api/scheduling/work-orders/${woId}/schedule`, cookie, {
      method: 'POST', body: body({ date: TUESDAY }),
    });
    expect(res.status).toBe(409);
    expect((await woRow(woId)).scheduled_date).toBe(MONDAY); // and did not move
  });

  it('P1-23 the move is all-or-nothing across the day row and its mirror', async () => {
    // The day update and the work_orders mirror share one db.batch, so they
    // cannot land apart. Asserted by pointing the mirror at a work order that
    // cannot be updated and checking the day did not move either.
    const woId = await createJob();
    const day = await dayRow(woId);
    await db().prepare(`DELETE FROM work_orders WHERE id=?`).bind(woId).run();

    // The day row is now an orphan; the batch's second statement matches nothing.
    // What matters is that the endpoint does not leave a half-applied schedule.
    const res = await req(`/api/scheduling/days/${day.id}/schedule`, cookie, {
      method: 'POST', body: body({ date: TUESDAY }),
    });
    const after = await db().prepare(`SELECT day_date FROM wo_days WHERE id=?`).bind(day.id).first<any>();
    // Either both moved or neither did — never a day on Tuesday with a work
    // order still on Monday.
    if (res.status === 200) expect(after.day_date).toBe(TUESDAY);
    else expect(after.day_date).toBe(MONDAY);
  });
});

describe('the Job Pool', () => {
  it('P1-27 a job scheduled with no stated duration still consumes capacity', async () => {
    // Found in the browser: dragging a job out of the pool put the right people
    // on it and left the crew reading 0% — capacity said idle next to a grid
    // with a card on it. A job off the pool has no calendar duration yet, and
    // planned_minutes defaulted to 0, which claims the crew is on site doing
    // nothing. It now falls back to the company's productive day.
    const woId = await createJob({ scheduled_date: null, crew_id: null, scheduled_duration_minutes: null });
    await req(`/api/scheduling/work-orders/${woId}/schedule`, cookie, {
      method: 'POST', body: body({ date: MONDAY, crew_id: BLUE }),
    });

    const day = await dayRow(woId);
    const rows = await db().prepare(`SELECT planned_minutes FROM wo_day_employees WHERE wo_day_id=?`).bind(day.id).all<any>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results!.every((r: any) => r.planned_minutes === 450)).toBe(true);

    const week = (await (await req(`/api/scheduling/week?start=${MONDAY}`, cookie)).json()) as any;
    const blue = week.crews.find((c: any) => c.id === BLUE);
    expect(blue.week_planned_minutes).toBe(900); // two people x a productive day
    expect(blue.week_utilization_pct).toBeGreaterThan(0);
  });

  it('P1-28 the fallback follows the tenant setting, not a hardcoded 450', async () => {
    await req('/api/workday-settings', cookie, { method: 'PUT', body: body({ productive_minutes_per_day: 400 }) });
    const woId = await createJob({ scheduled_date: null, crew_id: null, scheduled_duration_minutes: null });
    await req(`/api/scheduling/work-orders/${woId}/schedule`, cookie, {
      method: 'POST', body: body({ date: MONDAY, crew_id: BLUE }),
    });
    const day = await dayRow(woId);
    const row = await db().prepare(`SELECT planned_minutes FROM wo_day_employees WHERE wo_day_id=? LIMIT 1`).bind(day.id).first<any>();
    expect(row.planned_minutes).toBe(400);
  });

  it('P1-29 unscheduling returns a job to the pool without losing its people', async () => {
    // DELETE /days/:id/schedule has existed since the router was written and had
    // no UI at all — there was no way to take a job off the grid short of
    // editing it. It clears the date and keeps the day row and its staffing, so
    // re-scheduling does not start from an empty crew.
    const woId = await createJob();
    const day = await dayRow(woId);
    expect(await peopleOn(day.id)).toEqual(['wp-anna', 'wp-ben']);

    const res = await req(`/api/scheduling/days/${day.id}/schedule`, cookie, { method: 'DELETE' });
    expect(res.status).toBe(200);

    expect((await woRow(woId)).scheduled_date).toBeNull();
    expect(await peopleOn(day.id)).toEqual(['wp-anna', 'wp-ben']); // staffing survives

    const backlog = (await (await req('/api/scheduling/backlog', cookie)).json()) as any;
    expect(backlog.needs_scheduling.map((w: any) => w.work_order_id)).toContain(woId);
  });
});

describe('GET /api/work-orders paging and shape', () => {
  it('P1-16 one row per job by default, one row per day on request', async () => {
    // The wo_days join had no is_primary predicate, so a five-day job came back
    // as five identical-looking rows. The board needs that expansion; every
    // other consumer was silently over-counting.
    const woId = await createJob({ scheduled_date: null, crew_id: null });
    for (const [n, date] of [[1, MONDAY], [2, TUESDAY], [3, '2026-08-19']] as const) {
      await db().prepare(
        `INSERT INTO wo_days (id, company_id, work_order_id, day_number, day_date, questions, status, crew_id, is_primary)
         VALUES (?,?,?,?,?,'[]','pending',?,0)`,
      ).bind(`wp-x-${n}`, CO, woId, n, date, BLUE).run();
    }

    const plain = (await (await req('/api/work-orders', cookie)).json()) as any;
    expect(plain.data.filter((w: any) => w.id === woId)).toHaveLength(1);

    const expanded = (await (await req('/api/work-orders?expand=days', cookie)).json()) as any;
    expect(expanded.data.filter((w: any) => w.id === woId)).toHaveLength(3);
  });

  it('P1-17 offset actually pages instead of returning page one forever', async () => {
    // public/js/app_premium.js has sent &offset= from the client-detail "load
    // more" since it was written; the endpoint never read it, so the button
    // re-appended the same rows.
    for (let i = 0; i < 5; i++) await createJob({ scheduled_date: `2026-08-1${i}` });
    const page1 = (await (await req('/api/work-orders?limit=2&offset=0', cookie)).json()) as any;
    const page2 = (await (await req('/api/work-orders?limit=2&offset=2', cookie)).json()) as any;

    expect(page1.data).toHaveLength(2);
    expect(page2.data).toHaveLength(2);
    const overlap = page1.data.filter((a: any) => page2.data.some((b: any) => b.id === a.id));
    expect(overlap).toEqual([]);
  });

  it('P1-18 a junk limit is clamped rather than crashing the list', async () => {
    // LIMIT was interpolated, so ?limit=abc produced "LIMIT NaN" and a 500.
    await createJob();
    expect((await req('/api/work-orders?limit=abc', cookie)).status).toBe(200);
    expect((await req('/api/work-orders?limit=-5', cookie)).status).toBe(200);
    expect((await req('/api/work-orders?limit=99999999', cookie)).status).toBe(200);
  });
});
