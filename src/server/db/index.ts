import path from "path";
import type { CollectionName, DocMap } from "./schema";
import type { Collection } from "./types";

export interface Database {
  readonly driver: "json" | "mongo";
  collection<K extends CollectionName>(name: K): Collection<DocMap[K]>;
  /** Run `fn` atomically: all writes commit together or none do. Nested calls join the outer one. */
  transaction<R>(fn: () => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

type Holder = { db?: Database; pending?: Promise<Database> };
const g = globalThis as unknown as { __hrDb?: Holder };
const holder: Holder = (g.__hrDb ??= {});

async function createDefault(): Promise<Database> {
  const driver = (process.env.DB_DRIVER ?? "json").toLowerCase();
  if (driver === "mongo") {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("DB_DRIVER=mongo requires MONGODB_URI");
    const { MongoDatabase } = await import("./mongo-driver");
    return MongoDatabase.connect(uri, process.env.MONGODB_DB ?? "hr_attendance");
  }
  const { JsonDatabase } = await import("./json-driver");
  return new JsonDatabase(path.resolve(process.env.DATA_DIR ?? "./data"));
}

export async function getDb(): Promise<Database> {
  if (holder.db) return holder.db;
  holder.pending ??= createDefault().then((db) => (holder.db = db));
  return holder.pending;
}

/** Replace the active database (tests, scripts). */
export function setDb(db: Database | undefined) {
  holder.db = db;
  holder.pending = undefined;
}

/** Shorthand: typed collection accessor. */
export async function col<K extends CollectionName>(name: K): Promise<Collection<DocMap[K]>> {
  return (await getDb()).collection(name);
}

export async function transaction<R>(fn: () => Promise<R>): Promise<R> {
  return (await getDb()).transaction(fn);
}

export type { CollectionName, DocMap } from "./schema";
export { DuplicateKeyError } from "./types";
