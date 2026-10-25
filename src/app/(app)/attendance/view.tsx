"use client";
import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Download, Lock, Save, Undo2, Upload } from "lucide-react";
import clsx from "clsx";
import { api, ApiError, qs, useApi } from "@/lib/api";
import { formatDisplayDate, formatHours, WEEKDAY_NAMES, dayOfWeek } from "@/lib/time";
import { isKpiKey, KPI_LABELS, KPI_PREDICATES } from "@/lib/kpi";
import { SOURCE_LABELS } from "@/lib/constants";
import type { AttendanceStatus, DayResult } from "@/lib/types";
import { ExportDialog, ImportDialog } from "@/components/attendance-transfer";
import { DateRangeBar } from "@/components/date-range";
import { Alert, Button, Card, Empty, Input, PageHeader, Select, Spinner, StatusBadge, Switch } from "@/components/ui";
import { Pagination, usePageSize } from "@/components/pagination";

interface RegRow {
  employee: { id: string; employeeCode: string; fullName: string; departmentId: string | null };
  day: DayResult;
  record: { id: string; version: number; statusCode: string; checkIn: string | null; checkOut: string | null; workedHours: number | null; remarks: string; source: string; employeeSubmitted: boolean } | null;
  fullDayHours: number;
  editable: boolean;
}
interface RegisterDay {
  date: string;
  rows: RegRow[];
  locked: boolean;
  finalizeAt: string;
}
interface Register {
  from: string;
  to: string;
  today: string;
  days: RegisterDay[];
}
/** A register row for one employee on one date; `key` = date|employeeId. */
type DayRow = RegRow & { key: string; date: string };
interface Draft {
  statusCode: string;
  checkIn: string;
  checkOut: string;
  workedHours: string;
  remarks: string;
}

const MAX_RANGE_DAYS = 31;
const keyOf = (date: string, employeeId: string) => `${date}|${employeeId}`;
const dayLabel = (date: string) => `${WEEKDAY_NAMES[dayOfWeek(date)].slice(0, 3)}, ${formatDisplayDate(date)}`;

const draftOf = (r: RegRow): Draft => ({
  statusCode: r.record?.statusCode ?? "pending",
  checkIn: r.record?.checkIn ?? "",
  checkOut: r.record?.checkOut ?? "",
  workedHours: r.record?.workedHours != null ? String(r.record.workedHours) : "",
  remarks: r.record?.remarks ?? "",
});

/** Present needs entry time or hours (keeps what's there, else a full day); absent must have neither. */
const presencePatch = (r: RegRow, d: Draft, present: boolean): Partial<Draft> =>
  present
    ? { statusCode: "present", workedHours: d.checkIn || d.workedHours ? d.workedHours : String(r.record?.workedHours ?? r.fullDayHours) }
    : { statusCode: "absent", checkIn: "", checkOut: "", workedHours: "" };

