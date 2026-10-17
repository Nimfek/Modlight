import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { uploads, user as users } from "@/lib/db/schema";
import { getStorage } from "@/lib/storage";
import { purgeDerived } from "@/lib/media/derived-cache";
import type { MediaRow } from "@/lib/media/serve";

/**
 * The columns a permanent delete actually needs. Declared structurally so
 * callers can hand over a narrow `select()` of ten thousand rows instead of
 * pulling every column (blurhash, password hash…) into memory to throw away.
 */
export type DeletableMedia = Pick<
  MediaRow,
  "id" | "ownerId" | "size" | "storageKey" | "thumbKey"
>;

export interface BulkDeleteResult {
  /** Rows removed from the database. */
  deleted: number;
  /** Bytes reclaimed (sum of the removed rows' sizes). */
  bytes: number;
  /** Rows left alone because storage refused to give up their object. */
  failed: number;
}

/**
 * How many storage objects we delete at once.
 *
 * Purging an account can mean thousands of unlinks; doing them strictly one at
 * a time makes the admin stare at a spinner for minutes, and doing them all at
 * once opens thousands of file descriptors (or S3 sockets) inside a 2 GiB
 * container. Sixteen is the boring middle.
 */
const STORAGE_CONCURRENCY = 16;

/** Rows deleted per DELETE statement — keeps the parameter list sane. */
const ROW_BATCH = 500;

/** Local ENOENT / S3 NoSuchKey: the object is already gone, which is success. */
function isMissingObjectError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; name?: string; Code?: string };
  return (
    e.code === "ENOENT" || e.name === "NoSuchKey" || e.name === "NotFound" || e.Code === "NoSuchKey"
  );
}

/**
 * Permanently delete a batch of media: bytes first, then rows, then quota.
 *
 * Order matters. Deleting the object before the row means a crash in between
 * leaves a row pointing at nothing (visible, fixable) rather than bytes nobody
 * remembers (invisible, billable). When storage refuses — an S3 outage, a
 * read-only mount — the row is KEPT and counted in `failed`, so a retry finds
 * it again instead of us quietly forgetting the disk space.
 *
 * Quota refunds are grouped per owner and skip orphans: a file whose account was
 * deleted has no counter to credit.
 */
export async function deleteMediaBulk(rows: DeletableMedia[]): Promise<BulkDeleteResult> {
  if (rows.length === 0) return { deleted: 0, bytes: 0, failed: 0 };

  const storage = getStorage();
  const removable: string[] = [];
  /** owner id -> bytes to refund */
  const refunds = new Map<string, number>();
  let bytes = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += STORAGE_CONCURRENCY) {
    const slice = rows.slice(i, i + STORAGE_CONCURRENCY);
    const outcomes = await Promise.all(
      slice.map(async (row) => {
        try {
          await storage.delete(row.storageKey);
        } catch (err) {
          if (!isMissingObjectError(err)) return false;
        }
        if (row.thumbKey) {
          // A stale thumbnail is cosmetic — never block reclaiming the row.
          await storage.delete(row.thumbKey).catch(() => {});
        }
        // Cached conversions live under derived/{id}/ and belong to this file.
        await purgeDerived(row.id);
        return true;
      }),
    );

    outcomes.forEach((ok, n) => {
      const row = slice[n];
      if (!ok) {
        failed++;
        return;
      }
      removable.push(row.id);
      const size = Number(row.size) || 0;
      bytes += size;
      if (row.ownerId) refunds.set(row.ownerId, (refunds.get(row.ownerId) ?? 0) + size);
    });
  }

  for (let i = 0; i < removable.length; i += ROW_BATCH) {
    await db.delete(uploads).where(inArray(uploads.id, removable.slice(i, i + ROW_BATCH)));
  }

  for (const [ownerId, amount] of refunds) {
    await db
      .update(users)
      .set({ usedQuota: sql`GREATEST(0, ${users.usedQuota} - ${amount})` })
      .where(eq(users.id, ownerId));
  }

  return { deleted: removable.length, bytes, failed };
}

/** Permanently delete a single media: storage object + row, and refund quota. */
export async function deleteMediaHard(media: DeletableMedia): Promise<void> {
  const storage = getStorage();
  try {
    await storage.delete(media.storageKey);
  } catch {
    /* file may already be gone */
  }
  if (media.thumbKey) await storage.delete(media.thumbKey).catch(() => {});
  await purgeDerived(media.id);

  await db.delete(uploads).where(eq(uploads.id, media.id));

  // No owner means the file outlived its account — there is no quota counter
  // left to credit, and `eq(users.id, null)` would be a nonsense query.
  if (media.ownerId) {
    await db
      .update(users)
      .set({ usedQuota: sql`GREATEST(0, ${users.usedQuota} - ${media.size})` })
      .where(eq(users.id, media.ownerId));
  }
}

/** Soft-delete (move to trash) — keeps the file, hides it everywhere. */
export async function softDeleteMedia(id: string): Promise<void> {
  // `WHERE deleted_at IS NULL` so trashing something already in the trash does
  // nothing instead of re-stamping it. The stamp is what the thirty-day sweeper
  // counts from, so a second call would silently hand the file another month —
  // and a file that never quite expires is exactly what a retention window is
  // supposed to prevent.
  await db
    .update(uploads)
    .set({ deletedAt: new Date() })
    .where(and(eq(uploads.id, id), isNull(uploads.deletedAt)));
  // The original stays (that is the point of a trash); its cached conversions do
  // not. They are pure derivatives, regenerated on demand if the file comes
  // back, and keeping them would leave a downloadable copy of something the
  // owner has just said they no longer want served.
  await purgeDerived(id);
}

export async function restoreMedia(id: string): Promise<void> {
  await db.update(uploads).set({ deletedAt: null }).where(eq(uploads.id, id));
}
