import { col, DuplicateKeyError } from "../db";
import type { ID, Notification, NotificationType } from "@/lib/types";
import { stamp } from "../util";

/**
 * Notification dispatch. Phase 1 ships the in-app channel only; additional channels
 * (email, WhatsApp) implement NotificationChannel and are registered in CHANNELS.
 */
export interface NotificationInput {
  type: NotificationType;
  title: string;
  message: string;
  link?: string | null;
  /** Prevents duplicates (e.g. one missing-checkout reminder per employee/day). */
  dedupeKey?: string | null;
}

export interface NotificationChannel {
  name: string;
  deliver(userId: ID, n: NotificationInput): Promise<void>;
}

const inApp: NotificationChannel = {
  name: "in_app",
  async deliver(userId, n) {
    const c = await col("notifications");
    const doc: Notification = {
      ...stamp(),
      userId,
      type: n.type,
      title: n.title,
      message: n.message,
      link: n.link ?? null,
      read: false,
      channel: "in_app",
      dedupeKey: n.dedupeKey ? `${userId}:${n.dedupeKey}` : null,
    };
    try {
      await c.insertOne(doc);
    } catch (e) {
      if (!(e instanceof DuplicateKeyError)) throw e;
    }
  },
};

const CHANNELS: NotificationChannel[] = [inApp];

export async function notify(userIds: (ID | null | undefined)[], n: NotificationInput): Promise<void> {
  const unique = [...new Set(userIds.filter((u): u is ID => !!u))];
  for (const userId of unique) {
    for (const ch of CHANNELS) {
      try {
        await ch.deliver(userId, n);
      } catch (e) {
        // A failing optional channel must never break the business operation.
        console.error(`[notify:${ch.name}]`, e);
      }
    }
  }
}

export async function listNotifications(userId: ID, opts: { unreadOnly?: boolean; limit?: number } = {}) {
  const c = await col("notifications");
  const filter = opts.unreadOnly ? { userId, read: false } : { userId };
  const [items, unread] = await Promise.all([
    c.find(filter, { sort: { createdAt: -1 }, limit: opts.limit ?? 30 }),
    c.count({ userId, read: false }),
  ]);
  return { items, unread };
}

export async function markRead(userId: ID, ids: ID[] | "all") {
  const c = await col("notifications");
  if (ids === "all") return c.updateMany({ userId, read: false }, { read: true });
  return c.updateMany({ userId, id: { $in: ids } }, { read: true });
}
