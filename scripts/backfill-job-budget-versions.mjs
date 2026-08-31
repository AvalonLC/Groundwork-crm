#!/usr/bin/env node
/**
 * Item 4 Stage 2 §10 — CLI wrapper around the guarded writing-backfill
 * package (src/db/backfill-write-repos.ts: generateBackfillManifest /
 * executeBackfillManifest). This script itself contains NO backfill
 * business logic — every safety property (dry-run default, tenant
 * scoping, manifest hashing, confirmation token, backup confirmation,
 * audit attribution, idempotency, etc.) lives in the already-tested
 * engine (src/engines/backfill-write.ts) and DB-orchestration layer
 * (src/db/backfill-write-repos.ts, 98 tests, PR #110). This file only:
 *   1. parses CLI args,
 *   2. obtains a real D1Database via wrangler's getPlatformProxy (so the
 *      exact same TypeScript functions the test suite exercises against
 *      an in-memory D1 also run here against a real one — no separate,
 *      unverified SQL path, unlike migrate-finance-data.mjs's shell-out
 *      approach, which was necessary there only because it bridged TWO
 *      separate D1 databases and had no shared TS layer to reuse),
 *   3. prints the manifest / reconciliation report,
 *   4. on --apply, requires the explicit confirmation flags and prints
 *      the execution result.
 *
 * TS bridging: plain `node` cannot resolve this project's extensionless
 * relative TS imports (e.g. `from "./repos"`) even with
 * --experimental-strip-types, which only strips types — it does not do
 * module resolution/bundling. This script therefore esbuild-bundles
 * src/db/backfill-write-repos.ts (already a project devDependency, used
 * by vite/wrangler themselves) to a temp ESM file at startup and dynamic-
 * imports THAT — verified working (bundle only strips types/resolves
 * imports, changes no logic; the bundled module exports the identical
 * generateBackfillManifest/executeBackfillManifest functions the test
 * suite already covers). The temp file is removed in a `finally`.
 *
 * SAFE BY DEFAULT: dry-run (report + manifest only, ZERO writes) unless
 * --apply is passed. --apply additionally requires --confirm, --backup-
 * confirmed, and --approved-by <name>; missing any of these produces a
 * validation failure (not a crash) — see ExecuteBackfillManifestOptions
 * in src/db/backfill-write-repos.ts.
 *
 * Local vs remote: this script defaults to --local (the on-disk D1 SQLite
 * used by `npm run dev:local` / `wrangler pages dev --local`). Per
 * CLAUDE.md and docs/RUNBOOK-item4-stage2-backfill.md §12, only Tyler
 * runs this with --remote, and ONLY after a separate explicit approval —
 * it is never invoked with --remote by an agent session, CI, or any
 * automated process. --remote additionally requires the environment to
 * already be authenticated (CLOUDFLARE_API_TOKEN / `wrangler whoami`).
 *
 * Usage:
 *   node scripts/backfill-job-budget-versions.mjs --company acct_x --as-of 2026-08-01
 *     (dry run, local D1 — prints manifest + reconciliation, writes nothing)
 *
 *   node scripts/backfill-job-budget-versions.mjs --company acct_x --as-of 2026-08-01 \
 *     --apply --confirm <token-from-dry-run-output> --backup-confirmed --approved-by "Tyler Ridge"
 *     (writes, local D1)
 *
 *   node scripts/backfill-job-budget-versions.mjs --remote --company acct_x --as-of 2026-08-01 \
 *     --apply --confirm <token> --backup-confirmed --approved-by "Tyler Ridge"
 *     (writes, PRODUCTION — Tyler runs this himself, after §12's approval + backup)
 *
 * See docs/RUNBOOK-item4-stage2-backfill.md for the full walkthrough,
 * including required pre-flight checks and reconciliation queries.
 */
import { getPlatformProxy } from "wrangler";
import esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Bundles src/db/backfill-write-repos.ts (and its whole TS import graph)
 * into one dependency-free ESM file, then dynamic-imports it. This is the
 * ONLY place in this script that touches the filesystem beyond reading
 * argv/env — the temp file is written to the OS tmpdir (via esbuild's
 * outfile) and deleted in the caller's `finally`, never left behind.
 */
async function loadBackfillRepos() {
  const outfile = join(__dirname, "..", "node_modules", ".cache", `backfill-write-repos.${randomUUID()}.mjs`);
  await esbuild.build({
    entryPoints: [join(__dirname, "..", "src", "db", "backfill-write-repos.ts")],
    bundle: true,
    platform: "neutral",
    format: "esm",
    target: "es2022",
    outfile,
  });
  try {
    return { mod: await import(outfile), outfile };
  } catch (e) {
    await unlink(outfile).catch(() => {});
    throw e;
  }
}

export function parseArgs(argv) {
  const out = { apply: false, confirm: undefined, backupConfirmed: false, approvedBy: undefined, remote: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--local") out.remote = false;
    else if (a === "--remote") out.remote = true;
    else if (a === "--apply") out.apply = true;
    else if (a === "--backup-confirmed") out.backupConfirmed = true;
    else if (a === "--company") out.company = argv[++i];
    else if (a === "--as-of") out.asOf = argv[++i];
    else if (a === "--confirm") out.confirm = argv[++i];
    else if (a === "--approved-by") out.approvedBy = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else {
      console.error(`Unrecognized argument: ${a}`);
      process.exit(1);
    }
  }
  // BackfillManifestEnvironment is exactly "local" | "remote" (see
  // src/engines/backfill-write.ts) — it is NOT a free-form label like
  // "production"/"staging". It exists so a manifest generated against
  // local D1 can never be replayed against remote D1 (or vice versa):
  // validateManifestForExecution refuses to execute a manifest whose
  // `environment` doesn't match the run's actual target. So this script
  // derives it directly from --local/--remote rather than accepting a
  // separate flag that could disagree with where the manifest actually ran.
  out.environment = out.remote ? "remote" : "local";
  return out;
}

