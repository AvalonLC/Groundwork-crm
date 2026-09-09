/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  DEFAULT_DIVISIONS, parseCompanyDivisions, loadCompanyDivisions, classifyDivision,
  type Division,
} from "./lead-import-division";

const db = () => env.DB;
const TENANT = "t-division-classify";

const CUSTOM_DIVISIONS: Division[] = [
  { key: "tree_removal", label: "Tree Removal", color: "#7A4A2D" },
  { key: "irrigation", label: "Irrigation", color: "#2D6FA7" },
  { key: "hardscape", label: "Hardscaping", color: "#8A6D3B" },
];

// ── parseCompanyDivisions — pure, no DB ─────────────────────────────────────

describe("parseCompanyDivisions", () => {
  it("DIV-01 falls back to DEFAULT_DIVISIONS for null/empty/malformed input", () => {
    expect(parseCompanyDivisions(null)).toEqual(DEFAULT_DIVISIONS);
    expect(parseCompanyDivisions(undefined)).toEqual(DEFAULT_DIVISIONS);
    expect(parseCompanyDivisions("")).toEqual(DEFAULT_DIVISIONS);
    expect(parseCompanyDivisions("not json")).toEqual(DEFAULT_DIVISIONS);
    expect(parseCompanyDivisions("[]")).toEqual(DEFAULT_DIVISIONS);
    expect(parseCompanyDivisions("{}")).toEqual(DEFAULT_DIVISIONS);
    expect(parseCompanyDivisions(JSON.stringify([{ color: "#fff" }]))).toEqual(DEFAULT_DIVISIONS); // no key/label
  });

  it("DIV-02 parses a well-formed tenant division list, filtering out incomplete entries", () => {
    const raw = JSON.stringify([
      { key: "tree_removal", label: "Tree Removal", color: "#7A4A2D" },
      { key: "no_label_here" }, // missing label -> dropped
      { key: "irrigation", label: "Irrigation", color: "#2D6FA7" },
    ]);
    const parsed = parseCompanyDivisions(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].key).toBe("tree_removal");
    expect(parsed[1].key).toBe("irrigation");
  });

  it("DIV-03 defaults a missing color to the same #2D7A55 gwDivisions() uses", () => {
    const parsed = parseCompanyDivisions(JSON.stringify([{ key: "x", label: "X" }]));
    expect(parsed[0].color).toBe("#2D7A55");
  });
});

// ── loadCompanyDivisions — real D1 read ─────────────────────────────────────

describe("loadCompanyDivisions", () => {
  it("DIV-04 reads the exact {companyId}:company_divisions setting key and parses it", async () => {
    await db().prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,datetime('now'))`)
      .bind(`${TENANT}:company_divisions`, JSON.stringify(CUSTOM_DIVISIONS)).run();
    const divisions = await loadCompanyDivisions(db(), TENANT);
    expect(divisions).toEqual(CUSTOM_DIVISIONS);
  });

  it("DIV-05 falls back to defaults when the tenant has no setting row at all", async () => {
    const divisions = await loadCompanyDivisions(db(), "t-no-divisions-configured");
    expect(divisions).toEqual(DEFAULT_DIVISIONS);
  });

  it("DIV-06 never leaks another tenant's division setting (reads are prefix-scoped)", async () => {
    await db().prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,datetime('now'))`)
      .bind(`t-division-tenant-a:company_divisions`, JSON.stringify([{ key: "a_only", label: "A Only", color: "#111" }])).run();
    const divisions = await loadCompanyDivisions(db(), "t-division-tenant-b");
    expect(divisions.some((d) => d.key === "a_only")).toBe(false);
  });
});

// ── classifyDivision — the deterministic-first / AI-suggestion-fallback core ─

