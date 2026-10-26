/** Creates base data (roles, permissions, statuses, settings, default shift/template, first admin). */
import fs from "fs";
for (const f of [".env.local", ".env"]) if (fs.existsSync(f)) process.loadEnvFile(f);
// Scripts write the JSON files only; the running server (or `npm run mirror -- sync`) copies changes to MongoDB.
process.env.MONGO_MIRROR = "false";
import { ensureBaseData } from "@/server/bootstrap";

ensureBaseData({ log: (m) => console.log(m) })
  .then(() => console.log("Setup complete."))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
