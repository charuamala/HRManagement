import { col, transaction, DuplicateKeyError } from "../db";
import type { AttendanceTemplate, AttendanceTemplateVersion, CoreFieldKey, ID, TemplateField } from "@/lib/types";
import { defaultTemplateFields, LOCKED_CORE_FIELDS } from "@/lib/constants";
import { conflict, notFound, validationError, badRequest } from "../errors";
import { actorOf, requirePerm, type AuthContext } from "../auth/context";
import { audit } from "./audit";
import { nowIso, stamp } from "../util";

const CORE_TYPES: Record<CoreFieldKey, TemplateField["type"][]> = {
  attendance_date: ["date"],
  employee_code: ["employee_ref"],
  employee_name: ["calculated"],
  check_in: ["time"],
  check_out: ["time"],
  worked_hours: ["number"],
  status: ["dropdown"],
  remarks: ["text", "textarea"],
};

/** Enforces the integrity rules that keep historical records interpretable. */
export function validateFields(fields: TemplateField[]): TemplateField[] {
  const errors: string[] = [];
  const keys = new Set<string>();
  const cols = new Set<string>();
  const cores = new Set<string>();
  for (const f of fields) {
    if (keys.has(f.key)) errors.push(`Duplicate field key "${f.key}"`);
    keys.add(f.key);
    const colKey = f.importColumn.trim().toLowerCase();
    if (cols.has(colKey)) errors.push(`Duplicate import column "${f.importColumn}"`);
    cols.add(colKey);
    if (f.core) {
      if (cores.has(f.core)) errors.push(`Core field "${f.core}" appears twice`);
      cores.add(f.core);
      if (f.key !== f.core) errors.push(`Core field "${f.core}" must keep key "${f.core}"`);
      if (!CORE_TYPES[f.core].includes(f.type)) errors.push(`"${f.label}" must be of type ${CORE_TYPES[f.core].join("/")}`);
    } else if ((Object.keys(CORE_TYPES) as string[]).includes(f.key)) {
      errors.push(`Key "${f.key}" is reserved for a core field`);
    }
    if (f.type === "dropdown" && !f.core && f.options.length === 0) errors.push(`Dropdown "${f.label}" needs at least one option`);
    if (f.type === "calculated" && !f.calc) errors.push(`Calculated field "${f.label}" must choose a calculation`);
    if (f.validation.pattern) {
      try {
        new RegExp(f.validation.pattern);
      } catch {
        errors.push(`"${f.label}" has an invalid validation pattern`);
      }
    }
  }
  for (const core of LOCKED_CORE_FIELDS) if (!cores.has(core)) errors.push(`Core field "${core}" cannot be removed`);
  if (errors.length) throw validationError(errors[0], { errors });
  return [...fields]
    .sort((a, b) => a.order - b.order)
    .map((f, i) => {
      const out = { ...f, order: i + 1 };
      if (f.core === "attendance_date" || f.core === "employee_code" || f.core === "status") out.required = "yes";
      if (f.core === "check_in" || f.core === "check_out") out.required = out.required === "no" ? "conditional" : out.required;
      if (f.core && LOCKED_CORE_FIELDS.includes(f.core as (typeof LOCKED_CORE_FIELDS)[number])) out.visible = true;
      if (f.type === "calculated") out.editable = false;
      return out;
    });
}

export async function listTemplates(ctx: AuthContext) {
  requirePerm(ctx, "templates.view", "bulk_upload.export");
  const [templates, versions] = await Promise.all([
    (await col("attendance_templates")).find({}, { sort: { updatedAt: -1 } }),
    (await col("attendance_template_versions")).find(),
  ]);
  return templates.map((t) => {
    const active = versions.find((v) => v.id === t.activeVersionId);
    return { ...t, versionCount: versions.filter((v) => v.templateId === t.id).length, hasUnpublishedChanges: hasChanges(t, active) };
  });
}

function hasChanges(t: AttendanceTemplate, v: AttendanceTemplateVersion | undefined) {
  if (!v) return true;
  return JSON.stringify(t.fields) !== JSON.stringify(v.fields);
}

export async function getTemplate(ctx: AuthContext, id: ID) {
  requirePerm(ctx, "templates.view", "bulk_upload.export");
  const t = await (await col("attendance_templates")).findById(id);
  if (!t) throw notFound("Template");
  const versions = await (await col("attendance_template_versions")).find({ templateId: id }, { sort: { version: -1 } });
  const active = versions.find((v) => v.id === t.activeVersionId);
  return { template: t, versions, hasUnpublishedChanges: hasChanges(t, active) };
}

/** The active template's published version — drives forms, the register, import files and validation. */
export async function getActiveTemplate(): Promise<{ template: AttendanceTemplate | null; version: AttendanceTemplateVersion | null; fields: TemplateField[] }> {
  const t = await (await col("attendance_templates")).findOne({ status: "active" });
  if (!t?.activeVersionId) return { template: t, version: null, fields: defaultTemplateFields() };
  const v = await (await col("attendance_template_versions")).findById(t.activeVersionId);
  return { template: t, version: v, fields: v?.fields ?? defaultTemplateFields() };
}

