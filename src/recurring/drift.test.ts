/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import app from '../index';

/**
 * The recurring-services endpoints drifted away from their own UI: the plan
 * builder and enrolment modal post fields the handlers never read, and two
 * queries referenced columns that do not exist. Nothing here is hypothetical —
 * each test names the field the browser sends today and asserts it survives the
 * round trip.
 *
 * These go through the real HTTP routes rather than calling SQL directly,
 * because the defect WAS the handler: the columns existed the whole time.
 */

const db = () => env.DB;

async function seedSession(companyId: string, repId: string) {
  await db()
    .prepare(`INSERT OR IGNORE INTO companies (id, name, slug, active) VALUES (?,?,?,1)`)
    .bind(companyId, `Test Co ${companyId}`, companyId)
    .run();
  await db()
    .prepare(`INSERT OR IGNORE INTO reps (id, company_id, name, pin, role, active) VALUES (?,?,?,?,?,1)`)
    .bind(repId, companyId, 'Test Rep', '0000', 'admin')
    .run();
  const token = `tok-${companyId}-${repId}`;
  await db()
    .prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
    .bind(`session_${token}`, repId)
    .run();
  return `avalon_session=${token}`;
}

async function req(path: string, cookie: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const res = await app.request(
    path,
    { ...init, headers: { ...(init.headers || {}), 'content-type': 'application/json', cookie } },
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const body = (o: unknown) => JSON.stringify(o);

/** The exact payload public/js/recurring_plans.js builds when you save a plan. */
const PLAN_PAYLOAD = {
  name: 'Weekly Mow',
  frequency: 'weekly',
  price: 65,
  service_type: 'mowing',
  frequency_days: 7,
  price_type: 'per_visit',
  unit_label: 'visit',
  estimated_hours: 1.5,
  crew_size: 2,
  tasks: ['Mow all turf', 'Line-trim beds', 'Blow hard surfaces'],
};

describe('recurring plans: fields the builder sends must survive a save', () => {
  it('RD-01 POST keeps tasks, hours, crew size, cadence and pricing shape', async () => {
    const cookie = await seedSession('rd-co-1', 'rd-rep-1');
    const res = await req('/api/recurring-plans', cookie, { method: 'POST', body: body(PLAN_PAYLOAD) });
    expect(res.status).toBe(201);
    const plan = (await res.json()) as any;

    // The one that mattered most: a user types a three-item checklist, saves,
    // reopens the plan and finds it empty. Silent data loss, no error anywhere.
    expect(JSON.parse(plan.tasks)).toEqual(PLAN_PAYLOAD.tasks);

    expect(plan.estimated_hours).toBe(1.5);
    expect(plan.crew_size).toBe(2);
    expect(plan.frequency_days).toBe(7);
    expect(plan.service_type).toBe('mowing');
    expect(plan.price_type).toBe('per_visit');
    expect(plan.unit_label).toBe('visit');
    // Money is cents. The float column is dual-written, the cents column is truth.
    expect(plan.price_cents).toBe(6500);
  });

  it('RD-02 the saved row survives a re-read, not just the create response', async () => {
    // The create handler returns a fresh SELECT, so RD-01 alone could pass on a
    // response assembled in memory. Fetching by id proves it reached a column.
    const cookie = await seedSession('rd-co-2', 'rd-rep-2');
    const created = (await (
      await req('/api/recurring-plans', cookie, { method: 'POST', body: body(PLAN_PAYLOAD) })
    ).json()) as any;
    const fetched = (await (await req(`/api/recurring-plans/${created.id}`, cookie)).json()) as any;
    expect(JSON.parse(fetched.tasks)).toEqual(PLAN_PAYLOAD.tasks);
    expect(fetched.estimated_hours).toBe(1.5);
    expect(fetched.crew_size).toBe(2);
  });

  it('RD-03 PUT edits the same fields instead of dropping them', async () => {
    const cookie = await seedSession('rd-co-3', 'rd-rep-3');
    const created = (await (
      await req('/api/recurring-plans', cookie, { method: 'POST', body: body(PLAN_PAYLOAD) })
    ).json()) as any;

    const updated = (await (
      await req(`/api/recurring-plans/${created.id}`, cookie, {
        method: 'PUT',
        body: body({ tasks: ['Mow all turf', 'Edge walks'], estimated_hours: 2, crew_size: 3, price: 80 }),
      })
    ).json()) as any;

    expect(JSON.parse(updated.tasks)).toEqual(['Mow all turf', 'Edge walks']);
    expect(updated.estimated_hours).toBe(2);
    expect(updated.crew_size).toBe(3);
    expect(updated.price_cents).toBe(8000);
    // Untouched fields must not be clobbered by a partial update.
    expect(updated.service_type).toBe('mowing');
  });

  it('RD-04 accepts tasks already serialised as a JSON string', async () => {
    // The column is TEXT. The builder sends an array, but anything scripting the
    // API is as likely to send the string — double-encoding it would store
    // "\"[...]\"" and every reader would then get a string back instead of a list.
    const cookie = await seedSession('rd-co-4', 'rd-rep-4');
    const plan = (await (
      await req('/api/recurring-plans', cookie, {
        method: 'POST',
        body: body({ ...PLAN_PAYLOAD, tasks: JSON.stringify(['Only task']) }),
      })
    ).json()) as any;
    expect(JSON.parse(plan.tasks)).toEqual(['Only task']);
  });
});

describe('subscriptions: enrolment fields and the visit-history query', () => {
  async function seedPlanAndClient(cookie: string, companyId: string, clientId: string) {
    await db()
      .prepare(`INSERT OR IGNORE INTO clients (id, company_id, name) VALUES (?,?,?)`)
      .bind(clientId, companyId, 'Acme Grounds')
      .run();
    const plan = (await (
      await req('/api/recurring-plans', cookie, { method: 'POST', body: body(PLAN_PAYLOAD) })
    ).json()) as any;
    return plan;
  }

  it('RD-05 a per-client custom_price is not thrown away for the plan list price', async () => {
    const cookie = await seedSession('rd-co-5', 'rd-rep-5');
    const plan = await seedPlanAndClient(cookie, 'rd-co-5', 'rd-client-5');

    const sub = (await (
      await req('/api/recurring-subscriptions', cookie, {
        method: 'POST',
        // The enrolment modal posts custom_price. The handler only read
        // price_override, so this 90 used to be replaced by the plan's 65.
        body: body({ plan_id: plan.id, client_id: 'rd-client-5', client_name: 'Acme', custom_price: 90 }),
      })
    ).json()) as any;

    expect(sub.custom_price_cents).toBe(9000);
    expect(sub.custom_price_cents).not.toBe(plan.price_cents);
  });

  it('RD-06 price_override still works for anything already calling the API', async () => {
    const cookie = await seedSession('rd-co-6', 'rd-rep-6');
    const plan = await seedPlanAndClient(cookie, 'rd-co-6', 'rd-client-6');
    const sub = (await (
      await req('/api/recurring-subscriptions', cookie, {
        method: 'POST',
        body: body({ plan_id: plan.id, client_id: 'rd-client-6', price_override: 75 }),
      })
    ).json()) as any;
    expect(sub.custom_price_cents).toBe(7500);
  });

  it('RD-07 with neither price given, the plan price is inherited from cents', async () => {
    const cookie = await seedSession('rd-co-7', 'rd-rep-7');
    const plan = await seedPlanAndClient(cookie, 'rd-co-7', 'rd-client-7');
    const sub = (await (
      await req('/api/recurring-subscriptions', cookie, {
        method: 'POST',
        body: body({ plan_id: plan.id, client_id: 'rd-client-7' }),
      })
    ).json()) as any;
    expect(sub.custom_price_cents).toBe(6500);
  });

  it('RD-08 subscription detail returns visit history instead of erroring on a missing column', async () => {
    // ORDER BY visit_date — plan_visits has no such column, so this endpoint
    // failed outright for every subscription. Ordering is asserted too, because
    // swapping in the right column name silently is how it would regress.
    const cookie = await seedSession('rd-co-8', 'rd-rep-8');
    const plan = await seedPlanAndClient(cookie, 'rd-co-8', 'rd-client-8');
    const sub = (await (
      await req('/api/recurring-subscriptions', cookie, {
        method: 'POST',
        body: body({ plan_id: plan.id, client_id: 'rd-client-8' }),
      })
    ).json()) as any;

    for (const [id, date] of [
      ['pv-8-a', '2026-05-04'],
      ['pv-8-b', '2026-06-01'],
      ['pv-8-c', '2026-05-18'],
    ] as const) {
      await db()
        .prepare(
          `INSERT INTO plan_visits (id, company_id, subscription_id, plan_id, client_id, scheduled_date, status)
           VALUES (?,?,?,?,?,?,'scheduled')`,
        )
        .bind(id, 'rd-co-8', sub.id, plan.id, 'rd-client-8', date)
        .run();
    }

    const res = await req(`/api/recurring-subscriptions/${sub.id}`, cookie);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as any;
    expect(detail.visits).toHaveLength(3);
    expect(detail.visits.map((v: any) => v.scheduled_date)).toEqual([
      '2026-06-01',
      '2026-05-18',
      '2026-05-04',
    ]);
  });

  it('RD-09 cancelling a subscription succeeds instead of writing a column that does not exist', async () => {
    const cookie = await seedSession('rd-co-9', 'rd-rep-9');
    const plan = await seedPlanAndClient(cookie, 'rd-co-9', 'rd-client-9');
    const sub = (await (
      await req('/api/recurring-subscriptions', cookie, {
        method: 'POST',
        body: body({ plan_id: plan.id, client_id: 'rd-client-9' }),
      })
    ).json()) as any;

    const res = await req(`/api/recurring-subscriptions/${sub.id}`, cookie, {
      method: 'PUT',
      body: body({ status: 'cancelled' }),
    });
    expect(res.status).toBe(200);
    const row: any = await db()
      .prepare(`SELECT status FROM client_plan_subscriptions WHERE id=?`)
      .bind(sub.id)
      .first();
    expect(row.status).toBe('cancelled');
  });
});

describe('the deleted log-visit endpoint', () => {
  it('RD-10 POST /api/recurring-subscriptions/:id/log-visit is gone, not silently broken', async () => {
    // It was unreachable from the UI and threw on every possible call.
    // Asserting no-route rather than deleting quietly: if someone reintroduces a
    // second completion path, this fails and they have to justify it.
    //
    // The subscription must really exist. The old handler looked it up FIRST and
    // returned its own 404 for a missing one, so posting to a made-up id would
    // pass this test against the broken code as happily as against the fix, and
    // prove nothing at all.
    const cookie = await seedSession('rd-co-10', 'rd-rep-10');
    await db()
      .prepare(`INSERT OR IGNORE INTO clients (id, company_id, name) VALUES (?,?,?)`)
      .bind('rd-client-10', 'rd-co-10', 'Acme Grounds')
      .run();
    const plan = (await (
      await req('/api/recurring-plans', cookie, { method: 'POST', body: body(PLAN_PAYLOAD) })
    ).json()) as any;
    const sub = (await (
      await req('/api/recurring-subscriptions', cookie, {
        method: 'POST',
        body: body({ plan_id: plan.id, client_id: 'rd-client-10' }),
      })
    ).json()) as any;

    const res = await req(`/api/recurring-subscriptions/${sub.id}/log-visit`, cookie, {
      method: 'POST',
      body: body({ notes: 'mowed', visit_date: '2026-08-13' }),
    });
    expect(res.status).toBe(404);

    // And it left nothing behind: no half-written visit row from a path that
    // used to fail midway through.
    const visits: any = await db()
      .prepare(`SELECT COUNT(*) AS n FROM plan_visits WHERE subscription_id=?`)
      .bind(sub.id)
      .first();
    expect(visits.n).toBe(0);
  });
});
