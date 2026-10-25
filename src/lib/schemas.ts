import { z } from "zod";
import { isValidDate, isValidTime, isValidTimeZone } from "./time";
import { aadhaarProblem } from "./aadhaar";

/** Shared validation schemas — used by API handlers and client forms alike. */

export const zDate = z.string().refine(isValidDate, "Use YYYY-MM-DD");
export const zTime = z.string().refine(isValidTime, "Use HH:mm (24h)");
export const zOptTime = z
  .string()
  .optional()
  .nullable()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || isValidTime(v), "Use HH:mm (24h)");
export const zDateTime = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "Invalid date-time");
export const zId = z.string().min(1).max(64);
const trimmed = (max: number) => z.string().trim().max(max);

/* ------------------------------- Auth ------------------------------- */

export const loginSchema = z.object({
  identifier: z.string().trim().min(1, "Enter your Employee ID or email").max(200),
  password: z.string().min(1, "Enter your password").max(200),
  remember: z.boolean().optional().default(false),
});

export const forgotSchema = z.object({ identifier: z.string().trim().min(1, "Required").max(200) });

export const resetSchema = z.object({
  token: z.string().min(10).max(200),
  password: z.string().min(8, "At least 8 characters").max(128),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Required"),
  newPassword: z.string().min(8, "At least 8 characters").max(128),
});

/* ---------------------------- Organisation --------------------------- */

export const departmentSchema = z.object({
  name: trimmed(100).min(1, "Required"),
  code: trimmed(20).min(1, "Required").transform((s) => s.toUpperCase()),
  description: trimmed(500).default(""),
  active: z.boolean().default(true),
});

export const designationSchema = z.object({
  title: trimmed(100).min(1, "Required"),
  departmentId: zId.nullable().default(null),
  active: z.boolean().default(true),
});

export const locationSchema = z.object({
  name: trimmed(150).min(1, "Required"),
  code: trimmed(20).min(1, "Required").transform((s) => s.toUpperCase()),
  address: trimmed(500).default(""),
  principalEmployer: trimmed(200).default(""),
  principalEmployerAddress: trimmed(500).default(""),
  natureOfWork: trimmed(200).default(""),
  active: z.boolean().default(true),
});

export const shiftSchema = z.object({
  name: trimmed(100).min(1, "Required"),
  code: trimmed(20).min(1, "Required").transform((s) => s.toUpperCase()),
  startTime: zTime,
  endTime: zTime,
  breakMinutes: z.coerce.number().int().min(0).max(240).default(0),
  graceMinutes: z.coerce.number().int().min(0).max(240).nullable().default(null),
  fullDayHours: z.coerce.number().min(0.5).max(24).nullable().default(null),
  halfDayHours: z.coerce.number().min(0.5).max(24).nullable().default(null),
  active: z.boolean().default(true),
});

export const holidaySchema = z.object({
  date: zDate,
  name: trimmed(100).min(1, "Required"),
  officeLocationIds: z.array(zId).max(50).default([]),
});

export const leaveSchema = z
  .object({
    employeeId: zId,
    fromDate: zDate,
    toDate: zDate,
    leaveType: z.enum(["casual", "sick", "earned", "unpaid", "other"]),
    reason: trimmed(500).default(""),
  })
  .refine((v) => v.toDate >= v.fromDate, { message: "End date must be on or after start date", path: ["toDate"] });

export const statusSchema = z.object({
  code: trimmed(30)
    .min(1)
    .regex(/^[a-z][a-z0-9_]*$/, "Lowercase letters, numbers and underscores"),
  label: trimmed(60).min(1),
  category: z.enum(["present", "absent", "leave", "half_day", "holiday", "weekly_off", "pending"]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  credit: z.coerce.number().min(0).max(1),
  active: z.boolean().default(true),
});

/* ------------------------------ Settings ----------------------------- */

export const settingsSchema = z
  .object({
    organizationName: trimmed(120).min(1, "Required"),
    attendanceStartDate: zDate.nullable(),
    timezone: z.string().refine(isValidTimeZone, "Unknown IANA time zone"),
    defaultShiftId: zId.nullable(),
    weeklyOffDays: z.array(z.number().int().min(0).max(6)).max(7),
    graceMinutes: z.coerce.number().int().min(0).max(240),
    fullDayHours: z.coerce.number().min(0.5).max(24),
    halfDayHours: z.coerce.number().min(0.5).max(24),
    attendanceCutoffTime: zTime,
    finalizationTime: zTime,
    finalizeNextDay: z.boolean(),
    missingCheckoutPolicy: z.enum(["flag", "half_day", "absent"]),
    correctionWindowDays: z.coerce.number().int().min(0).max(365),
    lockEnabled: z.boolean(),
    lockAfterDays: z.coerce.number().int().min(1).max(3650),
    selfCheckInEnabled: z.boolean(),
    selfCheckOutEnabled: z.boolean(),
    allowRepeatCheckout: z.boolean(),
    fullDayCredit: z.coerce.number().min(0).max(1),
    halfDayCredit: z.coerce.number().min(0).max(1),
    leaveCountsAsPresent: z.boolean(),
    futureToleranceMinutes: z.coerce.number().int().min(0).max(120),
  })
  .refine((v) => v.halfDayHours <= v.fullDayHours, { message: "Half-day hours cannot exceed full-day hours", path: ["halfDayHours"] });

/* ------------------------------ Employees ---------------------------- */

/** Optional text: "" / undefined → null, otherwise trimmed and checked. */
const optText = (max: number, check?: (v: string) => boolean, message = "Invalid value") =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || !check || check(v), message);

