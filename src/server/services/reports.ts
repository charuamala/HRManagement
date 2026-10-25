import { col } from "../db";
import type { DayResult, Employee, ID, ISODate } from "@/lib/types";
import type { ReportFilter } from "@/lib/schemas";
import { KPI_PREDICATES, summarize, type KpiKey, type Summary } from "@/lib/kpi";
import { CATEGORY_LABELS, LEAVE_TYPE_LABELS, SOURCE_LABELS } from "@/lib/constants";
import { addDays, dayOfWeek, diffDays, formatHours, MONTH_NAMES, monthRange, presetRange, timeInTz, todayInTz, yearRange } from "@/lib/time";
import { badRequest, notFound } from "../errors";
import { assertCanView, can, requirePerm, type AuthContext } from "../auth/context";
import type { PermissionKey } from "@/lib/permissions";
import { scopedEmployees } from "./employees";
import { DayResolver } from "./days";
import { loadLookups, nameOf, empName, type Lookups } from "./lookups";

const MAX_RANGE_DAYS = 400;

/** Analytics team permission: reports.view, falling back to attendance.view (dashboards). */
function analyticsPerm(ctx: AuthContext): PermissionKey {
  return can(ctx, "reports.view") ? "reports.view" : "attendance.view";
}

export function resolveRange(f: Partial<ReportFilter>, today: ISODate): { from: ISODate; to: ISODate } {
  let range = f.preset && f.preset !== "custom" ? presetRange(f.preset, today) : { from: f.from ?? today, to: f.to ?? f.from ?? today };
  if (range.from > range.to) range = { from: range.to, to: range.from };
  if (diffDays(range.from, range.to) > MAX_RANGE_DAYS) throw badRequest(`Date range cannot exceed ${MAX_RANGE_DAYS} days`);
  return range;
}

function statusMatch(d: DayResult, statuses?: string[]) {
  if (!statuses?.length) return true;
  return statuses.some((s) => s === d.statusCode || s === d.category || (s in KPI_PREDICATES && KPI_PREDICATES[s as KpiKey](d)));
}

export interface DayComputation {
  employees: Employee[];
  days: DayResult[];
  from: ISODate;
  to: ISODate;
  requestedTo: ISODate;
  resolver: DayResolver | null;
  today: ISODate;
}

/** The one pipeline behind every dashboard, report, drill-down and export. */
export async function computeDays(
  ctx: AuthContext,
  filter: Partial<ReportFilter>,
  opts: { teamPerm?: PermissionKey; selfPerm?: PermissionKey; clipFuture?: boolean; range?: { from: ISODate; to: ISODate } } = {},
): Promise<DayComputation> {
  const today = todayInTz(ctx.settings.timezone);
  const { from, to } = opts.range ?? resolveRange(filter, today);
  const end = opts.clipFuture === false ? to : to > today ? today : to;
  const employees = await scopedEmployees(ctx, filter, opts.teamPerm ?? analyticsPerm(ctx), opts.selfPerm);
  if (from > end || !employees.length) return { employees, days: [], from, to: end < from ? from : end, requestedTo: to, resolver: null, today };
  const resolver = await DayResolver.load(employees.map((e) => e.id), from, end);
  const days = resolver
    .resolveRange(employees, from, end)
    .filter((d) => d.category !== "not_employed" && statusMatch(d, filter.statuses));
  return { employees, days, from, to: end, requestedTo: to, resolver, today };
}

/* ---------------------------- Display rows ---------------------------- */

export interface DisplayRow extends DayResult {
  departmentName: string;
  supervisorName: string;
  locationName: string;
  shiftName: string;
  checkIn: string;
  checkOut: string;
  workedHours: string;
  sourceLabel: string;
}

export function toDisplayRow(d: DayResult, l: Lookups, tz: string): DisplayRow {
  return {
    ...d,
    departmentName: nameOf(l.departments, d.departmentId),
    supervisorName: empName(l, d.supervisorEmployeeId),
    locationName: nameOf(l.locations, d.officeLocationId),
    shiftName: nameOf(l.shifts, d.shiftId),
    checkIn: d.checkInAt ? timeInTz(d.checkInAt, tz) : "",
    checkOut: d.checkOutAt ? timeInTz(d.checkOutAt, tz) : "",
    workedHours: d.workedMinutes ? formatHours(d.workedMinutes) : "",
    sourceLabel: d.source ? SOURCE_LABELS[d.source] : d.finalized ? "Policy" : "",
  };
}

/* --------------------------- Aggregation helpers --------------------------- */

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    let arr = m.get(k);
    if (!arr) m.set(k, (arr = []));
    arr.push(it);
  }
  return m;
}

const weekStart = (d: ISODate) => addDays(d, -((dayOfWeek(d) + 6) % 7));

