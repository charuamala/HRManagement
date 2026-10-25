import { col, transaction } from "../db";
import type { Session, User } from "@/lib/types";
import { audit } from "../services/audit";
import { AppError, badRequest, rateLimited, unauthorized, validationError } from "../errors";
import { getDummyHash, hashPassword, passwordProblem, verifyPassword } from "./password";
import { hit } from "./rate-limit";
import { nowIso, randomToken, sha256, stamp } from "../util";

export const SESSION_COOKIE = "hr_session";
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const RESET_TTL_MIN = 30;
const INVITE_TTL_HOURS = 72;

const ttlHours = () => Number(process.env.SESSION_TTL_HOURS ?? 12);
const rememberDays = () => Number(process.env.SESSION_REMEMBER_DAYS ?? 30);

export interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

function actorFor(user: User, ip: string | null) {
  return { userId: user.id, role: user.role, name: user.displayName, ip };
}

export async function findUserByIdentifier(identifier: string): Promise<User | null> {
  const users = await col("users");
  const id = identifier.trim();
  if (!id) return null;
  if (id.includes("@")) return users.findOne({ email: id.toLowerCase() });
  return users.findOne({ employeeCode: id.toUpperCase() });
}

export async function login(
  identifier: string,
  password: string,
  remember: boolean,
  meta: ClientMeta,
): Promise<{ token: string; user: User; expiresAt: string }> {
  const ipKey = `login:ip:${meta.ip ?? "unknown"}`;
  const idKey = `login:id:${identifier.trim().toLowerCase()}`;
  if (!hit(ipKey, 30, 15 * 60_000).allowed || !hit(idKey, 10, 15 * 60_000).allowed) {
    await audit({ userId: null, role: null, name: identifier, ip: meta.ip }, { action: "login_rate_limited", module: "auth" });
    throw rateLimited();
  }

  const user = await findUserByIdentifier(identifier);
  const generic = unauthorized("Invalid credentials");

  if (!user) {
    await verifyPassword(password, await getDummyHash());
    await audit({ userId: null, role: null, name: identifier, ip: meta.ip }, { action: "login_failed", module: "auth", reason: "unknown account" });
    throw generic;
  }

  if (user.lockedUntil && user.lockedUntil > nowIso()) {
    await audit(actorFor(user, meta.ip), { action: "login_failed", module: "auth", recordId: user.id, reason: "account locked" });
    throw new AppError(423, "LOCKED", "Account temporarily locked after repeated failed attempts. Try again later.");
  }

  const ok = await verifyPassword(password, user.passwordHash);
  const users = await col("users");
  if (!ok) {
    const failed = user.failedLoginCount + 1;
    const lockedUntil = failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null;
    await users.updateById(user.id, { failedLoginCount: lockedUntil ? 0 : failed, lockedUntil, updatedAt: nowIso() });
    await audit(actorFor(user, meta.ip), {
      action: "login_failed",
      module: "auth",
      recordId: user.id,
      reason: lockedUntil ? "bad password — account locked" : "bad password",
    });
    throw generic;
  }

  if (user.status !== "active") {
    await audit(actorFor(user, meta.ip), { action: "login_failed", module: "auth", recordId: user.id, reason: `account ${user.status}` });
    throw new AppError(403, "FORBIDDEN", user.status === "disabled" ? "This account has been deactivated. Contact your administrator." : "Account not yet activated. Use your invitation link.");
  }

  const token = randomToken();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + (remember ? rememberDays() * 24 : ttlHours()) * 3600_000).toISOString();
  const session: Session = {
    ...stamp(),
    tokenHash: sha256(token),
    userId: user.id,
    expiresAt,
    lastSeenAt: now,
    remember,
    ip: meta.ip,
    userAgent: meta.userAgent?.slice(0, 300) ?? null,
  };
  await (await col("sessions")).insertOne(session);
  const updated = (await users.updateById(user.id, { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now, updatedAt: now }))!;
  await audit(actorFor(user, meta.ip), { action: "login", module: "auth", recordId: user.id });
  return { token, user: updated, expiresAt };
}

/** Validates a session token; slides expiry for non-remembered sessions. */
export async function userFromToken(token: string | undefined | null): Promise<{ user: User; session: Session } | null> {
  if (!token) return null;
  const sessions = await col("sessions");
  const session = await sessions.findOne({ tokenHash: sha256(token) });
  if (!session) return null;
  const now = Date.now();
  if (session.expiresAt <= new Date(now).toISOString()) {
    await sessions.deleteById(session.id);
    return null;
  }
  const user = await (await col("users")).findById(session.userId);
  if (!user || user.status !== "active") {
    await sessions.deleteById(session.id);
    return null;
  }
  // Touch at most every 5 minutes to limit writes.
  if (now - new Date(session.lastSeenAt).getTime() > 5 * 60_000) {
    const patch: Partial<Session> = { lastSeenAt: new Date(now).toISOString() };
    if (!session.remember) patch.expiresAt = new Date(now + ttlHours() * 3600_000).toISOString();
    await sessions.updateById(session.id, patch);
  }
  return { user, session };
}

