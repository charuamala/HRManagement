/**
 * Imports a monthly labour attendance register (JSON transcription of the
 * contractor sheet) through the normal services, so every write is validated
 * and audit-logged. Idempotent: re-running updates employees and records in place.
 *
 *   npm run import:register -- data-import/register-2026-10.json
 */
import fs from "fs";
import path from "path";
for (const f of [".env.local", ".env"]) if (fs.existsSync(f)) process.loadEnvFile(f);
// Scripts write the JSON files only; the running server (or `npm run mirror -- sync`) copies changes to MongoDB.
process.env.MONGO_MIRROR = "false";

import { col } from "@/server/db";
import { ensureBaseData } from "@/server/bootstrap";
import { buildAuthContext } from "@/server/auth/context";
import { getSettings, saveSettings } from "@/server/services/settings";
import { createEmployee, updateEmployee } from "@/server/services/employees";
import { createAttendance, updateAttendance } from "@/server/services/attendance";
import { createHoliday, createDepartment, createDesignation, createLocation, updateLocation } from "@/server/services/org";
import { employeeCreateSchema } from "@/lib/schemas";
import { parse } from "@/server/http";
import { AppError } from "@/server/errors";
import { summarize } from "@/lib/kpi";
import { DayResolver } from "@/server/services/days";

interface RegisterEmployee {
  employeeCode: string;
  uan: string;
  title: string;
  name: string;
  gender: "male" | "female" | "other";
  fatherName: string;
  dateOfJoining: string;
  dateOfBirth: string;
  designation: string;
  permanentAddress: string;
  localAddress: string;
  labourStatus: "onroll" | "offroll";
  bankAccountNumber: string;
  ifscCode: string;
  sheetWorkingDays: number;
  sheetLop: number;
  attendance: string[];
}

interface Register {
  employer: { name: string };
  site: { code: string; name: string; address: string; principalEmployer: string; principalEmployerAddress: string; natureOfWork: string };
  department: { code: string; name: string };
  period: { label: string };
  days: string[];
  employees: RegisterEmployee[];
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: npm run import:register -- <register.json>");
  const reg = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as Register;
  const log = (m: string) => console.log(m);

  const { admin } = await ensureBaseData({ log });
  const ctx = await buildAuthContext(admin);

  let settings = await getSettings();
  const firstDay = [...reg.days].sort()[0];
  const startDate = !settings.attendanceStartDate || settings.attendanceStartDate > firstDay ? firstDay : settings.attendanceStartDate;
  if (settings.organizationName !== reg.employer.name || settings.attendanceStartDate !== startDate) {
    settings = await saveSettings({ ...settings, organizationName: reg.employer.name, attendanceStartDate: startDate });
    log(`Attendance tracking starts ${startDate} (earlier days are not counted as absent)`);
  }

  // Site, department, designations
  const locs = await col("office_locations");
  let site = await locs.findOne({ code: reg.site.code.toUpperCase() });
  const siteData = { ...reg.site, code: reg.site.code.toUpperCase(), active: true };
  if (!site) site = await createLocation(ctx, siteData);
  else site = await updateLocation(ctx, site.id, siteData);

  let dept = await (await col("departments")).findOne({ code: reg.department.code });
  dept ??= await createDepartment(ctx, { ...reg.department, description: reg.site.natureOfWork, active: true });

  const desigCol = await col("designations");
  const desigId = new Map<string, string>();
  for (const title of new Set(reg.employees.map((e) => e.designation))) {
    const d = (await desigCol.findOne({ title })) ?? (await createDesignation(ctx, { title, departmentId: dept.id, active: true }));
    desigId.set(title, d.id);
  }

  // Employees (upsert by Employee ID)
  const empCol = await col("employees");
  const shift = settings.defaultShiftId ?? (await (await col("shifts")).findOne({ code: "GEN" }))?.id ?? null;
  const invites: string[] = [];
  for (const r of reg.employees) {
    const input = parse(employeeCreateSchema, {
      employeeCode: r.employeeCode,
      uan: r.uan,
      title: r.title,
      firstName: r.name,
      lastName: "",
      gender: r.gender,
      fatherName: r.fatherName,
      dateOfBirth: r.dateOfBirth,
      permanentAddress: r.permanentAddress,
      localAddress: r.localAddress,
      labourStatus: r.labourStatus,
      bankAccountNumber: r.bankAccountNumber,
      ifscCode: r.ifscCode,
      officialEmail: null,
      personalEmail: null,
      mobile: null,
      departmentId: dept.id,
      designationId: desigId.get(r.designation) ?? null,
      supervisorEmployeeId: null,
      officeLocationId: site.id,
      employmentType: "contract",
      dateOfJoining: r.dateOfJoining,
      employmentStatus: "active",
      shiftId: shift,
      expectedEntryTime: null,
      expectedExitTime: null,
      standardWorkingHours: null,
      weeklyOffDays: null,
      createAccount: true,
      role: "employee",
    });
    const existing = await empCol.findOne({ employeeCode: input.employeeCode });
    if (existing) {
      const { createAccount: _c, ...upd } = input;
      void _c;
      await updateEmployee(ctx, existing.id, upd);
    } else {
      const res = await createEmployee(ctx, input);
      if (res.inviteLink) invites.push(`${r.employeeCode}: ${res.inviteLink}`);
    }
  }
  const employees = await empCol.find({ employeeCode: { $in: reg.employees.map((e) => e.employeeCode.toUpperCase()) } });
  const byCode = new Map(employees.map((e) => [e.employeeCode, e]));

