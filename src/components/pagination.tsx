"use client";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

export const PAGE_SIZES = [10, 25, 50, 100];

/** Per-page choice remembered per screen in this browser (falls back silently if storage is unavailable). */
export function usePageSize(storageKey: string, fallback = 25): [number, (n: number) => void] {
  const [size, setSize] = useState(fallback);
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(`pageSize:${storageKey}`));
      if (PAGE_SIZES.includes(v)) setSize(v);
    } catch {
      /* storage blocked — keep default */
    }
  }, [storageKey]);
  const update = (n: number) => {
    setSize(n);
    try {
      localStorage.setItem(`pageSize:${storageKey}`, String(n));
    } catch {
      /* ignore */
    }
  };
  return [size, update];
}

function pageList(page: number, pages: number): (number | "…")[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const out: (number | "…")[] = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(pages - 1, page + 1);
  if (start > 2) out.push("…");
  for (let i = start; i <= end; i++) out.push(i);
  if (end < pages - 1) out.push("…");
  out.push(pages);
  return out;
}

const btnBase = "inline-flex h-8 min-w-8 items-center justify-center rounded-lg border px-2 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40";
const btn = `${btnBase} border-slate-300 bg-white text-slate-700 hover:bg-slate-50`;
const btnActive = `${btnBase} border-brand-600 bg-brand-600 text-white hover:bg-brand-700`;

/** "Showing 1–25 of 34 · Rows per page [25] · « ‹ 1 2 › »" */
export function Pagination({
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
  label = "records",
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
  onPageSize: (n: number) => void;
  label?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);
  return (
    <nav className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600" aria-label="Pagination">
      <div className="flex items-center gap-3">
        <span className="tabular-nums">
          Showing <strong>{from}</strong>–<strong>{to}</strong> of <strong>{total}</strong> {label}
        </span>
        <label className="flex items-center gap-1.5">
          Rows per page
          <select
            value={pageSize}
            onChange={(e) => {
              onPageSize(Number(e.target.value));
              onPage(1);
            }}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs focus:border-brand-500 focus:outline-none"
            aria-label="Rows per page"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex items-center gap-1">
        <button className={btn} onClick={() => onPage(1)} disabled={page <= 1} aria-label="First page">
          <ChevronsLeft className="h-4 w-4" />
        </button>
        <button className={btn} onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page">
          <ChevronLeft className="h-4 w-4" />
        </button>
        {pageList(page, pages).map((p, i) =>
          p === "…" ? (
            <span key={`e${i}`} className="px-1 text-slate-400">
              …
            </span>
          ) : (
            <button key={p} className={p === page ? btnActive : btn} onClick={() => onPage(p)} aria-current={p === page ? "page" : undefined} aria-label={`Page ${p}`}>
              {p}
            </button>
          ),
        )}
        <button className={btn} onClick={() => onPage(page + 1)} disabled={page >= pages} aria-label="Next page">
          <ChevronRight className="h-4 w-4" />
        </button>
        <button className={btn} onClick={() => onPage(pages)} disabled={page >= pages} aria-label="Last page">
          <ChevronsRight className="h-4 w-4" />
        </button>
      </div>
    </nav>
  );
}
