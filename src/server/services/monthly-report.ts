import ExcelJS from "exceljs";
import type { DayResult, Employee, ISODate } from "@/lib/types";
import type { ReportFilter } from "@/lib/schemas";
import { summarize, type Summary } from "@/lib/kpi";
import { EMPLOYMENT_STATUS_LABELS, EMPLOYMENT_TYPE_LABELS } from "@/lib/constants";
import { dateInTz, daysInMonth, dayOfWeek, eachDay, formatDisplayDate, MONTH_NAMES, monthRange, timeInTz, todayInTz, WEEKDAY_NAMES } from "@/lib/time";
import { AppError } from "../errors";
import { can, requirePerm, type AuthContext } from "../auth/context";
import { scopedEmployees } from "./employees";
import { DayResolver } from "./days";
import { loadLookups, nameOf, empName, type Lookups } from "./lookups";

/**
 * Monthly attendance pivot: one employee per row, one column per day of the month.
 *
 * Every day is classified by the shared DayResolver (the same policy as the dashboard,
 * register and reports), so this export introduces no rules of its own:
 *  - Daily cells show the resolved status code; late arrivals keep their status (P/LT, HD/LT).
 *  - Totals count exactly the codes in the daily cells. Days not finalised yet resolve to
 *    Pending ("—") and count nowhere, so no absence is assumed for them.
 *  - Attendance % is the existing formula: credit days ÷ scheduled days (see lib/kpi summarize).
 *  - Expected Working Days = days in the employment window that are not weekly offs or holidays.
 */

export const DAY_CODES = {
  present: "P",
  absent: "A",
  leave: "L",
  half_day: "HD",
  weekly_off: "WO",
  holiday: "H",
  not_employed: "NA",
  pending: "—",
} as const;
export const LATE_CODE = "LT";

/** Daily cell text for a resolved day. */
export function dayCode(d: DayResult): string {
  const base = DAY_CODES[d.category as keyof typeof DAY_CODES] ?? DAY_CODES.pending;
  return d.isLate && (d.category === "present" || d.category === "half_day") ? `${base}/${LATE_CODE}` : base;
}

export interface MonthlyTotals {
  present: number;
  absent: number;
  leave: number;
  weeklyOff: number;
  holiday: number;
  halfDay: number;
  late: number;
  workedHours: number;
  expectedWorkingDays: number;
  attendancePct: number;
}

export interface MonthlyEmployeeRow {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  designation: string;
  department: string;
  workSite: string;
  supervisor: string;
  dateOfJoining: ISODate;
  cells: string[];
  totals: MonthlyTotals;
}

