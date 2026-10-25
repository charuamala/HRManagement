import { route } from "@/server/http";
import { mastersSummary } from "@/server/services/masters";
import { catalog } from "@/server/services/permissions";

/** Counts per master (only those the caller may view) plus the permission catalog for the Role Master grid. */
export const GET = route({}, async (_req, { auth }) => ({ summary: await mastersSummary(auth), permissionCatalog: catalog() }));
