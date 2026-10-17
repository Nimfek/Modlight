/**
 * Cache for files we DERIVE from an upload (today: format conversions).
 *
 * `/convert` is public for every published file, uncached, and costs seconds of
 * CPU per call. Without a cache the cheapest denial of service against this
 * deployment is a `for` loop over one link, and every honest second click pays
 * full price too.
 *
 * Four properties, and each one is a rule the rest of the app already relies on:
 *
 *  1. CONTENT-ADDRESSED. The key carries a sha256 of the source bytes plus a
 *     variant tag naming the target AND the encoder settings, so changing a
 *     quality knob invalidates every entry that used the old one instead of
 *     serving yesterday's output forever.
 *
 *  2. OUTSIDE THE QUOTA. Derived objects live under `derived/`, never under a
 *     user's tag. Quota is `users.used_quota`, maintained from `uploads.size` on
 *     insert and delete, so nothing here can touch it - and the admin's stray
 *     file scan skips the prefix (lib/data/admin.ts) rather than reporting every
 *     cache entry as garbage.
 *
 *  3. CLEANED UP WITH THE SOURCE. One prefix per upload id, one `deletePrefix`
 *     on delete, on trash, and on the retention purge. The caller never has to
 *     know which variants were ever produced.
 *
 *  4. NEVER FOR A RESTRICTED FILE. A password, an expiry, a view cap or an
 *     unpublished flag means the bytes are gated, and a cache entry is a copy
 *     that outlives the gate. Those files are simply not cached - which also
 *     makes rule 3 exact, because there is no cached artefact left behind by an
 *     expiry that deletes nothing.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import { getStorage } from "@/lib/storage";

/** Everything derived lives under this one prefix. Never a user tag. */
export const DERIVED_PREFIX = "derived";

/**
 * Bumped when the meaning of a cached object changes for reasons the variant tag
 * cannot express (a bug fix in the pipeline, say). Cheaper than a migration:
 * old entries stop being addressed and go away with their source.
 */
const CACHE_EPOCH = "1";

/** Everything cached for one upload. Handed straight to `deletePrefix`. */
export function derivedPrefixFor(uploadId: string): string {
  return `${DERIVED_PREFIX}/${uploadId}/`;
}

/**
 * Where one derived artefact lives.
 *
 * `contentHash` addresses the source bytes; `variant` addresses what was done to
 * them. Two uploads with identical bytes still get separate copies, on purpose:
 * sharing them would mean one user's delete could pull the file out from under
 * another's, and disk is cheaper than that class of bug.
 */
export function derivedKey(
  uploadId: string,
  contentHash: string,
  variant: string,
  ext: string,
): string {
  return `${derivedPrefixFor(uploadId)}${contentHash}.${CACHE_EPOCH}.${variant}.${ext}`;
}

/** sha256 of the bytes, hex. The content half of the address. */
export function contentHash(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Cached bytes, or null on a miss (or on any storage trouble - a miss is safe). */
export async function readDerived(key: string): Promise<Buffer | null> {
  try {
    return await getStorage().readBuffer(key);
  } catch {
    return null;
  }
}

/** Best effort: a cache that cannot be written is still a working conversion. */
export async function writeDerived(key: string, body: Buffer): Promise<void> {
  try {
    await getStorage().write(key, body);
  } catch {
    /* ignore */
  }
}

/**
 * Cache a derived file that lives on local disk, without loading it.
 *
 * The image path can afford `writeDerived(key, buffer)` because its outputs are
 * bounded by a 32 MB input ceiling. A remux is the same size as its source - up
 * to 512 MB - so the video path has to hand storage a STREAM. Best effort, like
 * its buffer sibling: a cache that could not be written is still a working
 * conversion, just a slower second one.
 */
export async function writeDerivedFile(key: string, localPath: string): Promise<void> {
  try {
    await getStorage().write(key, createReadStream(localPath));
  } catch {
    /* ignore */
  }
}

/**
 * A cached object as a stream plus its size, or null on a miss.
 *
 * Size comes first and separately because the response needs a Content-Length:
 * a download with no length shows no progress bar, which for a file that took
 * real work to produce is the one place progress matters.
 */
export async function readDerivedStream(
  key: string,
): Promise<{ stream: Readable; size: number } | null> {
  try {
    const storage = getStorage();
    const info = await storage.stat(key);
    if (!info || info.size <= 0) return null;
    return { stream: await storage.readStream(key), size: info.size };
  } catch {
    return null;
  }
}

/** Drop everything derived from one upload. Safe to call for an id that has none. */
export async function purgeDerived(uploadId: string): Promise<void> {
  try {
    await getStorage().deletePrefix(derivedPrefixFor(uploadId));
  } catch {
    /* a cache we failed to clear is dead weight, never a failed delete */
  }
}

export interface CacheableMedia {
  published: boolean;
  passwordHash: string | null;
  expiresAt: Date | null;
  maxViews: number | null;
}

/**
 * May a derived copy of this file be kept on disk?
 *
 * The same predicate `cacheHeadersFor` uses to decide whether a response may
 * enter a shared cache, and for the same reason: a derived object is a shared
 * cache we host ourselves.
 */
export function mayCacheDerived(media: CacheableMedia): boolean {
  return (
    media.published && !media.passwordHash && !media.expiresAt && media.maxViews == null
  );
}
