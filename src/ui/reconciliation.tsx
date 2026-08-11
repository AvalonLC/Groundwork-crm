import { Hono } from "hono";
import { listClassificationFindings } from "../db/repos";
import { canSee } from "./roles";
import { readPageArgs, Page, Card, Empty, Confidence, Why, money, isPartialRequest, type FinanceAuthVars } from "./layout";

export type ReconciliationBindings = { DB: D1Database };

/**
 * Reconciliation — real backing (classification_finding), same status as
 * Documents was before /finance/upload existed: the table, repo function,
 * and engine (src/ai/classify.ts's classifyTransaction) are all built and
 * gate-verified, but classifyTransaction has no production caller yet —
 * nothing currently classifies a real transaction, so this page will show
 * its honest empty state until that wiring exists. Not built here: that's
 * a separate task (giving the classifier itself a caller, analogous to
 * what item 2 did for ingest/receipts), not "build the nav page."
 */
export const reconciliationRouter = new Hono<{ Bindings: ReconciliationBindings; Variables: FinanceAuthVars }>();

reconciliationRouter.get("/", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  if (!canSee(role, "can_see_recovery")) {
    return c.html(
      <Page title="Reconciliation" active="finControl" role={role} partial={isPartialRequest(c)}>
        <Card>
          <div class="fin-empty" data-testid="denied">
            <div class="fin-empty-t">Not available for your role</div>
            <div class="fin-empty-s">Classification review is limited to office and owner roles.</div>
          </div>
        </Card>
      </Page>,
      403,
    );
  }

  const findings = await listClassificationFindings(c.env.DB, tenant_id);
  const unresolved = findings.filter((f) => !f.action_item_id);

  return c.html(
    <Page title="Reconciliation" active="finControl" tenant={tenant_id || undefined} role={role} vocab={vocab} partial={isPartialRequest(c)}>
      <div class="fin-grid fin-grid-3">
        <div class="fin-tile">
          <div class="fin-tile-l">Findings</div>
          <div class="fin-tile-v" data-testid="findings-count">{findings.length}</div>
          <div class="fin-tile-m">total classified</div>
        </div>
        <div class="fin-tile">
          <div class="fin-tile-l">Unresolved</div>
          <div class="fin-tile-v" data-testid="unresolved-count">{unresolved.length}</div>
          <div class="fin-tile-m">{unresolved.length > 0 ? "no review item yet" : "all have a review item"}</div>
        </div>
      </div>

      <Card title="Classification findings" sub="what the classifier proposed, and how sure it was">
        <div data-testid="reconciliation-list">
          {findings.length === 0 ? (
            <Empty
              title="Nothing classified yet"
              hint="src/ai/classify.ts's classifyTransaction is built and tested, but nothing calls it in production yet — no real transaction has been run through it. This page will fill in once that wiring exists."
            />
          ) : (
            <table class="fin-table">
              <thead>
                <tr><th>Subject</th><th>Stage</th><th>Materiality</th><th>Confidence</th><th>Status</th></tr>
              </thead>
              <tbody>
                {findings.map((f) => (
                  <tr data-testid={`finding-${f.id}`}>
                    <td>{f.subject_type} <span style="color:var(--gw-muted)">{f.subject_id}</span></td>
                    <td>{f.stage_reached}</td>
                    <td class="fin-num">{money(f.materiality_cents)}</td>
                    <td><Confidence level={f.confidence} /></td>
                    <td>
                      {f.action_item_id ? (
                        <span class="fin-badge b-human">has review item</span>
                      ) : (
                        <span class="fin-badge b-high">auto-resolved</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <Why
          what="Every transaction the classifier has looked at, and whether it resolved on its own or needed a person."
          source="src/ai/classify.ts's four-stage classifier — deterministic rules first, AI fallback only after those fail."
          matters="A finding without a review item auto-resolved above the confidence threshold; anything less becomes a Work Queue item, never a silent guess."
          moves="A new transaction being classified. Nothing here is retroactive."
        />
      </Card>
    </Page>,
  );
});
