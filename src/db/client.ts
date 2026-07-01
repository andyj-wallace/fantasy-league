import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const db = drizzle(pool, { schema });

/** Drizzle database client or an active transaction — pass as an optional param to repository
 * functions so they can participate in a caller-owned transaction without nesting. */
export type DbOrTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
