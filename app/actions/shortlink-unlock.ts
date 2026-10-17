"use server";

import { cookies, headers } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { shortLinks } from "@/lib/db/schema";
import {
  checkRateLimit,
  clientIp,
  mintUnlockToken,
  resetRateLimit,
  unlockCookieName,
  unlockCookieOptions,
  verifyPassword,
} from "@/lib/password";
import type { UnlockResult } from "@/lib/password";

/**
 * Verify a short link's gate password (scrypt, see lib/password.ts). On success,
 * drop a signed unlock token in `ml_sl_{id}` (httpOnly) so the /s/{code}
 * redirect passes the gate and forwards to the target.
 */
export async function verifyShortlinkPassword(
  code: string,
  password: string,
): Promise<UnlockResult> {
  if (!code || typeof password !== "string" || password.length === 0) {
    return { ok: false };
  }

  const key = `${clientIp(await headers())}|shortlink:${code}`;
  if (!checkRateLimit(key).allowed) return { ok: false, error: "rate-limited" };

  const rows = await db
    .select({ id: shortLinks.id, passwordHash: shortLinks.passwordHash })
    .from(shortLinks)
    .where(eq(shortLinks.code, code))
    .limit(1);

  const link = rows[0];
  if (!link || !link.passwordHash) return { ok: false };

  if (!(await verifyPassword(password, link.passwordHash))) return { ok: false };

  resetRateLimit(key);
  const jar = await cookies();
  jar.set(
    unlockCookieName("shortlink", link.id),
    mintUnlockToken("shortlink", link.id),
    unlockCookieOptions("shortlink"),
  );

  return { ok: true };
}