export interface MonthlyAttendanceData {
  year: number;
  month: number;
  label: string;
  from: ISODate;
  to: ISODate;
  today: ISODate;
  dates: ISODate[];
  rows: MonthlyEmployeeRow[];
  departments: ({ department: string; employees: number } & MonthlyTotals)[];
  overall: { employees: number } & MonthlyTotals;
  filterText: string;
  organizationName: string;
  timezone: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function totalsOf(counted: Summary, expectedWorkingDays: number): MonthlyTotals {
  return {
    present: counted.present,
    absent: counted.absent,
    leave: counted.leave,
    weeklyOff: counted.weeklyOff,
    holiday: counted.holiday,
    halfDay: counted.halfDay,
    late: counted.late,
    workedHours: round2(counted.totalWorkedMinutes / 60),
    expectedWorkingDays,
    attendancePct: counted.attendancePct,
  };
}

const isExpectedWorkDay = (d: DayResult) => d.category !== "not_employed" && d.category !== "holiday" && d.category !== "weekly_off";

/** Pure pivot over resolved days; `daysByEmployee` holds every date of the month for each employee. */
export function buildMonthlyRows(employees: Employee[], daysByEmployee: Map<string, DayResult[]>, l: Lookups) {
  const rows: MonthlyEmployeeRow[] = [];
  const countedByEmployee = new Map<string, DayResult[]>();
  for (const e of employees) {
    const days = daysByEmployee.get(e.id) ?? [];
    if (!days.some((d) => d.category !== "not_employed")) continue; // not employed at all this month
    const counted = days.filter((d) => d.category !== "not_employed");
    countedByEmployee.set(e.id, counted);
    rows.push({
      employeeId: e.id,
      employeeCode: e.employeeCode,
      employeeName: e.fullName,
      designation: nameOf(l.designations, e.designationId),
      department: nameOf(l.departments, e.departmentId),
      workSite: nameOf(l.locations, e.officeLocationId),
      supervisor: empName(l, e.supervisorEmployeeId),
      dateOfJoining: e.dateOfJoining,
      cells: days.map(dayCode),
      totals: totalsOf(summarize(counted), days.filter(isExpectedWorkDay).length),
    });
  }

  const group = (list: MonthlyEmployeeRow[]) => {
    const counted = list.flatMap((r) => countedByEmployee.get(r.employeeId) ?? []);
    return { employees: list.length, ...totalsOf(summarize(counted), list.reduce((n, r) => n + r.totals.expectedWorkingDays, 0)) };
  };
  const byDept = new Map<string, MonthlyEmployeeRow[]>();
  for (const r of rows) byDept.set(r.department, [...(byDept.get(r.department) ?? []), r]);
  const departments = [...byDept].sort(([a], [b]) => a.localeCompare(b)).map(([department, list]) => ({ department, ...group(list) }));
  return { rows, departments, overall: group(rows) };
}

function describeFilters(f: Partial<ReportFilter>, l: Lookups): string {
  const names = (ids: string[] | undefined, m: Map<string, string>) => ids?.map((id) => m.get(id) ?? id).join(", ");
  const parts = [
    ["Department", names(f.departmentIds, l.departments)],
    ["Designation", names(f.designationIds, l.designations)],
    ["Work Site", names(f.officeLocationIds, l.locations)],
    ["Supervisor", f.supervisorIds?.map((id) => empName(l, id)).join(", ")],
    ["Employment Type", f.employmentTypes?.map((t) => EMPLOYMENT_TYPE_LABELS[t]).join(", ")],
    ["Employee Status", f.employmentStatuses?.map((s) => EMPLOYMENT_STATUS_LABELS[s]).join(", ")],
    ["Search", f.search],
  ].filter(([, v]) => v);
  return parts.length ? parts.map(([k, v]) => `${k}: ${v}`).join(" · ") : "All authorised employees";
}

/** Read-only: resolves every employee-day of the month; never writes attendance. */
export async function monthlyAttendanceData(ctx: AuthContext, year: number, month: number, filter: Partial<ReportFilter>): Promise<MonthlyAttendanceData> {
  requirePerm(ctx, "reports.view", "attendance.view");
  const tz = ctx.settings.timezone;
  const today = todayInTz(tz);
  const { from, to } = monthRange(year, month);
  const dates = eachDay(from, to);
  const employees = await scopedEmployees(ctx, filter, can(ctx, "reports.view") ? "reports.view" : "attendance.view");
  const l = await loadLookups();
  const daysByEmployee = new Map<string, DayResult[]>();
  if (employees.length) {
    // Large selections load everything once instead of sending a huge $in list.
    const resolver = await DayResolver.load(employees.length > 500 ? "all" : employees.map((e) => e.id), from, to);
    for (const e of employees) daysByEmployee.set(e.id, dates.map((d) => resolver.resolve(e, d)));
  }
  const { rows, departments, overall } = buildMonthlyRows(employees, daysByEmployee, l);
  return {
    year,
    month,
    label: `${MONTH_NAMES[month - 1]} ${year}`,
    from,
    to,
    today,
    dates,
    rows,
    departments,
    overall,
    filterText: describeFilters(filter, l),
    organizationName: ctx.settings.organizationName,
    timezone: tz,
  };
}

/* -------------------------------- Workbook -------------------------------- */

const HEADER_FILL = "FF1F3864";
const CODE_FILLS: Record<string, string> = {
  P: "FFC6EFCE",
  A: "FFFFC7CE",
  L: "FFFFEB9C",
  WO: "FFE7E6E6",
  H: "FFDDEBF7",
  HD: "FFFCE4D6",
  NA: "FFF2F2F2",
};
const LEGEND: [string, string][] = [
  ["P", "Present"],
  ["A", "Absent"],
  ["L", "Approved Leave"],
  ["HD", "Half Day"],
  ["WO", "Weekly Off"],
  ["H", "Public Holiday"],
  ["LT", "Late (shown with the day's status, e.g. P/LT)"],
  ["NA", "Not Applicable (before joining / after leaving)"],
  ["—", "Pending / Not Recorded"],
];

const border: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: "FFBFBFBF" } },
  left: { style: "thin", color: { argb: "FFBFBFBF" } },
  bottom: { style: "thin", color: { argb: "FFBFBFBF" } },
  right: { style: "thin", color: { argb: "FFBFBFBF" } },
};
const fill = (argb: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

function styleHeader(row: ExcelJS.Row) {
  row.height = 30;
  row.eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = fill(HEADER_FILL);
    c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    c.border = border;
  });
}

