/**
 * client.ts — Postgres connection + Drizzle instance.
 *
 * Connection string from DATABASE_URL, e.g.
 *   postgres://user:pass@localhost:5432/upd
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://upd:upd@localhost:5432/upd";

export const pool = new Pool({ connectionString });
export const db = drizzle(pool, { schema });
export { schema };
