/**
 * Master Management — one definition per master, shared by the server (validation,
 * import/export columns) and the browser (tables, forms). Adding a field here makes it
 * appear in the form, the list, the import template and the export.
 */
import { z } from "zod";
import type { BaseDoc, ID } from "./types";
import { isValidTime } from "./time";

export const MASTER_KEYS = [
  "designations",
  "departments",
  "work_sites",
  "supervisors",
  "employment_types",
  "labour_statuses",
  "employment_statuses",
  "shifts",
  "roles",
] as const;
export type MasterKey = (typeof MASTER_KEYS)[number];

export function isMasterKey(k: string): k is MasterKey {
  return (MASTER_KEYS as readonly string[]).includes(k);
}

/* ------------------------------ Stored shapes ------------------------------ */

export interface MasterAudit {
  createdBy?: ID | null;
  updatedBy?: ID | null;
}

/** Employment type / labour status. */
export interface SimpleMaster extends BaseDoc, MasterAudit {
  code: string;
  name: string;
  description: string;
  active: boolean;
  system: boolean;
  order: number;
}

export interface EmploymentStatusMaster extends SimpleMaster {
  /** Lifecycle meaning: "active" = currently employed, "inactive" = separated (exit date applies). */
  lifecycle: "active" | "inactive";
}

/** Supervisor eligibility — references an existing employee; never a duplicate identity. */
export interface SupervisorMaster extends BaseDoc, MasterAudit {
  employeeId: ID;
  departmentIds: ID[];
  workSiteIds: ID[];
  notes: string;
  active: boolean;
}

/* ------------------------------ UI definitions ----------------------------- */

export type MasterFieldType = "text" | "textarea" | "time" | "number" | "select" | "multiselect" | "employee" | "lifecycle";

export interface MasterField {
  name: string;
  label: string;
  type: MasterFieldType;
  required?: boolean;
  /** For select/multiselect: options come from this master (active only for new picks). */
  ref?: MasterKey;
  help?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Shown as a column in the list table. */
  list?: boolean;
  /** Excluded from import/export (e.g. computed or permission grid). */
  noImport?: boolean;
}

export interface MasterDefinition {
  label: string;
  singular: string;
  employeeField: string;
  description: string;
  codeField: "code" | "key" | null;
  nameField: "name" | "title" | null;
  fields: MasterField[];
  importable: boolean;
  /** Only Administrators may manage this master (roles). */
  adminOnly?: boolean;
}

const code = (label = "Code"): MasterField => ({ name: "code", label, type: "text", required: true, list: true, placeholder: "e.g. DES001", help: "Unique. Letters, numbers, - and _" });
const desc: MasterField = { name: "description", label: "Description", type: "textarea" };

