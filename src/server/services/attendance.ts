import { col, transaction } from "../db";
import type {
  AttendanceEvent,
  AttendanceRecord,
  AttendanceStatus,
  DayResult,
  Employee,
  EntrySource,
  ID,
  ISODate,
  StatusCategory,
} from "@/lib/types";
import { resolveTimes, validateEntry } from "@/lib/attendance-calc";
import { finalizationInstant } from "@/lib/day-status";
import { addDays, dateInTz, diffDays, timeInTz, todayInTz } from "@/lib/time";
import { conflict, forbidden, locked, notFound, validationError, badRequest } from "../errors";
import { actorOf, assertCanManage, assertCanView, can, canManage, requirePerm, type AuthContext } from "../auth/context";
import { audit } from "./audit";
import { notify } from "./notifications";
import { DayResolver } from "./days";
import { diff, nowIso, stamp } from "../util";

/* ------------------------------- Helpers ------------------------------- */

export function isLocked(date: ISODate, ctx: Pick<AuthContext, "settings">, now = new Date()): boolean {
  const s = ctx.settings;
  return s.lockEnabled && diffDays(date, todayInTz(s.timezone, now)) > s.lockAfterDays;
}

export function employedOn(emp: Employee, date: ISODate): string | null {
  if (date < emp.dateOfJoining) return `Employee joined on ${emp.dateOfJoining}`;
  if (emp.dateOfExit && date > emp.dateOfExit) return `Employee was inactive after ${emp.dateOfExit}`;
  if (emp.employmentStatus === "inactive" && !emp.dateOfExit) return "Employee is inactive";
  return null;
}

async function loadEmployee(id: ID): Promise<Employee> {
  const emp = await (await col("employees")).findById(id);
  if (!emp) throw notFound("Employee");
  return emp;
}

export async function activeTemplateVersionId(): Promise<ID | null> {
  const t = await (await col("attendance_templates")).findOne({ status: "active" });
  return t?.activeVersionId ?? null;
}

async function userIdForEmployee(employeeId: ID): Promise<ID | null> {
  const u = await (await col("users")).findOne({ employeeId });
  return u?.id ?? null;
}

function stateFor(category: StatusCategory, checkInAt: string | null, checkOutAt: string | null, prev?: AttendanceRecord) {
  if (prev?.state === "finalized") return "finalized" as const;
  return category === "pending" && checkInAt && !checkOutAt ? ("open" as const) : ("complete" as const);
}

async function event(rec: AttendanceRecord, type: AttendanceEvent["type"], at: string, source: EntrySource, by: ID, note = "") {
  await (await col("attendance_events")).insertOne({ ...stamp(), attendanceId: rec.id, employeeId: rec.employeeId, type, at, source, createdBy: by, note });
}

export interface EntryInput {
  statusCode: string;
  checkIn: string | null;
  checkOut: string | null;
  checkOutDate?: string | null;
  /** Hours-only entry when no times are known. */
  workedHours?: number | null;
  allowFuture?: boolean;
}

export interface PreparedEntry {
  statusCode: string;
  category: StatusCategory;
  checkInAt: string | null;
  checkOutAt: string | null;
  reportedMinutes: number | null;
  shiftId: ID | null;
}

