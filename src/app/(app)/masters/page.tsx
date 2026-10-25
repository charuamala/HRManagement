import { requirePagePermission } from "@/server/auth/page";
import { can } from "@/server/auth/context";
import { MastersView } from "./view";

export default async function MastersPage() {
  const auth = await requirePagePermission("masters.view", "permissions.view");
  return <MastersView canDelete={can(auth, "masters.delete")} isAdmin={auth.role === "admin"} />;
}
