/**
 * Resolves the effective attendance outcome of one employee on one date.
 * This single function defines the attendance policy for every dashboard,
 * report, export and the finalization job, so their numbers always agree.
 *
 * Precedence:
 *  1. Outside employment window            → not_employed (excluded everywhere)
 *  2. Record with an explicit status        → that status
 *  3. Record with check-in, status pending  → derived from hours (or "in office")
 *  4. Approved leave → Holiday → Weekly off
 *  5. Nothing recorded: Pending until the finalization time, Absent afterwards
 */
import type { AttendanceRecord, AttendanceSettings, AttendanceStatus, DayResult, Employee, Holiday, ISODate, LeaveRecord, StatusCategory } from "./types";
import { computeMetrics, deriveCategory, type Schedule } from "./attendance-calc";
import { CATEGORY_LABELS } from "./constants";
import { addDays, zonedToUtc } from "./time";

export interface DayContext {
  date: ISODate;
  employee: Employee;
  record: AttendanceRecord | null;
  leave: LeaveRecord | null;
  holiday: Holiday | null;
  weeklyOff: boolean;
  schedule: Schedule;
  settings: AttendanceSettings;
  statuses: Map<string, AttendanceStatus>;
  now: Date;
}

export function finalizationInstant(date: ISODate, s: Pick<AttendanceSettings, "finalizeNextDay" | "finalizationTime" | "timezone">): Date {
  return zonedToUtc(s.finalizeNextDay ? addDays(date, 1) : date, s.finalizationTime, s.timezone);
}

export function creditFor(category: StatusCategory | "not_employed", status: AttendanceStatus | undefined, s: AttendanceSettings): number {
  if (status && !status.system && (category === "present" || category === "half_day")) return status.credit;
  switch (category) {
    case "present":
      return s.fullDayCredit;
    case "half_day":
      return s.halfDayCredit;
    case "leave":
      return s.leaveCountsAsPresent ? s.fullDayCredit : 0;
    default:
      return 0;
  }
}

export function isScheduled(category: StatusCategory | "not_employed", s: AttendanceSettings): boolean {
  if (category === "present" || category === "absent" || category === "half_day") return true;
  if (category === "leave") return s.leaveCountsAsPresent;
  return false;
}

export function resolveDay(c: DayContext): DayResult {
  const { employee: emp, schedule, settings } = c;
  const base = {
    date: c.date,
    employeeId: emp.id,
    employeeCode: emp.employeeCode,
    employeeName: emp.fullName,
    departmentId: emp.departmentId,
    officeLocationId: emp.officeLocationId,
    supervisorEmployeeId: emp.supervisorEmployeeId,
    shiftId: schedule.shiftId,
    expectedStart: schedule.startAt.toISOString(),
    expectedEnd: schedule.endAt.toISOString(),
  };
  const empty = {
    checkInAt: null,
    checkOutAt: null,
    workedMinutes: 0,
    hoursOnly: false,
    lateMinutes: 0,
    earlyMinutes: 0,
    isLate: false,
    isEarly: false,
    missingCheckOut: false,
    inOffice: false,
    recordId: null,
    source: null,
    employeeSubmitted: false,
    remarks: "",
  };

  if (c.date < emp.dateOfJoining || (emp.dateOfExit && c.date > emp.dateOfExit)) {
    return { ...base, ...empty, category: "not_employed", statusCode: "", statusLabel: CATEGORY_LABELS.not_employed, credit: 0, scheduled: false, finalized: true };
  }

  if (settings.attendanceStartDate && c.date < settings.attendanceStartDate && !(c.record && !c.record.voided)) {
    return { ...base, ...empty, category: "not_employed", statusCode: "", statusLabel: "Not tracked (before go-live)", credit: 0, scheduled: false, finalized: true };
  }

  const rec = c.record && !c.record.voided ? c.record : null;
  const isFinal = c.now >= finalizationInstant(c.date, settings) || rec?.state === "finalized";
  const hasIn = !!rec?.checkInAt;
  const hasOut = !!rec?.checkOutAt;
  const metrics = rec ? computeMetrics(rec.checkInAt, rec.checkOutAt, schedule, rec.reportedMinutes ?? null) : null;
  const recStatus = rec ? c.statuses.get(rec.statusCode) : undefined;
  const recCategory: StatusCategory | null = rec ? (recStatus?.category ?? "pending") : null;

  let category: StatusCategory;
  let statusCode: string;
  let missingCheckOut = false;
  let inOffice = false;

  if (rec && recCategory && recCategory !== "pending") {
    category = recCategory;
    statusCode = rec.statusCode;
    if (hasIn && !hasOut && (category === "present" || category === "half_day")) {
      inOffice = !isFinal && c.now >= new Date(rec.checkInAt!);
      missingCheckOut = isFinal || c.now > schedule.endAt;
    }
  } else if (rec && hasIn) {
    if (hasOut) {
      category = deriveCategory(metrics!.workedMinutes, rec.checkInAt, schedule);
    } else if (!isFinal) {
      category = "present";
      inOffice = c.now >= new Date(rec.checkInAt!);
      missingCheckOut = c.now > schedule.endAt;
    } else {
      missingCheckOut = true;
      category = settings.missingCheckoutPolicy === "flag" ? "present" : settings.missingCheckoutPolicy;
    }
    statusCode = category;
  } else if (rec && metrics?.hoursOnly) {
    category = deriveCategory(metrics.workedMinutes, null, schedule);
    statusCode = category;
  } else if (c.leave) {
    category = "leave";
    statusCode = "leave";
  } else if (c.holiday) {
    category = "holiday";
    statusCode = "holiday";
  } else if (c.weeklyOff) {
    category = "weekly_off";
    statusCode = "weekly_off";
  } else {
    category = isFinal ? "absent" : "pending";
    statusCode = category;
  }

  const status = c.statuses.get(statusCode);
  let statusLabel = status?.label ?? CATEGORY_LABELS[category];
  if (category === "pending" && !rec?.checkInAt) statusLabel = "Not Checked In";
  if (category === "holiday" && c.holiday && !rec) statusLabel = `Holiday — ${c.holiday.name}`;

  return {
    ...base,
    category,
    statusCode,
    statusLabel,
    credit: creditFor(category, status, settings),
    scheduled: isScheduled(category, settings),
    checkInAt: rec?.checkInAt ?? null,
    checkOutAt: rec?.checkOutAt ?? null,
    workedMinutes: metrics?.workedMinutes ?? 0,
    hoursOnly: metrics?.hoursOnly ?? false,
    lateMinutes: metrics?.lateMinutes ?? 0,
    earlyMinutes: hasOut ? (metrics?.earlyMinutes ?? 0) : 0,
    isLate: metrics?.isLate ?? false,
    isEarly: hasOut ? (metrics?.isEarly ?? false) : false,
    missingCheckOut,
    inOffice,
    finalized: isFinal,
    recordId: rec?.id ?? null,
    source: rec?.source ?? null,
    employeeSubmitted: rec?.employeeSubmitted ?? false,
    remarks: rec?.remarks ?? "",
  };
}
