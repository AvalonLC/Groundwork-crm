/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { PDFDocument } from "pdf-lib";
import { http, HttpResponse } from "msw";
import { network } from "../../test/network";
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

/**
 * Module-scoped (not nested in a single describe block) because both the
 * single-file AI-success tests (LIXA-*) and the bulk-import status tests
 * (LIBS-*) need to configure a fake AI key / mock chat-completion response.
 */
async function enableFakeAiKey(companyId: string) {
  await db().prepare(
    `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, 'sk-test-fake-not-a-real-key', datetime('now'))`
  ).bind(`${companyId}:openai_api_key`).run();
}

/** A complete, schema-shaped chat-completion body — see LEAD_IMPORT_DRAFT_SCHEMA in lead-import-parse.ts. */
function fakeChatCompletion(draftOverrides: Record<string, any> = {}) {
  const draft = {
    contact: { person_name: "Jamie Rivera", company_name: "Rivera Property Group", phone: "555-010-2233", email: "jamie@riverapg.example" },
    client_type: "Commercial",
    properties: [{ label: "Main Site", address: "42 Alder Court, Springfield, OH 45501", notes: "gate code 1234" }],
    project: "Tree removal and stump grinding",
    urgency: "within 30 days",
    contract_hint: "one_time",
    summary_note: "Removal of three dead oaks near the parking lot.",
    pricing_options: [{
      label: "Tree removal (3 trees) + stump grinding", property_label: "Main Site",
      customer_price_low_cents: 180000, customer_price_high_cents: 220000,
      billing_frequency: "one_time", internal_cost_cents: null, is_deposit: false, notes: "",
    }],
    division_suggestion: { label: "Tree Removal", rationale: "Document explicitly describes tree removal and stump grinding work." },
    ...draftOverrides,
  };
  return {
    id: "chatcmpl-fake-test-only", object: "chat.completion", model: "gpt-5-mini",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(draft) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 400, completion_tokens: 120, total_tokens: 520 },
  };
}

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

  // ── AI-call-succeeds branch, mocked via @msw/cloudflare's setupNetwork() ──
  //
  // Every LIX-01..06 test above exercises the "no AI key configured" path
  // (see the describe-block comment above): _aiCreds() finds nothing to
  // call, so extract soft-degrades straight to needs_review without ever
  // reaching _aiChatJson's fetch(). That's real, correct coverage of a real
  // production path (an AI-disabled tenant), but it never actually invokes
  // the fetch() inside _aiChatJson (src/ai/infra.ts) — so a bug specific to
  // handling a successful upstream response (parsing draft.contact fields,
  // running them through classifyDivision/deriveMissingInfo, and persisting
  // proposed_json/warnings_json) had no test able to catch it. The
  // TENANT_AI/TENANT_AI_AVAILABLE tenants below get a real
  // `{companyId}:openai_api_key` settings row (an obviously-fake test-only
  // value, never a real credential) so _aiCreds() resolves a non-empty
  // apiKey and the route actually reaches _aiChatJson -> fetch(); MSW's
  // setupNetwork() (wired into vitest.config.ts's setupFiles via
  // test/mock-network-setup.ts) intercepts that fetch() call *inside the
  // workerd runtime* and returns a canned OpenAI-shaped chat-completion
  // response instead of ever leaving the sandbox — this is the officially
  // documented mechanism for @cloudflare/vitest-pool-workers (see
  // https://developers.cloudflare.com/workers/testing/vitest-integration/mock-outbound-requests/),
  // not the raw undici MockAgent also declared in that package's types.
  const TENANT_AI = "t-lead-import-ai";
  const TENANT_AI_NO_ADDRESS = "t-lead-import-ai-no-address";
  const TENANT_AI_UPSTREAM_ERROR = "t-lead-import-ai-upstream-error";

  it("LIXA-01 AI-success path: parses a full draft, classifies division, and persists proposed_json/warnings_json", async () => {
    await enableFakeAiKey(TENANT_AI);
    network.use(
      http.post("https://api.openai.com/v1/chat/completions", () => HttpResponse.json(fakeChatCompletion())),
    );

    const bytes = await makePdfBytes("LIXA-01 Rivera Property Group tree removal proposal");
    const up: any = await (await postUpload(TENANT_AI, uploadForm(bytes))).json();
    const res = await postExtract(TENANT_AI, up.data.import_id);

    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.data.status).toBe("needs_review");
    expect(j.data.draft.contact.person_name).toBe("Jamie Rivera");
    expect(j.data.draft.contact.company_name).toBe("Rivera Property Group");
    expect(j.data.draft.properties).toHaveLength(1);
    expect(j.data.draft.properties[0].address).toBe("42 Alder Court, Springfield, OH 45501");
    expect(j.data.draft.pricing_options[0].customer_price_low_cents).toBe(180000);
    expect(j.data.draft.pricing_options[0].customer_price_high_cents).toBe(220000);
    // No tenant division setting exists for TENANT_AI, so classifyDivision
    // runs against DEFAULT_DIVISIONS. Neither "Tree Removal" (the AI
    // suggestion's label) nor the project text keyword-match any of
    // LEGACY_KEYWORD_BRIDGES' word lists (landscape/hardscape/drainage/
    // design/irrigat/lighting/enhancement, mainten/mowing/recurring,
    // snow/ice/plow) — so this deliberately lands on the "no confident
    // match, defaulted, please confirm" fallback path, which is itself a
    // real, expected production outcome for a document like this one.
    expect(j.data.division.isFallback).toBe(true);
    expect(j.data.division.source).toBe("default");
    // A full contact + address + phone means nothing should be flagged missing,
    // but the division fallback above still produces exactly one warning.
    expect(j.data.missing_info).toEqual([]);
    expect(j.data.warnings).toEqual([
      'Could not confidently classify a division from this document — defaulted to "Landscape". Please confirm.',
    ]);

    const row: any = await db().prepare(
      `SELECT status, proposed_json, warnings_json, ai_model FROM lead_import WHERE id=?`
    ).bind(up.data.import_id).first();
    expect(row.status).toBe("needs_review");
    expect(row.ai_model).toBe("gpt-5-mini");
    const persisted = JSON.parse(row.proposed_json);
    expect(persisted.contact.person_name).toBe("Jamie Rivera");
    expect(JSON.parse(row.warnings_json)).toEqual([
      'Could not confidently classify a division from this document — defaulted to "Landscape". Please confirm.',
    ]);
  });

  it("LIXA-02 AI-success path with an incomplete draft: missing_info and division-fallback warnings both surface", async () => {
    await enableFakeAiKey(TENANT_AI_NO_ADDRESS);
    network.use(
      http.post("https://api.openai.com/v1/chat/completions", () => HttpResponse.json(fakeChatCompletion({
        contact: { person_name: "", company_name: "", phone: "", email: "" },
        properties: [],
        division_suggestion: { label: "", rationale: "" },
      }))),
    );

    const bytes = await makePdfBytes("LIXA-02 vague document with no contact or address");
    const up: any = await (await postUpload(TENANT_AI_NO_ADDRESS, uploadForm(bytes))).json();
    const res = await postExtract(TENANT_AI_NO_ADDRESS, up.data.import_id);

    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.data.status).toBe("needs_review");
    // No person_name/company_name -> contact_identity; no address -> property_address;
    // no phone/email -> contact_method (see deriveMissingInfo in pdf-lead-import.ts).
    expect(j.data.missing_info).toEqual(["contact_identity", "property_address", "contact_method"]);
    expect(j.data.warnings.some((w: string) => /Missing:/.test(w))).toBe(true);
    expect(j.data.warnings.some((w: string) => /No property address/i.test(w))).toBe(true);
    // Empty division_suggestion.label gives the deterministic classifier
    // nothing to match against either -> falls all the way to the default.
    expect(j.data.division.isFallback).toBe(true);
    expect(j.data.warnings.some((w: string) => /Could not confidently classify a division/i.test(w))).toBe(true);
  });

  it("LIXA-03 upstream non-OK response soft-degrades to needs_review with an ai_upstream error, never a 500", async () => {
    await enableFakeAiKey(TENANT_AI_UPSTREAM_ERROR);
    network.use(
      http.post("https://api.openai.com/v1/chat/completions", () =>
        HttpResponse.json({ error: { message: "invalid_api_key (test double)" } }, { status: 401 })),
    );

    const bytes = await makePdfBytes("LIXA-03 upstream failure case");
    const up: any = await (await postUpload(TENANT_AI_UPSTREAM_ERROR, uploadForm(bytes))).json();
    const res = await postExtract(TENANT_AI_UPSTREAM_ERROR, up.data.import_id);

    expect(res.status).toBe(200); // extraction itself still succeeded — this is a soft degrade, not a route failure
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.data.status).toBe("needs_review");
    expect(j.data.warning).toMatch(/AI parsing failed/i);

    const row: any = await db().prepare(`SELECT status, error_message, proposed_json FROM lead_import WHERE id=?`)
      .bind(up.data.import_id).first();
    expect(row.status).toBe("needs_review");
    expect(row.error_message).toBe("ai_upstream");
    // Column default is NOT NULL DEFAULT '' (migrations/0088), never actually
    // NULL — asserting the empty-string default is what "never partially
    // written on a failed AI call" means at the schema level here.
    expect(row.proposed_json).toBe("");
  });

  it("LIXA-04 a JSON-invalid AI response (never happens with structured outputs, but the bare-fallback path can produce one) still soft-degrades cleanly", async () => {
    await enableFakeAiKey(TENANT_AI_UPSTREAM_ERROR);
    // Reuses TENANT_AI_UPSTREAM_ERROR's already-fake key from LIXA-03 (each
    // test's network.use() handler is reset afterEach, so this is an
    // independent case, not relying on the previous test's registration).
    network.use(
      http.post("https://api.openai.com/v1/chat/completions", () => HttpResponse.json({
        id: "chatcmpl-malformed", object: "chat.completion", model: "gpt-5-mini",
        choices: [{ index: 0, message: { role: "assistant", content: "not json at all, model went rogue" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      })),
    );

    const bytes = await makePdfBytes("LIXA-04 malformed AI response case");
    const up: any = await (await postUpload(TENANT_AI_UPSTREAM_ERROR, uploadForm(bytes))).json();
    const res = await postExtract(TENANT_AI_UPSTREAM_ERROR, up.data.import_id);

    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.data.status).toBe("needs_review");
    expect(j.data.warning).toMatch(/AI parsing failed/i);
    const row: any = await db().prepare(`SELECT error_message FROM lead_import WHERE id=?`).bind(up.data.import_id).first();
    expect(row.error_message).toBe("ai_error"); // _aiParseJson threw -> caught by the catch block, not the r.ok===false branch
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

// ── POST /api/lead-import/:id/confirm ───────────────────────────────────────
// insertOpportunityRow's INSERT carries a real FK (opportunities.rep_id ->
// reps.id) unlike anything hit by the upload/extract/status routes above —
// confirm is the first route in this file that actually creates an
// opportunity row, so its rep_id must reference a real reps row or the
// insert fails with SQLITE_CONSTRAINT_FOREIGNKEY. "test-rep" (the repId
// default used throughout this file) is inserted once per test via
// insertRep() below wherever a test exercises the create-opportunity path.
async function insertRep(id: string) {
  await db().prepare(`INSERT OR IGNORE INTO reps (id, name, role, pin) VALUES (?,?,?,?)`)
    .bind(id, id, "rep", "0000").run();
}

const postConfirm = (companyId: string, importId: string, body: any, repId = "test-rep") =>
  authedAs(companyId, repId).request(`/${importId}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, env);

/**
 * Insert a lead_import (+ its backing lead_import_document) row directly,
 * bypassing upload/extract, so confirm tests can start from an exact,
 * hand-crafted `status`/`proposed_json` state — the same fixture style as
 * LIS-05/LIS-06 above.
 */
async function insertImportFixture(
  companyId: string,
  overrides: Partial<{ importId: string; docId: string; status: string; proposedJson: any }> = {},
) {
  const importId = overrides.importId || `limp_${Math.random().toString(36).slice(2, 10)}`;
  const docId = overrides.docId || `lidoc_${Math.random().toString(36).slice(2, 10)}`;
  const status = overrides.status || "ready";
  const draft = overrides.proposedJson ?? {
    contact: { person_name: "Jane Homeowner", company_name: "", phone: "(555) 123-0000", email: "jane@example.com" },
    client_type: "Residential",
    properties: [{ label: "Primary Property", address: "123 Main St, Springfield, IL 62704", notes: "" }],
    project: "Tree removal", urgency: "", contract_hint: "unknown", summary_note: "Removal of large oak.", pricing_options: [],
    division_suggestion: { label: "Landscape", rationale: "mentions tree work" },
  };
  await db().prepare(
    `INSERT INTO lead_import_document (id, company_id, original_filename, safe_filename, r2_key, byte_size, sha256_hash, status, import_id)
     VALUES (?,?,?,?,?,?,?, 'uploaded', ?)`
  ).bind(docId, companyId, "proposal.pdf", "proposal.pdf", `fake/r2/${docId}`, 10, `hash_${docId}`, importId).run();
  await db().prepare(
    `INSERT INTO lead_import (id, company_id, document_id, idempotency_token, status, proposed_json, warnings_json)
     VALUES (?,?,?,?,?,?, '[]')`
  ).bind(importId, companyId, docId, `tok_${importId}`, status, JSON.stringify(draft)).run();
  return { importId, docId, draft };
}

describe("POST /api/lead-import/:id/confirm", () => {
  it("LIC-01 not found for an unknown import id", async () => {
    const res = await postConfirm(TENANT, "limp_does_not_exist", { approved: {} });
    expect(res.status).toBe(404);
  });

  it("LIC-02 404s (never 403) for another tenant's import", async () => {
    const { importId, draft } = await insertImportFixture(TENANT);
    const res = await postConfirm(TENANT_2, importId, { approved: draft });
    expect(res.status).toBe(404);
  });

  it("LIC-03 rejects confirmation from a status earlier than ready/needs_review (e.g. still extracting)", async () => {
    const { importId, draft } = await insertImportFixture(TENANT, { status: "extracting" });
    const res = await postConfirm(TENANT, importId, { approved: draft });
    expect(res.status).toBe(409);
    const j: any = await res.json();
    expect(j.error).toBe("invalid_state");
  });

  it("LIC-04 rejects a draft with no contact identity (neither person_name nor company_name)", async () => {
    const { importId, draft } = await insertImportFixture(TENANT);
    const badDraft = { ...draft, contact: { ...draft.contact, person_name: "", company_name: "" } };
    const res = await postConfirm(TENANT, importId, { approved: badDraft });
    expect(res.status).toBe(400);
    const j: any = await res.json();
    expect(j.error).toBe("missing_contact_identity");
    // Rejection must not have advanced the import's status at all.
    const row: any = await db().prepare(`SELECT status FROM lead_import WHERE id=?`).bind(importId).first();
    expect(row.status).toBe("ready");
  });

  it("LIC-05 rejects a draft with zero properties", async () => {
    const { importId, draft } = await insertImportFixture(TENANT);
    const badDraft = { ...draft, properties: [] };
    const res = await postConfirm(TENANT, importId, { approved: badDraft });
    expect(res.status).toBe(400);
    const j: any = await res.json();
    expect(j.error).toBe("missing_property");
  });

  it("LIC-06 create-new-client + create-new-property: single opportunity created, client/property rows written, document linked to both", async () => {
    await insertRep("test-rep");
    const { importId, docId, draft } = await insertImportFixture(TENANT);
    const res = await postConfirm(TENANT, importId, { approved: draft });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.data.status).toBe("finalized");
    expect(j.data.result_client_id).toBeTruthy();
    expect(j.data.result_opportunity_ids).toHaveLength(1);

    const clientRow: any = await db().prepare(`SELECT * FROM clients WHERE id=? AND company_id=?`)
      .bind(j.data.result_client_id, TENANT).first();
    expect(clientRow).toBeTruthy();
    expect(clientRow.name).toBe("Jane Homeowner");
    expect(clientRow.email).toBe("jane@example.com");
    expect(clientRow.status).toBe("Active"); // table DEFAULT, not explicitly set by the confirm route

    const oppId = j.data.result_opportunity_ids[0];
    const oppRow: any = await db().prepare(`SELECT * FROM opportunities WHERE id=? AND company_id=?`)
      .bind(oppId, TENANT).first();
    expect(oppRow).toBeTruthy();
    expect(oppRow.client).toBe("Jane Homeowner");
    expect(oppRow.client_id).toBe(j.data.result_client_id);
    expect(oppRow.address).toBe("123 Main St, Springfield, IL 62704");
    expect(oppRow.source).toBe("PDF Import");

    const propRow: any = await db().prepare(`SELECT * FROM properties WHERE company_id=? AND client_id=?`)
      .bind(TENANT, j.data.result_client_id).first();
    expect(propRow).toBeTruthy();
    expect(propRow.street).toBe("123 Main St, Springfield, IL 62704");
    expect(propRow.is_primary).toBe(1);

    const noteRow: any = await db().prepare(`SELECT * FROM notes WHERE opp_id=?`).bind(oppId).first();
    expect(noteRow).toBeTruthy();
    expect(noteRow.body).toContain("Removal of large oak.");

    const links: any = await db().prepare(
      `SELECT entity_type, entity_id FROM lead_import_document_link WHERE company_id=? AND document_id=? ORDER BY entity_type`
    ).bind(TENANT, docId).all();
    const linkSet = (links.results as any[]).map((r) => `${r.entity_type}:${r.entity_id}`);
    expect(linkSet).toContain(`client:${j.data.result_client_id}`);
    expect(linkSet).toContain(`opportunity:${oppId}`);

    const importRow: any = await db().prepare(`SELECT status, result_client_id, confirmed_by_rep_id FROM lead_import WHERE id=?`)
      .bind(importId).first();
    expect(importRow.status).toBe("finalized");
    expect(importRow.result_client_id).toBe(j.data.result_client_id);
    expect(importRow.confirmed_by_rep_id).toBe("test-rep");
  });

  it("LIC-07 multiple properties: one opportunity per property, multi-property naming convention, one property row per site", async () => {
    const draft = {
      contact: { person_name: "Acme Property Mgmt", company_name: "Acme Property Mgmt", phone: "", email: "" },
      client_type: "Commercial",
      properties: [
        { label: "North Lot", address: "1 North Ave", notes: "gate code 4321" },
        { label: "South Lot", address: "2 South Ave", notes: "" },
      ],
      project: "Landscape maintenance", urgency: "", contract_hint: "annual", summary_note: "Two-site contract.", pricing_options: [],
      division_suggestion: { label: "Maintenance", rationale: "" },
    };
    await insertRep("test-rep");
    const { importId } = await insertImportFixture(TENANT, { proposedJson: draft });

    const res = await postConfirm(TENANT, importId, { approved: draft });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.data.result_opportunity_ids).toHaveLength(2);

    const opps: any = await db().prepare(
      `SELECT client, address FROM opportunities WHERE id IN (?,?) ORDER BY address`
    ).bind(j.data.result_opportunity_ids[0], j.data.result_opportunity_ids[1]).all();
    const names = (opps.results as any[]).map((r) => r.client).sort();
    expect(names).toEqual(["Acme Property Mgmt — North Lot", "Acme Property Mgmt — South Lot"]);

    const propCount: any = await db().prepare(
      `SELECT COUNT(*) AS n FROM properties WHERE company_id=? AND client_id=?`
    ).bind(TENANT, j.data.result_client_id).first();
    expect(propCount.n).toBe(2);
  });

  it("LIC-08 link-to-existing-client + link-to-existing-property: no new client/property row created", async () => {
    await insertRep("test-rep");
    const existingClientId = await insertClient(TENANT, { name: "Jane Homeowner", email: "jane@example.com" });
    const existingPropertyId = await insertProperty(TENANT, existingClientId, { street: "123 Main St", city: "Springfield", state: "IL", zip: "62704" });
    const { importId, draft } = await insertImportFixture(TENANT);

    const before: any = await db().prepare(`SELECT COUNT(*) AS n FROM clients WHERE company_id=?`).bind(TENANT).first();
    const beforeProps: any = await db().prepare(`SELECT COUNT(*) AS n FROM properties WHERE company_id=?`).bind(TENANT).first();

    const res = await postConfirm(TENANT, importId, {
      approved: draft,
      client_choice: { action: "link", client_id: existingClientId },
      property_choices: [{ action: "link", property_id: existingPropertyId }],
    });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.data.result_client_id).toBe(existingClientId);

    const after: any = await db().prepare(`SELECT COUNT(*) AS n FROM clients WHERE company_id=?`).bind(TENANT).first();
    const afterProps: any = await db().prepare(`SELECT COUNT(*) AS n FROM properties WHERE company_id=?`).bind(TENANT).first();
    expect(after.n).toBe(before.n); // no new client row
    expect(afterProps.n).toBe(beforeProps.n); // no new property row

    const oppRow: any = await db().prepare(`SELECT client_id FROM opportunities WHERE id=?`).bind(j.data.result_opportunity_ids[0]).first();
    expect(oppRow.client_id).toBe(existingClientId);
  });

  it("LIC-09 a stale/invalid link target falls through to create rather than erroring", async () => {
    await insertRep("test-rep");
    const existingClientId = await insertClient(TENANT, { name: "Jane Homeowner" });
    const { importId, draft } = await insertImportFixture(TENANT);

    const res = await postConfirm(TENANT, importId, {
      approved: draft,
      client_choice: { action: "link", client_id: existingClientId },
      property_choices: [{ action: "link", property_id: "prop_does_not_exist" }],
    });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);

    const propRow: any = await db().prepare(`SELECT * FROM properties WHERE company_id=? AND client_id=?`)
      .bind(TENANT, existingClientId).first();
    expect(propRow).toBeTruthy(); // a new property WAS created despite the bogus link target
  });

  it("LIC-10 linking to a client_id that does not exist at all returns 404 and marks the import failed (retryable)", async () => {
    const { importId, draft } = await insertImportFixture(TENANT);
    const res = await postConfirm(TENANT, importId, {
      approved: draft,
      client_choice: { action: "link", client_id: "cli_does_not_exist" },
    });
    expect(res.status).toBe(404);
    const j: any = await res.json();
    expect(j.error).toBe("client_not_found");

    const row: any = await db().prepare(`SELECT status FROM lead_import WHERE id=?`).bind(importId).first();
    expect(row.status).toBe("failed"); // retryable — canTransition(creating, failed) is legal
  });

  it("LIC-11 idempotency: confirming an already-finalized import returns the ORIGINAL result, creates nothing new", async () => {
    await insertRep("test-rep");
    const { importId, draft } = await insertImportFixture(TENANT);
    const first: any = await (await postConfirm(TENANT, importId, { approved: draft })).json();
    expect(first.data.status).toBe("finalized");

    const clientCountBefore: any = await db().prepare(`SELECT COUNT(*) AS n FROM clients WHERE company_id=?`).bind(TENANT).first();
    const oppCountBefore: any = await db().prepare(`SELECT COUNT(*) AS n FROM opportunities WHERE company_id=?`).bind(TENANT).first();

    // A second confirm call against the same (now finalized) import, even
    // with a different body, must resolve to the FIRST outcome.
    const differentDraft = { ...draft, contact: { ...draft.contact, person_name: "Someone Else Entirely" } };
    const second: any = await (await postConfirm(TENANT, importId, { approved: differentDraft })).json();
    expect(second.data.already_confirmed).toBe(true);
    expect(second.data.result_client_id).toBe(first.data.result_client_id);
    expect(second.data.result_opportunity_ids).toEqual(first.data.result_opportunity_ids);

    const clientCountAfter: any = await db().prepare(`SELECT COUNT(*) AS n FROM clients WHERE company_id=?`).bind(TENANT).first();
    const oppCountAfter: any = await db().prepare(`SELECT COUNT(*) AS n FROM opportunities WHERE company_id=?`).bind(TENANT).first();
    expect(clientCountAfter.n).toBe(clientCountBefore.n); // no second client created
    expect(oppCountAfter.n).toBe(oppCountBefore.n); // no second opportunity created
  });

  it("LIC-12 idempotency: an import already stuck mid-flight (status='creating') also returns already_confirmed rather than creating a second time", async () => {
    const { importId, draft } = await insertImportFixture(TENANT, { status: "creating" });
    const res = await postConfirm(TENANT, importId, { approved: draft });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.data.already_confirmed).toBe(true);
    expect(j.data.status).toBe("creating");
  });

  it("LIC-13 division_key human override selects that division, case-insensitively, over the deterministic classifier's own guess", async () => {
    await insertRep("test-rep");
    await db().prepare(
      `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`
    ).bind(`${TENANT}:company_divisions`, JSON.stringify([
      { key: "landscape", label: "Landscape", color: "#2D7A55" },
      { key: "tree-care", label: "Tree Care", color: "#8A5A2D" },
    ])).run();
    const { importId, draft } = await insertImportFixture(TENANT);

    const res = await postConfirm(TENANT, importId, {
      approved: draft,
      division_key: "TREE-CARE", // deliberately wrong case vs. the stored key "tree-care"
    });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.data.division.division.key).toBe("tree-care");
    expect(j.data.division.source).toBe("explicit");

    const oppRow: any = await db().prepare(`SELECT work_type, service_line FROM opportunities WHERE id=?`)
      .bind(j.data.result_opportunity_ids[0]).first();
    expect(oppRow.work_type).toBe("tree-care");
    expect(oppRow.service_line).toBe("Tree Care");
  });

  it("LIC-14 rate-limits confirm attempts per tenant", async () => {
    const app = authedAs(TENANT);
    for (let n = 0; n < 20; n++) {
      const { importId, draft } = await insertImportFixture(TENANT, { status: "extracting" }); // cheap 409 path, still counted by the limiter
      await app.request(`/${importId}/confirm`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved: draft }),
      }, env);
    }
    const { importId, draft } = await insertImportFixture(TENANT, { status: "extracting" });
    const res = await app.request(`/${importId}/confirm`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved: draft }),
    }, env);
    expect(res.status).toBe(429);
    const j: any = await res.json();
    expect(j.error).toBe("rate_limited");
  });
});

/**
 * Puts a real PDF's bytes into the MEDIA R2 bucket under a given key, then
 * inserts a matching lead_import_document row pointing at that key — the
 * same "R2 object then D1 row" ordering POST /upload itself uses, just
 * skipping the HTTP round-trip so these tests can start from an exact,
 * known r2_key/company_id pairing.
 */
async function insertDocumentWithR2Object(
  companyId: string,
  overrides: Partial<{ id: string; r2Key: string; safeFilename: string; mimeType: string; bytes: ArrayBuffer }> = {},
) {
  const id = overrides.id || `lidoc_${Math.random().toString(36).slice(2, 10)}`;
  const r2Key = overrides.r2Key || `leads/${companyId}/${id}.pdf`;
  const safeFilename = overrides.safeFilename ?? "proposal.pdf";
  const mimeType = overrides.mimeType ?? "application/pdf";
  const bytes = overrides.bytes ?? (await makePdfBytes("Document link test fixture"));
  await (env.MEDIA as R2Bucket).put(r2Key, bytes, { httpMetadata: { contentType: mimeType } });
  await db().prepare(
    `INSERT INTO lead_import_document (id, company_id, original_filename, safe_filename, r2_key, mime_type, byte_size, sha256_hash, status)
     VALUES (?,?,?,?,?,?,?,?, 'uploaded')`
  ).bind(id, companyId, "Original Upload.pdf", safeFilename, r2Key, mimeType, (bytes as ArrayBuffer).byteLength, `hash_${id}`).run();
  return { id, r2Key, safeFilename, mimeType, bytes };
}

describe("GET /api/lead-import/document/:documentId", () => {
  it("LID-01 streams the original PDF bytes for a document owned by the caller's tenant", async () => {
    const { id, bytes, mimeType } = await insertDocumentWithR2Object(TENANT);
    const res = await authedAs(TENANT).request(`/document/${id}`, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(mimeType);
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe((bytes as ArrayBuffer).byteLength);
  });

  it("LID-02 sets Content-Disposition to the sanitized safe_filename, not the raw original_filename", async () => {
    const { id } = await insertDocumentWithR2Object(TENANT, { safeFilename: "avalon_proposal_123.pdf" });
    const res = await authedAs(TENANT).request(`/document/${id}`, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("avalon_proposal_123.pdf");
    expect(res.headers.get("content-disposition")).not.toContain("Original Upload");
  });

  it("LID-03 404s for an unknown document id", async () => {
    const res = await authedAs(TENANT).request(`/document/lidoc_does_not_exist`, {}, env);
    expect(res.status).toBe(404);
  });

  it("LID-04 404s (never 403) for a document belonging to another tenant", async () => {
    const { id } = await insertDocumentWithR2Object(TENANT);
    const res = await authedAs(TENANT_2).request(`/document/${id}`, {}, env);
    expect(res.status).toBe(404);
  });

  it("LID-05 404s if the D1 row exists but the R2 object is missing (storage-layer edge case, not a 500)", async () => {
    const id = `lidoc_${Math.random().toString(36).slice(2, 10)}`;
    // Deliberately skip the R2.put() this time — row exists, object doesn't.
    await db().prepare(
      `INSERT INTO lead_import_document (id, company_id, original_filename, safe_filename, r2_key, mime_type, byte_size, sha256_hash, status)
       VALUES (?,?,?,?,?,?,?,?, 'uploaded')`
    ).bind(id, TENANT, "x.pdf", "x.pdf", `leads/${TENANT}/${id}.pdf`, "application/pdf", 10, `hash_${id}`).run();
    const res = await authedAs(TENANT).request(`/document/${id}`, {}, env);
    expect(res.status).toBe(404);
  });
});

// Dedicated tenant ids for the entity-links suite below, distinct from
// TENANT/TENANT_2. LIC-14 above deliberately exhausts TENANT's
// `lead_import_confirm_${companyId}` rate-limit budget (20/300s) as part of
// testing that limiter — since D1 state (including the rate-limit counter
// row in `settings`) is reset only once per test FILE, not per test,
// reusing TENANT here for further postConfirm() calls would themselves get
// 429'd by that already-exhausted budget. Fresh tenant ids sidestep that
// entirely, the same way a genuinely different company would in production.
const TENANT_LINKS = "t-lead-import-links";
const TENANT_LINKS_2 = "t-lead-import-links-2";

describe("GET /api/lead-import/entity-links/:entityType/:entityId", () => {
  it("LIL-01 returns the linked document for an opportunity created via confirm", async () => {
    await insertRep("test-rep");
    const { importId, draft } = await insertImportFixture(TENANT_LINKS);
    const confirmed: any = await (await postConfirm(TENANT_LINKS, importId, { approved: draft })).json();
    const oppId = confirmed.data.result_opportunity_ids[0];

    const res = await authedAs(TENANT_LINKS).request(`/entity-links/opportunity/${oppId}`, {}, env);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.data.length).toBe(1);
    expect(j.data[0].document_id).toBeTruthy();
    expect(j.data[0].download_url).toBe(`/api/lead-import/document/${j.data[0].document_id}`);
  });

  it("LIL-02 returns the linked document for the client created via the same confirm", async () => {
    await insertRep("test-rep");
    const { importId, draft } = await insertImportFixture(TENANT_LINKS);
    const confirmed: any = await (await postConfirm(TENANT_LINKS, importId, { approved: draft })).json();

    const res = await authedAs(TENANT_LINKS).request(`/entity-links/client/${confirmed.data.result_client_id}`, {}, env);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.data.length).toBe(1);
    expect(j.data[0].document_id).toBeTruthy();
  });

  it("LIL-03 returns an empty array (not 404) for an entity with no linked documents", async () => {
    const res = await authedAs(TENANT_LINKS).request(`/entity-links/opportunity/opp_never_imported`, {}, env);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.data).toEqual([]);
  });

  it("LIL-04 rejects an unknown entity_type with 400", async () => {
    const res = await authedAs(TENANT_LINKS).request(`/entity-links/invoice/inv_123`, {}, env);
    expect(res.status).toBe(400);
    const j: any = await res.json();
    expect(j.error).toBe("bad_request");
  });

  it("LIL-05 is tenant-scoped: another tenant's request for the same entity_id sees no links", async () => {
    await insertRep("test-rep");
    const { importId, draft } = await insertImportFixture(TENANT_LINKS);
    const confirmed: any = await (await postConfirm(TENANT_LINKS, importId, { approved: draft })).json();
    const oppId = confirmed.data.result_opportunity_ids[0];

    const res = await authedAs(TENANT_LINKS_2).request(`/entity-links/opportunity/${oppId}`, {}, env);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.data).toEqual([]);
  });

  it("LIL-06 a multi-property import links the SAME document to every resulting opportunity plus the client", async () => {
    await insertRep("test-rep");
    const draft = {
      contact: { person_name: "Multi Site Owner", company_name: "", phone: "(555) 999-1111", email: "multi@example.com" },
      client_type: "Residential",
      properties: [
        { label: "North Lot", address: "1 North Rd, Springfield, IL 62704", notes: "" },
        { label: "South Lot", address: "2 South Rd, Springfield, IL 62704", notes: "" },
      ],
      project: "Tree removal", urgency: "", contract_hint: "unknown", summary_note: "", pricing_options: [],
      division_suggestion: { label: "Landscape", rationale: "" },
    };
    const { importId } = await insertImportFixture(TENANT_LINKS, { proposedJson: draft });
    const confirmed: any = await (await postConfirm(TENANT_LINKS, importId, { approved: draft })).json();
    expect(confirmed.data.result_opportunity_ids.length).toBe(2);

    for (const oppId of confirmed.data.result_opportunity_ids) {
      const res = await authedAs(TENANT_LINKS).request(`/entity-links/opportunity/${oppId}`, {}, env);
      const j: any = await res.json();
      expect(j.data.length).toBe(1);
      expect(j.data[0].document_id).toBeTruthy();
    }

    const [linkA, linkB] = await Promise.all(
      confirmed.data.result_opportunity_ids.map(async (oppId: string) => {
        const res = await authedAs(TENANT_LINKS).request(`/entity-links/opportunity/${oppId}`, {}, env);
        const j: any = await res.json();
        return j.data[0].document_id;
      }),
    );
    expect(linkA).toBe(linkB); // one PDF, one document row, linked to both resulting opportunities
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PR2 — Bulk PDF import. Every route here reuses ingestPdfBytes()/
// runExtraction() (the exact functions POST /upload and POST /:id/extract
// call above), so these tests focus on the bulk-specific behavior — file
// count/size limits, per-file independent outcomes, batch status
// aggregation, concurrency bound — rather than re-proving the dedupe/
// extraction logic itself, which LIU-01..LIX-0N already cover.
// ═══════════════════════════════════════════════════════════════════════════

function bulkUploadForm(files: Array<{ bytes: ArrayBuffer; filename?: string; type?: string }>) {
  const form = new FormData();
  for (const f of files) {
    form.append("files", new File([f.bytes], f.filename || "Proposal.pdf", { type: f.type || "application/pdf" }));
  }
  return form;
}

const postBulkUpload = (companyId: string, form: FormData, repId = "test-rep") =>
  authedAs(companyId, repId).request("/bulk/upload", { method: "POST", body: form }, env);

const postBulkExtract = (companyId: string, batchId: string, repId = "test-rep") =>
  authedAs(companyId, repId).request(`/bulk/${batchId}/extract`, { method: "POST" }, env);

const getBulkStatus = (companyId: string, batchId: string) =>
  authedAs(companyId).request(`/bulk/${batchId}`, {}, env);

describe("POST /api/lead-import/bulk/upload", () => {
  it("LIBU-01 uploads several distinct PDFs: one batch row, one lead_import per file, all sharing batch_id", async () => {
    const files = await Promise.all(
      ["Alpha", "Beta", "Gamma"].map((label) => makePdfBytes(`LIBU-01 ${label} proposal`)),
    );
    const res = await postBulkUpload(
      "t-libu-01",
      bulkUploadForm(files.map((bytes, i) => ({ bytes, filename: `${["Alpha", "Beta", "Gamma"][i]}.pdf` }))),
    );
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.data.file_count).toBe(3);
    expect(j.data.results.length).toBe(3);
    expect(j.data.results.every((r: any) => r.ok)).toBe(true);
    const importIds = new Set(j.data.results.map((r: any) => r.import_id));
    expect(importIds.size).toBe(3); // three distinct imports, not deduped against each other (different bytes)

    const batch: any = await db().prepare(`SELECT company_id, status, file_count FROM lead_import_batch WHERE id=?`)
      .bind(j.data.batch_id).first();
    expect(batch.company_id).toBe("t-libu-01");
    expect(batch.status).toBe("queued");
    expect(batch.file_count).toBe(3);

    const imports = await db().prepare(`SELECT id, batch_id, status FROM lead_import WHERE batch_id=?`)
      .bind(j.data.batch_id).all();
    expect(imports.results?.length).toBe(3);
    expect(imports.results?.every((r: any) => r.status === "uploaded")).toBe(true);
  });

  it("LIBU-02 rejects a batch with more than MAX_BULK_FILES entries, without creating a batch row", async () => {
    const bytesList = await Promise.all(
      Array.from({ length: 11 }, (_, i) => makePdfBytes(`LIBU-02 file ${i}`)),
    );
    const before = await db().prepare(`SELECT COUNT(*) AS n FROM lead_import_batch WHERE company_id='t-libu-02'`).first<any>();
    const res = await postBulkUpload("t-libu-02", bulkUploadForm(bytesList.map((bytes, i) => ({ bytes, filename: `f${i}.pdf` }))));
    expect(res.status).toBe(400);
    const j: any = await res.json();
    expect(j.ok).toBe(false);
    expect(j.error).toBe("too_many_files");
    const after = await db().prepare(`SELECT COUNT(*) AS n FROM lead_import_batch WHERE company_id='t-libu-02'`).first<any>();
    expect(after.n).toBe(before.n);
  });

  it("LIBU-03 a hash-duplicate within the same batch reuses the existing document, never creates a second one", async () => {
    const bytes = await makePdfBytes("LIBU-03 identical content twice");
    const res = await postBulkUpload("t-libu-03", bulkUploadForm([
      { bytes, filename: "Copy1.pdf" },
      { bytes, filename: "Copy2.pdf" },
    ]));
    const j: any = await res.json();
    expect(j.data.results[0].ok).toBe(true);
    expect(j.data.results[1].ok).toBe(true);
    expect(j.data.results[0].document_id).toBe(j.data.results[1].document_id); // same bytes -> same document row
    expect(j.data.results[0].duplicate).toBe(false);
    expect(j.data.results[1].duplicate).toBe(true); // second entry recognized as a dupe of the first, within the same request

    const docs = await db().prepare(`SELECT COUNT(*) AS n FROM lead_import_document WHERE company_id='t-libu-03'`).first<any>();
    expect(docs.n).toBe(1);
    const imports = await db().prepare(`SELECT COUNT(*) AS n FROM lead_import WHERE batch_id=?`).bind(j.data.batch_id).first<any>();
    expect(imports.n).toBe(2); // two import attempts, one document
  });

  it("LIBU-04 a bad file in the batch is reported independently and never blocks the good files", async () => {
    const good = await makePdfBytes("LIBU-04 good proposal");
    const notPdf = new TextEncoder().encode("not a pdf at all").buffer;
    const res = await postBulkUpload("t-libu-04", bulkUploadForm([
      { bytes: good, filename: "Good.pdf" },
      { bytes: notPdf, filename: "Bad.pdf" },
    ]));
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.data.file_count).toBe(1); // only the accepted file counts
    const [okResult, badResult] = j.data.results;
    expect(okResult.ok).toBe(true);
    expect(badResult.ok).toBe(false);
    expect(badResult.error).toBe("not_pdf");

    const batch: any = await db().prepare(`SELECT file_count FROM lead_import_batch WHERE id=?`).bind(j.data.batch_id).first();
    expect(batch.file_count).toBe(1);
    const imports = await db().prepare(`SELECT COUNT(*) AS n FROM lead_import WHERE batch_id=?`).bind(j.data.batch_id).first<any>();
    expect(imports.n).toBe(1); // the rejected file never got an import row at all
  });

  it("LIBU-05 rejects an empty files list", async () => {
    const res = await postBulkUpload("t-libu-05", new FormData());
    expect(res.status).toBe(400);
    const j: any = await res.json();
    expect(j.error).toBe("bad_request");
  });

  it("LIBU-06 two different tenants uploading byte-identical PDFs in the same request get independent documents", async () => {
    const bytes = await makePdfBytes("LIBU-06 shared template text");
    const [resA, resB] = await Promise.all([
      postBulkUpload("t-libu-06a", bulkUploadForm([{ bytes }])),
      postBulkUpload("t-libu-06b", bulkUploadForm([{ bytes }])),
    ]);
    const [ja, jb]: any[] = await Promise.all([resA.json(), resB.json()]);
    expect(ja.data.results[0].duplicate).toBe(false);
    expect(jb.data.results[0].duplicate).toBe(false);
    expect(ja.data.results[0].document_id).not.toBe(jb.data.results[0].document_id);
  });
});

describe("POST /api/lead-import/bulk/:batchId/extract", () => {
  it("LIBX-01 not found for an unknown batch id", async () => {
    const res = await postBulkExtract("t-libx-01", "libatch_does_not_exist");
    expect(res.status).toBe(404);
    const j: any = await res.json();
    expect(j.error).toBe("not_found");
  });

  it("LIBX-02 extracts every eligible import in the batch (no AI key configured -> each soft-degrades to needs_review)", async () => {
    const bytesList = await Promise.all([
      makePdfBytes("LIBX-02 Alpha proposal with enough real text to extract"),
      makePdfBytes("LIBX-02 Beta proposal with enough real text to extract"),
    ]);
    const up: any = await (await postBulkUpload("t-libx-02", bulkUploadForm(bytesList.map((bytes, i) => ({ bytes, filename: `f${i}.pdf` }))))).json();

    const res = await postBulkExtract("t-libx-02", up.data.batch_id);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.data.processed).toBe(2);
    expect(j.data.results.every((r: any) => r.status === "needs_review")).toBe(true);
    expect(j.data.status).toBe("ready"); // at least one reviewable import -> batch is 'ready'

    const rows = await db().prepare(`SELECT status FROM lead_import WHERE batch_id=?`).bind(up.data.batch_id).all();
    expect(rows.results?.every((r: any) => r.status === "needs_review")).toBe(true);

    const batch: any = await db().prepare(`SELECT status FROM lead_import_batch WHERE id=?`).bind(up.data.batch_id).first();
    expect(batch.status).toBe("ready");
  });

  it("LIBX-03 calling extract again on an already-needs_review batch re-enters cleanly (idempotent-safe retry)", async () => {
    const bytes = await makePdfBytes("LIBX-03 retry-safe proposal with real text");
    const up: any = await (await postBulkUpload("t-libx-03", bulkUploadForm([{ bytes }]))).json();
    await postBulkExtract("t-libx-03", up.data.batch_id);

    const res2 = await postBulkExtract("t-libx-03", up.data.batch_id);
    expect(res2.status).toBe(200);
    const j2: any = await res2.json();
    expect(j2.data.processed).toBe(1);
    expect(j2.data.results[0].status).toBe("needs_review");
  });

  it("LIBX-04 an import already past review (e.g. finalized) is skipped, not re-extracted", async () => {
    const bytesA = await makePdfBytes("LIBX-04 Alpha proposal with real text");
    const bytesB = await makePdfBytes("LIBX-04 Beta proposal with real text");
    const up: any = await (await postBulkUpload("t-libx-04", bulkUploadForm([
      { bytes: bytesA, filename: "a.pdf" }, { bytes: bytesB, filename: "b.pdf" },
    ]))).json();
    const [importA, importB] = up.data.results.map((r: any) => r.import_id);

    // Manually fast-forward the first import straight to 'finalized' —
    // simulates "one file in this batch was already reviewed and confirmed
    // by a human before extract ran (or re-ran) on the rest of the batch".
    await db().prepare(`UPDATE lead_import SET status='finalized' WHERE id=?`).bind(importA).run();

    const res = await postBulkExtract("t-libx-04", up.data.batch_id);
    const j: any = await res.json();
    expect(j.data.processed).toBe(1); // only importB was eligible
    expect(j.data.results[0].import_id).toBe(importB);

    const rowA: any = await db().prepare(`SELECT status FROM lead_import WHERE id=?`).bind(importA).first();
    expect(rowA.status).toBe("finalized"); // untouched
  });

  it("LIBX-05 a batch whose every import is already past review returns processed:0 without changing batch status", async () => {
    const bytes = await makePdfBytes("LIBX-05 already-finalized proposal");
    const up: any = await (await postBulkUpload("t-libx-05", bulkUploadForm([{ bytes }]))).json();
    const importId = up.data.results[0].import_id;
    await db().prepare(`UPDATE lead_import SET status='finalized' WHERE id=?`).bind(importId).run();
    await db().prepare(`UPDATE lead_import_batch SET status='completed' WHERE id=?`).bind(up.data.batch_id).run();

    const res = await postBulkExtract("t-libx-05", up.data.batch_id);
    const j: any = await res.json();
    expect(j.data.processed).toBe(0);
    expect(j.data.status).toBe("completed"); // reported as-is, never flipped to 'processing'/'ready' for zero work
  });

  it("LIBX-06 a batch belonging to a different tenant is not found (tenant isolation)", async () => {
    const bytes = await makePdfBytes("LIBX-06 tenant isolation check");
    const up: any = await (await postBulkUpload("t-libx-06a", bulkUploadForm([{ bytes }]))).json();
    const res = await postBulkExtract("t-libx-06b", up.data.batch_id);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/lead-import/bulk/:batchId", () => {
  it("LIBS-01 not found for an unknown batch id", async () => {
    const res = await getBulkStatus("t-libs-01", "libatch_does_not_exist");
    expect(res.status).toBe(404);
  });

  it("LIBS-02 lists every import in the batch with its own status, filename, and missing_info — never the full draft", async () => {
    // Unlike LIBS-03 (no AI key -> soft-degrade, proposed_json never
    // written, has_draft correctly false), this test's own intent per its
    // docstring is to verify has_draft:true + real missing_info values on a
    // batch that WAS successfully extracted by the AI path. That requires a
    // configured (fake) AI key and a mocked upstream response, same as
    // LIXA-02, so runExtraction() actually reaches the branch that writes
    // proposed_json/warnings_json instead of taking the no-API-key
    // early-return. The draft itself is deliberately all-blank contact
    // fields (mirroring LIXA-02's TENANT_AI_NO_ADDRESS case) so the
    // pre-existing missing_info assertion below stays valid.
    await enableFakeAiKey("t-libs-02");
    network.use(
      http.post("https://api.openai.com/v1/chat/completions", () => HttpResponse.json(fakeChatCompletion({
        contact: { person_name: "", company_name: "", phone: "", email: "" },
        properties: [],
        division_suggestion: { label: "", rationale: "" },
      }))),
    );

    const bytesA = await makePdfBytes("LIBS-02 Alpha proposal with real text");
    const bytesB = await makePdfBytes("LIBS-02 Beta proposal with real text");
    const up: any = await (await postBulkUpload("t-libs-02", bulkUploadForm([
      { bytes: bytesA, filename: "Alpha.pdf" }, { bytes: bytesB, filename: "Beta.pdf" },
    ]))).json();
    await postBulkExtract("t-libs-02", up.data.batch_id);

    const res = await getBulkStatus("t-libs-02", up.data.batch_id);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.data.batch_id).toBe(up.data.batch_id);
    expect(j.data.file_count).toBe(2);
    expect(j.data.imports.length).toBe(2);
    for (const imp of j.data.imports) {
      expect(imp.status).toBe("needs_review");
      expect(imp.has_draft).toBe(true);
      expect(["Alpha.pdf", "Beta.pdf"]).toContain(imp.original_filename);
      expect(imp).not.toHaveProperty("draft"); // list view never returns the full draft body
      expect(imp).not.toHaveProperty("proposed_json");
      // Blank AI draft contact fields -> every canonical field missing,
      // same derivation GET /:id uses.
      expect(imp.missing_info).toEqual(["contact_identity", "property_address", "contact_method"]);
    }
  });

  it("LIBS-03 reflects a not-yet-extracted batch's per-import status as 'uploaded' with has_draft:false", async () => {
    const bytes = await makePdfBytes("LIBS-03 not yet extracted");
    const up: any = await (await postBulkUpload("t-libs-03", bulkUploadForm([{ bytes }]))).json();

    const res = await getBulkStatus("t-libs-03", up.data.batch_id);
    const j: any = await res.json();
    expect(j.data.imports[0].status).toBe("uploaded");
    expect(j.data.imports[0].has_draft).toBe(false);
    expect(j.data.imports[0].warnings).toEqual([]);
  });

  it("LIBS-04 a batch belonging to a different tenant is not found (tenant isolation)", async () => {
    const bytes = await makePdfBytes("LIBS-04 tenant isolation check");
    const up: any = await (await postBulkUpload("t-libs-04a", bulkUploadForm([{ bytes }]))).json();
    const res = await getBulkStatus("t-libs-04b", up.data.batch_id);
    expect(res.status).toBe(404);
  });
});
