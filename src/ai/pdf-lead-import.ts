/**
 * PDF-to-lead import — core, framework-independent logic.
 *
 * Mirrors the architecture of src/ai/receipts.ts (hash-dedupe, injected
 * `extract()` callback so the actual PDF-parsing/AI call has no logic of its
 * own to test) and src/api/receipt-posting.ts (write-once-guard-first
 * idempotency), but for the CRM's lead-creation flow, never the finance
 * ledger. See migrations/0089_pdf_lead_import.sql for the schema this
 * module reads and writes.
 *
 * HARD INVARIANT (spec's non-negotiable constraint): AI output here is
 * always a suggestion. Nothing in this module creates or alters a CRM
 * record as a side effect of extraction/parsing — only `confirmLeadImport`
 * (added in a later commit, once matching/division/client creation exist)
 * does that, and only in response to an explicit, authenticated confirm
 * action.
 */

// ── PDF extraction (unpdf, Workers-compatible) ──────────────────────────────

// Named limits — see spec's "use named constants" requirement. Values chosen
// conservatively for Workers' CPU-time budget (PDF parsing + a downstream AI
// call must fit inside one request) and to bound worst-case R2/D1 storage.
export const MAX_PDF_BYTES = 15 * 1024 * 1024; // 15 MB — matches the existing photo/media upload cap (src/portal.tsx)
export const MAX_PDF_PAGES = 40;
export const MAX_EXTRACTED_TEXT_CHARS = 60_000; // matches the existing email-import slice(0, 60000) intake cap in app_premium.js
export const MAX_MODEL_INPUT_CHARS = 16_000; // matches the existing /api/ai/parse-lead emailText.slice(0, 16000)
export const PARSE_TIMEOUT_MS = 20_000; // unpdf text extraction budget
export const MODEL_TIMEOUT_MS = 45_000; // AI chat-completion call budget
export const MAX_BULK_FILES = 10;
export const MAX_BULK_TOTAL_BYTES = 60 * 1024 * 1024; // conservative total-batch cap, well under Workers' request body limits
export const BULK_PARSE_CONCURRENCY = 3;
export const ABANDONED_RETENTION_HOURS = 72;

/** The magic bytes every valid PDF must start with: "%PDF-". */
const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

export type PdfValidationError =
  | "empty_file"
  | "too_large"
  | "not_pdf" // magic-byte check failed
  | "encrypted" // PDF requires a password unpdf/pdf.js cannot supply
  | "malformed" // pdf.js could not parse the document structure
  | "too_many_pages"
  | "no_extractable_text" // parsed fine, but contains no meaningful text (e.g. scanned/image-only)
  | "parse_timeout";

export interface PdfValidationResult {
  ok: boolean;
  error?: PdfValidationError;
  message?: string;
  pageCount?: number;
  text?: string;
}

/** Human-facing, never-leak-internals error copy for each validation failure. */
export const PDF_ERROR_MESSAGES: Record<PdfValidationError, string> = {
  empty_file: "That file is empty. Please choose a valid PDF.",
  too_large: `That PDF is larger than the ${Math.round(MAX_PDF_BYTES / (1024 * 1024))} MB limit. Try a smaller file, or split it into separate documents.`,
  not_pdf: "That file doesn't look like a PDF. Please upload a .pdf file.",
  encrypted: "This PDF is password-protected. Please remove the password and upload it again.",
  malformed: "This PDF could not be read — it may be corrupted. Try re-saving or re-exporting it.",
  too_many_pages: `This PDF has more than ${MAX_PDF_PAGES} pages, which is more than this import can process. Try splitting it into smaller documents.`,
  no_extractable_text:
    "This PDF doesn't contain any readable text (it looks like a scanned image or photo). Scanned/image-only PDFs are not supported yet — please use a PDF exported directly from the source document, or use the email/paste-text import instead.",
  parse_timeout: "This PDF took too long to read. Try a smaller or simpler file.",
};

/** True when the first 5 bytes match the PDF magic number ("%PDF-"). */
export function hasPdfMagicBytes(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < PDF_MAGIC.length) return false;
  const head = new Uint8Array(bytes, 0, PDF_MAGIC.length);
  return head.every((b, i) => b === PDF_MAGIC[i]);
}

