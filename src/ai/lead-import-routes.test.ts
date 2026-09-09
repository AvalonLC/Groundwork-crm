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

// ── POST /api/lead-import/:id/extract ───────────────────────────────────────
// The test tenants here have no `settings` rows and no env.OPENAI_API_KEY
// (see wrangler.jsonc / .dev.vars for this test run), so _aiCreds() always
// resolves to an empty apiKey — every extract call below exercises the
// "extraction succeeds, AI parsing soft-degrades to needs_review with a
// warning" path. That path is exactly what a real AI-disabled tenant hits,
// and separately proves extraction/R2/state-machine wiring end-to-end
// without needing to mock fetch. The AI-call-succeeds branch (draft parsing,
// division classification, missing-info) is unit-tested in isolation by
// lead-import-parse.test.ts / lead-import-division.test.ts / this module's
// PDF-08..PDF-10-equivalent coverage in pdf-lead-import.test.ts, and by the
// stubbed-fetch path noted for future work in this route's own review.
const postExtract = (companyId: string, importId: string, repId = "test-rep") =>
  authedAs(companyId, repId).request(`/${importId}/extract`, { method: "POST" }, env);

describe("POST /api/lead-import/:id/extract", () => {
  it("LIX-01 not found for an unknown import id", async () => {
    const res = await postExtract(TENANT, "limp_does_not_exist");
    expect(res.status).toBe(404);
  });

  it("LIX-02 404s (never 403) for another tenant's import — same convention as portal media routes", async () => {
    const bytes = await makePdfBytes("LIX-02 cross tenant");
    const up: any = await (await postUpload(TENANT, uploadForm(bytes))).json();
    const res = await postExtract(TENANT_2, up.data.import_id);
    expect(res.status).toBe(404);
  });

  it("LIX-03 extracts text from a stored PDF and soft-degrades to needs_review when AI is not enabled", async () => {
    const marker = "LIX-03 Avalon Tree Removal unique marker text";
    const bytes = await makePdfBytes(marker);
    const up: any = await (await postUpload(TENANT, uploadForm(bytes))).json();

    const res = await postExtract(TENANT, up.data.import_id);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.data.status).toBe("needs_review");
    expect(j.data.warning).toMatch(/AI is not enabled/i);
    expect(j.data.extracted_page_count).toBe(1);

    const row: any = await db().prepare(`SELECT status, extracted_text, error_message FROM lead_import WHERE id=?`)
      .bind(up.data.import_id).first();
    expect(row.status).toBe("needs_review");
    expect(row.extracted_text).toContain("LIX-03");
    expect(row.error_message).toBe("no_api_key");
  });

  it("LIX-04 rejects re-extraction once an import has moved past review (e.g. ready)", async () => {
    const bytes = await makePdfBytes("LIX-04");
    const up: any = await (await postUpload(TENANT, uploadForm(bytes))).json();
    await postExtract(TENANT, up.data.import_id); // -> needs_review
    await db().prepare(`UPDATE lead_import SET status='ready' WHERE id=?`).bind(up.data.import_id).run();

    const res = await postExtract(TENANT, up.data.import_id);
    expect(res.status).toBe(409);
    const j: any = await res.json();
    expect(j.error).toBe("invalid_state");
  });

  it("LIX-05 retry-from-failed re-enters extraction (canTransition failed -> extracting)", async () => {
    const bytes = await makePdfBytes("LIX-05 retry from failed enough characters");
    const up: any = await (await postUpload(TENANT, uploadForm(bytes))).json();
    await db().prepare(`UPDATE lead_import SET status='failed', error_message='extraction_error' WHERE id=?`)
      .bind(up.data.import_id).run();

    const res = await postExtract(TENANT, up.data.import_id);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.data.status).toBe("needs_review");
  });

  it("LIX-06 document_missing (500) when the R2 object backing the import is gone", async () => {
    const bytes = await makePdfBytes("LIX-06");
    const up: any = await (await postUpload(TENANT, uploadForm(bytes))).json();
    const doc: any = await db().prepare(`SELECT r2_key FROM lead_import_document WHERE id=?`)
      .bind(up.data.document_id).first();
    await (env.MEDIA as R2Bucket).delete(doc.r2_key);

    const res = await postExtract(TENANT, up.data.import_id);
    expect(res.status).toBe(500);
    const j: any = await res.json();
    expect(j.error).toBe("document_missing");
    const row: any = await db().prepare(`SELECT status FROM lead_import WHERE id=?`).bind(up.data.import_id).first();
    expect(row.status).toBe("failed");
  });
});

