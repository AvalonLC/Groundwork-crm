/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import app from '../index';

/**
 * GET /api/work-orders?rep_id=... — the schedule board's field-role path.
 *
 * The filter referenced `wo.assigned_rep_id`, a column no migration creates, so
 * every request carrying ?rep_id= died with "no such column". The board sets
 * that parameter for foreman, laborer and field_supervisor
 * (public/js/app_premium.js), which means the schedule board was returning 500
 * to the entire field crew while working fine for everyone in the office.
 *
 * These go through the real route because the defect was in the SQL: no unit
 * test of a helper would have caught a column that does not exist.
 */

const db = () => env.DB;
const CO = 'fs-co';

async function seedSession(repId: string, role: string) {
  await db().prepare(`INSERT OR IGNORE INTO companies (id, name, slug, active) VALUES (?,?,?,1)`)
    .bind(CO, 'Field Scoping Co', CO).run();
  await db().prepare(`INSERT OR IGNORE INTO reps (id, company_id, name, pin, role, active) VALUES (?,?,?,?,?,1)`)
    .bind(repId, CO, `Rep ${repId}`, '0000', role).run();
  const token = `tok-${CO}-${repId}`;
  await db().prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
    .bind(`session_${token}`, repId).run();
  return `avalon_session=${token}`;
}

async function req(path: string, cookie: string) {
  const ctx = createExecutionContext();
  const res = await app.request(path, { headers: { cookie } }, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const ids = async (res: Response) => {
  const body = (await res.json()) as any;
  return ((body.data || []) as any[]).map((w) => w.id).sort();
};

async function seedWorkOrder(id: string, crewId: string | null, date = '2026-08-12') {
  await db().prepare(
    `INSERT INTO work_orders (id, company_id, wo_number, client_name, status, crew_id, scheduled_date)
     VALUES (?,?,?,?,'scheduled',?,?)`,
  ).bind(id, CO, `WO-${id}`, 'Client', crewId, date).run();
}

beforeEach(async () => {
  for (const t of ['wo_day_employees', 'wo_days', 'work_order_employees', 'work_orders', 'crew_members', 'crews', 'reps']) {
    await db().prepare(`DELETE FROM ${t} WHERE company_id=?`).bind(CO).run();
  }
  await db().prepare(`INSERT INTO crews (id, company_id, name, color, active) VALUES (?,?,?,?,1),(?,?,?,?,1)`)
    .bind('fs-crew-a', CO, 'Blue', '#00f', 'fs-crew-b', CO, 'Green', '#0f0').run();
});

describe('field-role scoping on GET /api/work-orders', () => {
  it('FS-01 a foreman can load the board at all', async () => {
    // The regression test for the outage. Before the fix this was 500 with
    // "no such column: wo.assigned_rep_id" for any rep_id at all, even when the
    // company had no work orders — the SQL failed to prepare.
    const cookie = await seedSession('fs-foreman', 'foreman');
    const res = await req('/api/work-orders?rep_id=fs-foreman', cookie);
    expect(res.status).toBe(200);
  });

  it('FS-02 returns jobs run by a crew the rep is on', async () => {
    const cookie = await seedSession('fs-rep-crew', 'laborer');
    await db().prepare(`INSERT INTO crew_members (id, crew_id, rep_id, company_id, crew_role) VALUES (?,?,?,?,?)`)
      .bind('fs-cm-1', 'fs-crew-a', 'fs-rep-crew', CO, 'laborer').run();
    await seedWorkOrder('fs-wo-mine', 'fs-crew-a');
    await seedWorkOrder('fs-wo-theirs', 'fs-crew-b');

    expect(await ids(await req('/api/work-orders?rep_id=fs-rep-crew', cookie))).toEqual(['fs-wo-mine']);
  });

  it('FS-03 returns jobs the rep is on personally, even with no crew', async () => {
    // work_order_employees is the job-level list. A rep pulled onto a job that
    // has no crew assigned yet still has to be able to see it.
    const cookie = await seedSession('fs-rep-named', 'foreman');
    await seedWorkOrder('fs-wo-named', null);
    await seedWorkOrder('fs-wo-other', null);
    await db().prepare(`INSERT INTO work_order_employees (id, wo_id, rep_id, company_id) VALUES (?,?,?,?)`)
      .bind('fs-woe-1', 'fs-wo-named', 'fs-rep-named', CO).run();

    expect(await ids(await req('/api/work-orders?rep_id=fs-rep-named', cookie))).toEqual(['fs-wo-named']);
  });

  it('FS-04 returns a job the rep is on for one DAY only', async () => {
    // The day is the source of truth for who works when. Someone added to
    // Thursday of a four-day job is not on the crew and not on the job list,
    // and must still see it. This is the case a single "assigned_rep_id"
    // column could never have expressed.
    const cookie = await seedSession('fs-rep-day', 'laborer');
    await seedWorkOrder('fs-wo-day', 'fs-crew-b'); // a crew the rep is NOT on
    await db().prepare(
      `INSERT INTO wo_days (id, company_id, work_order_id, day_number, day_date, questions, status, crew_id, is_primary)
       VALUES (?,?,?,4,?, '[]','pending',?,0)`,
    ).bind('fs-day-4', CO, 'fs-wo-day', '2026-08-13', 'fs-crew-b').run();
    await db().prepare(
      `INSERT INTO wo_day_employees (id, company_id, wo_day_id, rep_id, planned_minutes, crew_role)
       VALUES (?,?,?,?,?,?)`,
    ).bind('fs-wde-1', CO, 'fs-day-4', 'fs-rep-day', 480, 'laborer').run();

    expect(await ids(await req('/api/work-orders?rep_id=fs-rep-day', cookie))).toContain('fs-wo-day');
  });

  it('FS-05 a rep on nothing sees nothing, rather than everything', async () => {
    // The failure mode worth guarding against while widening the filter: an
    // over-broad OR that matches every row would look like a working board and
    // leak the whole schedule to a laborer.
    const cookie = await seedSession('fs-rep-empty', 'laborer');
    await seedWorkOrder('fs-wo-a', 'fs-crew-a');
    await seedWorkOrder('fs-wo-b', 'fs-crew-b');

    expect(await ids(await req('/api/work-orders?rep_id=fs-rep-empty', cookie))).toEqual([]);
  });

  it('FS-06 does not match a rep of the same id in another company', async () => {
    const cookie = await seedSession('fs-rep-tenant', 'foreman');
    await db().prepare(`INSERT OR IGNORE INTO companies (id, name, slug, active) VALUES (?,?,?,1)`)
      .bind('fs-other-co', 'Other Co', 'fs-other-co').run();
    await seedWorkOrder('fs-wo-ours', 'fs-crew-a');
    await db().prepare(`INSERT INTO crew_members (id, crew_id, rep_id, company_id, crew_role) VALUES (?,?,?,?,?)`)
      .bind('fs-cm-x', 'fs-crew-a', 'fs-rep-tenant', 'fs-other-co', 'foreman').run();

    // Membership recorded under a different company must not grant visibility.
    expect(await ids(await req('/api/work-orders?rep_id=fs-rep-tenant', cookie))).toEqual([]);
  });

  it('FS-07 an office user without rep_id still sees the whole board', async () => {
    const cookie = await seedSession('fs-admin', 'admin');
    await seedWorkOrder('fs-wo-1', 'fs-crew-a');
    await seedWorkOrder('fs-wo-2', 'fs-crew-b');

    expect(await ids(await req('/api/work-orders', cookie))).toEqual(['fs-wo-1', 'fs-wo-2']);
  });
});
