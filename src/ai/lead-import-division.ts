/**
 * Server-side division classification for PDF/email lead import.
 *
 * Mirrors public/js/app_premium.js's gwClassifyDivision() tiered logic
 * (explicit match -> keyword match against each division's own key/label
 * words -> legacy keyword bridges -> fallback to the first division) but
 * reads the tenant's real divisions directly from the D1 `settings` table
 * (`{companyId}:company_divisions`) instead of a browser's localStorage —
 * there is no localStorage inside a Worker request handler, and lead-import
 * classification has to run server-side alongside extraction/parsing.
 *
 * Deterministic-first, AI-suggestion-fallback, per the spec: the keyword
 * classifier below runs first and is considered authoritative whenever it
 * finds a real, non-default match; the model's `division_suggestion` (see
 * lead-import-parse.ts) is only consulted — and only ever as a suggestion,
 * never a final answer — when the deterministic classifier could not find
 * anything better than "the first division" to fall back on. The model
 * NEVER supplies a division id — see lead-import-parse.ts's stripTrustedIds;
 * this module only ever resolves a free-text label into one of the tenant's
 * own division objects, and a label that doesn't match anything real is
 * left unresolved rather than guessed at.
 */

export interface Division {
  key: string;
  label: string;
  color: string;
}

/** Same three-division fallback as GW_DEFAULT_DIVISIONS in app_premium.js — kept in sync deliberately, not imported (no bundler-safe shared module between browser JS and Worker TS in this repo yet). */
export const DEFAULT_DIVISIONS: readonly Division[] = [
  { key: "landscape", label: "Landscape", color: "#2D7A55" },
  { key: "maintenance", label: "Maintenance", color: "#4D8A86" },
  { key: "snow", label: "Snow & Ice", color: "#5B7A9D" },
];

/** Same legacy keyword bridges as gwClassifyDivision — existing tenant data was seeded against these categories before the configurable-division feature existed. */
const LEGACY_KEYWORD_BRIDGES: Record<string, readonly string[]> = {
  snow: ["snow", "ice", "plow"],
  maintenance: ["mainten", "mowing", "recurring"],
  landscape: ["landscape", "hardscape", "drainage", "design", "irrigat", "lighting", "enhancement"],
};

/**
 * Parse the raw `{companyId}:company_divisions` setting value the same way
 * gwDivisions() parses localStorage's `gwCompanyDivisions`: JSON array of
 * {key,label,color}, filtered to entries with a real key+label, falling back
 * to DEFAULT_DIVISIONS on anything malformed/empty. Never throws.
 */
export function parseCompanyDivisions(rawSettingValue: string | null | undefined): Division[] {
  try {
    if (rawSettingValue) {
      const arr = JSON.parse(rawSettingValue);
      if (Array.isArray(arr) && arr.length > 0) {
        const cleaned: Division[] = arr
          .filter((d: any) => d && d.key && d.label)
          .map((d: any) => ({ key: String(d.key), label: String(d.label), color: String(d.color || "#2D7A55") }));
        if (cleaned.length > 0) return cleaned;
      }
    }
  } catch {
    /* fall through to default */
  }
  return DEFAULT_DIVISIONS.map((d) => ({ ...d }));
}

/**
 * Fetch and parse a tenant's divisions directly from D1. Thin wrapper kept
 * separate from parseCompanyDivisions so the pure parsing logic (the part
 * worth unit-testing exhaustively) never needs a database in its tests.
 */
export async function loadCompanyDivisions(db: D1Database, companyId: string): Promise<Division[]> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key=? LIMIT 1")
    .bind(`${companyId}:company_divisions`)
    .first<{ value: string }>()
    .catch(() => null);
  return parseCompanyDivisions(row?.value ?? null);
}

export type DivisionClassificationSource = "explicit" | "keyword" | "legacy_bridge" | "ai_suggestion" | "default";

