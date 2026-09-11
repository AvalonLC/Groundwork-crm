/**
 * PDF-to-lead import — authenticated API, mounted at /api/lead-import.
 *
 * Standalone router (plain Hono, no auth of its own), following the exact
 * pattern already used for marketingRouter (src/marketing/api.ts) and
 * ratesRouter (src/api/rates.ts): requireAuth is applied at the MOUNT POINT
 * in src/index.tsx, not inside this file, so:
 *   1. every handler here can rely on c.var.companyId / c.var.repId already
 *      being set, and
 *   2. this router stays importable/testable on its own (see
 *      src/ai/lead-import-routes.test.ts), using the same authedAs() test
 *      harness pattern as src/api/rates.test.ts.
 *
 * This file intentionally uses raw `c.json({ ok, ... })` responses rather
 * than importing `json`/`err` from src/index.tsx. index.tsx must import
 * `leadImportRouter` FROM this file to mount it — importing `json`/`err`
 * back OUT of index.tsx into this file would recreate exactly the kind of
 * import cycle that src/ai/infra.ts and src/activity-log.ts were extracted
 * to avoid. marketingRouter/ratesRouter/actionsRouter follow the same rule
 * for the same reason (see src/marketing/api.ts) — this is not a new
 * convention, just the existing one applied here too.
 *
 * HARD INVARIANT carried over from src/ai/pdf-lead-import.ts and
 * src/ai/lead-import-parse.ts: AI output is always a SUGGESTION. Nothing in
 * this router creates or alters a CRM record except the POST /:id/confirm
 * route below, and only in response to an explicit, authenticated confirm
 * action — never as a side effect of upload/extraction/parsing.
 */

import { Hono } from "hono";
import { extractText, getDocumentProxy } from "unpdf";
import type { AppEnv } from "../env";
import { rateLimit } from "../portal";
import { randomToken } from "../marketing/send";
import {
  hasPdfMagicBytes, computeContentHash, safeFilename, documentR2Key,
  validateAndExtractPdf, canTransition, deriveMissingInfo,
  PDF_ERROR_MESSAGES, MAX_PDF_BYTES, MAX_BULK_FILES, MAX_BULK_TOTAL_BYTES, BULK_PARSE_CONCURRENCY,
  type PdfExtractor, type LeadImportStatus, type PdfValidationError,
} from "./pdf-lead-import";
import {
  buildLeadImportMessages, normalizeLeadImportDraft, LEAD_IMPORT_DRAFT_SCHEMA,
  type LeadImportDraft,
} from "./lead-import-parse";
import { loadCompanyDivisions, classifyDivision, type DivisionClassificationResult } from "./lead-import-division";
import { _aiCreds, _aiChatJson, _aiParseJson, _aiQuotaGate, _logAiUsage } from "./infra";
import {
  findClientMatches, findPropertyMatches,
  type ExistingClientRow, type ExistingPropertyRow, type ClientMatchCandidate, type PropertyMatchCandidate,
} from "./lead-import-match";
import { insertOpportunityRow, resolveDefaultPipelineStage } from "../marketing/leads";
import { logActivity } from "../activity-log";

export const leadImportRouter = new Hono<AppEnv>();

// Server-generated id helper, matching the style of index.tsx's own
// (unexported) `uid()` and insertOpportunityRow's own id-gen fallback
// (src/marketing/leads.ts) — `uid()` itself is not exported from index.tsx,
// so this router needs its own equivalent rather than importing it (which
// would also recreate the index.tsx->router cycle).
function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

type IngestOutcome =
  | {
      ok: true;
      importId: string;
      documentId: string;
      idempotencyToken: string;
      duplicate: boolean;
      safeFilename: string;
    }
  | { ok: false; error: "not_pdf" | "storage_error"; message: string; status: number };

/**
 * Core "store one already-validated-size PDF's bytes and start a new
 * lead_import against it" logic — hash-dedupe, R2 write, document+import
 * row inserts. Extracted out of POST /upload (PR1) so the bulk upload route
 * (PR2, below) can ingest up to MAX_BULK_FILES files through the EXACT same
 * dedupe/idempotency path one file at a time, rather than a parallel
 * reimplementation that could quietly drift from the single-file behavior
 * LIU-01..LIU-0N already pin down.
 *
 * Deliberately does NOT do the magic-byte/size checks — those inspect the
 * raw `File` (its `.size` without needing to read it, an early-reject
 * optimization worth keeping at the call site) and are identical in both
 * callers, so each caller runs them before calling in.
 *
 * `batchId` is '' for a single-file import (matches the column's own
 * DEFAULT '') and the real batch id for a bulk-uploaded one.
 */
async function ingestPdfBytes(
  db: D1Database,
  media: R2Bucket,
  companyId: string,
  repId: string,
  bytes: ArrayBuffer,
  originalFilename: string,
  batchId: string,
): Promise<IngestOutcome> {
  if (!hasPdfMagicBytes(bytes)) {
    return { ok: false, error: "not_pdf", message: "That file doesn't look like a PDF. Please upload a .pdf file.", status: 400 };
  }

  const hash = await computeContentHash(bytes);
  const safeName = safeFilename(originalFilename);
  const contentType = "application/pdf"; // never trust the browser-supplied MIME type for storage — magic bytes already confirmed this is a PDF
  const size = bytes.byteLength;

  // Duplicate-hash lookup — the spec's idempotency/dedupe requirement.
  // Scoped by company_id (the unique index is (company_id, sha256_hash)), so
  // two different tenants uploading the same proposal template never
  // collide with each other.
  const existingDoc: any = await db.prepare(
    `SELECT id, r2_key, safe_filename, status FROM lead_import_document WHERE company_id=? AND sha256_hash=? LIMIT 1`
  ).bind(companyId, hash).first();

  const idemToken = randomToken(16);
  const importId = newId("limp");

  if (existingDoc) {
    // Same PDF bytes, already stored — never re-upload to R2, never create a
    // second lead_import_document row. Start a new lead_import (a fresh
    // review/parse attempt can still be wanted, e.g. re-importing the same
    // proposal for a different follow-up), pointed at the existing document.
    await db.prepare(
      `INSERT INTO lead_import (id, company_id, document_id, idempotency_token, status, parser_name, batch_id)
       VALUES (?,?,?,?, 'uploaded', 'unpdf', ?)`
    ).bind(importId, companyId, existingDoc.id, idemToken, batchId).run();

    return {
      ok: true,
      importId, documentId: existingDoc.id, idempotencyToken: idemToken,
      duplicate: true, safeFilename: existingDoc.safe_filename || safeName,
    };
  }

  const documentId = newId("lidoc");
  const r2Key = documentR2Key(companyId, documentId, hash, safeName);

  await media.put(r2Key, bytes, { httpMetadata: { contentType } });

  try {
    await db.prepare(
      `INSERT INTO lead_import_document
         (id, company_id, uploaded_by_rep_id, original_filename, safe_filename, r2_key, mime_type, byte_size, sha256_hash, upload_source, document_kind, status, import_id)
       VALUES (?,?,?,?,?,?,?,?,?, ?, 'unknown', 'uploaded', ?)`
    ).bind(
      documentId, companyId, repId || "", originalFilename.slice(0, 300), safeName, r2Key, contentType, size, hash,
      batchId ? "pdf_bulk" : "pdf_single", importId,
    ).run();
  } catch (e: any) {
    // Unique (company_id, sha256_hash) violation from a concurrent duplicate
    // upload racing this one — the R2 object we just wrote is an orphaned
    // duplicate of one that's about to exist (or just got created) under
    // the winning request's key; harmless to leave (content-addressed, no
    // dangling reference will ever point at it) but we don't reference it
    // further. Re-resolve against the row that won and proceed exactly like
    // the existingDoc branch above, rather than surfacing a 500 for what is
    // actually a successful, idempotent outcome.
    const winner: any = await db.prepare(
      `SELECT id, safe_filename FROM lead_import_document WHERE company_id=? AND sha256_hash=? LIMIT 1`
    ).bind(companyId, hash).first();
    if (!winner) {
      console.error("[lead-import/ingest]", e?.message || e);
      return { ok: false, error: "storage_error", message: "Could not save that document. Please try again.", status: 500 };
    }
    await db.prepare(
      `INSERT INTO lead_import (id, company_id, document_id, idempotency_token, status, parser_name, batch_id)
       VALUES (?,?,?,?, 'uploaded', 'unpdf', ?)`
    ).bind(importId, companyId, winner.id, idemToken, batchId).run();
    return {
      ok: true,
      importId, documentId: winner.id, idempotencyToken: idemToken,
      duplicate: true, safeFilename: winner.safe_filename || safeName,
    };
  }

  await db.prepare(
    `INSERT INTO lead_import (id, company_id, document_id, idempotency_token, status, parser_name, batch_id)
     VALUES (?,?,?,?, 'uploaded', 'unpdf', ?)`
  ).bind(importId, companyId, documentId, idemToken, batchId).run();

  return {
    ok: true,
    importId, documentId, idempotencyToken: idemToken,
    duplicate: false, safeFilename: safeName,
  };
}

