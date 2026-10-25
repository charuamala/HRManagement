import fs from "fs";
import os from "os";
import path from "path";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { col, setDb } from "@/server/db";
import { JsonDatabase } from "@/server/db/json-driver";
import { ensureBaseData } from "@/server/bootstrap";
import { buildAuthContext, type AuthContext } from "@/server/auth/context";
import { getSettings, saveSettings } from "@/server/services/settings";
import { createEmployee } from "@/server/services/employees";
import { createAttendance } from "@/server/services/attendance";
import { createDepartment, createDesignation, createHoliday, createLeave, createLocation } from "@/server/services/org";
import { monthlyAttendanceData, monthlyAttendanceWorkbook } from "@/server/services/monthly-report";
import { employeeCreateSchema, type ReportFilter } from "@/lib/schemas";
import { parse } from "@/server/http";
import { AppError } from "@/server/errors";
import type { Employee } from "@/lib/types";

let dir: string;
let ctx: AuthContext;
const ids: Record<string, string> = {};

async function addEmployee(code: string, name: string, o: { dept: string; site: string; type: "contract" | "full_time"; doj: string; account?: boolean }) {
  const input = parse(employeeCreateSchema, {
    employeeCode: code,
    firstName: name,
    lastName: "",
    departmentId: ids[o.dept],
    designationId: ids.fitter,
    supervisorEmployeeId: null,
    officeLocationId: ids[o.site],
    employmentType: o.type,
    dateOfJoining: o.doj,
    employmentStatus: "active",
    shiftId: null,
    expectedEntryTime: null,
    expectedExitTime: null,
    weeklyOffDays: null,
    createAccount: !!o.account,
    role: "employee",
  });
  const { employee } = await createEmployee(ctx, input);
  ids[code] = employee.id;
  return employee;
}

const mark = (code: string, date: string, statusCode: string, e: { in?: string; out?: string; hours?: number } = {}) =>
  createAttendance(ctx, { employeeId: ids[code], date, statusCode, checkIn: e.in ?? null, checkOut: e.out ?? null, workedHours: e.hours ?? null });

/** Reads a generated workbook back into plain objects keyed by header label. */
async function readSheet(buf: Buffer, sheet: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  const ws = wb.getWorksheet(sheet)!;
  let headerRow = 0;
  ws.eachRow((row, n) => {
    if (!headerRow && row.getCell(1).value === "Emp ID") headerRow = n;
  });
  const headers = (ws.getRow(headerRow).values as unknown[]).slice(1).map((v) => String(v ?? "").split("\n")[0]);
  const rows: Record<string, unknown>[] = [];
  for (let n = headerRow + 1; n <= ws.rowCount; n++) {
    const vals = (ws.getRow(n).values as unknown[]).slice(1);
    if (!vals.length || vals[0] === null || vals[0] === undefined) break;
    rows.push(Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? null])));
  }
  return { wb, ws, headers, rows, headerRow };
}