function trendPoint(label: string, s: Summary) {
  return {
    label,
    present: s.present,
    absent: s.absent,
    leave: s.leave,
    halfDay: s.halfDay,
    late: s.late,
    pct: s.attendancePct,
    avgHours: Math.round((s.avgWorkedMinutes / 60) * 100) / 100,
    totalHours: Math.round((s.totalWorkedMinutes / 60) * 10) / 10,
  };
}

function byDepartment(days: DayResult[], l: Lookups) {
  return [...groupBy(days, (d) => d.departmentId ?? "none")].map(([id, ds]) => ({ id, ...trendPoint(id === "none" ? "Unassigned" : nameOf(l.departments, id), summarize(ds)) })).sort((a, b) => a.label.localeCompare(b.label));
}

export interface EmployeeAggregate {
  employeeId: ID;
  employeeCode: string;
  employeeName: string;
  departmentName: string;
  supervisorName: string;
  workingDays: number;
  present: number;
  absent: number;
  leave: number;
  halfDay: number;
  holiday: number;
  weeklyOff: number;
  late: number;
  early: number;
  missingCheckOut: number;
  totalHours: number;
  attendancePct: number;
}

function perEmployee(days: DayResult[], employees: Employee[], l: Lookups): EmployeeAggregate[] {
  const groups = groupBy(days, (d) => d.employeeId);
  return employees
    .filter((e) => groups.has(e.id))
    .map((e) => {
      const s = summarize(groups.get(e.id)!);
      return {
        employeeId: e.id,
        employeeCode: e.employeeCode,
        employeeName: e.fullName,
        departmentName: nameOf(l.departments, e.departmentId),
        supervisorName: empName(l, e.supervisorEmployeeId),
        workingDays: s.scheduledDays,
        present: s.present,
        absent: s.absent,
        leave: s.leave,
        halfDay: s.halfDay,
        holiday: s.holiday,
        weeklyOff: s.weeklyOff,
        late: s.late,
        early: s.early,
        missingCheckOut: s.missingCheckOut,
        totalHours: Math.round((s.totalWorkedMinutes / 60) * 10) / 10,
        attendancePct: s.attendancePct,
      };
    });
}

function distribution(s: Summary) {
  return [
    { key: "present", label: CATEGORY_LABELS.present, value: s.present },
    { key: "absent", label: CATEGORY_LABELS.absent, value: s.absent },
    { key: "leave", label: CATEGORY_LABELS.leave, value: s.leave },
    { key: "half_day", label: CATEGORY_LABELS.half_day, value: s.halfDay },
    { key: "holiday", label: CATEGORY_LABELS.holiday, value: s.holiday },
    { key: "weekly_off", label: CATEGORY_LABELS.weekly_off, value: s.weeklyOff },
    { key: "pending", label: "Pending / Unmarked", value: s.pending },
  ];
}

function leaveByType(c: DayComputation) {
  const counts = new Map<string, number>();
  const empById = new Map(c.employees.map((e) => [e.id, e]));
  for (const d of c.days) {
    if (d.category !== "leave") continue;
    const emp = empById.get(d.employeeId);
    const type = (emp && c.resolver?.leave(emp, d.date)?.leaveType) ?? "other";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts].map(([type, days]) => ({ type, label: LEAVE_TYPE_LABELS[type as keyof typeof LEAVE_TYPE_LABELS] ?? type, days }));
}

/* -------------------------------- Dashboard ------------------------------- */

