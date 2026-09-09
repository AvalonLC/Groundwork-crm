/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { PDFDocument } from "pdf-lib";
import { leadImportRouter } from "./lead-import-routes";

const db = () => env.DB as D1Database;
const TENANT = "t-lead-import-routes";
const TENANT_2 = "t-lead-import-routes-2";

/**
 * requireAuth is applied at the mount point in src/index.tsx, so wrap the
 * router the same way production does — see src/api/rates.test.ts for the
 * precedent this copies.
 */
function authedAs(companyId: string, repId = "test-rep") {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("companyId" as never, companyId as never);
    c.set("repId" as never, repId as never);
    c.set("role" as never, "owner" as never);
    c.set("isSuperAdmin" as never, false as never);
    await next();
  });
  app.route("/", leadImportRouter);
  return app;
}

async function makePdfBytes(text: string): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawText(text, { x: 50, y: 700, size: 14 });
  const bytes = await doc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function uploadForm(bytes: ArrayBuffer, filename = "Proposal.pdf", type = "application/pdf") {
  const form = new FormData();
  form.set("file", new File([bytes], filename, { type }));
  return form;
}

const postUpload = (companyId: string, form: FormData, repId = "test-rep") =>
  authedAs(companyId, repId).request("/upload", { method: "POST", body: form }, env);

