import { z } from "zod";
import { route, query, body } from "@/server/http";
import { reportFilterSchema, registerSaveSchema, FILTER_ARRAY_KEYS, zDate } from "@/lib/schemas";
import { getRegister, saveRegister } from "@/server/services/attendance";
import { scopedEmployees } from "@/server/services/employees";
import { badRequest } from "@/server/errors";
import { diffDays, eachDay, todayInTz } from "@/lib/time";

const MAX_RANGE_DAYS = 31;

const q = reportFilterSchema.extend({ date: zDate.optional(), from: zDate.optional(), to: zDate.optional() });

/** One day (`date`, or today) or a `from`–`to` range of up to 31 days. */
export const GET = route({ permission: "attendance.view" }, async (req, { auth }) => {
  const f = query(req, q as z.ZodType<z.infer<typeof q>>, FILTER_ARRAY_KEYS);
  const today = todayInTz(auth.settings.timezone);
  const from = f.from ?? f.date ?? today;
  const to = f.to ?? (f.from ? from : (f.date ?? today));
  if (to < from) throw badRequest("The end date must be on or after the start date");
  if (diffDays(from, to) + 1 > MAX_RANGE_DAYS) throw badRequest(`Choose a range of at most ${MAX_RANGE_DAYS} days`);
  const employees = await scopedEmployees(auth, f, "attendance.view");
  const days = [];
  for (const date of eachDay(from, to)) days.push({ date, ...(await getRegister(auth, date, employees)) });
  return { from, to, today, days };
});

export const PUT = route({ permission: ["attendance.create", "attendance.edit"] }, async (req, { auth }) => {
  const input = await body(req, registerSaveSchema);
  return saveRegister(auth, input.date, input.rows);
});
