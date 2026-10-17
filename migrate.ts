import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

// Applies versioned SQL migrations from ./drizzle. Run as a pre-start step
// (locally `pnpm db:migrate`, in Docker before the server boots) — never from
// within the app request runtime.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const db = drizzle({ client: pool });

await migrate(db, { migrationsFolder: "./drizzle" });

/**
 * Seed the settings an environment variable used to own.
 *
 * `ON CONFLICT DO NOTHING` is what turns the variable into a STARTING VALUE
 * rather than a competing source of truth. A fresh install inherits whatever
 * the operator put in .env; from the first boot onwards the row exists, the
 * admin panel owns it, and changing the variable does nothing. That asymmetry
 * is the point: a toggle that a redeploy can silently overrule is not a toggle.
 */
function bool(v: string | undefined, fallback = false): boolean {
  if (v == null) return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

await pool.query(
  `INSERT INTO settings (key, value) VALUES ('register_enabled', $1)
   ON CONFLICT (key) DO NOTHING`,
  [bool(process.env.REGISTRATION_ENABLED, false) ? "on" : "off"],
);

await pool.end();
console.log("✓ migrations applied");
