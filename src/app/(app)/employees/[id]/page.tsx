import { requirePageAuth } from "@/server/auth/page";
import { can } from "@/server/auth/context";
import { todayInTz } from "@/lib/time";
import { EmployeeDetail } from "./view";

export default async function EmployeePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ edit?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const auth = await requirePageAuth();
  return (
    <EmployeeDetail
      id={id}
      today={todayInTz(auth.settings.timezone)}
      startEditing={sp.edit === "1"}
      isAdmin={auth.role === "admin"}
      perms={{ edit: can(auth, "employees.edit"), remove: can(auth, "employees.delete"), isSelf: auth.scope.selfId === id }}
    />
  );
}