export async function dashboard(ctx: AuthContext, filter: Partial<ReportFilter>) {
  requirePerm(ctx, "dashboard.view");
  requirePerm(ctx, "attendance.view", "reports.view");
  const c = await computeDays(ctx, filter);
  const l = await loadLookups();
  const tz = ctx.settings.timezone;
  const summary = summarize(c.days);
  const snap = c.days.filter((d) => d.date === c.to);
  const rows = (ds: DayResult[], limit = 50) => ds.slice(0, limit).map((d) => toDisplayRow(d, l, tz));
  const P = KPI_PREDICATES;

  const ids = new Set(c.employees.map((e) => e.id));
  const recent = (await (await col("attendance_records")).find({ voided: false }, { sort: { updatedAt: -1 }, limit: 300 }))
    .filter((r) => ids.has(r.employeeId) && r.version > 1)
    .slice(0, 10);
  const users = new Map((await (await col("users")).find()).map((u) => [u.id, u.displayName]));

  let imports: unknown[] = [];
  if (can(ctx, "bulk_upload.view") || can(ctx, "bulk_upload.import")) {
    imports = (await (await col("bulk_import_jobs")).find(ctx.scope.all ? {} : { uploadedBy: ctx.user.id }, { sort: { createdAt: -1 }, limit: 5 })).map((j) => ({
      ...j,
      uploadedByName: users.get(j.uploadedBy) ?? "—",
    }));
  }
  let corrections: { count: number; items: unknown[] } = { count: 0, items: [] };
  if (can(ctx, "corrections.approve")) {
    const pending = (await (await col("attendance_correction_requests")).find({ status: "pending" }, { sort: { createdAt: -1 } })).filter(
      (r) => ctx.scope.all || ctx.scope.teamIds.has(r.employeeId),
    );
    corrections = {
      count: pending.length,
      items: pending.slice(0, 5).map((r) => ({ ...r, employeeName: empName(l, r.employeeId), requestedByName: users.get(r.requestedBy) ?? "—" })),
    };
  }

  const daily = [...groupBy(c.days, (d) => d.date)].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, ds]) => ({ date, ...trendPoint(date, summarize(ds)) }));
  const weekly = [...groupBy(c.days, (d) => weekStart(d.date))].sort(([a], [b]) => (a < b ? -1 : 1)).map(([wk, ds]) => ({ week: wk, ...trendPoint(`Wk ${wk.slice(5)}`, summarize(ds)) }));
  const monthly = [...groupBy(c.days, (d) => d.date.slice(0, 7))].sort(([a], [b]) => (a < b ? -1 : 1)).map(([m, ds]) => ({ month: m, ...trendPoint(`${MONTH_NAMES[Number(m.slice(5)) - 1].slice(0, 3)} ${m.slice(0, 4)}`, summarize(ds)) }));

  return {
    range: { from: c.from, to: c.to, requestedTo: c.requestedTo, today: c.today, singleDay: c.from === c.to },
    totals: { totalEmployees: c.employees.length, activeEmployees: c.employees.filter((e) => e.employmentStatus !== "inactive").length },
    summary,
    charts: { distribution: distribution(summary), daily, weekly, monthly, departments: byDepartment(c.days, l) },
    lists: {
      register: rows(snap, 200),
      inOffice: rows(snap.filter(P.in_office)),
      onLeave: rows(snap.filter(P.leave)),
      late: rows(snap.filter(P.late)),
      early: rows(snap.filter(P.early)),
      missingCheckouts: rows(c.days.filter(P.missing_checkout).reverse()),
      snapshotDate: c.to,
    },
    recent: recent.map((r) => ({
      id: r.id,
      date: r.date,
      employeeName: empName(l, r.employeeId),
      employeeCode: l.employees.get(r.employeeId)?.employeeCode ?? "",
      statusCode: r.statusCode,
      source: r.source,
      updatedAt: r.updatedAt,
      updatedBy: users.get(r.updatedBy) ?? "—",
      version: r.version,
    })),
    imports,
    corrections,
  };
}

/* ------------------------------ Drill-down ------------------------------ */

export async function recordsQuery(
  ctx: AuthContext,
  filter: Partial<ReportFilter>,
  kpi: KpiKey,
  page = 1,
  pageSize = 50,
  sort?: string,
  dir: "asc" | "desc" = "asc",
) {
  requirePerm(ctx, "attendance.view", "reports.view");
  const c = await computeDays(ctx, filter);
  const l = await loadLookups();
  let rows = c.days.filter(KPI_PREDICATES[kpi]).map((d) => toDisplayRow(d, l, ctx.settings.timezone));
  const key = (sort ?? "date") as keyof DisplayRow;
  rows = rows.sort((a, b) => {
    const r = String(a[key] ?? "").localeCompare(String(b[key] ?? ""), undefined, { numeric: true });
    return (r || a.employeeCode.localeCompare(b.employeeCode)) * (dir === "desc" ? -1 : 1);
  });
  return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize, all: rows, range: { from: c.from, to: c.to } };
}

/* -------------------------------- Reports ------------------------------- */

export async function dailyReport(ctx: AuthContext, date: ISODate, filter: Partial<ReportFilter>) {
  requirePerm(ctx, "reports.view");
  const c = await computeDays(ctx, filter, { range: { from: date, to: date }, clipFuture: false });
  const l = await loadLookups();
  const rows = c.days.map((d) => toDisplayRow(d, l, ctx.settings.timezone));
  const s = summarize(c.days);
  return { date, rows, summary: s, scheduledEmployees: c.days.filter((d) => d.category !== "holiday" && d.category !== "weekly_off").length };
}

