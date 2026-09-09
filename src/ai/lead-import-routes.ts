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
import type { AppEnv } from "../env";
import { rateLimit } from "../portal";
import { randomToken } from "../marketing/send";
import {
  hasPdfMagicBytes, computeContentHash, safeFilename, documentR2Key,
  MAX_PDF_BYTES,
} from "./pdf-lead-import";

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