// ── POST /api/lead-import/upload — single-file PDF upload ──────────────────
//
// multipart/form-data, field "file". Order mirrors src/ai/receipts.ts's
// processReceiptUpload (hash BEFORE storing/inserting) and src/portal.tsx's
// media-upload route (multipart parse -> arrayBuffer -> R2.put -> D1 insert):
//   1. Parse multipart, pull the file's ArrayBuffer (never readAsText — the
//      spec's "binary-safe" requirement; a PDF is binary, not text).
//   2. Cheap validation the router itself is responsible for (magic bytes,
//      size) BEFORE touching R2/D1 — validateAndExtractPdf's own deeper
//      validation (encrypted/malformed/no-text/too-many-pages) happens in
//      the extraction step, not here, since that requires the actual unpdf
//      call and this route's job is only to accept+store the file.
//   3. Hash the bytes. Look up (company_id, sha256_hash) in
//      lead_import_document — the spec's "never silently create a
//      duplicate" rule: a matching hash returns the EXISTING document and
//      starts a new lead_import row against it rather than writing a second
//      copy of the same PDF to R2.
//   4. On a genuinely new hash: R2.put() under documentR2Key(), then insert
//      lead_import_document + lead_import rows in that order (the document
//      row must exist before an import can reference it as a foreign key).
//
// Every id here (document id, import id, idempotency token) is server
// generated — the spec's "never accept a client-supplied trusted id"
// requirement applies just as much to the router layer as to the AI layer.
leadImportRouter.post("/upload", async (c) => {
  const db = c.env.DB as D1Database;
  const companyId = c.var.companyId as string;
  const repId = c.var.repId as string;

  // Reuses the portal's rate limiter — see src/portal.tsx's rateLimit() doc
  // comment for why this (not a dedicated CSRF token) is the "reuse"
  // component of the spec's CSRF/rate-limit requirement. Keyed per tenant so
  // one company's bulk activity can never exhaust another's budget.
  const rlOk = await rateLimit(db, `lead_import_upload_${companyId}`, 30, 300);
  if (!rlOk) {
    return c.json({ ok: false, error: "rate_limited", message: "Too many document uploads. Please wait a few minutes and try again." }, 429);
  }

  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ ok: false, error: "bad_request", message: "multipart/form-data required" }, 400);

  const file = form.get("file") as unknown as File | null;
  if (!file || typeof (file as any).arrayBuffer !== "function") {
    return c.json({ ok: false, error: "bad_request", message: "file field required" }, 400);
  }

  const size = Number((file as any).size) || 0;
  if (size === 0) return c.json({ ok: false, error: "empty_file", message: "That file is empty. Please choose a valid PDF." }, 400);
  if (size > MAX_PDF_BYTES) {
    return c.json({ ok: false, error: "too_large", message: `That PDF is larger than the ${Math.round(MAX_PDF_BYTES / (1024 * 1024))} MB limit. Try a smaller file, or split it into separate documents.` }, 413);
  }

  // ArrayBuffer, never readAsText/text() — a PDF is binary; reading it as
  // text would corrupt it before extraction ever runs (spec's explicit
  // "use ArrayBuffer, not readAsText" requirement).
  const bytes = await (file as any).arrayBuffer() as ArrayBuffer;
  const originalFilename = String((file as any).name || "upload.pdf");

  // batchId '' — this is the single-file upload route; ingestPdfBytes's
  // bulk caller (POST /bulk/upload, below) is the only one that ever
  // passes a real batch id.
  const result = await ingestPdfBytes(db, c.env.MEDIA as R2Bucket, companyId, repId, bytes, originalFilename, "");
  if (!result.ok) {
    return c.json({ ok: false, error: result.error, message: result.message }, result.status as any);
  }

  return c.json({
    ok: true,
    data: {
      import_id: result.importId,
      document_id: result.documentId,
      idempotency_token: result.idempotencyToken,
      status: "uploaded",
      duplicate: result.duplicate,
      safe_filename: result.safeFilename,
    },
  });
});

// The production unpdf extractor — identical to the one wired up in
// src/ai/pdf-lead-import.test.ts's `realExtractor` (that test file proved
// this exact call pattern works against the real Cloudflare Workers/
// workerd runtime). validateAndExtractPdf takes this as an injected
// callback so its own branching/validation logic stays independently
// testable without a real PDF fixture for every case (see that module's doc
// comment) — this is the one, and only, production wiring of it.
const realPdfExtractor: PdfExtractor = async (bytes) => {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return { totalPages, text: String(text || "") };
};

/**
 * Shared row-fetch + tenant-scope guard for every route below that acts on
 * an existing lead_import. Returns null (having already written the 404
 * response) when the row doesn't exist or belongs to a different tenant —
 * 404, not 403, so this never confirms to an attacker that an import id
 * exists for a company they aren't in (same convention as
 * src/portal.tsx's media routes).
 */
async function loadOwnedImport(db: D1Database, companyId: string, importId: string) {
  return db.prepare(
    `SELECT li.*, lid.r2_key, lid.safe_filename, lid.original_filename, lid.mime_type
     FROM lead_import li
     JOIN lead_import_document lid ON lid.id = li.document_id
     WHERE li.id=? AND li.company_id=? LIMIT 1`
  ).bind(importId, companyId).first<any>();
}

/**
 * Move a lead_import to a new status IF the transition is legal, writing
 * updated_at and (optionally) an error_message alongside it. Centralized so
 * every route that changes status goes through the same canTransition()
 * check — an illegal transition is a programming error in THIS router, not
 * a user-facing 400, so it throws rather than returning a response, and the
 * caller's own try/catch turns it into a failed-status write instead of an
 * unhandled 500.
 */
async function setImportStatus(
  db: D1Database, importId: string, from: LeadImportStatus, to: LeadImportStatus, extra: { errorMessage?: string } = {},
): Promise<void> {
  if (!canTransition(from, to)) {
    throw new Error(`illegal lead_import transition: ${from} -> ${to}`);
  }
  await db.prepare(
    `UPDATE lead_import SET status=?, error_message=?, updated_at=datetime('now') WHERE id=?`
  ).bind(to, extra.errorMessage || "", importId).run();
}

type ExtractOutcome =
  | { ok: true; status: "needs_review"; draft: LeadImportDraft; division: DivisionClassificationResult; warnings: string[]; missingInfo: string[]; pageCount: number }
  | { ok: true; status: "needs_review"; warning: string; pageCount: number } // AI-disabled/quota/upstream/parse-failure soft-degrade — no draft
  | { ok: false; error: string; message: string; httpStatus: number };

