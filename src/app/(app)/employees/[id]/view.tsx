"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { ArrowLeft, Pencil, RotateCcw, Trash2, UserX } from "lucide-react";
import { useApi } from "@/lib/api";
import { EmployeeForm } from "@/components/employee-form";
import { EmployeeActionDialog, type EmployeeAction } from "@/components/employee-actions";
import { PhotoManager } from "@/components/photo";
import { api, ApiError } from "@/lib/api";
import { CATEGORY_COLORS, CATEGORY_LABELS, EMPLOYMENT_STATUS_LABELS, EMPLOYMENT_TYPE_LABELS, GENDER_LABELS, LABOUR_STATUS_LABELS } from "@/lib/constants";
import { daysInMonth, dayOfWeek, formatDisplayDate, formatMinutes, MONTH_NAMES } from "@/lib/time";
import type { Summary } from "@/lib/kpi";
import { Alert, Button, Card, PageHeader, Select, Spinner, StatCard } from "@/components/ui";

type Emp = Record<string, unknown> & {
  id: string;
  employeeCode: string;
  fullName: string;
  departmentName: string;
  designationName: string;
  locationName: string;
  shiftName: string;
  supervisorName: string;
  age: number | null;
  role: string | null;
  accountStatus: string;
};
interface Report {
  summary: Summary;
  calendar: { date: string; category: string; label: string; recordId: string | null; late: boolean }[];
  months: { month: string; label: string; present: number; absent: number; leave: number; pct: number; totalHours: number }[];
}

const SHORT: Record<string, string> = { present: "P", absent: "A", leave: "L", half_day: "HD", holiday: "H", weekly_off: "WO", pending: "?", future: "", not_employed: "" };

