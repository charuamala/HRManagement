import { Suspense } from "react";
import { requirePagePermission } from "@/server/auth/page";
import { Spinner } from "@/components/ui";
import { RegisterView } from "./view";

export default async function AttendancePage() {
  await requirePagePermission("attendance.view");
  return (
    <Suspense fallback={<Spinner />}>
      <RegisterView />
    </Suspense>
  );
}
