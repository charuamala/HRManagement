import { col, transaction, DuplicateKeyError } from "../db";
import type { z } from "zod";
import type { employeeCreateSchema, employeeSchema, employeeUpdateSchema, ReportFilter } from "@/lib/schemas";
import type { Employee, ID, RoleKey, User } from "@/lib/types";
import { todayInTz, addDays } from "@/lib/time";
import { conflict, forbidden, notFound, validationError, badRequest } from "../errors";
import { actorOf, assertCanManage, assertCanView, can, requirePerm, visibleEmployeeIds, type AuthContext } from "../auth/context";
import type { PermissionKey } from "@/lib/permissions";
import { audit } from "./audit";
import { buildLink, issueToken, revokeSessions } from "../auth/service";
import { diff, nowIso, stamp } from "../util";
import { loadLookups, nameOf, empName } from "./lookups";
import { ageOn } from "@/lib/constants";
import { formatAadhaar, maskAadhaar, normalizeAadhaar } from "@/lib/aadhaar";
import { blindIndex, decrypt, encrypt } from "../crypto";

type EmployeeInput = z.infer<typeof employeeSchema>;

/* ------------------------------- Scoping ------------------------------- */

/**
 * Employees visible to the caller under `teamPerm` (team + self) or `selfPerm` (self only),
 * narrowed by the shared report filter. This is the single scoping primitive for lists,
 * registers, dashboards, reports and exports.
 */
export async function scopedEmployees(
  ctx: AuthContext,
  filter: Partial<ReportFilter> = {},
  teamPerm: PermissionKey = "reports.view",
  selfPerm?: PermissionKey,
): Promise<Employee[]> {
  const visible = visibleEmployeeIds(ctx, teamPerm, selfPerm);
  if (visible !== "all" && visible.size === 0) return [];
  let list = await (await col("employees")).find(visible === "all" ? {} : { id: { $in: [...visible] } }, { sort: { employeeCode: 1 } });
  const f = filter;
  const inSet = (vals: string[] | undefined, v: string | null) => !vals?.length || (v !== null && vals.includes(v));
  list = list.filter(
    (e) =>
      inSet(f.departmentIds, e.departmentId) &&
      inSet(f.designationIds, e.designationId) &&
      inSet(f.supervisorIds, e.supervisorEmployeeId) &&
      inSet(f.employeeIds, e.id) &&
      inSet(f.officeLocationIds, e.officeLocationId) &&
      inSet(f.shiftIds, e.shiftId) &&
      inSet(f.employmentStatuses, e.employmentStatus),
  );
  if (f.search) {
    const q = f.search.toLowerCase();
    list = list.filter((e) => e.fullName.toLowerCase().includes(q) || e.employeeCode.toLowerCase().includes(q) || (e.officialEmail ?? "").includes(q) || (e.uan ?? "").includes(q));
  }
  return list;
}

/* --------------------------------- Read -------------------------------- */

export interface EmployeeListQuery extends Partial<ReportFilter> {
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: "asc" | "desc";
}

export async function listEmployees(ctx: AuthContext, q: EmployeeListQuery) {
  requirePerm(ctx, "employees.view");
  const [list, lookups, users] = await Promise.all([scopedEmployees(ctx, q, "employees.view"), loadLookups(), (await col("users")).find()]);
  const userByEmp = new Map(users.filter((u) => u.employeeId).map((u) => [u.employeeId!, u]));
  const rows = list.map((e) => enrich(redact(ctx, e), lookups, userByEmp.get(e.id)));
  const sortKey = (q.sort ?? "employeeCode") as keyof (typeof rows)[number];
  const dir = q.dir === "desc" ? -1 : 1;
  rows.sort((a, b) => String(a[sortKey] ?? "").localeCompare(String(b[sortKey] ?? ""), undefined, { numeric: true }) * dir);
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? 25;
  return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize };
}

export type PublicEmployee = Omit<Employee, "aadhaarEnc" | "aadhaarHash"> & { aadhaarMasked: string | null };

