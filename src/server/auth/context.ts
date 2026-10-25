import { col } from "../db";
import type { AttendanceSettings, Employee, ID, RoleKey, User } from "@/lib/types";
import { allPermissionKeys, type PermissionKey } from "@/lib/permissions";
import { forbidden } from "../errors";
import { getSettings } from "../services/settings";
import type { AuditActor } from "../services/audit";

/**
 * Everything a service needs to authorise a request. Built once per request from
 * the session; never derived from client-supplied data.
 */
export interface AuthContext {
  user: User;
  employee: Employee | null;
  role: RoleKey;
  permissions: Set<PermissionKey>;
  /**
   * Data scope. `all` for admins. Otherwise `teamIds` = employees assigned to this
   * user (supervisor assignments, department assignments, direct reports) and
   * `selfId` = the user's own employee record.
   */
  scope: { all: boolean; teamIds: Set<ID>; selfId: ID | null };
  settings: AttendanceSettings;
  ip: string | null;
}

export async function effectivePermissions(user: Pick<User, "id" | "role">): Promise<Set<PermissionKey>> {
  if (user.role === "admin") return new Set(allPermissionKeys());
  const [rp, up] = await Promise.all([
    (await col("role_permissions")).find({ role: user.role }),
    (await col("user_permissions")).find({ userId: user.id }),
  ]);
  const set = new Set<PermissionKey>(rp.map((r) => r.permissionKey as PermissionKey));
  for (const o of up) {
    if (o.effect === "allow") set.add(o.permissionKey as PermissionKey);
    else set.delete(o.permissionKey as PermissionKey);
  }
  return set;
}

export async function resolveTeam(user: Pick<User, "id" | "employeeId">): Promise<Set<ID>> {
  const assignments = await (await col("supervisor_assignments")).find({ supervisorUserId: user.id });
  const team = new Set<ID>();
  const deptIds = new Set<ID>();
  for (const a of assignments) {
    if (a.scopeType === "employee" && a.employeeId) team.add(a.employeeId);
    if (a.scopeType === "department" && a.departmentId) deptIds.add(a.departmentId);
  }
  const employees = await col("employees");
  if (deptIds.size) {
    for (const e of await employees.find({ departmentId: { $in: [...deptIds] } })) team.add(e.id);
  }
  if (user.employeeId) {
    for (const e of await employees.find({ supervisorEmployeeId: user.employeeId })) team.add(e.id);
    team.delete(user.employeeId);
  }
  return team;
}

export async function buildAuthContext(user: User, ip: string | null = null): Promise<AuthContext> {
  const [permissions, employee, settings] = await Promise.all([
    effectivePermissions(user),
    user.employeeId ? (await col("employees")).findById(user.employeeId) : Promise.resolve(null),
    getSettings(),
  ]);
  const all = user.role === "admin";
  const teamIds = all ? new Set<ID>() : await resolveTeam(user);
  return {
    user,
    employee,
    role: user.role,
    permissions,
    scope: { all, teamIds, selfId: user.employeeId },
    settings,
    ip,
  };
}

export function can(ctx: AuthContext, perm: PermissionKey): boolean {
  return ctx.role === "admin" || ctx.permissions.has(perm);
}

export function requirePerm(ctx: AuthContext, ...perms: PermissionKey[]): void {
  if (!perms.some((p) => can(ctx, p))) throw forbidden();
}

/** May read this employee's data (team + self). */
export function canView(ctx: AuthContext, employeeId: ID): boolean {
  return ctx.scope.all || ctx.scope.teamIds.has(employeeId) || ctx.scope.selfId === employeeId;
}

/** May manage this employee's data on someone else's behalf (team only — never self). */
export function canManage(ctx: AuthContext, employeeId: ID): boolean {
  return ctx.scope.all || ctx.scope.teamIds.has(employeeId);
}

export function assertCanView(ctx: AuthContext, employeeId: ID) {
  if (!canView(ctx, employeeId)) throw forbidden("This employee is outside your access scope");
}

export function assertCanManage(ctx: AuthContext, employeeId: ID) {
  if (!canManage(ctx, employeeId)) throw forbidden("This employee is outside your access scope");
}

/**
 * Employee ids visible for a module. With team-level permission the scope is
 * team + self; with only self-service permission it is self only.
 */
export function visibleEmployeeIds(ctx: AuthContext, teamPerm: PermissionKey, selfPerm?: PermissionKey): Set<ID> | "all" {
  if (ctx.scope.all && can(ctx, teamPerm)) return "all";
  const ids = new Set<ID>();
  if (can(ctx, teamPerm)) {
    for (const id of ctx.scope.teamIds) ids.add(id);
    if (ctx.scope.selfId) ids.add(ctx.scope.selfId);
  }
  if (selfPerm && can(ctx, selfPerm) && ctx.scope.selfId) ids.add(ctx.scope.selfId);
  return ids;
}

export function actorOf(ctx: AuthContext | null): AuditActor | null {
  if (!ctx) return null;
  return { userId: ctx.user.id, role: ctx.role, name: ctx.user.displayName, ip: ctx.ip };
}
