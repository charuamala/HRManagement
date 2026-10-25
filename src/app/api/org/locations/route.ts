import { route, body } from "@/server/http";
import { locationSchema } from "@/lib/schemas";
import { createLocation, listLocations } from "@/server/services/org";

export const GET = route({}, async () => listLocations());
export const POST = route({ permission: "departments.create" }, async (req, { auth }) => createLocation(auth, await body(req, locationSchema)));
