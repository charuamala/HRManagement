import { col } from "../db";
import type { AttendanceSettings } from "@/lib/types";
import { DEFAULT_TIMEZONE } from "@/lib/time";
import { nowIso } from "../util";

export const SETTINGS_ID = "org";

export function defaultSettings(): AttendanceSettings {
  const now = nowIso();
  return {
    id: SETTINGS_ID,
    createdAt: now,
    updatedAt: now,
    organizationName: "Acme Corporation",
    attendanceStartDate: null,
    timezone: DEFAULT_TIMEZONE,
    defaultShiftId: null,
    weeklyOffDays: [0],
    graceMinutes: 10,
    fullDayHours: 8,
    halfDayHours: 4,
    attendanceCutoffTime: "13:00",
    finalizationTime: "23:00",
    finalizeNextDay: false,
    missingCheckoutPolicy: "flag",
    correctionWindowDays: 7,
    lockEnabled: true,
    lockAfterDays: 35,
    selfCheckInEnabled: true,
    selfCheckOutEnabled: true,
    allowRepeatCheckout: true,
    fullDayCredit: 1,
    halfDayCredit: 0.5,
    leaveCountsAsPresent: false,
    futureToleranceMinutes: 5,
  };
}

export async function getSettings(): Promise<AttendanceSettings> {
  const c = await col("attendance_settings");
  const s = await c.findById(SETTINGS_ID);
  if (s) return { ...defaultSettings(), ...s };
  return defaultSettings();
}

export async function saveSettings(next: AttendanceSettings): Promise<AttendanceSettings> {
  const c = await col("attendance_settings");
  const existing = await c.findById(SETTINGS_ID);
  const doc = { ...next, id: SETTINGS_ID, updatedAt: nowIso() };
  if (existing) return (await c.updateById(SETTINGS_ID, doc))!;
  return c.insertOne(doc);
}
