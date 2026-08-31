/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  processReceiptUpload, scoreFieldConfidence, needsReview, computeContentHash,
} from "./receipts";
import { getOpenActionItems, getReceiptByHash } from "../db/repos";

const db = () => env.DB;
const r2 = () => env.RECEIPTS;
const TENANT = "t-receipts";

const bytes = (s: string) => new TextEncoder().encode(s).buffer;

// receipt.job_id is a real FK to work_orders(id) since migrations/0057_finance_merge.sql.
async function seedWorkOrder(id: string) {
  await db().prepare(`INSERT INTO work_orders (id, company_id, wo_number) VALUES (?,?,?)`)
    .bind(id, TENANT, `WO-${id}`).run();
}

describe("scoreFieldConfidence / needsReview", () => {
  it("RC-01 high confidence when every field extracted, low when any is missing", () => {
    const full = scoreFieldConfidence({ vendor: "Acme", amount_cents: 4599, receipt_date: "2026-07-01" });
    expect(Object.values(full).every((c) => c === "high")).toBe(true);
    expect(needsReview(full)).toBe(false);

    const partial = scoreFieldConfidence({ vendor: "Acme", amount_cents: 4599, receipt_date: null });
    expect(partial.receipt_date).toBe("low");
    expect(needsReview(partial)).toBe(true);
  });
});

describe("processReceiptUpload", () => {
  it("RC-02 stores a new receipt in R2 and the DB with field-level confidence", async () => {
    await seedWorkOrder("job-1");
    const result = await processReceiptUpload(db(), r2(), {
      company_id: TENANT, job_id: "job-1", bytes: bytes("receipt-image-1"), filename: "r1.jpg",
      extract: async () => ({ vendor: "Acme Supply", amount_cents: 4599, receipt_date: "2026-07-01" }),
      reviewOwnerId: "office-user-1", reviewOwnerRole: "office",
    });
    expect(result.status).toBe("stored");
    if (result.status !== "stored") throw new Error("unreachable");
    expect(result.needs_review).toBe(false);

    const stored = await r2().get(result.r2_key);
    expect(stored).not.toBeNull();

    const receipt = await getReceiptByHash(db(), TENANT, await computeContentHash(bytes("receipt-image-1")));
    expect(receipt?.vendor).toBe("Acme Supply");
  });

  it("RC-03 dedupe by hash: uploading the same bytes twice is detected, not double-stored", async () => {
    await seedWorkOrder("job-2");
    const args = {
      company_id: TENANT, job_id: "job-2", bytes: bytes("dupe-bytes"), filename: "r2.jpg",
      extract: async () => ({ vendor: "Vendor B", amount_cents: 1000, receipt_date: "2026-07-02" }),
      reviewOwnerId: "office-user-1", reviewOwnerRole: "office" as const,
    };
    const first = await processReceiptUpload(db(), r2(), args);
    expect(first.status).toBe("stored");
    const second = await processReceiptUpload(db(), r2(), args);
    expect(second.status).toBe("duplicate");
  });

  it("RC-04 a low-confidence field creates a review action_item", async () => {
    await seedWorkOrder("job-3");
    const result = await processReceiptUpload(db(), r2(), {
      company_id: TENANT, job_id: "job-3", bytes: bytes("blurry-receipt"), filename: "r3.jpg",
      extract: async () => ({ vendor: null, amount_cents: 2000, receipt_date: "2026-07-03" }),
      reviewOwnerId: "office-user-1", reviewOwnerRole: "office",
    });
    expect(result.status).toBe("stored");
    if (result.status !== "stored") throw new Error("unreachable");
    expect(result.needs_review).toBe(true);

    const openFix = await getOpenActionItems(db(), TENANT, "fix");
    expect(openFix.some((a) => a.source_id === result.receipt_id)).toBe(true);
  });

  // Phase 4/5 checklist cross-check (Finance OS Phase 6, 2026-08-31): this
  // exact scenario — findLikelyDuplicateReceipts's fuzzy vendor+date+total
  // dedupe path, called from processReceiptUpload — had no test anywhere in
  // the repo (confirmed via grep across src/**/*.test.ts and *.e2e.ts before
  // adding this). Item 1's Tyler quote ("document hash + vendor + date +
  // receipt/invoice number + total") explicitly calls out this signal
  // as required; only the byte-hash half (RC-03 above) was covered.
  it("RC-05 a different photo of the same paper receipt (different bytes, same vendor/date/total) is flagged as a likely duplicate for review, not silently stored", async () => {
    await seedWorkOrder("job-5");
    const shared = {
      company_id: TENANT, job_id: "job-5",
      extract: async () => ({ vendor: "Ace Hardware", amount_cents: 5500, receipt_date: "2026-07-05" }),
      reviewOwnerId: "office-user-1", reviewOwnerRole: "office" as const,
    };
    const first = await processReceiptUpload(db(), r2(), {
      ...shared, bytes: bytes("photo-angle-1"), filename: "r5a.jpg",
    });
    expect(first.status).toBe("stored");
    if (first.status !== "stored") throw new Error("unreachable");
    // High confidence on every field and no receipt_number collision to
    // force review through the confidence path — isolates the assertion
    // below to the fuzzy-duplicate signal specifically.
    expect(first.needs_review).toBe(false);

    // A second, genuinely different set of bytes (different photo of the
    // same paper receipt) — hash dedupe (RC-03) does NOT catch this; only
    // the vendor+date+amount fuzzy match does.
    const second = await processReceiptUpload(db(), r2(), {
      ...shared, bytes: bytes("photo-angle-2-slightly-different-crop"), filename: "r5b.jpg",
    });
    expect(second.status).toBe("stored");
    if (second.status !== "stored") throw new Error("unreachable");
    expect(second.needs_review).toBe(true);
    expect(second.likely_duplicate_of).toEqual([first.receipt_id]);

    // Never blocks the upload outright (per findLikelyDuplicateReceipts's
    // own doc comment — a false positive is possible) — it is stored, just
    // flagged, alongside a review action_item that names the duplicate
    // suspicion explicitly so a human can tell this apart from a plain
    // low-confidence-field review.
    const openFix = await getOpenActionItems(db(), TENANT, "fix");
    const item = openFix.find((a) => a.source_id === second.receipt_id);
    expect(item).toBeDefined();
    expect(JSON.parse(item!.stale_components as string)).toContain("possible_duplicate");
  });

  it("forbidden: routing a bookkeeping review to the crew role throws", async () => {
    await expect(
      processReceiptUpload(db(), r2(), {
        company_id: TENANT, job_id: "job-4", bytes: bytes("crew-blocked"), filename: "r4.jpg",
        extract: async () => ({ vendor: null, amount_cents: null, receipt_date: null }),
        reviewOwnerId: "crew-user-1", reviewOwnerRole: "crew",
      }),
    ).rejects.toThrow(/crew/);
  });
});
