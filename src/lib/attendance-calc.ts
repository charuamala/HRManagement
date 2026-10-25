/**
 * Pure attendance calculations — shared by the API, reports, import validation
 * and the client-side form preview so every screen computes identical numbers.
 */
import type { AttendanceSettings, Employee, ISODate, Shift, StatusCategory, TimeOfDay } from "./types";
import { addDays, minutesBetween, zonedToUtc } from "./time";

export interface Schedule {
  shiftId: string | null;
  startTime: TimeOfDay;
  endTime: TimeOfDay;
  startAt: Date;
  endAt: Date;
  overnight: boolean;
  graceMinutes: number;
  fullDayMinutes: number;
  halfDayMinutes: number;
  /** Check-ins after this instant cannot earn more than half-day credit. */
  cutoffAt: Date;
}

type EmpSched = Pick<Employee, "expectedEntryTime" | "expectedExitTime" | "standardWorkingHours">;
type SettingsSched = Pick<AttendanceSettings, "timezone" | "graceMinutes" | "fullDayHours" | "halfDayHours" | "attendanceCutoffTime">;

export const FALLBACK_START = "09:00";
export const FALLBACK_END = "18:00";

export function buildSchedule(date: ISODate, shift: Shift | null, emp: EmpSched | null, settings: SettingsSched): Schedule {
  const startTime = emp?.expectedEntryTime || shift?.startTime || FALLBACK_START;
  const endTime = emp?.expectedExitTime || shift?.endTime || FALLBACK_END;
  const overnight = endTime <= startTime;
  const tz = settings.timezone;
  const startAt = zonedToUtc(date, startTime, tz);
  const endAt = zonedToUtc(overnight ? addDays(date, 1) : date, endTime, tz);
  const fullDayMinutes = Math.round((emp?.standardWorkingHours ?? shift?.fullDayHours ?? settings.fullDayHours) * 60);
  const halfDayMinutes = Math.round((shift?.halfDayHours ?? settings.halfDayHours) * 60);
  // Day shifts use the organisation cut-off clock time; overnight shifts use the same offset from their start.
  let cutoffAt: Date;
  const orgCutoff = zonedToUtc(date, settings.attendanceCutoffTime, tz);
  if (!overnight && orgCutoff > startAt) cutoffAt = orgCutoff;
  else cutoffAt = new Date(startAt.getTime() + Math.max(halfDayMinutes, 60) * 60000);
  return {
    shiftId: shift?.id ?? null,
    startTime,
    endTime,
    startAt,
    endAt,
    overnight,
    graceMinutes: shift?.graceMinutes ?? settings.graceMinutes,
    fullDayMinutes,
    halfDayMinutes,
    cutoffAt,
  };
}

export interface Metrics {
  workedMinutes: number;
  /** Worked time came from reported hours rather than timestamps. */
  hoursOnly: boolean;
  lateMinutes: number;
  earlyMinutes: number;
  isLate: boolean;
  isEarly: boolean;
}

/**
 * Timestamps are the source of truth. Reported minutes (hours-only entries) are used
 * only when no entry time exists; late/early cannot be derived for those.
 */
export function computeMetrics(checkInAt: string | null, checkOutAt: string | null, s: Schedule, reportedMinutes: number | null = null): Metrics {
  if (!checkInAt && reportedMinutes != null) {
    return { workedMinutes: Math.max(0, Math.round(reportedMinutes)), hoursOnly: true, lateMinutes: 0, earlyMinutes: 0, isLate: false, isEarly: false };
  }
  const worked = checkInAt && checkOutAt ? Math.max(0, minutesBetween(checkInAt, checkOutAt)) : 0;
  const lateRaw = checkInAt ? Math.max(0, minutesBetween(s.startAt, checkInAt)) : 0;
  const isLate = lateRaw > s.graceMinutes;
  const earlyRaw = checkOutAt ? Math.max(0, minutesBetween(checkOutAt, s.endAt)) : 0;
  return {
    workedMinutes: worked,
    hoursOnly: false,
    lateMinutes: isLate ? lateRaw : 0,
    earlyMinutes: earlyRaw,
    isLate,
    isEarly: earlyRaw > 0,
  };
}

/** Status implied by actual hours when no explicit status was chosen. */
export function deriveCategory(workedMinutes: number, checkInAt: string | null, s: Schedule): StatusCategory {
  const afterCutoff = !!checkInAt && new Date(checkInAt) > s.cutoffAt;
  if (!afterCutoff && workedMinutes >= s.fullDayMinutes) return "present";
  if (workedMinutes >= s.halfDayMinutes) return "half_day";
  return "absent";
}

export interface TimeInput {
  date: ISODate;
  checkIn: TimeOfDay | null;
  checkOut: TimeOfDay | null;
  /** Explicit exit date (overnight); when omitted, rolls over automatically for overnight shifts. */
  checkOutDate?: ISODate | null;
}

export interface ResolvedTimes {
  checkInAt: string | null;
  checkOutAt: string | null;
  errors: Record<string, string>;
}

/** Turn wall-clock inputs into full UTC instants, handling overnight shifts. */
export function resolveTimes(input: TimeInput, overnight: boolean, tz: string): ResolvedTimes {
  const errors: Record<string, string> = {};
  const inAt = input.checkIn ? zonedToUtc(input.date, input.checkIn, tz) : null;
  let outAt: Date | null = null;
  if (input.checkOut) {
    outAt = zonedToUtc(input.checkOutDate || input.date, input.checkOut, tz);
    if (inAt && outAt <= inAt && !input.checkOutDate) {
      if (overnight) outAt = zonedToUtc(addDays(input.date, 1), input.checkOut, tz);
      else errors.checkOut = "Exit time cannot be before entry time for a same-day shift";
    } else if (inAt && outAt <= inAt) {
      errors.checkOut = "Exit must be after entry";
    }
    if (!errors.checkOut && inAt && outAt && minutesBetween(inAt, outAt) > 24 * 60) {
      errors.checkOut = "Shift duration cannot exceed 24 hours";
    }
  }
  return { checkInAt: inAt?.toISOString() ?? null, checkOutAt: outAt?.toISOString() ?? null, errors };
}

export interface EntryRules {
  category: StatusCategory;
  checkInAt: string | null;
  checkOutAt: string | null;
  reportedMinutes?: number | null;
  now: Date;
  futureToleranceMinutes: number;
  allowFuture: boolean;
}

/** Business validation shared by manual entry, the register, corrections and imports. */
export function validateEntry(r: EntryRules): Record<string, string> {
  const errors: Record<string, string> = {};
  const limit = r.now.getTime() + r.futureToleranceMinutes * 60000;
  if (!r.allowFuture) {
    if (r.checkInAt && new Date(r.checkInAt).getTime() > limit) errors.checkIn = "Entry time is in the future";
    if (r.checkOutAt && new Date(r.checkOutAt).getTime() > limit) errors.checkOut = "Exit time is in the future";
  }
  const hours = r.reportedMinutes != null;
  if (r.checkOutAt && !r.checkInAt) errors.checkIn = "Entry time is required when an exit time is given";
  if (hours && (r.checkInAt || r.checkOutAt)) errors.workedHours = "Give either entry/exit times or worked hours, not both";
  const timed = r.category === "present" || r.category === "half_day";
  if (timed && !r.checkInAt && !hours) errors.checkIn = "Entry time (or worked hours) is required for this status";
  if (!timed && r.category !== "pending" && (r.checkInAt || r.checkOutAt || (hours && r.reportedMinutes! > 0))) {
    errors.statusCode = "Entry/exit times or hours are not allowed for this status";
  }
  return errors;
}
