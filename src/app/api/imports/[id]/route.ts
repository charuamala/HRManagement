import { z } from "zod";
import { route, query } from "@/server/http";
import { getImportJob } from "@/server/services/imports";

const q = z.object({
  status: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

export const GET = route<{ id: string }>({}, async (req, { auth, params }) => getImportJob(auth, params.id, query(req, q)));
