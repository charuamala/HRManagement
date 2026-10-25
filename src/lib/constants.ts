import type { EmploymentStatus, EmploymentType, LeaveType, StatusCategory, TemplateField } from "./types";

export const STATUS_CATEGORIES: StatusCategory[] = [
  "present",
  "absent",
  "leave",
  "half_day",
  "holiday",
  "weekly_off",
  "pending",
];

export const CATEGORY_LABELS: Record<StatusCategory | "not_employed", string> = {
  present: "Present",
  absent: "Absent",
  leave: "Leave",
  half_day: "Half Day",
  holiday: "Holiday",
  weekly_off: "Weekly Off",
  pending: "Pending",
  not_employed: "Not Employed",
};

/** Hex colours shared by charts, calendars and badges (badges also carry a text label). */
export const CATEGORY_COLORS: Record<StatusCategory | "not_employed", string> = {
  present: "#16a34a",
  absent: "#dc2626",
  leave: "#2563eb",
  half_day: "#d97706",
  holiday: "#64748b",
  weekly_off: "#94a3b8",
  pending: "#7c3aed",
  not_employed: "#e2e8f0",
};

export const SYSTEM_STATUSES: { code: string; label: string; category: StatusCategory; order: number }[] = [
  { code: "present", label: "Present", category: "present", order: 1 },
  { code: "absent", label: "Absent", category: "absent", order: 2 },
  { code: "leave", label: "Leave", category: "leave", order: 3 },
  { code: "half_day", label: "Half Day", category: "half_day", order: 4 },
  { code: "holiday", label: "Holiday", category: "holiday", order: 5 },
  { code: "weekly_off", label: "Weekly Off", category: "weekly_off", order: 6 },
  { code: "pending", label: "Pending / Unmarked", category: "pending", order: 7 },
];

/** Statuses for which check-in is expected (times are optional but meaningful). */
export const TIMED_CATEGORIES: StatusCategory[] = ["present", "half_day", "pending"];

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  full_time: "Full-time",
  part_time: "Part-time",
  contract: "Contract",
  intern: "Intern",
};

export const EMPLOYMENT_STATUS_LABELS: Record<EmploymentStatus, string> = {
  active: "Active",
  probation: "Probation",
  notice: "Notice Period",
  inactive: "Inactive",
};

export const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
  casual: "Casual",
  sick: "Sick",
  earned: "Earned",
  unpaid: "Unpaid",
  other: "Other",
};

export const SOURCE_LABELS: Record<string, string> = {
  manual: "Manual entry",
  register: "Daily register",
  import: "Bulk import",
  self: "Employee self-entry",
  correction: "Approved correction",
  finalization: "Auto-finalization",
};

export const FIELD_TYPE_LABELS: Record<TemplateField["type"], string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  time: "Time",
  datetime: "Date-Time",
  dropdown: "Dropdown",
  checkbox: "Checkbox",
  textarea: "Text Area",
  employee_ref: "Employee Reference",
  calculated: "Calculated",
};

/** Core template fields that cannot be removed or re-typed without breaking record integrity. */
export const LOCKED_CORE_FIELDS = ["attendance_date", "employee_code", "check_in", "check_out", "status"] as const;

export function defaultTemplateFields(): TemplateField[] {
  const base = {
    placeholder: "",
    defaultValue: "",
    options: [] as string[],
    validation: {},
    visible: true,
    editable: true,
    calc: null,
  };
  return [
    { ...base, key: "attendance_date", label: "Attendance Date", type: "date", required: "yes", order: 1, importColumn: "Attendance Date", core: "attendance_date", placeholder: "YYYY-MM-DD" },
    { ...base, key: "employee_code", label: "Employee ID", type: "employee_ref", required: "yes", order: 2, importColumn: "Employee ID", core: "employee_code", placeholder: "EMP0001" },
    { ...base, key: "employee_name", label: "Employee Name", type: "calculated", required: "no", order: 3, importColumn: "Employee Name", core: "employee_name", editable: false, calc: "employee_name" },
    { ...base, key: "check_in", label: "Entry Time", type: "time", required: "conditional", order: 4, importColumn: "Entry Time", core: "check_in", placeholder: "HH:mm (24h)" },
    { ...base, key: "check_out", label: "Exit Time", type: "time", required: "conditional", order: 5, importColumn: "Exit Time", core: "check_out", placeholder: "HH:mm (24h)" },
    { ...base, key: "worked_hours", label: "Worked Hours", type: "number", required: "no", order: 6, importColumn: "Worked Hours", core: "worked_hours", placeholder: "Only when no entry/exit times, e.g. 8", validation: { min: 0, max: 24 } },
    { ...base, key: "status", label: "Status", type: "dropdown", required: "yes", order: 7, importColumn: "Status", core: "status" },
    { ...base, key: "remarks", label: "Remarks", type: "text", required: "no", order: 8, importColumn: "Remarks", core: "remarks", validation: { maxLength: 500 } },
  ];
}

export const GENDER_LABELS = { male: "Male", female: "Female", other: "Other" } as const;
export const LABOUR_STATUS_LABELS = { onroll: "On-roll", offroll: "Off-roll" } as const;

/** Age in whole years on `onDate` (both YYYY-MM-DD). */
export function ageOn(dateOfBirth: string | null, onDate: string): number | null {
  if (!dateOfBirth) return null;
  const [y, m, d] = dateOfBirth.split("-").map(Number);
  const [ty, tm, td] = onDate.split("-").map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}
