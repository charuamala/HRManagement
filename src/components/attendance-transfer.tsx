"use client";
import { useState } from "react";
import { Download, FileSpreadsheet, Upload } from "lucide-react";
import { api, ApiError, download, qs, upload } from "@/lib/api";
import { monthRange } from "@/lib/time";
import type { BulkImportJob, BulkImportRow, ImportMode } from "@/lib/types";
import { Alert, Button, Field, Input, Modal, Select } from "@/components/ui";

/** Downloads the register for a date range as an Excel/CSV file in import-template layout. */
export function ExportDialog({ open, from: initialFrom, to: initialTo, onClose }: { open: boolean; from: string; to: string; onClose: () => void }) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [format, setFormat] = useState<"xlsx" | "csv">("xlsx");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setRange = (f: string, t: string) => {
    setFrom(f);
    setTo(t);
  };
  const month = initialFrom ? monthRange(Number(initialFrom.slice(0, 4)), Number(initialFrom.slice(5, 7))) : null;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await download(`/api/attendance/export${qs({ from, to, format })}`);
      onClose();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Export attendance"
      open={open}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={run} loading={busy} disabled={!from || !to}>
            <Download className="h-4 w-4" /> Download
          </Button>
        </>
      }
    >
      {error && <Alert>{error}</Alert>}
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" onClick={() => setRange(initialFrom, initialTo)}>
          Range on screen
        </Button>
        {month && (
          <Button variant="secondary" size="sm" onClick={() => setRange(month.from, month.to)}>
            This month
          </Button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="From" htmlFor="export-from">
          <Input id="export-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To" htmlFor="export-to">
          <Input id="export-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      <Field label="Format" htmlFor="export-format">
        <Select id="export-format" value={format} onChange={(e) => setFormat(e.target.value as "xlsx" | "csv")}>
          <option value="xlsx">Excel (.xlsx)</option>
          <option value="csv">CSV (.csv)</option>
        </Select>
      </Field>
      <p className="text-xs text-slate-500">One row per employee per day, up to 62 days. Edit the file and upload it with Import — rows left without a status are ignored.</p>
    </Modal>
  );
}

type JobView = { job: BulkImportJob; rows: BulkImportRow[]; total: number };

const MODES: { value: ImportMode; label: string }[] = [
  { value: "upsert", label: "Add new and update existing records" },
  { value: "insert", label: "Add new records only (skip existing)" },
  { value: "update", label: "Update existing records only" },
];

