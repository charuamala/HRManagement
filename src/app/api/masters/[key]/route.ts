import { z } from "zod";
import { route, query } from "@/server/http";
import { createMaster, listMaster } from "@/server/services/masters";
import { masterKey } from "../key";

const listSchema = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.enum(["all", "active", "inactive"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(500).optional(),
});

export const GET = route<{ key: string }>({}, async (req, { auth, params }) => listMaster(auth, masterKey(params.key), query(req, listSchema)));

export const POST = route<{ key: string }>({}, async (req, { auth, params }) => createMaster(auth, masterKey(params.key), await req.json().catch(() => ({}))));
