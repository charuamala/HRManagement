import { route } from "@/server/http";
import { badRequest } from "@/server/errors";
import { getPhoto, MAX_PHOTO_BYTES, removePhoto, setPhoto } from "@/server/services/photos";

/** Serves the photo bytes. The URL carries ?v=<photoId>, so responses can be cached privately. */
export const GET = route<{ id: string }>({}, async (_req, { auth, params }) => {
  const photo = await getPhoto(auth, params.id);
  return new Response(Buffer.from(photo.data, "base64"), {
    headers: {
      "Content-Type": photo.contentType,
      "Content-Length": String(photo.size),
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
});

/** multipart/form-data with a single "file" field. */
export const POST = route<{ id: string }>({}, async (req, { auth, params }) => {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_PHOTO_BYTES + 64 * 1024) throw badRequest("Photo must be 2 MB or smaller");
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") throw badRequest("Attach an image in the 'file' field");
  return setPhoto(auth, params.id, Buffer.from(await file.arrayBuffer()));
});

export const DELETE = route<{ id: string }>({}, async (_req, { auth, params }) => removePhoto(auth, params.id));