/**
 * Core "extract text from the stored PDF, then AI-parse it into a draft"
 * logic for ONE import row — extracted out of POST /:id/extract (PR1) so
 * the bulk extract route (PR2, below) can run this exact same two-phase
 * pipeline (with its exact same status-transition/soft-degrade behavior)
 * against every import in a batch, one row at a time, rather than a
 * parallel reimplementation that could quietly drift from what
 * LIX-01..LIXA-04 already pin down.
 *
 * Every status write happens inside here (not left to the caller) so a
 * caller iterating a batch never has to duplicate the same
 * setImportStatus() choreography per row.
 */
async function runExtraction(
  db: D1Database, env: { MEDIA: R2Bucket } & Record<string, any>, companyId: string, repId: string,
  importId: string, row: { status: string; r2_key: string; original_filename?: string },
): Promise<ExtractOutcome> {
  const current = row.status as LeadImportStatus;
  const RETRY_ENTRY: LeadImportStatus[] = ["uploaded", "extracting", "parsing", "needs_review", "failed"];
  if (!RETRY_ENTRY.includes(current)) {
    return { ok: false, error: "invalid_state", message: `Cannot extract from status "${current}".`, httpStatus: 409 };
  }

  // ── Phase 1: extraction (re-reads the ALREADY-STORED PDF from R2 — the
  // spec's "re-run extraction reuses stored PDF, never asks to re-upload"
  // requirement). ──────────────────────────────────────────────────────────
  await setImportStatus(db, importId, current, "extracting").catch(() => {});

  const obj = await env.MEDIA.get(row.r2_key);
  if (!obj) {
    await setImportStatus(db, importId, "extracting", "failed", { errorMessage: "document_missing" });
    return { ok: false, error: "document_missing", message: "The original document could not be found in storage. Please re-upload it.", httpStatus: 500 };
  }
  const bytes = await obj.arrayBuffer();

  let extraction;
  try {
    extraction = await validateAndExtractPdf(bytes, realPdfExtractor);
  } catch (e: any) {
    console.error("[lead-import/extract]", e?.message || e);
    await setImportStatus(db, importId, "extracting", "failed", { errorMessage: "extraction_error" });
    return { ok: false, error: "extraction_error", message: "This document could not be read. Please try again.", httpStatus: 500 };
  }

  if (!extraction.ok) {
    const errKey = extraction.error as PdfValidationError;
    await setImportStatus(db, importId, "extracting", "failed", { errorMessage: errKey });
    return { ok: false, error: errKey, message: PDF_ERROR_MESSAGES[errKey], httpStatus: 400 };
  }

  await db.prepare(
    `UPDATE lead_import SET extracted_text=?, extracted_page_count=?, updated_at=datetime('now') WHERE id=?`
  ).bind(extraction.text || "", extraction.pageCount || 0, importId).run();

  // ── Phase 2: AI parsing (shared contract — src/ai/lead-import-parse.ts).
  // AI output is always a SUGGESTION: this phase only writes proposed_json/
  // warnings_json and lands on needs_review, never "ready" and never a CRM
  // write. ─────────────────────────────────────────────────────────────────
  await setImportStatus(db, importId, "extracting", "parsing");

  const { apiKey, baseUrl, model, keySource } = await _aiCreds(db, companyId, env as any);
  if (!apiKey) {
    await setImportStatus(db, importId, "parsing", "needs_review", { errorMessage: "no_api_key" });
    return {
      ok: true, status: "needs_review",
      warning: "AI is not enabled for your company yet — the document text was extracted, but you'll need to fill in the lead details manually. Ask your rep to enable AI, or add your own OpenAI key under Integrations.",
      pageCount: extraction.pageCount || 0,
    };
  }
  const quotaGate = await _aiQuotaGate(db, companyId, keySource);
  if (quotaGate) {
    await setImportStatus(db, importId, "parsing", "needs_review", { errorMessage: "quota_exceeded" });
    return { ok: true, status: "needs_review", warning: quotaGate.body?.message || "AI quota exceeded — fill in the lead details manually.", pageCount: extraction.pageCount || 0 };
  }

  const messages = buildLeadImportMessages("pdf", extraction.text || "", { filename: row.original_filename || undefined });

  let draft: LeadImportDraft;
  const warnings: string[] = [];
  try {
    const r = await _aiChatJson(baseUrl, apiKey, model, messages, LEAD_IMPORT_DRAFT_SCHEMA);
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.error("[lead-import/extract] upstream", r.status, errText.slice(0, 300));
      await setImportStatus(db, importId, "parsing", "needs_review", { errorMessage: "ai_upstream" });
      return { ok: true, status: "needs_review", warning: "AI parsing failed — fill in the lead details manually.", pageCount: extraction.pageCount || 0 };
    }
    const j: any = await r.json();
    await _logAiUsage(db, companyId, repId || "", "lead_import_pdf", model, j?.usage, keySource);
    const raw = (j?.choices?.[0]?.message?.content || "").trim();
    draft = normalizeLeadImportDraft(_aiParseJson(raw));
  } catch (e: any) {
    console.error("[lead-import/extract]", e?.message || e);
    await setImportStatus(db, importId, "parsing", "needs_review", { errorMessage: "ai_error" });
    return { ok: true, status: "needs_review", warning: "AI parsing failed — fill in the lead details manually.", pageCount: extraction.pageCount || 0 };
  }

  // Deterministic-first division classification (src/ai/lead-import-division.ts).
  // The model's division_suggestion.label is consulted only as the LAST
  // resort inside classifyDivision — never trusted as an id, never applied
  // if a real tenant division keyword-matches first.
  const divisions = await loadCompanyDivisions(db, companyId);
  const divisionResult = classifyDivision(divisions, {
    projectCategory: draft.project, workType: draft.project, serviceLine: draft.division_suggestion.label,
    aiSuggestedLabel: draft.division_suggestion.label,
  });
  if (divisionResult.isFallback) {
    warnings.push(`Could not confidently classify a division from this document — defaulted to "${divisionResult.division.label}". Please confirm.`);
  }

  // Missing-information is derived live at read time (never persisted as
  // its own column — see deriveMissingInfo's doc comment), but a first-pass
  // warning here still helps a reviewer opening the review screen for the
  // first time understand why it's flagged.
  const firstProperty = draft.properties[0];
  const missing = deriveMissingInfo({
    personName: draft.contact.person_name, companyName: draft.contact.company_name,
    address: firstProperty?.address, phone: draft.contact.phone, email: draft.contact.email,
  });
  if (missing.length > 0) {
    warnings.push(`Missing: ${missing.join(", ")}`);
  }
  if (draft.properties.length === 0) {
    warnings.push("No property address was found in this document.");
  }

  const proposedJson = JSON.stringify({ ...draft, division: divisionResult });

  await db.prepare(
    `UPDATE lead_import SET proposed_json=?, warnings_json=?, ai_model=?, updated_at=datetime('now') WHERE id=?`
  ).bind(proposedJson, JSON.stringify(warnings), model, importId).run();

  await setImportStatus(db, importId, "parsing", "needs_review");

  return {
    ok: true, status: "needs_review", draft, division: divisionResult,
    warnings, missingInfo: missing, pageCount: extraction.pageCount || 0,
  };
}

