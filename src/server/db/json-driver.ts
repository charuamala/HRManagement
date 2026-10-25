import fs from "fs";
import path from "path";
import { AsyncLocalStorage } from "async_hooks";
import { COLLECTIONS, type CollectionName, type DocMap, type IndexDef } from "./schema";
import { applyOptions, matches } from "./query";
import { DuplicateKeyError, type Collection, type Filter, type FindOptions } from "./types";
import type { Database } from "./index";

/**
 * File-backed document store: one JSON file per collection under DATA_DIR.
 *
 *  - Writes are atomic (write temp file, then rename).
 *  - All mutations are serialised through a process-wide mutex.
 *  - transaction() buffers writes and snapshots touched collections, so a failure
 *    rolls every touched collection back and nothing partial reaches disk.
 *  - Files changed by another process (e.g. the seed script) are reloaded on next access.
 */

type AnyDoc = { id: string } & Record<string, unknown>;

interface TableState {
  docs: Map<string, AnyDoc>;
  mtimeMs: number;
}

interface TxState {
  snapshots: Map<CollectionName, Map<string, AnyDoc>>;
  dirty: Set<CollectionName>;
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<R>(fn: () => Promise<R> | R): Promise<R> {
    const result = this.tail.then(() => fn());
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const clone = <T>(v: T): T => structuredClone(v);

export class JsonDatabase implements Database {
  readonly driver = "json" as const;
  private tables = new Map<CollectionName, TableState>();
  private mutex = new Mutex();
  private tx = new AsyncLocalStorage<TxState>();

  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private file(name: CollectionName) {
    return path.join(this.dir, `${name}.json`);
  }

  private table(name: CollectionName): TableState {
    const file = this.file(name);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    const cached = this.tables.get(name);
    // Reload if another process rewrote the file — unless we're mid-transaction on it.
    if (cached && (cached.mtimeMs === mtimeMs || this.tx.getStore()?.dirty.has(name))) return cached;
    const docs = new Map<string, AnyDoc>();
    if (mtimeMs) {
      const raw = fs.readFileSync(file, "utf8");
      const arr = raw.trim() ? (JSON.parse(raw) as AnyDoc[]) : [];
      for (const d of arr) docs.set(d.id, d);
    }
    const state = { docs, mtimeMs };
    this.tables.set(name, state);
    return state;
  }

  private persist(name: CollectionName) {
    const state = this.tables.get(name);
    if (!state) return;
    const file = this.file(name);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...state.docs.values()], null, 1));
    fs.renameSync(tmp, file);
    state.mtimeMs = fs.statSync(file).mtimeMs;
  }

  /** Run a mutation: inside a transaction it's buffered, otherwise it's locked and flushed. */
  private async mutate<R>(name: CollectionName, fn: (docs: Map<string, AnyDoc>) => R): Promise<R> {
    const tx = this.tx.getStore();
    if (tx) {
      const state = this.table(name);
      if (!tx.snapshots.has(name)) tx.snapshots.set(name, new Map(state.docs));
      tx.dirty.add(name);
      return fn(state.docs);
    }
    return this.mutex.run(() => {
      const state = this.table(name);
      const before = new Map(state.docs);
      try {
        const r = fn(state.docs);
        this.persist(name);
        return r;
      } catch (e) {
        state.docs = before;
        throw e;
      }
    });
  }

  async transaction<R>(fn: () => Promise<R>): Promise<R> {
    if (this.tx.getStore()) return fn(); // nested → join outer transaction
    return this.mutex.run(async () => {
      const state: TxState = { snapshots: new Map(), dirty: new Set() };
      try {
        const result = await this.tx.run(state, fn);
        for (const name of state.dirty) this.persist(name);
        return result;
      } catch (e) {
        for (const [name, snap] of state.snapshots) {
          const t = this.tables.get(name);
          if (t) t.docs = snap;
        }
        throw e;
      }
    });
  }

  collection<K extends CollectionName>(name: K): Collection<DocMap[K]> {
    return new JsonCollection<DocMap[K]>(this, name) as unknown as Collection<DocMap[K]>;
  }

  /** @internal */
  _read(name: CollectionName) {
    return this.table(name).docs;
  }
  /** @internal */
  _mutate<R>(name: CollectionName, fn: (docs: Map<string, AnyDoc>) => R) {
    return this.mutate(name, fn);
  }

  async close() {
    this.tables.clear();
  }
}

