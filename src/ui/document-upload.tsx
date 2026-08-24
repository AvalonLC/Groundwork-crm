import { Hono } from "hono";
import { ingestFile, ingestXlsxFile } from "../ai/ingest";
import { processReceiptUpload, scoreFieldConfidence, type ExtractedReceiptFields } from "../ai/receipts";
import type { IngestResult } from "../ai/ingest";
import type { ProcessReceiptResult } from "../ai/receipts";
import { parseMoneyToCents } from "../ai/csv";
import { documentIntake } from "../config/finance-config";
import { canSee } from "./roles";
import type { VocabularyMode } from "./vocabulary";
import { readPageArgs, Page, Card, Why, Confidence, money, isPartialRequest, type FinanceAuthVars } from "./layout";

export type DocumentUploadBindings = { DB: D1Database; RECEIPTS: R2Bucket };

/** Mirrors onboarding.tsx's isCsvLike/isReceiptLike pattern — routes an
 * uploaded financial export to ingestXlsxFile (binary, grid-shape
 * detection) instead of ingestFile (text, header-row detection). See
 * src/ai/xlsx.ts / src/ai/ingest.ts's detectXlsxSource for why xlsx needs
 * a genuinely different parse path, not just a different MIME check. */
function isXlsxLike(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith(".xlsx") || file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}

/**
 * Item 2: src/ai/ingest.ts (ingestFile) and src/ai/receipts.ts
 * (processReceiptUpload) were built and gate-verified with no production
 * caller. This page is that caller. Two separate upload forms rather than
 * one auto-detecting dropzone: a CSV export needs nothing from the user
 * beyond the file (ingestFile calls detectSource internally and is honest
 * about a no-match — flags for review, never guesses); a receipt image
 * does need vendor/amount/date, and this build deliberately does NOT wire
 * up AI/OCR extraction for those fields — see the note on the receipt
 * card. That's a distinct follow-up, not silently faked here.
 *
 * No redirect-after-POST here (unlike config-admin.tsx/policy-setup.tsx):
 * results (ingest lines, gap report, per-field receipt confidence) are too
 * rich to round-trip through a query string, so POST handlers render the
 * result directly. A page refresh after submitting will resubmit — an
 * accepted tradeoff for an internal admin tool, not a hidden bug.
 */
export const documentUploadRouter = new Hono<{ Bindings: DocumentUploadBindings; Variables: FinanceAuthVars }>();

function deniedPage(role: string, partial: boolean) {
  return (
    <Page title="Upload Documents" active="finConfig" role={role} partial={partial}>
      <Card>
        <div class="fin-empty" data-testid="denied">
          <div class="fin-empty-t">Not available for your role</div>
          <div class="fin-empty-s">Uploading financial source documents requires an office or owner role.</div>
        </div>
      </Card>
    </Page>
  );
}

