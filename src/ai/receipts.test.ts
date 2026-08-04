/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  processReceiptUpload, scoreFieldConfidence, needsReview, computeContentHash,
} from "./receipts";
import { getOpenActionItems, getReceiptByHash } from "../db/repos";

const db = () => env.FINANCE_DB;
const r2 = () => env.RECEIPTS;
const TENANT = "t-receipts";

const bytes = (s: string) => new TextEncoder().encode(s).buffer;

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
    const result = await processReceiptUpload(db(), r2(), {
      tenant_id: TENANT, job_id: "job-1", bytes: bytes("receipt-image-1"), filename: "r1.jpg",
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
    const args = {
      tenant_id: TENANT, job_id: "job-2", bytes: bytes("dupe-bytes"), filename: "r2.jpg",
      extract: async () => ({ vendor: "Vendor B", amount_cents: 1000, receipt_date: "2026-07-02" }),
      reviewOwnerId: "office-user-1", reviewOwnerRole: "office" as const,
    };
    const first = await processReceiptUpload(db(), r2(), args);
    expect(first.status).toBe("stored");
    const second = await processReceiptUpload(db(), r2(), args);
    expect(second.status).toBe("duplicate");
  });

  it("RC-04 a low-confidence field creates a review action_item", async () => {
    const result = await processReceiptUpload(db(), r2(), {
      tenant_id: TENANT, job_id: "job-3", bytes: bytes("blurry-receipt"), filename: "r3.jpg",
      extract: async () => ({ vendor: null, amount_cents: 2000, receipt_date: "2026-07-03" }),
      reviewOwnerId: "office-user-1", reviewOwnerRole: "office",
    });
    expect(result.status).toBe("stored");
    if (result.status !== "stored") throw new Error("unreachable");
    expect(result.needs_review).toBe(true);

    const openFix = await getOpenActionItems(db(), TENANT, "fix");
    expect(openFix.some((a) => a.source_id === result.receipt_id)).toBe(true);
  });

  it("forbidden: routing a bookkeeping review to the crew role throws", async () => {
    await expect(
      processReceiptUpload(db(), r2(), {
        tenant_id: TENANT, job_id: "job-4", bytes: bytes("crew-blocked"), filename: "r4.jpg",
        extract: async () => ({ vendor: null, amount_cents: null, receipt_date: null }),
        reviewOwnerId: "crew-user-1", reviewOwnerRole: "crew",
      }),
    ).rejects.toThrow(/crew/);
  });
});