function indexKey(doc: AnyDoc, idx: IndexDef): string | null {
  if (idx.partial && !matches(doc, idx.partial as Filter<AnyDoc>)) return null;
  const vals = idx.fields.map((f) => doc[f]);
  if (idx.sparse && vals.some((v) => v === null || v === undefined)) return null;
  return JSON.stringify(vals);
}

function checkUnique(name: CollectionName, docs: Map<string, AnyDoc>, candidate: AnyDoc) {
  for (const idx of COLLECTIONS[name].indexes) {
    if (!idx.unique) continue;
    const key = indexKey(candidate, idx);
    if (key === null) continue;
    for (const other of docs.values()) {
      if (other.id === candidate.id) continue;
      if (indexKey(other, idx) === key) throw new DuplicateKeyError(name, idx.fields);
    }
  }
}

class JsonCollection<T extends { id: string }> implements Collection<T> {
  constructor(
    private db: JsonDatabase,
    private name: CollectionName,
  ) {}

  private get appendOnly() {
    return COLLECTIONS[this.name].appendOnly === true;
  }

  async find(filter?: Filter<T>, options?: FindOptions<T>): Promise<T[]> {
    const out: T[] = [];
    for (const d of this.db._read(this.name).values()) {
      if (matches(d as unknown as T, filter)) out.push(d as unknown as T);
    }
    return applyOptions(out, options).map(clone);
  }

  async findOne(filter: Filter<T>): Promise<T | null> {
    for (const d of this.db._read(this.name).values()) {
      if (matches(d as unknown as T, filter)) return clone(d as unknown as T);
    }
    return null;
  }

  async findById(id: string): Promise<T | null> {
    const d = this.db._read(this.name).get(id);
    return d ? clone(d as unknown as T) : null;
  }

  async count(filter?: Filter<T>): Promise<number> {
    if (!filter) return this.db._read(this.name).size;
    let n = 0;
    for (const d of this.db._read(this.name).values()) if (matches(d as unknown as T, filter)) n++;
    return n;
  }

  async insertOne(doc: T): Promise<T> {
    const [r] = await this.insertMany([doc]);
    return r;
  }

  async insertMany(docs: T[]): Promise<T[]> {
    return this.db._mutate(this.name, (map) => {
      const added: string[] = [];
      try {
        for (const doc of docs) {
          const d = clone(doc) as unknown as AnyDoc;
          if (!d.id) throw new Error(`${this.name}: document without id`);
          if (map.has(d.id)) throw new DuplicateKeyError(this.name, ["id"]);
          checkUnique(this.name, map, d);
          map.set(d.id, d);
          added.push(d.id);
        }
      } catch (e) {
        for (const id of added) map.delete(id);
        throw e;
      }
      return docs.map(clone);
    });
  }

  async updateById(id: string, set: Partial<T>): Promise<T | null> {
    if (this.appendOnly) throw new Error(`${this.name} is append-only`);
    return this.db._mutate(this.name, (map) => {
      const cur = map.get(id);
      if (!cur) return null;
      const next = { ...cur, ...clone(set), id } as AnyDoc;
      checkUnique(this.name, map, next);
      map.set(id, next);
      return clone(next) as unknown as T;
    });
  }

  async updateMany(filter: Filter<T>, set: Partial<T>): Promise<number> {
    if (this.appendOnly) throw new Error(`${this.name} is append-only`);
    return this.db._mutate(this.name, (map) => {
      const changed: [string, AnyDoc][] = [];
      for (const [id, d] of map) {
        if (matches(d as unknown as T, filter)) changed.push([id, d]);
      }
      try {
        for (const [id, d] of changed) {
          const next = { ...d, ...clone(set), id } as AnyDoc;
          checkUnique(this.name, map, next);
          map.set(id, next);
        }
      } catch (e) {
        for (const [id, d] of changed) map.set(id, d);
        throw e;
      }
      return changed.length;
    });
  }

  async deleteById(id: string): Promise<boolean> {
    if (this.appendOnly) throw new Error(`${this.name} is append-only`);
    return this.db._mutate(this.name, (map) => map.delete(id));
  }

  async deleteMany(filter: Filter<T>): Promise<number> {
    if (this.appendOnly) throw new Error(`${this.name} is append-only`);
    return this.db._mutate(this.name, (map) => {
      let n = 0;
      for (const [id, d] of map) {
        if (matches(d as unknown as T, filter)) {
          map.delete(id);
          n++;
        }
      }
      return n;
    });
  }
}