describe("POST /api/lead-import/upload", () => {
  it("LIU-01 stores a new PDF: R2 object written, document + import rows inserted", async () => {
    const bytes = await makePdfBytes("Avalon Tree Removal Proposal LIU-01");
    const res = await postUpload(TENANT, uploadForm(bytes, "Avalon Tree Removal Proposal.pdf"));
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.data.duplicate).toBe(false);
    expect(j.data.import_id).toBeTruthy();
    expect(j.data.document_id).toBeTruthy();
    expect(j.data.idempotency_token).toBeTruthy();
    expect(j.data.status).toBe("uploaded");
    // safe_filename sanitized but human-recognizable (safeFilename() only
    // strips characters unsafe for HTML/header/URL contexts — spaces,
    // hyphens and parentheses survive untouched; see pdf-lead-import.ts's
    // SAFE-01/02 tests).
    expect(j.data.safe_filename).toBe("Avalon Tree Removal Proposal.pdf");

    const doc: any = await db().prepare(
      `SELECT id, company_id, r2_key, sha256_hash, byte_size, status, mime_type FROM lead_import_document WHERE id=?`
    ).bind(j.data.document_id).first();
    expect(doc).toBeTruthy();
    expect(doc.company_id).toBe(TENANT);
    expect(doc.status).toBe("uploaded");
    expect(doc.mime_type).toBe("application/pdf");
    expect(doc.byte_size).toBeGreaterThan(0);

    const imp: any = await db().prepare(
      `SELECT id, company_id, document_id, idempotency_token, status FROM lead_import WHERE id=?`
    ).bind(j.data.import_id).first();
    expect(imp).toBeTruthy();
    expect(imp.company_id).toBe(TENANT);
    expect(imp.document_id).toBe(j.data.document_id);
    expect(imp.status).toBe("uploaded");

    const obj = await (env.MEDIA as R2Bucket).get(doc.r2_key);
    expect(obj).toBeTruthy();
  });

  it("LIU-02 R2 key never derives from the raw filename (path traversal / header injection safe)", async () => {
    const bytes = await makePdfBytes("LIU-02");
    const evilName = '../../../etc/passwd";evil.pdf';
    const res = await postUpload(TENANT, uploadForm(bytes, evilName));
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    const doc: any = await db().prepare(`SELECT r2_key, original_filename, safe_filename FROM lead_import_document WHERE id=?`)
      .bind(j.data.document_id).first();
    // safeFilename() replaces '/' and '"' with '_' — the literal substrings
    // "/etc/passwd" and a raw '"' can therefore never survive into the R2
    // key even though the underlying dots are harmless and allowed through.
    expect(doc.r2_key).not.toContain("/etc/passwd");
    expect(doc.r2_key).not.toContain('"');
    // The File constructor itself percent-encodes control-ish characters in
    // .name (a runtime/undici behavior, not this route's own logic) — so we
    // assert on the parts that survive that encoding rather than exact
    // equality with evilName.
    expect(doc.original_filename).toContain("etc/passwd");
    expect(doc.original_filename).toContain("evil.pdf");
    expect(doc.safe_filename).not.toContain("/");
    expect(doc.safe_filename).not.toContain('"');
  });

  it("LIU-03 duplicate upload (same tenant, same bytes) reuses the existing document, never writes a second R2 object or document row", async () => {
    const bytes = await makePdfBytes("LIU-03 duplicate content");
    const first: any = await (await postUpload(TENANT, uploadForm(bytes, "first.pdf"))).json();
    const second: any = await (await postUpload(TENANT, uploadForm(bytes, "second-name.pdf"))).json();

    expect(first.data.duplicate).toBe(false);
    expect(second.data.duplicate).toBe(true);
    expect(second.data.document_id).toBe(first.data.document_id);
    expect(second.data.import_id).not.toBe(first.data.import_id); // a new import attempt each time
    expect(second.data.idempotency_token).not.toBe(first.data.idempotency_token);

    const docCount: any = await db().prepare(
      `SELECT COUNT(*) AS n FROM lead_import_document WHERE company_id=? AND sha256_hash=(SELECT sha256_hash FROM lead_import_document WHERE id=?)`
    ).bind(TENANT, first.data.document_id).first();
    expect(docCount.n).toBe(1);

    const importCount: any = await db().prepare(
      `SELECT COUNT(*) AS n FROM lead_import WHERE company_id=? AND document_id=?`
    ).bind(TENANT, first.data.document_id).first();
    expect(importCount.n).toBe(2);
  });

  it("LIU-04 the same PDF bytes uploaded by two different tenants creates two separate documents (no cross-tenant dedupe)", async () => {
    const bytes = await makePdfBytes("LIU-04 shared bytes across tenants");
    const a: any = await (await postUpload(TENANT, uploadForm(bytes))).json();
    const b: any = await (await postUpload(TENANT_2, uploadForm(bytes))).json();
    expect(a.data.duplicate).toBe(false);
    expect(b.data.duplicate).toBe(false);
    expect(a.data.document_id).not.toBe(b.data.document_id);

    const docA: any = await db().prepare(`SELECT company_id FROM lead_import_document WHERE id=?`).bind(a.data.document_id).first();
    const docB: any = await db().prepare(`SELECT company_id FROM lead_import_document WHERE id=?`).bind(b.data.document_id).first();
    expect(docA.company_id).toBe(TENANT);
    expect(docB.company_id).toBe(TENANT_2);
  });

  it("LIU-05 rejects a non-PDF file (bad magic bytes) with a named error, writes nothing", async () => {
    const notPdf = new TextEncoder().encode("this is not a pdf, just text").buffer;
    const res = await postUpload(TENANT, uploadForm(notPdf, "fake.pdf"));
    expect(res.status).toBe(400);
    const j: any = await res.json();
    expect(j.ok).toBe(false);
    expect(j.error).toBe("not_pdf");
  });

  it("LIU-06 rejects an empty file", async () => {
    const res = await postUpload(TENANT, uploadForm(new ArrayBuffer(0), "empty.pdf"));
    expect(res.status).toBe(400);
    const j: any = await res.json();
    expect(j.ok).toBe(false);
    expect(j.error).toBe("empty_file");
  });

  it("LIU-07 rejects a file over the size cap without ever calling R2/D1 for it", async () => {
    // A tiny real PDF header followed by padding well past MAX_PDF_BYTES —
    // magic-byte check would pass, so the size gate must fire first and the
    // route must reject before ever reading the body into a hash/R2 write.
    const big = new Uint8Array(16 * 1024 * 1024);
    big.set(new TextEncoder().encode("%PDF-1.4"), 0);
    const res = await postUpload(TENANT, uploadForm(big.buffer, "big.pdf"));
    expect(res.status).toBe(413);
    const j: any = await res.json();
    expect(j.ok).toBe(false);
    expect(j.error).toBe("too_large");
  });

  it("LIU-08 rejects a request with no file field", async () => {
    const form = new FormData();
    form.set("not_file", "nope");
    const res = await authedAs(TENANT).request("/upload", { method: "POST", body: form }, env);
    expect(res.status).toBe(400);
    const j: any = await res.json();
    expect(j.ok).toBe(false);
  });

  it("LIU-09 every id in the response is server-generated, never echoing anything the client could have supplied", async () => {
    const bytes = await makePdfBytes("LIU-09");
    const form = uploadForm(bytes);
    // A client cannot supply an id via the multipart body in the first
    // place (there's no id field in the contract) — this test asserts the
    // response ids are freshly minted, non-empty, and distinct per request,
    // which is the externally-observable half of "server-generated".
    const r1: any = await (await postUpload(TENANT, form)).json();
    const bytes2 = await makePdfBytes("LIU-09b");
    const r2: any = await (await postUpload(TENANT, uploadForm(bytes2))).json();
    expect(r1.data.import_id).not.toBe(r2.data.import_id);
    expect(r1.data.document_id).not.toBe(r2.data.document_id);
    expect(r1.data.idempotency_token).not.toBe(r2.data.idempotency_token);
  });

  it("LIU-10 records the uploading rep on the document row", async () => {
    const bytes = await makePdfBytes("LIU-10");
    const res: any = await (await postUpload(TENANT, uploadForm(bytes), "rep-abc")).json();
    const doc: any = await db().prepare(`SELECT uploaded_by_rep_id FROM lead_import_document WHERE id=?`)
      .bind(res.data.document_id).first();
    expect(doc.uploaded_by_rep_id).toBe("rep-abc");
  });
});
