import { z } from "zod";
import { route, query, body } from "@/server/http";
import { reportFilterSchema, paginationSchema, FILTER_ARRAY_KEYS, employeeCreateSchema } from "@/lib/schemas";
import { listEmployees, createEmployee } from "@/server/services/employees";

const listSchema = reportFilterSchema.extend(paginationSchema.shape);

export const GET = route({ permission: "employees.view" }, async (req, { auth }) =>
  listEmployees(auth, query(req, listSchema as z.ZodType<z.infer<typeof listSchema>>, FILTER_ARRAY_KEYS)),
);

export const POST = route({ permission: "employees.create" }, async (req, { auth }) => createEmployee(auth, await body(req, employeeCreateSchema)));