const workbook = (year: number, month: number, filter: Partial<ReportFilter> = {}, c = ctx) => monthlyAttendanceWorkbook(c, year, month, filter);

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hr-monthly-"));
  setDb(new JsonDatabase(dir));
  const { admin } = await ensureBaseData({ dataDir: dir });
  await saveSettings({ ...(await getSettings()), organizationName: "Test Builders", timezone: "Asia/Kolkata", weeklyOffDays: [0], attendanceStartDate: null });
  ctx = await buildAuthContext(admin);

  ids.civil = (await createDepartment(ctx, { name: "Civil Works", code: "CIV", description: "", active: true })).id;
  ids.elec = (await createDepartment(ctx, { name: "Electrical", code: "ELE", description: "", active: true })).id;
  ids.bulk = (await createDepartment(ctx, { name: "Bulk", code: "BLK", description: "", active: true })).id;
  ids.fitter = (await createDesignation(ctx, { title: "Fitter", departmentId: null, active: true })).id;
  const site = (name: string, code: string) => createLocation(ctx, { name, code, address: "", principalEmployer: "", principalEmployerAddress: "", natureOfWork: "", active: true });
  ids.chennai = (await site("Chennai", "MAA")).id;
  ids.mumbai = (await site("Mumbai", "BOM")).id;

  await addEmployee("T001", "Alice", { dept: "civil", site: "chennai", type: "contract", doj: "2026-01-01", account: true });
  await addEmployee("T002", "Bob", { dept: "elec", site: "mumbai", type: "full_time", doj: "2026-09-15" });
  await addEmployee("T003", "Cara", { dept: "civil", site: "chennai", type: "contract", doj: "2026-01-01" });
  await addEmployee("T004", "Dan", { dept: "elec", site: "chennai", type: "contract", doj: "2027-01-01" });
  await (await col("employees")).updateById(ids.T003, { dateOfExit: "2026-09-10" });

  // September 2026: Sundays (weekly off) are 6, 13, 20, 27.
  await mark("T001", "2026-09-01", "present", { in: "09:00", out: "17:00" });
  await mark("T001", "2026-09-02", "present", { in: "09:45", out: "17:30" }); // late (shift 09:00, grace 10m)
  await mark("T001", "2026-09-03", "half_day", { hours: 4 });
  await mark("T001", "2026-09-04", "absent");
  await createLeave(ctx, { employeeId: ids.T001, fromDate: "2026-09-07", toDate: "2026-09-08", leaveType: "casual", reason: "" });
  await createHoliday(ctx, { date: "2026-09-15", name: "Festival", officeLocationIds: [] });
}, 60_000);

