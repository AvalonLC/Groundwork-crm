/**
 * Existing-record matching for PDF/email lead import.
 *
 * Deterministic-first, per spec: an email or phone match against an
 * existing `clients` row is a strong, structural signal (two different
 * people rarely share a phone number/email) and is always returned as a
 * "match" candidate. Company-name / person-name / address agreement is
 * comparatively weak on its own (many "John Smith"s, many "Main St"s) and is
 * only ever surfaced as a fuzzy SUGGESTION for the human reviewer to accept
 * or reject explicitly — this module never returns a fuzzy hit as
 * confidently as a deterministic one, and the caller (the not-yet-built
 * confirm/create route) must require an explicit human choice before
 * linking to any fuzzy suggestion. Nothing in this module writes to the
 * database or creates/links a client/property — it only reads and scores.
 */

export interface ExistingClientRow {
  id: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  type: string;
}

export interface ExistingPropertyRow {
  id: string;
  client_id: string;
  label: string;
  street: string;
  street2: string;
  city: string;
  state: string;
  zip: string;
}

export interface LeadMatchQuery {
  personName?: string | null;
  companyName?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
}

export type MatchBasis = "email" | "phone" | "company_name" | "person_name" | "address";
export type MatchStrength = "deterministic" | "fuzzy_suggestion";

export interface ClientMatchCandidate {
  client: ExistingClientRow;
  basis: MatchBasis[];
  strength: MatchStrength;
}

export interface PropertyMatchCandidate {
  property: ExistingPropertyRow;
  strength: MatchStrength;
}

// ── normalization helpers — deliberately simple/deterministic, no fuzzy string library ─

/** Digits only — "(555) 123-4567" and "555.123.4567" and "5551234567" all normalize identically. */
function normalizePhone(v: string | null | undefined): string {
  return String(v || "").replace(/\D+/g, "");
}

function normalizeEmail(v: string | null | undefined): string {
  return String(v || "").trim().toLowerCase();
}

/** Lowercase, whitespace-collapsed, trimmed — used for name/address text comparison. */
function normalizeText(v: string | null | undefined): string {
  return String(v || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Strips the common unit/suite/apt-style noise so "123 Main St" and "123 Main St Suite 200" can still fuzzy-match on the street number+name. */
function normalizeAddressCore(v: string | null | undefined): string {
  return normalizeText(v)
    .replace(/[.,#]/g, "")
    .replace(/\b(suite|ste|unit|apt|building|bldg)\.?\s*\S+/g, "")
    .trim();
}

const usable = (v: string | null | undefined): boolean => !!v && v.trim().length > 0;

// ── client matching ─────────────────────────────────────────────────────

/**
 * Score a single existing client row against the query. Returns null when
 * nothing at all matches (the caller filters those out) — never a
 * zero-confidence candidate that would clutter the review UI.
 *
 * Deterministic bases (email, phone) are checked first; if either matches,
 * the candidate is deterministic regardless of what else does or doesn't
 * match. Otherwise, company_name/person_name/address exact-normalized
 * matches are collected as fuzzy_suggestion bases only.
 */
function scoreClientCandidate(query: LeadMatchQuery, client: ExistingClientRow): ClientMatchCandidate | null {
  const basis: MatchBasis[] = [];
  let deterministic = false;

  const qEmail = normalizeEmail(query.email);
  if (qEmail && normalizeEmail(client.email) === qEmail) {
    basis.push("email");
    deterministic = true;
  }

  const qPhone = normalizePhone(query.phone);
  // Require a real phone number's worth of digits — a normalized empty
  // string or a couple of stray digits must never "match" every client that
  // also has no phone on file.
  if (qPhone.length >= 7 && normalizePhone(client.phone) === qPhone) {
    basis.push("phone");
    deterministic = true;
  }

  const qCompany = normalizeText(query.companyName);
  if (qCompany && normalizeText(client.name) === qCompany) {
    basis.push("company_name");
  }

  const qPerson = normalizeText(query.personName);
  if (qPerson && normalizeText(client.name) === qPerson) {
    basis.push("person_name");
  }

  const qAddress = normalizeAddressCore(query.address);
  if (qAddress && normalizeAddressCore(client.address) === qAddress) {
    basis.push("address");
  }

  if (basis.length === 0) return null;
  return { client, basis, strength: deterministic ? "deterministic" : "fuzzy_suggestion" };
}

/**
 * Find candidate existing clients for a parsed lead-import draft's contact
 * fields. Pure — takes an already-fetched row list (the caller does the
 * tenant-scoped D1 query; this module never touches the database itself, so
 * its matching logic is fully unit-testable without D1).
 *
 * Ordering: deterministic candidates first (email match before phone match
 * when a candidate has both — order within "deterministic" doesn't matter
 * functionally since the caller must treat all deterministic hits as
 * equally strong), then fuzzy suggestions.
 */
export function findClientMatches(
  query: LeadMatchQuery,
  existingClients: readonly ExistingClientRow[],
): ClientMatchCandidate[] {
  const candidates = existingClients
    .map((client) => scoreClientCandidate(query, client))
    .filter((c): c is ClientMatchCandidate => c !== null);

  return candidates.sort((a, b) => {
    if (a.strength !== b.strength) return a.strength === "deterministic" ? -1 : 1;
    return 0;
  });
}

// ── property matching ───────────────────────────────────────────────────

/** A property row's full address, in the same normalized-core form as normalizeAddressCore. */
function propertyAddressCore(p: ExistingPropertyRow): string {
  return normalizeAddressCore([p.street, p.street2, p.city, p.state, p.zip].filter(Boolean).join(" "));
}

/**
 * Find candidate existing properties (optionally scoped to a specific
 * client, when a client match has already been chosen) whose address
 * matches the parsed lead's address text. Address matching is inherently
 * fuzzy (free-text extraction vs. structured street/city/state/zip fields)
 * so every result here is a suggestion, never a deterministic hit — the
 * spec's "explicit link-vs-create choice" always applies to properties.
 */
export function findPropertyMatches(
  address: string | null | undefined,
  existingProperties: readonly ExistingPropertyRow[],
  opts: { clientId?: string } = {},
): PropertyMatchCandidate[] {
  const qAddress = normalizeAddressCore(address);
  if (!qAddress) return [];
  const pool = opts.clientId ? existingProperties.filter((p) => p.client_id === opts.clientId) : existingProperties;
  return pool
    .filter((p) => {
      const core = propertyAddressCore(p);
      return core.length > 0 && (core === qAddress || core.includes(qAddress) || qAddress.includes(core));
    })
    .map((property) => ({ property, strength: "fuzzy_suggestion" as MatchStrength }));
}
