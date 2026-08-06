import type { APIRequestContext } from "@playwright/test";

/** Shared seeding helper for the five Wave 4 e2e suites — talks to the
 * test-only endpoints in src/ui/dev-server.ts. */
export async function resetFinanceDb(request: APIRequestContext, tenantId: string) {
  const res = await request.post("/test/reset", { data: { tenant_id: tenantId } });
  if (!res.ok()) throw new Error(`reset failed: ${res.status()}`);
}

export async function exec(request: APIRequestContext, sql: string, params: unknown[] = []) {
  const res = await request.post("/test/exec", { data: { sql, params } });
  if (!res.ok()) throw new Error(`exec failed: ${res.status()} ${await res.text()}`);
}

/** Same pair, against the CRM's own `DB` — only collections.e2e.ts needs these. */
export async function resetCrmDb(request: APIRequestContext, companyId: string) {
  const res = await request.post("/test/reset-crm", { data: { company_id: companyId } });
  if (!res.ok()) throw new Error(`reset-crm failed: ${res.status()}`);
}

export async function execCrm(request: APIRequestContext, sql: string, params: unknown[] = []) {
  const res = await request.post("/test/exec-crm", { data: { sql, params } });
  if (!res.ok()) throw new Error(`exec-crm failed: ${res.status()} ${await res.text()}`);
}