/** Upload → validate → review problems → commit. */
export function ImportDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [view, setView] = useState<JobView | null>(null);
  const [mode, setMode] = useState<ImportMode>("upsert");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const job = view?.job;
  const done = job && ["completed", "partially_completed", "failed"].includes(job.status);

  function reset() {
    setFile(null);
    setView(null);
    setMode("upsert");
    setError(null);
  }

  async function close() {
    if (job?.status === "validated") await api("POST", `/api/imports/${job.id}/cancel`).catch(() => null);
    if (done) onImported();
    reset();
    onClose();
  }

  async function step(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  const validate = () =>
    step(async () => {
      const form = new FormData();
      form.append("file", file!);
      const j = await upload<BulkImportJob>("/api/imports", form);
      setView(await api<JobView>("GET", `/api/imports/${j.id}${qs({ status: "errors", pageSize: 50 })}`));
    });

  const commit = () =>
    step(async () => {
      await api<BulkImportJob>("POST", `/api/imports/${job!.id}/commit`, { mode });
      setView(await api<JobView>("GET", `/api/imports/${job!.id}${qs({ status: "failed", pageSize: 50 })}`));
    });

  // Rows that would actually change something in the chosen mode (identical rows are no-ops).
  const unchanged = job?.totals.unchanged ?? 0;
  const changedExisting = job ? job.totals.conflicts - unchanged : 0;
  const newRows = job ? job.totals.valid - job.totals.conflicts : 0;
  const importable = !job ? 0 : mode === "insert" ? newRows : mode === "update" ? changedExisting : newRows + changedExisting;
  const nothingChanged = !!done && job!.results.inserted + job!.results.updated === 0 && job!.results.failed === 0;

  return (
    <Modal
      title="Import attendance from Excel"
      open={open}
      onClose={close}
      wide
      footer={
        done ? (
          <Button onClick={close}>Done</Button>
        ) : job ? (
          <>
            <Button variant="secondary" onClick={() =>
                step(async () => {
                  await api("POST", `/api/imports/${job.id}/cancel`);
                  reset();
                })
              } disabled={busy}>
              Choose another file
            </Button>
            <Button onClick={commit} loading={busy} disabled={!!job.headerErrors.length || !importable}>
              Import {importable} row{importable === 1 ? "" : "s"}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button onClick={validate} loading={busy} disabled={!file}>
              <Upload className="h-4 w-4" /> Upload &amp; check
            </Button>
          </>
        )
      }
    >
      {error && <Alert>{error}</Alert>}

      {!job && (
        <>
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <FileSpreadsheet className="h-4 w-4 text-green-700" aria-hidden />
            Need a file? Download the
            <button type="button" className="font-medium text-brand-700 underline" onClick={() => step(() => download("/api/imports/template?format=xlsx"))}>
              Excel template
            </button>
            or use <strong>Export</strong> to get the register pre-filled.
          </div>
          <Field label="Attendance file (.xlsx or .csv, max 5 MB)" htmlFor="import-file">
            <Input id="import-file" type="file" accept=".xlsx,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
          <p className="text-xs text-slate-500">Nothing is saved until you review the check results and click Import.</p>
        </>
      )}

      {job && (
        <>
          <p className="text-xs text-slate-500">{job.fileName}</p>
          {job.headerErrors.map((m) => (
            <Alert key={m}>{m}</Alert>
          ))}
          {job.headerWarnings.map((m) => (
            <Alert key={m} tone="warn">
              {m}
            </Alert>
          ))}
          {done ? (
            <div className="grid grid-cols-4 gap-2">
              <Stat label="Added" value={job.results.inserted} tone="text-green-700" />
              <Stat label="Updated" value={job.results.updated} tone="text-brand-700" />
              <Stat label="Skipped" value={job.results.skipped} tone="text-slate-600" />
              <Stat label="Failed" value={job.results.failed} tone="text-red-600" />
            </div>
          ) : null}
          {done && (nothingChanged ? (
            <Alert tone="info">Nothing changed — every row already matched the saved attendance.</Alert>
          ) : job.results.failed === 0 ? (
            <Alert tone="success">
              Import finished: {job.results.inserted} added, {job.results.updated} updated{job.results.skipped ? `, ${job.results.skipped} skipped (see below)` : ""}.
            </Alert>
          ) : null)}
          {done ? (
            null
          ) : (
            !job.headerErrors.length && (
              <>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  <Stat label="Rows" value={job.totals.total} tone="text-slate-800" />
                  <Stat label="New" value={newRows} tone="text-green-700" />
                  <Stat label="Will update" value={changedExisting} tone="text-brand-700" />
                  <Stat label="No change" value={unchanged} tone="text-slate-500" />
                  <Stat label="With errors" value={job.totals.invalid + job.totals.duplicate} tone="text-red-600" />
                </div>
                {unchanged > 0 && unchanged === job.totals.valid && (
                  <Alert tone="info">
                    Every row in this file matches the attendance already saved, so there is nothing to import. Change values in the file — for example
                    Status, Entry/Exit Time or Worked Hours — then choose another file and upload it again.
                  </Alert>
                )}
                {importable === 0 && unchanged < job.totals.valid && job.totals.valid > 0 && (
                  <Alert tone="warn">No rows would change with the selected option. Try “Add new and update existing records”.</Alert>
                )}
                <Field label="When a record already exists" htmlFor="import-mode">
                  <Select id="import-mode" value={mode} onChange={(e) => setMode(e.target.value as ImportMode)}>
                    {MODES.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              </>
            )
          )}
          {view.rows.length > 0 && (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-slate-600">
                  {done ? "Rows not added or updated" : "Rows with errors (they will be skipped)"} {view.total > view.rows.length ? `— first ${view.rows.length} of ${view.total}` : ""}
                </span>
                <button type="button" className="text-xs font-medium text-brand-700 underline" onClick={() => step(() => download(`/api/imports/${job.id}/errors`))}>
                  Download as CSV
                </button>
              </div>
              <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-200">
                <table className="min-w-full text-xs">
                  <tbody className="divide-y divide-slate-100">
                    {view.rows.map((r) => (
                      <tr key={r.id}>
                        <td className="whitespace-nowrap px-2 py-1.5 font-mono text-slate-500">Row {r.rowNumber}</td>
                        <td className={`px-2 py-1.5 ${r.outcome === "skipped" ? "text-slate-600" : "text-red-700"}`}>{r.outcomeMessage || r.errors.join(" · ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-lg border border-slate-200 px-3 py-2">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}
