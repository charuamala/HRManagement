import { route } from "@/server/http";
import { badRequest } from "@/server/errors";
import { setDefaultShift } from "@/server/services/masters";

/** Make a shift the organisation default ("Organisation default" in the employee form). */
export const POST = route<{ key: string; id: string }>({}, async (_req, { auth, params }) => {
  if (params.key !== "shifts") throw badRequest("Only shifts have an organisation default");
  return setDefaultShift(auth, params.id);
});
