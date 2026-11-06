import { requirePagePermission } from "@/server/auth/page";
import { DashboardView } from "./dashboard/view";

/** The dashboard is the app's home page (e.g. https://plantopiaforms.com/HRmanagement). */
export default async function HomePage() {
  await requirePagePermission("dashboard.view");
  return <DashboardView />;
}
