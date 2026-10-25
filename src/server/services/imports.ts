import ExcelJS from "exceljs";
import { col, transaction } from "../db";
import type { AttendanceStatus, AttendanceTemplate, AttendanceTemplateVersion, BulkImportJob, BulkImportRow, Employee, ID, ISODate, ImportMode, ParsedAttendanceRow, TemplateField } from "@/lib/types";
import { addDays, diffDays, eachDay, todayInTz } from "@/lib/time";
import { conflict, forbidden, notFound, badRequest } from "../errors";
import { actorOf, can, canManage, requirePerm, type AuthContext } from "../auth/context";
import { audit } from "./audit";
import { notify } from "./notifications";
import { DayResolver } from "./days";
import { employedOn, getRegister, insertRecord, isLocked, prepareEntry, updateRecord, type PreparedEntry } from "./attendance";
import { getActiveTemplate, getVersion } from "./templates";
import { parseDateLoose, parseTimeLoose, parseUpload, toCsv, type Row } from "./tabular";
import { nowIso, sha256, stamp } from "../util";

const SAMPLE_MARK = "SAMPLE";
/** Row matches the saved record exactly — importing it would change nothing. */
export const UNCHANGED = "Identical to the saved record — nothing to change";
const BATCH = 100;
const MAX_EXPORT_DAYS = 62;
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const norm = (s: string) => s.trim().toLowerCase();

function importFields(fields: TemplateField[]) {
  return fields.filter((f) => f.visible).sort((a, b) => a.order - b.order);
}

/* --------------------------- Template download -------------------------- */

const FORMAT_HINT: Record<TemplateField["type"], string> = {
  text: "Free text",
  textarea: "Free text",
  number: "Number",
  date: "Date as YYYY-MM-DD (DD/MM/YYYY also accepted)",
  time: "24-hour time HH:mm, e.g. 09:30 or 18:05",
  datetime: "YYYY-MM-DD HH:mm",
  dropdown: "One of the allowed values",
  checkbox: "Yes / No",
  employee_ref: "Employee ID exactly as in the system, e.g. EMP0001",
  calculated: "Informational only — ignored on import",
};

export async function buildImportTemplate(ctx: AuthContext, format: "xlsx" | "csv") {
  requirePerm(ctx, "bulk_upload.export", "bulk_upload.import");
  const { template, version, fields: all } = await getActiveTemplate();
  const fields = importFields(all);
  const statuses = await (await col("attendance_statuses")).find({ active: true }, { sort: { order: 1 } });
  const yesterday = addDays(todayInTz(ctx.settings.timezone), -1);
  const sample = (code: string, name: string, status: string, inT: string, outT: string): Record<string, string> => {
    const r: Record<string, string> = {};
    for (const f of fields) {
      if (f.core === "attendance_date") r[f.importColumn] = yesterday;
      else if (f.core === "employee_code") r[f.importColumn] = code;
      else if (f.core === "employee_name") r[f.importColumn] = name;
      else if (f.core === "status") r[f.importColumn] = status;
      else if (f.core === "check_in") r[f.importColumn] = inT;
      else if (f.core === "check_out") r[f.importColumn] = outT;
      else if (f.core === "worked_hours") r[f.importColumn] = "";
      else if (f.core === "remarks") r[f.importColumn] = `${SAMPLE_MARK} ROW - delete before uploading`;
      else r[f.importColumn] = f.defaultValue;
    }
    return r;
  };
  const samples = [sample("EMP0001", "Sample Employee", "present", "09:05", "18:10"), sample("EMP0002", "Sample Employee 2", "leave", "", "")];
  const vLabel = version ? `v${version.version}` : "default";
  const baseName = `attendance-template-${(template?.name ?? "default").replace(/\W+/g, "-").toLowerCase()}-${vLabel}`;

  if (format === "csv") {
    return {
      data: toCsv(fields.map((f) => ({ key: f.importColumn, label: f.importColumn })), samples),
      filename: `${baseName}.csv`,
      contentType: "text/csv; charset=utf-8",
    };
  }
  return { data: await attendanceWorkbook(ctx, { template, version, fields, statuses, rows: [], samples }), filename: `${baseName}.xlsx`, contentType: XLSX_TYPE };
}

