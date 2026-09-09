/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractText, getDocumentProxy } from "unpdf";
import {
  MAX_PDF_BYTES, MAX_PDF_PAGES, MAX_EXTRACTED_TEXT_CHARS,
  hasPdfMagicBytes, validateAndExtractPdf, computeContentHash, safeFilename,
  documentR2Key, canTransition, isRetryable, isTerminal, deriveMissingInfo,
  type PdfExtractor,
} from "./pdf-lead-import";

// ── Fixture helpers — sanitized, synthetic PDFs generated in-process, never
// committed real customer documents (per spec's testing requirement). ──────

async function makePdf(text: string, pages = 1): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`${text} (page ${i + 1})`, { x: 50, y: 700, size: 14, font });
  }
  const bytes = await doc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function makeBlankPdf(pages = 1): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]);
  const bytes = await doc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/** The real extractor, wired to unpdf — used by the "real PDF" tests below. */
const realExtractor: PdfExtractor = async (bytes) => {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return { totalPages, text: String(text || "") };
};

describe("hasPdfMagicBytes", () => {
  it("PDF-01 true for real PDF bytes, false for arbitrary text", async () => {
    const pdf = await makePdf("hello");
    expect(hasPdfMagicBytes(pdf)).toBe(true);
    expect(hasPdfMagicBytes(new TextEncoder().encode("not a pdf").buffer)).toBe(false);
  });

  it("PDF-02 false for a buffer shorter than the magic number itself", () => {
    expect(hasPdfMagicBytes(new TextEncoder().encode("%PD").buffer)).toBe(false);
  });
});

