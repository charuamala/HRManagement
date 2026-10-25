/**
 * Shared domain types. Every persisted document has a stable string `id`
 * (internal identifier) plus createdAt/updatedAt ISO-8601 UTC timestamps.
 *
 * Conventions:
 *  - ISODate      "YYYY-MM-DD"  — a business date in the organisation time zone
 *  - ISODateTime  full ISO-8601 UTC instant ("2026-01-05T03:45:00.000Z")
 *  - TimeOfDay    "HH:mm"       — a wall-clock time in the organisation time zone
 */
export type ID = string;
export type ISODate = string;
export type ISODateTime = string;
export type TimeOfDay = string;

export interface BaseDoc {
  id: ID;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

/* ----------------------------- Identity ----------------------------- */

export type RoleKey = "admin" | "supervisor" | "employee";

export interface Role extends BaseDoc, MasterStamp {
  /** System roles: admin / supervisor / employee. Custom roles use their own lowercase key. */
  key: string;
  name: string;
  description: string;
  system: boolean;
  /** Custom roles can be deactivated (only when no user holds them). Missing = active. */
  active?: boolean;
}

export type UserStatus = "invited" | "active" | "disabled";

export interface User extends BaseDoc {
  /** Optional: site workers may sign in with their Employee ID only. */
  email: string | null;
  employeeId: ID | null;
  employeeCode: string | null;
  displayName: string;
  role: RoleKey;
  passwordHash: string | null;
  status: UserStatus;
  failedLoginCount: number;
  lockedUntil: ISODateTime | null;
  lastLoginAt: ISODateTime | null;
  passwordChangedAt: ISODateTime | null;
}

export interface Session extends BaseDoc {
  tokenHash: string;
  userId: ID;
  expiresAt: ISODateTime;
  lastSeenAt: ISODateTime;
  remember: boolean;
  ip: string | null;
  userAgent: string | null;
}

export interface AuthToken extends BaseDoc {
  userId: ID;
  type: "reset" | "invite";
  tokenHash: string;
  expiresAt: ISODateTime;
  usedAt: ISODateTime | null;
}

export interface PermissionDef extends BaseDoc {
  key: string;
  module: string;
  action: string;
  description: string;
}

export interface RolePermission extends BaseDoc {
  /** System role key or a custom role key from the Role Master. */
  role: string;
  permissionKey: string;
}

export interface UserPermission extends BaseDoc {
  userId: ID;
  permissionKey: string;
  effect: "allow" | "deny";
}

/* --------------------------- Organisation --------------------------- */

/** Who last created/changed a master record (null/undefined = system or legacy data). */
export interface MasterStamp {
  createdBy?: ID | null;
  updatedBy?: ID | null;
}

export interface Department extends BaseDoc, MasterStamp {
  name: string;
  code: string;
  description: string;
  active: boolean;
}

export interface Designation extends BaseDoc, MasterStamp {
  /** Unique designation code (added by the master-data migration for legacy records). */
  code?: string;
  title: string;
  description?: string;
  departmentId: ID | null;
  active: boolean;
}

/** Office or work site ("establishment where the work is carried on"). */
export interface OfficeLocation extends BaseDoc, MasterStamp {
  name: string;
  code: string;
  address: string;
  city?: string;
  contactName?: string;
  contactPhone?: string;
  /** Principal employer / establishment that owns the site. */
  principalEmployer: string;
  principalEmployerAddress: string;
  /** Nature of building or other construction work at this site. */
  natureOfWork: string;
  active: boolean;
}

export type EmploymentType = "full_time" | "part_time" | "contract" | "intern";
export type EmploymentStatus = "active" | "probation" | "notice" | "inactive";
export type Gender = "male" | "female" | "other";
export type LabourStatus = "onroll" | "offroll";

export interface Employee extends BaseDoc {
  employeeCode: string;
  /** Universal Account Number (EPFO), 12 digits. */
  uan: string | null;
  /** Aadhaar: only the last 4 digits are kept in clear; the full number is AES-GCM encrypted. */
  aadhaarLast4: string | null;
  aadhaarEnc: string | null;
  /** Keyed hash (blind index) used to keep Aadhaar unique without storing it in clear. */
  aadhaarHash: string | null;
  /** Current profile photo (employee_photos.id); null when none. */
  photoId: string | null;
  title: string | null;
  firstName: string;
  lastName: string;
  fullName: string;
  gender: Gender | null;
  fatherName: string | null;
  dateOfBirth: ISODate | null;
  permanentAddress: string;
  localAddress: string;
  labourStatus: LabourStatus | null;
  /** Bank details — stored masked as supplied; visible to admins and the employee only. */
  bankAccountNumber: string | null;
  ifscCode: string | null;
  officialEmail: string | null;
  personalEmail: string | null;
  mobile: string | null;
  departmentId: ID | null;
  designationId: ID | null;
  supervisorEmployeeId: ID | null;
  officeLocationId: ID | null;
  employmentType: EmploymentType;
  dateOfJoining: ISODate;
  dateOfExit: ISODate | null;
  employmentStatus: EmploymentStatus;
  shiftId: ID | null;
  expectedEntryTime: TimeOfDay | null;
  expectedExitTime: TimeOfDay | null;
  standardWorkingHours: number | null;
  weeklyOffDays: number[] | null;
  userId: ID | null;
  deactivatedAt: ISODateTime | null;
}

export interface EmployeePhoto extends BaseDoc {
  employeeId: ID;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  size: number;
  /** Base64 image bytes (small, client-resized) — portable to MongoDB without GridFS. */
  data: string;
  uploadedBy: ID;
}

export interface SupervisorAssignment extends BaseDoc {
  supervisorUserId: ID;
  scopeType: "employee" | "department";
  employeeId: ID | null;
  departmentId: ID | null;
}

export interface Shift extends BaseDoc, MasterStamp {
  name: string;
  code: string;
  description?: string;
  startTime: TimeOfDay;
  endTime: TimeOfDay;
  breakMinutes: number;
  graceMinutes: number | null;
  fullDayHours: number | null;
  halfDayHours: number | null;
  active: boolean;
}

export interface EmployeeShiftAssignment extends BaseDoc {
  employeeId: ID;
  shiftId: ID;
  effectiveFrom: ISODate;
  effectiveTo: ISODate | null;
}

/* ---------------------------- Attendance ---------------------------- */

export type StatusCategory =
  | "present"
  | "absent"
  | "leave"
  | "half_day"
  | "holiday"
  | "weekly_off"
  | "pending";

export interface AttendanceStatus extends BaseDoc {
  code: string;
  label: string;
  category: StatusCategory;
  color: string;
  /** Attendance credit for custom statuses. System statuses take credit from settings. */
  credit: number;
  system: boolean;
  active: boolean;
  order: number;
}

export type EntrySource = "manual" | "register" | "import" | "self" | "correction" | "finalization";
export type RecordState = "open" | "complete" | "finalized";

export interface AttendanceRecord extends BaseDoc {
  employeeId: ID;
  date: ISODate;
  segment: number;
  statusCode: string;
  checkInAt: ISODateTime | null;
  checkOutAt: ISODateTime | null;
  /** Hours-only entries (e.g. contractor registers): reported worked minutes when no times exist. */
  reportedMinutes: number | null;
  remarks: string;
  source: EntrySource;
  state: RecordState;
  employeeSubmitted: boolean;
  shiftId: ID | null;
  templateVersionId: ID | null;
  importJobId: ID | null;
  customFields: Record<string, unknown>;
  voided: boolean;
  voidReason: string | null;
  createdBy: ID;
  updatedBy: ID;
  version: number;
}

export interface AttendanceEvent extends BaseDoc {
  attendanceId: ID;
  employeeId: ID;
  type: "check_in" | "check_out" | "edit" | "void" | "finalize";
  at: ISODateTime;
  source: EntrySource;
  createdBy: ID;
  note: string;
}

export interface CorrectionValues {
  statusCode?: string;
  checkInAt?: ISODateTime | null;
  checkOutAt?: ISODateTime | null;
  reportedMinutes?: number | null;
  remarks?: string;
}

export type CorrectionStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface CorrectionRequest extends BaseDoc {
  attendanceId: ID | null;
  employeeId: ID;
  date: ISODate;
  original: CorrectionValues | null;
  requested: CorrectionValues;
  reason: string;
  requestedBy: ID;
  status: CorrectionStatus;
  reviewedBy: ID | null;
  reviewedAt: ISODateTime | null;
  reviewComment: string;
}

/* ----------------------------- Templates ---------------------------- */

export type FieldType =
  | "text"
  | "number"
  | "date"
  | "time"
  | "datetime"
  | "dropdown"
  | "checkbox"
  | "textarea"
  | "employee_ref"
  | "calculated";

/** Core semantic fields that map onto AttendanceRecord columns. */
export type CoreFieldKey =
  | "attendance_date"
  | "employee_code"
  | "employee_name"
  | "check_in"
  | "check_out"
  | "worked_hours"
  | "status"
  | "remarks";

export interface TemplateField {
  key: string;
  label: string;
  type: FieldType;
  required: "yes" | "no" | "conditional";
  placeholder: string;
  defaultValue: string;
  options: string[];
  validation: { min?: number; max?: number; maxLength?: number; pattern?: string };
  order: number;
  visible: boolean;
  editable: boolean;
  importColumn: string;
  core: CoreFieldKey | null;
  /** For calculated fields: which derived value to show. */
  calc: "employee_name" | "department" | "worked_hours" | "late_minutes" | "early_minutes" | null;
}

export interface AttendanceTemplate extends BaseDoc {
  name: string;
  description: string;
  status: "draft" | "active" | "archived";
  /** Working (draft) field set — becomes immutable once published as a version. */
  fields: TemplateField[];
  latestVersion: number;
  activeVersionId: ID | null;
  createdBy: ID;
  updatedBy: ID;
}

export interface AttendanceTemplateVersion extends BaseDoc {
  templateId: ID;
  version: number;
  name: string;
  fields: TemplateField[];
  notes: string;
  createdBy: ID;
}

/* ---------------------------- Bulk import --------------------------- */

export type ImportMode = "insert" | "update" | "upsert";
export type ImportJobStatus =
  | "validated"
  | "processing"
  | "completed"
  | "partially_completed"
  | "failed"
  | "cancelled";

export interface BulkImportJob extends BaseDoc {
  fileName: string;
  fileHash: string;
  fileType: "xlsx" | "csv";
  uploadedBy: ID;
  templateId: ID;
  templateVersionId: ID;
  templateVersion: number;
  status: ImportJobStatus;
  mode: ImportMode | null;
  headerErrors: string[];
  headerWarnings: string[];
  /** `unchanged` = rows identical to the saved record (absent on uploads made before this was tracked). */
  totals: { total: number; valid: number; invalid: number; duplicate: number; conflicts: number; unchanged?: number; warnings: number };
  results: { inserted: number; updated: number; skipped: number; failed: number };
  startedAt: ISODateTime | null;
  completedAt: ISODateTime | null;
  previousJobId: ID | null;
}

export type ImportRowStatus = "valid" | "invalid" | "duplicate" | "conflict";

export interface ParsedAttendanceRow {
  employeeId: ID;
  employeeCode: string;
  date: ISODate;
  statusCode: string;
  checkInAt: ISODateTime | null;
  checkOutAt: ISODateTime | null;
  reportedMinutes: number | null;
  remarks: string;
  customFields: Record<string, unknown>;
}

export interface BulkImportRow extends BaseDoc {
  jobId: ID;
  rowNumber: number;
  raw: Record<string, string>;
  parsed: ParsedAttendanceRow | null;
  errors: string[];
  warnings: string[];
  status: ImportRowStatus;
  existingRecordId: ID | null;
  outcome: "inserted" | "updated" | "skipped" | "failed" | null;
  outcomeMessage: string;
  processedAt: ISODateTime | null;
}

/* ------------------------ Calendar & policies ----------------------- */

export interface Holiday extends BaseDoc {
  date: ISODate;
  name: string;
  officeLocationIds: ID[];
}

export type LeaveType = "casual" | "sick" | "earned" | "unpaid" | "other";

export interface LeaveRecord extends BaseDoc {
  employeeId: ID;
  fromDate: ISODate;
  toDate: ISODate;
  leaveType: LeaveType;
  status: "approved" | "cancelled";
  reason: string;
  createdBy: ID;
}

export interface AttendanceSettings extends BaseDoc {
  organizationName: string;
  /** Go-live date: earlier days are not tracked (never counted as absent). */
  attendanceStartDate: ISODate | null;
  timezone: string;
  defaultShiftId: ID | null;
  weeklyOffDays: number[];
  graceMinutes: number;
  fullDayHours: number;
  halfDayHours: number;
  attendanceCutoffTime: TimeOfDay;
  finalizationTime: TimeOfDay;
  finalizeNextDay: boolean;
  missingCheckoutPolicy: "flag" | "half_day" | "absent";
  correctionWindowDays: number;
  lockEnabled: boolean;
  lockAfterDays: number;
  selfCheckInEnabled: boolean;
  selfCheckOutEnabled: boolean;
  allowRepeatCheckout: boolean;
  fullDayCredit: number;
  halfDayCredit: number;
  leaveCountsAsPresent: boolean;
  futureToleranceMinutes: number;
}

/* --------------------------- Notifications -------------------------- */

export type NotificationType =
  | "missing_checkout"
  | "correction_submitted"
  | "correction_approved"
  | "correction_rejected"
  | "import_completed"
  | "import_failed"
  | "attendance_modified"
  | "finalization_pending";

export interface Notification extends BaseDoc {
  userId: ID;
  type: NotificationType;
  title: string;
  message: string;
  link: string | null;
  read: boolean;
  channel: "in_app";
  dedupeKey: string | null;
}

/* ------------------------------ Audit ------------------------------- */

export interface AuditLog extends BaseDoc {
  at: ISODateTime;
  userId: ID | null;
  userRole: RoleKey | null;
  userName: string | null;
  action: string;
  module: string;
  recordId: ID | null;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  reason: string | null;
  importId: ID | null;
  ip: string | null;
  seq: number;
  prevHash: string;
  hash: string;
}

export interface SavedFilter extends BaseDoc {
  userId: ID;
  page: string;
  name: string;
  filters: Record<string, unknown>;
}

/* ------------------------------ Results ----------------------------- */

/** Fully-resolved attendance outcome for one employee on one date. */
export interface DayResult {
  date: ISODate;
  employeeId: ID;
  employeeCode: string;
  employeeName: string;
  departmentId: ID | null;
  officeLocationId: ID | null;
  supervisorEmployeeId: ID | null;
  shiftId: ID | null;
  /** "not_employed" days are outside the employment window and excluded everywhere. */
  category: StatusCategory | "not_employed";
  statusCode: string;
  statusLabel: string;
  credit: number;
  /** Counts in the attendance-percentage denominator. */
  scheduled: boolean;
  checkInAt: ISODateTime | null;
  checkOutAt: ISODateTime | null;
  workedMinutes: number;
  /** Worked time came from reported hours, not timestamps (late/early not computable). */
  hoursOnly: boolean;
  lateMinutes: number;
  earlyMinutes: number;
  isLate: boolean;
  isEarly: boolean;
  missingCheckOut: boolean;
  inOffice: boolean;
  finalized: boolean;
  recordId: ID | null;
  source: EntrySource | null;
  employeeSubmitted: boolean;
  remarks: string;
  expectedStart: ISODateTime | null;
  expectedEnd: ISODateTime | null;
}
