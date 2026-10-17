import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { db } from "@/lib/db";
import { account } from "@/lib/db/schema";

/**
 * Set the password on an account's credential login, creating that login if it
 * does not exist.
 *
 * The fallback is not theoretical: accounts imported from elsewhere without a
 * usable password hash (LDAP logins, or rows where the hash was missing) have no
 * `account` row at all, and Better Auth's own `setUserPassword` updates zero
 * rows for them and reports success. An admin would set a password, be told it
 * worked, and the user still could not sign in.
 *
 * Hashing goes through the same function `lib/auth.ts` installs as
 * `emailAndPassword.password.hash`, so what lands here is byte-for-byte what a
 * self-service password change would write.
 *
 * Lives in lib/ rather than beside its first caller because both the admin
 * panel and the invitation flow need it, and a `"use server"` module may only
 * export server actions.
 */
export async function writeCredentialPassword(userId: string, password: string): Promise<void> {
  const hash = await hashPassword(password);

  const updated = await db
    .update(account)
    .set({ password: hash })
    .where(and(eq(account.userId, userId), eq(account.providerId, "credential")))
    .returning({ id: account.id });
  if (updated.length > 0) return;

  const now = new Date();
  await db.insert(account).values({
    id: randomUUID(),
    accountId: userId, // Better Auth keys credential accounts by user id
    providerId: "credential",
    userId,
    password: hash,
    createdAt: now,
    updatedAt: now,
  });
}
