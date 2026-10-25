import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { SESSION_COOKIE, userFromToken } from "./service";
import { buildAuthContext, can, type AuthContext } from "./context";
import type { PermissionKey } from "@/lib/permissions";

/** Server-component auth: resolves the session once per render pass. */
export const getPageAuth = cache(async (): Promise<AuthContext | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const found = await userFromToken(token);
  if (!found) return null;
  const h = await headers();
  return buildAuthContext(found.user, h.get("x-forwarded-for")?.split(",")[0] ?? null);
});

export async function requirePageAuth(): Promise<AuthContext> {
  const auth = await getPageAuth();
  if (!auth) redirect("/login");
  return auth;
}

/** Blocks direct-URL access to screens the user isn't authorised for. */
export async function requirePagePermission(...perms: PermissionKey[]): Promise<AuthContext> {
  const auth = await requirePageAuth();
  if (perms.length && !perms.some((p) => can(auth, p))) redirect("/forbidden");
  return auth;
}
