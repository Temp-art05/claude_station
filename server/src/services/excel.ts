import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import * as XLSX from "xlsx";

export interface ParsedSheet {
  name: string;
  rows: number;
  cols: number;
  csvPath: string;
}

export interface ParsedWorkbook {
  dir: string;
  sheets: ParsedSheet[];
  metaPath: string;
}

/**
 * Claude reads CSV far more reliably than binary .xlsx, so every import is
 * flattened to one CSV per sheet next to the original plus a meta.json index.
 */
export function parseWorkbook(xlsxPath: string): ParsedWorkbook {
  const wb = XLSX.read(readFileSync(xlsxPath), { type: "buffer", cellDates: true });
  const stem = basename(xlsxPath, extname(xlsxPath));
  const dir = join(dirname(xlsxPath), `${stem}.parsed`);
  mkdirSync(dir, { recursive: true });

  const sheets: ParsedSheet[] = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    const safe = name.replace(/[^\w.-]+/g, "_").slice(0, 60) || "sheet";
    const csvPath = join(dir, `${safe}.csv`);
    writeFileSync(csvPath, csv, "utf8");
    const range = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : null;
    sheets.push({
      name,
      rows: range ? range.e.r - range.s.r + 1 : 0,
      cols: range ? range.e.c - range.s.c + 1 : 0,
      csvPath,
    });
  }

  const metaPath = join(dir, "meta.json");
  writeFileSync(
    metaPath,
    JSON.stringify({ source: xlsxPath, parsedAt: new Date().toISOString(), sheets }, null, 2),
    "utf8",
  );
  return { dir, sheets, metaPath };
}

export interface SheetSpec {
  name: string;
  /** Row-major cells; first row is normally the header. */
  rows: (string | number | boolean | null)[][];
}

/** Write a new workbook — used by the excel_write tool so Claude can produce reports. */
export function writeWorkbook(targetPath: string, sheets: SheetSpec[]): string {
  const wb = XLSX.utils.book_new();
  for (const spec of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(spec.rows);
    XLSX.utils.book_append_sheet(wb, ws, spec.name.slice(0, 31) || "Sheet1");
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  // Write the buffer ourselves — SheetJS's ESM build can't always resolve `fs`,
  // and XLSX.writeFile then fails with a bare "cannot save file".
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  writeFileSync(targetPath, buffer);
  return targetPath;
}

/** Read a slice of a sheet back as rows — the excel_read tool's payload. */
export function readSheet(
  xlsxOrCsvPath: string,
  sheetName?: string,
  limit = 200,
): { sheet: string; rows: unknown[][]; truncated: boolean } {
  const wb = XLSX.read(readFileSync(xlsxOrCsvPath), { type: "buffer", cellDates: true });
  const name = sheetName ?? wb.SheetNames[0] ?? "";
  const sheet = wb.Sheets[name];
  if (!sheet) {
    throw Object.assign(new Error(`Sheet not found: ${name}`), { statusCode: 400 });
  }
  const all = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false });
  return { sheet: name, rows: all.slice(0, limit), truncated: all.length > limit };
}
