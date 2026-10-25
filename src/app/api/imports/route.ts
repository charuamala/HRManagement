import { route } from "@/server/http";
import { badRequest } from "@/server/errors";
import { listImportJobs, uploadAttendanceFile } from "@/server/services/imports";

export const GET = route({}, async (_req, { auth }) => listImportJobs(auth));

export const POST = route({ permission: "bulk_upload.import" }, async (req, { auth }) => {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw badRequest("Choose an .xlsx or .csv file to upload");
  return uploadAttendanceFile(auth, { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) });
});
