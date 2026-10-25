import { route, body } from "@/server/http";
import { designationSchema } from "@/lib/schemas";
import { createDesignation, listDesignations } from "@/server/services/org";

export const GET = route({}, async () => listDesignations());
export const POST = route({ permission: "departments.create" }, async (req, { auth }) => createDesignation(auth, await body(req, designationSchema)));
