import { col, transaction } from "../db";
import type { CorrectionRequest, CorrectionValues, ID, ISODate } from "@/lib/types";
import { addDays, dateInTz, diffDays, timeInTz, todayInTz } from "@/lib/time";
import { conflict, forbidden, notFound, validationError, badRequest } from "../errors";
import { actorOf, assertCanManage, can, canManage, requirePerm, type AuthContext } from "../auth/context";
import { audit } from "./audit";
import { notify } from "./notifications";
import { DayResolver } from "./days";
import { employedOn, insertRecord, isLocked, prepareEntry, updateRecord } from "./attendance";
import { nowIso, stamp } from "../util";
import { loadLookups, empName } from "./lookups";

export interface CorrectionInput {
  date: ISODate;
  statusCode?: string;
  checkIn?: string | null;
  checkOut?: string | null;
  workedHours?: number | null;
  remarks?: string;
  reason: string;
}

async function reviewersFor(employeeId: ID): Promise<ID[]> {
  const [emp, users, assignments] = await Promise.all([
    (await col("employees")).findById(employeeId),
    (await col("users")).find({ status: "active" }),
    (await col("supervisor_assignments")).find(),
  ]);
  const ids = new Set<ID>();
  for (const u of users) if (u.role === "admin") ids.add(u.id);
  if (emp?.supervisorEmployeeId) {
    const sup = users.find((u) => u.employeeId === emp.supervisorEmployeeId);
    if (sup) ids.add(sup.id);
  }
  for (const a of assignments) {
    if ((a.scopeType === "employee" && a.employeeId === employeeId) || (a.scopeType === "department" && emp && a.departmentId === emp.departmentId)) {
      ids.add(a.supervisorUserId);
    }
  }
  return [...ids];
}

/** Employee-submitted correction for their own attendance. */
export async function createCorrection(ctx: AuthContext, input: CorrectionInput) {
  requirePerm(ctx, "corrections.create");
  const employeeId = ctx.scope.selfId;
  if (!employeeId) throw badRequest("Your account is not linked to an employee record");
  const s = ctx.settings;
  const today = todayInTz(s.timezone);
  if (input.date > today) throw validationError("Corrections cannot be requested for future dates", { fieldErrors: { date: "Future date" } });
  if (diffDays(input.date, today) > s.correctionWindowDays) {
    throw validationError(`Corrections can only be requested within ${s.correctionWindowDays} days`, { fieldErrors: { date: "Outside correction window" } });
  }
  const emp = await (await col("employees")).findById(employeeId);
  if (!emp) throw notFound("Employee");
  const employment = employedOn(emp, input.date);
  if (employment) throw validationError(employment);

  const corrections = await col("attendance_correction_requests");
  if (await corrections.findOne({ employeeId, date: input.date, status: "pending" })) {
    throw conflict("You already have a pending correction request for this date");
  }
  const rec = await (await col("attendance_records")).findOne({ employeeId, date: input.date, segment: 1, voided: false });
  const resolver = await DayResolver.load([employeeId], input.date, addDays(input.date, 1));
  const day = resolver.resolve(emp, input.date);
  const tz = s.timezone;
  const wall = (iso: string | null) => (iso ? timeInTz(iso, tz) : null);
  const checkIn = input.checkIn !== undefined ? input.checkIn : wall(rec?.checkInAt ?? null);
  let statusCode = input.statusCode || rec?.statusCode || day.statusCode;
  const cat = resolver.statuses.get(statusCode)?.category;
  // Adding times to an absent/unmarked day: let the hours decide the status.
  if (!input.statusCode && checkIn && cat && !["present", "half_day", "pending"].includes(cat)) statusCode = "pending";
  const merged = {
    statusCode,
    checkIn,
    checkOut: input.checkOut !== undefined ? input.checkOut : wall(rec?.checkOutAt ?? null),
    checkOutDate: input.checkOut === undefined && rec?.checkOutAt ? dateInTz(rec.checkOutAt, tz) : null,
    workedHours:
      input.workedHours !== undefined ? input.workedHours : checkIn ? null : rec?.reportedMinutes != null ? rec.reportedMinutes / 60 : null,
  };
  // Employees can't hold attendance.create, so validate as the system policy would for a reviewer.
  const { value, errors } = prepareEntry(ctx, emp, input.date, merged, resolver);
  if (!value) throw validationError(Object.values(errors)[0], { fieldErrors: errors });

  const original: CorrectionValues | null = rec
    ? { statusCode: rec.statusCode, checkInAt: rec.checkInAt, checkOutAt: rec.checkOutAt, reportedMinutes: rec.reportedMinutes, remarks: rec.remarks }
    : null;
  const requested: CorrectionValues = {
    statusCode: value.statusCode,
    checkInAt: value.checkInAt,
    checkOutAt: value.checkOutAt,
    reportedMinutes: value.reportedMinutes,
    remarks: input.remarks ?? rec?.remarks ?? "",
  };
  if (original && JSON.stringify(original) === JSON.stringify(requested)) throw badRequest("The requested values are identical to the current record");

  const req: CorrectionRequest = {
    ...stamp(),
    attendanceId: rec?.id ?? null,
    employeeId,
    date: input.date,
    original,
    requested,
    reason: input.reason,
    requestedBy: ctx.user.id,
    status: "pending",
    reviewedBy: null,
    reviewedAt: null,
    reviewComment: "",
  };
  await transaction(async () => {
    await corrections.insertOne(req);
    await audit(actorOf(ctx), { action: "correction_requested", module: "corrections", recordId: req.id, oldValues: original as Record<string, unknown> | null, newValues: requested as Record<string, unknown>, reason: input.reason });
  });
  await notify(await reviewersFor(employeeId), {
    type: "correction_submitted",
    title: "Correction request submitted",
    message: `${emp.fullName} requested a correction for ${input.date}.`,
    link: `/corrections?id=${req.id}`,
  });
  return req;
}