/**
 * The only shape in which employees leave the server: Aadhaar ciphertext and its
 * blind index are stripped (masked form only); bank details are visible only to
 * admins and to the employee themself.
 */
export function redact(ctx: AuthContext, e: Employee): PublicEmployee {
  const { aadhaarEnc: _enc, aadhaarHash: _hash, ...rest } = e;
  void _enc;
  void _hash;
  const out = { ...rest, aadhaarMasked: maskAadhaar(e.aadhaarLast4) };
  if (ctx.role === "admin" || ctx.scope.selfId === e.id) return out;
  return { ...out, bankAccountNumber: e.bankAccountNumber ? "•••• hidden" : null, ifscCode: e.ifscCode ? "•••• hidden" : null };
}

/** Write-only Aadhaar input → stored fields. undefined = keep, "" = remove, digits = set. */
function aadhaarPatch(value: string | undefined, current?: Employee): Partial<Employee> {
  if (value === undefined) return {};
  if (value === "") return { aadhaarLast4: null, aadhaarEnc: null, aadhaarHash: null };
  const n = normalizeAadhaar(value);
  const hash = blindIndex(n);
  if (current?.aadhaarHash === hash) return {};
  return { aadhaarLast4: n.slice(-4), aadhaarEnc: encrypt(n), aadhaarHash: hash };
}

/** Full Aadhaar for an admin or the employee themself — every reveal is audit-logged. */
export async function revealAadhaar(ctx: AuthContext, id: ID) {
  const emp = await (await col("employees")).findById(id);
  if (!emp) throw notFound("Employee");
  if (ctx.role !== "admin" && ctx.scope.selfId !== id) throw forbidden("Only administrators can view full Aadhaar numbers");
  if (!emp.aadhaarEnc) throw notFound("Aadhaar number");
  await audit(actorOf(ctx), { action: "aadhaar_viewed", module: "employees", recordId: id });
  return { aadhaar: formatAadhaar(decrypt(emp.aadhaarEnc)) };
}

export function enrich(e: PublicEmployee, l: Awaited<ReturnType<typeof loadLookups>>, user?: User) {
  return {
    ...e,
    age: ageOn(e.dateOfBirth, new Date().toISOString().slice(0, 10)),
    departmentName: nameOf(l.departments, e.departmentId),
    designationName: nameOf(l.designations, e.designationId),
    locationName: nameOf(l.locations, e.officeLocationId),
    shiftName: nameOf(l.shifts, e.shiftId),
    supervisorName: empName(l, e.supervisorEmployeeId),
    role: user?.role ?? null,
    accountStatus: user?.status ?? "none",
  };
}

export async function getEmployee(ctx: AuthContext, id: ID) {
  const emp = await (await col("employees")).findById(id);
  if (!emp) throw notFound("Employee");
  if (id !== ctx.scope.selfId) {
    requirePerm(ctx, "employees.view", "attendance.view", "reports.view");
    assertCanView(ctx, id);
  }
  const [lookups, user, shifts] = await Promise.all([
    loadLookups(),
    (await col("users")).findOne({ employeeId: id }),
    (await col("employee_shift_assignments")).find({ employeeId: id }, { sort: { effectiveFrom: -1 } }),
  ]);
  return { ...enrich(redact(ctx, emp), lookups, user ?? undefined), shiftHistory: shifts, userId: user?.id ?? null };
}

/* -------------------------------- Write -------------------------------- */

