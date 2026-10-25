import { col, transaction, DuplicateKeyError, type CollectionName } from "../db";
import type { ID } from "@/lib/types";
import { MASTERS, masterSchemas, isOvernight, type MasterField, type MasterKey } from "@/lib/masters";
import { isPermissionKey, allPermissionKeys, DEFAULT_ROLE_PERMISSIONS } from "@/lib/permissions";
import { conflict, forbidden, notFound, validationError, badRequest } from "../errors";
import { actorOf, can, requirePerm, type AuthContext } from "../auth/context";
import { audit } from "./audit";
import { getSettings, saveSettings } from "./settings";
import { parse } from "../http";
import { diff, nowIso, stamp } from "../util";
import { escapeRegex } from "../db/query";
import { parseTimeLoose, parseUpload, toCsv, toXlsx, type Column } from "./tabular";

/**
 * Generic Master Management service. Each master maps to a collection and a small
 * handler with its own reference checks and rules; everything else (validation,
 * uniqueness, audit, activation, import/export) is shared.
 */

type Doc = Record<string, unknown> & { id: string; active?: boolean; createdAt: string; updatedAt: string; createdBy?: string | null; updatedBy?: string | null };

const COLLECTION: Record<MasterKey, CollectionName> = {
  designations: "designations",
  departments: "departments",
  work_sites: "office_locations",
  supervisors: "supervisors",
  employment_types: "employment_types",
  labour_statuses: "labour_statuses",
  employment_statuses: "employment_statuses",
  shifts: "shifts",
  roles: "roles",
};

const SYSTEM_ROLES = ["admin", "supervisor", "employee"];

async function c(key: MasterKey) {
  return (await col(COLLECTION[key])) as unknown as import("../db/types").Collection<Doc>;
}

const count = async (name: CollectionName, filter: Record<string, unknown>) => (await col(name)).count(filter as never);

/* ------------------------------ Permissions ------------------------------ */

function assertAccess(ctx: AuthContext, key: MasterKey, op: "view" | "create" | "edit" | "delete" | "import" | "export") {
  if (key === "roles") {
    if (op === "view" || op === "export") return requirePerm(ctx, "masters.view", "permissions.view");
    // Roles carry permissions — only Administrators may change them (prevents privilege escalation).
    if (ctx.role !== "admin") throw forbidden("Only Administrators can manage roles and permissions");
    return;
  }
  requirePerm(ctx, `masters.${op}`);
}

/* ------------------------------ Display data ----------------------------- */

export function codeOf(key: MasterKey, d: Doc): string {
  const f = MASTERS[key].codeField;
  return f ? String(d[f] ?? "") : "";
}

export function nameOf(key: MasterKey, d: Doc): string {
  const f = MASTERS[key].nameField;
  return f ? String(d[f] ?? "") : "";
}

/* --------------------------- Reference checking -------------------------- */

/** Reasons a record cannot be deleted (empty = safe to delete). */
async function references(key: MasterKey, d: Doc): Promise<string[]> {
  const out: string[] = [];
  const add = (n: number, what: string) => n && out.push(`${n} ${what}`);
  switch (key) {
    case "designations":
      add(await count("employees", { designationId: d.id }), "employee(s)");
      break;
    case "departments":
      add(await count("employees", { departmentId: d.id }), "employee(s)");
      add(await count("designations", { departmentId: d.id }), "designation(s)");
      add(await count("supervisors", { departmentIds: d.id }), "supervisor assignment(s)");
      add(await count("supervisor_assignments", { departmentId: d.id }), "supervisor scope(s)");
      break;
    case "work_sites":
      add(await count("employees", { officeLocationId: d.id }), "employee(s)");
      add(await count("holidays", { officeLocationIds: d.id }), "holiday(s)");
      add(await count("supervisors", { workSiteIds: d.id }), "supervisor assignment(s)");
      break;
    case "supervisors":
      add(await count("employees", { supervisorEmployeeId: d.employeeId as string }), "employee(s) reporting to this supervisor");
      break;
    case "employment_types":
      add(await count("employees", { employmentTypeId: d.id }), "employee(s)");
      break;
    case "labour_statuses":
      add(await count("employees", { labourStatusId: d.id }), "employee(s)");
      break;
    case "employment_statuses":
      add(await count("employees", { employmentStatusId: d.id }), "employee(s)");
      break;
    case "shifts": {
      add(await count("employees", { shiftId: d.id }), "employee(s)");
      add(await count("employee_shift_assignments", { shiftId: d.id }), "shift history entr(ies)");
      add(await count("attendance_records", { shiftId: d.id }), "attendance record(s)");
      if ((await getSettings()).defaultShiftId === d.id) out.push("the organisation default shift setting");
      break;
    }
    case "roles":
      add(await count("users", { role: d.key as string }), "user account(s)");
      break;
  }
  return out;
}

