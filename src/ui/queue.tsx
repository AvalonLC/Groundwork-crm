import { Hono, type Context } from "hono";
import { getOpenActionItems, resolveActionItem, dismissActionItem } from "../db/repos";
import { canSee, type Role } from "./roles";
import type { VocabularyMode } from "./vocabulary";
import { readPageArgs, Page, Term, Card, Empty, Why, money, isPartialRequest, type FinanceAuthVars } from "./layout";

export type QueueBindings = { DB: D1Database };

/** Days between an SLA date and today — negative means already overdue. */
function daysOut(slaDue: string): number | null {
  const due = Date.parse(`${slaDue}T00:00:00Z`);
  if (!isFinite(due)) return null;
  return Math.round((due - Date.now()) / 86_400_000);
}

/**
 * See docs/spec/UI-QUEUE.md. SLA clocks (sla_due, sorted soonest-first) +
 * AI first-pass (source_type/source_id, when the finding came from the
 * classifier/receipts/ingest rather than a human) + confidence panel
 * (confidence + stale_components rendered per item, per CLAUDE.md hard
 * rule 4 — every number's confidence must be visible, not just returned
 * by the API).
 *
 * This is the resolution surface — the queue a finance/office user works
 * top-down, which is why it sorts by deadline rather than by amount. Kept
 * as a <ul>/<li> list (not a table) because UQ-01 asserts on list items and
 * the queue reads as a worklist, not a report.
 *
 * Resolve/Dismiss: UI-QUEUE.md's "a human confirms, edits, or dismisses" —
 * resolveActionItem()/dismissActionItem() (db/repos.ts) existed with no UI
 * caller until this. Plain HTML forms (POST + redirect), same pattern as
 * config-admin.tsx/policy-setup.tsx — no client JS required. "Resolve"
 * marks the item done; "Dismiss" closes it as not-actionable (e.g. stale
 * test data) without claiming it was fixed. Neither ever edits the
 * classifier/ingest finding itself or auto-applies anything — this is the
 * human-in-the-loop step CLAUDE.md requires, not an approval shortcut.
 */
export const queueRouter = new Hono<{ Bindings: QueueBindings; Variables: FinanceAuthVars }>();