async function validateRefs(input: Partial<EmployeeInput>, selfId?: ID) {
  const errors: Record<string, string> = {};
  const check = async (key: keyof EmployeeInput, name: "departments" | "designations" | "office_locations" | "shifts" | "employees") => {
    const v = input[key] as string | null | undefined;
    if (v && !(await (await col(name)).findById(v))) errors[key] = "Not found";
  };
  await Promise.all([
    check("departmentId", "departments"),
    check("designationId", "designations"),
    check("officeLocationId", "office_locations"),
    check("shiftId", "shifts"),
    check("supervisorEmployeeId", "employees"),
  ]);
  if (selfId && input.supervisorEmployeeId === selfId) errors.supervisorEmployeeId = "An employee cannot supervise themselves";
  if (input.dateOfBirth && input.dateOfJoining && input.dateOfBirth >= input.dateOfJoining) {
    errors.dateOfBirth = "Date of birth must be before the date of joining";
  }
  if (input.expectedEntryTime && input.expectedExitTime && input.expectedEntryTime === input.expectedExitTime) {
    errors.expectedExitTime = "Must differ from entry time";
  }
  if (Object.keys(errors).length) throw validationError(Object.values(errors)[0], { fieldErrors: errors });
}

function dupMessage(e: DuplicateKeyError) {
  if (e.fields.includes("employeeCode")) return { employeeCode: "This Employee ID is already in use" };
  if (e.fields.includes("officialEmail") || e.fields.includes("email")) return { officialEmail: "This email is already in use" };
  if (e.fields.includes("uan")) return { uan: "This UAN is already registered to another employee" };
  if (e.fields.includes("aadhaarHash")) return { aadhaarNumber: "This Aadhaar number is already registered to another employee" };
  return { _: e.message };
}

export async function createEmployee(ctx: AuthContext, input: z.infer<typeof employeeCreateSchema>) {
  requirePerm(ctx, "employees.create");
  if (input.createAccount && input.role !== "employee") requirePerm(ctx, "users.manage");
  await validateRefs(input);
  const { createAccount, role, aadhaarNumber, ...data } = input;
  const today = todayInTz(ctx.settings.timezone);
  try {
    return await transaction(async () => {
      const emp: Employee = {
        ...stamp(),
        ...data,
        fullName: `${data.firstName} ${data.lastName}`.trim(),
        aadhaarLast4: null,
        aadhaarEnc: null,
        aadhaarHash: null,
        ...aadhaarPatch(aadhaarNumber || undefined),
        photoId: null,
        dateOfExit: null,
        userId: null,
        deactivatedAt: null,
      };
      const employees = await col("employees");
      await employees.insertOne(emp);
      if (emp.shiftId) {
        await (await col("employee_shift_assignments")).insertOne({ ...stamp(), employeeId: emp.id, shiftId: emp.shiftId, effectiveFrom: emp.dateOfJoining < today ? emp.dateOfJoining : today, effectiveTo: null });
      }
      let inviteLink: string | null = null;
      if (createAccount) {
        const user = await createUserRecord({ email: emp.officialEmail, employeeId: emp.id, employeeCode: emp.employeeCode, displayName: emp.fullName, role });
        await employees.updateById(emp.id, { userId: user.id });
        emp.userId = user.id;
        inviteLink = buildLink("invite", await issueToken(user.id, "invite"));
        await audit(actorOf(ctx), { action: "invite", module: "users", recordId: user.id, newValues: { email: user.email, role } });
      }
      await audit(actorOf(ctx), { action: "create", module: "employees", recordId: emp.id, newValues: emp as unknown as Record<string, unknown> });
      return { employee: redact(ctx, emp), inviteLink };
    });
  } catch (e) {
    if (e instanceof DuplicateKeyError) {
      const fe = dupMessage(e);
      throw conflict(Object.values(fe)[0], { fieldErrors: fe });
    }
    throw e;
  }
}

export async function createUserRecord(u: { email: string | null; employeeId: ID | null; employeeCode: string | null; displayName: string; role: RoleKey }): Promise<User> {
  const user: User = {
    ...stamp(),
    email: u.email?.toLowerCase() ?? null,
    employeeId: u.employeeId,
    employeeCode: u.employeeCode?.toUpperCase() ?? null,
    displayName: u.displayName,
    role: u.role,
    passwordHash: null,
    status: "invited",
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: null,
    passwordChangedAt: null,
  };
  return (await col("users")).insertOne(user);
}