export async function logout(token: string | undefined | null, ip: string | null) {
  if (!token) return;
  const found = await userFromToken(token);
  const sessions = await col("sessions");
  await sessions.deleteMany({ tokenHash: sha256(token) });
  if (found) await audit(actorFor(found.user, ip), { action: "logout", module: "auth", recordId: found.user.id });
}

export async function revokeSessions(userId: string, exceptTokenHash?: string) {
  const sessions = await col("sessions");
  if (exceptTokenHash) return sessions.deleteMany({ userId, tokenHash: { $ne: exceptTokenHash } });
  return sessions.deleteMany({ userId });
}

/* ----------------------- Reset & invitation tokens ----------------------- */

export async function issueToken(userId: string, type: "reset" | "invite"): Promise<string> {
  const tokens = await col("auth_tokens");
  await tokens.deleteMany({ userId, type, usedAt: null });
  const token = randomToken();
  const ttlMs = type === "reset" ? RESET_TTL_MIN * 60_000 : INVITE_TTL_HOURS * 3600_000;
  await tokens.insertOne({
    ...stamp(),
    userId,
    type,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    usedAt: null,
  });
  return token;
}

export function buildLink(type: "reset" | "invite", token: string) {
  const base = process.env.APP_URL ?? "http://localhost:3000";
  return `${base}/${type === "reset" ? "reset-password" : "accept-invite"}?token=${encodeURIComponent(token)}`;
}

/**
 * Always responds identically whether or not the account exists (no user enumeration).
 * Returns the link only when DEV_SHOW_RESET_LINKS=true (no email service in Phase 1).
 */
export async function requestPasswordReset(identifier: string, meta: ClientMeta): Promise<{ devLink: string | null }> {
  if (!hit(`reset:ip:${meta.ip ?? "unknown"}`, 5, 60 * 60_000).allowed) throw rateLimited();
  const user = await findUserByIdentifier(identifier);
  if (!user || user.status !== "active") {
    await audit({ userId: null, role: null, name: identifier, ip: meta.ip }, { action: "password_reset_requested", module: "auth", reason: "no matching active account" });
    return { devLink: null };
  }
  const token = await issueToken(user.id, "reset");
  await audit(actorFor(user, meta.ip), { action: "password_reset_requested", module: "auth", recordId: user.id });
  const link = buildLink("reset", token);
  if (process.env.DEV_SHOW_RESET_LINKS === "true") return { devLink: link };
  console.info(`[auth] password reset link for ${user.email}: ${link}`);
  return { devLink: null };
}

async function consumeToken(token: string, type: "reset" | "invite") {
  const tokens = await col("auth_tokens");
  const t = await tokens.findOne({ tokenHash: sha256(token), type });
  if (!t || t.usedAt || t.expiresAt <= nowIso()) throw badRequest("This link is invalid or has expired. Please request a new one.");
  return t;
}

export async function peekToken(token: string, type: "reset" | "invite") {
  const t = await consumeToken(token, type);
  const user = await (await col("users")).findById(t.userId);
  return user ? { email: user.email, displayName: user.displayName } : null;
}

export async function completeToken(token: string, type: "reset" | "invite", newPassword: string, meta: ClientMeta) {
  const problem = passwordProblem(newPassword);
  if (problem) throw validationError(problem, { fieldErrors: { password: problem } });
  const t = await consumeToken(token, type);
  const passwordHash = await hashPassword(newPassword);
  await transaction(async () => {
    const tokens = await col("auth_tokens");
    const users = await col("users");
    const user = await users.findById(t.userId);
    if (!user) throw badRequest("Account no longer exists");
    if (type === "reset" && user.status !== "active") throw badRequest("Account is not active");
    const now = nowIso();
    await tokens.updateById(t.id, { usedAt: now });
    await users.updateById(user.id, {
      passwordHash,
      passwordChangedAt: now,
      failedLoginCount: 0,
      lockedUntil: null,
      status: type === "invite" ? "active" : user.status,
      updatedAt: now,
    });
    await revokeSessions(user.id);
    await audit(actorFor(user, meta.ip), { action: type === "invite" ? "invitation_accepted" : "password_reset", module: "auth", recordId: user.id });
  });
}

export async function changePassword(user: User, current: string, next: string, currentTokenHash: string, ip: string | null) {
  if (!(await verifyPassword(current, user.passwordHash))) {
    throw validationError("Current password is incorrect", { fieldErrors: { currentPassword: "Current password is incorrect" } });
  }
  const problem = passwordProblem(next);
  if (problem) throw validationError(problem, { fieldErrors: { newPassword: problem } });
  const now = nowIso();
  await (await col("users")).updateById(user.id, { passwordHash: await hashPassword(next), passwordChangedAt: now, updatedAt: now });
  await revokeSessions(user.id, currentTokenHash);
  await audit(actorFor(user, ip), { action: "password_changed", module: "auth", recordId: user.id });
}
