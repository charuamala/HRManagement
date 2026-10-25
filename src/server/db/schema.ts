import type * as T from "@/lib/types";
import type { EmploymentStatusMaster, SimpleMaster, SupervisorMaster } from "@/lib/masters";

/**
 * Collection registry. Each name maps to its document type and index set.
 * The same definitions drive the JSON driver (unique-constraint enforcement)
 * and the MongoDB driver (createIndex calls), so switching drivers is lossless.
 */
export interface DocMap {
  users: T.User;
  roles: T.Role;
  sessions: T.Session;
  auth_tokens: T.AuthToken;
  permissions: T.PermissionDef;
  role_permissions: T.RolePermission;
  user_permissions: T.UserPermission;
  employees: T.Employee;
  employee_photos: T.EmployeePhoto;
  employment_types: SimpleMaster;
  labour_statuses: SimpleMaster;
  employment_statuses: EmploymentStatusMaster;
  supervisors: SupervisorMaster;
  departments: T.Department;
  designations: T.Designation;
  office_locations: T.OfficeLocation;
  supervisor_assignments: T.SupervisorAssignment;
  shifts: T.Shift;
  employee_shift_assignments: T.EmployeeShiftAssignment;
  attendance_records: T.AttendanceRecord;
  attendance_events: T.AttendanceEvent;
  attendance_correction_requests: T.CorrectionRequest;
  attendance_statuses: T.AttendanceStatus;
  attendance_templates: T.AttendanceTemplate;
  attendance_template_versions: T.AttendanceTemplateVersion;
  bulk_import_jobs: T.BulkImportJob;
  bulk_import_rows: T.BulkImportRow;
  holidays: T.Holiday;
  employee_leave_records: T.LeaveRecord;
  attendance_settings: T.AttendanceSettings;
  notifications: T.Notification;
  audit_logs: T.AuditLog;
  saved_filters: T.SavedFilter;
}

export type CollectionName = keyof DocMap;

export interface IndexDef {
  fields: string[];
  unique?: boolean;
  /** Unique only among documents matching this equality filter (Mongo partialFilterExpression). */
  partial?: Record<string, unknown>;
  /** Ignore documents where any indexed field is null/undefined. */
  sparse?: boolean;
}

export interface CollectionDef {
  indexes: IndexDef[];
  /** Append-only: update/delete operations are rejected by the driver. */
  appendOnly?: boolean;
}

export const COLLECTIONS: Record<CollectionName, CollectionDef> = {
  users: { indexes: [{ fields: ["email"], unique: true, sparse: true }, { fields: ["employeeCode"], unique: true, sparse: true }, { fields: ["employeeId"] }] },
  roles: { indexes: [{ fields: ["key"], unique: true }] },
  sessions: { indexes: [{ fields: ["tokenHash"], unique: true }, { fields: ["userId"] }] },
  auth_tokens: { indexes: [{ fields: ["tokenHash"], unique: true }, { fields: ["userId"] }] },
  permissions: { indexes: [{ fields: ["key"], unique: true }] },
  role_permissions: { indexes: [{ fields: ["role", "permissionKey"], unique: true }] },
  user_permissions: { indexes: [{ fields: ["userId", "permissionKey"], unique: true }] },
  employees: {
    indexes: [
      { fields: ["employeeCode"], unique: true },
      { fields: ["officialEmail"], unique: true, sparse: true },
      { fields: ["uan"], unique: true, sparse: true },
      { fields: ["aadhaarHash"], unique: true, sparse: true },
      { fields: ["departmentId"] },
      { fields: ["supervisorEmployeeId"] },
      { fields: ["officeLocationId"] },
    ],
  },
  employee_photos: { indexes: [{ fields: ["employeeId"] }] },
  departments: { indexes: [{ fields: ["code"], unique: true }] },
  designations: { indexes: [{ fields: ["title"], unique: true }, { fields: ["code"], unique: true, sparse: true }] },
  employment_types: { indexes: [{ fields: ["code"], unique: true }] },
  labour_statuses: { indexes: [{ fields: ["code"], unique: true }] },
  employment_statuses: { indexes: [{ fields: ["code"], unique: true }] },
  supervisors: { indexes: [{ fields: ["employeeId"], unique: true }] },
  office_locations: { indexes: [{ fields: ["code"], unique: true }] },
  supervisor_assignments: { indexes: [{ fields: ["supervisorUserId"] }] },
  shifts: { indexes: [{ fields: ["code"], unique: true }] },
  employee_shift_assignments: { indexes: [{ fields: ["employeeId", "effectiveFrom"] }] },
  attendance_records: {
    indexes: [
      { fields: ["employeeId", "date", "segment"], unique: true, partial: { voided: false } },
      { fields: ["date"] },
      { fields: ["employeeId"] },
    ],
  },
  attendance_events: { indexes: [{ fields: ["attendanceId"] }, { fields: ["employeeId", "at"] }] },
  attendance_correction_requests: { indexes: [{ fields: ["employeeId"] }, { fields: ["status"] }] },
  attendance_statuses: { indexes: [{ fields: ["code"], unique: true }] },
  attendance_templates: { indexes: [{ fields: ["name"], unique: true }] },
  attendance_template_versions: { indexes: [{ fields: ["templateId", "version"], unique: true }] },
  bulk_import_jobs: { indexes: [{ fields: ["uploadedBy"] }, { fields: ["fileHash"] }] },
  bulk_import_rows: { indexes: [{ fields: ["jobId", "rowNumber"], unique: true }] },
  holidays: { indexes: [{ fields: ["date", "name"], unique: true }] },
  employee_leave_records: { indexes: [{ fields: ["employeeId", "fromDate"] }] },
  attendance_settings: { indexes: [] },
  notifications: { indexes: [{ fields: ["userId", "read"] }, { fields: ["dedupeKey"], unique: true, sparse: true }] },
  audit_logs: { indexes: [{ fields: ["seq"], unique: true }, { fields: ["module", "at"] }, { fields: ["recordId"] }], appendOnly: true },
  saved_filters: { indexes: [{ fields: ["userId", "page"] }] },
};
