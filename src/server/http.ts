import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError, type ZodType } from "zod";
import { AppError, forbidden, unauthorized, validationError, badRequest } from "./errors";
import { DuplicateKeyError } from "./db";
import { SESSION_COOKIE, userFromToken } from "./auth/service";
import { buildAuthContext, requirePerm, type AuthContext } from "./auth/context";
import type { PermissionKey } from "@/lib/permissions";

/**
 * Uniform API envelope:
 *   success → { ok: true, data }
 *   failure → { ok: false, error: { code, message, details? } }
 */
export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, init);
}

export function errorResponse(e: unknown) {
  if (e instanceof AppError) {
    return NextResponse.json({ ok: false, error: { code: e.code, message: e.message, details: e.details ?? null } }, { status: e.status });
  }
  if (e instanceof ZodError) {
    const v = zodToValidation(e);
    return NextResponse.json({ ok: false, error: { code: v.code, message: v.message, details: v.details } }, { status: 422 });
  }
  if (e instanceof DuplicateKeyError) {
    return NextResponse.json(
      { ok: false, error: { code: "CONFLICT", message: `A record with the same ${e.fields.join(" + ")} already exists`, details: { fields: e.fields } } },
      { status: 409 },
    );
  }
  console.error("[api] unhandled error", e);
  return NextResponse.json({ ok: false, error: { code: "INTERNAL_ERROR", message: "Unexpected server error", details: null } }, { status: 500 });
}

export function zodToValidation(e: ZodError): AppError {
  const fieldErrors: Record<string, string> = {};
  for (const issue of e.issues) {
    const key = issue.path.join(".") || "_";
    fieldErrors[key] ??= issue.message;
  }
  const first = Object.entries(fieldErrors)[0];
  return validationError(first ? `${first[0] === "_" ? "" : first[0] + ": "}${first[1]}` : "Invalid input", { fieldErrors });
}

export function parse<S extends ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) throw zodToValidation(r.error);
  return r.data;
}

const MAX_JSON_BYTES = 2 * 1024 * 1024;

export async function body<S extends ZodType>(req: NextRequest, schema: S): Promise<z.infer<S>> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_JSON_BYTES) throw badRequest("Request body too large");
  let json: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_JSON_BYTES) throw badRequest("Request body too large");
    json = text ? JSON.parse(text) : {};
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw badRequest("Malformed JSON body");
  }
  return parse(schema, json);
}

/** Query string → plain object. Repeated keys and comma-separated values become arrays for keys ending in "s" or listed in `arrays`. */
export function query<S extends ZodType>(req: NextRequest, schema: S, arrays: string[] = []): z.infer<S> {
  const sp = req.nextUrl.searchParams;
  const obj: Record<string, unknown> = {};
  for (const key of new Set(sp.keys())) {
    const values = sp.getAll(key);
    if (arrays.includes(key)) obj[key] = values.flatMap((v) => v.split(",")).filter(Boolean);
    else obj[key] = values[values.length - 1];
  }
  return parse(schema, obj);
}

export function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : null) || req.headers.get("x-real-ip") || null;
}

/** CSRF defence for cookie-authenticated mutations: Origin (or Referer) must match Host. */
function sameOrigin(req: NextRequest): boolean {
  const source = req.headers.get("origin") ?? req.headers.get("referer");
  if (!source) return true; // non-browser clients (curl, tests) — SameSite=Lax cookie still applies
  try {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    return new URL(source).host === host;
  } catch {
    return false;
  }
}

type Params = Record<string, string>;
type RouteCtx = { params: Promise<Params> };

export async function authenticate(req: NextRequest): Promise<AuthContext> {
  const found = await userFromToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!found) throw unauthorized("Your session has expired. Please sign in again.");
  return buildAuthContext(found.user, clientIp(req));
}

export function route<P extends Params = Params>(
  opts: { permission?: PermissionKey | PermissionKey[] },
  fn: (req: NextRequest, c: { params: P; auth: AuthContext }) => Promise<unknown>,
) {
  return async (req: NextRequest, context: RouteCtx) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) throw forbidden("Cross-origin request rejected");
      const auth = await authenticate(req);
      if (opts.permission) requirePerm(auth, ...(Array.isArray(opts.permission) ? opts.permission : [opts.permission]));
      const params = ((await context?.params) ?? {}) as P;
      const result = await fn(req, { params, auth });
      if (result instanceof Response) return result;
      return ok(result ?? null);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function publicRoute(fn: (req: NextRequest) => Promise<unknown>) {
  return async (req: NextRequest) => {
    try {
      if (req.method !== "GET" && !sameOrigin(req)) throw forbidden("Cross-origin request rejected");
      const result = await fn(req);
      if (result instanceof Response) return result;
      return ok(result ?? null);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function fileResponse(data: Buffer | Uint8Array | string, filename: string, contentType: string) {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return new Response(bytes as BodyInit, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename.replace(/[^\w.\-]/g, "_")}"`,
      "Cache-Control": "no-store",
    },
  });
}
