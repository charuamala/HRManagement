import { route } from "@/server/http";
import { cancelImport } from "@/server/services/imports";

export const POST = route<{ id: string }>({ permission: "bulk_upload.import" }, async (_req, { auth, params }) => cancelImport(auth, params.id));