function printUsage() {
  console.log(`
Usage:
  node scripts/backfill-job-budget-versions.mjs --company <id> --as-of <YYYY-MM-DD> [--local|--remote]
      Dry run (default). Prints the manifest and reconciliation preview.
      Writes nothing. The printed manifest_hash is the value to pass as
      --confirm on a subsequent --apply run.

  ...--apply --confirm <manifest_hash> --backup-confirmed --approved-by "<name>"
      Executes the write. Requires a prior backup (attested via
      --backup-confirmed, never inferred) and a named human approver.

Flags:
  --company <id>       Required. Explicit tenant id — never "all"/"*".
  --as-of <date>        Required. ISO date, e.g. 2026-08-01.
  --local | --remote    Which D1 to target, AND the manifest's environment
                        binding ("local"/"remote" — see
                        BackfillManifestEnvironment). Default: --local.
                        Only Tyler runs --remote, and only after separate
                        approval (see docs/RUNBOOK-item4-stage2-backfill.md
                        §12). A manifest generated with one can never be
                        applied against the other.
  --apply               Actually write. Omit for dry run.
  --confirm <hash>      Required with --apply. Must equal the manifest's
                        own manifest_hash from the dry run.
  --backup-confirmed    Required with --apply. Attests a pre-execution
                        backup already exists (see runbook §1).
  --approved-by <name>  Required with --apply. Stamped on every row.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printUsage(); return; }
  if (!args.company || !args.asOf) {
    printUsage();
    console.error("\n--company and --as-of are both required.");
    process.exit(1);
  }

  // getPlatformProxy loads bindings from wrangler.jsonc. --local (default)
  // persists to the same .wrangler/state/v3 SQLite this repo's own
  // `npm run dev:local` / `db:migrate:local` scripts use, so a manifest
  // generated here against local D1 reflects the exact same data you'd
  // see running the app locally. --remote requires the D1 binding's own
  // remote-bindings support (an authenticated wrangler session) and is
  // never exercised by this agent — see this file's header comment.
  const proxy = await getPlatformProxy({ remoteBindings: args.remote });
  const db = proxy.env.DB;
  if (!db) {
    console.error('No "DB" binding found via getPlatformProxy — check wrangler.jsonc.');
    await proxy.dispose();
    process.exit(1);
  }

  let bundleOutfile;
  try {
    const { mod, outfile } = await loadBackfillRepos();
    bundleOutfile = outfile;
    const { generateBackfillManifest, executeBackfillManifest } = mod;

    console.log(`\n=== §10 backfill manifest: company=${args.company} as_of=${args.asOf} target=${args.remote ? "REMOTE" : "local"} ===\n`);
    const manifest = await generateBackfillManifest(db, args.company, args.asOf, args.environment);

    console.log(`total_jobs_scanned : ${manifest.total_jobs_scanned}`);
    console.log(`eligible jobs       : ${manifest.jobs.length}`);
    console.log(`excluded jobs       : ${manifest.excluded_jobs.length}`);
    console.log(`manifest_hash       : ${manifest.manifest_hash}`);
    console.log(`generated_at        : ${manifest.generated_at}\n`);

    if (manifest.jobs.length > 0) {
      console.log("Jobs that WOULD get a baseline job_budget_versions row:");
      for (const j of manifest.jobs.slice(0, 50)) {
        console.log(`  job=${j.job_id}  division=${j.division}  completion_method=${j.completion_method}  estimate_total_cents=${j.estimate_total_cents}`);
      }
      if (manifest.jobs.length > 50) console.log(`  … and ${manifest.jobs.length - 50} more`);
    }
    if (manifest.excluded_jobs.length > 0) {
      console.log("\nExcluded (never guessed at — see reason per job):");
      for (const e of manifest.excluded_jobs.slice(0, 50)) {
        console.log(`  job=${e.job_id}  reason=${e.reason}`);
      }
      if (manifest.excluded_jobs.length > 50) console.log(`  … and ${manifest.excluded_jobs.length - 50} more`);
    }

    if (!args.apply) {
      console.log(`\nDry run only — nothing was written.`);
      console.log(`To apply, re-run with:\n  --apply --confirm ${manifest.manifest_hash} --backup-confirmed --approved-by "<name>"\n`);
      return;
    }

    console.log(`\n--apply requested. Validating and executing...\n`);
    const result = await executeBackfillManifest(db, manifest, {
      apply: true,
      confirmationToken: args.confirm,
      backupConfirmed: args.backupConfirmed,
      approvedBy: args.approvedBy,
      expectedCompanyId: args.company,
      expectedEnvironment: args.environment,
    });

    if (!result.validation.valid) {
      console.error(`\nREFUSED — validation failed:\n  ${result.validation.errors.join("\n  ")}\n`);
      console.error("Nothing was written.");
      process.exitCode = 1;
      return;
    }

    console.log(`applied        : ${result.applied}`);
    console.log(`rowsWritten    : ${result.rowsWritten}`);
    console.log(`executionId    : ${result.executionId}`);
    console.log(`reconciliation : ${JSON.stringify(result.reconciliation, null, 2)}\n`);
  } finally {
    await proxy.dispose();
    if (bundleOutfile) await unlink(bundleOutfile).catch(() => {});
  }
}

// Guarded so this module can be `import`ed (e.g. by
// scripts/backfill-job-budget-versions.test.mjs, to unit-test parseArgs)
// without also running the CLI's getPlatformProxy/D1 side effects — only
// run main() when this file is the actual process entrypoint.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