export function RegisterView() {
  const params = useSearchParams();
  const router = useRouter();
  const date = params.get("date") ?? "";
  const qFrom = params.get("from") ?? date;
  const qTo = params.get("to") ?? qFrom;
  const kpi = params.get("kpi") ?? "";
  const { data, error, loading, reload } = useApi<Register>(`/api/attendance/register${qs({ from: qFrom, to: qTo })}`);
  const options = useApi<{ statuses: AttendanceStatus[]; departments: { id: string; name: string }[] }>("/api/meta/options");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, Record<string, string>>>({});
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [transfer, setTransfer] = useState<"import" | "export" | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize("attendance", 25);

  useEffect(() => {
    setDrafts({});
    setRowErrors({});
    setSelected(new Set());
    setPage(1);
  }, [qFrom, qTo]);

  useEffect(() => setPage(1), [search, kpi]);

  const deptName = useMemo(() => new Map(options.data?.departments.map((d) => [d.id, d.name]) ?? []), [options.data]);
  const from = data?.from ?? qFrom;
  const to = data?.to ?? qTo;
  const multiDay = from !== to;
  const go = (f: string, t: string) => router.push(`/attendance${qs({ from: f, to: t, kpi })}`);

  const allRows = useMemo<DayRow[]>(() => (data?.days ?? []).flatMap((d) => d.rows.map((r) => ({ ...r, date: d.date, key: keyOf(d.date, r.employee.id) }))), [data]);
  const rowByKey = useMemo(() => new Map(allRows.map((r) => [r.key, r])), [allRows]);
  const lockedDays = data?.days.filter((d) => d.locked).length ?? 0;

  const rows = useMemo(() => {
    let r = allRows;
    if (kpi && isKpiKey(kpi)) r = r.filter((x) => KPI_PREDICATES[kpi](x.day));
    if (search) {
      const q = search.toLowerCase();
      r = r.filter((x) => x.employee.fullName.toLowerCase().includes(q) || x.employee.employeeCode.toLowerCase().includes(q));
    }
    return r;
  }, [allRows, kpi, search]);
  const employeeCount = new Set(rows.map((r) => r.employee.id)).size;
  // Edits and selections live in state keyed by row, so they survive paging; Save covers every page.
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageRows = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const pageSelectable = pageRows.filter((r) => r.editable);
  const pageAllSelected = pageSelectable.length > 0 && pageSelectable.every((r) => selected.has(r.key));
  const pageSomeSelected = pageSelectable.some((r) => selected.has(r.key));

  const selectable = rows.filter((r) => r.editable);
  const selectedRows = selectable.filter((r) => selected.has(r.key));

  function toggleMany(list: DayRow[], on: boolean) {
    setSelected((s) => {
      const next = new Set(s);
      for (const r of list) {
        if (on) next.add(r.key);
        else next.delete(r.key);
      }
      return next;
    });
  }

  const selectedAllPresent = selectedRows.length > 0 && selectedRows.every((r) => (drafts[r.key] ?? draftOf(r)).statusCode === "present");

  function markSelected(present: boolean) {
    setDrafts((ds) => {
      const next = { ...ds };
      for (const r of selectedRows) {
        const d = next[r.key] ?? draftOf(r);
        next[r.key] = { ...d, ...presencePatch(r, d, present) };
      }
      return next;
    });
  }

  const dirtyKeys = Object.keys(drafts).filter((k) => {
    const row = rowByKey.get(k);
    return row && JSON.stringify(drafts[k]) !== JSON.stringify(draftOf(row));
  });

  function edit(row: DayRow, patch: Partial<Draft>) {
    setDrafts((d) => ({ ...d, [row.key]: { ...(d[row.key] ?? draftOf(row)), ...patch } }));
  }

  /** Saves each day separately; days that fail keep their edits and show row errors. */
  async function save() {
    if (!data) return;
    setSaving(true);
    setMessage(null);
    setRowErrors({});
    const byDate = new Map<string, DayRow[]>();
    for (const k of dirtyKeys) {
      const row = rowByKey.get(k)!;
      byDate.set(row.date, [...(byDate.get(row.date) ?? []), row]);
    }
    const errors: Record<string, Record<string, string>> = {};
    const savedKeys: string[] = [];
    let created = 0;
    let updated = 0;
    let failedDays = 0;
    for (const [day, list] of byDate) {
      const payload = list.map((row) => {
        const d = drafts[row.key];
        return {
          employeeId: row.employee.id,
          statusCode: d.statusCode,
          checkIn: d.checkIn || null,
          checkOut: d.checkOut || null,
          workedHours: d.workedHours === "" ? null : Number(d.workedHours),
          remarks: d.remarks,
          expectedVersion: row.record?.version,
        };
      });
      try {
        const r = await api<{ created: number; updated: number }>("PUT", "/api/attendance/register", { date: day, rows: payload });
        created += r.created;
        updated += r.updated;
        savedKeys.push(...list.map((x) => x.key));
      } catch (e) {
        const err = e as ApiError;
        failedDays++;
        const re = err.details?.rowErrors;
        for (const row of list) {
          const rowErr = re ? re[row.employee.id] : { _: err.message };
          if (rowErr) errors[row.key] = rowErr;
        }
      }
    }
    setDrafts((ds) => Object.fromEntries(Object.entries(ds).filter(([k]) => !savedKeys.includes(k))));
    setRowErrors(errors);
    const saved = `${created} created, ${updated} updated`;
    setMessage(
      failedDays
        ? { tone: "error", text: `${Object.keys(errors).length} row(s) on ${failedDays} day(s) have errors and were not saved — fix the highlighted rows.${savedKeys.length ? ` Other days saved (${saved}).` : ""}` }
        : { tone: "success", text: `Saved — ${saved}.` },
    );
    setSaving(false);
    await reload();
  }

  function renderRow(row: DayRow) {
    const d = drafts[row.key] ?? draftOf(row);
    const errs = rowErrors[row.key] ?? {};
    const dirty = dirtyKeys.includes(row.key);
    const ro = !row.editable;
    const present = d.statusCode === "present";
    return (
      <tr key={row.key} className={clsx(dirty && "bg-amber-50/60", Object.keys(errs).length && "bg-red-50/60")}>
        <td className="px-3 py-2">
          <input
            type="checkbox"
            checked={selected.has(row.key)}
            disabled={ro}
            onChange={(e) => toggleMany([row], e.target.checked)}
            className="rounded border-slate-300"
            aria-label={`Select ${row.employee.fullName}`}
          />
        </td>
        <td className="px-3 py-2 font-mono text-xs">{row.employee.employeeCode}</td>
        <td className="px-3 py-2">
          <Link href={`/employees/${row.employee.id}`} className="font-medium hover:text-brand-700">
            {row.employee.fullName}
          </Link>
          {Object.values(errs).length > 0 && <div className="text-xs text-red-600">{Object.values(errs).join(" · ")}</div>}
        </td>
        <td className="px-3 py-2 text-slate-600">{row.employee.departmentId ? deptName.get(row.employee.departmentId) : "—"}</td>
        <td className="px-3 py-2">
          <Input type="time" value={d.checkIn} disabled={ro} onChange={(e) => edit(row, { checkIn: e.target.value })} invalid={!!errs.checkIn} className="w-28 py-1" aria-label={`Entry time for ${row.employee.fullName}`} />
        </td>
        <td className="px-3 py-2">
          <Input type="time" value={d.checkOut} disabled={ro} onChange={(e) => edit(row, { checkOut: e.target.value })} invalid={!!errs.checkOut} className="w-28 py-1" aria-label={`Exit time for ${row.employee.fullName}`} />
        </td>
        <td className="px-3 py-2">
          <Input
            type="number"
            min={0}
            max={24}
            step={0.5}
            value={d.workedHours}
            disabled={ro}
            placeholder={row.day.workedMinutes && !row.day.hoursOnly ? formatHours(row.day.workedMinutes) : ""}
            onChange={(e) => edit(row, { workedHours: e.target.value })}
            invalid={!!errs.workedHours}
            className="w-20 py-1"
            aria-label={`Worked hours for ${row.employee.fullName}`}
          />
        </td>
        <td className="px-3 py-2">
          <div className="flex items-center gap-2">
            <Switch checked={present} disabled={ro} onChange={(on) => edit(row, presencePatch(row, d, on))} label={`Present: ${row.employee.fullName}`} />
            <span className={clsx("text-xs font-medium", present ? "text-green-700" : "text-slate-500")}>{present ? "On" : "Off"}</span>
          </div>
        </td>
        <td className="px-3 py-2">
          <Select value={d.statusCode} disabled={ro} onChange={(e) => edit(row, { statusCode: e.target.value })} invalid={!!errs.statusCode} className="w-36 py-1" aria-label={`Status for ${row.employee.fullName}`}>
            {options.data?.statuses.map((s) => (
              <option key={s.code} value={s.code}>
                {s.label}
              </option>
            ))}
          </Select>
        </td>
        <td className="px-3 py-2">
          <StatusBadge category={row.day.category} label={row.day.statusLabel} />
          {row.day.isLate && <div className="mt-0.5 text-[11px] text-amber-700">Late {row.day.lateMinutes}m</div>}
          {row.day.missingCheckOut && <div className="mt-0.5 text-[11px] text-orange-700">⚠ Missing check-out</div>}
        </td>
        <td className="px-3 py-2">
          <Input value={d.remarks} disabled={ro} onChange={(e) => edit(row, { remarks: e.target.value })} className="w-48 py-1" aria-label={`Remarks for ${row.employee.fullName}`} />
        </td>
        <td className="px-3 py-2 text-xs text-slate-500">
          {row.record ? SOURCE_LABELS[row.record.source] : "—"}
          {row.record?.employeeSubmitted && <div className="font-medium text-purple-700">Employee-submitted</div>}
        </td>
      </tr>
    );
  }

  return (
    <div>
      <PageHeader
        title="Daily Attendance Register"
        subtitle={
          from
            ? `${multiDay ? `${dayLabel(from)} – ${dayLabel(to)}` : `${WEEKDAY_NAMES[dayOfWeek(from)]}, ${formatDisplayDate(from)}`}${lockedDays ? (multiDay ? ` · ${lockedDays} locked day${lockedDays === 1 ? "" : "s"}` : " · Locked") : ""}`
            : undefined
        }
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => setTransfer("import")}>
              <Upload className="h-4 w-4" /> Import Excel
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setTransfer("export")} disabled={!from}>
              <Download className="h-4 w-4" /> Export Excel
            </Button>
          </>
        }
      />
      <DateRangeBar from={from} to={to} today={data?.today ?? ""} maxDays={MAX_RANGE_DAYS} onChange={go} />
      {kpi && isKpiKey(kpi) && (
        <div className="mb-3">
          <Alert tone="info">
            Showing <strong>{KPI_LABELS[kpi]}</strong> only.{" "}
            <Link href={`/attendance${qs({ from, to })}`} className="underline">
              Show everyone
            </Link>
          </Alert>
        </div>
      )}
      {message && (
        <div className="mb-3">
          <Alert tone={message.tone}>{message.text}</Alert>
        </div>
      )}
      {error && <Alert>{error.message}</Alert>}
      <Card
        title={`${employeeCount} employee${employeeCount === 1 ? "" : "s"}${multiDay ? ` · ${data?.days.length ?? 0} days · ${rows.length} entries` : ""}`}
        actions={
          <div className="flex items-center gap-2">
            {selectedRows.length > 0 && (
              <div className="flex items-center gap-2 whitespace-nowrap rounded-lg border border-slate-200 px-2.5 py-1.5">
                <span className="text-xs text-slate-500">{selectedRows.length} selected · Present</span>
                <Switch checked={selectedAllPresent} onChange={markSelected} label={`Present for ${selectedRows.length} selected`} />
                <span className={clsx("text-xs font-medium", selectedAllPresent ? "text-green-700" : "text-slate-500")}>{selectedAllPresent ? "On" : "Off"}</span>
              </div>
            )}
            <Input placeholder="Search name or ID" value={search} onChange={(e) => setSearch(e.target.value)} className="w-48 py-1.5" aria-label="Search" />
            {dirtyKeys.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setDrafts({})}>
                <Undo2 className="h-4 w-4" /> Discard
              </Button>
            )}
            <Button size="sm" onClick={save} loading={saving} disabled={!dirtyKeys.length}>
              <Save className="h-4 w-4" /> Save changes{dirtyKeys.length ? ` (${dirtyKeys.length})` : ""}
            </Button>
          </div>
        }
      >
        {loading && !data ? (
          <Spinner />
        ) : !rows.length ? (
          <Empty title={multiDay ? "No employees for this period" : "No employees for this date"} />
        ) : (
          <div className="-mx-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 bg-white text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={pageAllSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = pageSomeSelected && !pageAllSelected;
                      }}
                      disabled={!pageSelectable.length}
                      onChange={(e) => toggleMany(pageSelectable, e.target.checked)}
                      className="rounded border-slate-300"
                      aria-label="Select all rows on this page"
                    />
                  </th>
                  <th className="px-3 py-2">Emp ID</th>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Department</th>
                  <th className="px-3 py-2">Entry</th>
                  <th className="px-3 py-2">Exit</th>
                  <th className="px-3 py-2">Worked hrs</th>
                  <th className="px-3 py-2">Present</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Result</th>
                  <th className="px-3 py-2">Remarks</th>
                  <th className="px-3 py-2">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {multiDay
                  ? (data?.days ?? []).map((day) => {
                      const dayRows = pageRows.filter((r) => r.date === day.date);
                      if (!dayRows.length) return null;
                      const daySelectable = dayRows.filter((r) => r.editable);
                      const daySelected = daySelectable.filter((r) => selected.has(r.key)).length;
                      const presentCount = dayRows.filter((r) => (drafts[r.key] ?? draftOf(r)).statusCode === "present").length;
                      return (
                        <Fragment key={day.date}>
                          <tr className="bg-slate-50">
                            <td className="px-3 py-2">
                              <input
                                type="checkbox"
                                checked={daySelectable.length > 0 && daySelected === daySelectable.length}
                                ref={(el) => {
                                  if (el) el.indeterminate = daySelected > 0 && daySelected < daySelectable.length;
                                }}
                                disabled={!daySelectable.length}
                                onChange={(e) => toggleMany(daySelectable, e.target.checked)}
                                className="rounded border-slate-300"
                                aria-label={`Select all on ${dayLabel(day.date)}`}
                              />
                            </td>
                            <td colSpan={11} className="px-3 py-2">
                              <div className="flex items-center gap-3 text-xs">
                                <span className="font-semibold text-slate-800">{dayLabel(day.date)}</span>
                                <span className="text-slate-500">
                                  {presentCount}/{dayRows.length} present
                                </span>
                                {day.locked && (
                                  <span className="inline-flex items-center gap-1 text-slate-500">
                                    <Lock className="h-3 w-3" aria-hidden /> Locked
                                  </span>
                                )}
                              </div>
                            </td>
                          </tr>
                          {dayRows.map(renderRow)}
                        </Fragment>
                      );
                    })
                  : pageRows.map(renderRow)}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > 0 && (
          <Pagination page={currentPage} pageSize={pageSize} total={rows.length} onPage={setPage} onPageSize={setPageSize} label={multiDay ? "entries" : "employees"} />
        )}
      </Card>
      {transfer === "export" && <ExportDialog open from={from} to={to} onClose={() => setTransfer(null)} />}
      <ImportDialog
        open={transfer === "import"}
        onClose={() => setTransfer(null)}
        onImported={() => {
          setDrafts({});
          reload();
        }}
      />
      <p className="mt-2 text-xs text-slate-500">
        Enter either entry/exit times or worked hours. Switching Present on fills a full day of hours if none are entered; switching it off marks Absent and clears times. Tick rows (or a whole day) to mark several at once. Ranges of up to 31 days can be viewed and edited together. &quot;Result&quot; is the status the system applies (holidays, weekly offs and pending days are resolved automatically).
      </p>
    </div>
  );
}