/** Validates an entry and converts wall-clock times into instants. Returns field errors instead of throwing. */
export function prepareEntry(
  ctx: AuthContext,
  emp: Employee,
  date: ISODate,
  input: EntryInput,
  resolver: DayResolver,
): { value: PreparedEntry | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const status: AttendanceStatus | undefined = resolver.statuses.get(input.statusCode);
  if (!status || !status.active) errors.statusCode = `Unknown or inactive status "${input.statusCode}"`;
  const employment = employedOn(emp, date);
  if (employment) errors.date = employment;

  const tz = ctx.settings.timezone;
  const allowFuture = !!input.allowFuture && can(ctx, "attendance.manage");
  const today = todayInTz(tz, resolver.now);
  const category = status?.category ?? "pending";
  if (date > today && !allowFuture && !["leave", "holiday", "weekly_off"].includes(category)) {
    errors.date = "Future dates accept only Leave, Holiday or Weekly Off";
  }
  const schedule = resolver.schedule(emp, date);
  const times = resolveTimes({ date, checkIn: input.checkIn, checkOut: input.checkOut, checkOutDate: input.checkOutDate }, schedule.overnight, tz);
  Object.assign(errors, times.errors);
  const reportedMinutes = input.workedHours != null ? Math.round(input.workedHours * 60) : null;
  if (status) {
    const rules = validateEntry({
      category,
      checkInAt: times.checkInAt,
      checkOutAt: times.checkOutAt,
      reportedMinutes,
      now: resolver.now,
      futureToleranceMinutes: ctx.settings.futureToleranceMinutes,
      allowFuture,
    });
    for (const [k, msg] of Object.entries(rules)) errors[k] ??= msg;
  }
  if (Object.keys(errors).length) return { value: null, errors };
  return {
    value: { statusCode: input.statusCode, category, checkInAt: times.checkInAt, checkOutAt: times.checkOutAt, reportedMinutes, shiftId: schedule.shiftId },
    errors,
  };
}

export interface WriteMeta {
  source: EntrySource;
  remarks?: string;
  customFields?: Record<string, unknown>;
  reason?: string | null;
  importJobId?: ID | null;
  employeeSubmitted?: boolean;
  templateVersionId?: ID | null;
  quiet?: boolean;
}

/** Inserts a record (caller has already authorised and validated). Must run inside a transaction. */
export async function insertRecord(ctx: AuthContext, emp: Employee, date: ISODate, v: PreparedEntry, meta: WriteMeta): Promise<AttendanceRecord> {
  const records = await col("attendance_records");
  const existing = await records.findOne({ employeeId: emp.id, date, segment: 1, voided: false });
  if (existing) throw conflict(`Attendance for ${emp.employeeCode} on ${date} already exists`, { existingId: existing.id });
  const rec: AttendanceRecord = {
    ...stamp(),
    employeeId: emp.id,
    date,
    segment: 1,
    statusCode: v.statusCode,
    checkInAt: v.checkInAt,
    checkOutAt: v.checkOutAt,
    reportedMinutes: v.reportedMinutes,
    remarks: meta.remarks ?? "",
    source: meta.source,
    state: stateFor(v.category, v.checkInAt, v.checkOutAt),
    employeeSubmitted: meta.employeeSubmitted ?? false,
    shiftId: v.shiftId,
    templateVersionId: meta.templateVersionId ?? (await activeTemplateVersionId()),
    importJobId: meta.importJobId ?? null,
    customFields: meta.customFields ?? {},
    voided: false,
    voidReason: null,
    createdBy: ctx.user.id,
    updatedBy: ctx.user.id,
    version: 1,
  };
  await records.insertOne(rec);
  if (rec.checkInAt) await event(rec, "check_in", rec.checkInAt, meta.source, ctx.user.id);
  if (rec.checkOutAt) await event(rec, "check_out", rec.checkOutAt, meta.source, ctx.user.id);
  await audit(actorOf(ctx), {
    action: "create",
    module: "attendance",
    recordId: rec.id,
    newValues: { employeeCode: emp.employeeCode, date, statusCode: rec.statusCode, checkInAt: rec.checkInAt, checkOutAt: rec.checkOutAt, reportedMinutes: rec.reportedMinutes, remarks: rec.remarks, source: rec.source },
    reason: meta.reason ?? null,
    importId: meta.importJobId ?? null,
  });
  return rec;
}

