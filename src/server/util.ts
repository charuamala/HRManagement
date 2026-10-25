import crypto from "crypto";

export const newId = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

export function sha256(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** Shallow diff: returns only the keys whose values changed. */
export function diff<T extends object>(before: T, after: Partial<T>): { old: Partial<T>; new: Partial<T> } | null {
  const o: Partial<T> = {};
  const n: Partial<T> = {};
  let changed = false;
  for (const k of Object.keys(after) as (keyof T)[]) {
    if (k === "updatedAt" || k === "version") continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      o[k] = before[k];
      n[k] = after[k] as T[keyof T];
      changed = true;
    }
  }
  return changed ? { old: o, new: n } : null;
}

export function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) out[k] = obj[k];
  return out;
}

export function stamp() {
  const now = nowIso();
  return { id: newId(), createdAt: now, updatedAt: now };
}
