import { Hono } from "hono";
import { ingestFile } from "../ai/ingest";
import { processReceiptUpload } from "../ai/receipts";
import {
  getTenantFinancePolicy, insertUploadBatch, listReceiptsForTenant, listUploadBatchesForTenant,
} from "../db/repos";
import type { UploadDomain } from "../db/schema";
import { canSee } from "./roles";
import { needsReviewFromConfidence } from "./documents";
import { readPageArgs, Page, Card, Why, isPartialRequest, type FinanceAuthVars } from "./layout";

export type OnboardingBindings = { DB: D1Database; RECEIPTS: R2Bucket };

/**
 * Financial Setup & AI Onboarding — stages 1 (multi-file intake), 2 (AI
 * normalization), and 8 (confidence-gap report) of a longer 9-stage plan.
 * Stages 3-7 and 9 (division mapping, account renaming, overhead/COGS
 * reclassification, budget generation, rate-calculation review, "activate
 * Financial Control") are explicitly deferred — they need real classified
 * data accumulating first, and are bigger builds in their own right. Not
 * stubbed here.
 *
 * Multi-file version of document-upload.tsx's same two engines
 * (ingestFile, processReceiptUpload) — no new classification logic. Plain
 * form + full-page render like every other Finance OS page: N files travel
 * in one POST under one <input multiple>, Hono's parseBody({all:true})
 * returns them as an array, the server loops once.
 */
export const onboardingRouter = new Hono<{ Bindings: OnboardingBindings; Variables: FinanceAuthVars }>();

interface FileResult {
  filename: string;
  detectedLabel: string;
  domain: UploadDomain;
  needsReview: boolean;
  duplicate: boolean;
}

type GapState = "good" | "review" | "missing";

interface GapRow {
  domain: string;
  state: GapState;
  detail: string;
}

function isCsvLike(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith(".csv") || name.endsWith(".txt") || file.type === "text/csv" || file.type === "text/plain";
}

function isReceiptLike(file: File): boolean {
  const name = file.name.toLowerCase();
  return file.type.startsWith("image/") || name.endsWith(".pdf") || file.type === "application/pdf";
}

async function computeConfidenceGap(db: D1Database, tenantId: string): Promise<GapRow[]> {
  const [policy, exports, receipts] = await Promise.all([
    getTenantFinancePolicy(db, tenantId),
    listUploadBatchesForTenant(db, tenantId, "financial_export"),
    listReceiptsForTenant(db, tenantId),
  ]);

  const exportsNeedReview = exports.some((e) => e.needs_review === 1);
  const receiptsNeedReview = receipts.some((r) => needsReviewFromConfidence(r.field_confidence));

  return [
    {
      domain: "Tenant Policy",
      state: policy ? "good" : "missing",
      detail: policy ? "Company policy is set up." : "No company policy yet — see Setup & Config.",
    },
    {
      domain: "Financial Exports",
      state: exports.length === 0 ? "missing" : exportsNeedReview ? "review" : "good",
      detail: exports.length === 0
        ? "No P&L or bank export uploaded yet."
        : `${exports.length} uploaded${exportsNeedReview ? ", at least one needs review" : ", all clean"}.`,
    },
    {
      domain: "Receipts",
      state: receipts.length === 0 ? "missing" : receiptsNeedReview ? "review" : "good",
      detail: receipts.length === 0
        ? "No receipts uploaded yet."
        : `${receipts.length} uploaded${receiptsNeedReview ? ", at least one field needs review" : ", all fields high-confidence"}.`,
    },
  ];
}

function gapLabel(state: GapState): string {
  return state === "good" ? "good to go" : state === "review" ? "needs review" : "missing";
}

