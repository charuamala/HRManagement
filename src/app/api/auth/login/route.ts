import { NextResponse } from "next/server";
import { body, clientIp, errorResponse } from "@/server/http";
import { loginSchema } from "@/lib/schemas";
import { login, SESSION_COOKIE } from "@/server/auth/service";

export async function POST(req: import("next/server").NextRequest) {
  try {
    const input = await body(req, loginSchema);
    const { token, user, expiresAt } = await login(input.identifier, input.password, input.remember, {
      ip: clientIp(req),
      userAgent: req.headers.get("user-agent"),
    });
    const res = NextResponse.json({ ok: true, data: { role: user.role, displayName: user.displayName, redirect: "/dashboard" } });
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.COOKIE_SECURE === "true",
      path: "/",
      ...(input.remember ? { expires: new Date(expiresAt) } : {}),
    });
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
