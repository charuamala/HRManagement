"use client";
import { useState } from "react";
import { api, ApiError, useApi } from "@/lib/api";
import { EMPLOYMENT_STATUS_LABELS, EMPLOYMENT_TYPE_LABELS, GENDER_LABELS, LABOUR_STATUS_LABELS } from "@/lib/constants";
import { ROLE_LABELS } from "@/lib/permissions";
import { Alert, Button, Card, Field, Input, Select } from "@/components/ui";
import { PhotoPicker, resizeImage, uploadPhoto } from "@/components/photo";
import { aadhaarProblem, formatAadhaar } from "@/lib/aadhaar";

interface Options {
  departments: { id: string; name: string }[];
  designations: { id: string; title: string }[];
  locations: { id: string; name: string }[];
  shifts: { id: string; name: string; startTime: string; endTime: string }[];
  employees: { id: string; employeeCode: string; fullName: string }[];
}

export const EMPLOYEE_FIELDS = [
  "employeeCode", "uan", "title", "firstName", "lastName", "gender", "fatherName", "dateOfBirth", "permanentAddress", "localAddress",
  "labourStatus", "bankAccountNumber", "ifscCode", "officialEmail", "personalEmail", "mobile", "departmentId", "designationId",
  "supervisorEmployeeId", "officeLocationId", "employmentType", "dateOfJoining", "employmentStatus", "shiftId", "expectedEntryTime",
  "expectedExitTime", "standardWorkingHours", "weeklyOffDays",
] as const;

type Values = Record<string, unknown>;

export function emptyEmployee(today: string): Values {
  const v: Values = Object.fromEntries(EMPLOYEE_FIELDS.map((k) => [k, null]));
  return { ...v, title: "Mr.", gender: "male", labourStatus: "onroll", employmentType: "contract", employmentStatus: "active", dateOfJoining: today };
}

/**
 * Create / edit form covering every employee attribute (including the contractor
 * register fields: UAN, father's name, DOB, addresses, labour status, bank details).
 */