export interface DivisionClassificationInput {
  /** An explicit division key or label already on the record, if any (e.g. a re-classification of an existing opportunity). */
  explicitDivision?: string | null;
  /** Free-text signal to keyword-match against each division's own key/label words — the deterministic path this classifier trusts first. */
  projectCategory?: string | null;
  workType?: string | null;
  serviceLine?: string | null;
  /**
   * The model's free-text division_suggestion.label (see
   * lead-import-parse.ts) — consulted only as a last-resort suggestion, and
   * only ever resolved against the tenant's REAL division labels (never
   * trusted verbatim, never treated as an id).
   */
  aiSuggestedLabel?: string | null;
}

export interface DivisionClassificationResult {
  division: Division;
  source: DivisionClassificationSource;
  /** True when nothing deterministic matched and this is only the fallback-to-first-division default — signals the review UI to show a "needs review" confidence label rather than "found clearly". */
  isFallback: boolean;
}

const norm = (v: string | null | undefined): string => String(v || "").toLowerCase().trim();

/** Splits a division's own key+label into words >= 4 chars, same threshold as gwClassifyDivision (short words like "ice" or "hoa" are too noisy to keyword-match on). */
function divisionMatchWords(d: Division): string[] {
  return `${d.key} ${d.label}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
}

/**
 * Deterministic-first, AI-suggestion-fallback division classification —
 * server-side counterpart to gwClassifyDivision(). Never throws; always
 * returns a real division from `divisions` (falling back to divisions[0]
 * when nothing at all matches, exactly like the client-side function).
 *
 * `divisions` must be non-empty — callers pass the result of
 * loadCompanyDivisions/parseCompanyDivisions, which always returns at least
 * DEFAULT_DIVISIONS.
 */
export function classifyDivision(
  divisions: readonly Division[],
  input: DivisionClassificationInput,
): DivisionClassificationResult {
  if (divisions.length === 0) {
    throw new Error("classifyDivision requires at least one division — pass loadCompanyDivisions()'s result, which always includes a default.");
  }

  // 1) Explicit division match (key or label), case-insensitive.
  const explicit = norm(input.explicitDivision);
  if (explicit) {
    const hit = divisions.find((d) => norm(d.key) === explicit || norm(d.label) === explicit);
    if (hit) return { division: hit, source: "explicit", isFallback: false };
  }

  // 2) Keyword match against each division's own key+label words.
  const hay = norm(`${input.projectCategory || ""} ${input.workType || ""} ${input.serviceLine || ""}`);
  if (hay) {
    for (const d of divisions) {
      const words = divisionMatchWords(d);
      if (words.some((w) => hay.includes(w))) return { division: d, source: "keyword", isFallback: false };
    }
    // 3) Legacy keyword bridges (existing tenant data uses these categories).
    for (const d of divisions) {
      const bridge = LEGACY_KEYWORD_BRIDGES[d.key];
      if (bridge && bridge.some((w) => hay.includes(w))) return { division: d, source: "legacy_bridge", isFallback: false };
    }
  }

  // 4) AI suggestion — resolved against the tenant's REAL division labels
  // only. A label the model invented that doesn't match anything real here
  // is discarded, not partially trusted; this is deliberately the same
  // exact-or-substring match as step 1/2, not a fuzzy/semantic match, since
  // this is the one point in the pipeline where model output could
  // otherwise silently steer a real classification.
  const aiLabel = norm(input.aiSuggestedLabel);
  if (aiLabel) {
    const hit = divisions.find((d) => norm(d.key) === aiLabel || norm(d.label) === aiLabel);
    if (hit) return { division: hit, source: "ai_suggestion", isFallback: false };
    // Substring match both ways: model might say "Tree Removal Services" for
    // a tenant division literally named "Tree Removal", or vice versa.
    const wordHit = divisions.find((d) => {
      const words = divisionMatchWords(d);
      return words.some((w) => aiLabel.includes(w));
    });
    if (wordHit) return { division: wordHit, source: "ai_suggestion", isFallback: false };
  }

  // 5) Nothing matched — fall back to the first division, flagged so the
  // review UI can show "Needs review" rather than implying confidence.
  // (divisions[0] is safe: the length===0 guard at the top already returned/
  // threw, and noUncheckedIndexedAccess otherwise types this as possibly
  // undefined.)
  const fallback = divisions[0];
  if (!fallback) throw new Error("unreachable: divisions.length was checked non-zero above");
  return { division: fallback, source: "default", isFallback: true };
}
