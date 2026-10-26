"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import clsx from "clsx";
import { CalendarCheck, Database, LayoutDashboard, LogOut, Menu, Users, X } from "lucide-react";
import { api } from "@/lib/api";
import { withBase } from "@/lib/base-path";
import { ROLE_LABELS } from "@/lib/permissions";
import type { RoleKey } from "@/lib/types";

export interface ShellUser {
  displayName: string;
  role: RoleKey;
  permissions: string[];
  organizationName: string;
  today: string;
}

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, perm: "dashboard.view" },
  { href: "/employees", label: "Employees", icon: Users, perm: "employees.view" },
  { href: "/attendance", label: "Daily Attendance", icon: CalendarCheck, perm: "attendance.view" },
  { href: "/masters", label: "Master Management", icon: Database, perm: "masters.view" },
];

export function Shell({ user, children }: { user: ShellUser; children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const allowed = NAV.filter((n) => user.role === "admin" || user.permissions.includes(n.perm));

  async function logout() {
    await api("POST", "/api/auth/logout").catch(() => null);
    window.location.href = withBase("/login");
  }

  const nav = (
    <nav className="space-y-1 p-3" aria-label="Main">
      {allowed.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            onClick={() => setOpen(false)}
            aria-current={active ? "page" : undefined}
            className={clsx(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition",
              active ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white lg:block">
        <div className="flex h-14 items-center gap-2 border-b border-slate-100 px-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">HR</div>
          <span className="text-sm font-semibold">Attendance</span>
        </div>
        {nav}
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 bg-white shadow-xl">
            <div className="flex h-14 items-center justify-between border-b px-4">
              <span className="text-sm font-semibold">Menu</span>
              <button onClick={() => setOpen(false)} aria-label="Close menu" className="rounded p-1 hover:bg-slate-100">
                <X className="h-5 w-5" />
              </button>
            </div>
            {nav}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur">
          <button className="rounded p-1.5 hover:bg-slate-100 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu">
            <Menu className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-slate-800">{user.organizationName}</div>
            <div className="text-xs text-slate-500">{user.today}</div>
          </div>
          <div className="hidden text-right sm:block">
            <div className="text-sm font-medium">{user.displayName}</div>
            <div className="text-xs text-brand-700">{ROLE_LABELS[user.role]}</div>
          </div>
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700" aria-hidden>
            {user.displayName.slice(0, 2).toUpperCase()}
          </div>
          <button onClick={logout} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800" aria-label="Sign out" title="Sign out">
            <LogOut className="h-4 w-4" />
          </button>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