/** Number of employees (or users, for roles) currently using a record — shown in the list. */
async function usage(key: MasterKey, d: Doc): Promise<number> {
  const field: Partial<Record<MasterKey, string>> = {
    designations: "designationId",
    departments: "departmentId",
    work_sites: "officeLocationId",
    employment_types: "employmentTypeId",
    labour_statuses: "labourStatusId",
    employment_statuses: "employmentStatusId",
    shifts: "shiftId",
  };
  if (key === "roles") return count("users", { role: d.key as string });
  if (key === "supervisors") return count("employees", { supervisorEmployeeId: d.employeeId as string });
  return count("employees", { [field[key]!]: d.id });
}

/* ------------------------------ Normalisation ---------------------------- */

async function assertExists(name: CollectionName, ids: (string | null | undefined)[], field: string) {
  for (const id of ids) {
    if (id && !(await (await col(name)).findById(id))) throw validationError(`${field}: selected record does not exist`, { fieldErrors: { [field]: "Not found" } });
  }
}

/** Cross-record rules and the final stored shape for a master. */
async function normalize(ctx: AuthContext, key: MasterKey, input: Record<string, unknown>, existing: Doc | null): Promise<Record<string, unknown>> {
  switch (key) {
    case "designations":
      await assertExists("departments", [input.departmentId as string], "departmentId");
      return input;
    case "supervisors": {
      const emp = await (await col("employees")).findById(input.employeeId as string);
      if (!emp) throw validationError("Employee not found", { fieldErrors: { employeeId: "Not found" } });
      if (!existing && emp.employmentStatus === "inactive") throw validationError("Only active employees can be made supervisors", { fieldErrors: { employeeId: "Employee is inactive" } });
      if (existing && existing.employeeId !== input.employeeId) throw validationError("The employee of a supervisor record cannot be changed — create a new record instead", { fieldErrors: { employeeId: "Cannot change" } });
      await assertExists("departments", input.departmentIds as string[], "departmentIds");
      await assertExists("office_locations", input.workSiteIds as string[], "workSiteIds");
      return input;
    }
    case "employment_statuses": {
      if (existing?.system && (existing.code !== input.code || existing.lifecycle !== input.lifecycle)) {
        throw validationError("System statuses cannot change their code or meaning");
      }
      if (existing && existing.lifecycle !== input.lifecycle && (await count("employees", { employmentStatusId: existing.id }))) {
        throw validationError("This status is assigned to employees; its meaning (employed / separated) cannot change");
      }
      return input;
    }
    case "shifts": {
      // Standard hours default to the shift length minus break when left blank.
      return input;
    }
    case "roles": {
      const keys = (input.permissions as string[]) ?? [];
      const bad = keys.filter((k) => !isPermissionKey(k));
      if (bad.length) throw validationError(`Unknown permissions: ${bad.join(", ")}`);
      if (!existing && SYSTEM_ROLES.includes(input.key as string)) throw validationError("This role code is reserved", { fieldErrors: { key: "Reserved" } });
      if (existing && existing.key !== input.key) throw validationError("Role code cannot be changed", { fieldErrors: { key: "Cannot change" } });
      return input;
    }
    default:
      void ctx;
      return input;
  }
}

async function assertUnique(key: MasterKey, values: Record<string, unknown>, selfId?: string) {
  const def = MASTERS[key];
  const coll = await c(key);
  const errs: Record<string, string> = {};
  for (const f of [def.codeField, def.nameField]) {
    if (!f || values[f] === undefined) continue;
    const v = String(values[f]);
    const hit = await coll.findOne({ [f]: { $regex: `^${escapeRegex(v)}$`, $options: "i" } } as never);
    if (hit && hit.id !== selfId) errs[f] = `${f === def.codeField ? "Code" : "Name"} "${v}" already exists`;
  }
  if (key === "supervisors") {
    const hit = await coll.findOne({ employeeId: values.employeeId } as never);
    if (hit && hit.id !== selfId) errs.employeeId = "This employee is already in the Supervisor Master";
  }
  if (Object.keys(errs).length) throw conflict(Object.values(errs)[0], { fieldErrors: errs });
}

