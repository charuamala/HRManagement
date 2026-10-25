import { z } from "zod";
import { route, body } from "@/server/http";
import { attendanceUpdateSchema } from "@/lib/schemas";
import { getAttendanceDetail, updateAttendance, voidAttendance } from "@/server/services/attendance";

export const GET = route<{ id: string }>({}, async (_req, { auth, params }) => getAttendanceDetail(auth, params.id));
export const PATCH = route<{ id: string }>({ permission: "attendance.edit" }, async (req, { auth, params }) =>
  updateAttendance(auth, params.id, await body(req, attendanceUpdateSchema)),
);
export const DELETE = route<{ id: string }>({ permission: "attendance.delete" }, async (req, { auth, params }) => {
  const { reason } = await body(req, z.object({ reason: z.string().trim().min(3, "Reason required").max(500) }));
  return voidAttendance(auth, params.id, reason);
});