  // Dates blank for every worker → organisation holiday ("site closed")
  const holidays = await col("holidays");
  const allBlank = reg.days.filter((_, i) => reg.employees.every((e) => (e.attendance[i] ?? "").trim() === ""));
  for (const date of allBlank) {
    if (!(await holidays.findOne({ date }))) await createHoliday(ctx, { date, name: "Site closed (blank in register)", officeLocationIds: [site.id] });
  }

  // Attendance cells
  const recCol = await col("attendance_records");
  const stats = { created: 0, updated: 0, unchanged: 0, holidaysByOrg: allBlank.length, failed: 0 };
  const failures: string[] = [];
  const remarks = `Imported from register (${reg.period.label})`;
  for (const r of reg.employees) {
    const emp = byCode.get(r.employeeCode.toUpperCase())!;
    for (let i = 0; i < reg.days.length; i++) {
      const date = reg.days[i];
      const cell = (r.attendance[i] ?? "").trim().toUpperCase();
      if (cell === "" && allBlank.includes(date)) continue;
      let statusCode: string;
      let workedHours: number | null = null;
      if (cell === "") statusCode = "holiday";
      else if (cell === "-") statusCode = "absent";
      else if (cell === "WO") statusCode = "weekly_off";
      else if (/^\d+(\.\d+)?$/.test(cell)) {
        workedHours = Number(cell);
        statusCode = workedHours >= settings.fullDayHours ? "present" : workedHours >= settings.halfDayHours ? "half_day" : "absent";
      } else {
        failures.push(`${r.employeeCode} ${date}: unknown cell value "${cell}"`);
        stats.failed++;
        continue;
      }
      try {
        const existing = await recCol.findOne({ employeeId: emp.id, date, segment: 1, voided: false });
        if (existing) {
          const same = existing.statusCode === statusCode && (existing.reportedMinutes ?? null) === (workedHours != null ? workedHours * 60 : null);
          if (same) {
            stats.unchanged++;
            continue;
          }
          await updateAttendance(ctx, existing.id, { statusCode, checkIn: null, checkOut: null, workedHours, allowFuture: true, reason: "Register re-import" }, "import");
          stats.updated++;
        } else {
          await createAttendance(ctx, { employeeId: emp.id, date, statusCode, checkIn: null, checkOut: null, workedHours, remarks, allowFuture: true }, "import");
          stats.created++;
        }
      } catch (e) {
        stats.failed++;
        failures.push(`${r.employeeCode} ${date}: ${e instanceof AppError ? e.message : String(e)}`);
      }
    }
  }

  // Reconcile against the sheet's own Working Days / LOP columns
  const resolver = await DayResolver.load(employees.map((e) => e.id), reg.days[0], reg.days[reg.days.length - 1]);
  console.log("\nReconciliation (system vs sheet):");
  console.log("Emp ID  Worked  Sheet-WD  Absent  WO  Holiday  Sheet-LOP");
  for (const r of reg.employees) {
    const emp = byCode.get(r.employeeCode.toUpperCase())!;
    const s = summarize(reg.days.map((d) => resolver.resolve(emp, d)));
    const flag = s.present !== r.sheetWorkingDays ? "  ← working days differ" : "";
    console.log(
      `${r.employeeCode.padEnd(7)} ${String(s.present).padStart(6)}  ${String(r.sheetWorkingDays).padStart(8)}  ${String(s.absent).padStart(6)}  ${String(s.weeklyOff).padStart(2)}  ${String(s.holiday).padStart(7)}  ${String(r.sheetLop).padStart(9)}${flag}`,
    );
  }
  console.log("\nAttendance:", stats);
  if (failures.length) console.log("Failures:\n  " + failures.join("\n  "));
  if (invites.length) console.log(`\n${invites.length} login invitation(s) created (status "invited"). Admins can re-issue links from User Management.`);
}

main().catch((e) => {
  console.error(e instanceof AppError ? `${e.code}: ${e.message} ${JSON.stringify(e.details ?? "")}` : e);
  process.exit(1);
});
