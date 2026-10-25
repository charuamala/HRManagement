"use client";
import { useState } from "react";
import Link from "next/link";
import { FileSpreadsheet } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { qs, useApi } from "@/lib/api";
import { CATEGORY_COLORS } from "@/lib/constants";
import { formatDisplayDate, formatMinutes } from "@/lib/time";
import type { Summary } from "@/lib/kpi";
import { Alert, Button, Card, Empty, Field, Input, PageHeader, Select, Spinner, StatCard, StatusBadge } from "@/components/ui";
import { MonthlyReportPanel } from "@/components/monthly-report-panel";

interface Row {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  departmentName: string;
  date: string;
  category: string;
  statusLabel: string;
  checkIn: string;
  checkOut: string;
  workedHours: string;
  hoursOnly: boolean;
}
interface Point {
  label: string;
  present: number;
  absent: number;
  leave: number;
  halfDay: number;
  late: number;
  pct: number;
  avgHours: number;
}
interface Dashboard {
  range: { from: string; to: string; today: string; singleDay: boolean };
  totals: { totalEmployees: number; activeEmployees: number };
  summary: Summary;
  charts: { distribution: { key: string; label: string; value: number }[]; daily: Point[]; departments: Point[]; weekly: Point[]; monthly: Point[] };
  lists: { register: Row[]; onLeave: Row[]; late: Row[]; missingCheckouts: Row[]; inOffice: Row[]; snapshotDate: string };
}

const PRESETS = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["this_week", "This Week"],
  ["last_week", "Last Week"],
  ["this_month", "This Month"],
  ["last_month", "Last Month"],
  ["this_year", "This Year"],
  ["custom", "Custom range"],
] as const;

