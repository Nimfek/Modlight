/**
 * Persisting an avatar: limiter, encoder, storage, row, and the orphan cleanup.
 *
 * Shared by the two entry points that can set one - the raw-body route handler
 * (a file from the user's disk) and the server action (one of their own
 * uploads). Both do exactly the same thing once they hold bytes, and a second
 * copy of "write the object, then swap the column, then delete the old object"
 * is how one of them ends up leaking files or, worse, deleting the live one.
 */

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { user as users } from "@/lib/db/schema";
import { getStorage } from "@/lib/storage";
import { avatarKey, avatarUrl, isAvatarKey } from "@/lib/avatar";
import { encodeAvatar, type AvatarDegradation } from "@/lib/media/avatar";
import { THUMBNAIL_TIMEOUT_MS, THUMBNAIL_WEIGHT } from "@/lib/media/transform-cost";
import {
  AbortedError,
  BusyError,
  imageTransforms,
  TimeoutError,
} from "@/lib/media/transform-queue";

/** Everything a caller has to be able to tell the user apart. */
export type AvatarSaveError =
  /** libvips cannot read these bytes, whatever the header claimed. */
  | "decode"
  /** A single frame beyond the decompression-bomb ceiling. */
  | "too-many-pixels"
  /** No transform slot, or the encode outlived its deadline. */
  | "busy"
  /** The caller hung up mid-encode. */
  | "aborted";

export type AvatarSaveResult =
  | { ok: true; url: string | null; bytes: number; animated: boolean; degraded: AvatarDegradation | null }
  | { ok: false; error: AvatarSaveError };

/**
 * Re-encode `input` and make it `userId`'s avatar.
 *
 * Goes through the shared limiter like every other libvips call, at thumbnail
 * weight: this is a 256 px square, not a conversion, and it must not have to
 * queue behind two AVIF encodes for a slot it barely uses. But it is counted,
 * because "expensive media work" is counted in one place or the number of
 * concurrent decodes is not actually bounded by anything.
 */
export async function saveAvatar(
  userId: string,
  input: Buffer,
  opts: { signal?: AbortSignal } = {},
): Promise<AvatarSaveResult> {
  let encoded;
  try {
    encoded = await imageTransforms.run(() => encodeAvatar(input), {
      weight: THUMBNAIL_WEIGHT,
      timeoutMs: THUMBNAIL_TIMEOUT_MS,
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof BusyError || err instanceof TimeoutError) return { ok: false, error: "busy" };
    if (err instanceof AbortedError) return { ok: false, error: "aborted" };
    // Anything libvips throws from inside the encoder is "we cannot read this",
    // which is a fact the user can act on.
    return { ok: false, error: "decode" };
  }

  if (!encoded.ok) return { ok: false, error: encoded.error };

  const storage = getStorage();
  const key = avatarKey(userId, randomBytes(8).toString("hex"));
  await storage.write(key, encoded.bytes);

  // The object exists before the column points at it, so a failure between the
  // two leaves an orphan rather than a 404 on somebody's face.
  const [previous] = await db
    .update(users)
    .set({ image: key })
    .where(eq(users.id, userId))
    .returning({ old: users.image, userCode: users.userCode });

  await discard(previous?.old, key);

  return {
    ok: true,
    url: avatarUrl(previous?.userCode, key),
    bytes: encoded.bytes.byteLength,
    animated: encoded.animated,
    degraded: encoded.degraded,
  };
}

/** Back to initials. */
export async function clearAvatar(userId: string): Promise<void> {
  const [previous] = await db
    .update(users)
    .set({ image: null })
    .where(eq(users.id, userId))
    .returning({ old: users.image });

  await discard(previous?.old, null);
}

/**
 * Delete the object a column used to point at.
 *
 * Never throws: the database is already the source of truth about which avatar
 * is current, so a storage backend that refuses the delete has cost us twenty
 * kilobytes, not correctness - and failing the request would tell the user their
 * change did not happen when it did.
 *
 * `isAvatarKey` is the guard that matters here. `user.image` is Better Auth's
 * own column and could in principle hold a URL from somewhere else; handing that
 * to `storage.delete()` would be asking the driver to interpret a foreign string
 * as a path.
 */
async function discard(oldKey: string | null | undefined, keep: string | null): Promise<void> {
  if (!isAvatarKey(oldKey) || oldKey === keep) return;
  try {
    await getStorage().delete(oldKey);
  } catch {
    /* orphaned bytes, not a failed setting */
  }
}
