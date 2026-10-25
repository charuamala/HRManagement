"use client";
import { useState } from "react";
import { FileSpreadsheet, Filter } from "lucide-react";
import { api, ApiError, download, qs, useApi } from "@/lib/api";
import { EMPLOYMENT_STATUS_LABELS, EMPLOYMENT_TYPE_LABELS } from "@/lib/constants";
import { MONTH_NAMES } from "@/lib/time";
import { Alert, Button, Card, Field, Input, Select } from "@/components/ui";

interface Options {
  departments: { id: string; name: string }[];
  designations: { id: string; title: string }[];
  locations: { id: string; name: string }[];
  employees: { id: string; employeeCode: string; fullName: string; supervisorEmployeeId: string | null }[];
}
interface Preview {
  label: string;
  days: number;
  employees: number;
  overall: { attendancePct: number; present: number; absent: number };
  canExport: boolean;
}
interface Form {
  year: string;
  month: string;
  departmentIds: string;
  designationIds: string;
  officeLocationIds: string;
  supervisorIds: string;
  employmentTypes: string;
  employmentStatuses: string;
  search: string;
}

/** Month/year + employee filters for the monthly attendance Excel (one employee per row, one column per day). */
export function MonthlyReportPanel({ today, departmentId }: { today: string; departmentId: string }) {
  const options = useApi<Options>("/api/meta/options");
  const [form, setForm] = useState<Form>({
    year: today.slice(0, 4),
    month: String(Number(today.slice(5, 7))),
    departmentIds: departmentId,
    designationIds: "",
    officeLocationIds: "",
    supervisorIds: "",
    employmentTypes: "",
    employmentStatuses: "",
    search: "",
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const [busy, setBusy] = useState<"apply" | "download" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = qs({ ...form, search: form.search.trim() });
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const thisYear = Number(today.slice(0, 4));
  const years = Array.from({ length: 7 }, (_, i) => thisYear + 1 - i);
  const supervisorIds = new Set(options.data?.employees.map((e) => e.supervisorEmployeeId).filter(Boolean));
  const supervisors = options.data?.employees.filter((e) => supervisorIds.has(e.id)) ?? [];

  async function apply() {
    setBusy("apply");
    setError(null);
    try {
      setPreview(await api<Preview>("GET", `/api/reports/monthly-attendance${query}&format=json`));
      setApplied(query);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(null);
    }
  }

  async function downloadExcel() {
    setBusy("download");
    setError(null);
    try {
      if (applied !== query) {
        const p = await api<Preview>("GET", `/api/reports/monthly-attendance${query}&format=json`);
        setPreview(p);
        setApplied(query);
        if (!p.employees) return;
      }
      await download(`/api/reports/monthly-attendance${query}&format=xlsx`);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(null);
    }
  }

  const idFor = (k: string) => `mr-${k}`;
  const select = (k: keyof Form, label: string, all: string, items: { value: string; label: string }[]) => (
    <Field label={label} htmlFor={idFor(k)}>
      <Select id={idFor(k)} value={form[k]} onChange={set(k)} disabled={!items.length && k === "supervisorIds"}>
        <option value="">{all}</option>
        {items.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </Field>
  );

  return (
    <Card title="Monthly attendance report — Excel" className="mb-5">
      <div role="region" aria-label="Monthly attendance report filters" className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Field label="Month" htmlFor={idFor("month")}>
            <Select id={idFor("month")} value={form.month} onChange={set("month")}>
              {MONTH_NAMES.map((m, i) => (
                <option key={m} value={String(i + 1)}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Year" htmlFor={idFor("year")}>
            <Select id={idFor("year")} value={form.year} onChange={set("year")}>
              {years.map((y) => (
                <option key={y} value={String(y)}>
                  {y}
                </option>
              ))}
            </Select>
          </Field>
          {select("departmentIds", "Department", "All departments", options.data?.departments.map((d) => ({ value: d.id, label: d.name })) ?? [])}
          {select("designationIds", "Designation", "All designations", options.data?.designations.map((d) => ({ value: d.id, label: d.title })) ?? [])}
          {select("officeLocationIds", "Work Site", "All work sites", options.data?.locations.map((d) => ({ value: d.id, label: d.name })) ?? [])}
          {select("supervisorIds", "Reporting Supervisor", supervisors.length ? "All supervisors" : "No supervisors assigned", supervisors.map((e) => ({ value: e.id, label: `${e.fullName} (${e.employeeCode})` })))}
          {select("employmentTypes", "Employment Type", "All types", Object.entries(EMPLOYMENT_TYPE_LABELS).map(([value, label]) => ({ value, label })))}
          {select("employmentStatuses", "Employee Status", "All statuses", Object.entries(EMPLOYMENT_STATUS_LABELS).map(([value, label]) => ({ value, label })))}
          <Field label="Employee search" htmlFor={idFor("search")}>
            <Input id={idFor("search")} value={form.search} onChange={set("search")} placeholder="Name or Employee ID" onKeyDown={(e) => e.key === "Enter" && apply()} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={apply} loading={busy === "apply"} disabled={!!busy}>
            <Filter className="h-4 w-4" /> Apply Filters
          </Button>
          <Button onClick={downloadExcel} loading={busy === "download"} disabled={!!busy || preview?.canExport === false}>
            <FileSpreadsheet className="h-4 w-4" /> {busy === "download" ? "Preparing Excel…" : "Download Excel"}
          </Button>
          <div className="text-sm text-slate-600" role="status" aria-live="polite">
            {preview &&
              applied === query &&
              (preview.employees ? (
                <span>
                  <strong>{preview.label}</strong> · {preview.days} days · {preview.employees} employee{preview.employees === 1 ? "" : "s"} · Attendance {preview.overall.attendancePct}%
                </span>
              ) : null)}
            {preview && applied !== query && <span className="text-amber-700">Filters changed — Download Excel uses the new selection.</span>}
          </div>
        </div>
        {preview && applied === query && !preview.employees && <Alert tone="warn">No employees match these filters for {preview.label}. Try widening the selection.</Alert>}
        {preview?.canExport === false && <Alert tone="info">You can preview this report but do not have permission to download it.</Alert>}
        {error && <Alert>{error}</Alert>}
      </div>
    </Card>
  );
}
