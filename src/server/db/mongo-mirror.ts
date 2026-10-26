import fs from "fs";
import path from "path";
import { MongoClient, type AnyBulkWriteOperation, type Db, type Document } from "mongodb";
import { COLLECTIONS, type CollectionName } from "./schema";
import type { ChangeSet } from "./json-driver";

/**
 * One-way, write-behind mirror: JSON files stay the source of truth and every
 * committed change is replayed into MongoDB (e.g. Atlas) in commit order.
 *
 *  - Work items run strictly in order on a single worker, so Mongo never applies an
 *    older state after a newer one.
 *  - The pending queue is persisted to DATA_DIR/.mirror-queue.json, so changes made
 *    while offline (or before a restart) are delivered later.
 *  - A full sync (upsert everything, delete extras) runs at start-up and on demand,
 *    which repairs any drift — Mongo always converges to exactly the JSON contents.
 *  - Failures never affect the application; they only delay the mirror.
 */

type AnyDoc = { id: string } & Record<string, unknown>;
type Snapshot = () => Map<CollectionName, AnyDoc[]>;
type Item = { kind: "changes"; changes: ChangeSet[] } | { kind: "full" };

export interface MirrorStatus {
  enabled: true;
  database: string;
  host: string;
  connected: boolean;
  pending: number;
  lastSyncAt: string | null;
  lastFullSyncAt: string | null;
  lastFullSync: Record<string, { json: number; upserted: number; deleted: number }> | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

const CHUNK = 500;

export class MongoMirror {
  private client: MongoClient;
  private db: Db | null = null;
  private queue: Item[] = [];
  private running = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private backoffMs = 2000;
  private queueFile: string;
  private idIndexed = new Set<string>();
  status: MirrorStatus;

