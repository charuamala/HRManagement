"use client";
import { useEffect, useState } from "react";
import clsx from "clsx";
import { ChevronLeft, ChevronRight, Download, Pencil, Plus, Power, Star, Trash2, Upload } from "lucide-react";
import { api, ApiError, download, qs, useApi } from "@/lib/api";
import { MASTERS, MASTER_KEYS, type MasterKey } from "@/lib/masters";
import { formatDisplayDate } from "@/lib/time";
import { Alert, Button, Card, Empty, Field, Input, Modal, PageHeader, Select, Spinner, StatusBadge } from "@/components/ui";
import { MasterForm } from "@/components/masters/master-form";
import { BulkImportDialog } from "@/components/masters/bulk-import";
import type { CatalogModule } from "@/components/masters/permission-grid";

type Row = Record<string, unknown> & {
  id: string;
  active: boolean;
  _code: string;
  _name: string;
  usage: number;
  createdAt: string;
  updatedAt: string;
  createdByName: string;
  updatedByName: string;
  system?: boolean;
};

const iconBtn = "inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-40";

function cell(key: MasterKey, name: string, r: Row) {
  if (key === "supervisors" && name === "employeeId") return r.employeeName as string;
  if (key === "supervisors" && name === "departmentIds") return (r.departmentNames as string[]).join(", ") || "Any";
  if (key === "supervisors" && name === "workSiteIds") return (r.workSiteNames as string[]).join(", ") || "Any";
  if (key === "designations" && name === "departmentId") return r.departmentName as string;
  if (name === "lifecycle") return r.lifecycle === "inactive" ? "Separated" : "Employed";
  if (key === "shifts" && name === "endTime") return `${r.endTime as string}${r.overnight ? " (+1 day)" : ""}`;
  const v = r[name];
  return v === null || v === undefined || v === "" ? "—" : String(v);
}