afterAll(() => {
  setDb(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("monthly attendance workbook", () => {
  it("creates one date column per day of the month (31/30/28/29)", async () => {
    for (const [y, m, n] of [
      [2026, 10, 31],
      [2026, 4, 30],
      [2026, 2, 28],
      [2028, 2, 29],
    ]) {
      const { headers } = await readSheet((await workbook(y, m)).data, "Monthly Attendance");
      const dayCols = headers.filter((h) => /^\d+$/.test(h)).map(Number);
      expect(dayCols, `${y}-${m}`).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    }
  });

  it("names the file and sheets as specified", async () => {
    const file = await workbook(2026, 9);
    expect(file.filename).toBe("Attendance_Report_September_2026.xlsx");
    const { wb } = await readSheet(file.data, "Monthly Attendance");
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Monthly Attendance", "Monthly Summary", "Legend & Notes"]);
    const ws = wb.getWorksheet("Monthly Attendance")!;
    expect(ws.getCell("A1").value).toBe("Test Builders");
    expect(String(ws.getCell("A2").value)).toContain("September 2026");
    expect(ws.pageSetup.orientation).toBe("landscape");
  });

  it("classifies present, late, half day, absent, leave, weekly off and holiday", async () => {
    const { rows } = await readSheet((await workbook(2026, 9)).data, "Monthly Attendance");
    const alice = rows.find((r) => r["Emp ID"] === "T001")!;
    expect([alice["1"], alice["2"], alice["3"], alice["4"]]).toEqual(["P", "P/LT", "HD", "A"]);
    expect([alice["6"], alice["7"], alice["8"], alice["15"]]).toEqual(["WO", "L", "L", "H"]);
    expect(alice["5"]).toBe("A"); // unrecorded past working day → Absent by the existing finalisation rule
    expect(alice).toMatchObject({ P: 2, A: 20, L: 2, WO: 4, H: 1, HD: 1, "Late Days": 1, "Total Worked Hours": 19.75, "Expected Working Days": 25 });
    expect(alice["Attendance %"]).toBe(10.9); // (2 × 1 + 1 × 0.5) credit ÷ 23 scheduled days
  });

  it("shows NA before joining and after leaving, and skips employees not employed that month", async () => {
    const { rows } = await readSheet((await workbook(2026, 9)).data, "Monthly Attendance");
    const bob = rows.find((r) => r["Emp ID"] === "T002")!;
    expect(bob["14"]).toBe("NA");
    expect(bob["15"]).toBe("H");
    expect(bob).toMatchObject({ "Expected Working Days": 13, WO: 2 });
    const cara = rows.find((r) => r["Emp ID"] === "T003")!;
    expect(cara["10"]).toBe("A");
    expect(cara["11"]).toBe("NA");
    expect(cara["Expected Working Days"]).toBe(9);
    expect(rows.some((r) => r["Emp ID"] === "T004")).toBe(false);
  });

  it("totals always equal the codes shown in the daily cells", async () => {
    for (const [y, m] of [
      [2026, 9],
      [2026, 10],
    ]) {
      for (const r of (await monthlyAttendanceData(ctx, y, m, {})).rows) {
        const count = (code: string) => r.cells.filter((c) => c.split("/")[0] === code).length;
        expect([count("P"), count("A"), count("L"), count("WO"), count("H"), count("HD")]).toEqual([r.totals.present, r.totals.absent, r.totals.leave, r.totals.weeklyOff, r.totals.holiday, r.totals.halfDay]);
        expect(r.cells.filter((c) => c.endsWith("/LT")).length).toBe(r.totals.late);
      }
    }
  });

  it("does not assume absence for days that are not finalised yet", async () => {
    const d = await monthlyAttendanceData(ctx, 2028, 2, {});
    const alice = d.rows.find((r) => r.employeeCode === "T001")!;
    expect(new Set(alice.cells)).toEqual(new Set(["—", "WO"]));
    expect(alice.totals.absent).toBe(0);
  });

  it("adds overall and department-wise totals to the Monthly Summary sheet", async () => {
    const { ws, rows } = await readSheet((await workbook(2026, 9)).data, "Monthly Summary");
    expect(rows.map((r) => r["Emp ID"])).toEqual(["T001", "T002", "T003", "Overall Total"]);
    expect(rows[3]).toMatchObject({ "Total Present Days": 2, "Total Weekly Off": 7, "Total Holidays": 2, "Expected Working Days": 47 });
    const values: string[] = [];
    ws.eachRow((r) => values.push(String(r.getCell(1).value)));
    expect(values).toContain("Overall Total");
    expect(values).toContain("Department-wise Summary");
    expect(values).toContain("Civil Works");
    expect(values).toContain("Electrical");
  });

  it("respects department, work site and employment type filters", async () => {
    const codes = async (f: Partial<ReportFilter>) => (await readSheet((await workbook(2026, 9, f)).data, "Monthly Attendance")).rows.map((r) => r["Emp ID"]);
    expect(await codes({ departmentIds: [ids.civil] })).toEqual(["T001", "T003"]);
    expect(await codes({ officeLocationIds: [ids.mumbai] })).toEqual(["T002"]);
    expect(await codes({ employmentTypes: ["full_time"] })).toEqual(["T002"]);
    expect(await codes({ search: "ali" })).toEqual(["T001"]);
  });

  it("explains when no employees match", async () => {
    await expect(workbook(2026, 9, { search: "nobody-matches" })).rejects.toMatchObject({ status: 404, message: "No employees match the selected filters for September 2026." });
  });

  it("refuses users without export permission", async () => {
    const user = (await (await col("users")).findOne({ employeeId: ids.T001 }))!;
    const employeeCtx = await buildAuthContext(user);
    const err = await workbook(2026, 9, {}, employeeCtx).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(403);
  });

  it("never modifies attendance records", async () => {
    const before = JSON.stringify(await (await col("attendance_records")).find());
    await workbook(2026, 9);
    expect(JSON.stringify(await (await col("attendance_records")).find())).toBe(before);
  });

  it("handles a large workforce", async () => {
    const template = (await (await col("employees")).findById(ids.T001)) as Employee;
    const bulk = Array.from({ length: 1500 }, (_, i) => ({ ...template, id: `bulk-${i}`, employeeCode: `B${String(i).padStart(4, "0")}`, fullName: `Worker ${i}`, departmentId: ids.bulk }));
    await (await col("employees")).insertMany(bulk);
    const started = Date.now();
    const file = await workbook(2026, 10, { departmentIds: [ids.bulk] });
    expect(file.rows).toBe(1500);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 60_000);
});
