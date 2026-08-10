/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { classifyDeterministic, classifyTransaction } from "./classify";
import { upsertTenantFinancePolicy, getOpenActionItems } from "../db/repos";
import { classifierRules } from "../config/finance-config";

const db = () => env.DB;
const TENANT = "t-classify";

describe("classifyDeterministic (pure, config-driven)", () => {
  it("CL-01 a medium-confidence vendor match still requires review (below auto_categorize_min)", () => {
    const d = classifyDeterministic({
      company_id: TENANT, subject_type: "bank_transaction", subject_id: "tx-1",
      vendor: "Shell Gas Station #4021", memo: null, amount_cents: 5000,
    });
    expect(d.stage_reached).toBe(1);
    expect(d.category).toBe("fuel");
    expect(d.requires_review).toBe(true); // "medium" < auto_categorize_min "high"
  });

  it("CL-02 stage 2: a memo keyword match is found when vendor doesn't match", () => {
    const d = classifyDeterministic({
      company_id: TENANT, subject_type: "bank_transaction", subject_id: "tx-2",
      vendor: "Unknown Vendor LLC", memo: "ADP Payroll run 7/15", amount_cents: 200000,
    });
    expect(d.stage_reached).toBe(2);
    expect(d.category).toBe("payroll");
  });

  it("CL-09 generic contractor-business starter categories match (vehicle maintenance, utilities, subcontractor labor)", () => {
    const vehicle = classifyDeterministic({
      company_id: TENANT, subject_type: "bank_transaction", subject_id: "tx-vehicle",
      vendor: "AutoZone #204", memo: null, amount_cents: 4500,
    });
    expect(vehicle.category).toBe("vehicle_maintenance");

    const utilities = classifyDeterministic({
      company_id: TENANT, subject_type: "bank_transaction", subject_id: "tx-utilities",
      vendor: "City Power Co", memo: "electric bill account #55219", amount_cents: 32000,
    });
    expect(utilities.category).toBe("utilities");

    const sub = classifyDeterministic({
      company_id: TENANT, subject_type: "bank_transaction", subject_id: "tx-sub",
      vendor: "J Rodriguez", memo: "subcontractor labor - drainage job", amount_cents: 150000,
    });
    expect(sub.category).toBe("subcontractor_labor");
  });

  it("CL-10 no new seed category resolves at high confidence — all still route to review", () => {
    // Deliberate design constraint (per the platform-default seeding pass):
    // none of the newly added generic categories should auto-resolve
    // without real data confirming them — only the two pre-existing
    // examples (bank_fees, owner_draw) demonstrate the auto-resolve path.
    const newCategoryIds = [
      "vehicle-maintenance-generic", "office-supplies-generic", "telecom-generic",
      "software-subscription-generic", "subcontractor-keyword", "utilities-keyword",
      "rent-keyword", "professional-services-keyword", "marketing-keyword",
      "permits-licenses-keyword", "uniforms-safety-keyword",
    ];
    // Re-derives from the same config the engine actually reads, so this
    // test fails loudly if someone bumps one of these to "high" without
    // reviewing why, rather than encoding a separate hardcoded expectation.
    const allRules: { id: string; confidence: string }[] = [
      ...classifierRules.stage1_vendor_patterns, ...classifierRules.stage2_keyword_rules,
    ];
    for (const id of newCategoryIds) {
      const rule = allRules.find((r) => r.id === id);
      expect(rule, `rule "${id}" should exist`).toBeDefined();
      expect(rule?.confidence, `rule "${id}" should not be high confidence yet`).not.toBe("high");
    }
  });

  it("CL-03 no match at all: stage 3, always requires review", () => {
    const d = classifyDeterministic({
      company_id: TENANT, subject_type: "bank_transaction", subject_id: "tx-3",
      vendor: "Totally Unrecognized Co", memo: "misc", amount_cents: 1000,
    });
    expect(d.stage_reached).toBe(3);
    expect(d.category).toBeNull();
    expect(d.requires_review).toBe(true);
  });

  it("CL-04 a high-confidence match at/above auto_categorize_min resolves without review", () => {
    const d = classifyDeterministic({
      company_id: TENANT, subject_type: "bank_transaction", subject_id: "tx-fee",
      vendor: "Bank of Somewhere", memo: "Monthly service fee", amount_cents: 1500,
    });
    expect(d.category).toBe("bank_fees");
    expect(d.confidence).toBe("high");
    expect(d.requires_review).toBe(false);
  });

  it("forbidden guard: forced_review_categories overrides even a high-confidence match", () => {
    const d = classifyDeterministic({
      company_id: TENANT, subject_type: "bank_transaction", subject_id: "tx-draw",
      vendor: null, memo: "Owner draw for personal use", amount_cents: 100000,
    });
    expect(d.category).toBe("owner_draw");
    expect(d.confidence).toBe("high"); // would otherwise auto-resolve
    expect(d.requires_review).toBe(true); // forced_review_categories catches it anyway
    expect(d.review_reason).toMatch(/forced_review_categories/);
  });
});