/** Workbook in import-template layout; `rows` pre-fill the Attendance sheet so an export can be edited and re-uploaded. */
async function attendanceWorkbook(
  ctx: AuthContext,
  o: { template: AttendanceTemplate | null; version: AttendanceTemplateVersion | null; fields: TemplateField[]; statuses: AttendanceStatus[]; rows: Row[]; samples: Record<string, string>[] },
) {
  const { template, version, fields, statuses } = o;
  const vLabel = version ? `v${version.version}` : "default";
  const wb = new ExcelJS.Workbook();
  wb.creator = "HR Attendance";
  const ws = wb.addWorksheet("Attendance");
  ws.addRow(fields.map((f) => f.importColumn));
  const hr = ws.getRow(1);
  hr.font = { bold: true, color: { argb: "FFFFFFFF" } };
  hr.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4338CA" } };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  for (const r of o.rows) ws.addRow(fields.map((f) => r[f.importColumn] ?? ""));
  const lastRow = Math.max(1001, o.rows.length + 201);

  const lists = wb.addWorksheet("Statuses");
  lists.addRow(["Code", "Label", "Category"]).font = { bold: true };
  for (const s of statuses) lists.addRow([s.code, s.label, s.category]);

  fields.forEach((f, i) => {
    const column = ws.getColumn(i + 1);
    column.width = Math.max(14, f.importColumn.length + 4);
    if (["date", "time", "datetime", "employee_ref", "text"].includes(f.type)) column.numFmt = "@";
    const letter = column.letter;
    const rule: ExcelJS.DataValidation | null =
      f.core === "status"
        ? { type: "list", allowBlank: true, formulae: [`Statuses!$A$2:$A$${statuses.length + 1}`], showErrorMessage: true, errorTitle: "Invalid status", error: "Choose a status code from the list" }
        : f.type === "dropdown" && f.options.length && f.options.join(",").length < 250
          ? { type: "list", allowBlank: f.required !== "yes", formulae: [`"${f.options.join(",")}"`], showErrorMessage: true }
          : f.type === "checkbox"
            ? { type: "list", allowBlank: true, formulae: ['"Yes,No"'] }
            : null;
    if (rule) for (let r = 2; r <= lastRow; r++) ws.getCell(`${letter}${r}`).dataValidation = rule;
  });

  const ins = wb.addWorksheet("Instructions");
  ins.getColumn(1).width = 24;
  ins.getColumn(2).width = 14;
  ins.getColumn(3).width = 14;
  ins.getColumn(4).width = 60;
  ins.addRow([`Attendance import template — ${template?.name ?? "Default"} (${vLabel})`]).font = { bold: true, size: 14 };
  ins.addRow([`Generated ${nowIso().slice(0, 16).replace("T", " ")} UTC · Time zone: ${ctx.settings.timezone}`]);
  ins.addRow([]);
  for (const line of [
    "1. Fill the 'Attendance' sheet — one row per employee per date. Do not rename or reorder the header row.",
    "2. Times are 24-hour wall-clock times in the organisation time zone.",
    "3. For overnight shifts, an exit time earlier than the entry time is treated as the next day.",
    "4. Present / Half Day require an Entry Time — or, when times are unknown, Worked Hours (e.g. 8). Never fill both.",
    "   Absent, Leave, Holiday and Weekly Off must have no times or hours.",
    "5. Leave Entry/Exit blank with status 'pending' for employees who have not checked in yet.",
    "6. Each employee may appear only once per date. Existing records are only changed in Update or Upsert mode.",
    "7. You can only upload rows for employees inside your access scope.",
    "8. Rows with no Status, times or hours are ignored, so unfilled rows of an export can stay as they are.",
  ]) ins.addRow([line]);
  ins.addRow([]);
  ins.addRow(["Column", "Type", "Required", "Format / allowed values"]).font = { bold: true };
  for (const f of fields) {
    const allowed = f.core === "status" ? statuses.map((s) => `${s.code} (${s.label})`).join(", ") : f.type === "dropdown" ? f.options.join(", ") : FORMAT_HINT[f.type];
    ins.addRow([f.importColumn, f.type, f.required === "conditional" ? "Depends on status" : f.required === "yes" ? "Yes" : "No", allowed]);
  }
  if (o.samples.length) {
    ins.addRow([]);
    ins.addRow(["Sample rows (for reference only — do not copy sample rows into the Attendance sheet)"]).font = { bold: true };
    ins.addRow(fields.map((f) => f.importColumn)).font = { bold: true };
    for (const s of o.samples) ins.addRow(fields.map((f) => s[f.importColumn]));
  }

  const meta = wb.addWorksheet("_meta");
  meta.addRow(["templateId", template?.id ?? ""]);
  meta.addRow(["templateVersionId", version?.id ?? ""]);
  meta.addRow(["templateVersion", String(version?.version ?? 0)]);
  meta.state = "veryHidden";

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* -------------------------------- Export -------------------------------- */

/** Register data for a date range in import-template columns. Days without a record get a blank Status to fill in. */
export async function exportAttendance(ctx: AuthContext, from: ISODate, to: ISODate, employees: Employee[], format: "xlsx" | "csv") {
  requirePerm(ctx, "bulk_upload.export", "reports.export");
  if (to < from) throw badRequest("The end date must be on or after the start date");
  if (diffDays(from, to) + 1 > MAX_EXPORT_DAYS) throw badRequest(`Export at most ${MAX_EXPORT_DAYS} days at a time`);
  const { template, version, fields: all } = await getActiveTemplate();
  const fields = importFields(all);
  const statuses = await (await col("attendance_statuses")).find({ active: true }, { sort: { order: 1 } });
  const records = await (await col("attendance_records")).find({ date: { $gte: from, $lte: to }, segment: 1, voided: false });
  const custom = new Map(records.map((r) => [`${r.employeeId}|${r.date}`, r.customFields ?? {}]));

  const rows: Row[] = [];
  for (const date of eachDay(from, to)) {
    const reg = await getRegister(ctx, date, employees);
    for (const r of reg.rows) {
      const cf = custom.get(`${r.employee.id}|${date}`) ?? {};
      const row: Row = {};
      for (const f of fields) {
        const v =
          f.core === "attendance_date" ? date
          : f.core === "employee_code" ? r.employee.employeeCode
          : f.core === "employee_name" ? r.employee.fullName
          : f.core === "status" ? (r.record?.statusCode ?? "")
          : f.core === "check_in" ? (r.record?.checkIn ?? "")
          : f.core === "check_out" ? (r.record?.checkOut ?? "")
          : f.core === "worked_hours" ? (r.record?.workedHours ?? "")
          : f.core === "remarks" ? (r.record?.remarks ?? "")
          : f.type === "calculated" ? ""
          : cf[f.key];
        row[f.importColumn] = typeof v === "boolean" ? (v ? "Yes" : "No") : (v ?? "");
      }
      rows.push(row);
    }
  }
  const baseName = from === to ? `attendance-${from}` : `attendance-${from}-to-${to}`;
  await audit(actorOf(ctx), { action: "export", module: "attendance", newValues: { from, to, format, rows: rows.length } });
  if (format === "csv") {
    return { data: toCsv(fields.map((f) => ({ key: f.importColumn, label: f.importColumn })), rows), filename: `${baseName}.csv`, contentType: "text/csv; charset=utf-8" };
  }
  return { data: await attendanceWorkbook(ctx, { template, version, fields, statuses, rows, samples: [] }), filename: `${baseName}.xlsx`, contentType: XLSX_TYPE };
}

/* ------------------------------ Validation ------------------------------ */

function parseCustom(f: TemplateField, raw: string): { value: unknown; error?: string } {
  const v = raw.trim();
  if (!v) return f.required === "yes" ? { value: null, error: `${f.label} is required` } : { value: f.defaultValue || null };
  switch (f.type) {
    case "number": {
      const n = Number(v);
      if (!Number.isFinite(n)) return { value: null, error: `${f.label} must be a number` };
      if (f.validation.min !== undefined && n < f.validation.min) return { value: null, error: `${f.label} must be ≥ ${f.validation.min}` };
      if (f.validation.max !== undefined && n > f.validation.max) return { value: null, error: `${f.label} must be ≤ ${f.validation.max}` };
      return { value: n };
    }
    case "date": {
      const d = parseDateLoose(v);
      return d ? { value: d } : { value: null, error: `${f.label} must be a date (YYYY-MM-DD)` };
    }
    case "time": {
      const t = parseTimeLoose(v);
      return t ? { value: t } : { value: null, error: `${f.label} must be a time (HH:mm)` };
    }
    case "datetime": {
      const d = parseDateLoose(v);
      const t = parseTimeLoose(v);
      return d && t ? { value: `${d} ${t}` } : { value: null, error: `${f.label} must be YYYY-MM-DD HH:mm` };
    }
    case "dropdown": {
      const opt = f.options.find((o) => norm(o) === norm(v));
      return opt ? { value: opt } : { value: null, error: `${f.label} must be one of: ${f.options.join(", ")}` };
    }
    case "checkbox": {
      if (["yes", "y", "true", "1"].includes(norm(v))) return { value: true };
      if (["no", "n", "false", "0"].includes(norm(v))) return { value: false };
      return { value: null, error: `${f.label} must be Yes or No` };
    }
    default: {
      if (f.validation.maxLength && v.length > f.validation.maxLength) return { value: null, error: `${f.label} exceeds ${f.validation.maxLength} characters` };
      if (f.validation.pattern && !new RegExp(f.validation.pattern).test(v)) return { value: null, error: `${f.label} has an invalid format` };
      return { value: v };
    }
  }
}

function matchStatus(raw: string, statuses: AttendanceStatus[]) {
  const v = norm(raw);
  return statuses.find((s) => s.active && (norm(s.code) === v || norm(s.label) === v || norm(s.label.split("/")[0]) === v));
}

export async function uploadAttendanceFile(ctx: AuthContext, file: { name: string; bytes: Buffer }, opts: { previousJobId?: ID | null } = {}) {
  requirePerm(ctx, "bulk_upload.import");
  const parsed = await parseUpload(file.name, file.bytes, "Attendance");
  const { template, version, fields: allFields } = await getActiveTemplate();
  if (!template || !version) throw badRequest("No active attendance template. Ask an administrator to activate one.");
  const fields = importFields(allFields);
  const headerErrors: string[] = [];
  const headerWarnings: string[] = [];

  // Template version check (xlsx files carry the version they were generated from).
  if (parsed.meta.templateVersionId && parsed.meta.templateVersionId !== version.id) {
    const old = await getVersion(parsed.meta.templateVersionId);
    headerWarnings.push(
      old
        ? `Template version mismatch: file was generated from "${old.name}" v${old.version}; active is "${template.name}" v${version.version}. Columns were validated against the active version.`
        : `Template version mismatch: file references an unknown template version; validated against "${template.name}" v${version.version}.`,
    );
  }

  const headerIndex = new Map(parsed.headers.map((h) => [norm(h), h]));
  const colOf = (f: TemplateField) => headerIndex.get(norm(f.importColumn));
  for (const f of fields) {
    const needed = f.required === "yes" || f.core === "check_in" || f.core === "check_out";
    if (needed && f.type !== "calculated" && !colOf(f)) headerErrors.push(`Missing required column "${f.importColumn}"`);
  }
  const known = new Set(fields.map((f) => norm(f.importColumn)));
  for (const h of parsed.headers) if (!known.has(norm(h))) headerWarnings.push(`Unknown column "${h}" will be ignored`);

  const hash = sha256(file.bytes);
  const jobs = await col("bulk_import_jobs");
  const prior = await jobs.findOne({ fileHash: hash, status: { $in: ["completed", "partially_completed"] } });
  if (prior) headerWarnings.push(`This exact file was already imported on ${prior.completedAt?.slice(0, 10)} (upload ${prior.id.slice(0, 8)}).`);

  const job: BulkImportJob = {
    ...stamp(),
    fileName: file.name.slice(0, 200),
    fileHash: hash,
    fileType: parsed.fileType,
    uploadedBy: ctx.user.id,
    templateId: template.id,
    templateVersionId: version.id,
    templateVersion: version.version,
    status: "validated",
    mode: null,
    headerErrors,
    headerWarnings,
    totals: { total: parsed.rows.length, valid: 0, invalid: 0, duplicate: 0, conflicts: 0, warnings: 0 },
    results: { inserted: 0, updated: 0, skipped: 0, failed: 0 },
    startedAt: null,
    completedAt: null,
    previousJobId: opts.previousJobId ?? null,
  };

  const rows: BulkImportRow[] = [];
  if (!headerErrors.length) {
    const fieldBy = (core: string) => fields.find((f) => f.core === core);
    const get = (values: Record<string, string>, core: string) => {
      const f = fieldBy(core);
      const h = f && colOf(f);
      return h ? (values[h] ?? "").trim() : "";
    };
    const employees = await (await col("employees")).find();
    const byCode = new Map(employees.map((e) => [e.employeeCode.toUpperCase(), e]));
    const statuses = await (await col("attendance_statuses")).find();
    const dates = parsed.rows.map((r) => parseDateLoose(get(r.values, "attendance_date"))).filter((d): d is string => !!d).sort();
    const from = dates[0] ?? todayInTz(ctx.settings.timezone);
    const to = dates[dates.length - 1] ?? from;
    const resolver = await DayResolver.load("all", from, addDays(to, 1));
    const seen = new Map<string, number>();
    const unchangedRows = new Set<number>();
    // Unfilled rows (e.g. from an export) carry only date/employee — nothing to import.
    const filled = parsed.rows.filter((r) => ["status", "check_in", "check_out", "worked_hours"].some((c) => get(r.values, c)));
    if (filled.length < parsed.rows.length) headerWarnings.push(`${parsed.rows.length - filled.length} row(s) with no Status, times or hours were ignored`);

    for (const r of filled) {
      const errors: string[] = [];
      const warnings: string[] = [];
      const remarks = get(r.values, "remarks");
      if (remarks.toUpperCase().startsWith(SAMPLE_MARK)) errors.push("Sample row from the template — delete it before uploading");

      const rawDate = get(r.values, "attendance_date");
      const date = parseDateLoose(rawDate);
      if (!rawDate) errors.push("Attendance Date is required");
      else if (!date) errors.push(`Invalid date "${rawDate}" — use YYYY-MM-DD`);

      const code = get(r.values, "employee_code").toUpperCase();
      let emp: Employee | undefined;
      if (!code) errors.push("Employee ID is required");
      else {
        emp = byCode.get(code);
        if (!emp) errors.push(`Unknown Employee ID "${code}"`);
        else if (!canManage(ctx, emp.id)) {
          errors.push(`Employee ${code} is outside your access scope`);
          emp = undefined;
        } else if (date) {
          const e = employedOn(emp, date);
          if (e) errors.push(e);
        }
      }
      const name = get(r.values, "employee_name");
      if (emp && name && norm(name) !== norm(emp.fullName)) warnings.push(`Name "${name}" differs from system name "${emp.fullName}"`);

      const rawStatus = get(r.values, "status");
      const status = rawStatus ? matchStatus(rawStatus, statuses) : undefined;
      if (!rawStatus) errors.push("Status is required");
      else if (!status) errors.push(`Unknown status "${rawStatus}". Allowed: ${statuses.filter((s) => s.active).map((s) => s.code).join(", ")}`);

      const rawIn = get(r.values, "check_in");
      const rawOut = get(r.values, "check_out");
      const tIn = rawIn ? parseTimeLoose(rawIn) : null;
      const tOut = rawOut ? parseTimeLoose(rawOut) : null;
      if (rawIn && !tIn) errors.push(`Invalid entry time "${rawIn}" — use HH:mm`);
      if (rawOut && !tOut) errors.push(`Invalid exit time "${rawOut}" — use HH:mm`);
      const rawHours = get(r.values, "worked_hours");
      const hours = rawHours ? Number(rawHours) : null;
      if (rawHours && (!Number.isFinite(hours) || hours! < 0 || hours! > 24)) errors.push(`Invalid worked hours "${rawHours}" — use a number from 0 to 24`);

      const customFields: Record<string, unknown> = {};
      for (const f of fields.filter((x) => !x.core && x.type !== "calculated")) {
        const h = colOf(f);
        const res = parseCustom(f, h ? (r.values[h] ?? "") : "");
        if (res.error) errors.push(res.error);
        else if (res.value !== null) customFields[f.key] = res.value;
      }

      let prepared: PreparedEntry | null = null;
      if (!errors.length && emp && date && status) {
        if (isLocked(date, ctx) && !can(ctx, "attendance.manage")) errors.push(`Attendance for ${date} is locked`);
        const res = prepareEntry(ctx, emp, date, { statusCode: status.code, checkIn: tIn, checkOut: tOut, workedHours: hours }, resolver);
        if (!res.value) errors.push(...Object.values(res.errors));
        prepared = res.value;
      }

      let rowStatus: BulkImportRow["status"] = errors.length ? "invalid" : "valid";
      let existingRecordId: ID | null = null;
      if (emp && date) {
        const key = `${emp.id}|${date}`;
        const first = seen.get(key);
        if (first !== undefined) {
          errors.push(`Duplicate of row ${first} (same employee and date)`);
          rowStatus = "duplicate";
        } else seen.set(key, r.rowNumber);
        const existing = resolver.record(emp.id, date);
        if (existing && rowStatus === "valid") {
          rowStatus = "conflict";
          existingRecordId = existing.id;
          const same =
            !!prepared &&
            existing.statusCode === prepared.statusCode &&
            existing.checkInAt === prepared.checkInAt &&
            existing.checkOutAt === prepared.checkOutAt &&
            (existing.reportedMinutes ?? null) === (prepared.reportedMinutes ?? null) &&
            existing.remarks === remarks &&
            JSON.stringify(existing.customFields ?? {}) === JSON.stringify(customFields);
          if (same) {
            unchangedRows.add(r.rowNumber);
            warnings.push(UNCHANGED);
          } else warnings.push("A record already exists — it will be updated only in Update or Upsert mode");
        }
      }

      const parsedRow: ParsedAttendanceRow | null =
        prepared && emp && date
          ? { employeeId: emp.id, employeeCode: emp.employeeCode, date, statusCode: prepared.statusCode, checkInAt: prepared.checkInAt, checkOutAt: prepared.checkOutAt, reportedMinutes: prepared.reportedMinutes, remarks, customFields }
          : null;
      rows.push({
        ...stamp(),
        jobId: job.id,
        rowNumber: r.rowNumber,
        raw: r.values,
        parsed: parsedRow,
        errors,
        warnings,
        status: rowStatus,
        existingRecordId,
        outcome: null,
        outcomeMessage: "",
        processedAt: null,
      });
    }
    job.totals = {
      total: rows.length,
      valid: rows.filter((x) => x.status === "valid" || x.status === "conflict").length,
      invalid: rows.filter((x) => x.status === "invalid").length,
      duplicate: rows.filter((x) => x.status === "duplicate").length,
      conflicts: rows.filter((x) => x.status === "conflict").length,
      unchanged: unchangedRows.size,
      warnings: rows.filter((x) => x.warnings.length).length,
    };
  }

  await transaction(async () => {
    await jobs.insertOne(job);
    if (rows.length) await (await col("bulk_import_rows")).insertMany(rows);
    await audit(actorOf(ctx), { action: "upload_validated", module: "bulk_upload", recordId: job.id, importId: job.id, newValues: { fileName: job.fileName, totals: job.totals, headerErrors } });
  });
  return job;
}

/* ------------------------------- Jobs read ------------------------------ */

function assertJobAccess(ctx: AuthContext, job: BulkImportJob) {
  if (job.uploadedBy !== ctx.user.id && !ctx.scope.all) throw forbidden("You can only view your own uploads");
}

export async function getImportJob(ctx: AuthContext, id: ID, q: { status?: string; page?: number; pageSize?: number } = {}) {
  requirePerm(ctx, "bulk_upload.view", "bulk_upload.import");
  const job = await (await col("bulk_import_jobs")).findById(id);
  if (!job) throw notFound("Upload");
  assertJobAccess(ctx, job);
  const rowsCol = await col("bulk_import_rows");
  const filter: Record<string, unknown> = { jobId: id };
  if (q.status === "errors") filter.status = { $in: ["invalid", "duplicate"] };
  else if (q.status === "failed") filter.outcome = { $in: ["failed", "skipped"] };
  else if (q.status) filter.status = q.status;
  const total = await rowsCol.count(filter as never);
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? 50;
  const rows = await rowsCol.find(filter as never, { sort: { rowNumber: 1 }, skip: (page - 1) * pageSize, limit: pageSize });
  const user = await (await col("users")).findById(job.uploadedBy);
  return { job: { ...job, uploadedByName: user?.displayName ?? "—" }, rows, total, page, pageSize };
}

export async function listImportJobs(ctx: AuthContext, limit = 100) {
  requirePerm(ctx, "bulk_upload.view", "bulk_upload.import");
  const jobs = await (await col("bulk_import_jobs")).find(ctx.scope.all ? {} : { uploadedBy: ctx.user.id }, { sort: { createdAt: -1 }, limit });
  const users = new Map((await (await col("users")).find()).map((u) => [u.id, u.displayName]));
  return jobs.map((j) => ({ ...j, uploadedByName: users.get(j.uploadedBy) ?? "—" }));
}

/* -------------------------------- Commit -------------------------------- */

export async function commitImport(ctx: AuthContext, id: ID, mode: ImportMode) {
  requirePerm(ctx, "bulk_upload.import");
  if (mode !== "update") requirePerm(ctx, "attendance.create");
  if (mode !== "insert") requirePerm(ctx, "attendance.edit");
  const jobs = await col("bulk_import_jobs");
  const rowsCol = await col("bulk_import_rows");

  // Claim the job atomically (idempotent: finished jobs return their stored result).
  const claimed = await transaction(async () => {
    const job = await jobs.findById(id);
    if (!job) throw notFound("Upload");
    assertJobAccess(ctx, job);
    if (job.headerErrors.length) throw badRequest("Fix the column errors and upload the file again");
    if (["completed", "partially_completed", "failed"].includes(job.status)) return { job, fresh: false };
    if (job.status === "cancelled") throw conflict("This upload was cancelled");
    if (job.status === "processing") {
      const stale = job.startedAt && Date.now() - new Date(job.startedAt).getTime() > 10 * 60_000;
      if (!stale) throw conflict("This upload is already being processed");
      if (job.mode !== mode) throw conflict(`Resume with the original mode "${job.mode}"`);
    }
    const saved = (await jobs.updateById(id, { status: "processing", mode, startedAt: job.startedAt ?? nowIso(), updatedAt: nowIso() }))!;
    return { job: saved, fresh: true };
  });
  if (!claimed.fresh) return claimed.job;
  const job = claimed.job;

  const rows = await rowsCol.find({ jobId: id }, { sort: { rowNumber: 1 } });
  const parsedRows = rows.filter((r) => r.parsed);
  const dates = parsedRows.map((r) => r.parsed!.date).sort();
  const employees = new Map((await (await col("employees")).find()).map((e) => [e.id, e]));
  const resolver = dates.length ? await DayResolver.load("all", dates[0], addDays(dates[dates.length - 1], 1)) : null;
  const records = await col("attendance_records");

  try {
    for (let i = 0; i < rows.length; i += BATCH) {
      await transaction(async () => {
        for (const row of rows.slice(i, i + BATCH)) {
          if (row.outcome) continue; // already processed in an earlier (interrupted) attempt
          let outcome: BulkImportRow["outcome"] = "failed";
          let message = "";
          try {
            if (row.status === "invalid" || row.status === "duplicate" || !row.parsed || !resolver) {
              message = row.errors.join("; ") || "Invalid row";
            } else {
              const p = row.parsed;
              const emp = employees.get(p.employeeId);
              if (!emp || !canManage(ctx, emp.id)) throw forbidden("Employee outside your access scope");
              if (isLocked(p.date, ctx) && !can(ctx, "attendance.manage")) throw forbidden(`Attendance for ${p.date} is locked`);
              const existing = await records.findOne({ employeeId: emp.id, date: p.date, segment: 1, voided: false });
              const status = resolver.statuses.get(p.statusCode);
              const value: PreparedEntry = {
                statusCode: p.statusCode,
                category: status?.category ?? "pending",
                checkInAt: p.checkInAt,
                checkOutAt: p.checkOutAt,
                reportedMinutes: p.reportedMinutes ?? null,
                shiftId: resolver.shiftFor(emp, p.date)?.id ?? null,
              };
              const meta = { source: "import" as const, remarks: p.remarks, customFields: p.customFields, importJobId: id, templateVersionId: job.templateVersionId, quiet: true };
              if (existing && mode === "insert") {
                outcome = "skipped";
                message = "Record already exists (insert-only mode)";
              } else if (!existing && mode === "update") {
                outcome = "skipped";
                message = "No existing record to update (update-only mode)";
              } else if (existing) {
                const saved = await updateRecord(ctx, existing, value, meta);
                outcome = saved === existing ? "skipped" : "updated";
                message = saved === existing ? "Already up to date — matches the saved record" : "";
              } else {
                await insertRecord(ctx, emp, p.date, value, meta);
                outcome = "inserted";
              }
            }
          } catch (e) {
            outcome = "failed";
            message = e instanceof Error ? e.message : "Unexpected error";
          }
          await rowsCol.updateById(row.id, { outcome, outcomeMessage: message, processedAt: nowIso(), updatedAt: nowIso() });
        }
      });
    }
  } catch (e) {
    await jobs.updateById(id, { status: "failed", completedAt: nowIso(), updatedAt: nowIso() });
    await notify([job.uploadedBy], { type: "import_failed", title: "Bulk upload failed", message: `${job.fileName} could not be processed.`, link: `/bulk-upload/${id}` });
    throw e;
  }

  const final = await rowsCol.find({ jobId: id });
  const results = {
    inserted: final.filter((r) => r.outcome === "inserted").length,
    updated: final.filter((r) => r.outcome === "updated").length,
    skipped: final.filter((r) => r.outcome === "skipped").length,
    failed: final.filter((r) => r.outcome === "failed").length,
  };
  const ok = results.inserted + results.updated;
  const status: BulkImportJob["status"] = results.failed === 0 ? "completed" : ok > 0 ? "partially_completed" : "failed";
  const saved = (await jobs.updateById(id, { status, results, completedAt: nowIso(), updatedAt: nowIso() }))!;
  await audit(actorOf(ctx), { action: "bulk_import", module: "bulk_upload", recordId: id, importId: id, newValues: { fileName: job.fileName, mode, ...results } });
  await notify([job.uploadedBy], {
    type: status === "failed" ? "import_failed" : "import_completed",
    title: status === "failed" ? "Bulk upload failed" : "Bulk upload completed",
    message: `${job.fileName}: ${results.inserted} inserted, ${results.updated} updated, ${results.skipped} skipped, ${results.failed} failed.`,
    link: `/bulk-upload/${id}`,
  });
  return saved;
}

export async function cancelImport(ctx: AuthContext, id: ID) {
  requirePerm(ctx, "bulk_upload.import");
  const jobs = await col("bulk_import_jobs");
  const job = await jobs.findById(id);
  if (!job) throw notFound("Upload");
  assertJobAccess(ctx, job);
  if (job.status !== "validated") throw conflict("Only uploads that have not been processed can be cancelled");
  await audit(actorOf(ctx), { action: "upload_cancelled", module: "bulk_upload", recordId: id, importId: id });
  return jobs.updateById(id, { status: "cancelled", updatedAt: nowIso() });
}

/** CSV of the problem rows in template format plus Row/Error columns — fix and re-upload. */
export async function importErrorFile(ctx: AuthContext, id: ID) {
  const { job } = await getImportJob(ctx, id, { pageSize: 1 });
  const rows = await (await col("bulk_import_rows")).find({ jobId: id }, { sort: { rowNumber: 1 } });
  const problem = rows.filter((r) => (r.outcome ? r.outcome === "failed" || r.outcome === "skipped" : r.status === "invalid" || r.status === "duplicate"));
  const version = await getVersion(job.templateVersionId);
  const headers = version ? importFields(version.fields).map((f) => f.importColumn) : Object.keys(problem[0]?.raw ?? {});
  const columns = [...headers.map((h) => ({ key: h, label: h })), { key: "__row", label: "Source Row" }, { key: "__error", label: "Error" }];
  const data = problem.map((r) => ({ ...r.raw, __row: r.rowNumber, __error: r.outcomeMessage || r.errors.join("; ") }));
  return { data: toCsv(columns, data), filename: `upload-${id.slice(0, 8)}-errors.csv`, contentType: "text/csv; charset=utf-8" };
}