/** Updates a record (caller has already authorised and validated). Must run inside a transaction. */
export async function updateRecord(
  ctx: AuthContext,
  before: AttendanceRecord,
  v: PreparedEntry,
  meta: WriteMeta & { moveTo?: { employeeId: ID; date: ISODate } },
): Promise<AttendanceRecord> {
  const records = await col("attendance_records");
  const patch: Partial<AttendanceRecord> = {
    statusCode: v.statusCode,
    checkInAt: v.checkInAt,
    checkOutAt: v.checkOutAt,
    reportedMinutes: v.reportedMinutes,
    shiftId: v.shiftId ?? before.shiftId,
    state: stateFor(v.category, v.checkInAt, v.checkOutAt, before),
  };
  if (meta.remarks !== undefined) patch.remarks = meta.remarks;
  if (meta.customFields !== undefined) patch.customFields = meta.customFields;
  if (meta.moveTo) {
    patch.employeeId = meta.moveTo.employeeId;
    patch.date = meta.moveTo.date;
  }
  const d = diff(before, patch);
  if (!d) return before;
  const saved = (await records.updateById(before.id, {
    ...patch,
    source: meta.source === "self" ? before.source : meta.source,
    employeeSubmitted: meta.employeeSubmitted ?? (meta.source === "self" ? true : before.employeeSubmitted),
    importJobId: meta.importJobId ?? before.importJobId,
    updatedBy: ctx.user.id,
    updatedAt: nowIso(),
    version: before.version + 1,
  }))!;
  if (patch.checkInAt && patch.checkInAt !== before.checkInAt) await event(saved, "check_in", patch.checkInAt, meta.source, ctx.user.id, before.checkInAt ? "corrected" : "");
  if (patch.checkOutAt && patch.checkOutAt !== before.checkOutAt) await event(saved, "check_out", patch.checkOutAt, meta.source, ctx.user.id, before.checkOutAt ? "corrected" : "");
  await audit(actorOf(ctx), {
    action: "update",
    module: "attendance",
    recordId: before.id,
    oldValues: d.old as Record<string, unknown>,
    newValues: d.new as Record<string, unknown>,
    reason: meta.reason ?? null,
    importId: meta.importJobId ?? null,
  });
  if (!meta.quiet && meta.source !== "self") {
    const owner = await userIdForEmployee(saved.employeeId);
    if (owner && owner !== ctx.user.id) {
      await notify([owner], {
        type: "attendance_modified",
        title: "Attendance record updated",
        message: `Your attendance for ${saved.date} was updated by ${ctx.user.displayName}.`,
        link: `/my-attendance?date=${saved.date}`,
      });
    }
  }
  return saved;
}

function assertNotLocked(ctx: AuthContext, date: ISODate) {
  if (isLocked(date, ctx) && !can(ctx, "attendance.manage")) {
    throw locked(`Attendance for ${date} is locked (older than ${ctx.settings.lockAfterDays} days). An administrator must make this change.`);
  }
}

function toWall(iso: string | null, tz: string) {
  return iso ? timeInTz(iso, tz) : null;
}

/* ----------------------------- Public API ----------------------------- */

export interface CreateInput extends EntryInput {
  employeeId: ID;
  date: ISODate;
  remarks?: string;
  customFields?: Record<string, unknown>;
  reason?: string;
}

export async function createAttendance(ctx: AuthContext, input: CreateInput, source: EntrySource = "manual") {
  requirePerm(ctx, "attendance.create");
  assertCanManage(ctx, input.employeeId);
  assertNotLocked(ctx, input.date);
  const emp = await loadEmployee(input.employeeId);
  const resolver = await DayResolver.load([emp.id], input.date, addDays(input.date, 1));
  const { value, errors } = prepareEntry(ctx, emp, input.date, input, resolver);
  if (!value) throw validationError(Object.values(errors)[0], { fieldErrors: errors });
  return transaction(() =>
    insertRecord(ctx, emp, input.date, value, { source, remarks: input.remarks, customFields: input.customFields, reason: input.reason }),
  );
}

export interface UpdateInput extends Partial<EntryInput> {
  employeeId?: ID;
  date?: ISODate;
  remarks?: string;
  customFields?: Record<string, unknown>;
  reason?: string;
  expectedVersion?: number;
}

