import { col } from "../db";
import type {
  AttendanceRecord,
  AttendanceSettings,
  AttendanceStatus,
  DayResult,
  Employee,
  EmployeeShiftAssignment,
  Holiday,
  ID,
  ISODate,
  LeaveRecord,
  Shift,
} from "@/lib/types";
import { buildSchedule, type Schedule } from "@/lib/attendance-calc";
import { resolveDay } from "@/lib/day-status";
import { dayOfWeek, eachDay } from "@/lib/time";
import { getSettings } from "./settings";

/**
 * Bulk loader that resolves DayResults for many employees across a date range
 * with a fixed number of queries (records, leave, holidays, shifts, statuses).
 */
export class DayResolver {
  private constructor(
    public settings: AttendanceSettings,
    private shifts: Map<ID, Shift>,
    public statuses: Map<string, AttendanceStatus>,
    private records: Map<string, AttendanceRecord>,
    private leaves: Map<ID, LeaveRecord[]>,
    private holidays: Map<ISODate, Holiday[]>,
    private assignments: Map<ID, EmployeeShiftAssignment[]>,
    public now: Date,
  ) {}

  static async load(employeeIds: ID[] | "all", from: ISODate, to: ISODate, now = new Date()): Promise<DayResolver> {
    const empFilter = employeeIds === "all" ? {} : { employeeId: { $in: employeeIds } };
    const [settings, shifts, statuses, records, leaves, holidays, assignments] = await Promise.all([
      getSettings(),
      (await col("shifts")).find(),
      (await col("attendance_statuses")).find(),
      (await col("attendance_records")).find({ ...empFilter, voided: false, date: { $gte: from, $lte: to } }),
      (await col("employee_leave_records")).find({ ...empFilter, status: "approved", fromDate: { $lte: to }, toDate: { $gte: from } }),
      (await col("holidays")).find({ date: { $gte: from, $lte: to } }),
      (await col("employee_shift_assignments")).find(empFilter),
    ]);
    const recMap = new Map<string, AttendanceRecord>();
    for (const r of records) if (r.segment === 1) recMap.set(`${r.employeeId}|${r.date}`, r);
    const leaveMap = new Map<ID, LeaveRecord[]>();
    for (const l of leaves) leaveMap.set(l.employeeId, [...(leaveMap.get(l.employeeId) ?? []), l]);
    const holMap = new Map<ISODate, Holiday[]>();
    for (const h of holidays) holMap.set(h.date, [...(holMap.get(h.date) ?? []), h]);
    const asgMap = new Map<ID, EmployeeShiftAssignment[]>();
    for (const a of assignments) asgMap.set(a.employeeId, [...(asgMap.get(a.employeeId) ?? []), a]);
    for (const list of asgMap.values()) list.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
    return new DayResolver(
      settings,
      new Map(shifts.map((s) => [s.id, s])),
      new Map(statuses.map((s) => [s.code, s])),
      recMap,
      leaveMap,
      holMap,
      asgMap,
      now,
    );
  }

  record(employeeId: ID, date: ISODate) {
    return this.records.get(`${employeeId}|${date}`) ?? null;
  }

  shiftFor(emp: Employee, date: ISODate, rec?: AttendanceRecord | null): Shift | null {
    if (rec?.shiftId && this.shifts.has(rec.shiftId)) return this.shifts.get(rec.shiftId)!;
    const asg = this.assignments.get(emp.id)?.find((a) => a.effectiveFrom <= date && (!a.effectiveTo || a.effectiveTo >= date));
    const id = asg?.shiftId ?? emp.shiftId ?? this.settings.defaultShiftId;
    return (id && this.shifts.get(id)) || null;
  }

  schedule(emp: Employee, date: ISODate, rec?: AttendanceRecord | null): Schedule {
    return buildSchedule(date, this.shiftFor(emp, date, rec), emp, this.settings);
  }

  isWeeklyOff(emp: Employee, date: ISODate) {
    return (emp.weeklyOffDays ?? this.settings.weeklyOffDays).includes(dayOfWeek(date));
  }

  holiday(emp: Employee, date: ISODate): Holiday | null {
    return (
      this.holidays.get(date)?.find((h) => !h.officeLocationIds.length || (emp.officeLocationId && h.officeLocationIds.includes(emp.officeLocationId))) ??
      null
    );
  }

  leave(emp: Employee, date: ISODate): LeaveRecord | null {
    return this.leaves.get(emp.id)?.find((l) => l.fromDate <= date && l.toDate >= date) ?? null;
  }

  resolve(emp: Employee, date: ISODate): DayResult {
    const rec = this.record(emp.id, date);
    return resolveDay({
      date,
      employee: emp,
      record: rec,
      leave: this.leave(emp, date),
      holiday: this.holiday(emp, date),
      weeklyOff: this.isWeeklyOff(emp, date),
      schedule: this.schedule(emp, date, rec),
      settings: this.settings,
      statuses: this.statuses,
      now: this.now,
    });
  }

  resolveRange(employees: Employee[], from: ISODate, to: ISODate): DayResult[] {
    const out: DayResult[] = [];
    const dates = eachDay(from, to);
    for (const emp of employees) for (const d of dates) out.push(this.resolve(emp, d));
    return out;
  }
}
