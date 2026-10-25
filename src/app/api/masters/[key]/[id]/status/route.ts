import { z } from "zod";
import { route, body } from "@/server/http";
import { setMasterActive } from "@/server/services/masters";
import { masterKey } from "../../../key";

export const POST = route<{ key: string; id: string }>({}, async (req, { auth, params }) => {
  const { active, reason } = await body(req, z.object({ active: z.boolean(), reason: z.string().trim().max(500).optional() }));
  return setMasterActive(auth, masterKey(params.key), params.id, active, reason);
});