// ── POST /api/lead-import/:id/extract — extract + AI-parse a PDF import ────
//
// No request body — acts entirely on the import row + its already-stored
// R2 document. Two-phase, each phase's failure recorded as its own status
// so a retry (POST again) re-enters exactly the step that failed rather
// than re-running the whole pipeline blind:
//   uploaded -> extracting -> (text pulled from R2 via unpdf)
//            -> parsing    -> (AI call, using the shared lead-import-parse
//                               contract — untrusted-content framing,
//                               anti-prompt-injection, stripTrustedIds)
//            -> needs_review (always — AI output is only ever a SUGGESTION;
//               this route NEVER auto-advances to "ready" on the model's
//               say-so, and NEVER creates/alters a client/opportunity/
//               property row. A human explicitly finishing review, or
//               explicitly accepting the draft as-is, is what the
//               POST /:id/confirm route below requires before that happens.)
// "Re-run extraction" is this same route again: it re-reads the ALREADY
// STORED PDF from R2 (never asks for a re-upload) and is idempotent-safe
// to call repeatedly — canTransition treats needs_review -> needs_review
// and failed -> extracting as legal precisely so a retry lands here safely.
leadImportRouter.post("/:id/extract", async (c) => {
  const db = c.env.DB as D1Database;
  const companyId = c.var.companyId as string;
  const repId = c.var.repId as string;
  const importId = c.req.param("id");

  const rlOk = await rateLimit(db, `lead_import_extract_${companyId}`, 30, 300);
  if (!rlOk) {
    return c.json({ ok: false, error: "rate_limited", message: "Too many extraction requests. Please wait a few minutes and try again." }, 429);
  }

  const row = await loadOwnedImport(db, companyId, importId);
  if (!row) return c.json({ ok: false, error: "not_found", message: "Import not found" }, 404);

  const outcome = await runExtraction(db, c.env as any, companyId, repId, importId, row);
  if (!outcome.ok) {
    return c.json({ ok: false, error: outcome.error, message: outcome.message, ...(outcome.error === "invalid_state" ? { status: row.status } : {}) }, outcome.httpStatus as any);
  }
  if ("draft" in outcome) {
    return c.json({
      ok: true,
      data: {
        import_id: importId,
        status: outcome.status,
        draft: outcome.draft,
        division: outcome.division,
        warnings: outcome.warnings,
        missing_info: outcome.missingInfo,
        extracted_page_count: outcome.pageCount,
      },
    });
  }
  return c.json({
    ok: true,
    data: { import_id: importId, status: outcome.status, warning: outcome.warning, extracted_page_count: outcome.pageCount },
  });
});

// ── GET /api/lead-import/:id — status/detail + existing-record match ───────
//
// Read-only. Two things a review-screen frontend needs that no other route
// currently exposes:
//   1. The CURRENT state of an import after a page refresh (extract's
//      response is otherwise the only place a draft/warnings/division ever
//      appear) — parses the persisted proposed_json/warnings_json back out.
//   2. Existing-client/property match SUGGESTIONS for that draft (spec
//      capability 5), computed fresh on every read rather than cached, since
//      the CRM's client/property list can change between an import's
//      extraction and a human opening the review screen.
// This route never writes to the database — matching is suggestion-only by
// spec ("fuzzy-as-suggestion-only, deterministic-first"); POST /:id/confirm
// below is where a human's explicit link-vs-create choice is actually acted
// on.
leadImportRouter.get("/:id", async (c) => {
  const db = c.env.DB as D1Database;
  const companyId = c.var.companyId as string;
  const importId = c.req.param("id");

  const row = await loadOwnedImport(db, companyId, importId);
  if (!row) return c.json({ ok: false, error: "not_found", message: "Import not found" }, 404);

  let draft: LeadImportDraft | null = null;
  let division: DivisionClassificationResult | null = null;
  if (row.proposed_json) {
    try {
      const parsed = JSON.parse(row.proposed_json);
      // division was appended alongside the draft's own fields at write
      // time (see POST /:id/extract) — split it back out rather than
      // leaving a stray `division` key sitting inside the draft object the
      // frontend expects to match LeadImportDraft's own shape.
      const { division: divisionRaw, ...draftRaw } = parsed || {};
      draft = draftRaw as LeadImportDraft;
      division = (divisionRaw as DivisionClassificationResult) || null;
    } catch {
      // Malformed proposed_json should never happen (this router is the
      // only writer), but a parse failure here must never crash the status
      // read — surface the import with draft:null rather than a 500.
      draft = null;
      division = null;
    }
  }

  let warnings: string[] = [];
  try {
    warnings = row.warnings_json ? JSON.parse(row.warnings_json) : [];
  } catch {
    warnings = [];
  }

  // Matching only makes sense once there's a draft to match against — an
  // import still mid-extraction has no contact/address fields yet.
  let clientMatches: ClientMatchCandidate[] = [];
  let propertyMatches: PropertyMatchCandidate[] = [];
  let missing: string[] = [];
  if (draft) {
    const [existingClients, existingProperties] = await Promise.all([
      db.prepare(`SELECT id, name, phone, email, address, type FROM clients WHERE company_id=?`)
        .bind(companyId).all<ExistingClientRow>(),
      db.prepare(`SELECT id, client_id, label, street, street2, city, state, zip FROM properties WHERE company_id=?`)
        .bind(companyId).all<ExistingPropertyRow>(),
    ]);

    const firstProperty = draft.properties[0];
    clientMatches = findClientMatches(
      {
        personName: draft.contact.person_name, companyName: draft.contact.company_name,
        phone: draft.contact.phone, email: draft.contact.email, address: firstProperty?.address,
      },
      existingClients.results || [],
    );
    // If a deterministic client match exists, scope the property search to
    // that client first (a property match only matters relative to WHICH
    // client it would be linked under) — otherwise search every tenant
    // property, unscoped, purely as a suggestion.
    const deterministicClient = clientMatches.find((m) => m.strength === "deterministic");
    propertyMatches = findPropertyMatches(
      firstProperty?.address, existingProperties.results || [],
      deterministicClient ? { clientId: deterministicClient.client.id } : {},
    );

    missing = deriveMissingInfo({
      personName: draft.contact.person_name, companyName: draft.contact.company_name,
      address: firstProperty?.address, phone: draft.contact.phone, email: draft.contact.email,
    });
  }

  return c.json({
    ok: true,
    data: {
      import_id: importId,
      status: row.status,
      error_message: row.error_message || "",
      original_filename: row.original_filename || "",
      safe_filename: row.safe_filename || "",
      extracted_page_count: row.extracted_page_count || 0,
      draft,
      division,
      warnings,
      missing_info: missing,
      client_matches: clientMatches,
      property_matches: propertyMatches,
    },
  });
});

// ── POST /api/lead-import/:id/confirm — create/link CRM records ────────────
//
// The ONLY route in this file that ever creates or alters a CRM record —
// every other route only extracts/parses/suggests. Requires an explicit,
// authenticated confirm action; nothing here runs automatically.
//
// Request body — the human's REVIEWED values, never raw AI output:
//   {
//     approved: LeadImportDraft,      // edited draft — this is what gets written, not proposed_json
//     client_choice: { action: "link", client_id: string } | { action: "create" },
//     property_choices?: Array<
//       { action: "link", property_id: string } | { action: "create" }
//     >,  // one entry per approved.properties[i]; defaults to "create" for any index not covered
//     division_key?: string,          // human's final division choice — overrides the AI/keyword
//                                      // suggestion; never trusted from the model, always from this
//                                      // explicit field or the already-classified divisionResult
//   }
//
// Spec requirements this route exists to satisfy:
//   - "explicit link-vs-create choice" — client_choice/property_choices are
//     REQUIRED inputs, never inferred silently from the match suggestions
//     computed by GET /:id. A fuzzy suggestion is never auto-applied.
//   - "idempotent creation" — guarded by the import's own idempotency_token
//     via a write-once-guard-first status transition (ready -> creating),
//     mirroring src/api/receipt-posting.ts's postApprovedReceiptToLedger
//     ordering: the guarded write happens BEFORE any CRM insert, so a losing
//     concurrent request never reaches the insert path at all. A second
//     confirm call against an already-`creating`/`finalized` import returns
//     the ORIGINAL result (from result_client_id/result_opportunity_ids_json)
//     rather than creating a second set of records.
//   - "document access from every resulting record" — one
//     lead_import_document_link row per client/opportunity actually
//     created or linked this call, so the source PDF can be found FROM any
//     of them later via GET /entity-links/:entityType/:entityId, which
//     reads exactly these rows (see that route below).
async function loadDivisions(db: D1Database, companyId: string) {
  return loadCompanyDivisions(db, companyId);
}

