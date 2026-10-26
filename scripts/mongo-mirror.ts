/**
 * MongoDB Atlas mirror tool (JSON stays the source of truth).
 *
 *   npm run mirror -- check    test the connection and show document counts
 *   npm run mirror -- sync     make MongoDB identical to the JSON files, then verify counts
 */
import fs from "fs";
import path from "path";
for (const f of [".env.local", ".env"]) if (fs.existsSync(f)) process.loadEnvFile(f);

import { JsonDatabase } from "@/server/db/json-driver";
import { MongoMirror } from "@/server/db/mongo-mirror";
import { COLLECTIONS, type CollectionName } from "@/server/db/schema";

async function main() {
  const cmd = process.argv[2] ?? "check";
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set. Add it to .env.local (see .env.example).");
    process.exit(1);
  }
  const dir = path.resolve(process.env.DATA_DIR ?? "./data");
  const names = Object.keys(COLLECTIONS) as CollectionName[];
  const json = new JsonDatabase(dir);
  const mirror = new MongoMirror(uri, process.env.MONGODB_DB ?? "hr_attendance", dir, () => json.snapshot(names), "mirror-queue-cli");
  try {
    const ping = await mirror.ping();
    console.log(`Connected to ${mirror.status.host} / database "${mirror.status.database}" (${ping.ms} ms)`);
    if (cmd === "sync") {
      mirror.requestFullSync();
      const ok = await mirror.flush(5 * 60_000);
      if (!ok) throw new Error(mirror.status.lastError ?? "Sync did not finish in time");
    } else if (cmd !== "check") {
      throw new Error(`Unknown command "${cmd}" (use check or sync)`);
    }
    const remote = await mirror.remoteCounts();
    const local = json.snapshot(names);
    let mismatches = 0;
    console.log("\nCollection                      JSON   MongoDB");
    for (const n of names) {
      const a = local.get(n)?.length ?? 0;
      const b = remote[n] ?? 0;
      if (a !== b) mismatches++;
      if (a || b) console.log(`${n.padEnd(30)} ${String(a).padStart(5)} ${String(b).padStart(8)}${a !== b ? "  ← differs" : ""}`);
    }
    console.log(mismatches ? `\n${mismatches} collection(s) differ — run: npm run mirror -- sync` : "\nMongoDB matches the JSON files ✓");
  } finally {
    await mirror.close();
  }
}

main().catch((e) => {
  console.error("Mirror error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
