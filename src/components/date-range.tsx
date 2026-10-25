"use client";
import clsx from "clsx";
import { ArrowRight, CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { addDays, diffDays, presetRange, type PeriodPreset } from "@/lib/time";

const PRESETS: { key: Exclude<PeriodPreset, "custom" | "this_year">; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "this_week", label: "This week" },
  { key: "last_week", label: "Last week" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
];

const dateCls = "w-[8.5rem] bg-transparent text-sm font-medium text-slate-800 focus:outline-none";

/** From/To picker with quick presets; the arrows move the whole range by its own length. */
export function DateRangeBar({ from, to, today, maxDays, onChange }: { from: string; to: string; today: string; maxDays: number; onChange: (from: string, to: string) => void }) {
  const span = from && to ? diffDays(from, to) + 1 : 1;

  function set(f: string, t: string) {
    if (!f || !t) return;
    if (t < f) [f, t] = [t, f];
    if (diffDays(f, t) + 1 > maxDays) t = addDays(f, maxDays - 1);
    onChange(f, t);
  }

  const shift = (dir: 1 | -1) => set(addDays(from, dir * span), addDays(to, dir * span));
  // `today` arrives with the register data; it is empty during the first (server) render.
  const active = today
    ? PRESETS.find((p) => {
        const r = presetRange(p.key, today);
        return r.from === from && r.to === to;
      })?.key
    : undefined;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => shift(-1)} disabled={!from} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-40" aria-label="Previous period">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-1.5 focus-within:border-brand-500">
          <CalendarDays className="h-4 w-4 text-brand-600" aria-hidden />
          <label className="flex flex-col">
            <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">From</span>
            <input type="date" value={from} max={to || undefined} onChange={(e) => set(e.target.value, to)} className={dateCls} />
          </label>
          <ArrowRight className="h-4 w-4 text-slate-300" aria-hidden />
          <label className="flex flex-col">
            <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">To</span>
            <input type="date" value={to} min={from || undefined} onChange={(e) => set(from, e.target.value)} className={dateCls} />
          </label>
        </div>
        <button type="button" onClick={() => shift(1)} disabled={!to} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-40" aria-label="Next period">
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700">
        {span} day{span === 1 ? "" : "s"}
      </span>
      <div className="flex flex-wrap gap-1.5 sm:ml-auto" role="group" aria-label="Quick ranges">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => {
              const r = presetRange(p.key, today);
              set(r.from, r.to);
            }}
            disabled={!today}
            aria-pressed={active === p.key}
            className={clsx(
              "rounded-full border px-3 py-1 text-xs font-medium transition",
              active === p.key ? "border-brand-600 bg-brand-600 text-white" : "border-slate-200 text-slate-600 hover:border-brand-500/50 hover:bg-brand-50",
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}