export async function listCorrections(ctx: AuthContext, opts: { status?: string; mine?: boolean } = {}) {
  requirePerm(ctx, "corrections.view", "corrections.create", "corrections.approve");
  const c = await col("attendance_correction_requests");
  const filter = opts.status ? { status: opts.status as CorrectionRequest["status"] } : {};
  const all = await c.find(filter, { sort: { createdAt: -1 } });
  const reviewer = can(ctx, "corrections.approve");
  const rows = all.filter((r) => r.employeeId === ctx.scope.selfId || (!opts.mine && reviewer && canManage(ctx, r.employeeId)));
  const lookups = await loadLookups();
  const users = new Map((await (await col("users")).find()).map((u) => [u.id, u.displayName]));
  return rows.map((r) => ({
    ...r,
    employeeName: empName(lookups, r.employeeId),
    employeeCode: lookups.employees.get(r.employeeId)?.employeeCode ?? "",
    requestedByName: users.get(r.requestedBy) ?? "—",
    reviewedByName: r.reviewedBy ? (users.get(r.reviewedBy) ?? "—") : null,
    canDecide: r.status === "pending" && reviewer && canManage(ctx, r.employeeId),
    canCancel: r.status === "pending" && r.requestedBy === ctx.user.id,
  }));
}

export async function decideCorrection(ctx: AuthContext, id: ID, decision: "approved" | "rejected", comment: string) {
  requirePerm(ctx, "corrections.approve");
  const c = await col("attendance_correction_requests");
  const req = await c.findById(id);
  if (!req) throw notFound("Correction request");
  if (req.status !== "pending") throw conflict(`This request was already ${req.status}`);
  assertCanManage(ctx, req.employeeId);
  if (req.requestedBy === ctx.user.id) throw forbidden("You cannot review your own request");
  if (decision === "rejected" && comment.trim().length < 3) throw validationError("Please give a reason for rejecting", { fieldErrors: { comment: "Required" } });

  const emp = await (await col("employees")).findById(req.employeeId);
  if (!emp) throw notFound("Employee");
  if (decision === "approved" && isLocked(req.date, ctx) && !can(ctx, "attendance.manage")) {
    throw forbidden("The attendance date is locked. An administrator must approve this request.");
  }

  const result = await transaction(async () => {
    let attendanceId = req.attendanceId;
    if (decision === "approved") {
      const resolver = await DayResolver.load([emp.id], req.date, addDays(req.date, 1));
      const tz = ctx.settings.timezone;
      const wall = (iso: string | null | undefined) => (iso ? timeInTz(iso, tz) : null);
      const { value, errors } = prepareEntry(
        ctx,
        emp,
        req.date,
        {
          statusCode: req.requested.statusCode!,
          checkIn: wall(req.requested.checkInAt),
          checkOut: wall(req.requested.checkOutAt),
          checkOutDate: req.requested.checkOutAt ? dateInTz(req.requested.checkOutAt, tz) : null,
          workedHours: req.requested.reportedMinutes != null ? req.requested.reportedMinutes / 60 : null,
        },
        resolver,
      );
      if (!value) throw validationError(`Cannot apply: ${Object.values(errors)[0]}`, { fieldErrors: errors });
      const current = await (await col("attendance_records")).findOne({ employeeId: emp.id, date: req.date, segment: 1, voided: false });
      const meta = { source: "correction" as const, remarks: req.requested.remarks, reason: `Correction ${req.id}: ${req.reason}`, quiet: true };
      const saved = current ? await updateRecord(ctx, current, value, meta) : await insertRecord(ctx, emp, req.date, value, meta);
      attendanceId = saved.id;
    }
    const updated = (await c.updateById(id, {
      status: decision,
      reviewedBy: ctx.user.id,
      reviewedAt: nowIso(),
      reviewComment: comment,
      attendanceId,
      updatedAt: nowIso(),
    }))!;
    await audit(actorOf(ctx), {
      action: decision === "approved" ? "correction_approved" : "correction_rejected",
      module: "corrections",
      recordId: id,
      oldValues: req.original as Record<string, unknown> | null,
      newValues: req.requested as Record<string, unknown>,
      reason: comment || null,
    });
    return updated;
  });

  await notify([req.requestedBy], {
    type: decision === "approved" ? "correction_approved" : "correction_rejected",
    title: decision === "approved" ? "Correction approved" : "Correction rejected",
    message: `Your correction for ${req.date} was ${decision} by ${ctx.user.displayName}${comment ? `: ${comment}` : "."}`,
    link: `/corrections?id=${id}`,
  });
  return result;
}

export async function cancelCorrection(ctx: AuthContext, id: ID) {
  const c = await col("attendance_correction_requests");
  const req = await c.findById(id);
  if (!req) throw notFound("Correction request");
  if (req.requestedBy !== ctx.user.id) throw forbidden();
  if (req.status !== "pending") throw conflict(`This request was already ${req.status}`);
  const saved = await c.updateById(id, { status: "cancelled", updatedAt: nowIso() });
  await audit(actorOf(ctx), { action: "correction_cancelled", module: "corrections", recordId: id });
  return saved;
}
