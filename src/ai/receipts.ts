import {
  getReceiptByHash, findLikelyDuplicateReceipts, insertActionItem, insertReceipt,
} from "../db/repos";
import type { Role } from "../ui/roles";
import type { RateConfidence } from "../db/schema";

export interface ExtractedReceiptFields {
  vendor: string | null;
  amount_cents: number | null;
  receipt_date: string | null;
  /** Optional — not every receipt has a visible receipt/invoice number
   * (e.g. a handwritten slip). Not scored for confidence (its absence
   * alone doesn't mean the extraction failed), but used by the
   * vendor+date+number+total fuzzy-dedupe check below. */
  receipt_number?: string | null;
}

/** receipt_number is deliberately excluded — see its doc comment above;
 * scoring it would force every receipt without a printed number into
 * "needs review" for no extraction-quality reason. */
export type FieldConfidenceMap = Record<"vendor" | "amount_cents" | "receipt_date", RateConfidence>;

/** Field-level, not receipt-level: a receipt can be high-confidence on
 * amount and low-confidence on date at the same time. See docs/spec/RECEIPTS.md. */
export function scoreFieldConfidence(fields: ExtractedReceiptFields): FieldConfidenceMap {
  return {
    vendor: fields.vendor ? "high" : "low",
    amount_cents: fields.amount_cents !== null ? "high" : "low",
    receipt_date: fields.receipt_date ? "high" : "low",
  };
}

export function needsReview(confidence: FieldConfidenceMap): boolean {
  return Object.values(confidence).some((c) => c === "low");
}

export async function computeContentHash(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ProcessReceiptArgs {
  company_id: string;
  job_id: string | null;
  bytes: ArrayBuffer;
  filename: string;
  /** Extraction is injected rather than called inline — the actual OCR/AI
   * call has little logic of its own to test; what matters (and is tested
   * here) is confidence scoring and the review/dedupe decisions built on
   * top of it. */
  extract: (bytes: ArrayBuffer) => Promise<ExtractedReceiptFields>;
  /** Forbidden: "routing a bookkeeping question to a crew role" — enforced
   * here, not just by convention. A review action_item can only go to a
   * non-crew owner. */
  reviewOwnerId: string;
  reviewOwnerRole: Role;
}

export type ProcessReceiptResult =
  | { status: "duplicate"; existing_receipt_id: string }
  | { status: "stored"; receipt_id: string; r2_key: string; needs_review: boolean; likely_duplicate_of: string[] };

export async function processReceiptUpload(
  db: D1Database, r2: R2Bucket, args: ProcessReceiptArgs,
): Promise<ProcessReceiptResult> {
  if (args.reviewOwnerRole === "crew") {
    throw new Error("cannot route a bookkeeping review to the crew role");
  }

  const hash = await computeContentHash(args.bytes);
  const existing = await getReceiptByHash(db, args.company_id, hash);
  if (existing) return { status: "duplicate", existing_receipt_id: existing.id };

  const r2Key = `receipts/${args.company_id}/${hash}-${args.filename}`;
  await r2.put(r2Key, args.bytes);

  const fields = await args.extract(args.bytes);
  const confidence = scoreFieldConfidence(fields);
  const reviewNeeded = needsReview(confidence);

  // Item 1 (Tyler, 2026-08-22): "duplicate detection: document hash +
  // vendor + date + receipt/invoice number + total." Byte-hash dedupe
  // above only catches an identical file uploaded twice; this catches a
  // second photo of the same paper receipt (different bytes, same
  // vendor/date/number/total) or the same purchase submitted from two
  // channels. It never blocks the upload outright — a fuzzy match can be
  // a false positive (two real purchases, same vendor/day/rounded total)
  // — it always forces a human review instead, alongside whatever other
  // review reason may already apply. See findLikelyDuplicateReceipts's
  // doc comment in src/db/repos.ts for the exact vs. weak-signal distinction.
  const likelyDuplicates = await findLikelyDuplicateReceipts(
    db, args.company_id, fields.vendor, fields.receipt_date, fields.amount_cents, fields.receipt_number ?? null,
  );
  const duplicateSuspected = likelyDuplicates.length > 0;
  const finalReviewNeeded = reviewNeeded || duplicateSuspected;

  const receiptId = `receipt-${hash.slice(0, 16)}`;
  await insertReceipt(db, {
    id: receiptId,
    company_id: args.company_id,
    job_id: args.job_id,
    r2_key: r2Key,
    content_hash: hash,
    vendor: fields.vendor,
    amount_cents: fields.amount_cents as never,
    receipt_date: fields.receipt_date,
    field_confidence: JSON.stringify(confidence),
    action_item_id: null,
    receipt_number: fields.receipt_number ?? null,
  });

  if (finalReviewNeeded) {
    const actionId = `ai-receipt-${hash.slice(0, 16)}`;
    const staleComponents: string[] = (Object.keys(confidence) as (keyof FieldConfidenceMap)[]).filter((k) => confidence[k] === "low");
    if (duplicateSuspected) staleComponents.push("possible_duplicate");
    await insertActionItem(db, {
      id: actionId,
      company_id: args.company_id,
      verb: "fix",
      owner_id: args.reviewOwnerId,
      sla_due: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
      amount_cents: fields.amount_cents as never,
      confidence: "low",
      stale_components: JSON.stringify(staleComponents),
      source_type: "receipt",
      source_id: receiptId,
    });
  }

  return {
    status: "stored", receipt_id: receiptId, r2_key: r2Key, needs_review: finalReviewNeeded,
    likely_duplicate_of: likelyDuplicates.map((r) => r.id),
  };
}
