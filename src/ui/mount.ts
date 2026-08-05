import { Hono } from "hono";
import { moneyLoopRouter } from "./money-loop";
import { recoveryRouter } from "./recovery";
import { budgetRouter } from "./budget";
import { queueRouter } from "./queue";
import { jobCostingRouter } from "./job-costing";
import { configAdminRouter, configAdminApiRouter } from "./config-admin";
import type { FinanceAuthVars } from "./layout";

/**
 * Production mount point for Finance OS UI pages — the counterpart to
 * src/ui/dev-server.ts, minus the test-only /test/reset and /test/exec
 * seeding endpoints. This is what src/index.tsx imports and mounts (see
 * that file's "Finance OS routes" section). Every page here reads real
 * auth via requireAuth-populated context vars (src/ui/layout.tsx's
 * readPageArgs) when mounted behind requireAuth, which src/index.tsx does
 * for the whole /finance/* prefix.
 */
export type FinanceUiBindings = { FINANCE_DB: D1Database };

export const financeUiRouter = new Hono<{ Bindings: FinanceUiBindings; Variables: FinanceAuthVars }>();

financeUiRouter.route("/money-loop", moneyLoopRouter);
financeUiRouter.route("/recovery", recoveryRouter);
financeUiRouter.route("/budget", budgetRouter);
financeUiRouter.route("/queue", queueRouter);
financeUiRouter.route("/job-costing", jobCostingRouter);
financeUiRouter.route("/config", configAdminRouter);
financeUiRouter.route("/api/config", configAdminApiRouter);
