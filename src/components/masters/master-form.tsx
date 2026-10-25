"use client";
import { useMemo, useState } from "react";
import { api, ApiError, useApi } from "@/lib/api";
import { MASTERS, isOvernight, shiftDurationMinutes, type MasterField, type MasterKey } from "@/lib/masters";
import { formatMinutes } from "@/lib/time";
import { Alert, Button, Field, Input, Modal, Select } from "@/components/ui";
import { PermissionGrid, type CatalogModule } from "./permission-grid";

type Row = Record<string, unknown> & { id: string; active?: boolean };

interface RefOption {
  id: string;
  label: string;
  active: boolean;
}

function useRefOptions(key: MasterKey | undefined) {
  const { data } = useApi<{ items: Row[] }>(key ? `/api/masters/${key}?status=all&pageSize=500` : null);
  return useMemo<RefOption[]>(
    () => (data?.items ?? []).map((r) => ({ id: r.id, label: `${String(r._name)}${r._code ? ` (${String(r._code)})` : ""}`, active: r.active !== false })),
    [data],
  );
}

/** Create / edit dialog for any master, driven by its definition in lib/masters. */
export function MasterForm({
  masterKey,
  record,
  catalog,
  onClose,
  onSaved,
}: {
  masterKey: MasterKey;
  record: Row | null;
  catalog: CatalogModule[];
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const def = MASTERS[masterKey];
  const editing = !!record;
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const v: Record<string, unknown> = {};
    for (const f of def.fields) v[f.name] = record?.[f.name] ?? (f.type === "multiselect" ? [] : f.type === "lifecycle" ? "active" : "");
    if (masterKey === "roles") v.permissions = (record?.permissions as string[]) ?? [];
    return v;
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (name: string, v: unknown) => setValues((s) => ({ ...s, [name]: v }));

  async function save() {
    setSaving(true);
    setErrors({});
    setMessage(null);
    const payload: Record<string, unknown> = { ...values };
    for (const f of def.fields) if (f.type === "number" && (payload[f.name] === "" || payload[f.name] === undefined)) payload[f.name] = null;
    for (const f of def.fields) if (f.type === "select" && payload[f.name] === "") payload[f.name] = null;
    try {
      if (editing) await api("PUT", `/api/masters/${masterKey}/${record!.id}`, payload);
      else await api("POST", `/api/masters/${masterKey}`, payload);
      onSaved(`${def.singular} ${editing ? "updated" : "created"}.`);
    } catch (e) {
      const err = e as ApiError;
      setErrors(err.details?.fieldErrors ?? {});
      setMessage(err.message);
    } finally {
      setSaving(false);
    }
  }

  const locked = (f: MasterField) =>
    editing && ((masterKey === "roles" && f.name === "key") || (masterKey === "supervisors" && f.name === "employeeId") || (!!record?.system && masterKey === "employment_statuses" && (f.name === "code" || f.name === "lifecycle")));

  return (
    <Modal
      open
      wide
      title={`${editing ? "Edit" : "Add"} ${def.singular}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            {editing ? "Save changes" : `Create ${def.singular.toLowerCase()}`}
          </Button>
        </>
      }
    >
      {message && <Alert>{message}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        {def.fields.map((f) => (
          <div key={f.name} className={f.type === "textarea" || f.type === "multiselect" ? "sm:col-span-2" : undefined}>
            <FieldInput masterKey={masterKey} field={f} value={values[f.name]} onChange={(v) => set(f.name, v)} error={errors[f.name]} disabled={locked(f)} />
          </div>
        ))}
      </div>
      {masterKey === "shifts" && typeof values.startTime === "string" && typeof values.endTime === "string" && values.startTime && values.endTime && (
        <Alert tone="info">
          {isOvernight(values.startTime, values.endTime) ? "Overnight shift — exit is on the next day. " : "Same-day shift. "}
          Duration {formatMinutes(shiftDurationMinutes(values.startTime, values.endTime))}
          {values.breakMinutes ? ` (incl. ${values.breakMinutes} min break)` : ""}.
        </Alert>
      )}
      {masterKey === "roles" && (
        <div>
          <div className="mb-2 text-xs font-medium text-slate-600">Permissions</div>
          {record?.key === "admin" ? (
            <Alert tone="info">The Admin role always has every permission.</Alert>
          ) : (
            <PermissionGrid catalog={catalog} value={values.permissions as string[]} onChange={(p) => set("permissions", p)} />
          )}
        </div>
      )}
    </Modal>
  );
}

function FieldInput({ masterKey, field: f, value, onChange, error, disabled }: { masterKey: MasterKey; field: MasterField; value: unknown; onChange: (v: unknown) => void; error?: string; disabled?: boolean }) {
  const refOpts = useRefOptions(f.type === "select" || f.type === "multiselect" ? f.ref : undefined);
  const employees = useApi<{ employees: { id: string; employeeCode: string; fullName: string }[] }>(f.type === "employee" ? "/api/meta/options" : null);
  const supervisors = useApi<{ items: Row[] }>(f.type === "employee" && masterKey === "supervisors" ? "/api/masters/supervisors?status=all&pageSize=500" : null);
  const label = `${f.label}${f.required ? " *" : ""}`;
  const id = `mf-${f.name}`;
  const str = value === null || value === undefined ? "" : String(value);

  if (f.type === "textarea")
    return (
      <Field label={label} error={error} hint={f.help} htmlFor={id}>
        <textarea id={id} rows={2} value={str} disabled={disabled} onChange={(e) => onChange(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none" />
      </Field>
    );
  if (f.type === "select") {
    const opts = refOpts.filter((o) => o.active || o.id === value);
    return (
      <Field label={label} error={error} hint={f.help} htmlFor={id}>
        <Select id={id} value={str} disabled={disabled} onChange={(e) => onChange(e.target.value)} invalid={!!error}>
          <option value="">—</option>
          {opts.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
              {o.active ? "" : " (inactive)"}
            </option>
          ))}
        </Select>
      </Field>
    );
  }
  if (f.type === "multiselect") {
    const sel = new Set((value as string[]) ?? []);
    const opts = refOpts.filter((o) => o.active || sel.has(o.id));
    return (
      <Field label={f.label} error={error} hint={f.help}>
        <div className="flex max-h-36 flex-wrap gap-2 overflow-y-auto rounded-lg border border-slate-200 p-2">
          {!opts.length && <span className="text-xs text-slate-400">No records yet</span>}
          {opts.map((o) => (
            <label key={o.id} className="inline-flex items-center gap-1.5 rounded-md bg-slate-50 px-2 py-1 text-xs">
              <input
                type="checkbox"
                checked={sel.has(o.id)}
                disabled={disabled}
                onChange={(e) => {
                  const n = new Set(sel);
                  if (e.target.checked) n.add(o.id);
                  else n.delete(o.id);
                  onChange([...n]);
                }}
              />
              {o.label}
            </label>
          ))}
        </div>
      </Field>
    );
  }
  if (f.type === "employee") {
    const taken = new Set((supervisors.data?.items ?? []).map((s) => s.employeeId as string));
    const list = (employees.data?.employees ?? []).filter((e) => e.id === value || !taken.has(e.id));
    return (
      <Field label={label} error={error} hint={f.help} htmlFor={id}>
        <Select id={id} value={str} disabled={disabled} onChange={(e) => onChange(e.target.value)} invalid={!!error}>
          <option value="">Select employee…</option>
          {list.map((e) => (
            <option key={e.id} value={e.id}>
              {e.fullName} ({e.employeeCode})
            </option>
          ))}
        </Select>
      </Field>
    );
  }
  if (f.type === "lifecycle")
    return (
      <Field label={label} error={error} hint={f.help} htmlFor={id}>
        <Select id={id} value={str || "active"} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          <option value="active">Employed (selectable in employee form)</option>
          <option value="inactive">Separated (used when deactivating)</option>
        </Select>
      </Field>
    );
  return (
    <Field label={label} error={error} hint={f.help} htmlFor={id}>
      <Input
        id={id}
        type={f.type === "time" ? "time" : f.type === "number" ? "number" : "text"}
        min={f.min}
        max={f.max}
        step={f.step}
        placeholder={f.placeholder}
        value={str}
        disabled={disabled}
        invalid={!!error}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}