export function DashboardView() {
  const [preset, setPreset] = useState<string>("this_month");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [departmentIds, setDept] = useState("");
  const [reportOpen, setReportOpen] = useState(false);
  const options = useApi<{ departments: { id: string; name: string }[] }>("/api/meta/options");
  const url = `/api/dashboard${qs(preset === "custom" ? { preset, from, to, departmentIds } : { preset, departmentIds })}`;
  const { data, error, loading } = useApi<Dashboard>(preset === "custom" && (!from || !to) ? null : url);
  const s = data?.summary;
  const unit = data && !data.range.singleDay ? " (employee-days)" : "";
  const day = (k: string) => `/attendance${qs({ date: data?.lists.snapshotDate, kpi: k })}`;

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle={data ? `${formatDisplayDate(data.range.from)} – ${formatDisplayDate(data.range.to)}` : "Attendance overview"}
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Period">
              <Select value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Period">
                {PRESETS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            {preset === "custom" && (
              <>
                <Field label="From">
                  <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </Field>
                <Field label="To">
                  <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                </Field>
              </>
            )}
            <Field label="Department">
              <Select value={departmentIds} onChange={(e) => setDept(e.target.value)}>
                <option value="">All departments</option>
                {options.data?.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Button variant="secondary" onClick={() => setReportOpen((o) => !o)} aria-expanded={reportOpen} aria-controls="monthly-report" disabled={!data}>
              <FileSpreadsheet className="h-4 w-4 text-green-700" /> Download Excel
            </Button>
          </div>
        }
      />
      {reportOpen && data && (
        <div id="monthly-report">
          <MonthlyReportPanel today={data.range.today} departmentId={departmentIds} />
        </div>
      )}
      {error && <Alert>{error.message}</Alert>}
      {loading && !data && <Spinner />}
      {data && s && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard label="Total Employees" value={data.totals.totalEmployees} tone="#4f46e5" href="/employees" />
            <StatCard label="Active Employees" value={data.totals.activeEmployees} tone="#4f46e5" href="/employees" />
            <StatCard label={`Present${unit}`} value={s.present} tone={CATEGORY_COLORS.present} href={day("present")} />
            <StatCard label={`Absent${unit}`} value={s.absent} tone={CATEGORY_COLORS.absent} href={day("absent")} />
            <StatCard label={`On Leave${unit}`} value={s.leave} tone={CATEGORY_COLORS.leave} href={day("leave")} />
            <StatCard label="Late Arrivals" value={s.late} tone={CATEGORY_COLORS.half_day} href={day("late")} />
            <StatCard label="Not Yet Checked In" value={s.notCheckedIn} tone={CATEGORY_COLORS.pending} href={day("not_checked_in")} />
            <StatCard label="Currently in Office" value={s.inOffice} tone="#0891b2" href={day("in_office")} />
            <StatCard label="Checked Out" value={s.checkedOut} tone="#0f766e" href={day("checked_out")} />
            <StatCard label="Missing Check-Out" value={s.missingCheckOut} tone="#ea580c" href={day("missing_checkout")} />
            <StatCard label="Attendance %" value={`${s.attendancePct}%`} hint={`${s.creditDays} credit / ${s.scheduledDays} scheduled days`} tone="#16a34a" />
            <StatCard label="Avg Working Hours" value={formatMinutes(s.avgWorkedMinutes)} hint={`${s.workedDays} worked days`} tone="#64748b" />
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <Card title="Attendance distribution">
              {data.charts.distribution.every((d) => !d.value) ? (
                <Empty title="No attendance in this period" />
              ) : (
                <div className="h-64">
                  <ResponsiveContainer>
                    <PieChart>
                      <Pie data={data.charts.distribution.filter((d) => d.value)} dataKey="value" nameKey="label" innerRadius={55} outerRadius={90} paddingAngle={2}>
                        {data.charts.distribution
                          .filter((d) => d.value)
                          .map((d) => (
                            <Cell key={d.key} fill={CATEGORY_COLORS[d.key as keyof typeof CATEGORY_COLORS]} />
                          ))}
                      </Pie>
                      <Tooltip />
                      <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Card>
            <Card title="Daily attendance" className="lg:col-span-2">
              <div className="h-64">
                <ResponsiveContainer>
                  <BarChart data={data.charts.daily}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} tickFormatter={(v: string) => v.slice(5)} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="present" name="Present" stackId="a" fill={CATEGORY_COLORS.present} />
                    <Bar dataKey="halfDay" name="Half Day" stackId="a" fill={CATEGORY_COLORS.half_day} />
                    <Bar dataKey="leave" name="Leave" stackId="a" fill={CATEGORY_COLORS.leave} />
                    <Bar dataKey="absent" name="Absent" stackId="a" fill={CATEGORY_COLORS.absent} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="Attendance % trend">
              <div className="h-56">
                <ResponsiveContainer>
                  <LineChart data={data.charts.daily}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} tickFormatter={(v: string) => v.slice(5)} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} unit="%" />
                    <Tooltip />
                    <Line type="monotone" dataKey="pct" name="Attendance %" stroke="#4f46e5" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card title="Department-wise attendance">
              <div className="h-56">
                <ResponsiveContainer>
                  <BarChart data={data.charts.departments} layout="vertical" margin={{ left: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                    <YAxis type="category" dataKey="label" tick={{ fontSize: 11 }} width={90} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="present" name="Present" fill={CATEGORY_COLORS.present} />
                    <Bar dataKey="absent" name="Absent" fill={CATEGORY_COLORS.absent} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          <Card
            title={`Attendance register — ${formatDisplayDate(data.lists.snapshotDate)}`}
            actions={
              <Link href={`/attendance?date=${data.lists.snapshotDate}`} className="text-xs font-medium text-brand-700 hover:underline">
                Open register →
              </Link>
            }
          >
            <RowTable rows={data.lists.register} />
          </Card>
        </div>
      )}
    </div>
  );
}

function RowTable({ rows }: { rows: Row[] }) {
  if (!rows.length) return <Empty title="No employees scheduled" />;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="text-left text-xs text-slate-500">
          <tr>
            <th className="px-2 py-2">Emp ID</th>
            <th className="px-2 py-2">Name</th>
            <th className="px-2 py-2">Department</th>
            <th className="px-2 py-2">In</th>
            <th className="px-2 py-2">Out</th>
            <th className="px-2 py-2">Hours</th>
            <th className="px-2 py-2">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={`${r.employeeId}${r.date}`} className="hover:bg-slate-50">
              <td className="px-2 py-2 font-mono text-xs">{r.employeeCode}</td>
              <td className="px-2 py-2">
                <Link href={`/employees/${r.employeeId}`} className="font-medium text-slate-800 hover:text-brand-700">
                  {r.employeeName}
                </Link>
              </td>
              <td className="px-2 py-2 text-slate-600">{r.departmentName}</td>
              <td className="px-2 py-2 tabular-nums">{r.checkIn || "—"}</td>
              <td className="px-2 py-2 tabular-nums">{r.checkOut || "—"}</td>
              <td className="px-2 py-2 tabular-nums">
                {r.workedHours || "—"}
                {r.hoursOnly && <span className="ml-1 text-[10px] text-slate-400">(reported)</span>}
              </td>
              <td className="px-2 py-2">
                <StatusBadge category={r.category} label={r.statusLabel} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