const isEmail = (v: string) => z.string().email().safeParse(v).success;

export const employeeSchema = z.object({
  employeeCode: trimmed(20)
    .min(1, "Required")
    .regex(/^[A-Za-z0-9_-]+$/, "Letters, numbers, - and _ only")
    .transform((s) => s.toUpperCase()),
  uan: optText(12, (v) => /^\d{12}$/.test(v), "UAN must be exactly 12 digits"),
  /** Write-only. Omitted = keep current, "" = remove, digits = set. Never returned by the API. */
  aadhaarNumber: z
    .string()
    .trim()
    .max(20)
    .optional()
    .refine((v) => v === undefined || v === "" || aadhaarProblem(v) === null, { message: "Enter a valid 12-digit Aadhaar number" }),
  title: optText(10),
  firstName: trimmed(80).min(1, "Required"),
  lastName: trimmed(80).default(""),
  gender: z.enum(["male", "female", "other"]).nullable().default(null),
  fatherName: optText(120),
  dateOfBirth: optText(10, isValidDate, "Use YYYY-MM-DD"),
  permanentAddress: trimmed(500).default(""),
  localAddress: trimmed(500).default(""),
  labourStatus: z.enum(["onroll", "offroll"]).nullable().default(null),
  bankAccountNumber: optText(34, (v) => /^[0-9X]{6,34}$/i.test(v), "Digits only (masked X allowed)"),
  ifscCode: optText(11, (v) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v.toUpperCase()), "IFSC is 11 characters, e.g. SBIN0001234").transform((v) => v?.toUpperCase() ?? null),
  officialEmail: optText(200, isEmail, "Enter a valid email").transform((v) => v?.toLowerCase() ?? null),
  personalEmail: optText(200, isEmail, "Enter a valid email").transform((v) => v?.toLowerCase() ?? null),
  mobile: optText(20, (v) => /^[+\d][\d\s-]{6,19}$/.test(v), "Enter a valid phone number"),
  departmentId: zId.nullable(),
  designationId: zId.nullable(),
  supervisorEmployeeId: zId.nullable(),
  officeLocationId: zId.nullable(),
  employmentType: z.enum(["full_time", "part_time", "contract", "intern"]),
  dateOfJoining: zDate,
  employmentStatus: z.enum(["active", "probation", "notice", "inactive"]),
  shiftId: zId.nullable(),
  expectedEntryTime: zOptTime,
  expectedExitTime: zOptTime,
  standardWorkingHours: z.coerce.number().min(0.5).max(24).nullable().optional().transform((v) => v ?? null),
  weeklyOffDays: z.array(z.number().int().min(0).max(6)).max(7).nullable(),
});

export const employeeCreateSchema = employeeSchema.extend({
  createAccount: z.boolean().default(true),
  role: z.enum(["admin", "supervisor", "employee"]).default("employee"),
});

/** Full-record update (PUT semantics) — the edit form always submits every field. */
export const employeeUpdateSchema = employeeSchema.extend({
  role: z.enum(["admin", "supervisor", "employee"]).optional(),
});

/* ----------------------------- Attendance ---------------------------- */

