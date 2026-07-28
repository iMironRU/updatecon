import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./client.js";

const here = dirname(fileURLToPath(import.meta.url));

export async function migrateDatabase(): Promise<void> {
  await migrate(db, {
    migrationsFolder: join(here, "../../drizzle"),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrateDatabase()
    .then(() => console.log("[migrate] database is ready"))
    .finally(() => pool.end());
}