export const MASTERS: Record<MasterKey, MasterDefinition> = {
  designations: {
    label: "Designation Master",
    singular: "Designation",
    employeeField: "Designation",
    description: "Job titles such as EHS Officer, Site Engineer, Fitter.",
    codeField: "code",
    nameField: "title",
    importable: true,
    fields: [
      code(),
      { name: "title", label: "Designation name", type: "text", required: true, list: true },
      { name: "departmentId", label: "Department", type: "select", ref: "departments", list: true, help: "Optional — limits this designation to one department in the employee form" },
      desc,
    ],
  },
  departments: {
    label: "Department Master",
    singular: "Department",
    employeeField: "Department",
    description: "Organisational units such as HVAC Works, Electrical Works.",
    codeField: "code",
    nameField: "name",
    importable: true,
    fields: [code(), { name: "name", label: "Department name", type: "text", required: true, list: true }, desc],
  },
  work_sites: {
    label: "Work Site Master",
    singular: "Work site",
    employeeField: "Work site",
    description: "Sites / establishments where work is carried on.",
    codeField: "code",
    nameField: "name",
    importable: true,
    fields: [
      code(),
      { name: "name", label: "Work site name", type: "text", required: true, list: true },
      { name: "principalEmployer", label: "Client / principal employer", type: "text", list: true },
      { name: "address", label: "Site address", type: "textarea" },
      { name: "city", label: "Location / city", type: "text", list: true },
      { name: "contactName", label: "Site contact name", type: "text" },
      { name: "contactPhone", label: "Site contact phone", type: "text" },
      { name: "principalEmployerAddress", label: "Principal employer address", type: "textarea" },
      { name: "natureOfWork", label: "Nature of work", type: "text", placeholder: "e.g. HVAC WORKS" },
    ],
  },
  supervisors: {
    label: "Supervisor Master",
    singular: "Supervisor",
    employeeField: "Reporting supervisor",
    description: "Existing employees eligible to be a reporting supervisor.",
    codeField: null,
    nameField: null,
    importable: true,
    fields: [
      { name: "employeeId", label: "Employee", type: "employee", required: true, list: true, help: "Pick an existing active employee" },
      { name: "departmentIds", label: "Departments", type: "multiselect", ref: "departments", list: true, help: "Optional — leave empty to supervise any department" },
      { name: "workSiteIds", label: "Work sites", type: "multiselect", ref: "work_sites", list: true, help: "Optional — leave empty to supervise any site" },
      { name: "notes", label: "Notes", type: "textarea" },
    ],
  },
  employment_types: {
    label: "Employment Type Master",
    singular: "Employment type",
    employeeField: "Employment type",
    description: "Permanent, Contract, Temporary, Internship, Consultant…",
    codeField: "code",
    nameField: "name",
    importable: true,
    fields: [code(), { name: "name", label: "Employment type name", type: "text", required: true, list: true }, desc],
  },
  labour_statuses: {
    label: "Labour Status Master",
    singular: "Labour status",
    employeeField: "Labour status",
    description: "On-roll, Off-roll, Third-party payroll, Apprentice…",
    codeField: "code",
    nameField: "name",
    importable: true,
    fields: [code(), { name: "name", label: "Labour status name", type: "text", required: true, list: true }, desc],
  },
  employment_statuses: {
    label: "Employment Status Master",
    singular: "Employment status",
    employeeField: "Employment status",
    description: "Lifecycle statuses: Active, Probation, Resigned, Terminated…",
    codeField: "code",
    nameField: "name",
    importable: true,
    fields: [
      code(),
      { name: "name", label: "Employment status name", type: "text", required: true, list: true },
      {
        name: "lifecycle",
        label: "Meaning",
        type: "lifecycle",
        required: true,
        list: true,
        help: "“Employed” statuses can be chosen in the employee form; “Separated” statuses are used when deactivating (exit date applies).",
      },
      desc,
    ],
  },
  shifts: {
    label: "Shift Master",
    singular: "Shift",
    employeeField: "Shift",
    description: "Working shifts, including overnight shifts and the organisation default.",
    codeField: "code",
    nameField: "name",
    importable: true,
    fields: [
      code(),
      { name: "name", label: "Shift name", type: "text", required: true, list: true },
      { name: "startTime", label: "Expected entry time", type: "time", required: true, list: true },
      { name: "endTime", label: "Expected exit time", type: "time", required: true, list: true, help: "Earlier than entry = overnight shift (ends next day)" },
      { name: "fullDayHours", label: "Standard working hours", type: "number", min: 0.5, max: 24, step: 0.5, list: true },
      { name: "halfDayHours", label: "Minimum hours for half day", type: "number", min: 0.5, max: 24, step: 0.5 },
      { name: "breakMinutes", label: "Break duration (minutes)", type: "number", min: 0, max: 240, step: 5 },
      { name: "graceMinutes", label: "Grace period (minutes)", type: "number", min: 0, max: 240, step: 1, help: "Optional — blank uses the organisation grace period" },
      desc,
    ],
  },
  roles: {
    label: "Role Master",
    singular: "Role",
    employeeField: "Login account role",
    description: "Application roles and their module permissions.",
    codeField: "key",
    nameField: "name",
    importable: false,
    adminOnly: true,
    fields: [
      { name: "key", label: "Role code", type: "text", required: true, list: true, placeholder: "e.g. site_manager", help: "Unique; cannot be changed later" },
      { name: "name", label: "Role name", type: "text", required: true, list: true },
      { name: "description", label: "Description", type: "textarea", list: true },
    ],
  },
};

