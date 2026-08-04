import { Hono } from "hono";
import { getLatestRecoverySnapshot, getOpenActionItems } from "../db/repos";
import type { ActionVerb } from "../db/schema";
import { readPageArgs, Page, Term } from "./layout";

export type MoneyLoopBindings = { FINANCE_DB: D1Database };

const VERBS: ActionVerb[] = ["collect", "bill", "pay", "fix", "decide"];

/**
 * See docs/spec/UI-MONEYLOOP.md. Depth 1: runway hero (recovery_snapshot)
 * + five verb tiles. Depth 2: verb lanes (the open action_items per verb).
 * "Runway hero" content is a documented guess (UI-MONEYLOOP.md flagged this
 * in wave 0) — rendered here as the recovery snapshot summary.
 */
export const moneyLoopRouter = new Hono<{ Bindings: MoneyLoopBindings }>();

moneyLoopRouter.get("/", async (c) => {
  const { tenant_id, vocab } = readPageArgs(c);
  const db = c.env.FINANCE_DB;

  const snapshot = await getLatestRecoverySnapshot(db, tenant_id);
  const lanes = await Promise.all(VERBS.map(async (verb) => ({
    verb, items: await getOpenActionItems(db, tenant_id, verb),
  })));

  return c.html(
    <Page title="Money Loop">
      <section data-testid="runway-hero">
        <h1><Term term="recovery snapshot" vocab={vocab} /></h1>
        {snapshot ? (
          <p data-testid="pct-recovered">{(snapshot.pct_recovered_millionths / 10000).toFixed(1)}%</p>
        ) : (
          <p data-testid="pct-recovered">no snapshot yet</p>
        )}
      </section>

      <section data-testid="verb-tiles">
        {lanes.map(({ verb, items }) => (
          <article data-testid={`verb-tile-${verb}`}>
            <h2><Term term={`action item: ${verb}`} vocab={vocab} /></h2>
            <p data-testid={`verb-count-${verb}`}>{items.length}</p>
          </article>
        ))}
      </section>

      <section data-testid="verb-lanes">
        {lanes.map(({ verb, items }) => (
          <div data-testid={`lane-${verb}`}>
            <h3>{verb}</h3>
            <ul>
              {items.map((item) => (
                <li data-testid={`action-${item.id}`}>
                  {item.id} — owner {item.owner_id} — due {item.sla_due} — confidence {item.confidence}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </Page>,
  );
});
