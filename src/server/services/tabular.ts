import ExcelJS from "exceljs";
import Papa from "papaparse";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { badRequest } from "../errors";

export interface Column {
  key: string;
  label: string;
  width?: number;
}
export type Row = Record<string, unknown>;

/* ------------------------------- Writers ------------------------------- */

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

/** Neutralise spreadsheet formula injection in exported text. */
function safe(s: string): string {
  return /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
}

export function toCsv(columns: Column[], rows: Row[]): string {
  const data = rows.map((r) => columns.map((c) => safe(cellText(r[c.key]))));
  return "﻿" + Papa.unparse({ fields: columns.map((c) => c.label), data }, { newline: "\r\n" });
}

export interface SheetSpec {
  name: string;
  columns: Column[];
  rows: Row[];
  title?: string;
}

export async function toXlsx(sheets: SheetSpec[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "HR Attendance";
  wb.created = new Date();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name.slice(0, 31));
    let headerRow = 1;
    if (s.title) {
      ws.addRow([s.title]).font = { bold: true, size: 13 };
      ws.addRow([]);
      headerRow = 3;
    }
    ws.addRow(s.columns.map((c) => c.label));
    const hr = ws.getRow(headerRow);
    hr.font = { bold: true, color: { argb: "FFFFFFFF" } };
    hr.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4338CA" } };
    for (const r of s.rows) {
      ws.addRow(
        s.columns.map((c) => {
          const v = r[c.key];
          return typeof v === "number" ? v : cellText(v);
        }),
      );
    }
    s.columns.forEach((c, i) => {
      ws.getColumn(i + 1).width = c.width ?? Math.min(40, Math.max(10, c.label.length + 2));
    });
    ws.views = [{ state: "frozen", ySplit: headerRow }];
    ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: s.columns.length } };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const PDF_SAFE = /[^\x20-\x7E -ÿ–—‘’“”•…]/g;
const pdfText = (s: string) => s.replace(PDF_SAFE, "?");

function fit(font: PDFFont, text: string, size: number, width: number): string {
  let t = pdfText(text);
  if (font.widthOfTextAtSize(t, size) <= width) return t;
  while (t.length > 1 && font.widthOfTextAtSize(t + "…", size) > width) t = t.slice(0, -1);
  return t + "…";
}

export interface PdfSpec {
  title: string;
  subtitle?: string;
  summary?: { label: string; value: string }[];
  columns: Column[];
  rows: Row[];
}

/** Landscape A4 table report with repeating headers and page numbers. */
export async function toPdf(spec: PdfSpec): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 842;
  const H = 595;
  const M = 32;
  const size = 8;
  const rowH = 15;
  const usable = W - M * 2;

  // Column widths proportional to content length (sampled), clamped.
  const weights = spec.columns.map((c) => {
    const sample = spec.rows.slice(0, 200).map((r) => cellText(r[c.key]).length);
    const avg = sample.length ? sample.reduce((a, b) => a + b, 0) / sample.length : 0;
    return Math.min(30, Math.max(c.label.length * 0.8, avg, 4));
  });
  const total = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (w / total) * usable);

  let page = doc.addPage([W, H]);
  let y = H - M;
  const pages = [page];

  const drawHeader = () => {
    page.drawRectangle({ x: M, y: y - rowH + 4, width: usable, height: rowH, color: rgb(0.263, 0.22, 0.792) });
    let x = M;
    spec.columns.forEach((c, i) => {
      page.drawText(fit(bold, c.label, size, widths[i] - 6), { x: x + 3, y: y - 7, size, font: bold, color: rgb(1, 1, 1) });
      x += widths[i];
    });
    y -= rowH;
  };

  page.drawText(pdfText(spec.title), { x: M, y: y - 14, size: 16, font: bold, color: rgb(0.1, 0.1, 0.18) });
  y -= 22;
  if (spec.subtitle) {
    page.drawText(fit(font, spec.subtitle, 9, usable), { x: M, y: y - 10, size: 9, font, color: rgb(0.35, 0.38, 0.45) });
    y -= 16;
  }
  page.drawText(pdfText(`Generated ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC`), { x: M, y: y - 10, size: 8, font, color: rgb(0.45, 0.48, 0.55) });
  y -= 20;
  if (spec.summary?.length) {
    const per = 6;
    const cw = usable / per;
    spec.summary.forEach((s, i) => {
      const cx = M + (i % per) * cw;
      if (i > 0 && i % per === 0) y -= 30;
      page.drawText(fit(font, s.label, 7, cw - 6), { x: cx, y: y - 8, size: 7, font, color: rgb(0.4, 0.43, 0.5) });
      page.drawText(fit(bold, s.value, 11, cw - 6), { x: cx, y: y - 22, size: 11, font: bold, color: rgb(0.1, 0.1, 0.18) });
    });
    y -= 36;
  }
  drawHeader();
  spec.rows.forEach((r, ri) => {
    if (y - rowH < M + 10) {
      page = doc.addPage([W, H]);
      pages.push(page);
      y = H - M;
      drawHeader();
    }
    if (ri % 2 === 1) page.drawRectangle({ x: M, y: y - rowH + 4, width: usable, height: rowH, color: rgb(0.96, 0.97, 0.98) });
    let x = M;
    spec.columns.forEach((c, i) => {
      page.drawText(fit(font, cellText(r[c.key]), size, widths[i] - 6), { x: x + 3, y: y - 7, size, font, color: rgb(0.12, 0.14, 0.2) });
      x += widths[i];
    });
    y -= rowH;
  });
  if (!spec.rows.length) page.drawText("No records match the selected filters.", { x: M, y: y - 12, size: 9, font, color: rgb(0.4, 0.4, 0.45) });
  pages.forEach((p, i) => p.drawText(`Page ${i + 1} of ${pages.length}`, { x: W - M - 60, y: 16, size: 7, font, color: rgb(0.5, 0.5, 0.55) }));
  return Buffer.from(await doc.save());
}