/**
 * Rejects an obviously-not-meaningful extraction. Deliberately simple
 * (length + non-whitespace check) rather than a language/quality heuristic —
 * the spec's target case is a scanned/image-only PDF, which pdf.js will
 * return as an EMPTY or near-empty string for (no text layer to extract at
 * all), not a PDF with unusual-but-real text.
 */
function hasMeaningfulText(text: string): boolean {
  return text.replace(/\s+/g, "").length >= 20;
}

/**
 * Injected PDF-library call, so this function's own validation/branching
 * logic (the part worth testing exhaustively) is decoupled from the actual
 * unpdf/pdf.js call — same pattern as receipts.ts's `extract` callback.
 * The real caller passes a thin wrapper around
 * `unpdf.getDocumentProxy`/`unpdf.extractText`; tests pass a fake that
 * throws unpdf's own exception types (or returns canned text) without
 * needing a real binary PDF fixture for every branch.
 */
export type PdfExtractor = (bytes: ArrayBuffer) => Promise<{ totalPages: number; text: string }>;

/**
 * Validate + extract text from an uploaded PDF's raw bytes.
 *
 * Order matters and mirrors the spec's own enumerated validation list:
 * empty -> too large -> magic bytes -> (library) encrypted/malformed ->
 * too many pages -> no extractable text. Every branch returns a distinct,
 * named error — never a generic "invalid file" — so the review UI can show
 * PDF_ERROR_MESSAGES[error] verbatim.
 *
 * NEVER rasterizes and NEVER falls back to a vision model for image-only
 * PDFs — per the spec's explicit "no rasterization, no vision fallback"
 * constraint, `no_extractable_text` is a terminal, user-facing error, not a
 * trigger for a second extraction attempt.
 */
export async function validateAndExtractPdf(
  bytes: ArrayBuffer,
  extractor: PdfExtractor,
): Promise<PdfValidationResult> {
  if (bytes.byteLength === 0) return { ok: false, error: "empty_file" };
  if (bytes.byteLength > MAX_PDF_BYTES) return { ok: false, error: "too_large" };
  if (!hasPdfMagicBytes(bytes)) return { ok: false, error: "not_pdf" };

  let extracted: { totalPages: number; text: string };
  try {
    extracted = await withTimeout(extractor(bytes), PARSE_TIMEOUT_MS, "parse_timeout");
  } catch (e: any) {
    const name = String(e?.name || "");
    const message = String(e?.message || e || "");
    if (message === "parse_timeout") return { ok: false, error: "parse_timeout" };
    // unpdf re-exports pdf.js's own exception classes (PasswordException,
    // InvalidPDFException) — matched by name so a fake extractor in tests
    // can throw a plain `Error` with the same `.name` without depending on
    // pdf.js's actual class identity.
    if (name === "PasswordException") return { ok: false, error: "encrypted" };
    if (name === "InvalidPDFException" || name === "UnknownErrorException") {
      return { ok: false, error: "malformed" };
    }
    return { ok: false, error: "malformed" };
  }

  if (extracted.totalPages > MAX_PDF_PAGES) return { ok: false, error: "too_many_pages", pageCount: extracted.totalPages };

  const text = String(extracted.text || "").slice(0, MAX_EXTRACTED_TEXT_CHARS);
  if (!hasMeaningfulText(text)) return { ok: false, error: "no_extractable_text", pageCount: extracted.totalPages };

  return { ok: true, pageCount: extracted.totalPages, text };
}

