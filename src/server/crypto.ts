import crypto from "crypto";
import fs from "fs";
import path from "path";

/**
 * Field-level encryption for sensitive identifiers (Aadhaar). AES-256-GCM with a
 * key from DATA_ENCRYPTION_KEY (base64, 32 bytes). In development, if the variable
 * is unset, a key is generated once and kept in DATA_DIR/.encryption-key (gitignored).
 * The same key must be carried over when migrating to MongoDB, or values can't be read.
 */
let cached: Buffer | null = null;

function key(): Buffer {
  if (cached) return cached;
  const env = process.env.DATA_ENCRYPTION_KEY;
  if (env) {
    const k = Buffer.from(env, "base64");
    if (k.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
    return (cached = k);
  }
  if (process.env.NODE_ENV === "production" && process.env.DB_DRIVER === "mongo") {
    throw new Error("DATA_ENCRYPTION_KEY is required in production");
  }
  const file = path.join(path.resolve(process.env.DATA_DIR ?? "./data"), ".encryption-key");
  if (fs.existsSync(file)) return (cached = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const k = crypto.randomBytes(32);
  fs.writeFileSync(file, k.toString("base64"), { mode: 0o600 });
  console.warn(`[crypto] Generated a development encryption key at ${file}. Set DATA_ENCRYPTION_KEY for production.`);
  return (cached = k);
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

export function decrypt(blob: string): string {
  const [v, iv, tag, ct] = blob.split(":");
  if (v !== "v1") throw new Error("Unknown ciphertext version");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

/** Keyed hash for uniqueness checks without storing the value in clear. */
export function blindIndex(value: string): string {
  return crypto.createHmac("sha256", key()).update(`idx:${value}`).digest("hex");
}