export const attendanceInputSchema = z.object({
  employeeId: zId,
  date: zDate,
  statusCode: z.string().min(1, "Select a status").max(30),
  checkIn: zOptTime,
  checkOut: zOptTime,
  /** Explicit exit date for overnight shifts; defaults to `date` (or next day when exit < entry on an overnight shift). */
  checkOutDate: zDate.optional().nullable(),
  /** Hours-only entry (no times), e.g. contractor registers. */
  workedHours: z.number().min(0).max(24).nullable().optional(),
  remarks: trimmed(500).default(""),
  customFields: z.record(z.string(), z.unknown()).default({}),
  reason: trimmed(500).optional(),
  allowFuture: z.boolean().optional(),
});

/** Explicit (no defaults) so omitted fields keep their stored values. */
export const attendanceUpdateSchema = z.object({
  employeeId: zId.optional(),
  date: zDate.optional(),
  statusCode: z.string().min(1).max(30).optional(),
  checkIn: z.string().refine(isValidTime, "Use HH:mm (24h)").nullable().optional(),
  checkOut: z.string().refine(isValidTime, "Use HH:mm (24h)").nullable().optional(),
  checkOutDate: zDate.nullable().optional(),
  workedHours: z.number().min(0).max(24).nullable().optional(),
  remarks: trimmed(500).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
  reason: trimmed(500).optional(),
  allowFuture: z.boolean().optional(),
  expectedVersion: z.number().int().optional(),
});

export const registerSaveSchema = z.object({
  date: zDate,
  rows: z
    .array(
      z.object({
        employeeId: zId,
        statusCode: z.string().min(1).max(30),
        checkIn: zOptTime,
        checkOut: zOptTime,
        workedHours: z.number().min(0).max(24).nullable().optional(),
        remarks: trimmed(500).default(""),
        expectedVersion: z.number().int().optional(),
      }),
    )
    .min(1)
    .max(1000),
});

export const correctionCreateSchema = z.object({
  employeeId: zId.optional(),
  date: zDate,
  attendanceId: zId.nullable().optional(),
  statusCode: z.string().max(30).optional(),
  checkIn: zOptTime,
  checkOut: zOptTime,
  workedHours: z.number().min(0).max(24).nullable().optional(),
  remarks: trimmed(500).optional(),
  reason: trimmed(1000).min(5, "Please explain the reason (min 5 characters)"),
});

export const correctionDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  comment: trimmed(1000).default(""),
});

/* ------------------------------ Templates ---------------------------- */

export const templateFieldSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, "Lowercase letters, numbers and underscores"),
  label: trimmed(80).min(1, "Required"),
  type: z.enum(["text", "number", "date", "time", "datetime", "dropdown", "checkbox", "textarea", "employee_ref", "calculated"]),
  required: z.enum(["yes", "no", "conditional"]),
  placeholder: trimmed(120).default(""),
  defaultValue: trimmed(200).default(""),
  options: z.array(trimmed(80).min(1)).max(100).default([]),
  validation: z
    .object({
      min: z.number().optional(),
      max: z.number().optional(),
      maxLength: z.number().int().min(1).max(5000).optional(),
      pattern: z.string().max(200).optional(),
    })
    .default({}),
  order: z.number().int().min(0).max(1000),
  visible: z.boolean().default(true),
  editable: z.boolean().default(true),
  importColumn: trimmed(80).min(1, "Required"),
  core: z.enum(["attendance_date", "employee_code", "employee_name", "check_in", "check_out", "worked_hours", "status", "remarks"]).nullable().default(null),
  calc: z.enum(["employee_name", "department", "worked_hours", "late_minutes", "early_minutes"]).nullable().default(null),
});

export const templateSchema = z.object({
  name: trimmed(100).min(1, "Required"),
  description: trimmed(500).default(""),
  fields: z.array(templateFieldSchema).min(1).max(60),
});

/* ------------------------------ Reports ------------------------------ */

const idList = z.array(zId).max(500).optional();

export const reportFilterSchema = z.object({
  from: zDate.optional(),
  to: zDate.optional(),
  preset: z.enum(["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "this_year", "custom"]).optional(),
  departmentIds: idList,
  designationIds: idList,
  supervisorIds: idList,
  employeeIds: idList,
  officeLocationIds: idList,
  shiftIds: idList,
  statuses: z.array(z.string().max(30)).max(20).optional(),
  employmentStatuses: z.array(z.enum(["active", "probation", "notice", "inactive"])).optional(),
  search: z.string().trim().max(100).optional(),
});

export type ReportFilter = z.infer<typeof reportFilterSchema>;
export const FILTER_ARRAY_KEYS = [
  "departmentIds",
  "designationIds",
  "supervisorIds",
  "employeeIds",
  "officeLocationIds",
  "shiftIds",
  "statuses",
  "employmentStatuses",
];

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(25),
  sort: z.string().max(40).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
});
