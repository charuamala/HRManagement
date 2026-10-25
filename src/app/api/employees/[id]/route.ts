import { z } from "zod";
import { route, body } from "@/server/http";
import { employeeUpdateSchema } from "@/lib/schemas";
import { deleteEmployee, getEmployee, updateEmployee } from "@/server/services/employees";

export const GET = route<{ id: string }>({}, async (_req, { auth, params }) => getEmployee(auth, params.id));
export const PUT = route<{ id: string }>({ permission: "employees.edit" }, async (req, { auth, params }) =>
  updateEmployee(auth, params.id, await body(req, employeeUpdateSchema)),
);
export const DELETE = route<{ id: string }>({ permission: "employees.delete" }, async (req, { auth, params }) => {
  const { reason } = await body(req, z.object({ reason: z.string().trim().min(3, "Please give a reason").max(500) }));
  return deleteEmployee(auth, params.id, reason);
});
