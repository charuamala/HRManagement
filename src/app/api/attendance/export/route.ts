import { z } from "zod";
import { route, query, fileResponse } from "@/server/http";
import { reportFilterSchema, FILTER_ARRAY_KEYS, zDate } from "@/lib/schemas";
import { exportAttendance } from "@/server/services/imports";
import { scopedEmployees } from "@/server/services/employees";

const q = reportFilterSchema.extend({ from: zDate, to: zDate, format: z.enum(["xlsx", "csv"]).default("xlsx") });

export const GET = route({ permission: "attendance.view" }, async (req, { auth }) => {
  const f = query(req, q as z.ZodType<z.infer<typeof q>>, FILTER_ARRAY_KEYS);
  const employees = await scopedEmployees(auth, f, "attendance.view");
  const file = await exportAttendance(auth, f.from, f.to, employees, f.format);
  return fileResponse(file.data, file.filename, file.contentType);
});