export async function updateAttendance(ctx: AuthContext, id: ID, input: UpdateInput, source: EntrySource = "manual") {
  requirePerm(ctx, "attendance.edit");
  const records = await col("attendance_records");
  const before = await records.findById(id);
  if (!before || before.voided) throw notFound("Attendance record");
  assertCanManage(ctx, before.employeeId);
  assertNotLocked(ctx, before.date);
  if (input.expectedVersion !== undefined && input.expectedVersion !== before.version) {
    throw conflict("This record was changed by someone else. Reload and try again.", { currentVersion: before.version });
  }

  let moveTo: { employeeId: ID; date: ISODate } | undefined;
  const targetEmpId = input.employeeId ?? before.employeeId;
  const targetDate = input.date ?? before.date;
  if (targetEmpId !== before.employeeId || targetDate !== before.date) {
    requirePerm(ctx, "attendance.manage");
    assertCanManage(ctx, targetEmpId);
    assertNotLocked(ctx, targetDate);
    if (!input.reason) throw validationError("A reason is required when reassigning a record", { fieldErrors: { reason: "Required" } });
    const clash = await records.findOne({ employeeId: targetEmpId, date: targetDate, segment: 1, voided: false });
    if (clash) throw conflict("The target employee already has attendance on that date");
    moveTo = { employeeId: targetEmpId, date: targetDate };
  }

  const emp = await loadEmployee(targetEmpId);
  const tz = ctx.settings.timezone;
  const resolver = await DayResolver.load([emp.id], targetDate, addDays(targetDate, 1));
  // Unspecified fields keep their current values.
  const wallIn = input.checkIn !== undefined ? input.checkIn : toWall(before.checkInAt, tz);
  const wallOut = input.checkOut !== undefined ? input.checkOut : toWall(before.checkOutAt, tz);
  const outDate =
    input.checkOutDate !== undefined ? input.checkOutDate : input.checkOut === undefined && before.checkOutAt ? dateInTz(before.checkOutAt, tz) : null;
  // Keep reported hours unless the caller changed them or switched to times.
  const workedHours =
    input.workedHours !== undefined ? input.workedHours : wallIn || wallOut ? null : before.reportedMinutes != null ? before.reportedMinutes / 60 : null;
  const { value, errors } = prepareEntry(
    ctx,
    emp,
    targetDate,
    { statusCode: input.statusCode ?? before.statusCode, checkIn: wallIn, checkOut: wallOut, checkOutDate: outDate, workedHours, allowFuture: input.allowFuture },
    resolver,
  );
  if (!value) throw validationError(Object.values(errors)[0], { fieldErrors: errors });
  if (isLocked(before.date, ctx) && !input.reason) {
    throw validationError("A reason is required to edit a locked record", { fieldErrors: { reason: "Required" } });
  }
  return transaction(() =>
    updateRecord(ctx, before, value, { source, remarks: input.remarks, customFields: input.customFields, reason: input.reason, moveTo }),
  );
}

export async function voidAttendance(ctx: AuthContext, id: ID, reason: string) {
  requirePerm(ctx, "attendance.delete");
  if (!reason || reason.trim().length < 3) throw validationError("A reason is required to void a record", { fieldErrors: { reason: "Required" } });
  const records = await col("attendance_records");
  const before = await records.findById(id);
  if (!before || before.voided) throw notFound("Attendance record");
  assertCanManage(ctx, before.employeeId);
  assertNotLocked(ctx, before.date);
  return transaction(async () => {
    const saved = (await records.updateById(id, { voided: true, voidReason: reason, updatedBy: ctx.user.id, updatedAt: nowIso(), version: before.version + 1 }))!;
    await event(saved, "void", nowIso(), "manual", ctx.user.id, reason);
    await audit(actorOf(ctx), { action: "void", module: "attendance", recordId: id, oldValues: { voided: false, statusCode: before.statusCode, checkInAt: before.checkInAt, checkOutAt: before.checkOutAt }, newValues: { voided: true }, reason });
    return saved;
  });
}

