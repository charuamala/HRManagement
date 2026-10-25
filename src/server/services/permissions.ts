import { col, transaction } from "../db";
import type { ID, RoleKey } from "@/lib/types";
import { allPermissionKeys, isPermissionKey, MODULES, ACTION_DESCRIPTIONS, PERMISSION_NOTES, type PermissionKey } from "@/lib/permissions";
import { badRequest, forbidden, notFound } from "../errors";
import { actorOf, effectivePermissions, requirePerm, resolveTeam, type AuthContext } from "../auth/context";
import { audit } from "./audit";
import { stamp } from "../util";

export function catalog() {
  return Object.entries(MODULES).map(([key, def]) => ({
    key,
    label: def.label,
    actions: def.actions.map((a) => ({
      action: a,
      key: `${key}.${a}` as PermissionKey,
      label: ACTION_DESCRIPTIONS[a],
      note: PERMISSION_NOTES[`${key}.${a}` as PermissionKey] ?? null,
    })),
  }));
}

export async function getRoleMatrix(ctx: AuthContext) {
  requirePerm(ctx, "permissions.view");
  const rp = await (await col("role_permissions")).find();
  const roles: Record<string, PermissionKey[]> = { admin: allPermissionKeys(), supervisor: [], employee: [] };
  for (const r of rp) if (r.role !== "admin") (roles[r.role] ??= []).push(r.permissionKey as PermissionKey);
  return { catalog: catalog(), roles };
}

export async function setRolePermissions(ctx: AuthContext, role: RoleKey, keys: string[]) {
  requirePerm(ctx, "permissions.manage");
  if (role === "admin") throw forbidden("The Admin role always holds every permission");
  const invalid = keys.filter((k) => !isPermissionKey(k));
  if (invalid.length) throw badRequest(`Unknown permissions: ${invalid.join(", ")}`);
  const c = await col("role_permissions");
  const before = (await c.find({ role })).map((r) => r.permissionKey).sort();
  const next = [...new Set(keys)].sort();
  await transaction(async () => {
    await c.deleteMany({ role });
    await c.insertMany(next.map((permissionKey) => ({ ...stamp(), role, permissionKey })));
    await audit(actorOf(ctx), {
      action: "role_permissions_changed",
      module: "permissions",
      recordId: role,
      oldValues: { permissions: before },
      newValues: { permissions: next, added: next.filter((k) => !before.includes(k)), removed: before.filter((k) => !next.includes(k)) },
    });
  });
  return { role, permissions: next };
}

export async function getUserPermissions(ctx: AuthContext, userId: ID) {
  requirePerm(ctx, "permissions.view");
  const user = await (await col("users")).findById(userId);
  if (!user) throw notFound("User");
  const [overrides, effective, rolePerms, assignments, team] = await Promise.all([
    (await col("user_permissions")).find({ userId }),
    effectivePermissions(user),
    (await col("role_permissions")).find({ role: user.role }),
    (await col("supervisor_assignments")).find({ supervisorUserId: userId }),
    resolveTeam(user),
  ]);
  return {
    user: { id: user.id, displayName: user.displayName, role: user.role, email: user.email, employeeId: user.employeeId },
    rolePermissions: user.role === "admin" ? allPermissionKeys() : rolePerms.map((r) => r.permissionKey),
    allow: overrides.filter((o) => o.effect === "allow").map((o) => o.permissionKey),
    deny: overrides.filter((o) => o.effect === "deny").map((o) => o.permissionKey),
    effective: [...effective],
    assignments: {
      employeeIds: assignments.filter((a) => a.scopeType === "employee").map((a) => a.employeeId!),
      departmentIds: assignments.filter((a) => a.scopeType === "department").map((a) => a.departmentId!),
    },
    teamSize: team.size,
  };
}

export async function setUserOverrides(ctx: AuthContext, userId: ID, allow: string[], deny: string[]) {
  requirePerm(ctx, "permissions.manage");
  const user = await (await col("users")).findById(userId);
  if (!user) throw notFound("User");
  if (user.role === "admin") throw badRequest("Admins hold every permission; overrides do not apply");
  if (userId === ctx.user.id) throw forbidden("You cannot change your own permissions");
  const invalid = [...allow, ...deny].filter((k) => !isPermissionKey(k));
  if (invalid.length) throw badRequest(`Unknown permissions: ${invalid.join(", ")}`);
  const both = allow.filter((k) => deny.includes(k));
  if (both.length) throw badRequest(`A permission cannot be both allowed and denied: ${both.join(", ")}`);
  const c = await col("user_permissions");
  const before = await c.find({ userId });
  await transaction(async () => {
    await c.deleteMany({ userId });
    await c.insertMany([
      ...[...new Set(allow)].map((permissionKey) => ({ ...stamp(), userId, permissionKey, effect: "allow" as const })),
      ...[...new Set(deny)].map((permissionKey) => ({ ...stamp(), userId, permissionKey, effect: "deny" as const })),
    ]);
    await audit(actorOf(ctx), {
      action: "user_permissions_changed",
      module: "permissions",
      recordId: userId,
      oldValues: { allow: before.filter((o) => o.effect === "allow").map((o) => o.permissionKey), deny: before.filter((o) => o.effect === "deny").map((o) => o.permissionKey) },
      newValues: { allow, deny },
    });
  });
  return getUserPermissions(ctx, userId);
}

export async function setSupervisorScope(ctx: AuthContext, userId: ID, employeeIds: ID[], departmentIds: ID[]) {
  requirePerm(ctx, "permissions.manage");
  const user = await (await col("users")).findById(userId);
  if (!user) throw notFound("User");
  if (user.role === "admin") throw badRequest("Admins already have organisation-wide scope");
  const c = await col("supervisor_assignments");
  const before = await c.find({ supervisorUserId: userId });
  const empIds = [...new Set(employeeIds)].filter((id) => id !== user.employeeId);
  const deptIds = [...new Set(departmentIds)];
  await transaction(async () => {
    await c.deleteMany({ supervisorUserId: userId });
    await c.insertMany([
      ...empIds.map((employeeId) => ({ ...stamp(), supervisorUserId: userId, scopeType: "employee" as const, employeeId, departmentId: null })),
      ...deptIds.map((departmentId) => ({ ...stamp(), supervisorUserId: userId, scopeType: "department" as const, employeeId: null, departmentId })),
    ]);
    await audit(actorOf(ctx), {
      action: "supervisor_scope_changed",
      module: "permissions",
      recordId: userId,
      oldValues: { employeeIds: before.filter((a) => a.employeeId).map((a) => a.employeeId), departmentIds: before.filter((a) => a.departmentId).map((a) => a.departmentId) },
      newValues: { employeeIds: empIds, departmentIds: deptIds },
    });
  });
  return getUserPermissions(ctx, userId);
}