function titleBlock(ws: ExcelJS.Worksheet, d: MonthlyAttendanceData, subtitle: string, generated: string) {
  ws.addRow([d.organizationName || "Attendance"]).font = { bold: true, size: 14, color: { argb: HEADER_FILL } };
  ws.addRow([`${subtitle} — ${d.label}`]).font = { bold: true, size: 12 };
  ws.addRow([`Filters: ${d.filterText}`]).font = { size: 10, color: { argb: "FF404040" } };
  ws.addRow([generated]).font = { size: 10, color: { argb: "FF595959" } };
}

function printSetup(ws: ExcelJS.Worksheet, headerRow: number) {
  ws.pageSetup = {
    orientation: "landscape",
    paperSize: 9, // A4
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
    printTitlesRow: `${headerRow}:${headerRow}`,
  };
  ws.headerFooter = { oddFooter: "&CPage &P of &N" };
}

const TOTAL_COLUMNS: { key: keyof MonthlyTotals; label: string; width: number; fmt?: string }[] = [
  { key: "present", label: "P", width: 6 },
  { key: "absent", label: "A", width: 6 },
  { key: "leave", label: "L", width: 6 },
  { key: "weeklyOff", label: "WO", width: 6 },
  { key: "holiday", label: "H", width: 6 },
  { key: "halfDay", label: "HD", width: 6 },
  { key: "late", label: "Late Days", width: 8 },
  { key: "workedHours", label: "Total Worked Hours", width: 11, fmt: "0.00" },
  { key: "expectedWorkingDays", label: "Expected Working Days", width: 11 },
  { key: "attendancePct", label: "Attendance %", width: 11, fmt: '0.0"%"' },
];

function writeTotals(row: ExcelJS.Row, startCol: number, t: MonthlyTotals) {
  TOTAL_COLUMNS.forEach((c, i) => {
    const cell = row.getCell(startCol + i);
    cell.value = t[c.key];
    cell.alignment = { horizontal: "right", vertical: "middle" };
    if (c.fmt) cell.numFmt = c.fmt;
  });
}

