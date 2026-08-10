# Runbook: Finance OS database merge (2026-08-09)

Finance OS used to live in a separate D1 database (`groundwork`, binding
`FINANCE_DB`). `migrations/0057_finance_merge.sql` adds its tables (and the
finance-only columns on `work_orders`/`time_entries`) into
`avalon-sales-hub-production`, the CRM's own database. This runbook is the
part a schema migration alone cannot do: moving the actual rows.

## Why this needs a separate step

D1/SQLite has no cross-database query. `groundwork` and
`avalon-sales-hub-production` are two independent D1 instances until you
run the script below — a `SELECT ... FROM other_database.table` is not
possible, so `INSERT ... SELECT` (the normal way to move data during a
same-database migration) does not work here.

## Steps

1. **Apply the schema migration to production** (you run this — see
   CLAUDE.md, no exceptions):
   ```
   wrangler d1 migrations apply avalon-sales-hub-production --remote
   ```
   This only adds columns/tables. It writes nothing into them. Note: this
   is the same migration step `deploy.yml` already runs automatically on
   every push to `main` (0057_finance_merge.sql lives in `/migrations`
   alongside every other CRM migration, not a separate finance-only
   directory anymore) — so if you're about to push this repo's code
   anyway, that push already does this step for you; running it by hand
   first is only useful if you want the schema live before the code that
   expects it.

2. **Dry-run the data copy first** to see what it would do, against your
   own machine's `--remote` access:
   ```
   node scripts/migrate-finance-data.mjs --remote
   ```
   Read the summary. In particular:
   - `work_item -> work_orders`: any id listed under "MISSING" means the
     old `work_item` row's `id` doesn't match any real `work_orders.id` in
     production — investigate before applying, don't skip past it.
   - `time_entry -> time_entries`: entries listed under "AMBIGUOUS" or
     "UNMATCHED" won't be copied automatically. There's no reliable way to
     match a `time_entry` row to a specific `time_entries` row after the
     fact (they were always two independently-created rows for the same
     clock event, with no shared key) — the script only applies a match
     when it's unique, and reports everything else so you can review it by
     hand rather than have it guessed at.

3. **Apply for real**, once the dry run looks right:
   ```
   node scripts/migrate-finance-data.mjs --remote --apply
   ```

4. **Verify row counts match** between what the script reported and what's
   now in the merged tables, e.g.:
   ```
   wrangler d1 execute avalon-sales-hub-production --remote --command \
     "SELECT COUNT(*) FROM labor_rate_profile"
   ```
   Compare against the source count the script printed for `groundwork`.

5. **Deploy the code** (push to `main` — the code in this repo already
   expects the merged schema; deploying before step 3 is fine, since the
   app tolerates empty new tables/columns, it just won't have moved any
   history yet).

6. **Once you've personally verified data integrity**, `groundwork` (the
   old database) can be deleted from the Cloudflare dashboard. That's
   your call, on your own timeline — nothing in this repo does it for you
   or nudges you toward a deadline.

## If something looks wrong

Don't re-run `--apply` to "fix" a partial result — the script has no
built-in idempotency guard against double-inserting rows that already
copied successfully. If a run fails partway, investigate the specific
failure first (the script logs exactly which row and why), fix the
underlying issue, and only then decide whether to re-run.