export function EmployeeForm({
  mode,
  initial,
  employeeId,
  isAdmin,
  onCancel,
  onSaved,
}: {
  mode: "create" | "edit";
  initial: Values;
  employeeId?: string;
  isAdmin: boolean;
  onCancel: () => void;
  onSaved: (result: { id: string; inviteLink?: string | null }) => void;
}) {
  const options = useApi<Options>("/api/meta/options");
  const [form, setForm] = useState<Values>(() => ({ ...Object.fromEntries(EMPLOYEE_FIELDS.map((k) => [k, initial[k] ?? null])), createAccount: true, role: "employee" }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newDesignation, setNewDesignation] = useState<string | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  /** undefined = unchanged (edit), "" = remove, digits = new value */
  const [aadhaar, setAadhaar] = useState<string | undefined>(mode === "create" ? "" : undefined);
  const aadhaarMasked = (initial.aadhaarMasked as string | null) ?? null;
  const [aadhaarRemove, setAadhaarRemove] = useState(false);
  const [desigError, setDesigError] = useState<string | null>(null);

  async function addDesignation() {
    if (!newDesignation?.trim()) return;
    setDesigError(null);
    try {
      const d = await api<{ id: string }>("POST", "/api/org/designations", { title: newDesignation.trim().toUpperCase(), departmentId: (form.departmentId as string) ?? null, active: true });
      await options.reload();
      setForm((f) => ({ ...f, designationId: d.id }));
      setNewDesignation(null);
    } catch (e) {
      setDesigError((e as ApiError).message);
    }
  }

  const v = (k: string) => (form[k] as string | null) ?? "";
  const set = (k: string) => (ev: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: ev.target.value === "" ? null : ev.target.value }));

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setSaving(true);
    setErrors({});
    setMessage(null);
    const payload: Values = {
      ...form,
      lastName: form.lastName ?? "",
      permanentAddress: form.permanentAddress ?? "",
      localAddress: form.localAddress ?? "",
      standardWorkingHours: form.standardWorkingHours ? Number(form.standardWorkingHours) : null,
    };
    if (mode === "edit") {
      delete payload.createAccount;
      delete payload.role;
    }
    // Edit: "" is sent only after an explicit Remove; an untouched "Change" box keeps the stored number.
    if (aadhaar !== undefined && (aadhaar !== "" || aadhaarRemove)) payload.aadhaarNumber = aadhaarRemove ? "" : aadhaar.replace(/\s/g, "");
    if (aadhaar) {
      const problem = aadhaarProblem(aadhaar);
      if (problem) {
        setErrors({ aadhaarNumber: problem });
        setMessage(problem);
        setSaving(false);
        return;
      }
    }
    try {
      if (mode === "create") {
        const r = await api<{ employee: { id: string }; inviteLink: string | null }>("POST", "/api/employees", payload);
        if (photo) {
          try {
            await uploadPhoto(r.employee.id, await resizeImage(photo));
          } catch (pe) {
            alert(`Employee created, but the photo could not be uploaded: ${(pe as Error).message}`);
          }
        }
        onSaved({ id: r.employee.id, inviteLink: r.inviteLink });
      } else {
        await api("PUT", `/api/employees/${employeeId}`, payload);
        onSaved({ id: employeeId! });
      }
    } catch (e) {
      const err = e as ApiError;
      setErrors(err.details?.fieldErrors ?? {});
      setMessage(err.message);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } finally {
      setSaving(false);
    }
  }

  const text = (k: string, label: string, props: Record<string, unknown> = {}) => (
    <Field label={label} error={errors[k]} htmlFor={k}>
      <Input id={k} value={v(k)} onChange={set(k)} invalid={!!errors[k]} {...props} />
    </Field>
  );
  const select = (k: string, label: string, opts: [string, string][], blank = "—") => (
    <Field label={label} error={errors[k]} htmlFor={k}>
      <Select id={k} value={v(k)} onChange={set(k)} invalid={!!errors[k]}>
        {blank !== "" && <option value="">{blank}</option>}
        {opts.map(([val, l]) => (
          <option key={val} value={val}>
            {l}
          </option>
        ))}
      </Select>
    </Field>
  );
  const o = options.data;
  const area = (k: string, label: string) => (
    <Field label={label} error={errors[k]} htmlFor={k}>
      <textarea id={k} rows={3} value={v(k)} onChange={set(k)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none" />
    </Field>
  );

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      {message && <Alert>{message}</Alert>}
      {mode === "create" && (
        <Card title="Profile photo">
          <PhotoPicker file={photo} onFile={setPhoto} />
        </Card>
      )}
      <Card title="Identity">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {text("employeeCode", "Employee ID *", { placeholder: "e.g. N610", autoFocus: mode === "create" })}
          {text("uan", "UAN (12 digits)", { inputMode: "numeric", maxLength: 12 })}
          <Field label="Aadhaar number" error={errors.aadhaarNumber} hint={aadhaar === undefined ? undefined : "12 digits · stored encrypted, shown masked"} htmlFor="aadhaarNumber">
            {aadhaar === undefined ? (
              <div className="flex items-center gap-2">
                <span className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-600">{aadhaarMasked ?? "Not recorded"}</span>
                <Button type="button" size="sm" variant="secondary" onClick={() => setAadhaar("")}>
                  {aadhaarMasked ? "Change" : "Add"}
                </Button>
                {aadhaarMasked && (
                  <Button type="button" size="sm" variant="ghost" className="text-red-600" onClick={() => { if (confirm("Remove the Aadhaar number from this employee?")) { setAadhaar(""); setErrors({}); setAadhaarRemove(true); } }}>
                    Remove
                  </Button>
                )}
              </div>
            ) : aadhaarRemove ? (
              <div className="flex items-center gap-2">
                <span className="flex-1 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">Will be removed on save</span>
                <Button type="button" size="sm" variant="ghost" onClick={() => { setAadhaar(undefined); setAadhaarRemove(false); }}>
                  Undo
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Input
                  id="aadhaarNumber"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={14}
                  placeholder="XXXX XXXX XXXX"
                  value={aadhaar}
                  invalid={!!errors.aadhaarNumber}
                  onChange={(ev) => setAadhaar(formatAadhaar(ev.target.value.replace(/\D/g, "").slice(0, 12)).trim())}
                />
                {mode === "edit" && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => setAadhaar(undefined)}>
                    Cancel
                  </Button>
                )}
              </div>
            )}
          </Field>
          {text("title", "Title", { placeholder: "Mr. / Ms." })}
          {text("firstName", "Employee name *")}
          {text("lastName", "Last name / initial")}
          {select("gender", "Gender", Object.entries(GENDER_LABELS))}
          {text("fatherName", "Father's name")}
          {text("dateOfBirth", "Date of birth", { type: "date" })}
          {text("mobile", "Mobile", { inputMode: "tel" })}
          {text("officialEmail", "Official email", { type: "email" })}
          {text("personalEmail", "Personal email", { type: "email" })}
        </div>
      </Card>
      <Card title="Employment">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {newDesignation === null ? (
            <Field label="Designation" error={errors.designationId} htmlFor="designationId">
              <Select
                id="designationId"
                value={v("designationId")}
                onChange={(ev) => (ev.target.value === "__new" ? setNewDesignation("") : set("designationId")(ev))}
              >
                <option value="">—</option>
                {(o?.designations ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}
                  </option>
                ))}
                {isAdmin && <option value="__new">+ Add new designation…</option>}
              </Select>
            </Field>
          ) : (
            <Field label="New designation" error={desigError ?? undefined} htmlFor="newDesignation">
              <div className="flex gap-1">
                <Input id="newDesignation" autoFocus value={newDesignation} onChange={(ev) => setNewDesignation(ev.target.value)} placeholder="e.g. ELECTRICIAN" onKeyDown={(ev) => ev.key === "Enter" && (ev.preventDefault(), addDesignation())} />
                <Button type="button" size="sm" onClick={addDesignation}>
                  Add
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setNewDesignation(null)}>
                  ✕
                </Button>
              </div>
            </Field>
          )}
          {select("departmentId", "Department", (o?.departments ?? []).map((d) => [d.id, d.name]))}
          {select("officeLocationId", "Work site", (o?.locations ?? []).map((d) => [d.id, d.name]))}
          {select("supervisorEmployeeId", "Reporting supervisor", (o?.employees ?? []).filter((x) => x.id !== employeeId).map((x) => [x.id, `${x.fullName} (${x.employeeCode})`]))}
          {text("dateOfJoining", "Date of joining *", { type: "date" })}
          {select("employmentType", "Employment type", Object.entries(EMPLOYMENT_TYPE_LABELS), "")}
          {select("labourStatus", "Labour status", Object.entries(LABOUR_STATUS_LABELS))}
          {select(
            "employmentStatus",
            "Employment status",
            Object.entries(EMPLOYMENT_STATUS_LABELS).filter(([k]) => k !== "inactive" || initial.employmentStatus === "inactive"),
            "",
          )}
          {select("shiftId", "Shift", (o?.shifts ?? []).map((s) => [s.id, `${s.name} (${s.startTime}–${s.endTime})`]), "Organisation default")}
          {text("expectedEntryTime", "Expected entry (override)", { type: "time" })}
          {text("expectedExitTime", "Expected exit (override)", { type: "time" })}
          {text("standardWorkingHours", "Standard hours (override)", { type: "number", step: 0.5, min: 0.5, max: 24 })}
        </div>
      </Card>
      <Card title="Address & bank">
        <div className="grid gap-4 sm:grid-cols-2">
          {area("permanentAddress", "Permanent address")}
          {area("localAddress", "Local address")}
          {isAdmin ? (
            <>
              {text("bankAccountNumber", "Account number")}
              {text("ifscCode", "IFSC code", { maxLength: 11, placeholder: "e.g. SBIN0001234" })}
            </>
          ) : (
            <p className="text-xs text-slate-500">Bank details are visible to administrators only.</p>
          )}
        </div>
      </Card>
      {mode === "create" && (
        <Card title="Login account">
          <div className="flex flex-wrap items-end gap-6">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!!form.createAccount} onChange={(e) => setForm((f) => ({ ...f, createAccount: e.target.checked }))} className="rounded border-slate-300" />
              Create a login (employee signs in with their Employee ID)
            </label>
            {!!form.createAccount && isAdmin && (
              <div className="w-48">{select("role", "Role", Object.entries(ROLE_LABELS), "")}</div>
            )}
          </div>
        </Card>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={saving}>
          {mode === "create" ? "Create employee" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
