import { col } from "../db";
import type { z } from "zod";
import type * as S from "@/lib/schemas";
import type { AttendanceStatus, Department, Designation, Holiday, ID, LeaveRecord, OfficeLocation, Shift } from "@/lib/types";
import { conflict, notFound, validationError } from "../errors";
import { assertCanManage, can, canView, requirePerm, type AuthContext } from "../auth/context";
import { createAudited, deleteAudited, updateAudited } from "./crud";

type In<T extends z.ZodType> = z.infer<T>;

/* ----------------------------- Departments ----------------------------- */

export async function listDepartments() {
  return (await col("departments")).find({}, { sort: { name: 1 } });
}

export async function createDepartment(ctx: AuthContext, input: In<typeof S.departmentSchema>) {
  requirePerm(ctx, "departments.create");
  return createAudited(ctx, "departments", "departments", input);
}

export async function updateDepartment(ctx: AuthContext, id: ID, input: Partial<Department>) {
  requirePerm(ctx, "departments.edit");
  return updateAudited(ctx, "departments", "departments", id, input);
}

export async function deleteDepartment(ctx: AuthContext, id: ID) {
  requirePerm(ctx, "departments.delete");
  const used = await (await col("employees")).count({ departmentId: id });
  if (used) throw conflict(`${used} employee(s) belong to this department. Reassign them or mark the department inactive instead.`);
  await (await col("designations")).updateMany({ departmentId: id }, { departmentId: null });
  return deleteAudited(ctx, "departments", "departments", id);
}

/* ----------------------------- Designations ---------------------------- */

export async function listDesignations() {
  return (await col("designations")).find({}, { sort: { title: 1 } });
}

export async function createDesignation(ctx: AuthContext, input: In<typeof S.designationSchema>) {
  requirePerm(ctx, "departments.create");
  return createAudited(ctx, "designations", "designations", input);
}

export async function updateDesignation(ctx: AuthContext, id: ID, input: Partial<Designation>) {
  requirePerm(ctx, "departments.edit");
  return updateAudited(ctx, "designations", "designations", id, input);
}

export async function deleteDesignation(ctx: AuthContext, id: ID) {
  requirePerm(ctx, "departments.delete");
  const used = await (await col("employees")).count({ designationId: id });
  if (used) throw conflict(`${used} employee(s) hold this designation. Mark it inactive instead.`);
  return deleteAudited(ctx, "designations", "designations", id);
}

/* --------------------------- Office locations -------------------------- */

export async function listLocations() {
  return (await col("office_locations")).find({}, { sort: { name: 1 } });
}

export async function createLocation(ctx: AuthContext, input: In<typeof S.locationSchema>) {
  requirePerm(ctx, "departments.create");
  return createAudited(ctx, "office_locations", "office_locations", input);
}

export async function updateLocation(ctx: AuthContext, id: ID, input: Partial<OfficeLocation>) {
  requirePerm(ctx, "departments.edit");
  return updateAudited(ctx, "office_locations", "office_locations", id, input);
}

export async function deleteLocation(ctx: AuthContext, id: ID) {
  requirePerm(ctx, "departments.delete");
  const used = await (await col("employees")).count({ officeLocationId: id });
  if (used) throw conflict(`${used} employee(s) are based at this location. Mark it inactive instead.`);
  return deleteAudited(ctx, "office_locations", "office_locations", id);
}

/* -------------------------------- Shifts ------------------------------- */

export async function listShifts() {
  return (await col("shifts")).find({}, { sort: { startTime: 1 } });
}

function checkShift(input: Partial<Shift>) {
  if (input.startTime && input.endTime && input.startTime === input.endTime) {
    throw validationError("Shift start and end cannot be identical", { fieldErrors: { endTime: "Must differ from start time" } });
  }
  if (input.fullDayHours != null && input.halfDayHours != null && input.halfDayHours > input.fullDayHours) {
    throw validationError("Half-day hours cannot exceed full-day hours", { fieldErrors: { halfDayHours: "Must be ≤ full-day hours" } });
  }
}

export async function createShift(ctx: AuthContext, input: In<typeof S.shiftSchema>) {
  requirePerm(ctx, "shifts.create");
  checkShift(input);
  return createAudited(ctx, "shifts", "shifts", input);
}

export async function updateShift(ctx: AuthContext, id: ID, input: Partial<Shift>) {
  requirePerm(ctx, "shifts.edit");
  const cur = await (await col("shifts")).findById(id);
  if (!cur) throw notFound("Shift");
  checkShift({ ...cur, ...input });
  return updateAudited(ctx, "shifts", "shifts", id, input);
}

export async function deleteShift(ctx: AuthContext, id: ID) {
  requirePerm(ctx, "shifts.delete");
  const [emp, rec] = await Promise.all([
    (await col("employees")).count({ shiftId: id }),
    (await col("attendance_records")).count({ shiftId: id }),
  ]);
  if (emp || rec) throw conflict("This shift is referenced by employees or attendance history. Mark it inactive instead.");
  return deleteAudited(ctx, "shifts", "shifts", id);
}