export async function getAttendanceDetail(ctx: AuthContext, id: ID) {
  const rec = await (await col("attendance_records")).findById(id);
  if (!rec) throw notFound("Attendance record");
  const own = rec.employeeId === ctx.scope.selfId;
  if (own) requirePerm(ctx, "self_attendance.view", "attendance.view");
  else {
    requirePerm(ctx, "attendance.view");
    assertCanView(ctx, rec.employeeId);
  }
  const emp = await loadEmployee(rec.employeeId);
  const resolver = await DayResolver.load([emp.id], rec.date, rec.date);
  const [events, history, corrections] = await Promise.all([
    (await col("attendance_events")).find({ attendanceId: id }, { sort: { createdAt: 1 } }),
    (await col("audit_logs")).find({ module: "attendance", recordId: id }, { sort: { seq: 1 } }),
    (await col("attendance_correction_requests")).find({ employeeId: rec.employeeId, date: rec.date }, { sort: { createdAt: -1 } }),
  ]);
  return {
    record: rec,
    day: rec.voided ? null : resolver.resolve(emp, rec.date),
    employee: { id: emp.id, employeeCode: emp.employeeCode, fullName: emp.fullName, departmentId: emp.departmentId },
    events,
    history,
    corrections,
    locked: isLocked(rec.date, ctx),
    canEdit: !own && can(ctx, "attendance.edit") && canManage(ctx, rec.employeeId) && (!isLocked(rec.date, ctx) || can(ctx, "attendance.manage")),
    canVoid: !own && can(ctx, "attendance.delete") && canManage(ctx, rec.employeeId),
  };
}

/** Find the record for an employee/date (used by forms to switch into edit mode). */
export async function findRecord(ctx: AuthContext, employeeId: ID, date: ISODate) {
  if (employeeId !== ctx.scope.selfId) {
    requirePerm(ctx, "attendance.view");
    assertCanView(ctx, employeeId);
  }
  return (await col("attendance_records")).findOne({ employeeId, date, segment: 1, voided: false });
}

/* ------------------------------- Register ------------------------------ */

export interface RegisterRow {
  employee: Pick<Employee, "id" | "employeeCode" | "fullName" | "departmentId" | "shiftId" | "officeLocationId" | "supervisorEmployeeId">;
  day: DayResult;
  record: {
    id: ID;
    version: number;
    statusCode: string;
    checkIn: string | null;
    checkOut: string | null;
    workedHours: number | null;
    remarks: string;
    source: EntrySource;
    employeeSubmitted: boolean;
  } | null;
  /** Hours credited as a full day; prefilled when the register marks someone present. */
  fullDayHours: number;
  editable: boolean;
}

export async function getRegister(ctx: AuthContext, date: ISODate, employees: Employee[]): Promise<{ rows: RegisterRow[]; locked: boolean; finalizeAt: string }> {
  const tz = ctx.settings.timezone;
  const active = employees.filter((e) => !employedOn(e, date));
  const resolver = await DayResolver.load(active.map((e) => e.id), date, date);
  const lockedDay = isLocked(date, ctx);
  const rows = active.map((e): RegisterRow => {
      const rec = resolver.record(e.id, date);
      return {
        employee: {
          id: e.id,
          employeeCode: e.employeeCode,
          fullName: e.fullName,
          departmentId: e.departmentId,
          shiftId: resolver.shiftFor(e, date, rec)?.id ?? null,
          officeLocationId: e.officeLocationId,
          supervisorEmployeeId: e.supervisorEmployeeId,
        },
        day: resolver.resolve(e, date),
        record: rec
          ? {
              id: rec.id,
              version: rec.version,
              statusCode: rec.statusCode,
              checkIn: toWall(rec.checkInAt, tz),
              checkOut: toWall(rec.checkOutAt, tz),
              workedHours: rec.reportedMinutes != null ? rec.reportedMinutes / 60 : null,
              remarks: rec.remarks,
              source: rec.source,
              employeeSubmitted: rec.employeeSubmitted,
            }
          : null,
        fullDayHours: resolver.schedule(e, date, rec).fullDayMinutes / 60,
        editable:
          canManage(ctx, e.id) && (rec ? can(ctx, "attendance.edit") : can(ctx, "attendance.create")) && (!lockedDay || can(ctx, "attendance.manage")),
      };
    });
  return { rows, locked: lockedDay, finalizeAt: finalizationInstant(date, ctx.settings).toISOString() };
}

export interface RegisterSaveRow {
  employeeId: ID;
  statusCode: string;
  checkIn: string | null;
  checkOut: string | null;
  workedHours?: number | null;
  remarks: string;
  expectedVersion?: number;
}