export async function getVersion(id: ID) {
  return (await col("attendance_template_versions")).findById(id);
}

export async function createTemplate(ctx: AuthContext, input: { name: string; description: string; fields: TemplateField[] }) {
  requirePerm(ctx, "templates.create");
  const fields = validateFields(input.fields);
  const t: AttendanceTemplate = {
    ...stamp(),
    name: input.name,
    description: input.description,
    status: "draft",
    fields,
    latestVersion: 0,
    activeVersionId: null,
    createdBy: ctx.user.id,
    updatedBy: ctx.user.id,
  };
  try {
    await transaction(async () => {
      await (await col("attendance_templates")).insertOne(t);
      await audit(actorOf(ctx), { action: "create", module: "templates", recordId: t.id, newValues: { name: t.name, fields: fields.map((f) => f.key) } });
    });
  } catch (e) {
    if (e instanceof DuplicateKeyError) throw conflict("A template with this name already exists", { fieldErrors: { name: "Name in use" } });
    throw e;
  }
  return t;
}

/** Edits the working copy. Changes take effect only when the template is (re)activated as a new version. */
export async function updateTemplate(ctx: AuthContext, id: ID, input: { name: string; description: string; fields: TemplateField[] }) {
  requirePerm(ctx, "templates.edit");
  const c = await col("attendance_templates");
  const before = await c.findById(id);
  if (!before) throw notFound("Template");
  if (before.status === "archived") throw badRequest("Archived templates are read-only. Duplicate it to make changes.");
  const fields = validateFields(input.fields);
  // Keys of published fields must never be re-typed — older records/imports rely on them.
  const versions = await (await col("attendance_template_versions")).find({ templateId: id });
  for (const v of versions) {
    for (const old of v.fields) {
      const now = fields.find((f) => f.key === old.key);
      if (now && now.type !== old.type) {
        throw validationError(`Field "${old.key}" was published as ${old.type}; create a new field instead of changing its type`);
      }
    }
  }
  try {
    return await transaction(async () => {
      const saved = (await c.updateById(id, { name: input.name, description: input.description, fields, updatedBy: ctx.user.id, updatedAt: nowIso() }))!;
      await audit(actorOf(ctx), {
        action: "update",
        module: "templates",
        recordId: id,
        oldValues: { name: before.name, fields: before.fields },
        newValues: { name: saved.name, fields: saved.fields },
      });
      return saved;
    });
  } catch (e) {
    if (e instanceof DuplicateKeyError) throw conflict("A template with this name already exists", { fieldErrors: { name: "Name in use" } });
    throw e;
  }
}

export async function activateTemplate(ctx: AuthContext, id: ID, notes = "") {
  requirePerm(ctx, "templates.manage");
  const c = await col("attendance_templates");
  const t = await c.findById(id);
  if (!t) throw notFound("Template");
  if (t.status === "archived") throw badRequest("Restore or duplicate an archived template before activating it");
  const vc = await col("attendance_template_versions");
  const active = t.activeVersionId ? await vc.findById(t.activeVersionId) : null;
  return transaction(async () => {
    let versionId = t.activeVersionId;
    let version = t.latestVersion;
    if (!active || hasChanges(t, active)) {
      version = t.latestVersion + 1;
      const v: AttendanceTemplateVersion = { ...stamp(), templateId: id, version, name: t.name, fields: t.fields, notes, createdBy: ctx.user.id };
      await vc.insertOne(v);
      versionId = v.id;
    }
    const others = await c.find({ status: "active" });
    for (const o of others) if (o.id !== id) await c.updateById(o.id, { status: "draft", updatedAt: nowIso() });
    const saved = (await c.updateById(id, { status: "active", activeVersionId: versionId, latestVersion: version, updatedBy: ctx.user.id, updatedAt: nowIso() }))!;
    await audit(actorOf(ctx), { action: "activate", module: "templates", recordId: id, newValues: { version, versionId, deactivated: others.filter((o) => o.id !== id).map((o) => o.name) }, reason: notes || null });
    return saved;
  });
}

export async function duplicateTemplate(ctx: AuthContext, id: ID) {
  requirePerm(ctx, "templates.create");
  const t = await (await col("attendance_templates")).findById(id);
  if (!t) throw notFound("Template");
  const names = new Set((await (await col("attendance_templates")).find()).map((x) => x.name));
  let name = `${t.name} (copy)`;
  for (let i = 2; names.has(name); i++) name = `${t.name} (copy ${i})`;
  return createTemplate(ctx, { name, description: t.description, fields: t.fields });
}

export async function archiveTemplate(ctx: AuthContext, id: ID, restore = false) {
  requirePerm(ctx, "templates.delete");
  const c = await col("attendance_templates");
  const t = await c.findById(id);
  if (!t) throw notFound("Template");
  if (!restore && t.status === "active") throw badRequest("Activate another template before archiving the active one");
  const status = restore ? "draft" : "archived";
  const saved = (await c.updateById(id, { status, updatedBy: ctx.user.id, updatedAt: nowIso() }))!;
  await audit(actorOf(ctx), { action: restore ? "restore" : "archive", module: "templates", recordId: id, oldValues: { status: t.status }, newValues: { status } });
  return saved;
}
