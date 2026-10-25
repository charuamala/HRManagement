import { requirePageAuth } from "@/server/auth/page";
import { Shell } from "@/components/shell";
import { formatDisplayDate, todayInTz, WEEKDAY_NAMES, dayOfWeek } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const auth = await requirePageAuth();
  const today = todayInTz(auth.settings.timezone);
  return (
    <Shell
      user={{
        displayName: auth.user.displayName,
        role: auth.role,
        permissions: [...auth.permissions],
        organizationName: auth.settings.organizationName,
        today: `${WEEKDAY_NAMES[dayOfWeek(today)]}, ${formatDisplayDate(today)} · ${auth.settings.timezone}`,
      }}
    >
      {children}
    </Shell>
  );
}