export async function saveRegister(ctx: AuthContext, date: ISODate, rows: RegisterSaveRow[]) {
  requirePerm(ctx, "attendance.create", "attendance.edit");
  assertNotLocked(ctx, date);
  const ids = [...new Set(rows.map((r) => r.employeeId))];
  if (ids.length !== rows.length) throw badRequest("Each employee may appear only once");
  for (const id of ids) assertCanManage(ctx, id);
  const employees = await (await col("employees")).find({ id: { $in: ids } });
  const empMap = new Map(employees.map((e) => [e.id, e]));
  const resolver = await DayResolver.load(ids, date, addDays(date, 1));
  const rowErrors: Record<ID, Record<string, string>> = {};
  const plan: { emp: Employee; before: AttendanceRecord | null; value: PreparedEntry; remarks: string }[] = [];

  for (const r of rows) {
    const emp = empMap.get(r.employeeId);
    if (!emp) {
      rowErrors[r.employeeId] = { employeeId: "Unknown employee" };
      continue;
    }
    const before = resolver.record(emp.id, date);
    if (before && !can(ctx, "attendance.edit")) {
      rowErrors[emp.id] = { _: "You may not edit existing records" };
      continue;
    }
    if (!before && !can(ctx, "attendance.create")) {
      rowErrors[emp.id] = { _: "You may not create records" };
      continue;
    }
    if (before && r.expectedVersion !== undefined && r.expectedVersion !== before.version) {
      rowErrors[emp.id] = { _: "Changed by someone else — reload the register" };
      continue;
    }
    if (!before && r.statusCode === "pending" && !r.checkIn && !r.checkOut && r.workedHours == null && !r.remarks) continue; // nothing to save
    const { value, errors } = prepareEntry(
      ctx,
      emp,
      date,
      { statusCode: r.statusCode, checkIn: r.checkIn, checkOut: r.checkOut, workedHours: r.workedHours ?? null },
      resolver,
    );
    if (!value) rowErrors[emp.id] = errors;
    else plan.push({ emp, before, value, remarks: r.remarks });
  }
  if (Object.keys(rowErrors).length) {
    throw validationError(`${Object.keys(rowErrors).length} row(s) have errors. Nothing was saved.`, { rowErrors });
  }
  let created = 0;
  let updated = 0;
  await transaction(async () => {
    for (const p of plan) {
      if (p.before) {
        const saved = await updateRecord(ctx, p.before, p.value, { source: "register", remarks: p.remarks });
        if (saved !== p.before) updated++;
      } else {
        await insertRecord(ctx, p.emp, date, p.value, { source: "register", remarks: p.remarks });
        created++;
      }
    }
  });
  return { created, updated, unchanged: rows.length - created - updated };
}

/* ---------------------------- Self-service ----------------------------- */

async function selfEmployee(ctx: AuthContext): Promise<Employee> {
  requirePerm(ctx, "self_attendance.view", "self_attendance.create");
  if (!ctx.scope.selfId) throw badRequest("Your account is not linked to an employee record");
  return loadEmployee(ctx.scope.selfId);
}

export async function selfStatus(ctx: AuthContext) {
  const emp = await selfEmployee(ctx);
  const tz = ctx.settings.timezone;
  const now = new Date();
  const today = todayInTz(tz, now);
  const yesterday = addDays(today, -1);
  const resolver = await DayResolver.load([emp.id], yesterday, today, now);
  const rec = resolver.record(emp.id, today);
  const prev = resolver.record(emp.id, yesterday);
  const openOvernight = prev && prev.checkInAt && !prev.checkOutAt && resolver.schedule(emp, yesterday, prev).overnight ? prev : null;
  const permitted = can(ctx, "self_attendance.create");
  return {
    date: today,
    day: resolver.resolve(emp, today),
    record: rec,
    openOvernight,
    schedule: { start: resolver.schedule(emp, today).startTime, end: resolver.schedule(emp, today).endTime },
    canCheckIn: permitted && ctx.settings.selfCheckInEnabled && !employedOn(emp, today) && !rec?.checkInAt && !openOvernight,
    canCheckOut: permitted && ctx.settings.selfCheckOutEnabled && !!((rec?.checkInAt && (!rec.checkOutAt || ctx.settings.allowRepeatCheckout)) || openOvernight),
    selfCheckInEnabled: ctx.settings.selfCheckInEnabled && permitted,
  };
}

