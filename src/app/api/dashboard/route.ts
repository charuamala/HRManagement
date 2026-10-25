import { route, query } from "@/server/http";
import { reportFilterSchema, FILTER_ARRAY_KEYS } from "@/lib/schemas";
import { dashboard } from "@/server/services/reports";

export const GET = route({ permission: "dashboard.view" }, async (req, { auth }) =>
  dashboard(auth, query(req, reportFilterSchema, FILTER_ARRAY_KEYS)),
);
