import { route, body } from "@/server/http";
import { departmentSchema } from "@/lib/schemas";
import { createDepartment, listDepartments } from "@/server/services/org";

export const GET = route({}, async () => listDepartments());
export const POST = route({ permission: "departments.create" }, async (req, { auth }) => createDepartment(auth, await body(req, departmentSchema)));