export function EmployeeDetail({
  id,
  today,
  startEditing,
  isAdmin,
  perms,
}: {
  id: string;
  today: string;
  startEditing: boolean;
  isAdmin: boolean;
  perms: { edit: boolean; remove: boolean; isSelf: boolean };
}) {
  const router = useRouter();
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  const [editing, setEditing] = useState(startEditing && perms.edit);
  const [action, setAction] = useState<EmployeeAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const emp = useApi<Emp>(`/api/employees/${id}`);
  const report = useApi<Report>(`/api/reports/employee/${id}?year=${year}`);
  const e = emp.data;

  return (
    <div>
      <Link href="/employees" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="h-4 w-4" /> Employees
      </Link>
      {emp.error && <Alert>{emp.error.message}</Alert>}
      {!e ? (
        <Spinner />
      ) : (
        <>
          <PageHeader
            title={`${(e.title as string) ?? ""} ${e.fullName}`.trim()}
            subtitle={`${e.employeeCode} · ${e.designationName} · ${e.departmentName}`}
            actions={
              !editing && (
                <>
                  {perms.edit && (
                    <Button variant="secondary" onClick={() => setEditing(true)}>
                      <Pencil className="h-4 w-4" /> Edit
                    </Button>
                  )}
                  {e.employmentStatus === "inactive"
                    ? perms.edit && (
                        <Button variant="secondary" onClick={() => setAction("reactivate")}>
                          <RotateCcw className="h-4 w-4" /> Reactivate
                        </Button>
                      )
                    : perms.remove && (
                        <Button variant="secondary" onClick={() => setAction("deactivate")}>
                          <UserX className="h-4 w-4" /> Deactivate
                        </Button>
                      )}
                  {perms.remove && (
                    <Button variant="ghost" className="text-red-600 hover:bg-red-50" onClick={() => setAction("delete")}>
                      <Trash2 className="h-4 w-4" /> Delete
                    </Button>
                  )}
                </>
              )
            }
          />
          {notice && (
            <div className="mb-4">
              <Alert tone="success">{notice}</Alert>
            </div>
          )}
          <EmployeeActionDialog
            action={action}
            employee={e}
            today={today}
            onClose={() => setAction(null)}
            onDone={(a) => {
              setAction(null);
              if (a === "delete") return router.push("/employees");
              setNotice(a === "deactivate" ? "Employee deactivated." : "Employee reactivated.");
              emp.reload();
              report.reload();
            }}
          />
          {editing ? (
            <EmployeeForm
              mode="edit"
              initial={e}
              employeeId={e.id}
              isAdmin={isAdmin}
              onCancel={() => {
                setEditing(false);
                router.replace(`/employees/${e.id}`);
              }}
              onSaved={() => {
                setEditing(false);
                setNotice("Employee updated.");
                router.replace(`/employees/${e.id}`);
                emp.reload();
                report.reload();
              }}
            />
          ) : (
            <>
              <Card className="mb-5">
                <PhotoManager employeeId={e.id} photoId={(e.photoId as string | null) ?? null} name={e.fullName} canChange={perms.edit || perms.isSelf} onChange={emp.reload} />
              </Card>
              <Profile e={e} canReveal={isAdmin || perms.isSelf} />
            </>
          )}

          <div className="mt-6 flex items-center justify-between">
            <h2 className="text-base font-semibold">Attendance {year}</h2>
            <Select value={year} onChange={(ev) => setYear(Number(ev.target.value))} className="w-28" aria-label="Year">
              {[year - 2, year - 1, year, year + 1].map((y) => (
                <option key={y}>{y}</option>
              ))}
            </Select>
          </div>
          {report.error && <Alert>{report.error.message}</Alert>}
          {report.data && (
            <div className="mt-3 space-y-5">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
                <StatCard label="Present" value={report.data.summary.present} tone={CATEGORY_COLORS.present} />
                <StatCard label="Absent" value={report.data.summary.absent} tone={CATEGORY_COLORS.absent} />
                <StatCard label="Leave" value={report.data.summary.leave} tone={CATEGORY_COLORS.leave} />
                <StatCard label="Half Day" value={report.data.summary.halfDay} tone={CATEGORY_COLORS.half_day} />
                <StatCard label="Weekly Off" value={report.data.summary.weeklyOff} tone={CATEGORY_COLORS.weekly_off} />
                <StatCard label="Holiday" value={report.data.summary.holiday} tone={CATEGORY_COLORS.holiday} />
                <StatCard label="Attendance %" value={`${report.data.summary.attendancePct}%`} hint={formatMinutes(report.data.summary.totalWorkedMinutes)} tone="#16a34a" />
              </div>
              <Card title="Attendance calendar">
                <Legend />
                <div className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {MONTH_NAMES.map((name, m) => (
                    <Month key={name} year={year} month={m + 1} name={name} days={report.data!.calendar} />
                  ))}
                </div>
              </Card>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-3 text-xs text-slate-600">
      {(["present", "absent", "leave", "half_day", "holiday", "weekly_off", "pending"] as const).map((c) => (
        <span key={c} className="inline-flex items-center gap-1.5">
          <span className="inline-flex h-4 min-w-6 items-center justify-center rounded px-1 text-[10px] font-semibold text-white" style={{ background: CATEGORY_COLORS[c] }}>
            {SHORT[c]}
          </span>
          {CATEGORY_LABELS[c]}
        </span>
      ))}
    </div>
  );
}

function Month({ year, month, name, days }: { year: number; month: number; name: string; days: Report["calendar"] }) {
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  const map = new Map(days.filter((d) => d.date.startsWith(prefix)).map((d) => [d.date, d]));
  const first = (dayOfWeek(`${prefix}-01`) + 6) % 7;
  const n = daysInMonth(year, month);
  return (
    <div>
      <div className="mb-1 text-xs font-semibold text-slate-700">{name}</div>
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-slate-400">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <div key={i}>{d}</div>
        ))}
        {Array.from({ length: first }, (_, i) => (
          <div key={`b${i}`} />
        ))}
        {Array.from({ length: n }, (_, i) => {
          const date = `${prefix}-${String(i + 1).padStart(2, "0")}`;
          const d = map.get(date);
          const cat = d?.category ?? "future";
          const color = CATEGORY_COLORS[cat as keyof typeof CATEGORY_COLORS];
          const tip = `${formatDisplayDate(date)}: ${d?.label ?? "—"}`;
          return (
            <Link
              key={date}
              href={`/attendance?date=${date}`}
              title={tip}
              aria-label={tip}
              className={clsx("flex h-8 flex-col items-center justify-center rounded text-[10px] leading-tight transition hover:ring-2 hover:ring-brand-500", !color && "bg-slate-50 text-slate-400")}
              style={color && cat !== "not_employed" ? { background: `${color}22`, color } : undefined}
            >
              <span className="font-medium">{i + 1}</span>
              <span className="font-semibold">{SHORT[cat] ?? ""}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function Item({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-800">{value === null || value === undefined || value === "" ? "—" : String(value)}</dd>
    </div>
  );
}

function AadhaarItem({ id, masked, canReveal }: { id: string; masked: string | null; canReveal: boolean }) {
  const [full, setFull] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function toggle() {
    if (full) return setFull(null);
    try {
      setFull((await api<{ aadhaar: string }>("GET", `/api/employees/${id}/aadhaar`)).aadhaar);
      setTimeout(() => setFull(null), 30000);
    } catch (e) {
      setErr((e as ApiError).message);
    }
  }
  return (
    <div>
      <dt className="text-xs text-slate-500">Aadhaar</dt>
      <dd className="mt-0.5 flex items-center gap-2 font-mono text-sm text-slate-800">
        {full ?? masked ?? "—"}
        {masked && canReveal && (
          <button type="button" onClick={toggle} className="font-sans text-xs font-medium text-brand-700 hover:underline">
            {full ? "Hide" : "Show"}
          </button>
        )}
      </dd>
      {err && <p className="text-xs text-red-600">{err}</p>}
    </div>
  );
}

function Profile({ e, canReveal }: { e: Emp; canReveal: boolean }) {
  const g = (k: string) => e[k] as string | null;
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Card title="Identity">
        <dl className="grid grid-cols-2 gap-4">
          <Item label="Employee ID" value={e.employeeCode} />
          <Item label="UAN" value={g("uan")} />
          <AadhaarItem id={e.id} masked={g("aadhaarMasked")} canReveal={canReveal} />
          <Item label="Gender" value={g("gender") ? GENDER_LABELS[g("gender") as keyof typeof GENDER_LABELS] : null} />
          <Item label="Father's name" value={g("fatherName")} />
          <Item label="Date of birth" value={g("dateOfBirth") ? formatDisplayDate(g("dateOfBirth")!) : null} />
          <Item label="Age" value={e.age} />
          <Item label="Mobile" value={g("mobile")} />
          <Item label="Email" value={g("officialEmail")} />
        </dl>
      </Card>
      <Card title="Employment">
        <dl className="grid grid-cols-2 gap-4">
          <Item label="Designation" value={e.designationName} />
          <Item label="Department" value={e.departmentName} />
          <Item label="Work site" value={e.locationName} />
          <Item label="Shift" value={e.shiftName} />
          <Item label="Date of joining" value={formatDisplayDate(g("dateOfJoining")!)} />
          <Item label="Employment type" value={EMPLOYMENT_TYPE_LABELS[g("employmentType") as keyof typeof EMPLOYMENT_TYPE_LABELS]} />
          <Item label="Labour status" value={g("labourStatus") ? LABOUR_STATUS_LABELS[g("labourStatus") as keyof typeof LABOUR_STATUS_LABELS] : null} />
          <Item label="Status" value={EMPLOYMENT_STATUS_LABELS[g("employmentStatus") as keyof typeof EMPLOYMENT_STATUS_LABELS]} />
          <Item label="Reporting supervisor" value={e.supervisorName} />
          <Item label="Login" value={`${e.role ?? "none"} · ${e.accountStatus}`} />
        </dl>
      </Card>
      <Card title="Address & bank">
        <dl className="grid gap-4">
          <Item label="Permanent address" value={g("permanentAddress")} />
          <Item label="Local address" value={g("localAddress")} />
          <div className="grid grid-cols-2 gap-4">
            <Item label="Account number" value={g("bankAccountNumber")} />
            <Item label="IFSC" value={g("ifscCode")} />
          </div>
        </dl>
      </Card>
    </div>
  );
}
