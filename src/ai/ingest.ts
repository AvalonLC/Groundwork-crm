import { insertActionItem, listOverheadPools } from "../db/repos";
import type { Cents } from "../db/schema";
import {
  automationPolicy, ingestSources, resolveDivision, divisionMap as staticDivisionMap,
  type IngestSourceDef, type IngestSourcesConfig, type DivisionMap,
} from "../config/finance-config";
import { parseCsv, parseMoneyToCents } from "./csv";

/**
 * See docs/spec/INGEST.md and BLOCKED-W5-ingest.md. This module NEVER posts
 * anywhere outside Finance OS's own DB — no QBO/GL client, no outbound
 * write of any kind (CLAUDE.md hard rule 1: "Groundwork proposes; QBO
 * records"; forbidden: "posting to the GL"). Every reclassification or
 * unmapped-division finding becomes an action_item(verb='decide') for a
 * human, never auto-applied (forbidden: "auto-approving any reclassification").
 *
 * Format detection is entirely config-driven
 * (config/finance/ingest.sources.json) — supporting a new export format is
 * a config edit, not a code change. When detection is uncertain, this
 * always falls back to a review flag, never a guessed column mapping.
 * `sources`/`divMap` are threaded through as parameters (defaulting to the
 * static config) so a DB-aware caller can pass an admin-edited override
 * without this module's pure functions needing DB access themselves.
 */

export function detectSource(headers: string[], sources: IngestSourcesConfig = ingestSources): IngestSourceDef | null {
  const headerSet = new Set(headers.map((h) => h.trim().toLowerCase()));
  // Multiple sources can match as a subset (e.g. a class/division P&L export
  // also satisfies the plain P&L export's Account+Total requirement) —
  // prefer the most specific match, not just the first one in config order.
  const matches = sources.sources.filter((source) =>
    source.detect.required_headers.every((rh) => headerSet.has(rh.toLowerCase())));
  if (matches.length === 0) return null;
  return matches.reduce((best, s) =>
    s.detect.required_headers.length > best.detect.required_headers.length ? s : best);
}

export interface IngestLine {
  target: string;
  account: string | null;
  division_raw: string | null;
  division: string | null; // canonical, via resolveDivision — null if unresolved
  amount_cents: number;
  needs_review: boolean;
  review_reason: string | null;
}

function mapRow(row: Record<string, string>, source: IngestSourceDef, divMap: DivisionMap): IngestLine {
  const get = (key: string) => {
    const col = source.column_map[key];
    return col ? (row[col] ?? "") : "";
  };

  const divisionRaw = source.column_map.division ? get("division") : null;
  const division = divisionRaw ? resolveDivision(divisionRaw, divMap) : null;
  const amountRaw = get("amount");
  const amountCents = amountRaw ? parseMoneyToCents(amountRaw) : 0;

  const unmappedDivision = divisionRaw !== null && division === null;

  return {
    target: source.target,
    account: source.column_map.account ? get("account") : null,
    division_raw: divisionRaw,
    division,
    amount_cents: amountCents,
    needs_review: unmappedDivision,
    review_reason: unmappedDivision ? `division "${divisionRaw}" not found in division-map.json` : null,
  };
}

export interface GapReport {
  divisions_with_pool_but_no_pnl_line: string[];
  pnl_divisions_with_no_matching_pool: string[];
}

async function computeGapReport(db: D1Database, companyId: string, lines: IngestLine[]): Promise<GapReport> {
  const pools = await listOverheadPools(db, companyId);
  const poolDivisions = new Set(pools.map((p) => p.division));
  const pnlDivisions = new Set(lines.map((l) => l.division).filter((d): d is string => d !== null));

  return {
    divisions_with_pool_but_no_pnl_line: [...poolDivisions].filter((d) => !pnlDivisions.has(d)),
    pnl_divisions_with_no_matching_pool: [...pnlDivisions].filter((d) => !poolDivisions.has(d)),
  };
}

export interface IngestResult {
  source_id: string | null; // null = unrecognized format
  source_label: string | null;
  total_rows: number;
  lines: IngestLine[];
  gap_report: GapReport;
  review_action_item_ids: string[];
}

export interface IngestFileOptions {
  sources?: IngestSourcesConfig;
  divMap?: DivisionMap;
}

export async function ingestFile(
  db: D1Database, companyId: string, csvText: string, reviewOwnerId: string,
  options: IngestFileOptions = {},
): Promise<IngestResult> {
  const sources = options.sources ?? ingestSources;
  const divMap = options.divMap ?? staticDivisionMap;
  const { headers, rows } = parseCsv(csvText);
  const reviewActionIds: string[] = [];

  if (!automationPolicy.ingest_auto_detect_enabled) {
    const actionId = await createIngestReviewItem(db, companyId, reviewOwnerId, null, "ingest auto-detect disabled by automation-policy.json");
    return { source_id: null, source_label: null, total_rows: rows.length, lines: [], gap_report: emptyGapReport(), review_action_item_ids: [actionId] };
  }

  const source = detectSource(headers, sources);
  if (!source) {
    const actionId = await createIngestReviewItem(db, companyId, reviewOwnerId, null, sources.fallback.reason);
    return { source_id: null, source_label: null, total_rows: rows.length, lines: [], gap_report: emptyGapReport(), review_action_item_ids: [actionId] };
  }

  const lines = rows.map((row) => mapRow(row, source, divMap));

  if (automationPolicy.auto_create_action_items) {
    for (const line of lines) {
      if (line.needs_review) {
        const actionId = await createIngestReviewItem(db, companyId, reviewOwnerId, line.amount_cents, line.review_reason!);
        reviewActionIds.push(actionId);
      }
    }
  }

  const gapReport = source.target === "pnl_line_by_division"
    ? await computeGapReport(db, companyId, lines)
    : emptyGapReport();

  return { source_id: source.id, source_label: source.label, total_rows: rows.length, lines, gap_report: gapReport, review_action_item_ids: reviewActionIds };
}

function emptyGapReport(): GapReport {
  return { divisions_with_pool_but_no_pnl_line: [], pnl_divisions_with_no_matching_pool: [] };
}

async function createIngestReviewItem(
  db: D1Database, companyId: string, ownerId: string, amountCents: number | null, reason: string,
): Promise<string> {
  const id = `ai-ingest-${crypto.randomUUID().slice(0, 12)}`;
  await insertActionItem(db, {
    id, company_id: companyId, verb: "decide", owner_id: ownerId,
    sla_due: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
    amount_cents: amountCents !== null ? (amountCents as Cents) : null,
    confidence: "low", stale_components: JSON.stringify([reason]),
    source_type: "ingest", source_id: null,
  });
  return id;
}
