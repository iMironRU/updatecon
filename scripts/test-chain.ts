import { findChain } from "../src/db/chain.js";
import { pool } from "../src/db/client.js";

const r = await findChain("БухгалтерияПредприятия", "3.0.177.30", "3.0.197.22");
console.log(JSON.stringify(r, null, 2));
await pool.end();
