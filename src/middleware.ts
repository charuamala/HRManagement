import { NextResponse, type NextRequest } from "next/server";

/** Cheap edge guard: no session cookie → login. Real validation happens server-side per request. */
const PUBLIC = ["/login", "/forgot-password", "/reset-password", "/accept-invite"];

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // Behind Cloudflare: plain-http visitors are sent to https (session cookies are Secure there).
  const host = req.headers.get("host") ?? "";
  const visitorScheme = /"scheme":"(\w+)"/.exec(req.headers.get("cf-visitor") ?? "")?.[1];
  if (visitorScheme === "http" && !LOCAL_HOSTS.test(host)) {
    const url = req.nextUrl.clone();
    url.protocol = "https:";
    url.host = host;
    url.port = "";
    return NextResponse.redirect(url, 308);
  }
  if (pathname.startsWith("/api") || PUBLIC.some((p) => pathname.startsWith(p))) return NextResponse.next();
  if (!req.cookies.get("hr_session")) {
    // Use the visitor's host/scheme: behind the tunnel nextUrl's host is the local listener, not the public domain.
    const origin = host ? `${visitorScheme ?? req.nextUrl.protocol.replace(":", "")}://${host}` : req.nextUrl.origin;
    return NextResponse.redirect(new URL(`${req.nextUrl.basePath}/login`, origin));
  }
  return NextResponse.next();
}

export const config = { matcher: ["/", "/((?!_next/|favicon.ico).*)"] };
