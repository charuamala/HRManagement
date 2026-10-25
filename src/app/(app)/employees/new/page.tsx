import { requirePagePermission } from "@/server/auth/page";
import { todayInTz } from "@/lib/time";
import { NewEmployee } from "./view";

export default async function NewEmployeePage() {
  const auth = await requirePagePermission("employees.create");
  return <NewEmployee today={todayInTz(auth.settings.timezone)} isAdmin={auth.role === "admin"} />;
}