  constructor(
    uri: string,
    private dbName: string,
    dataDir: string,
    private snapshot: Snapshot,
    /** Separate queue files keep the server and CLI tools from overwriting each other's queue. */
    queueName = "mirror-queue",
  ) {
    this.client = new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 10_000 });
    this.queueFile = path.join(dataDir, `.${queueName}.json`);
    let host = "unknown";
    try {
      host = new URL(uri.replace(/^mongodb(\+srv)?:/, "http:")).host;
    } catch {
      /* keep unknown */
    }
    this.status = {
      enabled: true,
      database: dbName,
      host,
      connected: false,
      pending: 0,
      lastSyncAt: null,
      lastFullSyncAt: null,
      lastFullSync: null,
      lastError: null,
      lastErrorAt: null,
    };
    try {
      if (fs.existsSync(this.queueFile)) this.queue = JSON.parse(fs.readFileSync(this.queueFile, "utf8"));
    } catch (e) {
      console.error("[mirror] could not read pending queue; a full sync will repair it", e);
      this.queue = [];
    }
    this.status.pending = this.queue.length;
  }

  /** Queue committed JSON changes for delivery. */
  enqueue(changes: ChangeSet[]) {
    if (!changes.length) return;
    this.queue.push({ kind: "changes", changes });
    this.saveQueue();
    this.kick();
  }

  /** Queue a full reconciliation (runs after everything already queued). */
  requestFullSync() {
    if (!this.queue.some((i) => i.kind === "full")) {
      this.queue.push({ kind: "full" });
      this.saveQueue();
    }
    this.kick();
  }

  /** Wait until the queue is empty (or the timeout passes). Returns true when fully delivered. */
  async flush(timeoutMs = 60_000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    this.kick();
    while (Date.now() < until) {
      if (!this.queue.length && !this.running) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return !this.queue.length;
  }

  async close() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    await this.client.close().catch(() => null);
  }

  private saveQueue() {
    this.status.pending = this.queue.length;
    try {
      const tmp = `${this.queueFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.queue));
      fs.renameSync(tmp, this.queueFile);
    } catch (e) {
      console.error("[mirror] could not persist queue", e);
    }
  }

  private async connection(): Promise<Db> {
    if (this.db) return this.db;
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.status.connected = true;
    return this.db;
  }

  /** Only the `id` index is created here — uniqueness is enforced by the JSON store. */
  private async ensureId(db: Db, name: string) {
    if (this.idIndexed.has(name)) return;
    await db.collection(name).createIndex({ id: 1 }, { unique: true, name: "id_unique" });
    this.idIndexed.add(name);
  }

  private kick() {
    if (this.running || this.retryTimer) return;
    void this.work();
  }

  private async work() {
    this.running = true;
    try {
      while (this.queue.length) {
        const item = this.queue[0];
        if (item.kind === "full") await this.fullSync();
        else await this.apply(item.changes);
        this.queue.shift();
        this.saveQueue();
        this.status.lastSyncAt = new Date().toISOString();
        this.backoffMs = 2000;
      }
      this.status.lastError = null;
    } catch (e) {
      this.status.connected = false;
      this.db = null;
      this.status.lastError = e instanceof Error ? e.message : String(e);
      this.status.lastErrorAt = new Date().toISOString();
      console.error(`[mirror] sync failed (${this.queue.length} pending), retrying in ${Math.round(this.backoffMs / 1000)}s: ${this.status.lastError}`);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.kick();
      }, this.backoffMs);
      this.retryTimer.unref?.();
      this.backoffMs = Math.min(this.backoffMs * 2, 5 * 60_000);
    } finally {
      this.running = false;
    }
  }

  private async apply(changes: ChangeSet[]) {
    const db = await this.connection();
    for (const c of changes) {
      await this.ensureId(db, c.collection);
      const ops: AnyBulkWriteOperation<Document>[] = [
        ...c.upserts.map((d) => ({ replaceOne: { filter: { id: d.id }, replacement: d as Document, upsert: true } })),
        ...c.deletes.map((id) => ({ deleteOne: { filter: { id } } })),
      ];
      for (let i = 0; i < ops.length; i += CHUNK) await db.collection(c.collection).bulkWrite(ops.slice(i, i + CHUNK), { ordered: true });
    }
  }

  /** Make Mongo identical to the JSON store: upsert every document, delete documents that no longer exist. */
  private async fullSync() {
    const db = await this.connection();
    const names = Object.keys(COLLECTIONS) as CollectionName[];
    const snap = this.snapshot(); // taken synchronously → consistent with queue order
    const report: NonNullable<MirrorStatus["lastFullSync"]> = {};
    for (const name of names) {
      await this.ensureId(db, name);
      const docs = snap.get(name) ?? [];
      const coll = db.collection(name);
      let upserted = 0;
      for (let i = 0; i < docs.length; i += CHUNK) {
        const chunk = docs.slice(i, i + CHUNK);
        const r = await coll.bulkWrite(
          chunk.map((d) => ({ replaceOne: { filter: { id: d.id }, replacement: d as Document, upsert: true } })),
          { ordered: false },
        );
        upserted += r.upsertedCount + r.modifiedCount;
      }
      const keep = new Set(docs.map((d) => d.id));
      const remote = await coll.find({}, { projection: { id: 1, _id: 0 } }).toArray();
      const extra = remote.map((d) => d.id as string).filter((id) => !keep.has(id));
      if (extra.length) await coll.deleteMany({ id: { $in: extra } });
      report[name] = { json: docs.length, upserted, deleted: extra.length };
    }
    this.status.lastFullSyncAt = new Date().toISOString();
    this.status.lastFullSync = report;
  }

  /** Per-collection document counts in Mongo (for verification). */
  async remoteCounts(): Promise<Record<string, number>> {
    const db = await this.connection();
    const out: Record<string, number> = {};
    for (const name of Object.keys(COLLECTIONS)) out[name] = await db.collection(name).countDocuments();
    return out;
  }

  async ping(): Promise<{ ok: boolean; ms: number }> {
    const t = Date.now();
    const db = await this.connection();
    await db.command({ ping: 1 });
    return { ok: true, ms: Date.now() - t };
  }
}
