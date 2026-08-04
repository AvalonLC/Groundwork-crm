# RECEIPTS

W5-receipts: "Receipt pipeline — R2 store, field-level confidence, dedupe by hash."
Depends on W1-repos.

## Pipeline
1. Image uploaded to the `RECEIPTS` R2 bucket (`gw-receipts`, wrangler.jsonc).
2. Hash computed over the image bytes for dedupe — a re-uploaded or duplicate-photo
   receipt is detected before OCR/extraction runs, per the `receipt` table's hash
   column (SCHEMA.md).
3. Field extraction (vendor, amount, date, job association) via Workers AI, each
   field carrying its own confidence — "field-level," not one confidence score for
   the whole receipt. A receipt with a crisp amount but blurry date should show high
   confidence on `amount_cents` and low confidence on `date`.
4. Low-confidence fields or unmatched job associations surface as `action_item`
   rows (`verb=fix` or `verb=decide`), never silently guessed and posted.

## Role boundary
Forbidden: "routing a bookkeeping question to a crew role" — receipt review/correction
flows go to bookkeeping-capable roles (per ROLES.md's four templates), never to the
crew role, which per CLAUDE.md's UI invariants never sees margin/wage/rate fields
anyway.

## Derivation confidence
**Confident:** dedupe-by-hash, field-level (not receipt-level) confidence, and the
crew-role exclusion are all explicit in the task title/forbidden list.

**Inferred:** the exact extraction field set (vendor/amount/date/job) — reasonable
for a receipts pipeline but not enumerated anywhere in evidence; SCHEMA.md's
`receipt` table lists "field-level confidence per extracted field" generically rather
than naming each field. **Needs Tyler:** confirm the field list before W5-receipts
locks in a schema for the confidence JSON blob.