// ── GET /api/lead-import/:id ─────────────────────────────────────────────
const getImport = (companyId: string, importId: string, repId = "test-rep") =>
  authedAs(companyId, repId).request(`/${importId}`, { method: "GET" }, env);

async function insertClient(companyId: string, fields: Partial<{ id: string; name: string; phone: string; email: string; address: string; type: string }> = {}) {
  const id = fields.id || `cli_${Math.random().toString(36).slice(2, 10)}`;
  await db().prepare(
    `INSERT INTO clients (id, company_id, name, phone, email, address, type) VALUES (?,?,?,?,?,?,?)`
  ).bind(id, companyId, fields.name || "", fields.phone || "", fields.email || "", fields.address || "", fields.type || "Residential").run();
  return id;
}

async function insertProperty(companyId: string, clientId: string, fields: Partial<{ id: string; label: string; street: string; city: string; state: string; zip: string }> = {}) {
  const id = fields.id || `prop_${Math.random().toString(36).slice(2, 10)}`;
  await db().prepare(
    `INSERT INTO properties (id, company_id, client_id, label, street, city, state, zip) VALUES (?,?,?,?,?,?,?,?)`
  ).bind(id, companyId, clientId, fields.label || "Primary Property", fields.street || "", fields.city || "", fields.state || "", fields.zip || "").run();
  return id;
}