/* ---------------------------------- CRUD --------------------------------- */

export interface ListQuery {
  search?: string;
  status?: "all" | "active" | "inactive";
  page?: number;
  pageSize?: number;
  /** Include records referenced by these ids even if inactive (keeps historical selections visible). */
}

export async function listMaster(ctx: AuthContext, key: MasterKey, q: ListQuery = {}) {
  assertAccess(ctx, key, "view");
  const coll = await c(key);
  let rows = await coll.find();
  const [users, employees, departments, sites, settings, rolePerms] = await Promise.all([
    (await col("users")).find(),
    (await col("employees")).find(),
    (await col("departments")).find(),
    (await col("office_locations")).find(),
    getSettings(),
    key === "roles" ? (await col("role_permissions")).find() : Promise.resolve([]),
  ]);
  const userName = new Map(users.map((u) => [u.id, u.displayName]));
  const emp = new Map(employees.map((e) => [e.id, e]));
  const dept = new Map(departments.map((d) => [d.id, d.name]));
  const site = new Map(sites.map((s) => [s.id, s.name]));

  const decorate = async (d: Doc) => {
    const extra: Record<string, unknown> = {};
    if (key === "supervisors") {
      const e = emp.get(d.employeeId as string);
      extra.employeeName = e ? `${e.fullName} (${e.employeeCode})` : "Unknown employee";
      extra.employeeActive = e?.employmentStatus !== "inactive";
      extra.departmentNames = ((d.departmentIds as string[]) ?? []).map((id) => dept.get(id) ?? "—");
      extra.workSiteNames = ((d.workSiteIds as string[]) ?? []).map((id) => site.get(id) ?? "—");
    }
    if (key === "designations") extra.departmentName = d.departmentId ? (dept.get(d.departmentId as string) ?? "—") : "Any department";
    if (key === "shifts") {
      extra.overnight = isOvernight(d.startTime as string, d.endTime as string);
      extra.isDefault = settings.defaultShiftId === d.id;
    }
    if (key === "roles") {
      extra.permissions = d.key === "admin" ? allPermissionKeys() : rolePerms.filter((p) => p.role === d.key).map((p) => p.permissionKey);
      extra.editablePermissions = d.key !== "admin";
    }
    return {
      ...d,
      active: d.active !== false,
      _code: codeOf(key, d),
      _name: key === "supervisors" ? extra.employeeName : nameOf(key, d),
      createdByName: d.createdBy ? (userName.get(d.createdBy) ?? "—") : "System",
      updatedByName: d.updatedBy ? (userName.get(d.updatedBy) ?? "—") : "System",
      usage: await usage(key, d),
      ...extra,
    };
  };

  let items = await Promise.all(rows.map(decorate));
  if (q.status === "active") items = items.filter((r) => r.active);
  if (q.status === "inactive") items = items.filter((r) => !r.active);
  if (q.search) {
    const s = q.search.toLowerCase();
    items = items.filter((r) => String(r._code).toLowerCase().includes(s) || String(r._name).toLowerCase().includes(s));
  }
  items.sort((a, b) => String(a._code || a._name).localeCompare(String(b._code || b._name), undefined, { numeric: true }));
  rows = [];
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? 25;
  return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize, defaultShiftId: settings.defaultShiftId };
}

export async function getMaster(ctx: AuthContext, key: MasterKey, id: ID) {
  assertAccess(ctx, key, "view");
  const d = await (await c(key)).findById(id);
  if (!d) throw notFound(MASTERS[key].singular);
  return d;
}

function storedFields(key: MasterKey, input: Record<string, unknown>) {
  if (key === "roles") {
    const { permissions: _p, ...rest } = input;
    void _p;
    return rest;
  }
  return input;
}

async function writeRolePermissions(roleKey: string, keys: string[]) {
  const rp = await col("role_permissions");
  await rp.deleteMany({ role: roleKey });
  const unique = [...new Set(keys)];
  if (unique.length) await rp.insertMany(unique.map((permissionKey) => ({ ...stamp(), role: roleKey, permissionKey })));
}

