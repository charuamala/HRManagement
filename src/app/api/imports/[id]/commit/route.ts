import { z } from "zod";
import { route, body } from "@/server/http";
import { commitImport } from "@/server/services/imports";

export const POST = route<{ id: string }>({ permission: "bulk_upload.import" }, async (req, { auth, params }) => {
  const { mode } = await body(req, z.object({ mode: z.enum(["insert", "update", "upsert"]) }));
  return commitImport(auth, params.id, mode);
});