type ClientChoice = { action: "link"; client_id: string } | { action: "create" };
type PropertyChoice = { action: "link"; property_id: string } | { action: "create" };

leadImportRouter.post("/:id/confirm", async (c) => {
  const db = c.env.DB as D1Database;
  const companyId = c.var.companyId as string;
  const repId = c.var.repId as string;
  const importId = c.req.param("id");

  const rlOk = await rateLimit(db, `lead_import_confirm_${companyId}`, 20, 300);
  if (!rlOk) {
    return c.json({ ok: false, error: "rate_limited", message: "Too many confirm requests. Please wait a few minutes and try again." }, 429);
  }

  const row = await loadOwnedImport(db, companyId, importId);
  if (!row) return c.json({ ok: false, error: "not_found", message: "Import not found" }, 404);

  const current = row.status as LeadImportStatus;

  // Idempotency: an import that already finished creating (or is mid-flight
  // on another concurrent request) returns its ORIGINAL result rather than
  // creating a second set of records. This check happens BEFORE any
  // parsing/validation of the request body — a retried confirm with a
  // slightly different body must still resolve to the first outcome, per
  // the spec's "never silently create a duplicate" rule.
  if (current === "finalized" || current === "creating") {
    let resultOpportunityIds: string[] = [];
    try { resultOpportunityIds = JSON.parse(row.result_opportunity_ids_json || "[]"); } catch { /* leave empty */ }
    return c.json({
      ok: true,
      data: {
        import_id: importId,
        status: current,
        already_confirmed: true,
        result_client_id: row.result_client_id || "",
        result_opportunity_ids: resultOpportunityIds,
      },
    });
  }

  // Everything before "ready" (still extracting/parsing/needs review) or
  // already terminal-failed-without-a-retry must go through the
  // extract/review routes first — this route never advances an import past
  // review on its own.
  if (current !== "ready" && current !== "needs_review") {
    return c.json({ ok: false, error: "invalid_state", message: `Cannot confirm from status "${current}".`, status: current }, 409);
  }

  const body: any = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ ok: false, error: "bad_request", message: "A JSON body with an approved draft is required." }, 400);
  }

  // The human's reviewed values are what gets written — never raw AI
  // output/proposed_json. normalizeLeadImportDraft is reused here (not a
  // second, separate validator) so a hand-edited draft goes through the
  // exact same sanitization/length-capping/stripTrustedIds pass a
  // freshly-parsed one does; the model is never trusted with an id and
  // neither is a human-submitted body that happens to contain one.
  const approved: LeadImportDraft = normalizeLeadImportDraft(body.approved);

  if (!approved.contact.person_name && !approved.contact.company_name) {
    return c.json({ ok: false, error: "missing_contact_identity", message: "A contact name or company name is required before creating a lead." }, 400);
  }
  if (approved.properties.length === 0) {
    return c.json({ ok: false, error: "missing_property", message: "At least one property address is required before creating a lead." }, 400);
  }

  const clientChoice: ClientChoice = body.client_choice && body.client_choice.action === "link"
    ? { action: "link", client_id: String(body.client_choice.client_id || "") }
    : { action: "create" };
  if (clientChoice.action === "link" && !clientChoice.client_id) {
    return c.json({ ok: false, error: "bad_request", message: "client_choice.client_id is required when action is \"link\"." }, 400);
  }

  const rawPropertyChoices = Array.isArray(body.property_choices) ? body.property_choices : [];
  const propertyChoices: PropertyChoice[] = approved.properties.map((_p, i) => {
    const raw = rawPropertyChoices[i];
    if (raw && raw.action === "link" && raw.property_id) {
      return { action: "link", property_id: String(raw.property_id) };
    }
    return { action: "create" };
  });

  // Division: the human's explicit final choice (division_key) takes
  // priority when supplied; otherwise fall back to re-running the same
  // deterministic-first classifier this import's own extract step already
  // ran, using the approved (possibly edited) draft's own project/division
  // fields — never the model's label treated as an id, exactly as
  // classifyDivision's own contract requires.
  const divisions = await loadDivisions(db, companyId);
  let division = classifyDivision(divisions, {
    projectCategory: approved.project, workType: approved.project,
    serviceLine: approved.division_suggestion.label, aiSuggestedLabel: approved.division_suggestion.label,
  });
  if (body.division_key) {
    // Case-insensitive match against key/label, matching classifyDivision's
    // own internal norm() comparison exactly (src/ai/lead-import-division.ts)
    // — a case-sensitive match here would silently fail to find a division
    // whose stored key/label differs only in case from what the client sent.
    const wanted = String(body.division_key).toLowerCase().trim();
    const explicit = divisions.find(
      (d) => d.key.toLowerCase().trim() === wanted || d.label.toLowerCase().trim() === wanted,
    );
    if (explicit) division = { division: explicit, source: "explicit", isFallback: false };
  }

  // ── Write-once guard FIRST, mirroring postApprovedReceiptToLedger's
  // documented ordering exactly: the guarded status transition happens
  // BEFORE any CRM insert below, so a losing concurrent request (racing
  // confirm calls against the same import) never reaches the client/
  // opportunity INSERT at all — it fails this UPDATE's WHERE clause and
  // returns a safe "already in progress" response instead of creating a
  // second, duplicate record set. ──────────────────────────────────────────
  const guard = await db.prepare(
    `UPDATE lead_import SET status='creating', updated_at=datetime('now') WHERE id=? AND status=?`
  ).bind(importId, current).run();
  if (!guard.meta.changes) {
    // Someone else's concurrent confirm call won the race between our read
    // of `current` above and this write — re-read and return that result
    // rather than erroring, since the outcome is exactly the not-a-real-
    // error "already_confirmed" case above, just discovered a few
    // milliseconds later than usual.
    const winner = await loadOwnedImport(db, companyId, importId);
    let resultOpportunityIds: string[] = [];
    try { resultOpportunityIds = JSON.parse(winner?.result_opportunity_ids_json || "[]"); } catch { /* leave empty */ }
    return c.json({
      ok: true,
      data: {
        import_id: importId, status: winner?.status || "creating", already_confirmed: true,
        result_client_id: winner?.result_client_id || "", result_opportunity_ids: resultOpportunityIds,
      },
    });
  }

  try {
    // ── Client: link to an existing row, or create a new one. ─────────────
    let clientId: string;
    if (clientChoice.action === "link") {
      const existing: any = await db.prepare(`SELECT id FROM clients WHERE id=? AND company_id=?`)
        .bind(clientChoice.client_id, companyId).first();
      if (!existing) {
        await setImportStatus(db, importId, "creating", "failed", { errorMessage: "client_not_found" }).catch(() => {});
        return c.json({ ok: false, error: "client_not_found", message: "The client you chose to link no longer exists." }, 404);
      }
      clientId = existing.id;
    } else {
      clientId = newId("cli");
      const contactName = approved.contact.person_name || approved.contact.company_name;
      await db.prepare(
        `INSERT INTO clients (id, company_id, name, phone, email, address, type, notes)
         VALUES (?,?,?,?,?,?,?,?)`
      ).bind(
        clientId, companyId, contactName, approved.contact.phone, approved.contact.email,
        approved.properties[0]?.address || "", approved.client_type, approved.summary_note || "",
      ).run();
    }

    // ── Properties: link existing rows, or create new ones — one per
    // approved.properties[i], following each entry's own choice. ──────────
    const propertyIds: string[] = [];
    for (const [i, p] of approved.properties.entries()) {
      const choice: PropertyChoice = propertyChoices[i] ?? { action: "create" };
      if (choice.action === "link") {
        const existing: any = await db.prepare(`SELECT id FROM properties WHERE id=? AND company_id=? AND client_id=?`)
          .bind(choice.property_id, companyId, clientId).first();
        if (existing) {
          propertyIds.push(existing.id);
          continue;
        }
        // A stale/invalid link target must never silently drop this
        // property from the lead — fall through to creating it instead,
        // same as if "create" had been chosen.
      }
      const propId = newId("prop");
      await db.prepare(
        `INSERT INTO properties (id, company_id, client_id, label, street, notes, is_primary)
         VALUES (?,?,?,?,?,?,?)`
      ).bind(propId, companyId, clientId, p.label || "Primary Property", p.address || "", p.notes || "", i === 0 ? 1 : 0).run();
      propertyIds.push(propId);
    }

    // ── One opportunity per property (multi-property handling — the spec's
    // "one contact, several sites -> several opportunities" requirement),
    // all sharing the same client_id and the same division classification. ─
    const defaultStage = await resolveDefaultPipelineStage(db, companyId);
    const multi = approved.properties.length > 1;
    const contactName = approved.contact.person_name || approved.contact.company_name;
    const opportunityIds: string[] = [];
    for (const p of approved.properties) {
      const oppId = await insertOpportunityRow(db, companyId, {
        repId: repId || null,
        client: multi ? `${contactName} — ${p.label || p.address || "Site"}` : contactName,
        phone: approved.contact.phone, email: approved.contact.email, address: p.address,
        serviceLine: division.division.label, source: "PDF Import", status: defaultStage,
        project: approved.project, urgency: approved.urgency, decisionMaker: contactName,
        workType: division.division.key, clientType: approved.client_type,
        clientId,
      });
      opportunityIds.push(oppId);

      const noteBody = [
        approved.summary_note || "",
        p.notes ? `Site notes: ${p.notes}` : "",
      ].filter(Boolean).join("\n");
      if (noteBody) {
        await db.prepare(`INSERT INTO notes (id, opp_id, rep_id, body, company_id) VALUES (?,?,?,?,?)`)
          .bind(newId("note"), oppId, repId || null, noteBody, companyId).run();
      }

      // Document access from every resulting record (spec requirement):
      // link this import's source document to each opportunity created —
      // INSERT OR IGNORE since the unique index on (document_id,
      // entity_type, entity_id) makes a repeat link (e.g. a future
      // "re-link this document" action) a safe no-op, never a duplicate row.
      await db.prepare(
        `INSERT OR IGNORE INTO lead_import_document_link (id, company_id, document_id, import_id, entity_type, entity_id)
         VALUES (?,?,?,?, 'opportunity', ?)`
      ).bind(newId("lidl"), companyId, row.document_id, importId, oppId).run();
    }

    // Link the document to the client too (once, regardless of how many
    // properties/opportunities were created from this one import).
    await db.prepare(
      `INSERT OR IGNORE INTO lead_import_document_link (id, company_id, document_id, import_id, entity_type, entity_id)
       VALUES (?,?,?,?, 'client', ?)`
    ).bind(newId("lidl"), companyId, row.document_id, importId, clientId).run();

    // Result references + terminal status — mirrors postApprovedReceiptToLedger's
    // "only the request that won the guard reaches this line" property:
    // nothing above this point can run twice for the same import, so these
    // writes are safe without a further guard of their own.
    await db.prepare(
      `UPDATE lead_import SET status='finalized', approved_json=?, confirmed_by_rep_id=?, confirmed_at=datetime('now'),
         result_client_id=?, result_opportunity_ids_json=?, updated_at=datetime('now') WHERE id=?`
    ).bind(JSON.stringify(approved), repId || "", clientId, JSON.stringify(opportunityIds), importId).run();

    // Note: unlike index.tsx's POST /api/opportunities, this route does not
    // call syncPublishedStageAssignment() or write a `{companyId}:last_write`
    // broadcast setting. Neither is exported from index.tsx (importing them
    // back out of index.tsx would recreate the cycle this router is built to
    // avoid — see the file header), and src/marketing/public.ts's own
    // insertOpportunityRow call site (the public inquiry-form lead path)
    // follows the exact same precedent: not every opportunity-creating
    // entry point outside index.tsx performs those two side effects.
    await logActivity(db, {
      companyId, actorId: repId || "", actorName: repId || "",
      entityType: "lead_import", entityId: importId, entityLabel: contactName,
      action: "confirmed", afterJson: { client_id: clientId, opportunity_ids: opportunityIds },
    });

    return c.json({
      ok: true,
      data: {
        import_id: importId, status: "finalized",
        result_client_id: clientId, result_opportunity_ids: opportunityIds,
        division: division,
      },
    });
  } catch (e: any) {
    console.error("[lead-import/confirm]", e?.message || e);
    await setImportStatus(db, importId, "creating", "failed", { errorMessage: "create_error" }).catch(() => {});
    return c.json({ ok: false, error: "create_error", message: "Could not create the lead. Please try again." }, 500);
  }
});

