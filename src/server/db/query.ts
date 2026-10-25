import type { FieldOps, Filter, FindOptions } from "./types";

/** In-memory evaluator for the Mongo-compatible filter subset used across the app. */

function getPath(doc: unknown, path: string): unknown {
  let cur: unknown = doc;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function isOps(v: unknown): v is FieldOps {
  return v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).some((k) => k.startsWith("$"));
}

function eq(a: unknown, b: unknown): boolean {
  // Mongo semantics: { field: null } matches null or missing
  if (b === null) return a === null || a === undefined;
  if (Array.isArray(a) && !Array.isArray(b)) return a.some((x) => x === b);
  return a === b;
}

function cmp(a: unknown, b: unknown): number | null {
  if (a == null || b == null) return null;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

function matchOps(value: unknown, ops: FieldOps): boolean {
  for (const [op, arg] of Object.entries(ops)) {
    switch (op) {
      case "$eq":
        if (!eq(value, arg)) return false;
        break;
      case "$ne":
        if (eq(value, arg)) return false;
        break;
      case "$in":
        if (!(arg as unknown[]).some((x) => eq(value, x))) return false;
        break;
      case "$nin":
        if ((arg as unknown[]).some((x) => eq(value, x))) return false;
        break;
      case "$gt": {
        const c = cmp(value, arg);
        if (c === null || c <= 0) return false;
        break;
      }
      case "$gte": {
        const c = cmp(value, arg);
        if (c === null || c < 0) return false;
        break;
      }
      case "$lt": {
        const c = cmp(value, arg);
        if (c === null || c >= 0) return false;
        break;
      }
      case "$lte": {
        const c = cmp(value, arg);
        if (c === null || c > 0) return false;
        break;
      }
      case "$exists":
        if ((value !== undefined) !== arg) return false;
        break;
      case "$regex": {
        if (typeof value !== "string") return false;
        if (!new RegExp(arg as string, ops.$options ?? "").test(value)) return false;
        break;
      }
      case "$options":
        break;
      default:
        throw new Error(`Unsupported query operator ${op}`);
    }
  }
  return true;
}

export function matches<T>(doc: T, filter: Filter<T> | undefined): boolean {
  if (!filter) return true;
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "$or") {
      if (!(cond as Filter<T>[]).some((f) => matches(doc, f))) return false;
      continue;
    }
    if (key === "$and") {
      if (!(cond as Filter<T>[]).every((f) => matches(doc, f))) return false;
      continue;
    }
    const value = getPath(doc, key);
    if (isOps(cond)) {
      if (!matchOps(value, cond)) return false;
    } else if (!eq(value, cond)) {
      return false;
    }
  }
  return true;
}

export function applyOptions<T>(docs: T[], options?: FindOptions<T>): T[] {
  let out = docs;
  if (options?.sort) {
    const entries = Object.entries(options.sort) as [string, 1 | -1][];
    out = [...out].sort((a, b) => {
      for (const [field, dir] of entries) {
        const av = getPath(a, field);
        const bv = getPath(b, field);
        if (av === bv) continue;
        if (av == null) return -1 * dir;
        if (bv == null) return 1 * dir;
        return (av < bv ? -1 : 1) * dir;
      }
      return 0;
    });
  }
  const skip = options?.skip ?? 0;
  const limit = options?.limit;
  if (skip || limit !== undefined) out = out.slice(skip, limit !== undefined ? skip + limit : undefined);
  return out;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
