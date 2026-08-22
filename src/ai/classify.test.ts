/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { classifyDeterministic, classifyTransaction } from "./classify";
import { upsertTenantFinancePolicy, getOpenActionItems } from "../db/repos";
import { classifierRules } from "../config/finance-config";

const db = () => env.DB;
const TENANT = "t-classify";

describe("classifyDeterministic (pure, config-driven) — v1 production rules, 2026-08-22", () => {
  it("CL-01 a medium-confidence vendor match still requires review (below auto_categorize_min)", () => {
    const d = classifyDeterministic({
      company_id: TENANT, subject_type: "bank_transaction", subject_id: "tx-1",
      vendor: "Home Depot #4021", memo: null, amount_cents: 5000,
    });
    expect(d.stage_reached).toBe(1);
    expect(d.category).toBe("materials");
    expect(d.confidence).toBe("medium");
    expect(d.requires_review).toBe(true); // "medium" < auto_categorize_min "high"
  });

  it("CL-02 stage 1: a high-confidence fuel-station vendor match resolves without review", () => {
    const d = classifyDeterministic({
      company_id: TENANT, subject_type: "bank_transaction", subject_id: "tx-2",
      vendor: "Shell Gas Station #4021", memo: null, amount_cents: 5000,
    });
    expect(d.stage_reached).toBe(1);
    expect(d.category).toBe("fuel");
    expect(d.confidence).toBe("high");
    expect(d.requires_review).toBe(false);
  });

  it("CL-03 stage 2: a memo keyword match is found when vendor doesn't match", () => {
    const d = classifyDeterministic({
      company_id: TENANT, subject_type: "bank_transaction", subject_id: "tx-3",
      vendor: "Unknown Vendor LLC", memo: "dump fee for job site debris", amount_cents: 20000,
    });
    expect(d.stage_reached).toBe(2);
    expect(d.category).toBe("disposal_and_hauling");
  });

  it("CL-04 subcontractor keyword: unsplit labor-and-materials invoice retains full amount under one category", () => {
    const d = classifyDeterministic({
      company_id: TENANT, subject_type: "bank_transaction", subject_id: "tx-sub",
      vendor: "J Rodriguez", memo: "labor and materials - drainage job", amount_cents: 150000,
    });
    expect(d.category).toBe("subcontractor");
    // amount is $1,500 (150000 cents), under the $2,500 stage3 threshold —
    // still review because subcontractor's confidence (medium) is below
    // auto_categorize_min, not because of the amount rule.
    expect(d.requires_review).toBe(true);
  });

  it("CL-05 repairs/maintenance vendor pattern (reusable tools context) resolves at high confidence", () => {
    const d = classifyDeterministic({
      company_id: TENANT, subject_type: "bank_transaction", subject_id: "tx-vehicle",
      vendor: "AutoZone #204", memo: null, amount_cents: 4500,
    });
    expect(d.category).toBe("repairs_and_maintenance");
    expect(d.confidence).toBe("high");
    expect(d.requires_review).toBe(false);
  });

  it("CL-06 equipment rental company vendor pattern resolves at high confidence", () => {
    const d = classifyDeterministic({
      company_id: TENANT, subject_type: "bank_transaction", subject_id: "tx-rental",
      vendor: "United Rentals Inc", memo: null, amount_cents: 80000,
    });
    expect(d.category).toBe("equipment_rental");
    expect(d.confidence).toBe("high");
    expect(d.requires_review).toBe(false);
  });

  it("CL-07 no match at all: stage 3, always requires review", () => {
    const d = classifyDeterministic({
      company_id: TENANT, subject_type: "bank_transaction", subject_id: "tx-none",
      vendor: "Totally Unrecognized Co", memo: "misc", amount_cents: 1000,
    });
    expect(d.stage_reached).toBe(3);
    expect(d.category).toBeNull();
    expect(d.requires_review).toBe(true);
  });

  it("CL-08 bank fee keyword resolves at high confidence, no review needed", () => {
    const d = classifyDeterministic({
      company_id: TENANT, subject_type: "bank_transaction", subject_id: "tx-fee",
      vendor: "Bank of Somewhere", memo: "Monthly service fee", amount_cents: 1500,
    });
    expect(d.category).toBe("office_admin_overhead");
    expect(d.confidence).toBe("high");
    expect(d.requires_review).toBe(false);
  });

  it("forbidden guard: forced_review_categories (direct_labor) overrides even a high-confidence match", () => {
    const d = classifyDeterministic({
      company_id: TENANT, subject_type: "bank_transaction", subject_id: "tx-labor",
      vendor: null, memo: "day labor for crew this week", amount_cents: 40000,
    });
    expect(d.category).toBe("direct_labor");
    expect(d.confidence).toBe("high"); // would otherwise auto-resolve
    expect(d.requires_review).toBe(true); // forced_review_categories catches it anyway
    expect(d.review_reason).toMatch(/forced_review_categories/);
  });

  it("forbidden guard: owner draw always routes to uncategorized_manual_review, never auto-resolved", () => {
    const d = classifyDeterministic({
      company_id: TENANT, subject_type: "bank_transaction", subject_id: "tx-draw",
      vendor: null, memo: "Owner draw for personal use", amount_cents: 100000,
    });
    expect(d.category).toBe("uncategorized_manual_review");
    expect(d.requires_review).toBe(true); // forced_review_categories catches it
  });

  it("CL-09 stage3 amount rule: a $2,500+ total always requires review, even a clean high-confidence match", () => {
    const d = classifyDeterministic({
      company_id: TENANT, subject_type: "bank_transaction", subject_id: "tx-large",
      vendor: "Shell Gas Station #4021", memo: null, amount_cents: 250000, // exactly $2,500
    });
    expect(d.category).toBe("fuel");
    expect(d.confidence).toBe("high"); // would otherwise auto-resolve
    expect(d.requires_review).toBe(true); // stage3_amount_review_rules catches it anyway
    expect(d.review_reason).toMatch(/2,500/);
  });

  it("CL-10 just under the $2,500 stage3 threshold does not force review by amount alone", () => {
    const d = classifyDeterministic({
      company_id: TENANT, subject_type: "bank_transaction", subject_id: "tx-under",
      vendor: "Shell Gas Station #4021", memo: null, amount_cents: 249999,
    });
    expect(d.category).toBe("fuel");
    expect(d.requires_review).toBe(false);
  });

  it("CL-11 every category referenced by a rule is a defined category in classifier.rules.json", () => {
    const categoryIds = new Set(classifierRules.categories.map((c) => c.id));
    const allRules: { id: string; category: string }[] = [
      ...classifierRules.stage1_vendor_patterns, ...classifierRules.stage2_keyword_rules,
    ];
    for (const rule of allRules) {
      expect(categoryIds.has(rule.category), `rule "${rule.id}" references undefined category "${rule.category}"`).toBe(true);
    }
    for (const cat of classifierRules.forced_review_categories) {
      expect(categoryIds.has(cat), `forced_review_categories entry "${cat}" is not a defined category`).toBe(true);
    }
  });
});

describe("classifyTransaction (orchestration, DB-backed)", () => {
  it("CL-12 a clean high-confidence resolution writes a finding but no action_item", async () => {
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

  it("CL-13 AI is consulted once deterministic stages need review, and its suggestion is attached, never auto-applied", async () => {
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

  it("forbidden: amount over tenant materiality forces review even on an otherwise-clean high-confidence match, below the $2,500 stage3 threshold", async () => {
    await upsertTenantFinancePolicy(db(), {
      company_id: "t-classify-materiality", equipment_engine_active: 0,
      materiality_threshold_cents: 1000, restated_target_cents: 0, black_friday_date: null,
    } as never);
    const result = await classifyTransaction(
      db(),
      { company_id: "t-classify-materiality", subject_type: "bank_transaction", subject_id: "tx-big-fee", vendor: "Big Bank", memo: "Monthly service fee", amount_cents: 2000 },
      "office-user-1",
    );
    expect(result.decision.requires_review).toBe(false); // deterministically clean, under $2,500 stage3 floor...
    expect(result.materiality_forced_review).toBe(true); // ...but tenant materiality overrides it
    expect(result.action_item_id).not.toBeNull();
  });
});