export async function updateEmployee(ctx: AuthContext, id: ID, input: z.infer<typeof employeeUpdateSchema>) {
  requirePerm(ctx, "employees.edit");
  assertCanManage(ctx, id);
  const employees = await col("employees");
  const before = await employees.findById(id);
  if (!before) throw notFound("Employee");
  await validateRefs(input, id);
  const { role, aadhaarNumber, ...data } = input;
  if (ctx.role !== "admin") {
    // Non-admins never see bank details, so never let their form overwrite them.
    data.bankAccountNumber = before.bankAccountNumber;
    data.ifscCode = before.ifscCode;
  }
  if ((data.employmentStatus === "inactive") !== (before.employmentStatus === "inactive")) {
    throw badRequest("Use the Deactivate / Reactivate actions to change whether an employee is inactive");
  }
  const patch: Partial<Employee> = { ...data, fullName: `${data.firstName} ${data.lastName}`.trim(), ...aadhaarPatch(aadhaarNumber, before) };
  const d = diff(before, patch);
  const users = await col("users");
  const user = await users.findOne({ employeeId: id });
  const roleChange = role && user && role !== user.role;
  if (roleChange) {
    requirePerm(ctx, "users.manage");
    if (user.id === ctx.user.id) throw forbidden("You cannot change your own role");
    if (user.role === "admin") await assertNotLastAdmin(user.id);
  }
  if (!d && !roleChange) return redact(ctx, before);
  const today = todayInTz(ctx.settings.timezone);
  try {
    return await transaction(async () => {
      const saved = (await employees.updateById(id, { ...patch, updatedAt: nowIso() }))!;
      if (patch.shiftId !== undefined && patch.shiftId !== before.shiftId) {
        const asg = await col("employee_shift_assignments");
        await asg.updateMany({ employeeId: id, effectiveTo: null }, { effectiveTo: addDays(today, -1) });
        if (patch.shiftId) await asg.insertOne({ ...stamp(), employeeId: id, shiftId: patch.shiftId, effectiveFrom: today, effectiveTo: null });
      }
      if (user) {
        const up: Partial<User> = {};
        if (patch.officialEmail && patch.officialEmail !== user.email) up.email = patch.officialEmail;
        if (patch.employeeCode && patch.employeeCode !== user.employeeCode) up.employeeCode = patch.employeeCode;
        if (saved.fullName !== user.displayName) up.displayName = saved.fullName;
        if (roleChange) up.role = role;
        if (Object.keys(up).length) {
          await users.updateById(user.id, { ...up, updatedAt: nowIso() });
          if (roleChange) {
            await audit(actorOf(ctx), { action: "role_change", module: "permissions", recordId: user.id, oldValues: { role: user.role }, newValues: { role } });
          }
        }
      }
      if (d) await audit(actorOf(ctx), { action: "update", module: "employees", recordId: id, oldValues: d.old as Record<string, unknown>, newValues: d.new as Record<string, unknown> });
      return redact(ctx, saved);
    });
  } catch (e) {
    if (e instanceof DuplicateKeyError) {
      const fe = dupMessage(e);
      throw conflict(Object.values(fe)[0], { fieldErrors: fe });
    }
    throw e;
  }
}

export async function assertNotLastAdmin(userId: ID) {
  const admins = await (await col("users")).find({ role: "admin", status: "active" });
  if (admins.length <= 1 && admins[0]?.id === userId) throw forbidden("At least one active administrator is required");
}