export async function createMaster(ctx: AuthContext, key: MasterKey, raw: unknown) {
  assertAccess(ctx, key, "create");
  const input = parse(masterSchemas[key], raw) as Record<string, unknown>;
  const values = await normalize(ctx, key, input, null);
  await assertUnique(key, values);
  const doc: Doc = {
    ...stamp(),
    ...storedFields(key, values),
    active: true,
    createdBy: ctx.user.id,
    updatedBy: ctx.user.id,
    ...(key === "employment_types" || key === "labour_statuses" || key === "employment_statuses" ? { system: false, order: await (await c(key)).count() + 1 } : {}),
    ...(key === "roles" ? { system: false } : {}),
  } as Doc;
  try {
    return await transaction(async () => {
      await (await c(key)).insertOne(doc);
      if (key === "roles") await writeRolePermissions(values.key as string, values.permissions as string[]);
      await audit(actorOf(ctx), { action: "create", module: `masters.${key}`, recordId: doc.id, newValues: { ...doc, ...(key === "roles" ? { permissions: values.permissions } : {}) } });
      return doc;
    });
  } catch (e) {
    if (e instanceof DuplicateKeyError) throw conflict("A record with this code already exists");
    throw e;
  }
}

export async function updateMaster(ctx: AuthContext, key: MasterKey, id: ID, raw: unknown) {
  assertAccess(ctx, key, "edit");
  const coll = await c(key);
  const before = await coll.findById(id);
  if (!before) throw notFound(MASTERS[key].singular);
  const input = parse(masterSchemas[key], raw) as Record<string, unknown>;
  if (key === "roles" && before.key === "admin" && JSON.stringify(input.permissions ?? []) !== JSON.stringify(allPermissionKeys())) {
    // The Admin role always holds everything; only its name/description are editable.
    input.permissions = allPermissionKeys();
  }
  const values = await normalize(ctx, key, input, before);
  await assertUnique(key, values, id);
  const patch = storedFields(key, values);
  const d = diff(before, patch as Partial<Doc>);
  let permChange: { old: string[]; next: string[] } | null = null;
  if (key === "roles" && before.key !== "admin") {
    const old = (await (await col("role_permissions")).find({ role: before.key as string })).map((p) => p.permissionKey).sort();
    const next = [...new Set(values.permissions as string[])].sort();
    if (JSON.stringify(old) !== JSON.stringify(next)) permChange = { old, next };
  }
  if (!d && !permChange) return before;
  try {
    return await transaction(async () => {
      const saved = (await coll.updateById(id, { ...patch, updatedBy: ctx.user.id, updatedAt: nowIso() } as Partial<Doc>))!;
      if (permChange) await writeRolePermissions(before.key as string, permChange.next);
      await audit(actorOf(ctx), {
        action: "update",
        module: `masters.${key}`,
        recordId: id,
        oldValues: { ...(d?.old ?? {}), ...(permChange ? { permissions: permChange.old } : {}) },
        newValues: { ...(d?.new ?? {}), ...(permChange ? { permissions: permChange.next } : {}) },
      });
      return saved;
    });
  } catch (e) {
    if (e instanceof DuplicateKeyError) throw conflict("A record with this code already exists");
    throw e;
  }
}

export async function setMasterActive(ctx: AuthContext, key: MasterKey, id: ID, active: boolean, reason?: string) {
  assertAccess(ctx, key, "edit");
  const coll = await c(key);
  const before = await coll.findById(id);
  if (!before) throw notFound(MASTERS[key].singular);
  if ((before.active !== false) === active) return before;
  if (!active) {
    if (key === "employment_statuses" && before.system) throw badRequest("System employment statuses cannot be deactivated");
    if (key === "roles" && before.system) throw badRequest("System roles cannot be deactivated");
    if (key === "roles") {
      const n = await count("users", { role: before.key as string });
      if (n) throw conflict(`${n} user account(s) have this role. Move them to another role first.`);
    }
    if (key === "shifts" && (await getSettings()).defaultShiftId === id) throw conflict("This is the organisation default shift. Choose another default first.");
  } else if (key === "supervisors") {
    const e = await (await col("employees")).findById(before.employeeId as string);
    if (e?.employmentStatus === "inactive") throw badRequest("The employee is inactive; reactivate the employee first");
  }
  return transaction(async () => {
    const saved = (await coll.updateById(id, { active, updatedBy: ctx.user.id, updatedAt: nowIso() } as Partial<Doc>))!;
    await audit(actorOf(ctx), { action: active ? "activate" : "deactivate", module: `masters.${key}`, recordId: id, oldValues: { active: !active }, newValues: { active }, reason: reason ?? null });
    return saved;
  });
}