/* ------------------------------- Readers ------------------------------- */

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 5000;

export interface ParsedSheet {
  headers: string[];
  rows: { rowNumber: number; values: Record<string, string> }[];
  meta: Record<string, string>;
  fileType: "xlsx" | "csv";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Normalises any ExcelJS cell value into the text a user would see. */
export function cellToString(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    if (v.getUTCFullYear() < 1901) return `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`;
    const date = `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
    return v.getUTCHours() || v.getUTCMinutes() ? `${date} ${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}` : date;
  }
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("result" in v) return cellToString((v.result ?? "") as ExcelJS.CellValue);
    if ("text" in v) return String(v.text);
    if ("error" in v) return "";
  }
  return String(v).trim();
}

export function detectType(fileName: string, bytes: Buffer): "xlsx" | "csv" {
  const ext = fileName.toLowerCase().split(".").pop();
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (ext === "xlsx") {
    if (!isZip) throw badRequest("The file has an .xlsx extension but is not a valid Excel workbook");
    return "xlsx";
  }
  if (ext === "csv") {
    if (isZip || bytes.subarray(0, 4096).includes(0)) throw badRequest("The file has a .csv extension but contains binary data");
    return "csv";
  }
  throw badRequest("Unsupported file type. Upload an .xlsx or .csv file.");
}

export async function parseUpload(fileName: string, bytes: Buffer, preferredSheet?: string): Promise<ParsedSheet> {
  if (bytes.length === 0) throw badRequest("The file is empty");
  if (bytes.length > MAX_UPLOAD_BYTES) throw badRequest(`File exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  const type = detectType(fileName, bytes);
  if (type === "csv") {
    const text = bytes.toString("utf8").replace(/^﻿/, "");
    const res = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });
    const [head, ...body] = res.data;
    if (!head) throw badRequest("The file has no header row");
    if (body.length > MAX_ROWS) throw badRequest(`Too many rows (max ${MAX_ROWS})`);
    const headers = head.map((h) => h.trim());
    return {
      headers,
      rows: body.map((cells, i) => ({ rowNumber: i + 2, values: Object.fromEntries(headers.map((h, j) => [h, (cells[j] ?? "").trim()])) })),
      meta: {},
      fileType: "csv",
    };
  }
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  } catch {
    throw badRequest("Could not read the Excel workbook. Re-save it as .xlsx and try again.");
  }
  const meta: Record<string, string> = {};
  const metaSheet = wb.getWorksheet("_meta");
  metaSheet?.eachRow((row) => {
    const k = cellToString(row.getCell(1).value);
    if (k) meta[k] = cellToString(row.getCell(2).value);
  });
  const ws =
    (preferredSheet && wb.getWorksheet(preferredSheet)) ||
    wb.worksheets.find((w) => w.state === "visible" && !["Instructions", "Statuses", "Lists", "_meta"].includes(w.name)) ||
    wb.worksheets[0];
  if (!ws) throw badRequest("The workbook has no worksheets");
  const headerCells = ws.getRow(1);
  const headers: string[] = [];
  headerCells.eachCell({ includeEmpty: true }, (c, col) => (headers[col - 1] = cellToString(c.value)));
  if (!headers.some(Boolean)) throw badRequest("The first row of the sheet must contain column headers");
  const rows: ParsedSheet["rows"] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const values: Record<string, string> = {};
    let any = false;
    headers.forEach((h, i) => {
      if (!h) return;
      const s = cellToString(row.getCell(i + 1).value);
      if (s) any = true;
      values[h] = s;
    });
    if (any) rows.push({ rowNumber, values });
  });
  if (rows.length > MAX_ROWS) throw badRequest(`Too many rows (max ${MAX_ROWS})`);
  return { headers: headers.filter(Boolean), rows, meta, fileType: "xlsx" };
}

/* ------------------------- Loose value parsing ------------------------- */

const validYmd = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

/** Accepts YYYY-MM-DD, YYYY/MM/DD, DD-MM-YYYY, DD/MM/YYYY, DD.MM.YYYY and Excel serial numbers. */
export function parseDateLoose(input: string): string | null {
  const s = input.trim().split(/[ T]/)[0];
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m && validYmd(+m[1], +m[2], +m[3])) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m && validYmd(+m[3], +m[2], +m[1])) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`;
  if (/^\d{5}$/.test(s)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  return null;
}

/** Accepts HH:mm, H:mm, HH:mm:ss, h:mm AM/PM, "YYYY-MM-DD HH:mm" and Excel day fractions. */
export function parseTimeLoose(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  const dt = /^\d{4}-\d{2}-\d{2}[ T](\d{1,2}:\d{2}(?::\d{2})?)/.exec(s);
  if (dt) s = dt[1];
  const m = /^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/.exec(s);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2]);
    const ap = m[3]?.toLowerCase();
    if (ap) {
      if (h < 1 || h > 12) return null;
      if (ap === "pm" && h !== 12) h += 12;
      if (ap === "am" && h === 12) h = 0;
    }
    if (h > 23 || min > 59) return null;
    return `${pad(h)}:${pad(min)}`;
  }
  if (/^0?\.\d+$/.test(s)) {
    const total = Math.round(Number(s) * 1440);
    if (total >= 1440) return null;
    return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
  }
  return null;
}
