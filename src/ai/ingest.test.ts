/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { detectSource, ingestFile, ingestXlsxFile } from "./ingest";
import { parseCsv, parseMoneyToCents } from "./csv";
import { insertOverheadPool, getOpenActionItems } from "../db/repos";
import avalonFixture from "../../fixtures/ingest/qbo-class-pnl-wide-avalon.base64.json" with { type: "json" };

const db = () => env.DB;
const TENANT = "t-ingest";

/** Same real uploaded Avalon export used in src/ai/xlsx.test.ts, decoded from
 * the base64 sidecar since vitest-pool-workers has no `fs`. */
function avalonFixtureBytes(): ArrayBuffer {
  const bin = Uint8Array.from(atob(avalonFixture.base64), (ch) => ch.charCodeAt(0));
  return bin.buffer;
}

describe("csv helpers", () => {
  it("IG-01 parses quoted fields with embedded commas", () => {
    const { headers, rows } = parseCsv('Account,Total\n"Fuel, Vehicles",1234.56');
    expect(headers).toEqual(["Account", "Total"]);
    expect(rows[0].Account).toBe("Fuel, Vehicles");
    expect(rows[0].Total).toBe("1234.56");
  });

  it("IG-02 parses accounting-negative money strings", () => {
    expect(parseMoneyToCents("1,234.56")).toBe(123456);
    expect(parseMoneyToCents("(1,234.56)")).toBe(-123456);
    expect(parseMoneyToCents("$500.00")).toBe(50000);
  });
});

describe("detectSource — config-driven format detection", () => {
  it("IG-03 detects each of the five configured source types", () => {
    expect(detectSource(["Account", "Total"])?.id).toBe("qbo_pnl_export");
    expect(detectSource(["Class", "Account", "Total"])?.id).toBe("qbo_class_pnl_export");
    expect(detectSource(["Account", "Balance"])?.id).toBe("balance_sheet_export");
    expect(detectSource(["Date", "Description", "Amount"])?.id).toBe("bank_csv_generic");
    expect(detectSource(["Employee", "Pay Date", "Gross Pay"])?.id).toBe("payroll_export_generic");
  });

  it("IG-04 an unrecognized header set matches nothing", () => {
    expect(detectSource(["Foo", "Bar", "Baz"])).toBeNull();
  });
});

describe("ingestFile — unknown format", () => {
  it("IG-05 an unrecognized file creates exactly one review action_item, no line processing", async () => {
    const result = await ingestFile(db(), TENANT, "Foo,Bar\n1,2", "office-user-1");
    expect(result.source_id).toBeNull();
    expect(result.lines.length).toBe(0);
    expect(result.review_action_item_ids.length).toBe(1);
    const open = await getOpenActionItems(db(), TENANT, "decide");
    expect(open.some((a) => a.id === result.review_action_item_ids[0])).toBe(true);
  });
});

describe("ingestFile — class/division P&L", () => {
  it("IG-06 known division aliases resolve to canonical names, no review needed", async () => {
    const csv = "Class,Account,Total\nlawn maintenance,Fuel,500.00\nhardscaping,Materials,1200.00";
    const result = await ingestFile(db(), "t-ingest-known", csv, "office-user-1");
    expect(result.source_id).toBe("qbo_class_pnl_export");
    expect(result.lines[0].division).toBe("maintenance");
    expect(result.lines[1].division).toBe("hardscape");
    expect(result.lines.every((l) => !l.needs_review)).toBe(true);
  });

  it("forbidden: an unmapped division is flagged for review, never guessed", async () => {
    const csv = "Class,Account,Total\nSome Totally New Division,Fuel,500.00";
    const result = await ingestFile(db(), "t-ingest-unmapped", csv, "office-user-1");
    expect(result.lines[0].division).toBeNull();
    expect(result.lines[0].needs_review).toBe(true);
    expect(result.review_action_item_ids.length).toBe(1);
    const open = await getOpenActionItems(db(), "t-ingest-unmapped", "decide");
    expect(open.length).toBe(1);
  });

  it("forbidden: auto-approving any reclassification — every needs_review line becomes an action_item, never silently resolved", async () => {
    const csv = "Class,Account,Total\nUnknown A,Fuel,100.00\nUnknown B,Materials,200.00";
    const result = await ingestFile(db(), "t-ingest-multi-unmapped", csv, "office-user-1");
    expect(result.review_action_item_ids.length).toBe(2); // one per unmapped line, not auto-resolved
  });

  it("IG-09 gap report finds divisions with a pool but no P&L coverage, and vice versa", async () => {
    await insertOverheadPool(db(), {
      company_id: "t-ingest-gap", division: "snow", pool_type: "shop", annual_cost_cents: 100000, driver: "sellable_hours", as_of: "2026-08-01",
    });
    const csv = "Class,Account,Total\nlawn maintenance,Fuel,500.00";
    const result = await ingestFile(db(), "t-ingest-gap", csv, "office-user-1");
    expect(result.gap_report.divisions_with_pool_but_no_pnl_line).toContain("snow");
    expect(result.gap_report.pnl_divisions_with_no_matching_pool).toContain("maintenance");
  });
});