// ── GET /api/lead-import/document/:documentId — stream the original PDF ────
//
// Satisfies the spec's "document access from every resulting record"
// requirement together with the /entity-links route below: the confirm
// route above writes one lead_import_document_link row per client/
// opportunity/property it creates or links; a frontend viewing any of those
// records calls GET /entity-links/:entityType/:entityId to discover the
// linked document_id(s), then this route to actually stream one.
//
// Tenant-scoped exactly like src/portal.tsx's GET /api/portal/media/:id and
// GET /api/admin/portal/media/:id: a document that exists but belongs to a
// different company_id returns 404, never 403 (never confirms existence to
// an attacker) — same convention loadOwnedImport() above already follows.
//
// Streams the ORIGINAL PDF bytes only. Per the spec's storage rules, this
// document row is never replaced by a derivative (e.g. an OCR'd or
// rasterized copy) — r2_key always points at exactly the bytes that were
// hashed at upload time, so this route can never serve anything other than
// the tenant's own original upload.
leadImportRouter.get("/document/:documentId", async (c) => {
  const db = c.env.DB as D1Database;
  const companyId = c.var.companyId as string;
  const documentId = c.req.param("documentId");

  const doc: any = await db.prepare(
    `SELECT r2_key, mime_type, safe_filename, company_id FROM lead_import_document WHERE id=? LIMIT 1`
  ).bind(documentId).first();

  if (!doc || doc.company_id !== companyId) {
    return c.json({ ok: false, error: "not_found", message: "Document not found" }, 404);
  }

  const obj = await (c.env.MEDIA as R2Bucket).get(doc.r2_key);
  if (!obj) {
    // Row exists but the R2 object doesn't (should never happen outside a
    // storage-layer incident) — surface as not_found rather than a 500,
    // since from the caller's point of view the document is unavailable
    // either way and there is nothing they can retry.
    return c.json({ ok: false, error: "not_found", message: "Document file not found" }, 404);
  }

  const filename = String(doc.safe_filename || "document.pdf").replace(/[^\w.\- ]/g, "");
  return new Response(obj.body as any, {
    headers: {
      "Content-Type": doc.mime_type || "application/pdf",
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": `inline; filename="${filename}"`,
    },
  });
});