/* --------------------------- Validation (shared) --------------------------- */

const tx = (max: number) => z.string().trim().max(max);
const codeRule = tx(30)
  .min(1, "Required")
  .regex(/^[A-Za-z0-9_-]+$/, "Letters, numbers, - and _ only")
  .transform((s) => s.toUpperCase());
const optNum = (min: number, max: number) =>
  z.preprocess((v) => (v === "" || v === undefined ? null : v), z.coerce.number().min(min).max(max).nullable());

export const masterSchemas = {
  designations: z.object({ code: codeRule, title: tx(100).min(1, "Required"), departmentId: z.string().min(1).nullable().default(null), description: tx(500).default("") }),
  departments: z.object({ code: codeRule, name: tx(100).min(1, "Required"), description: tx(500).default("") }),
  work_sites: z.object({
    code: codeRule,
    name: tx(150).min(1, "Required"),
    principalEmployer: tx(200).default(""),
    address: tx(500).default(""),
    city: tx(100).default(""),
    contactName: tx(100).default(""),
    contactPhone: tx(20)
      .default("")
      .refine((v) => !v || /^[+\d][\d\s-]{6,19}$/.test(v), "Enter a valid phone number"),
    principalEmployerAddress: tx(500).default(""),
    natureOfWork: tx(200).default(""),
  }),
  supervisors: z.object({
    employeeId: z.string().min(1, "Select an employee"),
    departmentIds: z.array(z.string().min(1)).max(100).default([]),
    workSiteIds: z.array(z.string().min(1)).max(100).default([]),
    notes: tx(500).default(""),
  }),
  employment_types: z.object({ code: codeRule, name: tx(100).min(1, "Required"), description: tx(500).default("") }),
  labour_statuses: z.object({ code: codeRule, name: tx(100).min(1, "Required"), description: tx(500).default("") }),
  employment_statuses: z.object({ code: codeRule, name: tx(100).min(1, "Required"), lifecycle: z.enum(["active", "inactive"]), description: tx(500).default("") }),
  shifts: z
    .object({
      code: codeRule,
      name: tx(100).min(1, "Required"),
      startTime: z.string().refine(isValidTime, "Use HH:mm (24h)"),
      endTime: z.string().refine(isValidTime, "Use HH:mm (24h)"),
      fullDayHours: optNum(0.5, 24),
      halfDayHours: optNum(0.5, 24),
      breakMinutes: optNum(0, 240).transform((v) => v ?? 0),
      graceMinutes: optNum(0, 240),
      description: tx(500).default(""),
    })
    .refine((v) => v.startTime !== v.endTime, { message: "Entry and exit times cannot be the same", path: ["endTime"] })
    .refine((v) => v.fullDayHours == null || v.halfDayHours == null || v.halfDayHours <= v.fullDayHours, {
      message: "Half-day hours cannot exceed standard hours",
      path: ["halfDayHours"],
    }),
  roles: z.object({
    key: tx(30)
      .min(2, "Required")
      .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "Start with a letter; letters, numbers and _ only")
      .transform((s) => s.toLowerCase()),
    name: tx(60).min(1, "Required"),
    description: tx(300).default(""),
    permissions: z.array(z.string().max(60)).max(200).default([]),
  }),
} satisfies Record<MasterKey, z.ZodType>;

export type MasterInput<K extends MasterKey> = z.infer<(typeof masterSchemas)[K]>;

/** Shift helper shared by list, form preview and attendance maths. */
export function isOvernight(startTime: string, endTime: string) {
  return endTime <= startTime;
}

export function shiftDurationMinutes(startTime: string, endTime: string) {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  let d = eh * 60 + em - (sh * 60 + sm);
  if (d <= 0) d += 1440;
  return d;
}