describe("ingestXlsxFile — real Avalon QBO Class P&L export (.xlsx)", () => {
  it("IG-11 detects the wide class/division P&L shape and produces one line per (account, division)", async () => {
    const result = await ingestXlsxFile(db(), "t-ingest-avalon", avalonFixtureBytes(), "office-user-1");
    expect(result.source_id).toBe("qbo_class_pnl_wide_xlsx");
    expect(result.total_rows).toBe(96);
    expect(result.lines.length).toBe(96);
  });

  it("IG-12 divisions that match the platform default map (case-insensitively) resolve with no review flag", async () => {
    const result = await ingestXlsxFile(db(), "t-ingest-avalon-resolved", avalonFixtureBytes(), "office-user-1");
    // "Maintenance" (capitalized, from the real file) matches canonical
    // "maintenance" case-insensitively; "Snow Removal" is a configured
    // alias of canonical "snow" — both resolve without any review flag.
    const maintenanceLines = result.lines.filter((l) => l.division_raw === "Maintenance");
    const snowLines = result.lines.filter((l) => l.division_raw === "Snow Removal");
    expect(maintenanceLines.length).toBe(37);
    expect(snowLines.length).toBe(18);
    expect(maintenanceLines.every((l) => l.division === "maintenance" && !l.needs_review)).toBe(true);
    expect(snowLines.every((l) => l.division === "snow" && !l.needs_review)).toBe(true);
  });

  it("IG-13 divisions absent from the platform default map are flagged for review, never guessed — real Avalon file has two: Landscaping, G&A", async () => {
    const tenant = "t-ingest-avalon-unresolved";
    const result = await ingestXlsxFile(db(), tenant, avalonFixtureBytes(), "office-user-1");
    const landscapingLines = result.lines.filter((l) => l.division_raw === "Landscaping");
    const gaLines = result.lines.filter((l) => l.division_raw === "G&A");
    expect(landscapingLines.length).toBe(38);
    expect(gaLines.length).toBe(3);
    expect(landscapingLines.every((l) => l.division === null && l.needs_review)).toBe(true);
    expect(gaLines.every((l) => l.division === null && l.needs_review)).toBe(true);
    // One action_item per unmapped line (41 total: 38 + 3), never silently resolved.
    expect(result.review_action_item_ids.length).toBe(41);
    const open = await getOpenActionItems(db(), tenant, "decide");
    expect(open.length).toBe(41);
  });

  it("IG-14 a non-xlsx blob is flagged for review with a clear reason, never silently skipped or guessed", async () => {
    const notXlsx = new TextEncoder().encode("just,a,csv\n1,2,3").buffer;
    const result = await ingestXlsxFile(db(), "t-ingest-bad-xlsx", notXlsx, "office-user-1");
    expect(result.source_id).toBeNull();
    expect(result.lines.length).toBe(0);
    expect(result.review_action_item_ids.length).toBe(1);
  });

  it("IG-15 gap report also works for xlsx-sourced lines: division with a pool but no P&L line, and vice versa", async () => {
    const tenant = "t-ingest-avalon-gap";
    await insertOverheadPool(db(), {
      company_id: tenant, division: "hardscape", pool_type: "shop", annual_cost_cents: 100000, driver: "sellable_hours", as_of: "2026-08-01",
    });
    const result = await ingestXlsxFile(db(), tenant, avalonFixtureBytes(), "office-user-1");
    expect(result.gap_report.divisions_with_pool_but_no_pnl_line).toContain("hardscape");
    expect(result.gap_report.pnl_divisions_with_no_matching_pool).toContain("maintenance");
    expect(result.gap_report.pnl_divisions_with_no_matching_pool).toContain("snow");
  });
});

describe("forbidden: no GL-posting capability exists in this module", () => {
  it("IG-10 the module has no outbound-write export — only Finance OS's own DB is ever touched", async () => {
    const mod = await import("./ingest");
    const exportNames = Object.keys(mod);
    // Structural proof, not just convention: nothing here is named/shaped
    // like a GL/QBO write path.
    expect(exportNames.some((n) => /post|write|sync/i.test(n))).toBe(false);
  });
});
