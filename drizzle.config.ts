import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  // Directory: picks up both auth-schema.ts (Better Auth) and app-schema.ts.
  schema: "./lib/db/schema",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://modlight:modlight@localhost:5432/modlight",
  },
});