/* ------------------------------- Holidays ------------------------------ */

export async function listHolidays(year?: number) {
  const c = await col("holidays");
  const filter = year ? { date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } } : {};
  return c.find(filter, { sort: { date: 1 } });
}

export async function createHoliday(ctx: AuthContext, input: In<typeof S.holidaySchema>) {
  requirePerm(ctx, "settings.manage");
  return createAudited(ctx, "holidays", "holidays", input);
}

export async function updateHoliday(ctx: AuthContext, id: ID, input: Partial<Holiday>) {
  requirePerm(ctx, "settings.manage");
  return updateAudited(ctx, "holidays", "holidays", id, input);
}

export async function deleteHoliday(ctx: AuthContext, id: ID) {
  requirePerm(ctx, "settings.manage");
  return deleteAudited(ctx, "holidays", "holidays", id);
}

/* -------------------------------- Leave -------------------------------- */

export async function listLeaves(ctx: AuthContext, opts: { employeeId?: ID; from?: string; to?: string } = {}) {
  const c = await col("employee_leave_records");
  const filter: Record<string, unknown> = {};
  if (opts.employeeId) filter.employeeId = opts.employeeId;
  if (opts.from) filter.toDate = { $gte: opts.from };
  if (opts.to) filter.fromDate = { $lte: opts.to };
  const rows = await c.find(filter as never, { sort: { fromDate: -1 } });
  const hasView = can(ctx, "leave.view");
  return rows.filter((r) => (hasView && canView(ctx, r.employeeId)) || r.employeeId === ctx.scope.selfId);
}

async function checkLeaveOverlap(employeeId: ID, fromDate: string, toDate: string, excludeId?: ID) {
  const c = await col("employee_leave_records");
  const overlap = await c.findOne({ employeeId, status: "approved", fromDate: { $lte: toDate }, toDate: { $gte: fromDate } } as never);
  if (overlap && overlap.id !== excludeId) {
    throw conflict(`Overlaps an existing leave from ${overlap.fromDate} to ${overlap.toDate}`);
  }
}

export async function createLeave(ctx: AuthContext, input: In<typeof S.leaveSchema>) {
  requirePerm(ctx, "leave.create");
  assertCanManage(ctx, input.employeeId);
  const emp = await (await col("employees")).findById(input.employeeId);
  if (!emp) throw notFound("Employee");
  await checkLeaveOverlap(input.employeeId, input.fromDate, input.toDate);
  return createAudited(ctx, "employee_leave_records", "leave", { ...input, status: "approved", createdBy: ctx.user.id });
}

export async function updateLeave(ctx: AuthContext, id: ID, input: Partial<LeaveRecord>) {
  requirePerm(ctx, "leave.edit");
  const cur = await (await col("employee_leave_records")).findById(id);
  if (!cur) throw notFound("Leave record");
  assertCanManage(ctx, cur.employeeId);
  const next = { ...cur, ...input };
  if (next.toDate < next.fromDate) throw validationError("End date must be on or after start date");
  if (next.status === "approved") await checkLeaveOverlap(cur.employeeId, next.fromDate, next.toDate, id);
  return updateAudited(ctx, "employee_leave_records", "leave", id, input);
}

export async function deleteLeave(ctx: AuthContext, id: ID) {
  requirePerm(ctx, "leave.delete");
  const cur = await (await col("employee_leave_records")).findById(id);
  if (!cur) throw notFound("Leave record");
  assertCanManage(ctx, cur.employeeId);
  return updateAudited(ctx, "employee_leave_records", "leave", id, { status: "cancelled" }, "Leave cancelled");
}

/* --------------------------- Attendance statuses ------------------------ */

export async function listStatuses(includeInactive = false): Promise<AttendanceStatus[]> {
  const c = await col("attendance_statuses");
  return c.find(includeInactive ? {} : { active: true }, { sort: { order: 1 } });
}

export async function createStatus(ctx: AuthContext, input: In<typeof S.statusSchema>) {
  requirePerm(ctx, "settings.manage");
  const count = await (await col("attendance_statuses")).count();
  return createAudited(ctx, "attendance_statuses", "attendance_statuses", { ...input, system: false, order: count + 1 });
}

export async function updateStatus(ctx: AuthContext, id: ID, input: Partial<AttendanceStatus>) {
  requirePerm(ctx, "settings.manage");
  const cur = await (await col("attendance_statuses")).findById(id);
  if (!cur) throw notFound("Status");
  if (cur.system && (input.code !== undefined && input.code !== cur.code || input.category !== undefined && input.category !== cur.category)) {
    throw validationError("System statuses cannot change code or category");
  }
  if (cur.system && input.active === false) throw validationError("System statuses cannot be deactivated");
  return updateAudited(ctx, "attendance_statuses", "attendance_statuses", id, input);
}
