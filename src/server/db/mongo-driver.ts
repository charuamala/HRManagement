import { AsyncLocalStorage } from "async_hooks";
import { MongoClient, MongoServerError, type ClientSession, type Db, type Document, type IndexSpecification } from "mongodb";
import { COLLECTIONS, type CollectionName, type DocMap } from "./schema";
import { DuplicateKeyError, type Collection, type Filter, type FindOptions } from "./types";
import type { Database } from "./index";

/**
 * MongoDB driver (works with MongoDB Atlas Free Tier, which is a replica set and
 * therefore supports multi-document transactions). Documents keep their own string
 * `id` (uniquely indexed); Mongo's `_id` is never exposed to the application.
 */
export class MongoDatabase implements Database {
  readonly driver = "mongo" as const;
  private session = new AsyncLocalStorage<ClientSession>();

  private constructor(
    private client: MongoClient,
    private db: Db,
  ) {}

  static async connect(uri: string, dbName: string): Promise<MongoDatabase> {
    const client = new MongoClient(uri, { maxPoolSize: 10 });
    await client.connect();
    const inst = new MongoDatabase(client, client.db(dbName));
    await inst.ensureIndexes();
    return inst;
  }

  async ensureIndexes() {
    for (const [name, def] of Object.entries(COLLECTIONS)) {
      const coll = this.db.collection(name);
      await coll.createIndex({ id: 1 }, { unique: true, name: "id_unique" });
      for (const idx of def.indexes) {
        const spec: IndexSpecification = Object.fromEntries(idx.fields.map((f) => [f, 1]));
        const partial: Document = { ...(idx.partial ?? {}) };
        // Mongo "sparse" still indexes explicit nulls, so express it as a partial index instead.
        if (idx.sparse) for (const f of idx.fields) partial[f] = { $type: "string" };
        await coll.createIndex(spec, {
          unique: idx.unique ?? false,
          ...(Object.keys(partial).length ? { partialFilterExpression: partial } : {}),
        });
      }
    }
  }

  async transaction<R>(fn: () => Promise<R>): Promise<R> {
    if (this.session.getStore()) return fn();
    const session = this.client.startSession();
    try {
      let result!: R;
      await session.withTransaction(async () => {
        result = await this.session.run(session, fn);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  collection<K extends CollectionName>(name: K): Collection<DocMap[K]> {
    return new MongoCollection<DocMap[K]>(this.db, name, () => this.session.getStore());
  }

  async close() {
    await this.client.close();
  }
}

const strip = <T>(doc: Document | null): T | null => {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  void _id;
  return rest as T;
};

function wrapDup(name: string, e: unknown): never {
  if (e instanceof MongoServerError && e.code === 11000) {
    const fields = Object.keys((e.keyPattern as Record<string, unknown>) ?? {});
    throw new DuplicateKeyError(name, fields);
  }
  throw e;
}

class MongoCollection<T extends { id: string }> implements Collection<T> {
  constructor(
    private db: Db,
    private name: CollectionName,
    private session: () => ClientSession | undefined,
  ) {}

  private get coll() {
    return this.db.collection(this.name);
  }
  private opts() {
    const s = this.session();
    return s ? { session: s } : {};
  }
  private guard() {
    if (COLLECTIONS[this.name].appendOnly) throw new Error(`${this.name} is append-only`);
  }

  async find(filter: Filter<T> = {}, options?: FindOptions<T>): Promise<T[]> {
    let cursor = this.coll.find(filter as Document, { ...this.opts(), projection: { _id: 0 } });
    if (options?.sort) cursor = cursor.sort(options.sort as Record<string, 1 | -1>);
    if (options?.skip) cursor = cursor.skip(options.skip);
    if (options?.limit !== undefined) cursor = cursor.limit(options.limit);
    return (await cursor.toArray()) as unknown as T[];
  }

  async findOne(filter: Filter<T>): Promise<T | null> {
    return strip<T>(await this.coll.findOne(filter as Document, { ...this.opts(), projection: { _id: 0 } }));
  }

  async findById(id: string): Promise<T | null> {
    return this.findOne({ id } as Filter<T>);
  }

  async count(filter: Filter<T> = {}): Promise<number> {
    return this.coll.countDocuments(filter as Document, this.opts());
  }

  async insertOne(doc: T): Promise<T> {
    try {
      await this.coll.insertOne({ ...doc } as Document, this.opts());
      return doc;
    } catch (e) {
      wrapDup(this.name, e);
    }
  }

  async insertMany(docs: T[]): Promise<T[]> {
    if (!docs.length) return [];
    try {
      await this.coll.insertMany(docs.map((d) => ({ ...d })) as Document[], { ...this.opts(), ordered: true });
      return docs;
    } catch (e) {
      wrapDup(this.name, e);
    }
  }

  async updateById(id: string, set: Partial<T>): Promise<T | null> {
    this.guard();
    const { id: _ignored, ...rest } = set as Record<string, unknown>;
    void _ignored;
    try {
      const r = await this.coll.findOneAndUpdate({ id }, { $set: rest }, { ...this.opts(), returnDocument: "after", projection: { _id: 0 } });
      return strip<T>(r);
    } catch (e) {
      wrapDup(this.name, e);
    }
  }

  async updateMany(filter: Filter<T>, set: Partial<T>): Promise<number> {
    this.guard();
    try {
      const r = await this.coll.updateMany(filter as Document, { $set: set as Document }, this.opts());
      return r.modifiedCount;
    } catch (e) {
      wrapDup(this.name, e);
    }
  }

  async deleteById(id: string): Promise<boolean> {
    this.guard();
    const r = await this.coll.deleteOne({ id }, this.opts());
    return r.deletedCount > 0;
  }

  async deleteMany(filter: Filter<T>): Promise<number> {
    this.guard();
    const r = await this.coll.deleteMany(filter as Document, this.opts());
    return r.deletedCount;
  }
}
