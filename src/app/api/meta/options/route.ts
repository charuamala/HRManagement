import { route } from "@/server/http";
import { listDepartments, listDesignations, listLocations, listShifts, listStatuses } from "@/server/services/org";
import { scopedEmployees } from "@/server/services/employees";

/** Reference data for forms and filters (employees limited to the caller's scope). */
export const GET = route({}, async (_req, { auth }) => {
  const [departments, designations, locations, shifts, statuses, employees] = await Promise.all([
    listDepartments(),
    listDesignations(),
    listLocations(),
    listShifts(),
    listStatuses(),
    scopedEmployees(auth, {}, "attendance.view", "self_attendance.view"),
  ]);
  return {
    departments,
    designations,
    locations,
    shifts,
    statuses,
    employees: employees.map((e) => ({ id: e.id, employeeCode: e.employeeCode, fullName: e.fullName, departmentId: e.departmentId })),
  };
});
