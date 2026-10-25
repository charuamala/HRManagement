import { route } from "@/server/http";
import { badRequest } from "@/server/errors";
import { importMaster } from "@/server/services/masters";
import { MAX_UPLOAD_BYTES } from "@/server/services/tabular";
import { masterKey } from "../../key";

/** multipart/form-data: file, commit ("true" to save; otherwise preview only), updateExisting ("true"). */
export const POST = route<{ key: string }>({}, async (req, { auth, params }) => {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES + 64 * 1024) throw badRequest("File is too large (max 5 MB)");
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") throw badRequest("Attach a CSV or Excel file in the 'file' field");
  return importMaster(auth, masterKey(params.key), { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) }, {
    commit: form!.get("commit") === "true",
    updateExisting: form!.get("updateExisting") === "true",
  });
});