async function renderQueuePage(
  c: { env: { DB: D1Database }; req: { path: string } },
  tenant_id: string, role: Role, vocab: VocabularyMode,
  notice: string | null, partial: boolean,
) {
  const db = c.env.DB;
  const items = await getOpenActionItems(db, tenant_id);
  const sorted = [...items].sort((a, b) => a.sla_due.localeCompare(b.sla_due));

  const overdue = sorted.filter((i) => (daysOut(i.sla_due) ?? 0) < 0).length;
  const aiCount = sorted.filter((i) => i.source_type).length;
  const basePath = c.req.path.replace(/\/[^/]+\/(resolve|dismiss)$/, "");
  const qs = `tenant_id=${encodeURIComponent(tenant_id)}&role=${role}`;

  return (
    <Page
      title="Work Queue"
      active="finQueue"
      tenant={tenant_id || undefined}
      role={role}
      vocab={vocab}
      partial={partial}
    >
      {notice && (
        <div class="fin-note" data-testid="notice" style={notice.startsWith("Error") ? "border-left-color:var(--gw-rose)" : ""}>
          {notice}
        </div>
      )}
      <div class="fin-grid fin-grid-3">
        <div class="fin-tile">
          <div class="fin-tile-l">Open items</div>
          <div class="fin-tile-v">{sorted.length}</div>
          <div class="fin-tile-m">soonest deadline first</div>
        </div>
        <div class="fin-tile">
          <div class="fin-tile-l">Past due</div>
          <div class="fin-tile-v" style={overdue > 0 ? "color:var(--gw-rose)" : ""}>{overdue}</div>
          <div class="fin-tile-m">{overdue > 0 ? "breached their clock" : "nothing overdue"}</div>
        </div>
        <div class="fin-tile">
          <div class="fin-tile-l">AI first pass</div>
          <div class="fin-tile-v">{aiCount}</div>
          <div class="fin-tile-m">already has a proposed answer</div>
        </div>
      </div>

      {canSee(role, "can_see_recovery") ? (
        <div class="fin-note" data-testid="related-pages-link">
          What needs doing?{" "}
          <a href={basePath.replace(/\/queue\/?$/, "/collections")} style="font-weight:700">Collections</a>
          {" "}·{" "}
          <a href={basePath.replace(/\/queue\/?$/, "/obligations")} style="font-weight:700">Obligations</a>
        </div>
      ) : null}

      <Card title="Queue" sub="work top-down — the clock drives the order">
        <ul data-testid="queue-list" style="list-style:none">
          {sorted.map((item) => {
            const d = daysOut(item.sla_due);
            const late = d !== null && d < 0;
            return (
              <li
                data-testid={`queue-item-${item.id}`}
                style="display:flex;gap:16px;align-items:flex-start;padding:13px 2px;border-bottom:1px solid var(--gw-line)"
              >
                <div style="min-width:96px">
                  <div class="fin-num" data-testid={`sla-${item.id}`} style={late ? "color:var(--gw-rose)" : ""}>
                    {item.sla_due}
                  </div>
                  <div style="font-size:11px;color:var(--gw-muted);margin-top:2px">
                    {d === null ? "" : late ? `${Math.abs(d)}d late` : d === 0 ? "today" : `in ${d}d`}
                  </div>
                </div>

                <div style="flex:1;min-width:0">
                  <div style="font-weight:700">
                    <Term term={`action item: ${item.verb}`} vocab={vocab} />
                    {item.amount_cents !== null ? (
                      <span class="fin-num" style="margin-left:8px">{money(item.amount_cents)}</span>
                    ) : null}
                  </div>
                  <div style="margin-top:5px">
                    {item.source_type ? (
                      <span class="fin-badge b-ai" data-testid={`ai-first-pass-${item.id}`}>
                        AI: {item.source_type}
                      </span>
                    ) : (
                      <span class="fin-badge b-human" data-testid={`human-${item.id}`}>manual</span>
                    )}
                    <span style="font-size:11.5px;color:var(--gw-muted);margin-left:8px">
                      owner {item.owner_id}
                    </span>
                  </div>
                  <div style="margin-top:8px;display:flex;gap:8px">
                    <form method="post" action={`${basePath}/${item.id}/resolve?${qs}`}>
                      <button
                        type="submit"
                        data-testid={`resolve-${item.id}`}
                        style="background:var(--gw-pine);color:#fff;border:0;border-radius:var(--gw-r-sm);padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer"
                      >
                        Resolve
                      </button>
                    </form>
                    <form method="post" action={`${basePath}/${item.id}/dismiss?${qs}`}>
                      <button
                        type="submit"
                        data-testid={`dismiss-${item.id}`}
                        style="background:none;color:var(--gw-muted);border:1px solid var(--gw-line-strong);border-radius:var(--gw-r-sm);padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer"
                      >
                        Dismiss
                      </button>
                    </form>
                  </div>
                </div>

                <div
                  data-testid={`confidence-panel-${item.id}`}
                  style="min-width:150px;font-size:11.5px;color:var(--gw-muted);text-align:right"
                >
                  {/* text-transform stays off here: UQ-03 reads innerText and
                      asserts the literal lowercase "confidence: <level>". */}
                  <span
                    class={`fin-badge ${
                      item.confidence === "high" ? "b-high" : item.confidence === "medium" ? "b-med" : "b-low"
                    }`}
                    style="text-transform:none"
                  >
                    confidence: {item.confidence}
                  </span>
                  {item.stale_components ? (
                    <div style="color:var(--gw-amber);margin-top:5px">stale: {item.stale_components}</div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>

        {sorted.length === 0 ? (
          <Empty
            title="Queue is clear"
            hint="Nothing is waiting on a person right now. New findings from classification, receipts and ingest land here automatically."
          />
        ) : null}

        <Why
          what="Everything the system couldn't finish on its own, ordered by how soon it's due."
          source="Findings from transaction classification, receipt reading and file ingest, plus anything a person flagged."
          matters="These are the only things standing between today's records and books you can trust."
          moves="Resolve clears an item as done. Dismiss closes it without claiming it was fixed — use it for a finding that turned out not to need action. Correcting an AI answer also teaches the classifier, so the same question stops coming back."
        />
      </Card>
    </Page>
  );
}

queueRouter.get("/", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const notice = c.req.query("resolved") === "1" ? "Resolved." : c.req.query("dismissed") === "1" ? "Dismissed." : c.req.query("error") ? `Error: ${c.req.query("error")}` : null;
  return c.html(await renderQueuePage(c, tenant_id, role, vocab, notice, isPartialRequest(c)));
});

async function handleAction(
  c: Context<{ Bindings: QueueBindings; Variables: FinanceAuthVars }>,
  tenant_id: string, role: Role, vocab: VocabularyMode,
  action: "resolve" | "dismiss", partial: boolean,
): Promise<Response | null> {
  const id = c.req.param("id")!;
  if (action === "resolve") await resolveActionItem(c.env.DB, tenant_id, id);
  else await dismissActionItem(c.env.DB, tenant_id, id);

  if (partial) {
    const notice = action === "resolve" ? "Resolved." : "Dismissed.";
    return c.html(await renderQueuePage(c, tenant_id, role, vocab, notice, true));
  }
  return null; // signal caller to redirect
}

queueRouter.post("/:id/resolve", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const partial = isPartialRequest(c);
  const partialResult = await handleAction(c, tenant_id, role, vocab, "resolve", partial);
  if (partialResult) return partialResult;
  const basePath = c.req.path.replace(/\/[^/]+\/resolve$/, "");
  return c.redirect(`${basePath}?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}&resolved=1`);
});

queueRouter.post("/:id/dismiss", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const partial = isPartialRequest(c);
  const partialResult = await handleAction(c, tenant_id, role, vocab, "dismiss", partial);
  if (partialResult) return partialResult;
  const basePath = c.req.path.replace(/\/[^/]+\/dismiss$/, "");
  return c.redirect(`${basePath}?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}&dismissed=1`);
});
