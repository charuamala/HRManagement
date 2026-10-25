/**
 * Driver-agnostic data-access contract. The filter language is a strict subset
 * of MongoDB's query syntax so the MongoDB driver can pass filters through unchanged.
 */
export type Primitive = string | number | boolean | null;

export interface FieldOps {
  $eq?: unknown;
  $ne?: unknown;
  $in?: unknown[];
  $nin?: unknown[];
  $gt?: unknown;
  $gte?: unknown;
  $lt?: unknown;
  $lte?: unknown;
  $exists?: boolean;
  $regex?: string;
  $options?: string;
}

export type Filter<T> = {
  [K in keyof T]?: T[K] | FieldOps;
} & {
  $or?: Filter<T>[];
  $and?: Filter<T>[];
};

export interface FindOptions<T> {
  sort?: Partial<Record<keyof T & string, 1 | -1>>;
  skip?: number;
  limit?: number;
}

export interface Collection<T extends { id: string }> {
  find(filter?: Filter<T>, options?: FindOptions<T>): Promise<T[]>;
  findOne(filter: Filter<T>): Promise<T | null>;
  findById(id: string): Promise<T | null>;
  count(filter?: Filter<T>): Promise<number>;
  insertOne(doc: T): Promise<T>;
  insertMany(docs: T[]): Promise<T[]>;
  /** `$set` semantics — the given fields are merged into the matching document. */
  updateById(id: string, set: Partial<T>): Promise<T | null>;
  updateMany(filter: Filter<T>, set: Partial<T>): Promise<number>;
  deleteById(id: string): Promise<boolean>;
  deleteMany(filter: Filter<T>): Promise<number>;
}

export class DuplicateKeyError extends Error {
  constructor(
    public collection: string,
    public fields: string[],
  ) {
    super(`Duplicate value for ${collection}(${fields.join(", ")})`);
    this.name = "DuplicateKeyError";
  }
}
