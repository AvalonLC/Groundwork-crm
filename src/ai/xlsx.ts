import { unzipSync, strFromU8 } from "fflate";

/**
 * Minimal XLSX (OOXML spreadsheet) reader — reads exactly what Finance OS
 * ingest needs: the first worksheet's grid of cell values, with shared
 * strings resolved. Not a general-purpose xlsx library: no styles, number
 * formats, multiple sheets, formula evaluation, or write support.
 *
 * Uses fflate (small, zero-dependency) to unzip the .xlsx container — an
 * xlsx file IS a zip of XML parts — then hand-rolled regex extraction for
 * the two parts that matter (xl/worksheets/sheet1.xml, xl/sharedStrings.xml).
 * Same rationale as csv.ts's hand-rolled CSV parser: this is small and
 * well-scoped enough not to justify a multi-MB dependency (the full `xlsx`
 * npm package is 7.5MB unpacked) in a Cloudflare Workers bundle.
 */

export type XlsxCellValue = string | number | null;

function columnLetterToIndex(letters: string): number {
  let index = 0;
  for (let i = 0; i < letters.length; i++) {
    index = index * 26 + (letters.charCodeAt(i) - 64);
  }
  return index - 1; // 0-based
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Each <si> shared-string entry can hold a plain <t> or several <r><t>...</t></r>
 * rich-text runs — concatenate every <t> found inside, in document order. */
function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const strings: string[] = [];
  const siBlocks = xml.match(/<si[^>]*>[\s\S]*?<\/si>/g) ?? [];
  for (const block of siBlocks) {
    const texts = [...block.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXmlEntities(m[1] ?? ""));
    strings.push(texts.join(""));
  }
  return strings;
}

interface ParsedCell { col: number; row: number; value: XlsxCellValue }

function parseSheetCells(xml: string, sharedStrings: string[]): ParsedCell[] {
  const cells: ParsedCell[] = [];
  // Two shapes: self-closing blank cells (<c r="B6" s="40" />) and cells
  // with a body (<c r="C8" s="42"><v>160881.37</v></c>, sometimes preceded
  // by a cached <f>formula</f> which is ignored — this module never
  // recalculates formulas, only reads the cached <v> result).
  const cellMatches = xml.matchAll(/<c\s+([^>]*)\/>|<c\s+([^>]*)>([\s\S]*?)<\/c>/g);
  for (const m of cellMatches) {
    const attrs = m[1] ?? m[2] ?? "";
    const body = m[3] ?? "";
    const refMatch = attrs.match(/r="([A-Z]+)(\d+)"/);
    if (!refMatch) continue;
    const col = columnLetterToIndex(refMatch[1]!);
    const row = Number(refMatch[2]!);
    const typeMatch = attrs.match(/t="([a-z]+)"/);
    const type = typeMatch ? typeMatch[1] : "n";

    const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
    if (!vMatch) { cells.push({ col, row, value: null }); continue; }
    const raw = vMatch[1] ?? "";

    let value: XlsxCellValue;
    if (type === "s") {
      value = sharedStrings[Number(raw)] ?? null;
    } else if (type === "str" || type === "e") {
      value = decodeXmlEntities(raw);
    } else if (type === "b") {
      value = raw === "1" ? 1 : 0;
    } else {
      const num = Number(raw);
      value = Number.isFinite(num) ? num : decodeXmlEntities(raw);
    }
    cells.push({ col, row, value });
  }
  return cells;
}

/**
 * Reads the first worksheet of an .xlsx file into a dense grid:
 * `grid[rowIndex][colIndex]`, 0-based on both axes, gaps filled with null.
 * Throws if `bytes` isn't a readable zip or is missing the expected
 * worksheet part — callers should catch this and treat it the same as any
 * other unrecognized upload (flag for review, never guess).
 */
export function readXlsxGrid(bytes: ArrayBuffer): XlsxCellValue[][] {
  let files: ReturnType<typeof unzipSync>;
  try {
    files = unzipSync(new Uint8Array(bytes));
  } catch {
    throw new Error("not a readable .xlsx workbook (not a valid zip container)");
  }
  const sheetFile = files["xl/worksheets/sheet1.xml"];
  if (!sheetFile) throw new Error("not a readable .xlsx workbook (missing xl/worksheets/sheet1.xml)");
  const sheetXml = strFromU8(sheetFile);
  const sharedStringsFile = files["xl/sharedStrings.xml"];
  const sharedStrings = parseSharedStrings(sharedStringsFile ? strFromU8(sharedStringsFile) : undefined);

  const cells = parseSheetCells(sheetXml, sharedStrings);
  const maxRow = cells.reduce((max, c) => Math.max(max, c.row), 0);
  const maxCol = cells.reduce((max, c) => Math.max(max, c.col), 0);

  const grid: XlsxCellValue[][] = Array.from({ length: maxRow }, () => Array<XlsxCellValue>(maxCol + 1).fill(null));
  for (const cell of cells) {
    grid[cell.row - 1]![cell.col] = cell.value;
  }
  return grid;
}

