import type { FC } from "hono/jsx";
import type { Role } from "./roles";
import type { VocabularyMode } from "./vocabulary";
import { translateTerm, DEFAULT_VOCABULARY_MODE } from "./vocabulary";
import { resolveFinanceRole } from "../config/finance-config";

export interface PageArgs {
  tenant_id: string;
  role: Role;
  vocab: VocabularyMode;
}

/** Set by the CRM's own requireAuth middleware (src/index.tsx) when a page
 * is mounted for real, behind /finance/*. All optional because the
 * standalone dev-server.ts (used for e2e tests) never runs requireAuth. */
export interface FinanceAuthVars {
  repId?: string;
  companyId?: string;
  role?: string;
  isSuperAdmin?: boolean;
}

/**
 * Real auth first: if requireAuth populated c.var.companyId (the live-app
 * mount path), use the real session — companyId as tenant_id, the CRM role
 * string mapped through config/finance/role-map.json. Otherwise falls back
 * to query params (the standalone dev-server.ts path, used only for
 * Playwright e2e tests that don't need a real login).
 */
export function readPageArgs(c: {
  req: { query: (k: string) => string | undefined };
  var: FinanceAuthVars;
}): PageArgs {
  const vocab = (c.req.query("vocab") as VocabularyMode) ?? DEFAULT_VOCABULARY_MODE;

  if (c.var.companyId) {
    return {
      tenant_id: c.var.companyId,
      role: resolveFinanceRole(c.var.role, !!c.var.isSuperAdmin),
      vocab,
    };
  }

  return {
    tenant_id: c.req.query("tenant_id") ?? "",
    role: (c.req.query("role") as Role) ?? "crew",
    vocab,
  };
}

export const Term: FC<{ term: string; vocab: VocabularyMode }> = ({ term, vocab }) => (
  <>{translateTerm(term, vocab)}</>
);

export const Page: FC<{ title: string; children: unknown }> = ({ title, children }) => (
  <html>
    <head>
      <meta charset="utf-8" />
      <title>{title}</title>
    </head>
    <body>
      <main>{children as never}</main>
    </body>
  </html>
);