export async function selfPunch(ctx: AuthContext, type: "check_in" | "check_out", note = "") {
  requirePerm(ctx, "self_attendance.create");
  const emp = await selfEmployee(ctx);
  const s = ctx.settings;
  if (type === "check_in" && !s.selfCheckInEnabled) throw forbidden("Self check-in is disabled by your administrator");
  if (type === "check_out" && !s.selfCheckOutEnabled) throw forbidden("Self check-out is disabled by your administrator");
  const now = new Date();
  const nowIsoStr = now.toISOString();
  const today = todayInTz(s.timezone, now);
  const yesterday = addDays(today, -1);
  const resolver = await DayResolver.load([emp.id], yesterday, today, now);
  const employment = employedOn(emp, today);
  if (employment) throw forbidden(employment);
  const records = await col("attendance_records");

  return transaction(async () => {
    if (type === "check_in") {
      const rec = await records.findOne({ employeeId: emp.id, date: today, segment: 1, voided: false });
      if (rec?.checkInAt) throw conflict(`Already checked in today at ${timeInTz(rec.checkInAt, s.timezone)}`);
      if (rec) {
        const cat = resolver.statuses.get(rec.statusCode)?.category;
        if (cat && cat !== "pending" && cat !== "present" && cat !== "half_day") {
          throw conflict(`You are marked "${resolver.statuses.get(rec.statusCode)?.label}" today. Contact your supervisor.`);
        }
        const saved = await updateRecord(
          ctx,
          rec,
          { statusCode: rec.statusCode, category: cat ?? "pending", checkInAt: nowIsoStr, checkOutAt: null, reportedMinutes: null, shiftId: rec.shiftId },
          { source: "self", employeeSubmitted: true, remarks: note || rec.remarks },
        );
        return { record: saved, message: "Checked in" };
      }
      const shift = resolver.shiftFor(emp, today);
      const saved = await insertRecord(
        ctx,
        emp,
        today,
        { statusCode: "pending", category: "pending", checkInAt: nowIsoStr, checkOutAt: null, reportedMinutes: null, shiftId: shift?.id ?? null },
        { source: "self", employeeSubmitted: true, remarks: note },
      );
      return { record: saved, message: "Checked in" };
    }

    // check_out: prefer today's record; fall back to an open overnight record from yesterday.
    let rec = await records.findOne({ employeeId: emp.id, date: today, segment: 1, voided: false });
    if (!rec?.checkInAt) {
      const prev = await records.findOne({ employeeId: emp.id, date: yesterday, segment: 1, voided: false });
      if (prev?.checkInAt && !prev.checkOutAt && resolver.schedule(emp, yesterday, prev).overnight) rec = prev;
    }
    if (!rec?.checkInAt) throw conflict("No check-in found for today. Check in first.");
    if (rec.checkOutAt && !s.allowRepeatCheckout) throw conflict(`Already checked out at ${timeInTz(rec.checkOutAt, s.timezone)}`);
    const cat = resolver.statuses.get(rec.statusCode)?.category ?? "pending";
    const saved = await updateRecord(
      ctx,
      rec,
      { statusCode: rec.statusCode, category: cat, checkInAt: rec.checkInAt, checkOutAt: nowIsoStr, reportedMinutes: null, shiftId: rec.shiftId },
      { source: "self", employeeSubmitted: true, remarks: note || rec.remarks },
    );
    return { record: saved, message: rec.checkOutAt ? "Check-out time updated" : "Checked out" };
  });
}

/* ----------------------------- Finalization ---------------------------- */

