import { z } from "zod";
import { route, body } from "@/server/http";
import { zDate } from "@/lib/schemas";
import { setEmployeeActive } from "@/server/services/employees";

const schema = z.object({
  active: z.boolean(),
  date: zDate.optional(),
  reason: z.string().trim().max(500).optional(),
});

/** Deactivate (soft delete, keeps history) or reactivate an employee. */
export const POST = route<{ id: string }>({ permission: ["employees.edit", "employees.delete"] }, async (req, { auth, params }) => {
  const input = await body(req, schema);
  return setEmployeeActive(auth, params.id, input.active, { date: input.date, reason: input.reason });
});
