import { z } from "zod";
import { route, query, fileResponse } from "@/server/http";
import { masterTemplate } from "@/server/services/masters";
import { masterKey } from "../../key";

export const GET = route<{ key: string }>({}, async (req, { auth, params }) => {
  const { format } = query(req, z.object({ format: z.enum(["csv", "xlsx"]).default("xlsx") }));
  const f = await masterTemplate(auth, masterKey(params.key), format);
  return fileResponse(f.data, f.filename, f.contentType);
});
