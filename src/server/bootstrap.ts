import fs from "fs";
import path from "path";
import { col } from "./db";
import type { AttendanceStatus, Role, User } from "@/lib/types";
import { allPermissionKeys, DEFAULT_ROLE_PERMISSIONS, MODULES, ACTION_DESCRIPTIONS, ROLE_LABELS } from "@/lib/permissions";
import { CATEGORY_COLORS, defaultTemplateFields, SYSTEM_STATUSES } from "@/lib/constants";
import { hashPassword } from "./auth/password";
import { defaultSettings, getSettings, saveSettings } from "./services/settings";
import { randomToken, stamp } from "./util";
import { audit } from "./services/audit";

/**
 * Idempotent base data every installation needs: roles, the permission catalog,
 * default role permissions, system statuses, settings, a default shift, the default
 * attendance template (published as v1) and the first administrator.
 */
export async function ensureBaseData(opts: { dataDir?: string; log?: (m: string) => void } = {}) {
  const log = opts.log ?? (() => {});

  const roles = await col("roles");
  for (const key of ["admin", "supervisor", "employee"] as const) {
    if (!(await roles.findOne({ key }))) {
      const r: Role = { ...stamp(), key, name: ROLE_LABELS[key], description: `${ROLE_LABELS[key]} role`, system: true };
      await roles.insertOne(r);
    }
  }

  const perms = await col("permissions");
  const existing = new Set((await perms.find()).map((p) => p.key));
  for (const [module, def] of Object.entries(MODULES)) {
    for (const action of def.actions) {
      const key = `${module}.${action}`;
      if (!existing.has(key)) await perms.insertOne({ ...stamp(), key, module, action, description: `${def.label}: ${ACTION_DESCRIPTIONS[action]}` });
    }
  }

  const rp = await col("role_permissions");
  for (const role of ["supervisor", "employee"] as const) {
    if (!(await rp.count({ role }))) {
      await rp.insertMany(DEFAULT_ROLE_PERMISSIONS[role].map((permissionKey) => ({ ...stamp(), role, permissionKey })));
    }
  }
  void allPermissionKeys;

  const statuses = await col("attendance_statuses");
  for (const s of SYSTEM_STATUSES) {
    if (!(await statuses.findOne({ code: s.code }))) {
      const doc: AttendanceStatus = { ...stamp(), code: s.code, label: s.label, category: s.category, color: CATEGORY_COLORS[s.category], credit: s.category === "present" ? 1 : s.category === "half_day" ? 0.5 : 0, system: true, active: true, order: s.order };
      await statuses.insertOne(doc);
    }
  }

  const shifts = await col("shifts");
  let general = await shifts.findOne({ code: "GEN" });
  if (!general) {
    general = await shifts.insertOne({ ...stamp(), name: "General Shift", code: "GEN", startTime: "09:00", endTime: "17:00", breakMinutes: 30, graceMinutes: null, fullDayHours: 8, halfDayHours: 4, active: true });
    log("Created default shift GEN 09:00–17:00");
  }

  const settingsCol = await col("attendance_settings");
  if (!(await settingsCol.findById("org"))) {
    await saveSettings({ ...defaultSettings(), defaultShiftId: general.id });
    log("Created organisation settings (time zone Asia/Kolkata)");
  } else {
    const s = await getSettings();
    if (!s.defaultShiftId) await saveSettings({ ...s, defaultShiftId: general.id });
  }

  const users = await col("users");
  let admin = await users.findOne({ role: "admin", status: "active" });
  if (!admin) {
    const generated = !process.env.ADMIN_PASSWORD;
    const password = process.env.ADMIN_PASSWORD ?? `Adm-${randomToken(9)}1`;
    const user: User = {
      ...stamp(),
      email: process.env.ADMIN_EMAIL?.toLowerCase() ?? null,
      employeeId: null,
      employeeCode: "ADMIN",
      displayName: "System Administrator",
      role: "admin",
      passwordHash: await hashPassword(password),
      status: "active",
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: null,
      passwordChangedAt: null,
    };
    admin = await users.insertOne(user);
    if (generated) {
      const dir = path.resolve(opts.dataDir ?? process.env.DATA_DIR ?? "./data");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "initial-admin-password.txt");
      fs.writeFileSync(file, `Login ID: ADMIN\nPassword: ${password}\n\nChange this password after first sign-in, then delete this file.\n`, { mode: 0o600 });
      log(`Created administrator (login ID "ADMIN"). Initial password written to ${file}`);
    } else {
      log('Created administrator (login ID "ADMIN") with ADMIN_PASSWORD from the environment');
    }
    await audit({ userId: null, role: null, name: "system", ip: null }, { action: "bootstrap_admin", module: "users", recordId: admin.id });
  }

  const templates = await col("attendance_templates");
  if (!(await templates.count())) {
    const fields = defaultTemplateFields();
    const t = await templates.insertOne({ ...stamp(), name: "Default Attendance Template", description: "Standard daily attendance: date, employee, entry/exit or worked hours, status, remarks.", status: "active", fields, latestVersion: 1, activeVersionId: null, createdBy: admin.id, updatedBy: admin.id });
    const v = await (await col("attendance_template_versions")).insertOne({ ...stamp(), templateId: t.id, version: 1, name: t.name, fields, notes: "Initial version", createdBy: admin.id });
    await templates.updateById(t.id, { activeVersionId: v.id });
    log("Published default attendance template v1");
  }
  return { admin };
}
