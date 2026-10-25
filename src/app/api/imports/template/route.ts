import { z } from "zod";
import { route, query, fileResponse } from "@/server/http";
import { buildImportTemplate } from "@/server/services/imports";

export const GET = route({}, async (req, { auth }) => {
  const { format } = query(req, z.object({ format: z.enum(["xlsx", "csv"]).default("xlsx") }));
  const file = await buildImportTemplate(auth, format);
  return fileResponse(file.data, file.filename, file.contentType);
});