// ── GET /api/lead-import/entity-links/:entityType/:entityId — find the ─────
//    source document(s) linked to a CRM record.
//
// entity_type is constrained to the same three values as the
// lead_import_document_link table's own CHECK constraint (client,
// opportunity, property) — an out-of-range value can never match a row, but
// is still explicitly validated here so a typo'd entity_type gives a clear
// 400 rather than a silently-empty 200.
//
// Returns document metadata (never the raw bytes — GET /document/:id above
// is the separate download step), tenant-scoped by company_id on the link
// table, which is itself always written with the same company_id as the
// entity it links (see POST /:id/confirm above).
const LINKABLE_ENTITY_TYPES = new Set(["client", "opportunity", "property"]);

leadImportRouter.get("/entity-links/:entityType/:entityId", async (c) => {
  const db = c.env.DB as D1Database;
  const companyId = c.var.companyId as string;
  const entityType = c.req.param("entityType");
  const entityId = c.req.param("entityId");

  if (!LINKABLE_ENTITY_TYPES.has(entityType)) {
    return c.json({ ok: false, error: "bad_request", message: "Unknown entity_type" }, 400);
  }

  const rows = await db.prepare(
    `SELECT lidl.document_id, lidl.import_id, lidl.created_at,
            lid.original_filename, lid.safe_filename, lid.mime_type, lid.byte_size
     FROM lead_import_document_link lidl
     JOIN lead_import_document lid ON lid.id = lidl.document_id
     WHERE lidl.company_id=? AND lidl.entity_type=? AND lidl.entity_id=?
     ORDER BY lidl.created_at DESC`
  ).bind(companyId, entityType, entityId).all();

  return c.json({
    ok: true,
    data: (rows.results || []).map((r: any) => ({
      document_id: r.document_id,
      import_id: r.import_id,
      linked_at: r.created_at,
      original_filename: r.original_filename,
      safe_filename: r.safe_filename,
      mime_type: r.mime_type,
      byte_size: r.byte_size,
      download_url: `/api/lead-import/document/${r.document_id}`,
    })),
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PR2 — Bulk PDF import (multiple files at once, ≤MAX_BULK_FILES). Every
// route below reuses ingestPdfBytes()/runExtraction() (PR1's extracted core
// logic, above) so a bulk-uploaded file goes through the EXACT SAME
// hash-dedupe/idempotency/extract/parse pipeline a single-file import does —
// never a parallel reimplementation. Same HARD INVARIANT as the rest of this
// router: AI output is always a SUGGESTION; nothing below ever creates or
// alters a CRM record — that still only happens via POST /:id/confirm,
// called once per import, same as a single-file import would.
// ═══════════════════════════════════════════════════════════════════════════

// ── POST /api/lead-import/bulk/upload — multi-file PDF upload ──────────────
//
// multipart/form-data, one or more repeated "files" field entries
// (`form.getAll("files")`) — up to MAX_BULK_FILES files, MAX_BULK_TOTAL_BYTES
// combined (both named constants from pdf-lead-import.ts, not invented
// here). Creates one lead_import_batch row, then ingests each file through
// ingestPdfBytes() with that batch's id — one lead_import row per file, all
// sharing batch_id, each independently hash-deduped exactly like a
// single-file upload would be.
//
// A per-file rejection (not-a-PDF, empty, oversized) never aborts the whole
// batch — each file's outcome is reported independently in `results`, so a
// human uploading 8 good PDFs and 2 bad ones still gets the 8 good ones
// queued rather than losing the entire batch to one bad file. `file_count`
// on the batch row reflects only what was actually ACCEPTED, so a queue UI
// polling GET /bulk/:batchId never expects more imports than truly exist.
leadImportRouter.post("/bulk/upload", async (c) => {
  const db = c.env.DB as D1Database;
  const companyId = c.var.companyId as string;
  const repId = c.var.repId as string;

  // Deliberately a tighter budget than the single-file upload's 30/300 —
  // each call here can do up to MAX_BULK_FILES times the R2/D1 work of a
  // single-file upload, so the per-tenant ceiling on call FREQUENCY is
  // lower even though the ceiling on total files processed is much higher.
  const rlOk = await rateLimit(db, `lead_import_bulk_upload_${companyId}`, 10, 300);
  if (!rlOk) {
    return c.json({ ok: false, error: "rate_limited", message: "Too many bulk uploads. Please wait a few minutes and try again." }, 429);
  }

  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ ok: false, error: "bad_request", message: "multipart/form-data required" }, 400);

  const files = form.getAll("files").filter(
    (f): f is File => !!f && typeof (f as any).arrayBuffer === "function",
  );
  if (files.length === 0) {
    return c.json({ ok: false, error: "bad_request", message: 'At least one "files" field is required.' }, 400);
  }
  if (files.length > MAX_BULK_FILES) {
    return c.json({
      ok: false, error: "too_many_files",
      message: `You can upload up to ${MAX_BULK_FILES} PDFs at once. Please split this into smaller batches.`,
    }, 400);
  }

  const totalBytes = files.reduce((sum, f) => sum + (Number((f as any).size) || 0), 0);
  if (totalBytes > MAX_BULK_TOTAL_BYTES) {
    return c.json({
      ok: false, error: "too_large",
      message: `This batch is larger than the ${Math.round(MAX_BULK_TOTAL_BYTES / (1024 * 1024))} MB combined limit. Please upload fewer or smaller files at once.`,
    }, 413);
  }

  const batchId = newId("libatch");
  await db.prepare(
    `INSERT INTO lead_import_batch (id, company_id, created_by_rep_id, status, file_count) VALUES (?,?,?, 'queued', ?)`
  ).bind(batchId, companyId, repId || "", files.length).run();

  const results: Array<{
    filename: string; ok: boolean;
    import_id?: string; document_id?: string; duplicate?: boolean; safe_filename?: string;
    error?: string; message?: string;
  }> = [];

  // Sequential, not parallel — R2.put() + D1 insert per file already does
  // real I/O work per iteration, and the per-file dedupe lookup inside
  // ingestPdfBytes must see each PRIOR file's write in this same batch (two
  // identical files uploaded together must still land as one document + two
  // imports, never two documents) — a fully parallel version could race
  // itself on that exact case.
  for (const file of files) {
    const originalFilename = String((file as any).name || "upload.pdf");
    const size = Number((file as any).size) || 0;
    if (size === 0) {
      results.push({ filename: originalFilename, ok: false, error: "empty_file", message: "That file is empty." });
      continue;
    }
    if (size > MAX_PDF_BYTES) {
      results.push({
        filename: originalFilename, ok: false, error: "too_large",
        message: `Larger than the ${Math.round(MAX_PDF_BYTES / (1024 * 1024))} MB per-file limit.`,
      });
      continue;
    }
    const bytes = await (file as any).arrayBuffer() as ArrayBuffer;
    const outcome = await ingestPdfBytes(db, c.env.MEDIA as R2Bucket, companyId, repId, bytes, originalFilename, batchId);
    if (!outcome.ok) {
      results.push({ filename: originalFilename, ok: false, error: outcome.error, message: outcome.message });
      continue;
    }
    results.push({
      filename: originalFilename, ok: true,
      import_id: outcome.importId, document_id: outcome.documentId,
      duplicate: outcome.duplicate, safe_filename: outcome.safeFilename,
    });
  }

  const acceptedCount = results.filter((r) => r.ok).length;
  if (acceptedCount !== files.length) {
    await db.prepare(`UPDATE lead_import_batch SET file_count=?, updated_at=datetime('now') WHERE id=?`)
      .bind(acceptedCount, batchId).run();
  }

  return c.json({
    ok: true,
    data: { batch_id: batchId, file_count: acceptedCount, results },
  });
});

// ── POST /api/lead-import/bulk/:batchId/extract — extract+parse every ──────
//    still-pending import in a batch
//
// Runs runExtraction() — the EXACT SAME two-phase pipeline POST /:id/extract
// uses — once per RETRY_ENTRY-eligible import in the batch (an import
// already 'ready'/'creating'/'finalized' is skipped, same rule the
// single-file route enforces), bounded to BULK_PARSE_CONCURRENCY concurrent
// in-flight extractions — the spec's named concurrency cap, chosen so this
// one request's total outbound-fetch fan-out (one AI call per file) and
// wall time stay bounded regardless of how many files (up to
// MAX_BULK_FILES) are in the batch, and so one tenant's bulk import can
// never burst the AI provider's own per-account rate limit as hard as
// MAX_BULK_FILES fully-parallel calls would. AI output is still always a
// SUGGESTION here: this route only ever advances an import to
// needs_review/failed, exactly like the single-file route, and never
// itself creates a CRM record — that is POST /:id/confirm's job alone, run
// once per import a human has reviewed, same as for a single-file import.
leadImportRouter.post("/bulk/:batchId/extract", async (c) => {
  const db = c.env.DB as D1Database;
  const companyId = c.var.companyId as string;
  const repId = c.var.repId as string;
  const batchId = c.req.param("batchId");

  const rlOk = await rateLimit(db, `lead_import_bulk_extract_${companyId}`, 10, 300);
  if (!rlOk) {
    return c.json({ ok: false, error: "rate_limited", message: "Too many bulk extraction requests. Please wait a few minutes and try again." }, 429);
  }

  // 404, not 403, for a batch that doesn't exist or belongs to another
  // tenant — same convention loadOwnedImport() follows for single imports.
  const batch: any = await db.prepare(`SELECT id, status FROM lead_import_batch WHERE id=? AND company_id=? LIMIT 1`)
    .bind(batchId, companyId).first();
  if (!batch) return c.json({ ok: false, error: "not_found", message: "Batch not found" }, 404);

  const rowsRes = await db.prepare(
    `SELECT li.*, lid.r2_key, lid.safe_filename, lid.original_filename, lid.mime_type
     FROM lead_import li JOIN lead_import_document lid ON lid.id = li.document_id
     WHERE li.batch_id=? AND li.company_id=?
     ORDER BY li.created_at ASC`
  ).bind(batchId, companyId).all<any>();
  const rows = rowsRes.results || [];
  if (rows.length === 0) {
    return c.json({ ok: false, error: "empty_batch", message: "This batch has no documents to extract." }, 404);
  }

  const RETRY_ENTRY: LeadImportStatus[] = ["uploaded", "extracting", "parsing", "needs_review", "failed"];
  const eligible = rows.filter((r: any) => RETRY_ENTRY.includes(r.status as LeadImportStatus));
  if (eligible.length === 0) {
    // Every import in this batch has already moved past the extract step
    // (already reviewed/ready/finalized) — nothing to (re-)extract. Report
    // the batch's own current status rather than flipping it to
    // 'processing' and back for zero actual work.
    return c.json({ ok: true, data: { batch_id: batchId, status: batch.status, processed: 0, results: [] } });
  }

  await db.prepare(`UPDATE lead_import_batch SET status='processing', updated_at=datetime('now') WHERE id=?`).bind(batchId).run();

  type BulkExtractResult = { import_id: string; filename: string; status: string; warning?: string; error?: string };
  const results: BulkExtractResult[] = [];

  // Bounded-concurrency runner: BULK_PARSE_CONCURRENCY workers pull from a
  // shared cursor, so at most that many extractions (and their AI calls)
  // are ever in flight at once, regardless of eligible.length.
  let cursor = 0;
  async function worker() {
    while (cursor < eligible.length) {
      const row = eligible[cursor++];
      const filename = row.original_filename || row.safe_filename || "";
      try {
        const outcome = await runExtraction(db, c.env as any, companyId, repId, row.id, row);
        if (!outcome.ok) {
          results.push({ import_id: row.id, filename, status: "failed", error: outcome.error });
        } else if ("draft" in outcome) {
          results.push({ import_id: row.id, filename, status: outcome.status });
        } else {
          results.push({ import_id: row.id, filename, status: outcome.status, warning: outcome.warning });
        }
      } catch (e: any) {
        console.error("[lead-import/bulk-extract]", e?.message || e);
        results.push({ import_id: row.id, filename, status: "failed", error: "extraction_error" });
      }
    }
  }
  const workerCount = Math.min(BULK_PARSE_CONCURRENCY, eligible.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // Batch-level status: 'ready' as soon as at least one import in the batch
  // reached a reviewable needs_review state — a human then opens the review
  // queue and works through whichever imports succeeded, one at a time,
  // exactly like a single-file needs_review screen. 'failed' only when
  // EVERY eligible import in this run errored out — a partial batch (some
  // succeeded, some failed) still surfaces as 'ready' so the good ones are
  // never blocked behind the bad ones.
  const anyReviewable = results.some((r) => r.status === "needs_review");
  const batchStatus = anyReviewable ? "ready" : "failed";
  await db.prepare(`UPDATE lead_import_batch SET status=?, updated_at=datetime('now') WHERE id=?`).bind(batchStatus, batchId).run();

  return c.json({
    ok: true,
    data: { batch_id: batchId, status: batchStatus, processed: results.length, results },
  });
});

// ── GET /api/lead-import/bulk/:batchId — batch status + per-file summary ───
//
// Read-only, mirrors GET /:id but for every import in a batch — a queue UI
// polls this to render "3 of 10 ready for review, 2 failed, 5 still
// processing" without issuing N separate GET /:id calls. Returns each
// import's own status/warnings/missing_info (derived the same way GET /:id
// derives them) but never the full draft body or match suggestions — a
// queue LIST view does not need every field of every draft; a human opening
// one specific import to actually review/confirm it still goes through
// GET /:id and POST /:id/confirm exactly as a single-file import would.
leadImportRouter.get("/bulk/:batchId", async (c) => {
  const db = c.env.DB as D1Database;
  const companyId = c.var.companyId as string;
  const batchId = c.req.param("batchId");

  const batch: any = await db.prepare(
    `SELECT id, status, file_count, created_at FROM lead_import_batch WHERE id=? AND company_id=? LIMIT 1`
  ).bind(batchId, companyId).first();
  if (!batch) return c.json({ ok: false, error: "not_found", message: "Batch not found" }, 404);

  const rowsRes = await db.prepare(
    `SELECT li.id, li.status, li.error_message, li.warnings_json, li.proposed_json,
            lid.original_filename, lid.safe_filename
     FROM lead_import li JOIN lead_import_document lid ON lid.id = li.document_id
     WHERE li.batch_id=? AND li.company_id=?
     ORDER BY li.created_at ASC`
  ).bind(batchId, companyId).all<any>();

  const imports = (rowsRes.results || []).map((r: any) => {
    let warnings: string[] = [];
    try { warnings = r.warnings_json ? JSON.parse(r.warnings_json) : []; } catch { warnings = []; }

    let hasDraft = false;
    let missing: string[] = [];
    if (r.proposed_json) {
      try {
        const parsed = JSON.parse(r.proposed_json);
        hasDraft = true;
        missing = deriveMissingInfo({
          personName: parsed?.contact?.person_name, companyName: parsed?.contact?.company_name,
          address: parsed?.properties?.[0]?.address, phone: parsed?.contact?.phone, email: parsed?.contact?.email,
        });
      } catch {
        // Malformed proposed_json should never happen (this router is the
        // only writer) — never crash a batch-status read over it.
        hasDraft = false;
      }
    }

    return {
      import_id: r.id,
      status: r.status,
      error_message: r.error_message || "",
      original_filename: r.original_filename || "",
      safe_filename: r.safe_filename || "",
      has_draft: hasDraft,
      warnings,
      missing_info: missing,
    };
  });

  return c.json({
    ok: true,
    data: {
      batch_id: batch.id,
      status: batch.status,
      file_count: batch.file_count,
      created_at: batch.created_at,
      imports,
    },
  });
});