describe("classifyTransaction (orchestration, DB-backed)", () => {
  it("CL-06 a clean high-confidence resolution writes a finding but no action_item", async () => {
    const before = (await getOpenActionItems(db(), TENANT, "decide")).length;
    const result = await classifyTransaction(
      db(),
      { company_id: TENANT, subject_type: "bank_transaction", subject_id: "tx-clean-fee", vendor: "Big Bank", memo: "Monthly service fee", amount_cents: 1500 },
      "office-user-1",
    );
    expect(result.decision.requires_review).toBe(false);
    expect(result.action_item_id).toBeNull();
    const after = await getOpenActionItems(db(), TENANT, "decide");
    expect(after.length).toBe(before); // no new action_item
  });

  it("forbidden: never calls the AI stage before deterministic stages have failed", async () => {
    let aiCalled = false;
    await classifyTransaction(
      db(),
      { company_id: TENANT, subject_type: "bank_transaction", subject_id: "tx-ai-clean", vendor: "Big Bank", memo: "Monthly service fee", amount_cents: 1500 },
      "office-user-1",
      async () => { aiCalled = true; return { category: "materials", confidence: "high" }; },
    );
    expect(aiCalled).toBe(false); // resolved cleanly at stage 2 — AI never consulted
  });

  it("CL-08 AI is consulted once deterministic stages need review, and its suggestion is attached, never auto-applied", async () => {
    const result = await classifyTransaction(
      db(),
      { company_id: TENANT, subject_type: "bank_transaction", subject_id: "tx-ai-2", vendor: "Unmatched Vendor", memo: null, amount_cents: 3000 },
      "office-user-1",
      async () => ({ category: "materials", confidence: "high" }),
    );
    expect(result.ai_suggestion?.category).toBe("materials");
    expect(result.action_item_id).not.toBeNull(); // still landed as a review item, not auto-applied
    const open = await getOpenActionItems(db(), TENANT, "decide");
    expect(open.some((a) => a.id === result.action_item_id)).toBe(true);
  });

  it("forbidden: amount over tenant materiality forces review even on an otherwise-clean high-confidence match", async () => {
    await upsertTenantFinancePolicy(db(), {
      company_id: "t-classify-materiality", equipment_engine_active: 0,
      materiality_threshold_cents: 1000, restated_target_cents: 0, black_friday_date: null,
    } as never);
    const result = await classifyTransaction(
      db(),
      { company_id: "t-classify-materiality", subject_type: "bank_transaction", subject_id: "tx-big-fee", vendor: "Big Bank", memo: "Monthly service fee", amount_cents: 999999 },
      "office-user-1",
    );
    expect(result.decision.requires_review).toBe(false); // deterministically clean...
    expect(result.materiality_forced_review).toBe(true); // ...but materiality overrides it
    expect(result.action_item_id).not.toBeNull();
  });
});
