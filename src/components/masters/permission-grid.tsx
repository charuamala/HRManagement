"use client";
import { ACTIONS } from "@/lib/permissions";

export interface CatalogModule {
  key: string;
  label: string;
  actions: { action: string; key: string; label: string; note: string | null }[];
}

/** Module × action checkbox matrix used by the Role Master. */
export function PermissionGrid({ catalog, value, onChange }: { catalog: CatalogModule[]; value: string[]; onChange: (keys: string[]) => void }) {
  const set = new Set(value);
  const toggle = (key: string, on: boolean) => {
    const n = new Set(set);
    if (on) n.add(key);
    else n.delete(key);
    onChange([...n]);
  };
  const toggleRow = (m: CatalogModule, on: boolean) => {
    const n = new Set(set);
    for (const a of m.actions) {
      if (on) n.add(a.key);
      else n.delete(a.key);
    }
    onChange([...n]);
  };
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="min-w-full text-xs">
        <thead className="bg-slate-50 text-left text-slate-500">
          <tr>
            <th className="px-2 py-2">Module</th>
            {ACTIONS.map((a) => (
              <th key={a} className="px-2 py-2 text-center capitalize">
                {a}
              </th>
            ))}
            <th className="px-2 py-2 text-center">All</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {catalog.map((m) => {
            const all = m.actions.every((a) => set.has(a.key));
            return (
              <tr key={m.key}>
                <td className="whitespace-nowrap px-2 py-1.5 font-medium text-slate-700">{m.label}</td>
                {ACTIONS.map((a) => {
                  const item = m.actions.find((x) => x.action === a);
                  return (
                    <td key={a} className="px-2 py-1.5 text-center">
                      {item ? (
                        <input type="checkbox" checked={set.has(item.key)} onChange={(e) => toggle(item.key, e.target.checked)} title={item.note ?? `${m.label}: ${item.label}`} aria-label={`${m.label}: ${item.label}`} />
                      ) : (
                        <span className="text-slate-300">·</span>
                      )}
                    </td>
                  );
                })}
                <td className="px-2 py-1.5 text-center">
                  <input type="checkbox" checked={all} onChange={(e) => toggleRow(m, e.target.checked)} aria-label={`All ${m.label} permissions`} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
