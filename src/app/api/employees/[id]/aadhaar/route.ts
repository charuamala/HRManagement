import { route } from "@/server/http";
import { revealAadhaar } from "@/server/services/employees";

/** Reveal the full Aadhaar number (admin or the employee themself). Audit-logged; never cached. */
export const GET = route<{ id: string }>({}, async (_req, { auth, params }) => {
  const data = await revealAadhaar(auth, params.id);
  return Response.json({ ok: true, data }, { headers: { "Cache-Control": "no-store" } });
});
