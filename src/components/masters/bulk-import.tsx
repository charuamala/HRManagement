"use client";
import { useRef, useState } from "react";
import clsx from "clsx";
import { Download, FileUp } from "lucide-react";
import { download, upload, ApiError } from "@/lib/api";
import { Alert, Button, Modal, Switch } from "@/components/ui";

export interface ImportResult {
  committed: boolean;
  totals: { rows: number; valid: number; invalid: number; toCreate: number; toUpdate: number; created: number; updated: number };
  warnings: string[];
  columns: string[];
  rows: { row: number; values: Record<string, string>; errors: string[]; action: "create" | "update" | "skip" }[];
}

function errorCsv(r: ImportResult) {
  const esc = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const head = [...r.columns, "Source Row", "Error"];
  const lines = r.rows.filter((x) => x.errors.length).map((x) => [...r.columns.map((c) => x.values[c] ?? ""), String(x.row), x.errors.join("; ")].map(esc).join(","));
  return "﻿" + [head.map(esc).join(","), ...lines].join("\r\n");
}

/**
 * Two-step bulk upload: preview (validate only) → save. Re-uses the server's
 * validation so uploaded rows follow exactly the same rules as manual entry.
 */
export function BulkImportDialog({ title, endpoint, templateUrl, allowUpdate = true, onClose, onDone }: { title: string; endpoint: string; templateUrl: string; allowUpdate?: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [updateExisting, setUpdateExisting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);

  async function run(commit: boolean) {
    if (!file) return;
    setBusy(commit ? "commit" : "preview");
    setError(null);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("commit", String(commit));
    fd.append("updateExisting", String(updateExisting));
    try {
      const r = await upload<ImportResult>(endpoint, fd);
      setResult(r);
      if (commit) onDone(`Bulk upload saved: ${r.totals.created} created, ${r.totals.updated} updated${r.totals.invalid ? `, ${r.totals.invalid} row(s) skipped` : ""}.`);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(null);
    }
  }

  function downloadErrors() {
    if (!result) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([errorCsv(result)], { type: "text/csv" }));
    a.download = "upload-errors.csv";
    a.click();
  }

  const t = result?.totals;
  return (
    <Modal
      open
      wide
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button variant="secondary" onClick={() => run(false)} disabled={!file} loading={busy === "preview"}>
            Validate &amp; preview
          </Button>
          <Button onClick={() => run(true)} disabled={!file || !result || result.committed || !t?.valid} loading={busy === "commit"}>
            Save {t?.valid ?? 0} valid row{t?.valid === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-500">1. Download a template:</span>
        <Button size="sm" variant="ghost" onClick={() => download(`${templateUrl}?format=xlsx`).catch((e) => setError(e.message))}>
          <Download className="h-4 w-4" /> Excel
        </Button>
        <Button size="sm" variant="ghost" onClick={() => download(`${templateUrl}?format=csv`).catch((e) => setError(e.message))}>
          <Download className="h-4 w-4" /> CSV
        </Button>
      </div>
      <div
        className={clsx("flex cursor-pointer flex-col items-center gap-1 rounded-lg border-2 border-dashed px-4 py-6 text-center", file ? "border-brand-500/50 bg-brand-50/40" : "border-slate-300 hover:border-brand-500/50")}
        onClick={() => input.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files?.[0];
          if (f) {
            setFile(f);
            setResult(null);
          }
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
        aria-label="Choose file to upload"
      >
        <FileUp className="h-6 w-6 text-slate-400" aria-hidden />
        <span className="text-sm font-medium">{file ? file.name : "2. Drop a .xlsx or .csv file here, or click to choose"}</span>
        <span className="text-xs text-slate-400">Max 5 MB</span>
        <input
          ref={input}
          type="file"
          accept=".xlsx,.csv"
          className="hidden"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setResult(null);
          }}
        />
      </div>
      {allowUpdate && (
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={updateExisting}
            onChange={(v) => {
              setUpdateExisting(v);
              setResult(null);
            }}
            label="Update existing records"
          />
          Update existing records with the same code (otherwise duplicates are rejected)
        </label>
      )}
      {error && <Alert>{error}</Alert>}
      {result && t && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-5">
            {[
              ["Rows", t.rows],
              ["Valid", t.valid],
              ["Invalid", t.invalid],
              [result.committed ? "Created" : "To create", result.committed ? t.created : t.toCreate],
              [result.committed ? "Updated" : "To update", result.committed ? t.updated : t.toUpdate],
            ].map(([l, v]) => (
              <div key={l as string} className="rounded-lg border border-slate-200 p-2">
                <div className="text-slate-500">{l}</div>
                <div className="text-lg font-semibold tabular-nums">{v}</div>
              </div>
            ))}
          </div>
          {result.committed && <Alert tone="success">Saved. Invalid rows were skipped — download the error report, fix them and upload again.</Alert>}
          {result.warnings.map((w) => (
            <Alert key={w} tone="warn">
              {w}
            </Alert>
          ))}
          {t.invalid > 0 && (
            <Button size="sm" variant="secondary" onClick={downloadErrors}>
              <Download className="h-4 w-4" /> Download error report
            </Button>
          )}
          <div className="max-h-64 overflow-auto rounded-lg border border-slate-200">
            <table className="min-w-full text-xs">
              <thead className="sticky top-0 bg-slate-50 text-left text-slate-500">
                <tr>
                  <th className="px-2 py-1.5">Row</th>
                  {result.columns.slice(0, 4).map((c) => (
                    <th key={c} className="px-2 py-1.5">
                      {c}
                    </th>
                  ))}
                  <th className="px-2 py-1.5">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {result.rows.map((r) => (
                  <tr key={r.row} className={r.errors.length ? "bg-red-50/60" : undefined}>
                    <td className="px-2 py-1.5 tabular-nums">{r.row}</td>
                    {result.columns.slice(0, 4).map((c) => (
                      <td key={c} className="max-w-40 truncate px-2 py-1.5">
                        {r.values[c]}
                      </td>
                    ))}
                    <td className="px-2 py-1.5">{r.errors.length ? <span className="text-red-700">{r.errors.join(" · ")}</span> : <span className="text-green-700">{r.action === "update" ? "Will update" : "Will create"}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}
