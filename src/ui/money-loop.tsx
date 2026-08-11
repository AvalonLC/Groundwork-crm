import { Hono } from "hono";
import { getLatestRecoverySnapshot, getOpenActionItems, getTenantFinancePolicy } from "../db/repos";
import type { ActionItem, ActionVerb } from "../db/schema";
import { canSee } from "./roles";
import { readPageArgs, Page, Term, Card, Empty, Confidence, Why, money, isPartialRequest, type FinanceAuthVars } from "./layout";

export type MoneyLoopBindings = { DB: D1Database };

const VERBS: ActionVerb[] = ["collect", "bill", "pay", "fix", "decide"];

/** Plain-language framing per verb — simple mode must contain zero
 * accounting words (CLAUDE.md UI invariant). Advanced mode falls through to
 * the dictionary term, which is already the accounting-native wording. */
const VERB_COPY: Record<ActionVerb, string> = {
  collect: "Money to collect",
  bill:    "Needs an invoice",
  pay:     "Needs to be paid",
  fix:     "Something's off",
  decide:  "Needs your call",
};

const sum = (items: ActionItem[]) => items.reduce((t, i) => t + (i.amount_cents ?? 0), 0);

/**
 * Money Loop (renamed from "Control Center" 2026-08-06 to match the
 * confirmed 8-item nav shape — gwFinancial() in app_premium.js uses the
 * same label) — the daily operating cockpit, and the center of gravity of
 * the Financial section. See docs/spec/UI-MONEYLOOP.md.
 *
 * Depth 1 is the whole page for most users: one hero number, one
 * plain-language sentence, five verb tiles. Depth 2 (the lanes) renders
 * underneath rather than behind a navigation step, so nothing is more than
 * a scroll away.
 */
export const moneyLoopRouter = new Hono<{ Bindings: MoneyLoopBindings; Variables: FinanceAuthVars }>();