/**
 * Wide-format QuickBooks "Profit and Loss by Class" export — one column per
 * division/class instead of the tall Class,Account,Total shape the CSV
 * pipeline (ingest.sources.json's qbo_class_pnl_export) already handles.
 * Real example this was built and tested against: a genuine Avalon export
 * (fixtures/ingest/qbo-class-pnl-wide-avalon.xlsx) — title rows, a header
 * row of division names ending in "Total", account lines, section/subgroup
 * header rows (all-blank numeric columns), and "Total for X"/"Gross
 * Profit"/"Net ..." subtotal rows interleaved with the real line items.
 */

export interface WideClassPnlHeader {
  headerRowIndex: number; // 0-based, into the grid
  divisions: { colIndex: number; name: string }[]; // excludes the leading blank column and the trailing "Total" column
  totalColIndex: number;
}

/** QBO's own standard P&L rollup/subtotal labels — never real GL account
 * lines, always skipped. "Total for X" covers every section/subgroup
 * subtotal; the rest are the fixed named rollups this report format always
 * emits. Matched case-insensitively, so a real account can't accidentally
 * collide with a different capitalization by chance either way. */
const SUBTOTAL_LABEL_PATTERN = /^(total(\s+for\b)?\s|gross\s|net\s)/i;

/**
 * Looks for the division-header row: first column blank, every other
 * populated column a string, last populated column literally "Total"
 * (case-insensitive). This signature is specific to this export shape —
 * unlike the tall CSV formats' header row, it's not the file's first line
 * (title rows precede it), so this scans rather than assumes row 0.
 */
export function findWideClassPnlHeader(grid: XlsxCellValue[][]): WideClassPnlHeader | null {
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r]!;
    if (row.length < 2) continue;
    if (row[0] !== "" && row[0] !== null && row[0] !== undefined) continue; // first column must be blank
    const populated = row.slice(1).filter((v) => v !== null && v !== "" && v !== undefined);
    if (populated.length < 2) continue; // need at least one division + "Total"
    if (!populated.every((v) => typeof v === "string")) continue;
    const lastIndex = row.length - 1 - [...row].reverse().findIndex((v) => v !== null && v !== "" && v !== undefined);
    if (String(row[lastIndex] ?? "").trim().toLowerCase() !== "total") continue;

    const divisions: { colIndex: number; name: string }[] = [];
    for (let c = 1; c < lastIndex; c++) {
      const v = row[c];
      if (typeof v === "string" && v.trim() !== "") divisions.push({ colIndex: c, name: v.trim() });
    }
    if (divisions.length === 0) continue;
    return { headerRowIndex: r, divisions, totalColIndex: lastIndex };
  }
  return null;
}

export interface WideClassPnlLine {
  account: string;
  division_raw: string;
  amount: number; // dollars, as read from the cell — caller converts to cents
}

/**
 * Flattens the wide grid into one line per (account, division) cell that
 * actually has a value. Rows are classified generically, not by hardcoding
 * this file's specific section names, so the same logic covers top-level
 * sections (Income, Expenses, ...) and nested subgroups (Automobile
 * Expense, Payroll - Indirect Labor, ...) alike:
 *  - blank account label → skip (title/footer/spacer rows)
 *  - a QBO subtotal/rollup label (SUBTOTAL_LABEL_PATTERN) → skip
 *  - every division + Total column null → skip (a group header row, e.g.
 *    "Automobile Expense" itself has no dollar value, only its children do)
 *  - otherwise → a real line item; emit one WideClassPnlLine per division
 *    column that has a non-null value for this row (zero is a real value,
 *    kept; null means that division has no such line at all, omitted
 *    rather than forced to zero)
 */
export function parseWideClassPnl(grid: XlsxCellValue[][], header: WideClassPnlHeader): WideClassPnlLine[] {
  const lines: WideClassPnlLine[] = [];
  for (let r = header.headerRowIndex + 1; r < grid.length; r++) {
    const row = grid[r]!;
    const accountRaw = row[0];
    if (typeof accountRaw !== "string" || accountRaw.trim() === "") continue;
    const account = accountRaw.trim();
    if (SUBTOTAL_LABEL_PATTERN.test(account)) continue;

    const valueCols = [...header.divisions.map((d) => d.colIndex), header.totalColIndex];
    const allBlank = valueCols.every((c) => row[c] === null || row[c] === undefined);
    if (allBlank) continue; // group/section header row, not a line item

    for (const division of header.divisions) {
      const v = row[division.colIndex];
      if (typeof v === "number") {
        lines.push({ account, division_raw: division.name, amount: v });
      }
    }
  }
  return lines;
}
