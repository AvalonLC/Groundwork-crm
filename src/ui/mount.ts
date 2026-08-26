import { Hono } from "hono";
import { moneyLoopRouter } from "./money-loop";
import { recoveryRouter } from "./recovery";
import { budgetRouter } from "./budget";
import { queueRouter } from "./queue";
import { jobCostingRouter } from "./job-costing";
import { configAdminRouter, configAdminApiRouter } from "./config-admin";
import { policySetupRouter } from "./policy-setup";
import { documentUploadRouter } from "./document-upload";
import { collectionsRouter } from "./collections";
import { obligationsRouter } from "./obligations";
import { reconciliationRouter } from "./reconciliation";
import { forecastRouter } from "./forecast";
import { documentsRouter } from "./documents";
import { receiptPostingRouter } from "./receipt-posting";
import { invoicesPaymentsRouter } from "./invoices-payments";
import { ledgerRouter } from "./ledger";
import { onboardingRouter } from "./onboarding";
import { changeOrdersRouter } from "./change-orders";
import type { FinanceAuthVars } from "./layout";

/**
 * Production mount point for Finance OS UI pages — the counterpart to
 * src/ui/dev-server.ts, minus the test-only /test/reset and /test/exec
 * seeding endpoints. This is what src/index.tsx imports and mounts (see
 * that file's "Finance OS routes" section). Every page here reads real
 * auth via requireAuth-populated context vars (src/ui/layout.tsx's
 * readPageArgs) when mounted behind requireAuth, which src/index.tsx does
 * for the whole /finance/* prefix.
 *
 * Single `DB` binding since the 2026-08-09 merge
 * (migrations/0057_finance_merge.sql) — Finance OS tables and the CRM's
 * own tables live in the same database now, no more separate FINANCE_DB.
 */
export type FinanceUiBindings = { DB: D1Database; RECEIPTS: R2Bucket };

export const financeUiRouter = new Hono<{ Bindings: FinanceUiBindings; Variables: FinanceAuthVars }>();

financeUiRouter.route("/money-loop", moneyLoopRouter);
financeUiRouter.route("/recovery", recoveryRouter);
financeUiRouter.route("/budget", budgetRouter);
financeUiRouter.route("/queue", queueRouter);
financeUiRouter.route("/job-costing", jobCostingRouter);
financeUiRouter.route("/config", configAdminRouter);
// NOT nested under /config: configAdminRouter's POST /:name would otherwise
// swallow POST /finance/config/policy (name="policy") before ever reaching
// this router — same-prefix mounts don't fall through in Hono.
financeUiRouter.route("/policy", policySetupRouter);
financeUiRouter.route("/upload", documentUploadRouter);
financeUiRouter.route("/collections", collectionsRouter);
financeUiRouter.route("/obligations", obligationsRouter);
financeUiRouter.route("/reconciliation", reconciliationRouter);
financeUiRouter.route("/forecast", forecastRouter);
financeUiRouter.route("/documents", documentsRouter);
financeUiRouter.route("/post-receipts", receiptPostingRouter);
financeUiRouter.route("/invoices-payments", invoicesPaymentsRouter);
financeUiRouter.route("/ledger", ledgerRouter);
financeUiRouter.route("/onboarding", onboardingRouter);
financeUiRouter.route("/change-orders", changeOrdersRouter);
financeUiRouter.route("/api/config", configAdminApiRouter);
