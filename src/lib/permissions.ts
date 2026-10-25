import type { RoleKey } from "./types";

export const ACTIONS = ["view", "create", "edit", "delete", "import", "export", "approve", "manage"] as const;
export type Action = (typeof ACTIONS)[number];

/** Catalog of modules and the operations each one supports. */
export const MODULES = {
  dashboard: { label: "Dashboard", actions: ["view"] },
  employees: { label: "Employees", actions: ["view", "create", "edit", "delete", "import", "export"] },
  attendance: {
    label: "Team Attendance",
    actions: ["view", "create", "edit", "delete", "export", "approve", "manage"],
  },
  self_attendance: { label: "My Attendance (self-service)", actions: ["view", "create", "export"] },
  corrections: { label: "Attendance Corrections", actions: ["view", "create", "approve"] },
  templates: { label: "Attendance Templates", actions: ["view", "create", "edit", "delete", "manage"] },
  bulk_upload: { label: "Bulk Upload", actions: ["view", "import", "export"] },
  reports: { label: "Reports", actions: ["view", "export"] },
  users: { label: "User Management", actions: ["view", "create", "edit", "manage"] },
  permissions: { label: "Roles & Permissions", actions: ["view", "manage"] },
  departments: { label: "Departments & Org Structure", actions: ["view", "create", "edit", "delete"] },
  masters: { label: "Master Management", actions: ["view", "create", "edit", "delete", "import", "export"] },
  shifts: { label: "Shifts", actions: ["view", "create", "edit", "delete"] },
  leave: { label: "Leave Records", actions: ["view", "create", "edit", "delete"] },
  settings: { label: "Attendance Settings", actions: ["view", "manage"] },
  audit_logs: { label: "Audit Logs", actions: ["view", "export"] },
} as const satisfies Record<string, { label: string; actions: readonly Action[] }>;

export type ModuleKey = keyof typeof MODULES;
export type PermissionKey = `${ModuleKey}.${Action}`;

export const ACTION_DESCRIPTIONS: Record<Action, string> = {
  view: "View",
  create: "Create",
  edit: "Edit",
  delete: "Delete / Void",
  import: "Import",
  export: "Export",
  approve: "Approve",
  manage: "Manage",
};

/** Extra explanation of what non-obvious permissions unlock. */
export const PERMISSION_NOTES: Partial<Record<PermissionKey, string>> = {
  "attendance.approve": "Finalize attendance for a date",
  "attendance.manage": "Edit locked records, enter future-dated records, override policy",
  "self_attendance.create": "Self check-in / check-out (also requires the global setting)",
  "self_attendance.export": "Download own attendance report",
  "corrections.create": "Submit correction requests for own attendance",
  "corrections.approve": "Approve or reject correction requests within scope",
  "templates.manage": "Activate templates",
  "templates.delete": "Archive templates",
  "bulk_upload.import": "Upload attendance files (update/upsert also need attendance.edit)",
  "bulk_upload.export": "Download blank import templates",
  "users.manage": "Activate/deactivate accounts, issue reset links, change roles",
  "permissions.manage": "Change role and user permissions, supervisor scopes",
  "masters.edit": "Edit and activate/deactivate master records",
  "masters.delete": "Permanently delete unreferenced master records",
  "masters.import": "Bulk upload master records",
};

export function allPermissionKeys(): PermissionKey[] {
  const keys: PermissionKey[] = [];
  for (const [mod, def] of Object.entries(MODULES)) {
    for (const action of def.actions) keys.push(`${mod}.${action}` as PermissionKey);
  }
  return keys;
}

export function isPermissionKey(key: string): key is PermissionKey {
  return allPermissionKeys().includes(key as PermissionKey);
}

/** Default permissions per role. Admin implicitly holds every permission. */
export const DEFAULT_ROLE_PERMISSIONS: Record<RoleKey, PermissionKey[]> = {
  admin: allPermissionKeys(),
  supervisor: [
    "dashboard.view",
    "employees.view",
    "attendance.view",
    "attendance.create",
    "attendance.edit",
    "attendance.export",
    "self_attendance.view",
    "self_attendance.create",
    "self_attendance.export",
    "corrections.view",
    "corrections.create",
    "corrections.approve",
    "bulk_upload.view",
    "bulk_upload.import",
    "bulk_upload.export",
    "reports.view",
    "reports.export",
    "templates.view",
  ],
  employee: [
    "dashboard.view",
    "self_attendance.view",
    "self_attendance.create",
    "self_attendance.export",
    "corrections.view",
    "corrections.create",
  ],
};

export const ROLE_LABELS: Record<RoleKey, string> = {
  admin: "Admin",
  supervisor: "Supervisor",
  employee: "Employee",
};
