import { z } from "zod";
import { route, query, fileResponse } from "@/server/http";
import { reportFilterSchema, FILTER_ARRAY_KEYS } from "@/lib/schemas";
import { monthlyAttendancePreview, monthlyAttendanceWorkbook } from "@/server/services/monthly-report";

const q = reportFilterSchema.extend({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  format: z.enum(["xlsx", "json"]).default("xlsx"),
});

/** Monthly attendance pivot: `format=json` previews the match count, `xlsx` downloads the workbook. */
export const GET = route({}, async (req, { auth }) => {
  const { year, month, format, ...filter } = query(req, q as z.ZodType<z.infer<typeof q>>, FILTER_ARRAY_KEYS);
  if (format === "json") return monthlyAttendancePreview(auth, year, month, filter);
  const file = await monthlyAttendanceWorkbook(auth, year, month, filter);
  return fileResponse(file.data, file.filename, file.contentType);
});
