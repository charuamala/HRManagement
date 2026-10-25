import { requirePagePermission } from "@/server/auth/page";
import { DashboardView } from "./view";

export default async function DashboardPage() {
  await requirePagePermission("dashboard.view");
  return <DashboardView />;
}
