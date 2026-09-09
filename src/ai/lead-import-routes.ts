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
 * this router creates or alters a CRM record except the (not-yet-written)
 * confirm route, and only in response to an explicit, authenticated confirm
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
  PDF_ERROR_MESSAGES, MAX_PDF_BYTES,
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

export const leadImportRouter = new Hono<AppEnv>();

// Server-generated id helper, matching the style of index.tsx's own
// (unexported) `uid()` and insertOpportunityRow's own id-gen fallback
// (src/marketing/leads.ts) — `uid()` itself is not exported from index.tsx,
// so this router needs its own equivalent rather than importing it (which
// would also recreate the index.tsx->router cycle).
function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
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
  if (!hasPdfMagicBytes(bytes)) {
    return c.json({ ok: false, error: "not_pdf", message: "That file doesn't look like a PDF. Please upload a .pdf file." }, 400);
  }

  const hash = await computeContentHash(bytes);
  const originalFilename = String((file as any).name || "upload.pdf");
  const safeName = safeFilename(originalFilename);
  const contentType = "application/pdf"; // never trust the browser-supplied MIME type for storage — magic bytes already confirmed this is a PDF

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
      `INSERT INTO lead_import (id, company_id, document_id, idempotency_token, status, parser_name)
       VALUES (?,?,?,?, 'uploaded', 'unpdf')`
    ).bind(importId, companyId, existingDoc.id, idemToken).run();

    return c.json({
      ok: true,
      data: {
        import_id: importId,
        document_id: existingDoc.id,
        idempotency_token: idemToken,
        status: "uploaded",
        duplicate: true,
        safe_filename: existingDoc.safe_filename || safeName,
      },
    });
  }

  const documentId = newId("lidoc");
  const r2Key = documentR2Key(companyId, documentId, hash, safeName);

  await (c.env.MEDIA as R2Bucket).put(r2Key, bytes, { httpMetadata: { contentType } });

  try {
    await db.prepare(
      `INSERT INTO lead_import_document
         (id, company_id, uploaded_by_rep_id, original_filename, safe_filename, r2_key, mime_type, byte_size, sha256_hash, upload_source, document_kind, status, import_id)
       VALUES (?,?,?,?,?,?,?,?,?, 'pdf_single', 'unknown', 'uploaded', ?)`
    ).bind(documentId, companyId, repId || "", originalFilename.slice(0, 300), safeName, r2Key, contentType, size, hash, importId).run();
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
      console.error("[lead-import/upload]", e?.message || e);
      return c.json({ ok: false, error: "storage_error", message: "Could not save that document. Please try again." }, 500);
    }
    await db.prepare(
      `INSERT INTO lead_import (id, company_id, document_id, idempotency_token, status, parser_name)
       VALUES (?,?,?,?, 'uploaded', 'unpdf')`
    ).bind(importId, companyId, winner.id, idemToken).run();
    return c.json({
      ok: true,
      data: {
        import_id: importId,
        document_id: winner.id,
        idempotency_token: idemToken,
        status: "uploaded",
        duplicate: true,
        safe_filename: winner.safe_filename || safeName,
      },
    });
  }

  await db.prepare(
    `INSERT INTO lead_import (id, company_id, document_id, idempotency_token, status, parser_name)
     VALUES (?,?,?,?, 'uploaded', 'unpdf')`
  ).bind(importId, companyId, documentId, idemToken).run();

  return c.json({
    ok: true,
    data: {
      import_id: importId,
      document_id: documentId,
      idempotency_token: idemToken,
      status: "uploaded",
      duplicate: false,
      safe_filename: safeName,
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
//               not-yet-built confirm route requires before that happens.)
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

  const current = row.status as LeadImportStatus;
  // Only a state this route is actually meant to (re-)enter may proceed —
  // an import already 'ready'/'creating'/'finalized' must go through the
  // review/confirm routes instead, never be silently re-extracted underneath
  // a human who has already reviewed it.
  const RETRY_ENTRY: LeadImportStatus[] = ["uploaded", "extracting", "parsing", "needs_review", "failed"];
  if (!RETRY_ENTRY.includes(current)) {
    return c.json({ ok: false, error: "invalid_state", message: `Cannot extract from status "${current}".`, status: current }, 409);
  }

  // ── Phase 1: extraction (re-reads the ALREADY-STORED PDF from R2 — the
  // spec's "re-run extraction reuses stored PDF, never asks to re-upload"
  // requirement). ──────────────────────────────────────────────────────────
  await setImportStatus(db, importId, current, "extracting").catch(() => {});

  const obj = await (c.env.MEDIA as R2Bucket).get(row.r2_key);
  if (!obj) {
    // The document row exists but its R2 object is gone (should not happen
    // under normal operation — surfaced as a named, retryable failure
    // rather than a generic 500, since a human retrying later after an
    // infra hiccup is the expected recovery path, not a full re-upload).
    await setImportStatus(db, importId, "extracting", "failed", { errorMessage: "document_missing" });
    return c.json({ ok: false, error: "document_missing", message: "The original document could not be found in storage. Please re-upload it." }, 500);
  }
  const bytes = await obj.arrayBuffer();

  let extraction;
  try {
    extraction = await validateAndExtractPdf(bytes, realPdfExtractor);
  } catch (e: any) {
    console.error("[lead-import/extract]", e?.message || e);
    await setImportStatus(db, importId, "extracting", "failed", { errorMessage: "extraction_error" });
    return c.json({ ok: false, error: "extraction_error", message: "This document could not be read. Please try again." }, 500);
  }

  if (!extraction.ok) {
    const errKey = extraction.error as PdfValidationError;
    await setImportStatus(db, importId, "extracting", "failed", { errorMessage: errKey });
    return c.json({ ok: false, error: errKey, message: PDF_ERROR_MESSAGES[errKey] }, 400);
  }

  await db.prepare(
    `UPDATE lead_import SET extracted_text=?, extracted_page_count=?, updated_at=datetime('now') WHERE id=?`
  ).bind(extraction.text || "", extraction.pageCount || 0, importId).run();

  // ── Phase 2: AI parsing (shared contract — src/ai/lead-import-parse.ts).
  // AI output is always a SUGGESTION: this phase only writes proposed_json/
  // warnings_json and lands on needs_review, never "ready" and never a CRM
  // write. ─────────────────────────────────────────────────────────────────
  await setImportStatus(db, importId, "extracting", "parsing");

  const { apiKey, baseUrl, model, keySource } = await _aiCreds(db, companyId, c.env);
  if (!apiKey) {
    await setImportStatus(db, importId, "parsing", "needs_review", { errorMessage: "no_api_key" });
    return c.json({
      ok: true,
      data: {
        import_id: importId, status: "needs_review",
        warning: "AI is not enabled for your company yet — the document text was extracted, but you'll need to fill in the lead details manually. Ask your rep to enable AI, or add your own OpenAI key under Integrations.",
        extracted_page_count: extraction.pageCount || 0,
      },
    });
  }
  const quotaGate = await _aiQuotaGate(db, companyId, keySource);
  if (quotaGate) {
    await setImportStatus(db, importId, "parsing", "needs_review", { errorMessage: "quota_exceeded" });
    return c.json({ ok: true, data: { import_id: importId, status: "needs_review", warning: quotaGate.body?.message || "AI quota exceeded — fill in the lead details manually.", extracted_page_count: extraction.pageCount || 0 } });
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
      return c.json({ ok: true, data: { import_id: importId, status: "needs_review", warning: "AI parsing failed — fill in the lead details manually.", extracted_page_count: extraction.pageCount || 0 } });
    }
    const j: any = await r.json();
    await _logAiUsage(db, companyId, repId || "", "lead_import_pdf", model, j?.usage, keySource);
    const raw = (j?.choices?.[0]?.message?.content || "").trim();
    draft = normalizeLeadImportDraft(_aiParseJson(raw));
  } catch (e: any) {
    console.error("[lead-import/extract]", e?.message || e);
    await setImportStatus(db, importId, "parsing", "needs_review", { errorMessage: "ai_error" });
    return c.json({ ok: true, data: { import_id: importId, status: "needs_review", warning: "AI parsing failed — fill in the lead details manually.", extracted_page_count: extraction.pageCount || 0 } });
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

  return c.json({
    ok: true,
    data: {
      import_id: importId,
      status: "needs_review",
      draft,
      division: divisionResult,
      warnings,
      missing_info: missing,
      extracted_page_count: extraction.pageCount || 0,
    },
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
// spec ("fuzzy-as-suggestion-only, deterministic-first"); the not-yet-built
// confirm route is where a human's explicit link-vs-create choice is
// actually acted on.
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