export async function deleteMaster(ctx: AuthContext, key: MasterKey, id: ID, reason?: string) {
  assertAccess(ctx, key, "delete");
  const coll = await c(key);
  const before = await coll.findById(id);
  if (!before) throw notFound(MASTERS[key].singular);
  if (before.system) throw badRequest("System records cannot be deleted");
  const refs = await references(key, before);
  if (refs.length) throw conflict(`Cannot delete — still used by ${refs.join(", ")}. Deactivate it instead to stop new assignments.`, { references: refs });
  await transaction(async () => {
    await coll.deleteById(id);
    if (key === "roles") await (await col("role_permissions")).deleteMany({ role: before.key as string });
    await audit(actorOf(ctx), { action: "delete", module: `masters.${key}`, recordId: id, oldValues: before, reason: reason ?? null });
  });
  return { deleted: true };
}

export async function setDefaultShift(ctx: AuthContext, id: ID) {
  assertAccess(ctx, "shifts", "edit");
  const shift = await (await col("shifts")).findById(id);
  if (!shift) throw notFound("Shift");
  if (shift.active === false) throw badRequest("Activate the shift before making it the default");
  const s = await getSettings();
  if (s.defaultShiftId === id) return { defaultShiftId: id };
  await saveSettings({ ...s, defaultShiftId: id });
  await audit(actorOf(ctx), { action: "default_shift_changed", module: "masters.shifts", recordId: id, oldValues: { defaultShiftId: s.defaultShiftId }, newValues: { defaultShiftId: id } });
  return { defaultShiftId: id };
}

export async function mastersSummary(ctx: AuthContext) {
  const out: Record<string, { total: number; active: number }> = {};
  for (const key of Object.keys(COLLECTION) as MasterKey[]) {
    if (key === "roles" ? !(can(ctx, "masters.view") || can(ctx, "permissions.view")) : !can(ctx, "masters.view")) continue;
    const all = await (await c(key)).find();
    out[key] = { total: all.length, active: all.filter((d) => d.active !== false).length };
  }
  return out;
}

/* ---------------------------- Import / Export ---------------------------- */

function importFields(key: MasterKey): MasterField[] {
  return MASTERS[key].fields.filter((f) => !f.noImport);
}

function columnsFor(key: MasterKey): Column[] {
  const cols: Column[] = importFields(key).map((f) => ({ key: f.name, label: f.type === "employee" ? "Employee ID" : f.label }));
  cols.push({ key: "active", label: "Active" });
  return cols;
}

interface RefMaps {
  byKey: Partial<Record<MasterKey, Map<string, string>>>; // lowercased code/name → id
  idTo: Partial<Record<MasterKey, Map<string, string>>>; // id → code (for export)
  employeesByCode: Map<string, string>;
  employeeCodeById: Map<string, string>;
}

async function refMaps(keys: MasterKey[]): Promise<RefMaps> {
  const byKey: RefMaps["byKey"] = {};
  const idTo: RefMaps["idTo"] = {};
  for (const k of keys) {
    const docs = await (await c(k)).find();
    const m = new Map<string, string>();
    const r = new Map<string, string>();
    for (const d of docs) {
      const cd = codeOf(k, d);
      const nm = nameOf(k, d);
      if (cd) m.set(cd.toLowerCase(), d.id);
      if (nm) m.set(nm.toLowerCase(), d.id);
      r.set(d.id, cd || nm);
    }
    byKey[k] = m;
    idTo[k] = r;
  }
  const emps = await (await col("employees")).find();
  return {
    byKey,
    idTo,
    employeesByCode: new Map(emps.map((e) => [e.employeeCode.toUpperCase(), e.id])),
    employeeCodeById: new Map(emps.map((e) => [e.id, e.employeeCode])),
  };
}

const refKeysOf = (key: MasterKey) => [...new Set(importFields(key).filter((f) => f.ref).map((f) => f.ref!))];

