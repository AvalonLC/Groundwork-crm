import { Hono } from "hono";
import { listReceiptsForTenant } from "../db/repos";
import type { RateConfidence } from "../db/schema";
import { canSee } from "./roles";
import { readPageArgs, Page, Card, Empty, Why, money, type FinanceAuthVars } from "./layout";

export type DocumentsBindings = { DB: D1Database };

/**
 * Documents — real backing (receipt), and genuinely populated now:
 * /finance/upload (item 2) is a live caller of processReceiptUpload, so
 * this page shows real uploaded receipts, not just an empty table waiting
 * for wiring that doesn't exist yet.
 */
export const documentsRouter = new Hono<{ Bindings: DocumentsBindings; Variables: FinanceAuthVars }>();

/** Exported for reuse by onboarding.tsx's confidence-gap report — same
 * "low confidence on any field" signal, not recomputed there. */
export function needsReviewFromConfidence(fieldConfidence: string | null): boolean {
  if (!fieldConfidence) return false;
  try {
    const parsed = JSON.parse(fieldConfidence) as Record<string, RateConfidence>;
    return Object.values(parsed).some((c) => c === "low");
  } catch {
    return false;
  }
}

documentsRouter.get("/", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  if (!canSee(role, "can_manage_receipts")) {
    return c.html(
      <Page title="Documents" active="finDocuments" role={role}>
        <Card>
          <div class="fin-empty" data-testid="denied">
            <div class="fin-empty-t">Not available for your role</div>
            <div class="fin-empty-s">Receipt documents are limited to office and owner roles.</div>
          </div>
        </Card>
      </Page>,
      403,
    );
  }

  const receipts = await listReceiptsForTenant(c.env.DB, tenant_id);
  const needingReview = receipts.filter((r) => needsReviewFromConfidence(r.field_confidence));
  const basePath = c.req.path;

  return c.html(
    <Page title="Documents" active="finDocuments" tenant={tenant_id || undefined} role={role} vocab={vocab}>
      <div class="fin-grid fin-grid-3">
        <div class="fin-tile">
          <div class="fin-tile-l">Receipts</div>
          <div class="fin-tile-v" data-testid="receipt-count">{receipts.length}</div>
          <div class="fin-tile-m">uploaded total</div>
        </div>
        <div class="fin-tile">
          <div class="fin-tile-l">Needs review</div>
          <div class="fin-tile-v" data-testid="needs-review-count" style={needingReview.length > 0 ? "color:var(--gw-amber)" : ""}>{needingReview.length}</div>
          <div class="fin-tile-m">{needingReview.length > 0 ? "low confidence on a field" : "nothing flagged"}</div>
        </div>
      </div>

      <Card title="Receipts" sub="newest first">
        <div data-testid="documents-list">
          {receipts.length === 0 ? (
            <Empty
              title="No receipts yet"
              hint="Upload one at Upload Documents — it'll show up here with whatever was entered and whether it's flagged for review."
            />
          ) : (
            <table class="fin-table">
              <thead>
                <tr><th>Vendor</th><th>Amount</th><th>Date</th><th>Status</th></tr>
              </thead>
              <tbody>
                {receipts.map((r) => {
                  const flagged = needsReviewFromConfidence(r.field_confidence);
                  return (
                    <tr data-testid={`receipt-${r.id}`}>
                      <td>{r.vendor ?? "—"}</td>
                      <td class="fin-num">{r.amount_cents !== null ? money(r.amount_cents) : "—"}</td>
                      <td>{r.receipt_date ?? "—"}</td>
                      <td>
                        {flagged ? (
                          <span class="fin-badge b-low">needs review</span>
                        ) : (
                          <span class="fin-badge b-high">complete</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <Why
          what="Every receipt uploaded through Upload Documents, deduped by file content."
          source="src/ai/receipts.ts's processReceiptUpload — hashes the file, stores it in R2, and scores each typed-in field."
          matters="A receipt flagged for review is missing a field the uploader wasn't sure of, not a fabricated guess filling the gap."
          moves="Uploading a new receipt. Nothing here is editable from this page yet."
        />
      </Card>

      <div class="fin-note">
        <a href={basePath.replace(/\/documents$/, "/upload")} style="font-weight:700">Upload another document</a>
      </div>
    </Page>,
  );
});
