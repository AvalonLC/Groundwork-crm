/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import app from '../index';

/**
 * Visit generation against a real database.
 *
 * schedule.test.ts covers the date arithmetic in isolation. This covers the part
 * that can only be wrong once rows exist: idempotency, the two-tier horizon, the
 * work_order_id link that has never been populated, and whether a generated job
 * actually lands on the schedule board like any other.
 */

const db = () => env.DB;
const CO = 'gen-co';
const CREW = 'gen-crew';
const TODAY = '2026-08-17'; // Monday

async function seedSession() {
  await db().prepare(`INSERT OR IGNORE INTO companies (id, name, slug, active) VALUES (?,?,?,1)`).bind(CO, 'Gen Co', CO).run();
  await db().prepare(`INSERT OR IGNORE INTO reps (id, company_id, name, pin, role, active) VALUES (?,?,?,?,?,1)`)
    .bind('gen-admin', CO, 'Admin', '0000', 'admin').run();
  await db().prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
    .bind(`session_tok-${CO}`, 'gen-admin').run();
  return `avalon_session=tok-${CO}`;
}

async function req(path: string, cookie: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const res = await app.request(path, { ...init, headers: { ...(init.headers || {}), 'content-type': 'application/json', cookie } }, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const body = (o: unknown) => JSON.stringify(o);
const generate = async (cookie: string, extra: Record<string, unknown> = {}) =>
  (await (await req('/api/recurring/generate', cookie, { method: 'POST', body: body({ today: TODAY, ...extra }) })).json()) as any;

const visitCount = async () =>
  ((await db().prepare(`SELECT COUNT(*) n FROM plan_visits WHERE company_id=?`).bind(CO).first<any>())!).n;
const woCount = async () =>
  ((await db().prepare(`SELECT COUNT(*) n FROM work_orders WHERE company_id=?`).bind(CO).first<any>())!).n;

let cookie: string;

beforeEach(async () => {
  for (const t of ['wo_day_employees', 'wo_days', 'work_orders', 'plan_visits', 'client_plan_subscriptions', 'recurring_plans', 'crew_members', 'crews', 'reps', 'workday_settings']) {
    await db().prepare(`DELETE FROM ${t} WHERE company_id=?`).bind(CO).run();
  }
  cookie = await seedSession();
  await db().prepare(`INSERT INTO workday_settings (id, company_id, working_days, shift_start, shift_end, productive_minutes_per_day) VALUES (?,?,?,?,?,?)`)
    .bind(`ws-${CO}`, CO, '1,2,3,4,5', '07:00', '17:00', 450).run();
  await db().prepare(`INSERT INTO crews (id, company_id, name, color, active) VALUES (?,?,?,?,1)`).bind(CREW, CO, 'Mow Crew', '#0f0').run();
  await db().prepare(`INSERT INTO reps (id, company_id, name, pin, role, active) VALUES (?,?,?,?,?,1)`).bind('gen-mike', CO, 'Mike', '0000', 'laborer').run();
  await db().prepare(`INSERT INTO crew_members (id, crew_id, rep_id, company_id, crew_role) VALUES (?,?,?,?,?)`).bind('gen-cm', CREW, 'gen-mike', CO, 'foreman').run();

  await db().prepare(
    `INSERT INTO recurring_plans (id, company_id, name, frequency, frequency_days, price, price_cents, estimated_hours, service_type, tasks, is_active)
     VALUES (?,?,?,?,?,?,?,?,?,?,1)`,
  ).bind('gen-plan', CO, 'Weekly Mow', 'weekly', 7, 65, 6500, 2, 'Lawn Care', JSON.stringify(['Mow', 'Trim', 'Blow'])).run();
});

async function subscribe(extra: Record<string, unknown> = {}) {
  const id = `gen-sub-${Math.random().toString(36).slice(2, 8)}`;
  const f = { start_date: TODAY, next_visit_date: TODAY, end_date: null, crew: CREW, ...extra } as any;
  await db().prepare(
    `INSERT INTO client_plan_subscriptions
       (id, company_id, plan_id, client_id, client_name, status, start_date, end_date, next_visit_date, default_crew_id, service_address, property_access)
     VALUES (?,?,?,?,?, 'active', ?,?,?,?,?,?)`,
  ).bind(id, CO, 'gen-plan', 'gen-client', 'Johnson', f.start_date, f.end_date, f.next_visit_date, f.crew, '12 Elm St, Vienna VA', 'Gate code 4821').run();
  return id;
}

describe('visit generation', () => {
  it('GEN-20 a weekly subscription produces a year of visits and a month of work orders', async () => {
    // The two-tier horizon, which is the entire design. 52 cheap rows the client
    // can see; 5 real jobs on the board. As work orders all 52 would burn 52
    // job numbers and fill every backlog query for a year.
    await subscribe();
    const out = await generate(cookie);

    expect(out.ok).toBe(true);
    expect(out.visits_created).toBeGreaterThan(50);
    expect(out.visits_created).toBeLessThan(55);
    expect(out.work_orders_created).toBe(5); // Aug 17, 24, 31, Sep 7, 14
    expect(await visitCount()).toBe(out.visits_created);
    expect(await woCount()).toBe(5);
  });

  it('GEN-21 running it twice creates nothing the second time', async () => {
    // The property that matters most. This will run on a schedule, by hand, and
    // again the moment anyone suspects it did not work.
    await subscribe();
    const first = await generate(cookie);
    const visitsAfterFirst = await visitCount();
    const wosAfterFirst = await woCount();

    const second = await generate(cookie);
    expect(second.visits_created).toBe(0);
    expect(second.work_orders_created).toBe(0);
    expect(await visitCount()).toBe(visitsAfterFirst);
    expect(await woCount()).toBe(wosAfterFirst);
    expect(first.visits_created).toBeGreaterThan(0);
  });

  it('GEN-22 a moved visit is not regenerated into its old slot', async () => {
    // Ids are keyed on the PLANNED date, so dragging a visit does not make the
    // generator think it is missing. Keying on scheduled_date would resurrect
    // the original every single run.
    await subscribe();
    await generate(cookie);
    const before = await visitCount();

    await db().prepare(`UPDATE plan_visits SET scheduled_date='2026-08-19' WHERE id LIKE 'pv_%2026-08-17'`).run();
    const again = await generate(cookie);

    expect(again.visits_created).toBe(0);
    expect(await visitCount()).toBe(before);
  });

  it('GEN-23 the work_order_id link is finally populated', async () => {
    // plan_visits.work_order_id has existed since migration 0024 and was never
    // once written. It is what makes a visit and a job the same thing.
    await subscribe();
    await generate(cookie);
    const linked = await db().prepare(
      `SELECT pv.id, pv.work_order_id, wo.wo_number FROM plan_visits pv
         JOIN work_orders wo ON wo.id = pv.work_order_id
        WHERE pv.company_id=?`).bind(CO).all<any>();
    expect(linked.results!.length).toBe(5);
    expect(linked.results![0].wo_number).toMatch(/^RC-\d{5}$/);
  });

  it('GEN-24 recurring work gets its own number series', async () => {
    // Thousands of mow visits a year must not burn the WO- numbers that appear
    // on install paperwork.
    await db().prepare(
      `INSERT INTO work_orders (id, company_id, wo_number, client_name, status) VALUES (?,?,?,?,'scheduled')`,
    ).bind('gen-manual', CO, 'WO-00042', 'Install job').run();

    await subscribe();
    await generate(cookie);

    const manual = await db().prepare(`SELECT wo_number FROM work_orders WHERE id='gen-manual'`).first<any>();
    expect(manual.wo_number).toBe('WO-00042'); // untouched
    const rc = await db().prepare(`SELECT wo_number FROM work_orders WHERE company_id=? AND wo_number LIKE 'RC-%' ORDER BY wo_number`).bind(CO).all<any>();
    expect(rc.results!.map((r: any) => r.wo_number)).toEqual(['RC-00001', 'RC-00002', 'RC-00003', 'RC-00004', 'RC-00005']);
  });

  it('GEN-25 a generated job lands on the board, staffed, like any other', async () => {
    // The point of generating work orders at all. If it does not appear in the
    // week payload with planned labor, the crew reads as idle on a day it is
    // fully booked — the exact bug the scheduling work spent all day removing.
    await subscribe();
    await generate(cookie);

    const week = (await (await req(`/api/scheduling/week?start=${TODAY}`, cookie)).json()) as any;
    const card = week.assignments.find((a: any) => a.date === TODAY);
    expect(card).toBeTruthy();
    expect(card.crew_id).toBe(CREW);
    expect(card.employees.map((e: any) => e.rep_id)).toEqual(['gen-mike']);
    expect(card.planned_minutes).toBe(120); // the plan's 2 estimated hours
    expect(week.crews.find((c: any) => c.id === CREW).week_planned_minutes).toBeGreaterThan(0);
  });

  it('GEN-26 an ended subscription generates nothing, an inactive one is skipped', async () => {
    await subscribe({ end_date: '2026-08-01' });                       // already over
    const paused = await subscribe();
    await db().prepare(`UPDATE client_plan_subscriptions SET status='paused' WHERE id=?`).bind(paused).run();

    const out = await generate(cookie);
    expect(out.visits_created).toBe(0);
    expect(await woCount()).toBe(0);
  });

  it('GEN-27 a subscription with no dates at all is reported, not silently skipped', async () => {
    // Silence here would mean a client who never gets scheduled and nobody
    // knowing why.
    const id = await subscribe({ start_date: null, next_visit_date: null });
    const out = await generate(cookie);
    expect(out.skipped).toEqual([{ subscription_id: id, reason: 'no start_date or next_visit_date' }]);
  });

  it('GEN-28 generation carries the plan through to the crew', async () => {
    // Access notes, task checklist and address are what makes the job doable on
    // site. A generated job that arrives blank is a job the crew has to phone in about.
    await subscribe();
    await generate(cookie);
    const wo = await db().prepare(`SELECT * FROM work_orders WHERE company_id=? AND wo_number='RC-00001'`).bind(CO).first<any>();
    expect(wo.property_addr).toBe('12 Elm St, Vienna VA');
    expect(wo.access_notes).toBe('Gate code 4821');
    expect(JSON.parse(wo.checklist)).toEqual(['Mow', 'Trim', 'Blow']);
    expect(wo.budget_minutes).toBe(120);
    expect(wo.type).toBe('Lawn Care');
  });

  it('GEN-29 a second run extends the horizon rather than restarting it', async () => {
    // Time passes and the generator runs again. It should add the visits that
    // have newly come into range, not re-walk the year.
    await subscribe();
    await generate(cookie);
    const afterFirst = await visitCount();

    const later = (await (await req('/api/recurring/generate', cookie, {
      method: 'POST', body: body({ today: '2026-09-14' }),
    })).json()) as any;

    expect(later.visits_created).toBeGreaterThan(0);
    expect(await visitCount()).toBeGreaterThan(afterFirst);
  });

  it('GEN-31 an omitted horizon uses the default, and 0 means "no work orders yet"', async () => {
    // The bug this pins: the endpoint clamped with `Number(x) ?? default`.
    // Number(undefined) is NaN and ?? only catches null/undefined, so an omitted
    // horizon became NaN, every `delta <= NaN` was false, and generation
    // produced a year of visits and not one work order — silently, with ok:true.
    //
    // `|| default` would be wrong too: 0 is a real value here, meaning "plan the
    // year, put nothing on the board yet".
    await subscribe();
    const omitted = (await (await req('/api/recurring/generate', cookie, {
      method: 'POST', body: body({ today: TODAY }),   // no horizons at all
    })).json()) as any;
    expect(omitted.work_orders_created).toBe(5);

    await db().prepare(`DELETE FROM work_orders WHERE company_id=?`).bind(CO).run();
    await db().prepare(`UPDATE plan_visits SET work_order_id=NULL WHERE company_id=?`).bind(CO).run();

    const zero = await generate(cookie, { work_order_horizon_days: 0 });
    expect(zero.work_orders_created).toBe(1); // just today's, nothing beyond
  });

  it('GEN-32 junk horizons fall back rather than generating nothing', async () => {
    await subscribe();
    const out = await generate(cookie, { work_order_horizon_days: 'soon', visit_horizon_days: null });
    expect(out.visits_created).toBeGreaterThan(50);
    expect(out.work_orders_created).toBe(5);
  });

  it('GEN-30 a field role cannot generate work for the whole company', async () => {
    await db().prepare(`INSERT OR IGNORE INTO reps (id, company_id, name, pin, role, active) VALUES (?,?,?,?,?,1)`)
      .bind('gen-foreman', CO, 'Foreman', '0000', 'foreman').run();
    await db().prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
      .bind('session_tok-foreman', 'gen-foreman').run();
    const res = await req('/api/recurring/generate', 'avalon_session=tok-foreman', { method: 'POST', body: body({ today: TODAY }) });
    expect(res.status).toBe(403);
  });
});
