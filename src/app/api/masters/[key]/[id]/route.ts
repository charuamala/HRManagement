import { z } from "zod";
import { route, body } from "@/server/http";
import { deleteMaster, getMaster, updateMaster } from "@/server/services/masters";
import { masterKey } from "../../key";

export const GET = route<{ key: string; id: string }>({}, async (_req, { auth, params }) => getMaster(auth, masterKey(params.key), params.id));
export const PUT = route<{ key: string; id: string }>({}, async (req, { auth, params }) =>
  updateMaster(auth, masterKey(params.key), params.id, await req.json().catch(() => ({}))),
);
export const DELETE = route<{ key: string; id: string }>({}, async (req, { auth, params }) => {
  const { reason } = await body(req, z.object({ reason: z.string().trim().max(500).optional() }));
  return deleteMaster(auth, masterKey(params.key), params.id, reason);
});