export async function monthlyReport(ctx: AuthContext, year: number, month: number, filter: Partial<ReportFilter>) {
  requirePerm(ctx, "reports.view");
  const range = monthRange(year, month);
  const c = await computeDays(ctx, filter, { range });
  const l = await loadLookups();
  const s = summarize(c.days);
  const daily = [...groupBy(c.days, (d) => d.date)].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, ds]) => ({ date, ...trendPoint(date.slice(8), summarize(ds)) }));
  const rows = perEmployee(c.days, c.employees, l);
  return {
    year,
    month,
    range: { from: range.from, to: c.to },
    kpis: {
      totalEmployees: s.employees,
      workingDays: await orgWorkingDays(ctx, range.from, c.to < range.from ? range.from : c.to),
      attendancePct: s.attendancePct,
      totalLeave: s.leave,
      totalAbsent: s.absent,
      totalLate: s.late,
      totalHours: Math.round((s.totalWorkedMinutes / 60) * 10) / 10,
      employeesWithMissingCheckouts: rows.filter((r) => r.missingCheckOut > 0).length,
    },
    summary: s,
    rows,
    charts: { daily, departments: byDepartment(c.days, l), leaveByType: leaveByType(c), distribution: distribution(s) },
  };
}

export async function yearlyReport(ctx: AuthContext, year: number, filter: Partial<ReportFilter>) {
  requirePerm(ctx, "reports.view");
  const range = yearRange(year);
  const c = await computeDays(ctx, filter, { range });
  const l = await loadLookups();
  const s = summarize(c.days);
  const months = MONTH_NAMES.map((name, i) => {
    const key = `${year}-${String(i + 1).padStart(2, "0")}`;
    const ds = c.days.filter((d) => d.date.startsWith(key));
    return { month: key, ...trendPoint(name.slice(0, 3), summarize(ds)) };
  });
  return {
    year,
    range: { from: range.from, to: c.to },
    summary: s,
    kpis: {
      totalEmployees: s.employees,
      scheduledDays: s.scheduledDays,
      attendancePct: s.attendancePct,
      totalPresent: s.present,
      totalAbsent: s.absent,
      totalLeave: s.leave,
      totalHalfDays: s.halfDay,
      totalLate: s.late,
      totalHours: Math.round((s.totalWorkedMinutes / 60) * 10) / 10,
    },
    rows: perEmployee(c.days, c.employees, l),
    charts: { months, departments: byDepartment(c.days, l), distribution: distribution(s) },
  };
}

/** Calendar working days for the organisation (excludes default weekly offs and org-wide holidays). */
async function orgWorkingDays(ctx: AuthContext, from: ISODate, to: ISODate) {
  const holidays = new Set((await (await col("holidays")).find({ date: { $gte: from, $lte: to } })).filter((h) => !h.officeLocationIds.length).map((h) => h.date));
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (!ctx.settings.weeklyOffDays.includes(dayOfWeek(d)) && !holidays.has(d)) n++;
  return n;
}

/* ---------------------------- Employee detail ---------------------------- */

export async function employeeReport(ctx: AuthContext, employeeId: ID, year: number) {
  const own = employeeId === ctx.scope.selfId;
  if (own) requirePerm(ctx, "self_attendance.view", "reports.view", "attendance.view");
  else {
    requirePerm(ctx, "reports.view", "attendance.view");
    assertCanView(ctx, employeeId);
  }
  const emp = await (await col("employees")).findById(employeeId);
  if (!emp) throw notFound("Employee");
  const range = yearRange(year);
  const resolver = await DayResolver.load([emp.id], range.from, range.to);
  const l = await loadLookups();
  const tz = ctx.settings.timezone;
  const today = todayInTz(tz);
  const all = resolver.resolveRange([emp], range.from, range.to);
  const calendar = all.map((d) => ({
    date: d.date,
    category: d.date > today && !d.recordId && !["holiday", "weekly_off", "leave"].includes(d.category) ? "future" : d.category,
    label: d.statusLabel,
    recordId: d.recordId,
    late: d.isLate,
    missingCheckOut: d.missingCheckOut,
  }));
  const past = all.filter((d) => d.date <= today && d.category !== "not_employed");
  const months = MONTH_NAMES.map((name, i) => {
    const key = `${year}-${String(i + 1).padStart(2, "0")}`;
    return { month: key, ...trendPoint(name.slice(0, 3), summarize(past.filter((d) => d.date.startsWith(key)))) };
  });
  const corrections = await (await col("attendance_correction_requests")).find({ employeeId }, { sort: { createdAt: -1 }, limit: 20 });
  return {
    employee: {
      id: emp.id,
      employeeCode: emp.employeeCode,
      fullName: emp.fullName,
      officialEmail: emp.officialEmail,
      departmentName: nameOf(l.departments, emp.departmentId),
      designationName: nameOf(l.designations, emp.designationId),
      locationName: nameOf(l.locations, emp.officeLocationId),
      supervisorName: empName(l, emp.supervisorEmployeeId),
      shiftName: nameOf(l.shifts, emp.shiftId),
      dateOfJoining: emp.dateOfJoining,
      employmentStatus: emp.employmentStatus,
    },
    year,
    summary: summarize(past),
    months,
    calendar,
    days: past.filter((d) => d.recordId || d.category === "absent" || d.category === "leave").reverse().map((d) => toDisplayRow(d, l, tz)),
    corrections,
  };
}
