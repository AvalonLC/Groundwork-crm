/** Minimal RFC4180-ish CSV parser — quoted fields, embedded commas, escaped
 * quotes (""). No external dependency for something this small. */
export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; } else { inQuotes = false; }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

export function parseCsv(text: string): ParsedCsv {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0);
  const [firstLine, ...rest] = lines;
  if (!firstLine) return { headers: [], rows: [] };
  const headers = parseCsvLine(firstLine);
  const rows = rest.map((line) => {
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ""; });
    return row;
  });
  return { headers, rows };
}

/** Parses a money string like "1,234.56" or "(1,234.56)" (accounting
 * negative) into integer cents. */
export function parseMoneyToCents(raw: string): number {
  const trimmed = raw.trim();
  const negative = trimmed.startsWith("(") && trimmed.endsWith(")");
  const cleaned = trimmed.replace(/[(),$]/g, "");
  const dollars = Number(cleaned);
  const cents = Math.round(dollars * 100);
  return negative ? -cents : cents;
}
