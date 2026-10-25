import { route } from "@/server/http";

export const GET = route({}, async (_req, { auth }) => ({
  user: { id: auth.user.id, displayName: auth.user.displayName, role: auth.role, employeeId: auth.user.employeeId },
  permissions: [...auth.permissions],
  organizationName: auth.settings.organizationName,
  timezone: auth.settings.timezone,
}));
