import { col } from "../db";
import type { Employee, ID } from "@/lib/types";

/** Name lookups used to enrich employee-level rows in tables and exports. */
export interface Lookups {
  departments: Map<ID, string>;
  designations: Map<ID, string>;
  locations: Map<ID, string>;
  shifts: Map<ID, string>;
  employees: Map<ID, Employee>;
}

export async function loadLookups(): Promise<Lookups> {
  const [d, g, l, s, e] = await Promise.all([
    (await col("departments")).find(),
    (await col("designations")).find(),
    (await col("office_locations")).find(),
    (await col("shifts")).find(),
    (await col("employees")).find(),
  ]);
  return {
    departments: new Map(d.map((x) => [x.id, x.name])),
    designations: new Map(g.map((x) => [x.id, x.title])),
    locations: new Map(l.map((x) => [x.id, x.name])),
    shifts: new Map(s.map((x) => [x.id, `${x.name} (${x.startTime}–${x.endTime})`])),
    employees: new Map(e.map((x) => [x.id, x])),
  };
}

export const nameOf = (m: Map<ID, string>, id: ID | null | undefined) => (id ? (m.get(id) ?? "—") : "—");
export const empName = (l: Lookups, id: ID | null | undefined) => (id ? (l.employees.get(id)?.fullName ?? "—") : "—");
