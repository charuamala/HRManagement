/** Creates base data (roles, permissions, statuses, settings, default shift/template, first admin). */
import fs from "fs";
for (const f of [".env.local", ".env"]) if (fs.existsSync(f)) process.loadEnvFile(f);
import { ensureBaseData } from "@/server/bootstrap";

ensureBaseData({ log: (m) => console.log(m) })
  .then(() => console.log("Setup complete."))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
