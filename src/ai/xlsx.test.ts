/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { readXlsxGrid, findWideClassPnlHeader, parseWideClassPnl } from "./xlsx";
import avalonFixture from "../../fixtures/ingest/qbo-class-pnl-wide-avalon.base64.json" with { type: "json" };

/** atob/btoa are already used elsewhere in this codebase (src/index.tsx,
 * src/marketing/providers/sendgrid.ts) against the real Workers runtime —
 * confirmed available here too. The workers pool test environment has no
 * `fs`, so the real uploaded Avalon fixture (fixtures/ingest/
 * qbo-class-pnl-wide-avalon.xlsx) is base64-encoded once at fixture-build
 * time into a sibling .base64.json, imported as a JSON module, and decoded
 * back to bytes here — same file, same bytes, just DB-runtime-safe. */
function fixtureBytes(): ArrayBuffer {
  const bin = Uint8Array.from(atob(avalonFixture.base64), (ch) => ch.charCodeAt(0));
  return bin.buffer;
}

describe("readXlsxGrid — real Avalon QBO Class P&L export", () => {
  it("XL-01 reads the title, header, and footer rows correctly", () => {
    const grid = readXlsxGrid(fixtureBytes());
    expect(grid.length).toBe(75);
    expect(grid[0][0]).toBe("Avalon Landscape Construction LLC");
    expect(grid[4]).toEqual(["", "G&A", "Landscaping", "Maintenance", "Snow Removal", "Total"]);
    expect(grid[74][0]).toContain("Accrual Basis");
  });

  it("XL-02 reads a plain data row with per-division dollar amounts", () => {
    const grid = readXlsxGrid(fixtureBytes());
    // Row 8 (1-based) = grid index 7 — "Services", the sole Income line.
    expect(grid[7][0]).toBe("Services");
    expect(grid[7][2]).toBeCloseTo(160881.37, 2);
    expect(grid[7][3]).toBeCloseTo(263343.97, 2);
    expect(grid[7][4]).toBeCloseTo(190664.32, 2);
  });

  it("XL-03 throws a clear error on a non-xlsx blob instead of silently returning garbage", () => {
    const notXlsx = new TextEncoder().encode("just,a,csv\n1,2,3").buffer;
    expect(() => readXlsxGrid(notXlsx)).toThrow(/not a readable \.xlsx/);
  });
});

describe("findWideClassPnlHeader", () => {
  it("XL-04 locates the division header row and its columns, skipping the title rows above it", () => {
    const grid = readXlsxGrid(fixtureBytes());
    const header = findWideClassPnlHeader(grid);
    expect(header).not.toBeNull();
    expect(header!.headerRowIndex).toBe(4);
    expect(header!.divisions.map((d) => d.name)).toEqual(["G&A", "Landscaping", "Maintenance", "Snow Removal"]);
    expect(header!.totalColIndex).toBe(5);
  });

  it("XL-05 returns null for a grid with no such header (e.g. a tall Class/Account/Total sheet)", () => {
    const grid = [["Class", "Account", "Total"], ["maintenance", "Fuel", "500"]];
    expect(findWideClassPnlHeader(grid)).toBeNull();
  });
});

describe("parseWideClassPnl", () => {
  it("XL-06 flattens real account lines into one entry per (account, division), skipping subtotal/section/group rows", () => {
    const grid = readXlsxGrid(fixtureBytes());
    const header = findWideClassPnlHeader(grid)!;
    const lines = parseWideClassPnl(grid, header);

    // Never a subtotal/rollup label.
    expect(lines.some((l) => /^total\b/i.test(l.account))).toBe(false);
    expect(lines.some((l) => l.account === "Gross Profit")).toBe(false);
    expect(lines.some((l) => l.account === "Net Operating Income")).toBe(false);
    expect(lines.some((l) => l.account === "Net Income")).toBe(false);

    // Never a group header with no dollar value of its own (its children
    // carry the real amounts) — "Automobile Expense" and "Payroll -
    // Indirect Labor" are both such nested group headers in this file.
    expect(lines.some((l) => l.account === "Automobile Expense")).toBe(false);
    expect(lines.some((l) => l.account === "Payroll - Indirect Labor")).toBe(false);

    // A real top-level line: Services, Landscaping division.
    const services = lines.find((l) => l.account === "Services" && l.division_raw === "Landscaping");
    expect(services?.amount).toBeCloseTo(160881.37, 2);

    // A real nested-group child line: Fuel (under Automobile Expense), G&A
    // division has no value for Fuel at all (null, not zero) — must be
    // omitted, not forced to 0.
    expect(lines.some((l) => l.account === "Fuel" && l.division_raw === "G&A")).toBe(false);
    const fuelLandscaping = lines.find((l) => l.account === "Fuel" && l.division_raw === "Landscaping");
    expect(fuelLandscaping?.amount).toBeCloseTo(8625.73, 2);

    // A genuine zero value (not blank) must be kept, not dropped: Ridgefield
    // Earnout is 0 for Landscaping/Maintenance in the source file.
    const earnout = lines.find((l) => l.account === "Ridgefield Earnout" && l.division_raw === "Landscaping");
    expect(earnout?.amount).toBe(0);
  });

  it("XL-07 never emits a line for the Total column itself (it's a derived rollup, not a division)", () => {
    const grid = readXlsxGrid(fixtureBytes());
    const header = findWideClassPnlHeader(grid)!;
    const lines = parseWideClassPnl(grid, header);
    expect(lines.some((l) => l.division_raw === "Total")).toBe(false);

    // "Loan Origination Costs" only has a value in the G&A column in the
    // source file (Landscaping/Maintenance/Snow Removal are all null,
    // Total is the same 150 as G&A) — confirms the row isn't skipped as
    // "all blank" just because most of its division columns are null, and
    // that only the true division column comes through, not Total.
    const loanOrigination = lines.filter((l) => l.account === "Loan Origination Costs");
    expect(loanOrigination.length).toBe(1);
    expect(loanOrigination[0].division_raw).toBe("G&A");
    expect(loanOrigination[0].amount).toBe(150);
  });
});