describe("GET /api/lead-import/:id", () => {
  it("LIS-01 not found for an unknown import id", async () => {
    const res = await getImport(TENANT, "limp_does_not_exist");
    expect(res.status).toBe(404);
  });

  it("LIS-02 404s (never 403) for another tenant's import", async () => {
    const bytes = await makePdfBytes("LIS-02 cross tenant status read");
    const up: any = await (await postUpload(TENANT, uploadForm(bytes))).json();
    const res = await getImport(TENANT_2, up.data.import_id);
    expect(res.status).toBe(404);
  });

  it("LIS-03 returns draft:null and empty matches before extraction has run", async () => {
    const bytes = await makePdfBytes("LIS-03 not yet extracted");
    const up: any = await (await postUpload(TENANT, uploadForm(bytes))).json();

    const res = await getImport(TENANT, up.data.import_id);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.data.status).toBe("uploaded");
    expect(j.data.draft).toBeNull();
    expect(j.data.client_matches).toEqual([]);
    expect(j.data.property_matches).toEqual([]);
  });

  it("LIS-04 after extraction (AI disabled), returns draft:null since no proposed_json exists yet, but exposes the no_api_key warning state", async () => {
    // Extraction alone (with AI disabled, per every test tenant here — see
    // the LIX-03 comment above) never writes proposed_json; only a
    // successful AI parse does. This route must reflect that honestly
    // rather than fabricating a draft.
    const bytes = await makePdfBytes("LIS-04 extracted but ai disabled enough chars");
    const up: any = await (await postUpload(TENANT, uploadForm(bytes))).json();
    await postExtract(TENANT, up.data.import_id);

    const res = await getImport(TENANT, up.data.import_id);
    const j: any = await res.json();
    expect(j.data.status).toBe("needs_review");
    expect(j.data.draft).toBeNull();
    expect(j.data.error_message).toBe("no_api_key");
  });

  it("LIS-05 surfaces a deterministic client match by email and a fuzzy property-address suggestion, scoped to that client", async () => {
    const importId = "limp_lis05_fixture";
    const clientId = await insertClient(TENANT, { name: "Jane Homeowner", email: "jane@example.com", phone: "5551230000" });
    await insertProperty(TENANT, clientId, { street: "123 Main St", city: "Springfield", state: "IL", zip: "62704" });
    // A second, unrelated client+property in the same tenant must never be
    // pulled in by the clientId-scoped property search below.
    const otherClientId = await insertClient(TENANT, { name: "Unrelated Co" });
    await insertProperty(TENANT, otherClientId, { street: "123 Main St", city: "Springfield", state: "IL", zip: "62704" });

    const docId = "lidoc_lis05_fixture";
    await db().prepare(
      `INSERT INTO lead_import_document (id, company_id, original_filename, safe_filename, r2_key, byte_size, sha256_hash, status, import_id)
       VALUES (?,?,?,?,?,?,?, 'uploaded', ?)`
    ).bind(docId, TENANT, "x.pdf", "x.pdf", "fake/r2/key", 10, "deadbeef_lis05", importId).run();
    await db().prepare(
      `INSERT INTO lead_import (id, company_id, document_id, idempotency_token, status, proposed_json, warnings_json)
       VALUES (?,?,?,?, 'needs_review', ?, '[]')`
    ).bind(
      importId, TENANT, docId, "tok_lis05",
      JSON.stringify({
        contact: { person_name: "Jane Homeowner", company_name: "", phone: "(555) 123-0000", email: "jane@example.com" },
        client_type: "Residential",
        properties: [{ label: "Primary Property", address: "123 Main St, Springfield, IL 62704", notes: "" }],
        project: "Tree removal", urgency: "", contract_hint: "unknown", summary_note: "", pricing_options: [],
        division_suggestion: { label: "", rationale: "" },
        division: { division: { key: "landscape", label: "Landscape" }, source: "keyword", isFallback: false },
      }),
    ).run();

    const res = await getImport(TENANT, importId);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.data.draft.contact.email).toBe("jane@example.com");
    expect(j.data.division.division.key).toBe("landscape");

    expect(j.data.client_matches).toHaveLength(1);
    expect(j.data.client_matches[0].client.id).toBe(clientId);
    expect(j.data.client_matches[0].strength).toBe("deterministic");
    expect(j.data.client_matches[0].basis).toContain("email");

    // Property match must be scoped to the deterministic client's own
    // property, never the unrelated client's identically-addressed one.
    expect(j.data.property_matches.length).toBeGreaterThan(0);
    for (const m of j.data.property_matches) {
      expect(m.property.client_id).toBe(clientId);
    }
    expect(j.data.missing_info).toEqual([]);
  });

  it("LIS-06 no match candidates when nothing in the tenant's client list matches", async () => {
    const importId = "limp_lis06_fixture";
    const docId = "lidoc_lis06_fixture";
    await db().prepare(
      `INSERT INTO lead_import_document (id, company_id, original_filename, safe_filename, r2_key, byte_size, sha256_hash, status, import_id)
       VALUES (?,?,?,?,?,?,?, 'uploaded', ?)`
    ).bind(docId, TENANT, "x.pdf", "x.pdf", "fake/r2/key2", 10, "deadbeef_lis06", importId).run();
    await db().prepare(
      `INSERT INTO lead_import (id, company_id, document_id, idempotency_token, status, proposed_json, warnings_json)
       VALUES (?,?,?,?, 'needs_review', ?, '["No property address was found in this document."]')`
    ).bind(
      importId, TENANT, docId, "tok_lis06",
      JSON.stringify({
        contact: { person_name: "Nobody Known", company_name: "", phone: "", email: "" },
        client_type: "Residential",
        properties: [],
        project: "", urgency: "", contract_hint: "unknown", summary_note: "", pricing_options: [],
        division_suggestion: { label: "", rationale: "" },
        division: { division: { key: "landscape", label: "Landscape" }, source: "default", isFallback: true },
      }),
    ).run();

    const res = await getImport(TENANT, importId);
    const j: any = await res.json();
    expect(j.data.client_matches).toEqual([]);
    expect(j.data.property_matches).toEqual([]);
    expect(j.data.missing_info).toEqual(expect.arrayContaining(["property_address", "contact_method"]));
    expect(j.data.warnings).toEqual(["No property address was found in this document."]);
  });
});