function renderPage(
  role: string, tenant: string | undefined, vocab: string | undefined,
  basePath: string, gap: GapRow[], fileResults: FileResult[] | null, error: string | null,
  partial: boolean,
) {
  return (
    <Page title="Financial Setup" active="finConfig" tenant={tenant} role={role} vocab={vocab as never} partial={partial}>
      <div class="fin-note">
        Drop everything you have — P&L exports, bank/card exports, receipts — and
        each file gets checked and classified. Nothing here maps divisions, proposes
        a budget, or calculates rates yet; this is intake and an honest picture of
        what's covered and what isn't.
      </div>

      <Card title="Upload financial documents" sub="P&L / bank exports (CSV) and receipts (image/PDF), any mix, all at once">
        <form
          method="post"
          action={`${basePath}/upload?tenant_id=${encodeURIComponent(tenant ?? "")}&role=${role}`}
          enctype="multipart/form-data"
        >
          <input type="file" name="files" multiple required data-testid="onboarding-file-input" />
          <button
            type="submit"
            data-testid="onboarding-submit"
            style="display:block;margin-top:12px;background:var(--gw-pine);color:#fff;border:0;border-radius:var(--gw-r-sm);padding:9px 18px;font-size:13px;font-weight:700;cursor:pointer"
          >
            Upload &amp; classify
          </button>
        </form>
        {error && (
          <div class="fin-note" data-testid="onboarding-error" style="border-left-color:var(--gw-rose);margin-top:12px">Error: {error}</div>
        )}
      </Card>

      {fileResults ? (
        <Card title="This upload" sub={`${fileResults.length} file${fileResults.length === 1 ? "" : "s"}`}>
          <div data-testid="onboarding-file-results">
            <table class="fin-table">
              <thead>
                <tr><th>File</th><th>Detected as</th><th>Status</th></tr>
              </thead>
              <tbody>
                {fileResults.map((f, i) => (
                  <tr data-testid={`file-result-${i}`}>
                    <td>{f.filename}</td>
                    <td>{f.detectedLabel}</td>
                    <td>
                      {f.duplicate ? (
                        <span class="fin-badge b-human" data-testid={`file-status-${i}`}>duplicate</span>
                      ) : f.domain === "unrecognized" ? (
                        <span class="fin-badge b-low" data-testid={`file-status-${i}`}>unrecognized</span>
                      ) : f.needsReview ? (
                        <span class="fin-badge b-low" data-testid={`file-status-${i}`}>needs review</span>
                      ) : (
                        <span class="fin-badge b-high" data-testid={`file-status-${i}`}>ok</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      <Card title="Where things stand" sub="one row per data domain — reflects everything uploaded to date, not just this batch">
        <div data-testid="confidence-gap-report">
          <table class="fin-table">
            <thead>
              <tr><th>Domain</th><th>Status</th><th>Detail</th></tr>
            </thead>
            <tbody>
              {gap.map((g, i) => (
                <tr data-testid={`gap-row-${i}`}>
                  <td><strong>{g.domain}</strong></td>
                  <td>
                    <span
                      class={`fin-badge ${g.state === "good" ? "b-high" : g.state === "review" ? "b-med" : "b-human"}`}
                      data-testid={`gap-state-${i}`}
                    >
                      {gapLabel(g.state)}
                    </span>
                  </td>
                  <td class="fin-card-s">{g.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Why
          what="Whether each data domain this system depends on has real data, and whether that data is trustworthy."
          source="Company Policy (set up or not), Financial Exports and Receipts (uploaded here, tracked in upload_batch and receipt)."
          matters="A domain marked missing or needs-review is a real gap, not a rounding error — nothing downstream fabricates around it."
          moves="Uploading here, or setting up Company Policy at Setup & Config."
        />
      </Card>

      <div class="fin-note">
        Not built yet, deliberately: division mapping, account renaming, overhead vs.
        job-cost reclassification review, budget generation, rate-calculation review,
        and the final "activate Financial Control" step. These need real classified
        data accumulating first.
      </div>
    </Page>
  );
}

onboardingRouter.get("/", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const partial = isPartialRequest(c);
  if (!canSee(role, "can_manage_receipts")) {
    return c.html(
      <Page title="Financial Setup" active="finConfig" role={role} partial={partial}>
        <Card>
          <div class="fin-empty" data-testid="denied">
            <div class="fin-empty-t">Not available for your role</div>
            <div class="fin-empty-s">Financial setup and onboarding is limited to office and owner roles.</div>
          </div>
        </Card>
      </Page>,
      403,
    );
  }
  const gap = await computeConfidenceGap(c.env.DB, tenant_id);
  return c.html(renderPage(role, tenant_id || undefined, vocab, c.req.path, gap, null, null, partial));
});

onboardingRouter.post("/upload", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const basePath = c.req.path.replace(/\/upload$/, "");
  const partial = isPartialRequest(c);
  if (!canSee(role, "can_manage_receipts")) return c.html(<Page title="Financial Setup" active="finConfig" role={role} partial={partial}><Card><div class="fin-empty" data-testid="denied"><div class="fin-empty-t">Not available for your role</div></div></Card></Page>, 403);

  const form = await c.req.parseBody({ all: true });
  const rawFiles = form.files;
  const files = (Array.isArray(rawFiles) ? rawFiles : rawFiles ? [rawFiles] : []).filter(
    (f): f is File => f instanceof File && f.size > 0,
  );

  if (files.length === 0) {
    const gap = await computeConfidenceGap(c.env.DB, tenant_id);
    return c.html(renderPage(role, tenant_id || undefined, vocab, basePath, gap, null, "no files selected", partial), 400);
  }

  const ownerId = c.var.repId ?? "office-upload";
  const fileResults: FileResult[] = [];

  for (const file of files) {
    const id = `ub-${crypto.randomUUID().slice(0, 12)}`;
    if (isCsvLike(file)) {
      const text = await file.text();
      const result = await ingestFile(c.env.DB, tenant_id, text, ownerId);
      const domain: UploadDomain = result.source_id ? "financial_export" : "unrecognized";
      const anyLineNeedsReview = result.lines.some((l) => l.needs_review);
      await insertUploadBatch(c.env.DB, {
        id, company_id: tenant_id, filename: file.name, domain,
        detected_source_id: result.source_id, needs_review: anyLineNeedsReview ? 1 : 0,
        row_count: result.total_rows,
      });
      fileResults.push({
        filename: file.name,
        detectedLabel: result.source_label ?? "Unrecognized format",
        domain, needsReview: anyLineNeedsReview, duplicate: false,
      });
    } else if (isReceiptLike(file)) {
      const bytes = await file.arrayBuffer();
      const result = await processReceiptUpload(c.env.DB, c.env.RECEIPTS, {
        company_id: tenant_id, job_id: null, bytes, filename: file.name,
        // No OCR yet (PUNCHLIST.md's documented gap) — blank fields, honestly
        // low-confidence, not guessed.
        extract: async () => ({ vendor: null, amount_cents: null, receipt_date: null }),
        reviewOwnerId: ownerId, reviewOwnerRole: role,
      });
      const isDuplicate = result.status === "duplicate";
      const needsReviewFlag = result.status === "stored" && result.needs_review;
      if (!isDuplicate) {
        await insertUploadBatch(c.env.DB, {
          id, company_id: tenant_id, filename: file.name, domain: "receipt",
          detected_source_id: null, needs_review: needsReviewFlag ? 1 : 0, row_count: null,
        });
      }
      fileResults.push({
        filename: file.name, detectedLabel: "Receipt", domain: "receipt",
        needsReview: needsReviewFlag, duplicate: isDuplicate,
      });
    } else {
      await insertUploadBatch(c.env.DB, {
        id, company_id: tenant_id, filename: file.name, domain: "unrecognized",
        detected_source_id: null, needs_review: 0, row_count: null,
      });
      fileResults.push({
        filename: file.name, detectedLabel: "Unrecognized file type", domain: "unrecognized",
        needsReview: false, duplicate: false,
      });
    }
  }

  const gap = await computeConfidenceGap(c.env.DB, tenant_id);
  return c.html(renderPage(role, tenant_id || undefined, vocab, basePath, gap, fileResults, null, partial));
});