function ingestResultCard(result: IngestResult) {
  return (
    <Card title="Import result">
      <div data-testid="ingest-result">
      {result.source_id === null ? (
        <div class="fin-note" data-testid="ingest-unrecognized" style="border-left-color:var(--gw-amber)">
          Format not recognized against any configured import format
          (<code>config/finance/ingest.sources.json</code>). {result.total_rows} row
          {result.total_rows === 1 ? "" : "s"} found but not processed — flagged for review
          rather than guessed at.
        </div>
      ) : (
        <>
          <p class="fin-card-s" data-testid="ingest-source-label" style="margin-bottom:12px">
            Detected as <strong>{result.source_label}</strong> — {result.total_rows} row{result.total_rows === 1 ? "" : "s"}.
          </p>
          {result.lines.length > 0 ? (
            <table class="fin-table">
              <thead>
                <tr><th>Account</th><th>Division (raw)</th><th>Division (resolved)</th><th>Amount</th><th>Status</th></tr>
              </thead>
              <tbody>
                {result.lines.map((line, i) => (
                  <tr data-testid={`ingest-line-${i}`}>
                    <td>{line.account ?? "—"}</td>
                    <td>{line.division_raw ?? "—"}</td>
                    <td>{line.division ?? "—"}</td>
                    <td class="fin-num">{money(line.amount_cents)}</td>
                    <td>
                      {line.needs_review ? (
                        <span class="fin-badge b-low" data-testid={`ingest-review-${i}`}>needs review</span>
                      ) : (
                        <span class="fin-badge b-high">resolved</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {(result.gap_report.divisions_with_pool_but_no_pnl_line.length > 0 ||
            result.gap_report.pnl_divisions_with_no_matching_pool.length > 0) && (
            <div class="fin-note" data-testid="ingest-gap-report" style="margin-top:12px">
              {result.gap_report.divisions_with_pool_but_no_pnl_line.length > 0 && (
                <div>Has an overhead pool but no line in this file: {result.gap_report.divisions_with_pool_but_no_pnl_line.join(", ")}</div>
              )}
              {result.gap_report.pnl_divisions_with_no_matching_pool.length > 0 && (
                <div>In this file but no matching overhead pool: {result.gap_report.pnl_divisions_with_no_matching_pool.join(", ")}</div>
              )}
            </div>
          )}
        </>
      )}
      {result.review_action_item_ids.length > 0 && (
        <p class="fin-card-s" data-testid="ingest-review-count" style="margin-top:12px">
          <strong>{result.review_action_item_ids.length}</strong> item{result.review_action_item_ids.length === 1 ? "" : "s"} sent to the Work Queue for review.
        </p>
      )}
      </div>
    </Card>
  );
}

function receiptResultCard(result: ProcessReceiptResult, confidence: ReturnType<typeof scoreFieldConfidence> | null) {
  if (result.status === "duplicate") {
    return (
      <Card title="Upload result">
        <div data-testid="receipt-result">
          <div class="fin-note" data-testid="receipt-duplicate">
            This exact file was already uploaded (receipt {result.existing_receipt_id}) — not stored again.
          </div>
        </div>
      </Card>
    );
  }
  return (
    <Card title="Upload result">
      <div data-testid="receipt-result">
      <p class="fin-card-s" data-testid="receipt-id" style="margin-bottom:8px">Stored as {result.receipt_id}.</p>
      {confidence ? (
        <table class="fin-table">
          <thead><tr><th>Field</th><th>Confidence</th></tr></thead>
          <tbody>
            {(Object.keys(confidence) as (keyof ExtractedReceiptFields)[]).map((field) => (
              <tr data-testid={`receipt-field-${field}`}>
                <td>{field}</td>
                <td><Confidence level={confidence[field]} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {result.needs_review ? (
        <div class="fin-note" data-testid="receipt-needs-review" style="border-left-color:var(--gw-amber);margin-top:12px">
          One or more fields is low-confidence — sent to the Work Queue for review rather than
          accepted as-is.
        </div>
      ) : (
        <p class="fin-card-s" style="margin-top:12px">All fields entered — nothing sent to review.</p>
      )}
      </div>
    </Card>
  );
}

function renderPage(
  role: string, tenant: string | undefined, vocab: VocabularyMode, basePath: string,
  ingestResult: IngestResult | null, ingestError: string | null,
  receiptResult: ProcessReceiptResult | null, receiptConfidence: ReturnType<typeof scoreFieldConfidence> | null, receiptError: string | null,
  partial: boolean,
) {
  // Carries tenant_id/role forward explicitly, same as config-admin.tsx and
  // policy-setup.tsx's own forms — c.req.path alone (used for basePath)
  // drops the query string, and this page has no session to fall back to
  // outside the live app mount.
  const qs = `?tenant_id=${encodeURIComponent(tenant ?? "")}&role=${role}`;
  return (
    <Page title="Upload Documents" active="finConfig" tenant={tenant} role={role} vocab={vocab} partial={partial}>
      <div class="fin-note">
        Financial exports get checked against known formats and reconciled against your
        overhead pools. Receipts get stored and deduped by content, with anything uncertain
        sent to the Work Queue instead of guessed at.
      </div>

      <Card title="Upload a financial export" sub="P&L, class/division P&L, balance sheet, bank/card CSV or Excel, or payroll export">
        <form method="post" action={`${basePath}/ingest${qs}`} enctype="multipart/form-data">
          <input
            type="file" name="file" required data-testid="ingest-file-input"
            accept=".csv,text/csv,text/plain,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          />
          <button type="submit" data-testid="ingest-submit" style="display:block;margin-top:12px;background:var(--gw-pine);color:#fff;border:0;border-radius:var(--gw-r-sm);padding:9px 18px;font-size:13px;font-weight:700;cursor:pointer">
            Upload export
          </button>
        </form>
        {ingestError && (
          <div class="fin-note" data-testid="ingest-error" style="border-left-color:var(--gw-rose);margin-top:12px">Error: {ingestError}</div>
        )}
      </Card>
      {ingestResult ? ingestResultCard(ingestResult) : null}

      <Card title="Upload a receipt" sub="image or PDF, plus what's on it">
        <form method="post" action={`${basePath}/receipt${qs}`} enctype="multipart/form-data">
          <div style="margin-bottom:12px">
            <input type="file" name="file" accept="image/*,.pdf" required data-testid="receipt-file-input" />
          </div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">
            <label style="font-size:13px">
              Vendor<br />
              <input type="text" name="vendor" data-testid="receipt-vendor-input" style="padding:8px 10px;border:1px solid var(--gw-line-strong);border-radius:var(--gw-r-sm);font-size:13px" />
            </label>
            <label style="font-size:13px">
              Amount<br />
              <input type="text" name="amount" inputmode="decimal" placeholder="0.00" data-testid="receipt-amount-input" style="padding:8px 10px;border:1px solid var(--gw-line-strong);border-radius:var(--gw-r-sm);font-size:13px;width:120px" />
            </label>
            <label style="font-size:13px">
              Date<br />
              <input type="date" name="receipt_date" data-testid="receipt-date-input" style="padding:8px 10px;border:1px solid var(--gw-line-strong);border-radius:var(--gw-r-sm);font-size:13px" />
            </label>
          </div>
          <p class="fin-card-s" style="margin-bottom:12px">
            Fields are typed in, not read off the image automatically — this build doesn't wire
            up AI extraction yet. Leave a field blank if you're not sure; it'll be flagged for
            review instead of guessed at.
          </p>
          <button type="submit" data-testid="receipt-submit" style="background:var(--gw-pine);color:#fff;border:0;border-radius:var(--gw-r-sm);padding:9px 18px;font-size:13px;font-weight:700;cursor:pointer">
            Upload receipt
          </button>
        </form>
        {receiptError && (
          <div class="fin-note" data-testid="receipt-error" style="border-left-color:var(--gw-rose);margin-top:12px">Error: {receiptError}</div>
        )}
      </Card>
      {receiptResult ? receiptResultCard(receiptResult, receiptConfidence) : null}

      <Why
        what="The two source-document pipelines behind the classifier and job costing: financial exports and receipts."
        source="Uploaded here, checked against configured formats, and either resolved or sent to the Work Queue."
        matters="These are the raw inputs everything downstream reads — wrong or missing input here means wrong numbers everywhere else."
        moves="Every upload. Nothing here is scheduled or automatic yet."
      />
    </Page>
  );
}

/** GET is mounted at the router root, so c.req.path there IS the base
 * ("/upload" in dev-server, "/finance/upload" live). POST handlers hang off
 * "/ingest" and "/receipt" beneath it — strip that suffix to recover the
 * same base for building the redisplayed form's action attributes. */
function basePathFor(c: { req: { path: string } }): string {
  return c.req.path.replace(/\/(ingest|receipt)$/, "");
}

documentUploadRouter.get("/", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const partial = isPartialRequest(c);
  if (!canSee(role, "can_manage_receipts")) return c.html(deniedPage(role, partial), 403);
  return c.html(renderPage(role, tenant_id || undefined, vocab, basePathFor(c), null, null, null, null, null, partial));
});

documentUploadRouter.post("/ingest", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const basePath = basePathFor(c);
  const partial = isPartialRequest(c);
  if (!canSee(role, "can_manage_receipts")) return c.html(deniedPage(role, partial), 403);

  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File) || file.size === 0) {
    return c.html(renderPage(role, tenant_id || undefined, vocab, basePath, null, "no file selected", null, null, null, partial), 400);
  }

  const ownerId = c.var.repId ?? "office-upload";
  const result = isXlsxLike(file)
    ? await ingestXlsxFile(c.env.DB, tenant_id, await file.arrayBuffer(), ownerId)
    : await ingestFile(c.env.DB, tenant_id, await file.text(), ownerId);
  return c.html(renderPage(role, tenant_id || undefined, vocab, basePath, result, null, null, null, null, partial));
});

documentUploadRouter.post("/receipt", async (c) => {
  const { tenant_id, role, vocab } = readPageArgs(c);
  const basePath = basePathFor(c);
  const partial = isPartialRequest(c);
  if (!canSee(role, "can_manage_receipts")) return c.html(deniedPage(role, partial), 403);

  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File) || file.size === 0) {
    return c.html(renderPage(role, tenant_id || undefined, vocab, basePath, null, null, null, null, "no file selected", partial), 400);
  }
  // config/finance/document-intake.json: Tyler's accepted types (PDF, JPG/
  // JPEG, PNG, HEIC where supported) and 10MB size ceiling for the manual/
  // mobile-camera upload channels — checked here rather than only in the
  // <input accept="..."> attribute, which a user can bypass.
  if (file.size > documentIntake.max_file_size_bytes) {
    const maxMb = Math.round(documentIntake.max_file_size_bytes / 1024 / 1024);
    return c.html(renderPage(role, tenant_id || undefined, vocab, basePath, null, null, null, null, `file too large — max ${maxMb} MB`, partial), 413);
  }
  const nameLower = file.name.toLowerCase();
  const extOk = documentIntake.accepted_extensions.some((ext) => nameLower.endsWith(ext));
  const mimeOk = documentIntake.accepted_mime_types.includes(file.type);
  if (!extOk && !mimeOk) {
    return c.html(renderPage(role, tenant_id || undefined, vocab, basePath, null, null, null, null, "unsupported file type — accepted: PDF, JPG, PNG, HEIC", partial), 400);
  }

  const vendorRaw = String(form.vendor ?? "").trim();
  const amountRaw = String(form.amount ?? "").trim();
  const dateRaw = String(form.receipt_date ?? "").trim();
  const amountCents = amountRaw ? parseMoneyToCents(amountRaw) : null;
  if (amountCents !== null && (!Number.isFinite(amountCents) || amountCents < 0)) {
    return c.html(renderPage(role, tenant_id || undefined, vocab, basePath, null, null, null, null, "amount must be a non-negative number", partial), 400);
  }

  const fields: ExtractedReceiptFields = {
    vendor: vendorRaw || null,
    amount_cents: amountCents,
    receipt_date: dateRaw || null,
  };
  const confidence = scoreFieldConfidence(fields);
  const ownerId = c.var.repId ?? "office-upload";
  const bytes = await file.arrayBuffer();

  const result = await processReceiptUpload(c.env.DB, c.env.RECEIPTS, {
    company_id: tenant_id, job_id: null, bytes, filename: file.name,
    extract: async () => fields,
    reviewOwnerId: ownerId, reviewOwnerRole: role,
  });

  const shownConfidence = result.status === "stored" ? confidence : null;
  return c.html(renderPage(role, tenant_id || undefined, vocab, basePath, null, null, result, shownConfidence, null, partial));
});