describe("validateAndExtractPdf — file/extraction validation matrix", () => {
  it("PDF-03 rejects an empty file", async () => {
    const r = await validateAndExtractPdf(new ArrayBuffer(0), realExtractor);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("empty_file");
  });

  it("PDF-04 rejects a file over the byte-size limit (magic bytes present, but oversized)", async () => {
    const big = new Uint8Array(MAX_PDF_BYTES + 1);
    big.set([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
    const r = await validateAndExtractPdf(big.buffer, realExtractor);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("too_large");
  });

  it("PDF-05 rejects a non-PDF file (wrong magic bytes) without ever calling the extractor", async () => {
    let called = false;
    const spy: PdfExtractor = async (b) => { called = true; return { totalPages: 1, text: "x" }; };
    const r = await validateAndExtractPdf(new TextEncoder().encode("this is a plain text file, not a PDF").buffer, spy);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not_pdf");
    expect(called).toBe(false);
  });

  it("PDF-06 rejects a real PDF's bytes when corrupted enough that pdf.js cannot parse it", async () => {
    const good = new Uint8Array(await makePdf("hello"));
    // Truncate hard, right after the valid magic-byte header, to guarantee a
    // parse failure regardless of unpdf/pdf.js version specifics.
    const corrupted = good.slice(0, 20);
    const r = await validateAndExtractPdf(corrupted.buffer, realExtractor);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("malformed");
  });

  it("PDF-07 maps a PasswordException (by .name, decoupled from pdf.js's real class) to 'encrypted'", async () => {
    const fakeEncrypted: PdfExtractor = async () => {
      const e: any = new Error("No password given");
      e.name = "PasswordException";
      throw e;
    };
    const r = await validateAndExtractPdf(await makePdf("x"), fakeEncrypted);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("encrypted");
  });

  it("PDF-08 rejects a PDF with more pages than the configured maximum", async () => {
    const manyPages: PdfExtractor = async () => ({ totalPages: MAX_PDF_PAGES + 1, text: "plenty of real text here to pass the text check" });
    const r = await validateAndExtractPdf(await makePdf("x"), manyPages);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("too_many_pages");
    expect(r.pageCount).toBe(MAX_PDF_PAGES + 1);
  });

  it("PDF-09 rejects a real, validly-structured PDF with a blank page (no vision fallback — scanned/image-only case)", async () => {
    const blank = await makeBlankPdf(1);
    const r = await validateAndExtractPdf(blank, realExtractor);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("no_extractable_text");
  });

  it("PDF-10 accepts a real PDF with genuine extractable text and returns it, capped at MAX_EXTRACTED_TEXT_CHARS", async () => {
    const pdf = await makePdf("Proposal for Avalon Tree Removal — 123 Main St");
    const r = await validateAndExtractPdf(pdf, realExtractor);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Proposal for Avalon Tree Removal");
    expect(r.text!.length).toBeLessThanOrEqual(MAX_EXTRACTED_TEXT_CHARS);
    expect(r.pageCount).toBe(1);
  });

  it("PDF-11 a parser that times out surfaces as 'parse_timeout', not an unhandled rejection", async () => {
    const neverResolves: PdfExtractor = () => new Promise(() => {}); // never settles
    const r = await validateAndExtractPdf(await makePdf("x"), neverResolves);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("parse_timeout");
  }, 25_000);

  it("PDF-12 an unrecognized thrown error still fails closed as 'malformed', never crashes the caller", async () => {
    const weird: PdfExtractor = async () => { throw "a bare string, not an Error object" as any; };
    const r = await validateAndExtractPdf(await makePdf("x"), weird);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("malformed");
  });
});

describe("computeContentHash", () => {
  it("HASH-01 is deterministic and content-sensitive (SHA-256 hex)", async () => {
    const a = await computeContentHash(new TextEncoder().encode("same bytes").buffer);
    const b = await computeContentHash(new TextEncoder().encode("same bytes").buffer);
    const c = await computeContentHash(new TextEncoder().encode("different bytes").buffer);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("safeFilename / documentR2Key", () => {
  it("SAFE-01 strips characters unsafe for HTML/header/URL contexts", () => {
    expect(safeFilename('../../etc/passwd";<script>.pdf')).not.toMatch(/[<>"/;]/);
    expect(safeFilename("normal-file_name (1).pdf")).toBe("normal-file_name (1).pdf");
  });

  it("SAFE-02 falls back to a default name for empty/garbage-only input", () => {
    expect(safeFilename("")).toBe("upload.pdf");
    expect(safeFilename("../../../")).toBe("upload.pdf");
  });

  it("SAFE-03 R2 key never contains the raw original filename, even when malicious", () => {
    const malicious = '../../../etc/passwd?x=1"><img src=x>.pdf';
    const key = documentR2Key("company-1", "doc_abc123", "deadbeef".repeat(8), safeFilename(malicious));
    expect(key).not.toContain("etc/passwd");
    expect(key).not.toContain("<img");
    expect(key.startsWith("lead-imports/company-1/doc_abc123/")).toBe(true);
  });

  it("SAFE-04 two different tenants uploading identically-named files get keys under their own tenant prefix only", () => {
    const k1 = documentR2Key("tenant-a", "doc_1", "hash1".padEnd(64, "0"), "proposal.pdf");
    const k2 = documentR2Key("tenant-b", "doc_1", "hash1".padEnd(64, "0"), "proposal.pdf");
    expect(k1).not.toBe(k2);
    expect(k1.startsWith("lead-imports/tenant-a/")).toBe(true);
    expect(k2.startsWith("lead-imports/tenant-b/")).toBe(true);
  });
});

describe("lifecycle state machine", () => {
  it("LC-01 allows the normal happy-path chain", () => {
    expect(canTransition("temporary", "uploaded")).toBe(true);
    expect(canTransition("uploaded", "extracting")).toBe(true);
    expect(canTransition("extracting", "parsing")).toBe(true);
    expect(canTransition("parsing", "needs_review")).toBe(true);
    expect(canTransition("needs_review", "ready")).toBe(true);
    expect(canTransition("ready", "creating")).toBe(true);
    expect(canTransition("creating", "finalized")).toBe(true);
  });

  it("LC-02 rejects skipping required steps", () => {
    expect(canTransition("temporary", "finalized")).toBe(false);
    expect(canTransition("uploaded", "ready")).toBe(false);
  });

  it("LC-03 terminal states have no legal outgoing transition (except the identity no-op)", () => {
    expect(canTransition("finalized", "finalized")).toBe(true);
    expect(canTransition("finalized", "creating")).toBe(false);
    expect(canTransition("abandoned", "uploaded")).toBe(false);
    expect(canTransition("expired", "ready")).toBe(false);
  });

  it("LC-04 failed is reachable from every in-flight step and can retry back into it", () => {
    expect(canTransition("extracting", "failed")).toBe(true);
    expect(canTransition("parsing", "failed")).toBe(true);
    expect(canTransition("creating", "failed")).toBe(true);
    expect(canTransition("failed", "extracting")).toBe(true);
    expect(canTransition("failed", "creating")).toBe(true);
  });

  it("LC-05 isRetryable / isTerminal classify every status correctly", () => {
    expect(isRetryable("failed")).toBe(true);
    expect(isRetryable("needs_review")).toBe(true);
    expect(isRetryable("ready")).toBe(true);
    expect(isRetryable("finalized")).toBe(false);
    expect(isTerminal("finalized")).toBe(true);
    expect(isTerminal("abandoned")).toBe(true);
    expect(isTerminal("expired")).toBe(true);
    expect(isTerminal("ready")).toBe(false);
  });
});

describe("deriveMissingInfo — live-derived, never persisted", () => {
  it("MISS-01 nothing missing when identity, address, and a contact method are all present", () => {
    expect(deriveMissingInfo({ personName: "Jane Doe", address: "123 Main St", phone: "555-1234" })).toEqual([]);
  });

  it("MISS-02 company name alone satisfies contact_identity (no person name required)", () => {
    const missing = deriveMissingInfo({ companyName: "Acme Property Mgmt", address: "1 Elm St", email: "a@acme.com" });
    expect(missing).not.toContain("contact_identity");
  });

  it("MISS-03 email alone satisfies contact_method — never reports both phone AND email missing when one is present", () => {
    const missing = deriveMissingInfo({ personName: "Jane Doe", address: "1 Elm St", email: "jane@example.com" });
    expect(missing).not.toContain("contact_method");
  });

  it("MISS-04 phone alone satisfies contact_method", () => {
    const missing = deriveMissingInfo({ personName: "Jane Doe", address: "1 Elm St", phone: "555-1234" });
    expect(missing).not.toContain("contact_method");
  });

  it("MISS-05 flags all three when nothing usable is present, and whitespace-only values count as absent", () => {
    const missing = deriveMissingInfo({ personName: "   ", companyName: "", address: "", phone: "", email: "" });
    expect(missing).toEqual(["contact_identity", "property_address", "contact_method"]);
  });

  it("MISS-06 never fabricates a placeholder — missing stays missing, it is never auto-filled", () => {
    const rec = { personName: "", companyName: "", address: "42 Oak Ave" };
    const missing = deriveMissingInfo(rec);
    expect(missing).toContain("contact_identity");
    expect(missing).toContain("contact_method");
    expect(missing).not.toContain("property_address");
  });
});
