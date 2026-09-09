/**
 * PDF-to-lead import — core, framework-independent logic.
 *
 * Mirrors the architecture of src/ai/receipts.ts (hash-dedupe, injected
 * `extract()` callback so the actual PDF-parsing/AI call has no logic of its
 * own to test) and src/api/receipt-posting.ts (write-once-guard-first
 * idempotency), but for the CRM's lead-creation flow, never the finance
 * ledger. See migrations/0088_pdf_lead_import.sql for the schema this
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
