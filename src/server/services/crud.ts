import { col, transaction, type CollectionName, type DocMap } from "../db";
import { notFound } from "../errors";
import { actorOf, type AuthContext } from "../auth/context";
import { audit } from "./audit";
import { diff, nowIso, stamp } from "../util";

/** Generic audited create/update/delete used by simple reference-data modules. */

export async function createAudited<K extends CollectionName>(
  ctx: AuthContext,
  name: K,
  module: string,
  data: Omit<DocMap[K], "id" | "createdAt" | "updatedAt">,
): Promise<DocMap[K]> {
  return transaction(async () => {
    const doc = { ...stamp(), ...data } as DocMap[K];
    const saved = await (await col(name)).insertOne(doc);
    await audit(actorOf(ctx), { action: "create", module, recordId: saved.id, newValues: saved as unknown as Record<string, unknown> });
    return saved;
  });
}

export async function updateAudited<K extends CollectionName>(
  ctx: AuthContext,
  name: K,
  module: string,
  id: string,
  patch: Partial<DocMap[K]>,
  reason?: string,
): Promise<DocMap[K]> {
  return transaction(async () => {
    const c = await col(name);
    const before = await c.findById(id);
    if (!before) throw notFound();
    const d = diff(before, patch);
    if (!d) return before;
    const saved = (await c.updateById(id, { ...patch, updatedAt: nowIso() } as Partial<DocMap[K]>))!;
    await audit(actorOf(ctx), {
      action: "update",
      module,
      recordId: id,
      oldValues: d.old as Record<string, unknown>,
      newValues: d.new as Record<string, unknown>,
      reason,
    });
    return saved;
  });
}

export async function deleteAudited<K extends CollectionName>(ctx: AuthContext, name: K, module: string, id: string): Promise<void> {
  await transaction(async () => {
    const c = await col(name);
    const before = await c.findById(id);
    if (!before) throw notFound();
    await c.deleteById(id);
    await audit(actorOf(ctx), { action: "delete", module, recordId: id, oldValues: before as unknown as Record<string, unknown> });
  });
}
