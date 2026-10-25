import type { DayResult } from "./types";

/**
 * Single definition of every KPI. Summary counts, drill-down tables and exports
 * all use these predicates, so a KPI card always equals the rows it opens.
 */
export const KPI_PREDICATES = {
  all: () => true,
  present: (d: DayResult) => d.category === "present",
  absent: (d: DayResult) => d.category === "absent",
  leave: (d: DayResult) => d.category === "leave",
  half_day: (d: DayResult) => d.category === "half_day",
  holiday: (d: DayResult) => d.category === "holiday",
  weekly_off: (d: DayResult) => d.category === "weekly_off",
  pending: (d: DayResult) => d.category === "pending",
  not_checked_in: (d: DayResult) => d.category === "pending" && !d.checkInAt,
  late: (d: DayResult) => d.isLate,
  early: (d: DayResult) => d.isEarly,
  missing_checkout: (d: DayResult) => d.missingCheckOut,
  in_office: (d: DayResult) => d.inOffice,
  checked_out: (d: DayResult) => !!d.checkOutAt,
  scheduled: (d: DayResult) => d.scheduled,
  employee_submitted: (d: DayResult) => d.employeeSubmitted,
} satisfies Record<string, (d: DayResult) => boolean>;

export type KpiKey = keyof typeof KPI_PREDICATES;

export const KPI_LABELS: Record<KpiKey, string> = {
  all: "All records",
  present: "Present",
  absent: "Absent",
  leave: "On Leave",
  half_day: "Half Day",
  holiday: "Holiday",
  weekly_off: "Weekly Off",
  pending: "Pending",
  not_checked_in: "Not Yet Checked In",
  late: "Late Arrivals",
  early: "Early Departures",
  missing_checkout: "Missing Check-Out",
  in_office: "Currently in Office",
  checked_out: "Checked Out",
  scheduled: "Scheduled Working Days",
  employee_submitted: "Employee-submitted",
};

export function isKpiKey(k: string): k is KpiKey {
  return k in KPI_PREDICATES;
}

export interface Summary {
  employees: number;
  days: number;
  scheduledDays: number;
  creditDays: number;
  attendancePct: number;
  present: number;
  absent: number;
  leave: number;
  halfDay: number;
  holiday: number;
  weeklyOff: number;
  pending: number;
  notCheckedIn: number;
  late: number;
  early: number;
  missingCheckOut: number;
  inOffice: number;
  checkedOut: number;
  totalWorkedMinutes: number;
  workedDays: number;
  avgWorkedMinutes: number;
}

export function summarize(days: DayResult[]): Summary {
  const P = KPI_PREDICATES;
  const s: Summary = {
    employees: new Set(days.map((d) => d.employeeId)).size,
    days: days.length,
    scheduledDays: 0,
    creditDays: 0,
    attendancePct: 0,
    present: 0,
    absent: 0,
    leave: 0,
    halfDay: 0,
    holiday: 0,
    weeklyOff: 0,
    pending: 0,
    notCheckedIn: 0,
    late: 0,
    early: 0,
    missingCheckOut: 0,
    inOffice: 0,
    checkedOut: 0,
    totalWorkedMinutes: 0,
    workedDays: 0,
    avgWorkedMinutes: 0,
  };
  for (const d of days) {
    if (P.scheduled(d)) {
      s.scheduledDays++;
      s.creditDays += d.credit;
    }
    if (P.present(d)) s.present++;
    if (P.absent(d)) s.absent++;
    if (P.leave(d)) s.leave++;
    if (P.half_day(d)) s.halfDay++;
    if (P.holiday(d)) s.holiday++;
    if (P.weekly_off(d)) s.weeklyOff++;
    if (P.pending(d)) s.pending++;
    if (P.not_checked_in(d)) s.notCheckedIn++;
    if (P.late(d)) s.late++;
    if (P.early(d)) s.early++;
    if (P.missing_checkout(d)) s.missingCheckOut++;
    if (P.in_office(d)) s.inOffice++;
    if (P.checked_out(d)) s.checkedOut++;
    if (d.workedMinutes > 0) {
      s.totalWorkedMinutes += d.workedMinutes;
      s.workedDays++;
    }
  }
  s.attendancePct = s.scheduledDays ? Math.round((s.creditDays / s.scheduledDays) * 1000) / 10 : 0;
  s.avgWorkedMinutes = s.workedDays ? Math.round(s.totalWorkedMinutes / s.workedDays) : 0;
  return s;
}