export async function monthlyAttendanceWorkbook(ctx: AuthContext, year: number, month: number, filter: Partial<ReportFilter>) {
  requirePerm(ctx, "reports.export", "attendance.export");
  const d = await monthlyAttendanceData(ctx, year, month, filter);
  if (!d.rows.length) throw new AppError(404, "NOT_FOUND", `No employees match the selected filters for ${d.label}.`);

  const now = new Date();
  const generated = `Generated ${formatDisplayDate(dateInTz(now, d.timezone))} ${timeInTz(now, d.timezone)} (${d.timezone})`;
  const wb = new ExcelJS.Workbook();
  wb.creator = "HR Attendance";
  wb.created = now;

  /* Sheet 1 — daily pivot */
  const ws = wb.addWorksheet("Monthly Attendance");
  titleBlock(ws, d, "Monthly Attendance Report", generated);
  ws.addRow([`Legend: ${LEGEND.map(([c, m]) => `${c} = ${m.split(" (")[0]}`).join(" · ")}`]).font = { size: 9, italic: true, color: { argb: "FF595959" } };
  ws.addRow([]);
  const info = ["Emp ID", "Employee Name", "Designation", "Department", "Work Site", "Reporting Supervisor", "Date of Joining"];
  const infoWidths = [10, 24, 16, 16, 14, 18, 12];
  const dayHeaders = d.dates.map((date) => `${Number(date.slice(8))}\n${WEEKDAY_NAMES[dayOfWeek(date)].slice(0, 2)}`);
  const headerRow = ws.addRow([...info, ...dayHeaders, ...TOTAL_COLUMNS.map((c) => c.label)]);
  styleHeader(headerRow);
  const hr = headerRow.number;
  const firstDay = info.length + 1;
  const firstTotal = firstDay + d.dates.length;

  for (const r of d.rows) {
    const row = ws.addRow([r.employeeCode, r.employeeName, r.designation, r.department, r.workSite, r.supervisor, formatDisplayDate(r.dateOfJoining), ...r.cells]);
    writeTotals(row, firstTotal, r.totals);
    row.eachCell({ includeEmpty: true }, (c, col) => {
      c.border = border;
      if (col >= firstDay && col < firstTotal) {
        const code = String(c.value ?? "");
        c.alignment = { horizontal: "center", vertical: "middle" };
        const argb = CODE_FILLS[code.split("/")[0]];
        if (argb) c.fill = fill(argb);
        if (code.includes(LATE_CODE)) c.font = { bold: true, color: { argb: "FF9C5700" } };
        if (code === "NA") c.font = { color: { argb: "FF808080" } };
      } else if (col < firstDay) c.alignment = { vertical: "middle" };
    });
  }
  infoWidths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  d.dates.forEach((_, i) => (ws.getColumn(firstDay + i).width = 5.5));
  TOTAL_COLUMNS.forEach((c, i) => (ws.getColumn(firstTotal + i).width = c.width));
  ws.views = [{ state: "frozen", xSplit: info.length, ySplit: hr }];
  ws.autoFilter = { from: { row: hr, column: 1 }, to: { row: hr, column: firstTotal + TOTAL_COLUMNS.length - 1 } };
  printSetup(ws, hr);

  /* Sheet 2 — summary + department breakdown */
  const ss = wb.addWorksheet("Monthly Summary");
  titleBlock(ss, d, "Monthly Attendance Summary", generated);
  ss.addRow([]);
  const sInfo = ["Emp ID", "Employee Name", "Department", "Designation", "Work Site"];
  const sLabels = ["Total Present Days", "Total Absent Days", "Total Leave Days", "Total Weekly Off", "Total Holidays", "Total Half Days", "Total Late Days", "Total Working Hours", "Expected Working Days", "Attendance %"];
  const sHeader = ss.addRow([...sInfo, ...sLabels]);
  styleHeader(sHeader);
  const sFirstTotal = sInfo.length + 1;
  for (const r of d.rows) {
    const row = ss.addRow([r.employeeCode, r.employeeName, r.department, r.designation, r.workSite]);
    writeTotals(row, sFirstTotal, r.totals);
    row.eachCell({ includeEmpty: true }, (c) => (c.border = border));
  }
  const totalRow = ss.addRow(["Overall Total", `${d.overall.employees} employee${d.overall.employees === 1 ? "" : "s"}`]);
  writeTotals(totalRow, sFirstTotal, d.overall);
  totalRow.eachCell({ includeEmpty: true }, (c) => {
    c.font = { bold: true };
    c.fill = fill("FFD9E1F2");
    c.border = border;
  });
  ss.autoFilter = { from: { row: sHeader.number, column: 1 }, to: { row: sHeader.number + d.rows.length, column: sFirstTotal + sLabels.length - 1 } };

  ss.addRow([]);
  ss.addRow([]);
  ss.addRow(["Department-wise Summary"]).font = { bold: true, size: 12, color: { argb: HEADER_FILL } };
  styleHeader(ss.addRow(["Department", "Employees", "", "", "", ...sLabels]));
  for (const dep of [...d.departments, { ...d.overall, department: "All departments" }]) {
    const row = ss.addRow([dep.department, dep.employees]);
    row.getCell(2).alignment = { horizontal: "right" };
    writeTotals(row, sFirstTotal, dep);
    const isTotal = dep.department === "All departments";
    row.eachCell({ includeEmpty: true }, (c) => {
      c.border = border;
      if (isTotal) {
        c.font = { bold: true };
        c.fill = fill("FFD9E1F2");
      }
    });
  }
  [10, 24, 16, 16, 14, ...sLabels.map(() => 11)].forEach((w, i) => (ss.getColumn(i + 1).width = w));
  ss.views = [{ state: "frozen", xSplit: 2, ySplit: sHeader.number }];
  printSetup(ss, sHeader.number);

  /* Sheet 3 — legend and formulas */
  const ns = wb.addWorksheet("Legend & Notes");
  ns.getColumn(1).width = 10;
  ns.getColumn(2).width = 90;
  ns.addRow(["Code", "Meaning"]).font = { bold: true };
  for (const [code, meaning] of LEGEND) {
    const row = ns.addRow([code, meaning]);
    const argb = CODE_FILLS[code];
    if (argb) row.getCell(1).fill = fill(argb);
    row.getCell(1).alignment = { horizontal: "center" };
    row.getCell(1).border = border;
  }
  ns.addRow([]);
  ns.addRow(["", "How the numbers are calculated"]).font = { bold: true };
  for (const line of [
    "Each day is classified by the system attendance policy (same as the dashboard and register): an entered status wins; otherwise approved leave, then holiday calendar, then the employee's weekly off; unrecorded working days become Absent only after the day is finalised.",
    "P, A, L, WO, H, HD, Late Days and Total Worked Hours count exactly the codes shown in the daily cells. Days not yet finalised show — and are not counted, so no absence is assumed.",
    `Attendance % = credit days ÷ scheduled days × 100. Present = ${ctx.settings.fullDayCredit} credit, Half Day = ${ctx.settings.halfDayCredit}${ctx.settings.leaveCountsAsPresent ? `, Leave = ${ctx.settings.fullDayCredit}` : ""}; scheduled days are Present, Absent and Half Day${ctx.settings.leaveCountsAsPresent ? " plus Leave (leave counts as present)" : ""}.`,
    "Expected Working Days = days in the employee's employment window this month, excluding weekly offs and holidays (includes leave and days still to come).",
    "Late (LT) is counted separately and never replaces the day's status. Hours-only entries have no entry time, so they cannot be late.",
    "Employees not employed on any day of the month are left out; NA marks days before joining or after leaving.",
  ]) {
    const row = ns.addRow(["•", line]);
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
  }

  return {
    data: Buffer.from(await wb.xlsx.writeBuffer()),
    filename: `Attendance_Report_${MONTH_NAMES[month - 1]}_${year}.xlsx`,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    rows: d.rows.length,
  };
}

/** Lightweight preview for the dashboard panel (no workbook). */
export async function monthlyAttendancePreview(ctx: AuthContext, year: number, month: number, filter: Partial<ReportFilter>) {
  const d = await monthlyAttendanceData(ctx, year, month, filter);
  return { label: d.label, days: daysInMonth(year, month), employees: d.rows.length, overall: d.overall, filterText: d.filterText, canExport: can(ctx, "reports.export") || can(ctx, "attendance.export") };
}
