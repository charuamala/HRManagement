import { requirePagePermission } from "@/server/auth/page";
import { can } from "@/server/auth/context";
import { todayInTz } from "@/lib/time";
import { EmployeesView } from "./view";

export default async function EmployeesPage() {
  const auth = await requirePagePermission("employees.view");
  return (
    <EmployeesView
      today={todayInTz(auth.settings.timezone)}
      perms={{ create: can(auth, "employees.create"), edit: can(auth, "employees.edit"), remove: can(auth, "employees.delete") }}
    />
  );
}
