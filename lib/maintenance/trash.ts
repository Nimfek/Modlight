/**
 * Trash retention.
 *
 * Deleting a file in Modlight is always a soft-delete: the row gets a
 * `deletedAt` stamp and the bytes stay exactly where they were. That is the
 * whole point of the trash — a mis-click must never destroy an upload.
 *
 * Something has to close the loop, though, or the trash grows forever and the
 * owner's quota never comes back. This module is that loop: it permanently
 * removes items that have been sitting in the trash for longer than
 * `TRASH_RETENTION_DAYS`, deletes their bytes from storage, and refunds the
 * owner's used quota.
 *
 * NOTE: deliberately free of `server-only` and of any Next.js import, so the
 * custom Node server (server.ts) can schedule it directly. See the wiring
 * snippet at the bottom of this file.
 */
import { and, asc, eq, inArray, isNotNull, lt, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { uploads, user as users } from "@/lib/db/schema";
import { getStorage } from "@/lib/storage";
import { purgeDerived } from "@/lib/media/derived-cache";

/**
 * How long a trashed item is kept before it is destroyed for good. Surfaced in
 * the UI verbatim ("items in the trash are permanently deleted after 30 days"),
 * so this constant and that copy must stay in step.
 */
export const TRASH_RETENTION_DAYS = 30;

export const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** How often server.ts should run the sweep. */
export const TRASH_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Rows handled per round trip — keeps a huge backlog off the heap. */
const BATCH_SIZE = 200;

/** Hard stop so one invocation can never run away with the database. */
const MAX_BATCHES = 250;

export interface TrashSweepResult {
  /** Rows permanently removed. */
  deleted: number;
  /** Bytes reclaimed (sum of the removed rows' sizes). */
  bytes: number;
  /** Rows left for the next sweep because storage refused to delete them. */
  skipped: number;
}

/** Days remaining before an item is purged; 0 once it is due. */
export function trashDaysLeft(deletedAt: Date | string | null, now: number = Date.now()): number | null {
  if (!deletedAt) return null;
  const stamp = deletedAt instanceof Date ? deletedAt.getTime() : new Date(deletedAt).getTime();
  if (Number.isNaN(stamp)) return null;
  return Math.max(0, Math.ceil((stamp + TRASH_RETENTION_MS - now) / (24 * 60 * 60 * 1000)));
}

/**
 * Permanently delete every trashed upload older than the retention window.
 *
 * Order matters: the storage object goes first, then the row. If the process
 * dies in between we lose a byte-level orphan (recoverable by an orphan sweep)
 * rather than a row pointing at a file that no longer exists.
 *
 * When storage refuses to delete an object — an S3 outage, a read-only mount —
 * the row is *kept* and skipped, so the next sweep tries again instead of us
 * silently forgetting about the bytes.
 */
export async function purgeExpiredTrash(now: Date = new Date()): Promise<TrashSweepResult> {
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_MS);
  const storage = getStorage();

  const skipped = new Set<string>();
  let deleted = 0;
  let bytes = 0;

  for (let round = 0; round < MAX_BATCHES; round++) {
    const conditions = [isNotNull(uploads.deletedAt), lt(uploads.deletedAt, cutoff)];
    if (skipped.size > 0) conditions.push(notInArray(uploads.id, [...skipped]));

    const batch = await db
      .select({
        id: uploads.id,
        ownerId: uploads.ownerId,
        storageKey: uploads.storageKey,
        thumbKey: uploads.thumbKey,
        size: uploads.size,
      })
      .from(uploads)
      .where(and(...conditions))
      .orderBy(asc(uploads.deletedAt))
      .limit(BATCH_SIZE);

    if (batch.length === 0) break;

    const removable: string[] = [];
    /** owner id -> bytes to refund */
    const refunds = new Map<string, number>();

    for (const row of batch) {
      try {
        await storage.delete(row.storageKey);
      } catch (err) {
        // "Already gone" is success as far as we're concerned; anything else
        // means storage is unhappy, so leave the row for the next run.
        if (!isMissingObjectError(err)) {
          skipped.add(row.id);
          continue;
        }
      }
      if (row.thumbKey) {
        try {
          await storage.delete(row.thumbKey);
        } catch {
          // A stale thumbnail is cosmetic — never block reclaiming the row.
        }
      }
      // Cached conversions (derived/{id}/…). Normally already gone — the trash
      // purges them on the way in — but a row trashed before this existed, or by
      // a path that bulk-updated `deleted_at` directly, still has to be covered.
      await purgeDerived(row.id);
      removable.push(row.id);
      const size = Number(row.size) || 0;
      // `ownerId` is null for an orphan (owner deleted, files kept) — there is
      // no quota left to refund, but the bytes still have to be reclaimed.
      if (row.ownerId) refunds.set(row.ownerId, (refunds.get(row.ownerId) ?? 0) + size);
      bytes += size;
    }

    if (removable.length > 0) {
      await db.delete(uploads).where(inArray(uploads.id, removable));
      for (const [ownerId, amount] of refunds) {
        await db
          .update(users)
          .set({ usedQuota: sql`GREATEST(0, ${users.usedQuota} - ${amount})` })
          .where(eq(users.id, ownerId));
      }
      deleted += removable.length;
    }

    // Everything in this batch was skipped — the next query would return the
    // same rows minus the skip list, so keep going only while progress happens.
    if (removable.length === 0 && batch.length < BATCH_SIZE) break;
  }

  return { deleted, bytes, skipped: skipped.size };
}

/** Local ENOENT / S3 NoSuchKey — the object is already gone, which is fine. */
function isMissingObjectError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; name?: string; Code?: string };
  return (
    e.code === "ENOENT" ||
    e.name === "NoSuchKey" ||
    e.name === "NotFound" ||
    e.Code === "NoSuchKey"
  );
}

/* -----------------------------------------------------------------------------
 * Wiring (server.ts — owned by another module, add this next to the tus sweep):
 *
 *   import { purgeExpiredTrash, TRASH_SWEEP_INTERVAL_MS } from "@/lib/maintenance/trash";
 *
 *   const sweepTrash = () => {
 *     purgeExpiredTrash()
 *       .then(({ deleted, bytes }) => {
 *         if (deleted > 0) console.log(`[trash] purged ${deleted} item(s), ${bytes} byte(s)`);
 *       })
 *       .catch((err) => console.error("[trash] purge failed:", err));
 *   };
 *   sweepTrash();                                            // catch up on boot
 *   setInterval(sweepTrash, TRASH_SWEEP_INTERVAL_MS).unref(); // never hold the process open
 * -------------------------------------------------------------------------- */
