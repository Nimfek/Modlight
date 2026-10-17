import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { user as users } from "@/lib/db/schema";
import { createApiToken, isTokenScope, TOKEN_SCOPES } from "@/lib/api-token";

// Dev helper: mint an API token for a user by email.
//   tsx scripts/mint-token.ts <email> [tokenName] [scope]
//
// The scope has no default here on purpose: a dev helper that quietly mints the
// widest credential in the system is how "just use full" becomes the habit.
const email = process.argv[2];
const name = process.argv[3] ?? "dev";
const scope = process.argv[4];
if (!email || !isTokenScope(scope)) {
  console.error(`usage: tsx scripts/mint-token.ts <email> <name> <${TOKEN_SCOPES.join("|")}>`);
  process.exit(1);
}
const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
if (!rows[0]) {
  console.error(`no user with email ${email}`);
  process.exit(1);
}
const token = await createApiToken(rows[0].id, name, scope);
console.log(token);
process.exit(0);
