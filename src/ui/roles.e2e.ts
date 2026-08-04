import { test, expect } from "@playwright/test";
import { canSee, assertCrewCannotSee, ROLE_PERMISSIONS, type Role } from "./roles";
import { translateTerm, DEFAULT_VOCABULARY_MODE } from "./vocabulary";

// No .tsx page exists yet for this task (files_owned is roles.ts/vocabulary.ts
// only) — this exercises the role/vocabulary logic directly through the
// Playwright test runner rather than a browser, the way later UI tasks
// (money-loop, recovery, budget, queue, job-costing) will drive real pages.

test.describe("crew-cannot-see-margin", () => {
  const fields = ["can_see_margin", "can_see_wage", "can_see_rate"] as const;

  for (const field of fields) {
    test(`crew role: ${field} is false`, () => {
      expect(ROLE_PERMISSIONS.crew[field]).toBe(false);
      expect(assertCrewCannotSee("crew", field)).toBe(true);
    });
  }

  test("crew_lead also cannot see margin/wage/rate", () => {
    expect(canSee("crew_lead", "can_see_margin")).toBe(false);
    expect(canSee("crew_lead", "can_see_wage")).toBe(false);
    expect(canSee("crew_lead", "can_see_rate")).toBe(false);
  });

  test("office and owner can see margin/wage/rate", () => {
    for (const role of ["office", "owner"] as Role[]) {
      expect(canSee(role, "can_see_margin")).toBe(true);
      expect(canSee(role, "can_see_wage")).toBe(true);
      expect(canSee(role, "can_see_rate")).toBe(true);
    }
  });

  test("only owner can see budget rates", () => {
    expect(canSee("owner", "can_see_budget_rates")).toBe(true);
    expect(canSee("office", "can_see_budget_rates")).toBe(false);
    expect(canSee("crew", "can_see_budget_rates")).toBe(false);
  });
});

test.describe("vocabulary toggle", () => {
  test("simple mode is the default and contains no accounting words", () => {
    expect(DEFAULT_VOCABULARY_MODE).toBe("simple");
    const simple = translateTerm("burdened rate", "simple");
    expect(simple).toBe("true hourly cost");
    expect(simple).not.toMatch(/burden|rate/i);
  });

  test("advanced mode returns the real accounting term unchanged", () => {
    expect(translateTerm("burdened rate", "advanced")).toBe("burdened rate");
  });

  test("an unmapped term passes through unchanged in simple mode (never throws)", () => {
    expect(translateTerm("some unmapped term", "simple")).toBe("some unmapped term");
  });
});
