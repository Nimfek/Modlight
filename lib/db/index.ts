import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "@/lib/config";
import * as schema from "./schema";

// Single pooled client for the long-running Node server. Guard against HMR
// re-instantiation in dev (would otherwise exhaust Postgres connections).
const globalForDb = globalThis as unknown as { __pool?: Pool };

const pool =
  globalForDb.__pool ??
  new Pool({
    connectionString: config.db.url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

if (!config.isProd) globalForDb.__pool = pool;

export const db = drizzle({ client: pool, schema });
export type DB = typeof db;
export { schema };
