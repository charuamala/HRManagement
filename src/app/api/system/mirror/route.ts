import { route } from "@/server/http";
import { forbidden } from "@/server/errors";
import { getMirror } from "@/server/db";

/** Cloud-mirror health for administrators. POST triggers a full re-sync. */
export const GET = route({}, async (_req, { auth }) => {
  if (auth.role !== "admin") throw forbidden();
  const m = await getMirror();
  return m ? m.status : { enabled: false };
});

export const POST = route({}, async (_req, { auth }) => {
  if (auth.role !== "admin") throw forbidden();
  const m = await getMirror();
  if (!m) return { enabled: false };
  m.requestFullSync();
  return { queued: true };
});
