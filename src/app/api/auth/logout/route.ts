import { NextResponse, type NextRequest } from "next/server";
import { clientIp } from "@/server/http";
import { logout, SESSION_COOKIE } from "@/server/auth/service";
import { BASE_PATH } from "@/lib/base-path";

export async function POST(req: NextRequest) {
  await logout(req.cookies.get(SESSION_COOKIE)?.value, clientIp(req));
  const res = NextResponse.json({ ok: true, data: null });
  res.cookies.set(SESSION_COOKIE, "", { path: BASE_PATH || "/", maxAge: 0 });
  return res;
}
