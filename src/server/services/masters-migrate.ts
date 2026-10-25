import { col, transaction } from "../db";
import type { EmploymentStatusMaster, SimpleMaster } from "@/lib/masters";
import { audit } from "./audit";
import { nowIso, stamp } from "../util";

/**
 * Repeatable migration from hard-coded dropdown values to Master records.
 *  - Seeds masters from the options the employee form used to hard-code.
 *  - Maps every employee's stored value to the matching master id.
 *  - Unknown legacy values get their own master record (never replaced by a default).
 *  - Gives legacy designations a code, marks system roles, and creates Supervisor
 *    Master entries for employees who already act as reporting supervisors.
 * Running it again changes nothing.
 */

const EMPLOYMENT_TYPES = [
  ["FULL_TIME", "Full-time"],
  ["PART_TIME", "Part-time"],
  ["CONTRACT", "Contract"],
  ["INTERN", "Intern"],
] as const;
const LABOUR_STATUSES = [
  ["ONROLL", "On-roll"],
  ["OFFROLL", "Off-roll"],
] as const;
const EMPLOYMENT_STATUSES = [
  ["ACTIVE", "Active", "active", true],
  ["PROBATION", "Probation", "active", false],
  ["NOTICE", "Notice Period", "active", false],
  ["INACTIVE", "Inactive", "inactive", true],
] as const;

export interface MigrationSummary {
  created: Record<string, string[]>;
  employeesMapped: number;
  employeesAlreadyMapped: number;
  unmatchedValues: string[];
  designationCodes: string[];
  supervisorsAdded: string[];
}

type Coll = "employment_types" | "labour_statuses" | "employment_statuses";

export async function migrateMasters(log: (m: string) => void = () => {}): Promise<MigrationSummary> {
  const summary: MigrationSummary = { created: {}, employeesMapped: 0, employeesAlreadyMapped: 0, unmatchedValues: [], designationCodes: [], supervisorsAdded: [] };
  const note = (k: string, v: string) => (summary.created[k] ??= []).push(v);

  await transaction(async () => {
    async function ensure(name: Coll, codeValue: string, label: string, extra: Partial<EmploymentStatusMaster> = {}, description = "") {
      const c = (await col(name)) as unknown as import("../db/types").Collection<SimpleMaster>;
      const found = await c.findOne({ code: codeValue });
      if (found) return found.id;
      const order = (await c.count()) + 1;
      const doc = { ...stamp(), code: codeValue, name: label, description, active: true, system: false, order, createdBy: null, updatedBy: null, ...extra } as SimpleMaster;
      await c.insertOne(doc);
      note(name, `${codeValue} (${label})`);
      return doc.id;
    }

    for (const [code, name] of EMPLOYMENT_TYPES) await ensure("employment_types", code, name);
    for (const [code, name] of LABOUR_STATUSES) await ensure("labour_statuses", code, name);
    for (const [code, name, lifecycle, system] of EMPLOYMENT_STATUSES) {
      await ensure("employment_statuses", code, name, { lifecycle, system });
    }

    // Employees: legacy string values → master ids
    const employees = await col("employees");
    for (const e of await employees.find()) {
      const legacy = e as unknown as Record<string, unknown>;
      const hasIds = legacy.employmentTypeId !== undefined && legacy.labourStatusId !== undefined && legacy.employmentStatusId !== undefined;
      if (hasIds) {
        summary.employeesAlreadyMapped++;
        continue;
      }
      const resolve = async (name: Coll, value: unknown, extra: Partial<EmploymentStatusMaster> = {}) => {
        if (value === null || value === undefined || value === "") return null;
        const code = String(value).toUpperCase();
        const c = (await col(name)) as unknown as import("../db/types").Collection<SimpleMaster>;
        const hit = await c.findOne({ code });
        if (hit) return hit.id;
        summary.unmatchedValues.push(`${name}: "${value}" (employee ${e.employeeCode})`);
        return ensure(name, code, String(value), extra, "Created by migration from existing employee data");
      };
      const legacyStatus = String(legacy.employmentStatus ?? "active");
      const patch: Record<string, unknown> = {
        employmentTypeId: legacy.employmentTypeId ?? (await resolve("employment_types", legacy.employmentType ?? "full_time")),
        labourStatusId: legacy.labourStatusId ?? (await resolve("labour_statuses", legacy.labourStatus)),
        employmentStatusId:
          legacy.employmentStatusId ?? (await resolve("employment_statuses", legacyStatus, { lifecycle: legacyStatus === "inactive" ? "inactive" : "active" })),
        employmentStatus: legacyStatus === "inactive" ? "inactive" : "active",
        employmentType: undefined,
        labourStatus: undefined,
      };
      await employees.updateById(e.id, patch as never);
      summary.employeesMapped++;
    }

    // Designations: give legacy records a unique code
    const designations = await col("designations");
    const all = await designations.find({}, { sort: { createdAt: 1 } });
    const used = new Set(all.map((d) => d.code).filter(Boolean) as string[]);
    let n = 1;
    for (const d of all) {
      if (d.code) continue;
      let code: string;
      do code = `DES${String(n++).padStart(3, "0")}`;
      while (used.has(code));
      used.add(code);
      await designations.updateById(d.id, { code, description: d.description ?? "", updatedAt: nowIso() });
      summary.designationCodes.push(`${code} = ${d.title}`);
    }

    // Roles: system flags + active
    const roles = await col("roles");
    for (const r of await roles.find()) {
      const system = ["admin", "supervisor", "employee"].includes(r.key);
      if (r.active === undefined || r.system !== system) await roles.updateById(r.id, { active: r.active ?? true, system });
    }

    // Supervisor Master: everyone already used as a reporting supervisor, plus supervisor-role users
    const sup = await col("supervisors");
    const emps = await employees.find();
    const users = await (await col("users")).find({ role: "supervisor" });
    const candidates = new Set<string>([
      ...emps.map((e) => e.supervisorEmployeeId).filter((x): x is string => !!x),
      ...users.map((u) => u.employeeId).filter((x): x is string => !!x),
    ]);
    for (const employeeId of candidates) {
      if (await sup.findOne({ employeeId })) continue;
      const e = emps.find((x) => x.id === employeeId);
      if (!e) continue;
      await sup.insertOne({ ...stamp(), employeeId, departmentIds: [], workSiteIds: [], notes: "Added by migration (existing reporting supervisor)", active: e.employmentStatus !== "inactive", createdBy: null, updatedBy: null });
      summary.supervisorsAdded.push(`${e.fullName} (${e.employeeCode})`);
    }

    const changed = Object.keys(summary.created).length || summary.employeesMapped || summary.designationCodes.length || summary.supervisorsAdded.length;
    if (changed) await audit({ userId: null, role: null, name: "system", ip: null }, { action: "masters_migration", module: "masters", newValues: summary as unknown as Record<string, unknown> });
  });

  for (const [k, v] of Object.entries(summary.created)) log(`Created ${k}: ${v.join(", ")}`);
  if (summary.employeesMapped) log(`Mapped ${summary.employeesMapped} employee(s) to master ids`);
  if (summary.unmatchedValues.length) log(`Unmatched legacy values preserved as new masters: ${summary.unmatchedValues.join("; ")}`);
  if (summary.designationCodes.length) log(`Designation codes assigned: ${summary.designationCodes.join(", ")}`);
  if (summary.supervisorsAdded.length) log(`Supervisor Master entries: ${summary.supervisorsAdded.join(", ")}`);
  return summary;
}