function withTimeout<T>(p: Promise<T>, ms: number, timeoutError: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(timeoutError)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// ── Content hashing + filename safety ───────────────────────────────────────

/** SHA-256 hex digest via Web Crypto — identical approach to receipts.ts's computeContentHash. */
export async function computeContentHash(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Sanitize a browser-supplied filename for safe use in R2 keys, HTML
 * attributes, and Content-Disposition headers. Same disallow-list spirit as
 * src/portal.tsx's media upload (`.replace(/[^\w.\- ]/g, '_')`), widened to
 * also allow parentheses — a common, harmless filename character (e.g.
 * "Proposal (1).pdf") that is not unsafe in any of those contexts — and
 * extended with a "did sanitization leave anything real behind?" check:
 * path-traversal/punctuation-only input (e.g. "../../../") survives the
 * character replace as dots/underscores, which is not a real filename and
 * must fall back to the default, not be trusted as-is.
 */
export function safeFilename(name: string): string {
  const sanitized = String(name || "").replace(/[^\w.\-() ]/g, "_").slice(0, 120);
  const hasRealContent = /[A-Za-z0-9]/.test(sanitized);
  return hasRealContent ? sanitized : "upload.pdf";
}

/**
 * The R2 object key for a document. NEVER derived from the raw/original
 * filename (per spec) — uses only the tenant id, a server-generated
 * document id, and the content hash, so a malicious filename (path
 * traversal, header-injection payloads, etc.) can never influence storage
 * location. The safe (sanitized) filename is stored purely for display and
 * appended for human debuggability, never trusted as an identifier.
 */
export function documentR2Key(companyId: string, documentId: string, hash: string, safeName: string): string {
  return `lead-imports/${companyId}/${documentId}/${hash.slice(0, 16)}_${safeName}`;
}

// ── Lifecycle state machine ─────────────────────────────────────────────────

export type LeadImportStatus =
  | "temporary" | "uploaded" | "extracting" | "parsing" | "needs_review"
  | "ready" | "creating" | "finalized" | "failed" | "abandoned" | "expired";

export type DocumentStatus = "uploaded" | "finalized" | "abandoned" | "expired";

/**
 * Legal forward transitions. Enforced by callers (not the DB — SQLite CHECK
 * constraints only validate the value is in the enum, not the transition),
 * so this table is the single source of truth for "can this import move
 * from A to B". `failed` is reachable from every in-flight state (a step can
 * always fail) and is itself retryable back into the state that failed —
 * modeled here as `failed -> *` being allowed for every non-terminal state,
 * so a retry simply re-attempts the same transition.
 */
const LEGAL_TRANSITIONS: Record<LeadImportStatus, LeadImportStatus[]> = {
  temporary: ["uploaded", "failed", "abandoned"],
  uploaded: ["extracting", "failed", "abandoned"],
  extracting: ["parsing", "needs_review", "failed"],
  parsing: ["needs_review", "ready", "failed"],
  needs_review: ["needs_review", "ready", "failed", "abandoned"],
  ready: ["creating", "needs_review", "failed"],
  creating: ["finalized", "failed"],
  finalized: [], // terminal — a finalized import is never moved again
  failed: ["extracting", "parsing", "ready", "creating", "abandoned"], // retry re-enters the step that failed
  abandoned: [], // terminal
  expired: [], // terminal
};

export function canTransition(from: LeadImportStatus, to: LeadImportStatus): boolean {
  if (from === to) return true; // idempotent no-op transition (e.g. re-saving the same review state)
  return LEGAL_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Statuses in which an import may still be edited/retried by its uploader. */
export function isRetryable(status: LeadImportStatus): boolean {
  return status === "failed" || status === "needs_review" || status === "ready";
}

/** Statuses that represent a finished, immutable outcome. */
export function isTerminal(status: LeadImportStatus): boolean {
  return status === "finalized" || status === "abandoned" || status === "expired";
}

// ── Confidence labeling (spec: no false numerical precision) ───────────────

export type ConfidenceLabel = "found_clearly" | "suggested_from_scope" | "possible_match" | "needs_review" | "missing";

export const CONFIDENCE_DISPLAY: Record<ConfidenceLabel, string> = {
  found_clearly: "Found clearly",
  suggested_from_scope: "Suggested from scope",
  possible_match: "Possible match",
  needs_review: "Needs review",
  missing: "Missing",
};

// ── Missing-information helper (live-derived, never persisted) ─────────────
//
// Spec: do NOT persist a `missing_fields` JSON column (goes stale after
// edits) — derive live from canonical CRM record shape, using stable
// machine keys kept separate from any display label. A usable person OR
// company name satisfies contact_identity; a usable phone OR email
// satisfies contact_method (never report both missing if either is
// present); a usable address satisfies property_address.

export type MissingInfoKey = "contact_identity" | "property_address" | "contact_method";

export interface CanonicalLeadRecord {
  personName?: string | null;
  companyName?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
}

const usable = (v: string | null | undefined): boolean => !!v && v.trim().length > 0;

/** Returns the list of missing concept keys — empty when nothing is missing. */
export function deriveMissingInfo(record: CanonicalLeadRecord): MissingInfoKey[] {
  const missing: MissingInfoKey[] = [];
  if (!usable(record.personName) && !usable(record.companyName)) missing.push("contact_identity");
  if (!usable(record.address)) missing.push("property_address");
  if (!usable(record.phone) && !usable(record.email)) missing.push("contact_method");
  return missing;
}

export const MISSING_INFO_LABELS: Record<MissingInfoKey, string> = {
  contact_identity: "Contact name or company",
  property_address: "Property / service address",
  contact_method: "Phone or email",
};

// ── Abandoned-import cleanup (retention) ────────────────────────────────────
//
// Spec: a `temporary`/in-progress import that is never confirmed becomes
// eligible for cleanup after ABANDONED_RETENTION_HOURS. This function is the
// implementation the migration's own doc comment refers to
// ("cleanupAbandonedImports()'s own guard and its tests") — it exists but is
// NEVER auto-executed against production: nothing in this codebase calls it
// on a schedule. The only invocation path is the secret-header-authenticated
// POST /internal/cron/lead-import-cleanup route (src/api/cron-trigger.ts),
// mirroring the existing nightly-rollup pattern — an external scheduler
// (GitHub Actions) calls it, never a Cloudflare Workers `triggers` cron
// (unsupported by this project's hosted-deploy path — see wrangler.jsonc's
// own constraints). Even that route requires an explicit, deliberate call;
// this module itself never runs anything on its own.
//
// HARD GUARDS (non-negotiable, same spirit as confirmLeadImport's
// write-once ordering):
//   1. NEVER touches a `finalized` import/document — the WHERE clause below
//      only ever selects rows in a non-terminal, non-finalized status.
//   2. NEVER deletes a row — only transitions status to 'abandoned' (a
//      legal transition from every non-terminal status per
//      LEGAL_TRANSITIONS above) and, per the spec's "do not retain complete
//      extracted text indefinitely" instruction, nulls out the bulky/
//      sensitive extracted_text and proposed_json columns on the import row
//      it just abandoned — status/timestamps/ids/warnings are kept for
//      audit purposes.
//   3. A document row backing an abandoned import is itself only moved to
//      'abandoned' if EVERY import referencing it is abandoned/failed/
//      expired — never if any import (including a different, still-active
//      one that later re-linked the same hash-deduped document) still needs
//      it. This mirrors the schema's own "document status must not be
//      forced backward by a second import" rule (see migrations/0088's doc
//      comment on lead_import_document.status).
//   4. Cursor-scoped by cutoff time using the SAME 'updated_at' column
//      every status transition in this router already stamps
//      (datetime('now')) — an import that's still being actively worked
//      (extended by a retry) keeps advancing its own updated_at and is
//      therefore never swept just because it was originally uploaded long
//      ago.

export interface CleanupAbandonedImportsResult {
  /** How many lead_import rows were moved to 'abandoned' this run. */
  importsAbandoned: number;
  /** How many lead_import_document rows were moved to 'abandoned' this run. */
  documentsAbandoned: number;
  /** import_id values actually abandoned — useful for audit logging/tests. */
  abandonedImportIds: string[];
}

/**
 * Every status a lead_import row can sit in that is NEITHER terminal
 * (finalized/abandoned/expired) NOR already-successfully-reviewed-and-
 * confirmed. Exported so cleanupAbandonedImports() (below) and
 * GET /api/lead-import/mine/pending (src/ai/lead-import-routes.ts, the
 * "resume an abandoned/in-progress import" entry point) share the exact
 * same list rather than each maintaining its own copy that could quietly
 * drift apart.
 */
export const NON_TERMINAL_NON_FINALIZED_STATUSES: LeadImportStatus[] = [
  "temporary", "uploaded", "extracting", "parsing", "needs_review", "ready", "creating", "failed",
];

/**
 * Sweeps every tenant's stalled lead-import rows (unless `companyId` is
 * given, scoping to just one) whose `updated_at` is older than
 * ABANDONED_RETENTION_HOURS AND whose status is still non-terminal/
 * non-finalized (temporary/uploaded/extracting/parsing/needs_review/ready/
 * creating/failed) into 'abandoned'. Never touches `finalized`,
 * already-`abandoned`, or already-`expired` rows — those are already
 * terminal and are simply skipped by the WHERE clause, not re-processed.
 *
 * dryRun=true computes and returns exactly what WOULD be changed without
 * writing anything — same contract as runNightlyRollup's own dry_run
 * parameter (src/cron/rollup.ts / src/api/cron-trigger.ts), so a human can
 * always preview a sweep before it runs for real.
 */
export async function cleanupAbandonedImports(
  db: D1Database,
  opts: { companyId?: string; dryRun?: boolean; now?: Date } = {},
): Promise<CleanupAbandonedImportsResult> {
  const cutoffIso = new Date(
    (opts.now ?? new Date()).getTime() - ABANDONED_RETENTION_HOURS * 60 * 60 * 1000,
  ).toISOString().replace("T", " ").slice(0, 19);

  const statusPlaceholders = NON_TERMINAL_NON_FINALIZED_STATUSES.map(() => "?").join(",");

  const params: any[] = [...NON_TERMINAL_NON_FINALIZED_STATUSES, cutoffIso];
  let companyClause = "";
  if (opts.companyId) {
    companyClause = " AND company_id = ?";
    params.push(opts.companyId);
  }

  const staleRes = await db.prepare(
    `SELECT id, company_id, document_id FROM lead_import
     WHERE status IN (${statusPlaceholders}) AND updated_at < ?${companyClause}`,
  ).bind(...params).all<{ id: string; company_id: string; document_id: string }>();
  const stale = staleRes.results || [];

  if (stale.length === 0) {
    return { importsAbandoned: 0, documentsAbandoned: 0, abandonedImportIds: [] };
  }

  const importIds = stale.map((r) => r.id);
  // A document can be referenced by more than one import (hash-deduped
  // reuse) — collect the distinct set touched this run so guard #3 above
  // can check EVERY import against each one, not just the stale ones.
  const documentIds = [...new Set(stale.map((r) => r.document_id).filter(Boolean))];

  if (opts.dryRun) {
    return { importsAbandoned: importIds.length, documentsAbandoned: 0, abandonedImportIds: importIds };
  }

  // Guard #2: transition to 'abandoned' AND null out the bulky/sensitive
  // retained fields on exactly the rows just selected — never a broader
  // UPDATE than the SELECT above already scoped.
  const idPlaceholders = importIds.map(() => "?").join(",");
  await db.prepare(
    `UPDATE lead_import
     SET status='abandoned', extracted_text='', proposed_json='', updated_at=datetime('now')
     WHERE id IN (${idPlaceholders})`,
  ).bind(...importIds).run();

  // Guard #3: only abandon a document if NONE of its imports are still in
  // an active (non-abandoned/failed/expired) state — re-check fresh from
  // the DB rather than assuming the stale set above is the complete answer
  // for shared/hash-deduped documents.
  let documentsAbandoned = 0;
  if (documentIds.length > 0) {
    const docIdPlaceholders = documentIds.map(() => "?").join(",");
    const stillActiveRes = await db.prepare(
      `SELECT DISTINCT document_id FROM lead_import
       WHERE document_id IN (${docIdPlaceholders})
         AND status NOT IN ('abandoned','failed','expired')`,
    ).bind(...documentIds).all<{ document_id: string }>();
    const stillActiveDocIds = new Set((stillActiveRes.results || []).map((r) => r.document_id));
    const fullyAbandonedDocIds = documentIds.filter((id) => !stillActiveDocIds.has(id));

    if (fullyAbandonedDocIds.length > 0) {
      const fadPlaceholders = fullyAbandonedDocIds.map(() => "?").join(",");
      // Documents are never in 'finalized' unless a confirm actually
      // happened for one of their imports — but guard explicitly anyway
      // (never touch a finalized document, belt-and-suspenders with
      // guard #1) rather than relying solely on the still-active check above.
      // Note: deliberately NOT using result.meta.rows_written here — D1/
      // SQLite's rows_written also counts secondary-index page writes (this
      // table has idx_lid_company_status on (company_id, status)), so it
      // can report more than the number of logical document rows changed.
      // fullyAbandonedDocIds.length is the actual candidate set already
      // guarded above (status != 'finalized' excludes nothing further here
      // since guard #1/#3 already kept finalized rows out of this set).
      await db.prepare(
        `UPDATE lead_import_document
         SET status='abandoned', updated_at=datetime('now')
         WHERE id IN (${fadPlaceholders}) AND status != 'finalized'`,
      ).bind(...fullyAbandonedDocIds).run();
      documentsAbandoned = fullyAbandonedDocIds.length;
    }
  }

  return { importsAbandoned: importIds.length, documentsAbandoned, abandonedImportIds: importIds };
}