export async function finalizeDate(ctx: AuthContext, date: ISODate, employees: Employee[]) {
  requirePerm(ctx, "attendance.approve");
  const now = new Date();
  const finalAt = finalizationInstant(date, ctx.settings);
  if (now < finalAt) throw badRequest(`Attendance for ${date} can be finalized after ${finalAt.toISOString()}`);
  const inScope = employees.filter((e) => canManage(ctx, e.id) && !employedOn(e, date));
  const resolver = await DayResolver.load(inScope.map((e) => e.id), date, date, now);
  const records = await col("attendance_records");
  const counts = { created: 0, updated: 0, missingCheckOut: 0, alreadyFinal: 0 };
  const reminders: { employeeId: ID; userId: ID | null }[] = [];

  await transaction(async () => {
    for (const emp of inScope) {
      const day = resolver.resolve(emp, date);
      const rec = resolver.record(emp.id, date);
      if (day.missingCheckOut) {
        counts.missingCheckOut++;
        reminders.push({ employeeId: emp.id, userId: await userIdForEmployee(emp.id) });
      }
      if (rec?.state === "finalized") {
        counts.alreadyFinal++;
        continue;
      }
      if (!rec) {
        const saved: AttendanceRecord = {
          ...stamp(),
          employeeId: emp.id,
          date,
          segment: 1,
          statusCode: day.statusCode,
          checkInAt: null,
          checkOutAt: null,
          reportedMinutes: null,
          remarks: "",
          source: "finalization",
          state: "finalized",
          employeeSubmitted: false,
          shiftId: day.shiftId,
          templateVersionId: null,
          importJobId: null,
          customFields: {},
          voided: false,
          voidReason: null,
          createdBy: ctx.user.id,
          updatedBy: ctx.user.id,
          version: 1,
        };
        await records.insertOne(saved);
        counts.created++;
      } else {
        await records.updateById(rec.id, {
          statusCode: resolver.statuses.get(rec.statusCode)?.category === "pending" ? day.statusCode : rec.statusCode,
          state: "finalized",
          updatedBy: ctx.user.id,
          updatedAt: nowIso(),
          version: rec.version + 1,
        });
        await event(rec, "finalize", nowIso(), "finalization", ctx.user.id, `Finalized as ${day.statusCode}`);
        counts.updated++;
      }
    }
    await audit(actorOf(ctx), { action: "finalize", module: "attendance", recordId: null, newValues: { date, ...counts } });
  });

  for (const r of reminders) {
    await notify([r.userId], {
      type: "missing_checkout",
      title: "Missing check-out",
      message: `No check-out was recorded for ${date}. Please submit a correction request.`,
      link: `/my-attendance?date=${date}`,
      dedupeKey: `missing:${date}`,
    });
  }
  return counts;
}

/** Notify the given users (admins) about past dates whose finalization time has passed but are not finalized. */
export async function remindPendingFinalization(adminUserIds: ID[], settings: AuthContext["settings"], lookbackDays = 7) {
  const now = new Date();
  const today = todayInTz(settings.timezone, now);
  const records = await col("attendance_records");
  for (let i = 1; i <= lookbackDays; i++) {
    const date = addDays(today, -i);
    if (now < finalizationInstant(date, settings)) continue;
    const open = await records.count({ date, voided: false, state: { $ne: "finalized" } });
    const finalized = await records.count({ date, voided: false, state: "finalized" });
    if (open > 0 || finalized === 0) {
      await notify(adminUserIds, {
        type: "finalization_pending",
        title: "Attendance not finalized",
        message: `Attendance for ${date} is past its finalization time and has not been finalized.`,
        link: `/attendance?date=${date}`,
        dedupeKey: `finalize:${date}`,
      });
    }
  }
}

export async function sendMissingCheckoutReminders(ctx: AuthContext, days: DayResult[]) {
  requirePerm(ctx, "attendance.edit");
  let sent = 0;
  for (const d of days.filter((x) => x.missingCheckOut && canManage(ctx, x.employeeId))) {
    const uid = await userIdForEmployee(d.employeeId);
    if (!uid) continue;
    await notify([uid], {
      type: "missing_checkout",
      title: "Missing check-out",
      message: `You checked in on ${d.date} but no check-out was recorded.`,
      link: `/my-attendance?date=${d.date}`,
      dedupeKey: `missing:${d.date}`,
    });
    sent++;
  }
  return { sent };
}