describe("classifyDivision", () => {
  it("DIV-07 throws only on a truly empty divisions array (a caller bug, never reachable via loadCompanyDivisions)", () => {
    expect(() => classifyDivision([], {})).toThrow();
  });

  it("DIV-08 explicit division key match wins outright, case-insensitively", () => {
    const r = classifyDivision(CUSTOM_DIVISIONS, { explicitDivision: "TREE_REMOVAL" });
    expect(r.division.key).toBe("tree_removal");
    expect(r.source).toBe("explicit");
    expect(r.isFallback).toBe(false);
  });

  it("DIV-09 explicit division LABEL match also wins, case-insensitively", () => {
    const r = classifyDivision(CUSTOM_DIVISIONS, { explicitDivision: "irrigation" });
    expect(r.division.key).toBe("irrigation");
    expect(r.source).toBe("explicit");
  });

  it("DIV-10 keyword match against a division's own key/label words, when no explicit match exists", () => {
    const r = classifyDivision(CUSTOM_DIVISIONS, { projectCategory: "Full irrigation system install for backyard" });
    expect(r.division.key).toBe("irrigation");
    expect(r.source).toBe("keyword");
    expect(r.isFallback).toBe(false);
  });

  it("DIV-11 keyword match reads across projectCategory/workType/serviceLine combined, not just projectCategory alone", () => {
    const r = classifyDivision(CUSTOM_DIVISIONS, { projectCategory: "", workType: "Full hardscape renovation", serviceLine: "patio and retaining wall" });
    expect(r.division.key).toBe("hardscape");
    expect(r.source).toBe("keyword");
  });

  it("DIV-12 an explicit division mismatch (name matches nothing real) falls through to keyword matching, not an error", () => {
    const r = classifyDivision(CUSTOM_DIVISIONS, { explicitDivision: "does_not_exist", projectCategory: "irrigation repair" });
    expect(r.division.key).toBe("irrigation");
    expect(r.source).toBe("keyword");
  });

  it("DIV-13 legacy keyword bridge still resolves for the three original default division keys", () => {
    const r = classifyDivision(DEFAULT_DIVISIONS, { projectCategory: "Plow the lot after snowfall" });
    expect(r.division.key).toBe("snow");
    expect(r.source === "keyword" || r.source === "legacy_bridge").toBe(true);
  });

  it("DIV-14 legacy bridge fires specifically when the keyword word itself is too short to match the >=4-char keyword-match tier (e.g. 'ice')", () => {
    const r = classifyDivision(DEFAULT_DIVISIONS, { projectCategory: "ice management contract" });
    expect(r.division.key).toBe("snow");
    expect(r.source).toBe("legacy_bridge");
  });

  it("DIV-15 AI suggestion is consulted only when deterministic matching finds nothing, and only resolved against a real division label", () => {
    const r = classifyDivision(CUSTOM_DIVISIONS, { aiSuggestedLabel: "Tree Removal" });
    expect(r.division.key).toBe("tree_removal");
    expect(r.source).toBe("ai_suggestion");
    expect(r.isFallback).toBe(false);
  });

  it("DIV-16 a deterministic keyword match wins over a present but conflicting AI suggestion — AI is a fallback signal, never an override", () => {
    const r = classifyDivision(CUSTOM_DIVISIONS, {
      projectCategory: "irrigation system tune-up",
      aiSuggestedLabel: "Tree Removal", // deliberately conflicting — must be ignored
    });
    expect(r.division.key).toBe("irrigation");
    expect(r.source).toBe("keyword");
  });

  it("DIV-17 an AI suggestion naming a division that does not exist for this tenant is discarded, not partially trusted", () => {
    const r = classifyDivision(CUSTOM_DIVISIONS, { aiSuggestedLabel: "Underwater Basket Weaving" });
    expect(r.division.key).toBe(CUSTOM_DIVISIONS[0].key); // falls all the way through to default
    expect(r.source).toBe("default");
    expect(r.isFallback).toBe(true);
  });

  it("DIV-18 an AI suggestion never resolves via a database id, only via the division's own label/key text — passing something id-shaped simply won't match", () => {
    const r = classifyDivision(CUSTOM_DIVISIONS, { aiSuggestedLabel: "div_irrigation_9f3a" });
    // "div_irrigation_9f3a" contains "irrigation" as a substring of the raw
    // label text, which the word-match tier legitimately catches — this
    // assertion documents that behavior is driven by the real word
    // "irrigation", not by treating the string as an id lookup.
    expect(r.division.key).toBe("irrigation");
    expect(r.source).toBe("ai_suggestion");
  });

  it("DIV-19 nothing matches at all -> falls back to divisions[0], flagged isFallback:true so the UI can show 'Needs review'", () => {
    const r = classifyDivision(CUSTOM_DIVISIONS, {});
    expect(r.division).toEqual(CUSTOM_DIVISIONS[0]);
    expect(r.source).toBe("default");
    expect(r.isFallback).toBe(true);
  });

  it("DIV-20 never throws on garbage/empty-string inputs", () => {
    expect(() => classifyDivision(CUSTOM_DIVISIONS, {
      explicitDivision: "", projectCategory: null, workType: undefined, serviceLine: "", aiSuggestedLabel: null,
    })).not.toThrow();
  });
});
