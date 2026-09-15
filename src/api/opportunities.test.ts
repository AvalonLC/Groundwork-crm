/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import app from "../index";

/**
 * The lead form always assigns its own client-side id (uid('opp')) before the
 * very first save, so a brand new lead's first write always reaches the API
 * as PUT /api/opportunities/:id, never POST — the id has never existed in
 * this company's rows. Before this fix, that PUT's `UPDATE ... WHERE id=?`
 * matched zero rows, D1 reported no error, and the route returned 200 anyway
 * — reporting a "successful" save that never created anything. The frontend
 * (public/js/app_premium.js's _d1Write) has no way to distinguish that from
 * a real update, so it never queues a retry, and the lead is permanently
 * flagged "saved locally, not synced to the cloud" (it never gets the
 * `_fromD1: true` marker a real GET /opportunities round-trip would set)
 * even though the app believed the write had already gone through.
 *
 * The fix makes PUT idempotent for a not-yet-existing id: a genuine no-op
 * (0 rows matched) falls back to the same insertOpportunityRow() helper
 * POST /api/opportunities already uses, so the row actually gets created —
 * matching how POST and /bulk-upsert already behave for a brand new id.
 */

const db = () => env.DB;

async function seedSession(companyId: string, repId: string) {
  await db().prepare(`INSERT OR IGNORE INTO companies (id, name, slug, active) VALUES (?,?,?,1)`)
    .bind(companyId, `Test Co ${companyId}`, companyId).run();
  await db().prepare(`INSERT OR IGNORE INTO reps (id, company_id, name, pin, role, active) VALUES (?,?,?,?,?,1)`)
    .bind(repId, companyId, "Test Rep", "0000", "admin").run();
  const token = `tok-${companyId}-${repId}`;
  await db().prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
    .bind(`session_${token}`, repId).run();
  return { token, cookie: `avalon_session=${token}` };
}

async function req(path: string, cookie: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const res = await app.request(path, {
    ...init,
    headers: { ...(init.headers || {}), "content-type": "application/json", cookie },
  }, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("PUT /api/opportunities/:id on a client-generated id that was never created", () => {
  it("OPP-01 creates the row instead of silently no-op'ing, and reports created:true", async () => {
    const { cookie } = await seedSession("opp-co-1", "opp-rep-1");
    const clientSideId = "opp_" + Date.now() + "_neverposted";

    const res = await req(`/api/opportunities/${clientSideId}`, cookie, {
      method: "PUT",
      body: JSON.stringify({ client: "Jane Doe", status: "Lead Intake / Rapport", jobValue: 1500, repId: "opp-rep-1" }),
    });

    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: { updated: string; created: boolean } };
    expect(data.created).toBe(true);
    expect(data.updated).toBe(clientSideId);

    const row: any = await db().prepare(
      `SELECT id, client, status, company_id FROM opportunities WHERE id = ?`
    ).bind(clientSideId).first();
    expect(row).toBeTruthy();
    expect(row.client).toBe("Jane Doe");
    expect(row.company_id).toBe("opp-co-1");
  });

  it("OPP-02 a genuine update to an existing id still reports created:false and does not duplicate the row", async () => {
    const { cookie } = await seedSession("opp-co-2", "opp-rep-2");
    const created = await req("/api/opportunities", cookie, {
      method: "POST",
      body: JSON.stringify({ client: "Existing Client", jobValue: 100 }),
    });
    const { data: { id } } = await created.json() as { data: { id: string } };

    const res = await req(`/api/opportunities/${id}`, cookie, {
      method: "PUT",
      body: JSON.stringify({ jobValue: 250 }),
    });
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: { updated: string; created: boolean } };
    expect(data.created).toBe(false);

    const rows: any = await db().prepare(
      `SELECT COUNT(*) AS n FROM opportunities WHERE id = ?`
    ).bind(id).first();
    expect(rows.n).toBe(1);
    const row: any = await db().prepare(`SELECT job_value FROM opportunities WHERE id = ?`).bind(id).first();
    expect(row.job_value).toBe(250);
  });

  it("OPP-03 an id that belongs to a DIFFERENT company is rejected, not adopted or duplicated", async () => {
    // opportunities.id is a global TEXT PRIMARY KEY, not scoped per company —
    // "0 rows matched WHERE id=? AND company_id=?" is ambiguous between "id
    // does not exist anywhere" (should create) and "id exists, but under a
    // different tenant" (must never create: blind-inserting would either hit
    // the id's UNIQUE constraint and 500, or let one tenant overwrite/adopt
    // another tenant's lead — both worse than the original silent no-op bug).
    const sessionA = await seedSession("opp-co-a", "opp-rep-a");
    const sessionB = await seedSession("opp-co-b", "opp-rep-b");

    const createdInA = await req("/api/opportunities", sessionA.cookie, {
      method: "POST", body: JSON.stringify({ client: "Company A Lead" }),
    });
    const { data: { id } } = await createdInA.json() as { data: { id: string } };

    const res = await req(`/api/opportunities/${id}`, sessionB.cookie, {
      method: "PUT", body: JSON.stringify({ client: "Company B Trying To Hijack" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(false);

    const rows = await db().prepare(
      `SELECT COUNT(*) AS n FROM opportunities WHERE id = ?`
    ).bind(id).first() as any;
    expect(rows.n).toBe(1);
    const row: any = await db().prepare(`SELECT company_id, client FROM opportunities WHERE id = ?`).bind(id).first();
    expect(row.company_id).toBe("opp-co-a");
    expect(row.client).toBe("Company A Lead");
  });
});
