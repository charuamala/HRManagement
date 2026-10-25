/**
 * Time-zone aware helpers built on Intl (no external dependency).
 * Business dates ("YYYY-MM-DD") and wall-clock times ("HH:mm") are always
 * interpreted in the organisation time zone; instants are stored as UTC ISO strings.
 */
import type { ISODate, TimeOfDay } from "./types";

export const DEFAULT_TIMEZONE = "Asia/Kolkata";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isValidDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function isValidTime(value: string): boolean {
  return TIME_RE.test(value);
}

/** Wall-clock components of an instant in a time zone. */
export function zonedParts(instant: Date | string, tz: string) {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  const parts: Record<string, string> = {};
  for (const p of partsFormatter(tz).formatToParts(d)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Offset (minutes) of `tz` from UTC at the given instant. Asia/Kolkata → +330. */
export function tzOffsetMinutes(instant: Date, tz: string): number {
  const p = zonedParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

/** Convert a wall-clock date + time in `tz` into a UTC Date. Handles DST transitions. */
export function zonedToUtc(date: ISODate, time: TimeOfDay, tz: string): Date {
  const dm = DATE_RE.exec(date);
  const tm = TIME_RE.exec(time);
  if (!dm || !tm) throw new Error(`Invalid date/time: ${date} ${time}`);
  const guess = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2]), Number(tm[3] ?? 0));
  const off1 = tzOffsetMinutes(new Date(guess), tz);
  let result = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(new Date(result), tz);
  if (off2 !== off1) result = guess - off2 * 60000;
  return new Date(result);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Business date ("YYYY-MM-DD") of an instant in `tz`. */
export function dateInTz(instant: Date | string, tz: string): ISODate {
  const p = zonedParts(instant, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Wall-clock time ("HH:mm") of an instant in `tz`. */
export function timeInTz(instant: Date | string, tz: string): TimeOfDay {
  const p = zonedParts(instant, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export function todayInTz(tz: string, now: Date = new Date()): ISODate {
  return dateInTz(now, tz);
}

/* ------------------------- Pure date arithmetic ------------------------- */

function toUtcDate(date: ISODate): Date {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function fromUtcDate(d: Date): ISODate {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function addDays(date: ISODate, days: number): ISODate {
  const d = toUtcDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtcDate(d);
}

/** 0 = Sunday … 6 = Saturday */
export function dayOfWeek(date: ISODate): number {
  return toUtcDate(date).getUTCDay();
}

export function diffDays(from: ISODate, to: ISODate): number {
  return Math.round((toUtcDate(to).getTime() - toUtcDate(from).getTime()) / 86400000);
}

export function eachDay(from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  if (from > to) return out;
  let cur = from;
  while (cur <= to) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function monthRange(year: number, month: number): { from: ISODate; to: ISODate } {
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(daysInMonth(year, month))}` };
}

export function yearRange(year: number): { from: ISODate; to: ISODate } {
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

export function minutesBetween(a: string | Date, b: string | Date): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
}

export function timeToMinutes(t: TimeOfDay): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export function formatMinutes(mins: number): string {
  if (!mins || mins <= 0) return "0h 00m";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${pad(m)}m`;
}

export function formatHours(mins: number): string {
  return (Math.round((mins / 60) * 100) / 100).toFixed(2);
}

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function formatDisplayDate(date: ISODate): string {
  if (!isValidDate(date)) return date;
  const d = toUtcDate(date);
  return `${pad(d.getUTCDate())} ${MONTH_NAMES[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}`;
}

/** Named reporting periods relative to `today`. Weeks start on Monday. */
export type PeriodPreset =
  | "today"
  | "yesterday"
  | "this_week"
  | "last_week"
  | "this_month"
  | "last_month"
  | "this_year"
  | "custom";

export function presetRange(preset: PeriodPreset, today: ISODate): { from: ISODate; to: ISODate } {
  const [y, m] = today.split("-").map(Number);
  const dow = (dayOfWeek(today) + 6) % 7; // Monday = 0
  switch (preset) {
    case "yesterday": {
      const d = addDays(today, -1);
      return { from: d, to: d };
    }
    case "this_week":
      return { from: addDays(today, -dow), to: addDays(today, 6 - dow) };
    case "last_week":
      return { from: addDays(today, -dow - 7), to: addDays(today, -dow - 1) };
    case "this_month":
      return monthRange(y, m);
    case "last_month":
      return m === 1 ? monthRange(y - 1, 12) : monthRange(y, m - 1);
    case "this_year":
      return yearRange(y);
    case "today":
    case "custom":
    default:
      return { from: today, to: today };
  }
}
