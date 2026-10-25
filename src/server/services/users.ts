import { col, transaction, DuplicateKeyError } from "../db";
import type { ID, RoleKey, User } from "@/lib/types";
import { conflict, forbidden, notFound, badRequest } from "../errors";
import { actorOf, requirePerm, type AuthContext } from "../auth/context";
import { audit } from "./audit";
import { buildLink, issueToken, revokeSessions } from "../auth/service";
import { nowIso } from "../util";
import { assertNotLastAdmin, createUserRecord } from "./employees";

export type PublicUser = Omit<User, "passwordHash">;

export function toPublic(u: User): PublicUser & { hasPassword: boolean } {
  const { passwordHash, ...rest } = u;
  return { ...rest, hasPassword: !!passwordHash };
}

export async function listUsers(ctx: AuthContext) {
  requirePerm(ctx, "users.view");
  const [users, employees, sessions] = await Promise.all([
    (await col("users")).find({}, { sort: { displayName: 1 } }),
    (await col("employees")).find(),
    (await col("sessions")).find(),
  ]);
  const empById = new Map(employees.map((e) => [e.id, e]));
  const now = nowIso();
  return users.map((u) => ({
    ...toPublic(u),
    employeeName: u.employeeId ? (empById.get(u.employeeId)?.fullName ?? null) : null,
    activeSessions: sessions.filter((s) => s.userId === u.id && s.expiresAt > now).length,
  }));
}

/** Invite a login for an existing employee (or a standalone admin account). */
export async function inviteUser(ctx: AuthContext, input: { employeeId?: ID | null; email?: string; displayName?: string; role: RoleKey }) {
  requirePerm(ctx, "users.create");
  if (input.role !== "employee") requirePerm(ctx, "users.manage");
  let email: string | null = input.email?.toLowerCase().trim() || null;
  let displayName = input.displayName?.trim();
  let employeeCode: string | null = null;
  if (input.employeeId) {
    const emp = await (await col("employees")).findById(input.employeeId);
    if (!emp) throw notFound("Employee");
    if (emp.employmentStatus === "inactive") throw badRequest("Cannot create a login for an inactive employee");
    if (await (await col("users")).findOne({ employeeId: emp.id })) throw conflict("This employee already has a login account");
    email = emp.officialEmail;
    displayName = emp.fullName;
    employeeCode = emp.employeeCode;
  }
  if (!input.employeeId && (!email || !displayName)) throw badRequest("Email and display name are required for accounts without an employee record");
  try {
    return await transaction(async () => {
      const user = await createUserRecord({ email, employeeId: input.employeeId ?? null, employeeCode, displayName: displayName!, role: input.role });
      if (input.employeeId) await (await col("employees")).updateById(input.employeeId, { userId: user.id });
      const link = buildLink("invite", await issueToken(user.id, "invite"));
      await audit(actorOf(ctx), { action: "invite", module: "users", recordId: user.id, newValues: { email, role: input.role } });
      return { user: toPublic(user), inviteLink: link };
    });
  } catch (e) {
    if (e instanceof DuplicateKeyError) throw conflict("A user with this email or Employee ID already exists");
    throw e;
  }
}

export async function updateUser(ctx: AuthContext, id: ID, input: { role?: RoleKey; status?: "active" | "disabled"; displayName?: string }) {
  requirePerm(ctx, "users.edit", "users.manage");
  const users = await col("users");
  const before = await users.findById(id);
  if (!before) throw notFound("User");
  const patch: Partial<User> = {};
  if (input.displayName && input.displayName !== before.displayName) patch.displayName = input.displayName;
  if (input.role && input.role !== before.role) {
    requirePerm(ctx, "users.manage");
    if (id === ctx.user.id) throw forbidden("You cannot change your own role");
    if (before.role === "admin") await assertNotLastAdmin(id);
    patch.role = input.role;
  }
  if (input.status && input.status !== before.status) {
    requirePerm(ctx, "users.manage");
    if (id === ctx.user.id) throw forbidden("You cannot change your own account status");
    if (input.status === "disabled" && before.role === "admin") await assertNotLastAdmin(id);
    if (input.status === "active" && !before.passwordHash) throw badRequest("This user has not accepted their invitation yet. Resend the invite instead.");
    if (input.status === "active" && before.employeeId) {
      const emp = await (await col("employees")).findById(before.employeeId);
      if (emp?.employmentStatus === "inactive") throw badRequest("Reactivate the employee record first");
    }
    patch.status = input.status;
  }
  if (!Object.keys(patch).length) return toPublic(before);
  return transaction(async () => {
    const saved = (await users.updateById(id, { ...patch, updatedAt: nowIso() }))!;
    if (patch.status === "disabled") await revokeSessions(id);
    const old: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) old[k] = before[k as keyof User];
    await audit(actorOf(ctx), {
      action: patch.role ? "role_change" : patch.status ? (patch.status === "active" ? "activate" : "deactivate") : "update",
      module: patch.role ? "permissions" : "users",
      recordId: id,
      oldValues: old,
      newValues: patch as Record<string, unknown>,
    });
    return toPublic(saved);
  });
}

/** Admin-issued reset / invite link (no email service in Phase 1 — the admin shares it). */
export async function issueUserLink(ctx: AuthContext, id: ID) {
  requirePerm(ctx, "users.manage");
  const user = await (await col("users")).findById(id);
  if (!user) throw notFound("User");
  if (user.status === "disabled") throw badRequest("Activate the account first");
  const type = user.status === "invited" ? "invite" : "reset";
  const link = buildLink(type, await issueToken(user.id, type));
  await audit(actorOf(ctx), { action: type === "invite" ? "invite_resent" : "reset_link_issued", module: "users", recordId: id });
  return { link, type, expiresIn: type === "invite" ? "72 hours" : "30 minutes" };
}

export async function revokeUserSessions(ctx: AuthContext, id: ID) {
  requirePerm(ctx, "users.manage");
  const n = await revokeSessions(id);
  await audit(actorOf(ctx), { action: "sessions_revoked", module: "users", recordId: id, newValues: { count: n } });
  return { revoked: n };
}