/** Soft-deactivation: history stays referenced; the account is disabled and sessions revoked. */
export async function setEmployeeActive(ctx: AuthContext, id: ID, active: boolean, opts: { date?: string; reason?: string } = {}) {
  requirePerm(ctx, active ? "employees.edit" : "employees.delete");
  assertCanManage(ctx, id);
  const employees = await col("employees");
  const before = await employees.findById(id);
  if (!before) throw notFound("Employee");
  const users = await col("users");
  const user = await users.findOne({ employeeId: id });
  if (!active && user?.id === ctx.user.id) throw forbidden("You cannot deactivate yourself");
  if (!active && user?.role === "admin") await assertNotLastAdmin(user.id);
  const today = todayInTz(ctx.settings.timezone);
  const exitDate = opts.date ?? today;
  if (!active && exitDate < before.dateOfJoining) throw badRequest("Exit date cannot be before the joining date");

  return transaction(async () => {
    const patch: Partial<Employee> = active
      ? { employmentStatus: "active", dateOfExit: null, deactivatedAt: null }
      : { employmentStatus: "inactive", dateOfExit: exitDate, deactivatedAt: nowIso() };
    const saved = (await employees.updateById(id, { ...patch, updatedAt: nowIso() }))!;
    if (user) {
      const status = active ? (user.passwordHash ? "active" : "invited") : "disabled";
      await users.updateById(user.id, { status, updatedAt: nowIso() });
      if (!active) await revokeSessions(user.id);
    }
    await audit(actorOf(ctx), {
      action: active ? "reactivate" : "deactivate",
      module: "employees",
      recordId: id,
      oldValues: { employmentStatus: before.employmentStatus, dateOfExit: before.dateOfExit },
      newValues: { employmentStatus: saved.employmentStatus, dateOfExit: saved.dateOfExit },
      reason: opts.reason ?? null,
    });
    return redact(ctx, saved);
  });
}

export async function listSupervisors() {
  const users = await (await col("users")).find({ role: { $in: ["supervisor", "admin"] } });
  const employees = await col("employees");
  const out: { userId: ID; employeeId: ID | null; name: string; role: RoleKey; status: User["status"] }[] = [];
  for (const u of users) {
    const e = u.employeeId ? await employees.findById(u.employeeId) : null;
    out.push({ userId: u.id, employeeId: e?.id ?? null, name: e?.fullName ?? u.displayName, role: u.role, status: u.status });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function canSeeEmployeeDirectory(ctx: AuthContext) {
  return can(ctx, "employees.view");
}

/**
 * Permanent delete — only for records created by mistake. Employees referenced by any
 * attendance, correction or leave history must be deactivated instead (soft delete).
 */
export async function deleteEmployee(ctx: AuthContext, id: ID, reason: string) {
  requirePerm(ctx, "employees.delete");
  assertCanManage(ctx, id);
  const employees = await col("employees");
  const emp = await employees.findById(id);
  if (!emp) throw notFound("Employee");
  const [att, corr, leave, reports] = await Promise.all([
    (await col("attendance_records")).count({ employeeId: id }),
    (await col("attendance_correction_requests")).count({ employeeId: id }),
    (await col("employee_leave_records")).count({ employeeId: id }),
    employees.count({ supervisorEmployeeId: id }),
  ]);
  if (att || corr || leave) {
    throw conflict(`${emp.fullName} has attendance history (${att} record(s)). Deactivate the employee instead so history stays intact.`);
  }
  if (reports) throw conflict(`${reports} employee(s) report to ${emp.fullName}. Reassign them first.`);
  const users = await col("users");
  const user = await users.findOne({ employeeId: id });
  if (user?.id === ctx.user.id) throw forbidden("You cannot delete yourself");
  if (user?.role === "admin") await assertNotLastAdmin(user.id);
  await transaction(async () => {
    await (await col("employee_shift_assignments")).deleteMany({ employeeId: id });
    await (await col("supervisor_assignments")).deleteMany({ employeeId: id });
    if (user) {
      await revokeSessions(user.id);
      await (await col("auth_tokens")).deleteMany({ userId: user.id });
      await (await col("user_permissions")).deleteMany({ userId: user.id });
      await (await col("supervisor_assignments")).deleteMany({ supervisorUserId: user.id });
      await users.deleteById(user.id);
    }
    await employees.deleteById(id);
    await audit(actorOf(ctx), { action: "delete", module: "employees", recordId: id, oldValues: emp as unknown as Record<string, unknown>, reason });
  });
  return { deleted: true };
}
