import { Hono } from "hono";
import { getOpenActionItems } from "../db/repos";
import { readPageArgs, Page, Term, type FinanceAuthVars } from "./layout";

export type QueueBindings = { FINANCE_DB: D1Database };

/**
 * See docs/spec/UI-QUEUE.md. SLA clocks (sla_due, sorted soonest-first) +
 * AI first-pass (source_type/source_id, when the finding came from the
 * classifier/receipts/ingest rather than a human) + confidence panel
 * (confidence + stale_components rendered per item, per CLAUDE.md hard
 * rule 4 — every number's confidence must be visible, not just returned
 * by the API).
 */
export const queueRouter = new Hono<{ Bindings: QueueBindings; Variables: FinanceAuthVars }>();

queueRouter.get("/", async (c) => {
  const { tenant_id, vocab } = readPageArgs(c);
  const db = c.env.FINANCE_DB;
  const items = await getOpenActionItems(db, tenant_id);
  const sorted = [...items].sort((a, b) => a.sla_due.localeCompare(b.sla_due));

  return c.html(
    <Page title="Work Queue">
      <h1>Work Queue</h1>
      <ul data-testid="queue-list">
        {sorted.map((item) => (
          <li data-testid={`queue-item-${item.id}`}>
            <span data-testid={`sla-${item.id}`}>{item.sla_due}</span>
            {" — "}
            <Term term={`action item: ${item.verb}`} vocab={vocab} />
            {item.source_type ? (
              <span data-testid={`ai-first-pass-${item.id}`}> (AI: {item.source_type})</span>
            ) : (
              <span data-testid={`human-${item.id}`}> (manual)</span>
            )}
            <div data-testid={`confidence-panel-${item.id}`}>
              confidence: {item.confidence}
              {item.stale_components ? `, stale: ${item.stale_components}` : ""}
            </div>
          </li>
        ))}
      </ul>
    </Page>,
  );
});