moneyLoopRouter.get("/", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const db = c.env.DB;

  const [snapshot, policy] = await Promise.all([
    getLatestRecoverySnapshot(db, tenant_id),
    canSee(role, "can_see_budget_rates") ? getTenantFinancePolicy(db, tenant_id) : Promise.resolve(null),
  ]);
  const lanes = await Promise.all(VERBS.map(async (verb) => ({
    verb, items: await getOpenActionItems(db, tenant_id, verb),
  })));

  const pct = snapshot ? snapshot.pct_recovered_millionths / 10000 : null;
  const openTotal = lanes.reduce((t, l) => t + l.items.length, 0);
  const cashInPlay = lanes
    .filter((l) => l.verb === "collect" || l.verb === "bill")
    .reduce((t, l) => t + sum(l.items), 0);

  return c.html(
    <Page
      title="Money Loop"
      active="finControl"
      tenant={tenant_id || undefined}
      role={role}
      vocab={vocab}
      partial={isPartialRequest(c)}
    >
      {canSee(role, "can_see_budget_rates") && !policy ? (
        <div class="fin-note" data-testid="policy-setup-banner" style="border-left-color:var(--gw-amber)">
          <strong>Company policy isn't set up yet.</strong> Rate resolution and
          classification are running on platform defaults, silently.{" "}
          <a href={c.req.path.replace(/\/money-loop\/?$/, "/policy")} style="font-weight:700">Set it up</a>.
        </div>
      ) : null}

      {canSee(role, "can_manage_receipts") ? (
        <div class="fin-note" data-testid="upload-documents-link">
          Have a P&L export, bank statement, or receipt to add?{" "}
          <a href={c.req.path.replace(/\/money-loop\/?$/, "/upload")} style="font-weight:700">Upload documents</a>.
        </div>
      ) : null}

      {canSee(role, "can_see_recovery") ? (
        <div class="fin-note" data-testid="related-pages-link">
          How are we tracking?{" "}
          <a href={c.req.path.replace(/\/money-loop\/?$/, "/reconciliation")} style="font-weight:700">Reconciliation</a>
          {" "}·{" "}
          <a href={c.req.path.replace(/\/money-loop\/?$/, "/forecast")} style="font-weight:700">Forecast</a>
        </div>
      ) : null}

      <section class="fin-hero" data-testid="runway-hero">
        <div class="fin-hero-l"><Term term="recovery snapshot" vocab={vocab} /></div>
        {pct !== null && snapshot ? (
          <>
            <div class="fin-hero-v" data-testid="pct-recovered">{pct.toFixed(1)}%</div>
            <p class="fin-hero-s">
              You've covered {pct.toFixed(1)}% of what it costs to keep the doors open this
              year. At the current pace you get there around{" "}
              <strong>{snapshot.projected_black_friday}</strong>, give or take{" "}
              {snapshot.confidence_days} days.
            </p>
            <div class="fin-meter">
              <div class="fin-meter-f" style={`width:${Math.min(pct, 100).toFixed(1)}%`}></div>
            </div>
          </>
        ) : (
          <>
            <div class="fin-hero-v" data-testid="pct-recovered">no snapshot yet</div>
            <p class="fin-hero-s">
              Nothing has been rolled up yet. Once the nightly rollup runs, this becomes
              the one number to manage the year against.
            </p>
          </>
        )}
      </section>

      <div class="fin-grid fin-grid-5" data-testid="verb-tiles">
        {lanes.map(({ verb, items }) => (
          <a class="fin-tile" href={`#lane-${verb}`} data-testid={`verb-tile-${verb}`}>
            <div class="fin-tile-l">
              {vocab === "simple" ? VERB_COPY[verb] : <Term term={`action item: ${verb}`} vocab={vocab} />}
            </div>
            <div class="fin-tile-v" data-testid={`verb-count-${verb}`}>{items.length}</div>
            <div class="fin-tile-m">{sum(items) > 0 ? money(sum(items)) : "nothing waiting"}</div>
          </a>
        ))}
      </div>

      {openTotal > 0 ? (
        <div class="fin-note">
          <strong>{openTotal}</strong> open item{openTotal === 1 ? "" : "s"} across the five lanes
          {cashInPlay > 0 ? <> · <strong>{money(cashInPlay)}</strong> of cash in play</> : null}.
          Work them soonest-deadline first — the Work Queue sorts them that way.
        </div>
      ) : null}

      <Card title="What needs doing" sub="grouped by what you'd actually do about it">
        <div class="fin-grid fin-grid-3" data-testid="verb-lanes" style="margin-bottom:0">
          {lanes.map(({ verb, items }) => (
            <div class="fin-lane" id={`lane-${verb}`} data-testid={`lane-${verb}`}>
              <div class="fin-lane-h">
                <span>{vocab === "simple" ? VERB_COPY[verb] : verb}</span>
                <span>{items.length}</span>
              </div>
              {items.length === 0 ? (
                <div class="fin-lane-empty">nothing here — good</div>
              ) : (
                <ul>
                  {items.map((item) => (
                    <li data-testid={`action-${item.id}`}>
                      <div>
                        <strong>{item.amount_cents !== null ? money(item.amount_cents) : item.id}</strong>
                        {" "}<Confidence level={item.confidence} />
                      </div>
                      <div style="color:var(--gw-muted);font-size:11.5px;margin-top:3px">
                        owner {item.owner_id} · due {item.sla_due}
                        {item.stale_components ? ` · stale: ${item.stale_components}` : ""}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
        <Why
          what="Five lanes covering everything the system found that needs a person: collect, bill, pay, fix, decide."
          source="Built from your jobs, invoices, time entries and transactions — anything that couldn't be resolved automatically lands here."
          matters="If a finding doesn't turn into one of these five actions, it's noise. This is the whole list."
          moves="Working an item closes it. New work, new invoices and nightly classification add to it."
        />
      </Card>

      {openTotal === 0 ? (
        <Card>
          <Empty
            title="Nothing needs you right now"
            hint="No open items in any lane. As work gets done, invoiced and classified, anything needing a person shows up here."
          />
        </Card>
      ) : null}
    </Page>,
  );
});