export function MastersView({ canDelete, isAdmin }: { canDelete: boolean; isAdmin: boolean }) {
  const meta = useApi<{ summary: Record<string, { total: number; active: number }>; permissionCatalog: CatalogModule[] }>("/api/masters");
  const visible = MASTER_KEYS.filter((k) => meta.data?.summary[k]);
  const [key, setKey] = useState<MasterKey>("designations");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Row | "new" | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "delete" | "deactivate"; row: Row } | null>(null);
  const [reason, setReason] = useState("");
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (visible.length && !visible.includes(key)) setKey(visible[0]);
  }, [visible, key]);

  const list = useApi<{ items: Row[]; total: number; pageSize: number }>(meta.data ? `/api/masters/${key}${qs({ search, status, page, pageSize: 20 })}` : null);
  const def = MASTERS[key];
  const readOnly = def.adminOnly && !isAdmin;
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;

  const flash = (tone: "success" | "error", text: string) => {
    setNotice({ tone, text });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const refresh = () => {
    list.reload();
    meta.reload();
  };
  const pick = (k: MasterKey) => {
    setKey(k);
    setSearch("");
    setStatus("all");
    setPage(1);
    setNotice(null);
  };

  async function toggle(r: Row) {
    if (r.active) return setConfirm({ kind: "deactivate", row: r });
    try {
      await api("POST", `/api/masters/${key}/${r.id}/status`, { active: true });
      flash("success", `${def.singular} activated.`);
      refresh();
    } catch (e) {
      flash("error", (e as ApiError).message);
    }
  }

  async function confirmAction() {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === "delete") await api("DELETE", `/api/masters/${key}/${confirm.row.id}`, { reason: reason || undefined });
      else await api("POST", `/api/masters/${key}/${confirm.row.id}/status`, { active: false, reason: reason || undefined });
      flash("success", `${def.singular} ${confirm.kind === "delete" ? "deleted" : "deactivated"}.`);
      refresh();
    } catch (e) {
      flash("error", (e as ApiError).message);
    } finally {
      setBusy(false);
      setConfirm(null);
      setReason("");
    }
  }

  async function makeDefault(r: Row) {
    try {
      await api("POST", `/api/masters/shifts/${r.id}/default`);
      flash("success", `${r._name} is now the organisation default shift.`);
      refresh();
    } catch (e) {
      flash("error", (e as ApiError).message);
    }
  }

  const listFields = def.fields.filter((f) => f.list);

  return (
    <div>
      <PageHeader title="Master Management" subtitle="Manage every dropdown used in employee records from one place" />
      {notice && (
        <div className="mb-4">
          <Alert tone={notice.tone}>{notice.text}</Alert>
        </div>
      )}
      {meta.error && <Alert>{meta.error.message}</Alert>}
      {!meta.data ? (
        <Spinner />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[240px_1fr]">
          <nav aria-label="Masters" className="hidden lg:block">
            <ul className="space-y-1">
              {visible.map((k) => (
                <li key={k}>
                  <button
                    onClick={() => pick(k)}
                    aria-current={k === key ? "page" : undefined}
                    className={clsx("flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition", k === key ? "bg-brand-50 font-medium text-brand-700" : "text-slate-600 hover:bg-white")}
                  >
                    <span>{MASTERS[k].label}</span>
                    <span className="rounded-full bg-white px-2 text-xs text-slate-500 ring-1 ring-slate-200">{meta.data!.summary[k].total}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <div className="lg:hidden">
            <Select value={key} onChange={(e) => pick(e.target.value as MasterKey)} aria-label="Choose master">
              {visible.map((k) => (
                <option key={k} value={k}>
                  {MASTERS[k].label} ({meta.data!.summary[k].total})
                </option>
              ))}
            </Select>
          </div>

          <Card
            title={
              <span>
                {def.label}
                <span className="ml-2 text-xs font-normal text-slate-500">→ Employee form: {def.employeeField}</span>
              </span>
            }
            actions={
              !readOnly && (
                <div className="flex flex-wrap gap-2">
                  {def.importable && (
                    <Button size="sm" variant="secondary" onClick={() => setImporting(true)}>
                      <Upload className="h-4 w-4" /> Bulk upload
                    </Button>
                  )}
                  <Button size="sm" variant="secondary" onClick={() => download(`/api/masters/${key}/export?format=xlsx`).catch((e) => flash("error", e.message))}>
                    <Download className="h-4 w-4" /> Export
                  </Button>
                  <Button size="sm" onClick={() => setEditing("new")}>
                    <Plus className="h-4 w-4" /> Add new
                  </Button>
                </div>
              )
            }
          >
            <p className="mb-3 text-xs text-slate-500">{def.description}</p>
            {readOnly && (
              <div className="mb-3">
                <Alert tone="info">Only Administrators can change roles and permissions.</Alert>
              </div>
            )}
            <div className="mb-3 flex flex-wrap gap-2">
              <Input
                placeholder="Search name or code"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                className="w-56 py-1.5"
                aria-label="Search"
              />
              <Select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
                className="w-36 py-1.5"
                aria-label="Status filter"
              >
                <option value="all">All statuses</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </Select>
              <span className="self-center text-xs text-slate-500">{list.data ? `${list.data.total} record${list.data.total === 1 ? "" : "s"}` : ""}</span>
            </div>
            {list.error && <Alert>{list.error.message}</Alert>}
            {list.loading && !list.data ? (
              <Spinner />
            ) : !list.data?.items.length ? (
              <Empty title={search || status !== "all" ? "No records match" : `No ${def.singular.toLowerCase()} records yet`}>
                {!readOnly && !search && (
                  <button className="font-medium text-brand-700 hover:underline" onClick={() => setEditing("new")}>
                    Add the first one
                  </button>
                )}
              </Empty>
            ) : (
              <>
                <div className="-mx-4 overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="text-left text-xs text-slate-500">
                      <tr>
                        {listFields.map((f) => (
                          <th key={f.name} className="px-3 py-2">
                            {f.label}
                          </th>
                        ))}
                        <th className="px-3 py-2">Status</th>
                        <th className="px-3 py-2">{key === "roles" ? "Users" : "In use"}</th>
                        <th className="px-3 py-2">Created</th>
                        <th className="px-3 py-2">Updated</th>
                        <th className="px-3 py-2 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {list.data.items.map((r) => (
                        <tr key={r.id} className={r.active ? "hover:bg-slate-50" : "bg-slate-50/70 text-slate-500"}>
                          {listFields.map((f, i) => (
                            <td key={f.name} className={clsx("px-3 py-2", i === 0 && f.name === "code" && "font-mono text-xs")}>
                              {cell(key, f.name, r)}
                              {i === 0 && r.isDefault ? <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">DEFAULT</span> : null}
                              {i === 0 && r.system ? <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">SYSTEM</span> : null}
                            </td>
                          ))}
                          <td className="px-3 py-2">
                            <StatusBadge category={r.active ? "present" : "absent"} label={r.active ? "Active" : "Inactive"} />
                          </td>
                          <td className="px-3 py-2 tabular-nums">{r.usage}</td>
                          <td className="whitespace-nowrap px-3 py-2 text-xs">
                            {formatDisplayDate(r.createdAt.slice(0, 10))}
                            <div className="text-slate-400">{r.createdByName}</div>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-xs">
                            {formatDisplayDate(r.updatedAt.slice(0, 10))}
                            <div className="text-slate-400">{r.updatedByName}</div>
                          </td>
                          <td className="whitespace-nowrap px-3 py-1 text-right">
                            {!readOnly && (
                              <>
                                <button className={iconBtn} title="Edit" aria-label={`Edit ${r._name}`} onClick={() => setEditing(r)}>
                                  <Pencil className="h-4 w-4" />
                                </button>
                                {key === "shifts" && !r.isDefault && r.active && (
                                  <button className={iconBtn} title="Set as organisation default" aria-label={`Make ${r._name} the default shift`} onClick={() => makeDefault(r)}>
                                    <Star className="h-4 w-4" />
                                  </button>
                                )}
                                {!r.system && (
                                  <button
                                    className={clsx(iconBtn, r.active ? "hover:text-amber-700" : "hover:text-green-700")}
                                    title={r.active ? "Deactivate" : "Activate"}
                                    aria-label={`${r.active ? "Deactivate" : "Activate"} ${r._name}`}
                                    onClick={() => toggle(r)}
                                  >
                                    <Power className="h-4 w-4" />
                                  </button>
                                )}
                                {canDelete && !r.system && (
                                  <button className={clsx(iconBtn, "hover:bg-red-50 hover:text-red-600")} title="Delete" aria-label={`Delete ${r._name}`} onClick={() => setConfirm({ kind: "delete", row: r })}>
                                    <Trash2 className="h-4 w-4" />
                                  </button>
                                )}
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 flex items-center justify-end gap-2 text-xs text-slate-500">
                  Page {page} of {pages}
                  <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page">
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </>
            )}
          </Card>
        </div>
      )}

      {editing && (
        <MasterForm
          key={`${key}-${editing === "new" ? "new" : editing.id}`}
          masterKey={key}
          record={editing === "new" ? null : editing}
          catalog={meta.data?.permissionCatalog ?? []}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            flash("success", msg);
            refresh();
          }}
        />
      )}

      {confirm && (
        <Modal
          open
          title={confirm.kind === "delete" ? `Delete ${def.singular.toLowerCase()}` : `Deactivate ${def.singular.toLowerCase()}`}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={confirmAction} loading={busy}>
                {confirm.kind === "delete" ? "Delete permanently" : "Deactivate"}
              </Button>
            </>
          }
        >
          <p>
            <strong>{confirm.row._name}</strong> {confirm.row._code ? `(${confirm.row._code})` : ""}
          </p>
          {confirm.kind === "deactivate" ? (
            <p className="text-slate-600">It will no longer be offered for new assignments. Employees who already have it keep it and still see it.</p>
          ) : (
            <Alert tone="warn">Deleting is permanent and only allowed when nothing uses this record{confirm.row.usage ? ` — it is currently used by ${confirm.row.usage}` : ""}. Deactivate instead to keep history.</Alert>
          )}
          <Field label="Reason (optional, recorded in the audit log)" htmlFor="reason">
            <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </Modal>
      )}

      {importing && (
        <BulkImportDialog
          title={`Bulk upload — ${def.label}`}
          endpoint={`/api/masters/${key}/import`}
          templateUrl={`/api/masters/${key}/template`}
          onClose={() => setImporting(false)}
          onDone={(msg) => {
            flash("success", msg);
            refresh();
          }}
        />
      )}
    </div>
  );
}
