import { redirect } from "next/navigation";

/** Old address — the dashboard now lives at the app's home page. */
export default function DashboardPage() {
  redirect("/");
}
