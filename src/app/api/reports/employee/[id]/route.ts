import { z } from "zod";
import { route, query } from "@/server/http";
import { employeeReport } from "@/server/services/reports";
import { todayInTz } from "@/lib/time";

export const GET = route<{ id: string }>({}, async (req, { auth, params }) => {
  const { year } = query(req, z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }));
  return employeeReport(auth, params.id, year ?? Number(todayInTz(auth.settings.timezone).slice(0, 4)));
});