export async function exportMaster(ctx: AuthContext, key: MasterKey, format: "csv" | "xlsx") {
  assertAccess(ctx, key, "export");
  const docs = await (await c(key)).find();
  const maps = await refMaps(refKeysOf(key));
  const rows = docs.map((d) => {
    const r: Record<string, unknown> = { active: d.active !== false ? "Yes" : "No" };
    for (const f of importFields(key)) {
      const v = d[f.name];
      if (f.type === "employee") r[f.name] = maps.employeeCodeById.get(v as string) ?? "";
      else if (f.type === "select" && f.ref) r[f.name] = v ? (maps.idTo[f.ref]?.get(v as string) ?? "") : "";
      else if (f.type === "multiselect" && f.ref) r[f.name] = ((v as string[]) ?? []).map((id) => maps.idTo[f.ref!]?.get(id) ?? "").join("; ");
      else if (f.type === "lifecycle") r[f.name] = v === "inactive" ? "Separated" : "Employed";
      else r[f.name] = v ?? "";
    }
    if (key === "roles") r.permissions = "";
    return r;
  });
  await audit(actorOf(ctx), { action: "export", module: `masters.${key}`, newValues: { format, rows: rows.length } });
  return fileOf(key, format, columnsFor(key), rows, "export");
}

export async function masterTemplate(ctx: AuthContext, key: MasterKey, format: "csv" | "xlsx") {
  assertAccess(ctx, key, "import");
  if (!MASTERS[key].importable) throw badRequest("This master does not support bulk upload");
  return fileOf(key, format, columnsFor(key), [], "template");
}

