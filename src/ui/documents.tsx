import { Hono, type Context } from "hono";
import { listReceiptsForTenant, setReceiptStatus } from "../db/repos";
import type { RateConfidence } from "../db/schema";
import { canSee, type Role } from "./roles";
import type { VocabularyMode } from "./vocabulary";
import { readPageArgs, Page, Card, Empty, Why, money, isPartialRequest, type FinanceAuthVars } from "./layout";

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

async function renderDocumentsPage(
  c: Context<{ Bindings: DocumentsBindings; Variables: FinanceAuthVars }>,
  tenant_id: string, role: Role, vocab: VocabularyMode, notice: string | null, partial: boolean,
) {
  const receipts = await listReceiptsForTenant(c.env.DB, tenant_id);
  // needs_review (field-confidence-derived) and status (migration 0084,
  // explicit human lifecycle) are two separate signals — see
  // DocumentStatus's doc comment in src/db/schema.ts. A receipt can be
  // high-confidence on every field and still sit in pending_review until
  // a human explicitly approves or rejects it; nothing here ever posts
  // to job_cost_ledger regardless of either signal.
  const needingReview = receipts.filter((r) => needsReviewFromConfidence(r.field_confidence));
  const pendingCount = receipts.filter((r) => r.status === "pending_review").length;
  const basePath = c.req.path;

  return (
      <Page title="Documents" active="finDocuments" tenant={tenant_id || undefined} role={role} vocab={vocab} partial={partial}>
      {notice && (
        <div class="fin-note" data-testid="notice" style={notice.startsWith("Error") ? "border-left-color:var(--gw-rose)" : ""}>
          {notice}
        </div>
      )}

      <div class="fin-grid fin-grid-3">
        <div class="fin-tile">
          <div class="fin-tile-l">Receipts</div>
          <div class="fin-tile-v" data-testid="receipt-count">{receipts.length}</div>
          <div class="fin-tile-m">uploaded total</div>
        </div>
        <div class="fin-tile">
          <div class="fin-tile-l">Pending review</div>
          <div class="fin-tile-v" data-testid="pending-review-count" style={pendingCount > 0 ? "color:var(--gw-amber)" : ""}>{pendingCount}</div>
          <div class="fin-tile-m">{pendingCount > 0 ? "awaiting approve/reject" : "nothing waiting"}</div>
        </div>
        <div class="fin-tile">
          <div class="fin-tile-l">Low-confidence fields</div>
          <div class="fin-tile-v" data-testid="needs-review-count" style={needingReview.length > 0 ? "color:var(--gw-amber)" : ""}>{needingReview.length}</div>
          <div class="fin-tile-m">{needingReview.length > 0 ? "a field wasn't confidently extracted" : "nothing flagged"}</div>
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
                <tr><th>Vendor</th><th>Amount</th><th>Date</th><th>Fields</th><th>Status</th><th /></tr>
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
                      <td data-testid={`status-${r.id}`}>
                        {r.status === "pending_review" && <span class="fin-badge b-med">pending review</span>}
                        {r.status === "approved" && <span class="fin-badge b-high">approved</span>}
                        {r.status === "rejected" && <span class="fin-badge b-low">rejected</span>}
                      </td>
                      <td>
                        {r.status === "pending_review" && (
                          <div style="display:flex;gap:6px">
                            <form method="post" action={`${basePath}/${r.id}/approve?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}`}>
                              <button type="submit" data-testid={`approve-${r.id}`} style="background:var(--gw-pine);color:#fff;border:0;border-radius:var(--gw-r-sm);padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer">
                                Approve
                              </button>
                            </form>
                            <form method="post" action={`${basePath}/${r.id}/reject?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}`}>
                              <button type="submit" data-testid={`reject-${r.id}`} style="background:none;color:var(--gw-rose);border:1px solid var(--gw-rose);border-radius:var(--gw-r-sm);padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer">
                                Reject
                              </button>
                            </form>
                          </div>
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
          source="src/ai/receipts.ts's processReceiptUpload — hashes the file, stores it in R2, and scores each typed-in field. status starts at pending_review (migration 0084) and only changes via an explicit Approve/Reject action here."
          matters="A receipt flagged 'needs review' is missing a field the uploader wasn't sure of, not a fabricated guess filling the gap. Approving a receipt here still never posts anything to job_cost_ledger — that's a separate, explicit posting step."
          moves="Uploading a new receipt, or approving/rejecting one already pending review."
        />
      </Card>

      <div class="fin-note">
        <a href={basePath.replace(/\/documents$/, "/upload")} style="font-weight:700">Upload another document</a>
      </div>

      {/* Finance OS §9 Priority 4 (route-mount/nav audit): /post-receipts is a
          real, fully-tested page (src/ui/receipt-posting.tsx, PC-01..PC-11)
          mounted in src/ui/mount.ts, but had no link anywhere in the finance
          UI — reachable only by typing the URL directly. It marks itself
          active="finDocuments" (the same nav tab this page is under), so it
          belongs here as a related-pages link, same pattern as Reconciliation/
          Forecast under Money Loop and Collections/Obligations under Work
          Queue. Same can_manage_receipts gate as the rest of this page, so no
          extra check is needed beyond the one this whole page already passed
          to render at all. */}
      <div class="fin-note" data-testid="related-pages-link">
        Ready to post an approved receipt to the job cost ledger?{" "}
        <a href={basePath.replace(/\/documents$/, "/post-receipts")} style="font-weight:700">Post Receipts</a>
      </div>
    </Page>
  );
}

documentsRouter.get("/", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const partial = isPartialRequest(c);
  if (!canSee(role, "can_manage_receipts")) {
    return c.html(
      <Page title="Documents" active="finDocuments" role={role} partial={partial}>
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

  const notice = c.req.query("approved") === "1" ? "Approved." : c.req.query("rejected") === "1" ? "Rejected." : null;
  return c.html(await renderDocumentsPage(c, tenant_id, role, vocab, notice, partial));
});

async function handleStatusChange(
  c: Context<{ Bindings: DocumentsBindings; Variables: FinanceAuthVars }>,
  tenant_id: string, role: Role, vocab: VocabularyMode, status: "approved" | "rejected", partial: boolean,
): Promise<Response | null> {
  const id = c.req.param("id")!;
  await setReceiptStatus(c.env.DB, tenant_id, id, status);
  if (partial) {
    const notice = status === "approved" ? "Approved." : "Rejected.";
    return c.html(await renderDocumentsPage(c, tenant_id, role, vocab, notice, true));
  }
  return null;
}

documentsRouter.post("/:id/approve", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const partial = isPartialRequest(c);
  if (!canSee(role, "can_manage_receipts")) return c.text("not available for your role", 403);
  const partialResult = await handleStatusChange(c, tenant_id, role, vocab, "approved", partial);
  if (partialResult) return partialResult;
  const basePath = c.req.path.replace(/\/[^/]+\/approve$/, "");
  return c.redirect(`${basePath}?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}&approved=1`);
});

documentsRouter.post("/:id/reject", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const partial = isPartialRequest(c);
  if (!canSee(role, "can_manage_receipts")) return c.text("not available for your role", 403);
  const partialResult = await handleStatusChange(c, tenant_id, role, vocab, "rejected", partial);
  if (partialResult) return partialResult;
  const basePath = c.req.path.replace(/\/[^/]+\/reject$/, "");
  return c.redirect(`${basePath}?tenant_id=${encodeURIComponent(tenant_id)}&role=${role}&rejected=1`);
});
