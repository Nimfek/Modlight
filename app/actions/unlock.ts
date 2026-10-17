"use server";

import { cookies, headers } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { uploads, user as users } from "@/lib/db/schema";
import {
  REMEMBER_TTL,
  checkRateLimit,
  clientIp,
  mintOwnerUnlockToken,
  mintUnlockToken,
  ownerUnlockCookieName,
  resetRateLimit,
  unlockCookieName,
  unlockCookieOptions,
  verifyPassword,
} from "@/lib/password";
import type { UnlockResult } from "@/lib/password";

/** uploads.id is a uuid column; anything else would make Postgres throw. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Verify a media's unlock password (scrypt, see lib/password.ts). On success,
 * drop a signed unlock token in `ml_unlock_{id}` (httpOnly) so subsequent
 * page/raw/download requests are authorized.
 *
 * `remember` is the visitor's answer to the checkbox on the gate, and what it
 * is worth is decided HERE rather than by the client:
 *
 *  - the file carries the owner's CURRENT default password → an owner-scoped
 *    token, so the next file that same person shares opens without a prompt;
 *  - anything else (a password typed for this one file, or a leftover from an
 *    earlier default) → a longer-lived token for this file and nothing more.
 *
 * The distinction is the whole point: a recipient who was let into one file
 * must not thereby be let into a file its owner deliberately gave a different
 * password.
 */
export async function verifyMediaPassword(
  mediaId: string,
  password: string,
  remember = false,
): Promise<UnlockResult> {
  if (!mediaId || !UUID.test(mediaId) || typeof password !== "string" || password.length === 0) {
    return { ok: false };
  }

  const key = `${clientIp(await headers())}|media:${mediaId}`;
  if (!checkRateLimit(key).allowed) return { ok: false, error: "rate-limited" };

  const rows = await db
    .select({
      id: uploads.id,
      passwordHash: uploads.passwordHash,
      ownerId: uploads.ownerId,
      passwordVersion: uploads.passwordVersion,
      ownerVersion: users.defaultPasswordVersion,
      ownerHash: users.defaultPasswordHash,
    })
    .from(uploads)
    .leftJoin(users, eq(users.id, uploads.ownerId))
    .where(eq(uploads.id, mediaId))
    .limit(1);

  const media = rows[0];
  if (!media || !media.passwordHash) return { ok: false };

  if (!(await verifyPassword(password, media.passwordHash))) return { ok: false };

  resetRateLimit(key);
  const jar = await cookies();

  // Is this file on the owner's default password as it stands right now? Only
  // then may the consent travel to their other files.
  const onCurrentDefault =
    !!media.ownerId &&
    !!media.ownerHash &&
    media.passwordVersion != null &&
    media.passwordVersion === media.ownerVersion;

  // Always let the visitor through the file they just unlocked. "Remember"
  // stretches that from a day to a month; it never shortens it.
  jar.set(
    unlockCookieName("media", media.id),
    mintUnlockToken("media", media.id),
    unlockCookieOptions("media", remember ? REMEMBER_TTL : undefined),
  );

  if (remember && onCurrentDefault && media.ownerId) {
    const version = media.passwordVersion as number;
    jar.set(
      ownerUnlockCookieName(media.ownerId),
      mintOwnerUnlockToken(media.ownerId, version),
      unlockCookieOptions("owner"),
    );
    return { ok: true, remembered: "owner" };
  }

  return { ok: true, remembered: remember ? "file" : undefined };
}