async function fileOf(key: MasterKey, format: "csv" | "xlsx", columns: Column[], rows: Record<string, unknown>[], kind: string) {
  const name = `${key}-${kind}-${nowIso().slice(0, 10)}`;
  if (format === "csv") return { data: toCsv(columns, rows), filename: `${name}.csv`, contentType: "text/csv; charset=utf-8" };
  return {
    data: await toXlsx([{ name: MASTERS[key].singular.slice(0, 31), columns, rows }]),
    filename: `${name}.xlsx`,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
}

export interface ImportRowResult {
  row: number;
  values: Record<string, string>;
  errors: string[];
  action: "create" | "update" | "skip";
  existingId: string | null;
}

/** Validates (and optionally commits) a master upload. Same rules as manual entry. */
export async function importMaster(ctx: AuthContext, key: MasterKey, file: { name: string; bytes: Buffer }, opts: { commit: boolean; updateExisting: boolean }) {
  assertAccess(ctx, key, "import");
  if (opts.updateExisting) assertAccess(ctx, key, "edit");
  assertAccess(ctx, key, "create");
  if (!MASTERS[key].importable) throw badRequest("This master does not support bulk upload");
  const sheet = await parseUpload(file.name, file.bytes);
  const cols = columnsFor(key);
  const header = new Map(sheet.headers.map((h) => [h.trim().toLowerCase(), h]));
  const missing = importFields(key)
    .filter((f) => f.required)
    .map((f) => (f.type === "employee" ? "Employee ID" : f.label))
    .filter((l) => !header.has(l.toLowerCase()));
  if (missing.length) throw validationError(`Missing required column(s): ${missing.join(", ")}`);
  const known = new Set(cols.map((x) => x.label.toLowerCase()));
  const unknown = sheet.headers.filter((h) => !known.has(h.trim().toLowerCase()));

  const maps = await refMaps(refKeysOf(key));
  const coll = await c(key);
  const existing = await coll.find();
  const def = MASTERS[key];
  const seen = new Set<string>();
  const results: ImportRowResult[] = [];
  const toApply: { result: ImportRowResult; input: Record<string, unknown> }[] = [];

  for (const r of sheet.rows) {
    const get = (label: string) => (r.values[header.get(label.toLowerCase()) ?? ""] ?? "").trim();
    const errors: string[] = [];
    const input: Record<string, unknown> = {};
    for (const f of importFields(key)) {
      const label = f.type === "employee" ? "Employee ID" : f.label;
      const v = get(label);
      if (f.type === "employee") {
        const id = maps.employeesByCode.get(v.toUpperCase());
        if (!v) errors.push("Employee ID is required");
        else if (!id) errors.push(`Unknown Employee ID "${v}"`);
        input[f.name] = id ?? "";
      } else if (f.type === "select" && f.ref) {
        if (!v) input[f.name] = null;
        else {
          const id = maps.byKey[f.ref]?.get(v.toLowerCase());
          if (!id) errors.push(`${f.label}: "${v}" not found in ${MASTERS[f.ref].label}`);
          input[f.name] = id ?? null;
        }
      } else if (f.type === "multiselect" && f.ref) {
        const parts = v.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
        const ids: string[] = [];
        for (const p of parts) {
          const id = maps.byKey[f.ref]?.get(p.toLowerCase());
          if (!id) errors.push(`${f.label}: "${p}" not found`);
          else ids.push(id);
        }
        input[f.name] = ids;
      } else if (f.type === "lifecycle") {
        const s = v.toLowerCase();
        input[f.name] = ["separated", "inactive", "no"].includes(s) ? "inactive" : ["employed", "active", "yes", ""].includes(s) ? "active" : (errors.push(`${f.label} must be Employed or Separated`), "active");
      } else if (f.type === "time") {
        const t = v ? parseTimeLoose(v) : null;
        if (v && !t) errors.push(`${f.label}: invalid time "${v}" (use HH:mm)`);
        input[f.name] = t ?? "";
      } else if (f.type === "number") {
        input[f.name] = v === "" ? null : v;
      } else {
        input[f.name] = v;
      }
    }
    const activeRaw = get("Active").toLowerCase();
    const active = activeRaw === "" ? true : ["yes", "y", "true", "1", "active"].includes(activeRaw) ? true : ["no", "n", "false", "0", "inactive"].includes(activeRaw) ? false : null;
    if (active === null) errors.push('Active must be "Yes" or "No"');

    const parsed = masterSchemas[key].safeParse(input);
    if (!parsed.success) for (const i of parsed.error.issues) errors.push(`${i.path.join(".") || "row"}: ${i.message}`);

    const identity = key === "supervisors" ? String(input.employeeId) : String((parsed.success ? (parsed.data as Record<string, unknown>)[def.codeField!] : input[def.codeField!]) ?? "").toUpperCase();
    if (identity && seen.has(identity)) errors.push("Duplicate of an earlier row in this file");
    if (identity) seen.add(identity);
    const match = existing.find((d) => (key === "supervisors" ? d.employeeId === identity : codeOf(key, d).toUpperCase() === identity));
    let action: ImportRowResult["action"] = match ? (opts.updateExisting ? "update" : "skip") : "create";
    if (match && !opts.updateExisting) errors.push("Already exists (enable “Update existing records” to overwrite)");
    if (errors.length) action = "skip";
    const result: ImportRowResult = { row: r.rowNumber, values: Object.fromEntries(cols.map((x) => [x.label, get(x.label)])), errors, action, existingId: match?.id ?? null };
    results.push(result);
    if (!errors.length && parsed.success) toApply.push({ result, input: { ...(parsed.data as Record<string, unknown>), __active: active } });
  }

  let created = 0;
  let updated = 0;
  if (opts.commit) {
    for (const { result, input } of toApply) {
      const { __active, ...data } = input;
      try {
        const saved =
          result.action === "update" && result.existingId
            ? await updateMaster(ctx, key, result.existingId, data)
            : await createMaster(ctx, key, data);
        if (__active === false && (saved as Doc).active !== false) await setMasterActive(ctx, key, (saved as Doc).id, false, "Bulk upload");
        if (__active === true && (saved as Doc).active === false) await setMasterActive(ctx, key, (saved as Doc).id, true, "Bulk upload");
        if (result.action === "update") updated++;
        else created++;
      } catch (e) {
        result.errors.push(e instanceof Error ? e.message : "Failed");
        result.action = "skip";
      }
    }
    await audit(actorOf(ctx), { action: "bulk_import", module: `masters.${key}`, newValues: { fileName: file.name, created, updated, failed: results.filter((x) => x.errors.length).length } });
  }
  return {
    committed: opts.commit,
    totals: {
      rows: results.length,
      valid: results.filter((x) => !x.errors.length).length,
      invalid: results.filter((x) => x.errors.length).length,
      toCreate: results.filter((x) => x.action === "create" && !x.errors.length).length,
      toUpdate: results.filter((x) => x.action === "update" && !x.errors.length).length,
      created,
      updated,
    },
    warnings: unknown.map((h) => `Unknown column "${h}" was ignored`),
    columns: cols.map((x) => x.label),
    rows: results,
  };
}

/** Default permissions for the system roles (used by the migration). */
export const SYSTEM_ROLE_DEFAULTS = DEFAULT_ROLE_PERMISSIONS;
