import { route, fileResponse } from "@/server/http";
import { importErrorFile } from "@/server/services/imports";

export const GET = route<{ id: string }>({}, async (_req, { auth, params }) => {
  const file = await importErrorFile(auth, params.id);
  return fileResponse(file.data, file.filename, file.contentType);
});
