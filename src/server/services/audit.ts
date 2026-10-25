import { col, transaction, DuplicateKeyError } from "../db";
import type { AuditLog, ID, RoleKey } from "@/lib/types";
import { newId, nowIso, sha256 } from "../util";

/**
 * Append-only, hash-chained audit trail. Each entry stores the hash of the previous
 * entry, so any modification or deletion of history is detectable via verifyChain().
 * The audit_logs collection is flagged append-only at the driver level and the API
 * exposes no update/delete endpoints.
 */
export interface AuditActor {
  userId: ID | null;
  role: RoleKey | null;
  name: string | null;
  ip?: string | null;
}

export interface AuditEntry {
  action: string;
  module: string;
  recordId?: ID | null;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  reason?: string | null;
  importId?: ID | null;
}

const SENSITIVE = /password|token|hash|aadhaarEnc|aadhaarNumber|^data$/i;

function scrub(v: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!v) return null;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) out[k] = SENSITIVE.test(k) ? "[redacted]" : val;
  return out;
}

function entryHash(e: Omit<AuditLog, "hash">): string {
  return sha256(
    JSON.stringify([e.seq, e.prevHash, e.at, e.userId, e.action, e.module, e.recordId, e.oldValues, e.newValues, e.reason, e.importId]),
  );
}

export async function audit(actor: AuditActor | null, entry: AuditEntry): Promise<AuditLog> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await transaction(async () => {
        const c = await col("audit_logs");
        const [last] = await c.find({}, { sort: { seq: -1 }, limit: 1 });
        const now = nowIso();
        const base: Omit<AuditLog, "hash"> = {
          id: newId(),
          createdAt: now,
          updatedAt: now,
          at: now,
          userId: actor?.userId ?? null,
          userRole: actor?.role ?? null,
          userName: actor?.name ?? null,
          action: entry.action,
          module: entry.module,
          recordId: entry.recordId ?? null,
          oldValues: scrub(entry.oldValues),
          newValues: scrub(entry.newValues),
          reason: entry.reason ?? null,
          importId: entry.importId ?? null,
          ip: actor?.ip ?? null,
          seq: (last?.seq ?? 0) + 1,
          prevHash: last?.hash ?? "GENESIS",
        };
        return c.insertOne({ ...base, hash: entryHash(base) });
      });
    } catch (e) {
      if (e instanceof DuplicateKeyError && attempt < 5) continue;
      throw e;
    }
  }
}

export async function verifyChain(): Promise<{ ok: boolean; checked: number; brokenAtSeq: number | null }> {
  const c = await col("audit_logs");
  const all = await c.find({}, { sort: { seq: 1 } });
  let prev = "GENESIS";
  for (const e of all) {
    const { hash, ...rest } = e;
    if (e.prevHash !== prev || entryHash(rest) !== hash) return { ok: false, checked: all.length, brokenAtSeq: e.seq };
    prev = hash;
  }
  return { ok: true, checked: all.length, brokenAtSeq: null };
}
