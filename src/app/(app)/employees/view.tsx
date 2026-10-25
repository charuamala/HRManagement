"use client";
import { useState } from "react";
import Link from "next/link";
import { Eye, Pencil, Plus, RotateCcw, Trash2, UserX } from "lucide-react";
import { Pagination, usePageSize } from "@/components/pagination";
import { qs, useApi } from "@/lib/api";
import { EMPLOYMENT_STATUS_LABELS } from "@/lib/constants";
import { formatDisplayDate } from "@/lib/time";
import { EmployeeActionDialog, type EmployeeAction } from "@/components/employee-actions";
import { Avatar } from "@/components/photo";
import { Alert, Card, Empty, Input, PageHeader, Select, Spinner, StatusBadge } from "@/components/ui";

interface EmpRow {
  id: string;
  employeeCode: string;
  uan: string | null;
  fullName: string;
  designationName: string;
  departmentName: string;
  dateOfJoining: string;
  dateOfExit: string | null;
  age: number | null;
  employmentStatus: keyof typeof EMPLOYMENT_STATUS_LABELS;
  accountStatus: string;
  photoId: string | null;
  aadhaarMasked: string | null;
}

const iconBtn = "inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900";

export function EmployeesView({ today, perms }: { today: string; perms: { create: boolean; edit: boolean; remove: boolean } }) {
  const [search, setSearch] = useState("");
  const [departmentIds, setDept] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize("employees", 25);
  const [sort, setSort] = useState("employeeCode");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [dialog, setDialog] = useState<{ action: EmployeeAction; emp: EmpRow } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const options = useApi<{ departments: { id: string; name: string }[] }>("/api/meta/options");
  const { data, error, loading, reload } = useApi<{ items: EmpRow[]; total: number; pageSize: number }>(
    `/api/employees${qs({ search, departmentIds, employmentStatuses: status ? [status] : undefined, page, pageSize, sort, dir })}`,
  );
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const th = (key: string, label: string) => (
    <th className="px-3 py-2">
      <button
        className="font-semibold hover:text-slate-800"
        onClick={() => {
          setDir(sort === key && dir === "asc" ? "desc" : "asc");
          setSort(key);
        }}
        aria-label={`Sort by ${label}`}
      >
        {label} {sort === key ? (dir === "asc" ? "▲" : "▼") : ""}
      </button>
    </th>
  );

  return (
    <div>
      <PageHeader
        title="Employee Directory"
        subtitle={data ? `${data.total} employee${data.total === 1 ? "" : "s"}` : undefined}
        actions={
          perms.create && (
            <Link href="/employees/new" className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700">
              <Plus className="h-4 w-4" /> Add Employee
            </Link>
          )
        }
      />
      {notice && (
        <div className="mb-3">
          <Alert tone="success">{notice}</Alert>
        </div>
      )}
      <Card
        title="Employees"
        actions={
          <div className="flex flex-wrap justify-end gap-2">
            <Input
              placeholder="Search name, Emp ID, UAN"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="w-56 py-1.5"
              aria-label="Search employees"
            />
            <Select value={departmentIds} onChange={(e) => setDept(e.target.value)} className="w-44 py-1.5" aria-label="Department">
              <option value="">All departments</option>
              {options.data?.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40 py-1.5" aria-label="Employment status">
              <option value="">All statuses</option>
              {Object.entries(EMPLOYMENT_STATUS_LABELS).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          </div>
        }
      >
        {error && <Alert>{error.message}</Alert>}
        {loading && !data ? (
          <Spinner />
        ) : !data?.items.length ? (
          <Empty title="No employees match">
            {perms.create && (
              <Link href="/employees/new" className="font-medium text-brand-700 hover:underline">
                Add the first employee
              </Link>
            )}
          </Empty>
        ) : (
          <>
            <div className="-mx-4 overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="text-left text-xs text-slate-500">
                  <tr>
                    {th("employeeCode", "Emp ID")}
                    {th("fullName", "Name")}
                    <th className="px-3 py-2">UAN</th>
                    <th className="px-3 py-2">Aadhaar</th>
                    {th("designationName", "Designation")}
                    {th("departmentName", "Department")}
                    {th("dateOfJoining", "DOJ")}
                    <th className="px-3 py-2">Age</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Login</th>
                    <th className="px-3 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((e) => {
                    const inactive = e.employmentStatus === "inactive";
                    return (
                      <tr key={e.id} className={inactive ? "bg-slate-50/70 text-slate-500" : "hover:bg-slate-50"}>
                        <td className="px-3 py-2 font-mono text-xs">{e.employeeCode}</td>
                        <td className="px-3 py-2">
                          <Link href={`/employees/${e.id}`} className="flex items-center gap-2.5 font-medium text-slate-800 hover:text-brand-700">
                            <Avatar employeeId={e.id} photoId={e.photoId} name={e.fullName} size={30} />
                            {e.fullName}
                          </Link>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-slate-600">{e.uan ?? "—"}</td>
                        <td className="px-3 py-2 font-mono text-xs text-slate-600">{e.aadhaarMasked ?? "—"}</td>
                        <td className="px-3 py-2">{e.designationName}</td>
                        <td className="px-3 py-2 text-slate-600">{e.departmentName}</td>
                        <td className="px-3 py-2 tabular-nums">{formatDisplayDate(e.dateOfJoining)}</td>
                        <td className="px-3 py-2 tabular-nums">{e.age ?? "—"}</td>
                        <td className="px-3 py-2">
                          <StatusBadge category={inactive ? "absent" : "present"} label={EMPLOYMENT_STATUS_LABELS[e.employmentStatus]} />
                          {inactive && e.dateOfExit && <div className="mt-0.5 text-[11px]">Exit {formatDisplayDate(e.dateOfExit)}</div>}
                        </td>
                        <td className="px-3 py-2 text-xs capitalize text-slate-500">{e.accountStatus}</td>
                        <td className="whitespace-nowrap px-3 py-1 text-right">
                          <Link href={`/employees/${e.id}`} className={iconBtn} title="View" aria-label={`View ${e.fullName}`}>
                            <Eye className="h-4 w-4" />
                          </Link>
                          {perms.edit && (
                            <Link href={`/employees/${e.id}?edit=1`} className={iconBtn} title="Edit" aria-label={`Edit ${e.fullName}`}>
                              <Pencil className="h-4 w-4" />
                            </Link>
                          )}
                          {inactive
                            ? perms.edit && (
                                <button className={iconBtn} title="Reactivate" aria-label={`Reactivate ${e.fullName}`} onClick={() => setDialog({ action: "reactivate", emp: e })}>
                                  <RotateCcw className="h-4 w-4" />
                                </button>
                              )
                            : perms.remove && (
                                <button className={iconBtn} title="Deactivate" aria-label={`Deactivate ${e.fullName}`} onClick={() => setDialog({ action: "deactivate", emp: e })}>
                                  <UserX className="h-4 w-4" />
                                </button>
                              )}
                          {perms.remove && (
                            <button className={`${iconBtn} hover:bg-red-50 hover:text-red-600`} title="Delete" aria-label={`Delete ${e.fullName}`} onClick={() => setDialog({ action: "delete", emp: e })}>
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination page={Math.min(page, pages)} pageSize={pageSize} total={data.total} onPage={setPage} onPageSize={setPageSize} label="employees" />
          </>
        )}
      </Card>
      <EmployeeActionDialog
        action={dialog?.action ?? null}
        employee={dialog?.emp ?? null}
        today={today}
        onClose={() => setDialog(null)}
        onDone={(action) => {
          setNotice(`${dialog?.emp.fullName} ${action === "delete" ? "deleted" : action === "deactivate" ? "deactivated" : "reactivated"}.`);
          setDialog(null);
          reload();
        }}
      />
    </div>
  );
}
