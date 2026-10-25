import { col } from "../db";
import type { AuditLog } from "@/lib/types";
import { requirePerm, type AuthContext } from "../auth/context";
import { verifyChain } from "./audit";
import { escapeRegex } from "../db/query";
import type { Filter } from "../db/types";

export interface AuditQuery {
  module?: string;
  action?: string;
  userId?: string;
  recordId?: string;
  from?: string;
  to?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function listAuditLogs(ctx: AuthContext, q: AuditQuery) {
  requirePerm(ctx, "audit_logs.view");
  const c = await col("audit_logs");
  const filter: Filter<AuditLog> = {};
  if (q.module) filter.module = q.module;
  if (q.action) filter.action = q.action;
  if (q.userId) filter.userId = q.userId;
  if (q.recordId) filter.recordId = q.recordId;
  if (q.from || q.to) {
    filter.at = {};
    if (q.from) (filter.at as Record<string, string>).$gte = `${q.from}T00:00:00.000Z`;
    if (q.to) (filter.at as Record<string, string>).$lte = `${q.to}T23:59:59.999Z`;
  }
  if (q.search) {
    const rx = escapeRegex(q.search);
    filter.$or = [{ userName: { $regex: rx, $options: "i" } }, { action: { $regex: rx, $options: "i" } }, { reason: { $regex: rx, $options: "i" } }, { recordId: q.search }];
  }
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? 50;
  const [items, total] = await Promise.all([c.find(filter, { sort: { seq: -1 }, skip: (page - 1) * pageSize, limit: pageSize }), c.count(filter)]);
  return { items, total, page, pageSize };
}

export async function auditFacets(ctx: AuthContext) {
  requirePerm(ctx, "audit_logs.view");
  const all = await (await col("audit_logs")).find();
  return {
    modules: [...new Set(all.map((a) => a.module))].sort(),
    actions: [...new Set(all.map((a) => a.action))].sort(),
  };
}

export async function verifyAudit(ctx: AuthContext) {
  requirePerm(ctx, "audit_logs.view");
  return verifyChain();
}
