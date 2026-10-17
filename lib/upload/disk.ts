import { stat, statfs } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { config } from "@/lib/config";

/**
 * What one statfs call has to say about a filesystem.
 *
 * `free + used` deliberately does NOT add up to `total`: the gap is the
 * root-reserved portion, which the kernel keeps back from unprivileged writers.
 * Reporting it any other way would either overstate what we can still write or
 * understate what is already occupied, so this matches `df` exactly.
 */
export interface FilesystemSpace {
  /** Size of the whole filesystem. */
  totalBytes: number;
  /** Bytes an unprivileged process may still write (df's "Avail"). */
  freeBytes: number;
  /** Bytes occupied by everything on this filesystem, not just by us. */
  usedBytes: number;
}

/**
 * Free bytes on the filesystem that holds uploads, or null when the question
 * does not apply (S3) or cannot be answered.
 *
 * Shared by the two upload paths so both refuse an oversized transfer at the
 * door rather than after it. A full disk is not a degraded state — Postgres
 * stops accepting writes, backups truncate mid-file, and every other
 * application on the host goes down with us.
 */
export async function freeBytesForUploads(): Promise<number | null> {
  if (config.storage.driver !== "local") return null;
  return freeBytesAt(config.storage.localPath);
}

/**
 * Everything the admin panel needs about the storage filesystem, or null when
 * there is no such thing (S3) or the syscall failed.
 *
 * Same single statfs the upload guard runs on, so the panel and the 507 can
 * never disagree about how much room is left: one measurement, two readers.
 */
export async function storageFilesystemSpace(): Promise<FilesystemSpace | null> {
  if (config.storage.driver !== "local") return null;
  return filesystemSpaceAt(config.storage.localPath);
}

/**
 * The one place a statfs is issued. Null when the path cannot be measured.
 *
 * Never blocks an upload on a failed syscall: an unmeasurable filesystem is
 * reported as "no answer", and the callers treat that as "let it through".
 */
async function filesystemSpaceAt(path: string): Promise<FilesystemSpace | null> {
  try {
    const fs = await statfs(path);
    return {
      totalBytes: fs.blocks * fs.bsize,
      freeBytes: fs.bavail * fs.bsize,
      usedBytes: (fs.blocks - fs.bfree) * fs.bsize,
    };
  } catch {
    return null;
  }
}

/** Free bytes on the filesystem holding `path`, or null when it cannot be read. */
async function freeBytesAt(path: string): Promise<number | null> {
  return (await filesystemSpaceAt(path))?.freeBytes ?? null;
}

/**
 * Whether `size` more bytes fit without eating into the operator's reserve.
 *
 * Pure, so the arithmetic that decides a 507 can be tested without a disk.
 * `free === null` means we could not measure and must not guess: refusing an
 * upload because a syscall failed would be a worse failure than the one this
 * guard exists to prevent.
 */
export function fitsOnDisk(size: number, free: number | null, minFree: number): boolean {
  if (free === null) return true;
  if (minFree <= 0) return free - size >= 0;
  return free - size >= minFree;
}

/**
 * How worried an operator should be about the storage filesystem.
 *
 * "unknown" is a distinct answer on purpose: an unreadable filesystem must not
 * be painted green, and it must not be painted red either.
 */
export type DiskPressure = "unknown" | "ok" | "low" | "critical";

/** Below this share of the disk, say something. */
export const LOW_FREE_RATIO = 0.1;
/** Below this share, say it loudly. */
export const CRITICAL_FREE_RATIO = 0.05;

/**
 * Severity for the admin panel, from the same two numbers the upload guard uses.
 *
 * Two independent triggers, because they answer different questions:
 *
 *  - The RESERVE is the operationally real line. Once free space is inside it,
 *    `fitsOnDisk` is already refusing every upload with a 507, and the panel is
 *    the only place that can tell the operator why. Twice the reserve means the
 *    next large file is the one that fails.
 *  - The RATIO catches the slow fill on a disk far bigger than the reserve, where
 *    10 GiB free is 0.25% and the fixed floor would stay quiet until the hour
 *    everything breaks.
 *
 * A filesystem that could not be measured reports "unknown" rather than a guess:
 * this panel is read at a glance, and a wrong colour is worse than no colour.
 */
export function diskPressure(
  free: number | null,
  total: number | null,
  minFree: number,
): DiskPressure {
  if (free == null || total == null) return "unknown";
  if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0 || free < 0) return "unknown";

  const ratio = free / total;
  if (ratio <= CRITICAL_FREE_RATIO) return "critical";
  if (minFree > 0 && free <= minFree) return "critical";
  if (ratio <= LOW_FREE_RATIO) return "low";
  if (minFree > 0 && free <= minFree * 2) return "low";
  return "ok";
}

/**
 * Can the host accept a file of `size` bytes, given where it will be staged?
 *
 * Both filesystems are checked with the FULL size, and that is correct in each
 * case. When staging and storage share a filesystem the two checks read the
 * same number, and the file only ever occupies it once (LocalDriver moves it
 * with rename). When they differ, the payload really does need `size` free on
 * the staging disk and `size` free on the storage disk, because the copy has
 * both on the floor at the same moment.
 *
 * This runs BEFORE the first byte is accepted. Getting it right here is the
 * whole difference between "your file is too big for this server" arriving in a
 * millisecond and arriving after an hour of uploading.
 */
export async function hasRoomFor(size: number, stagingPath: string): Promise<boolean> {
  if (config.storage.driver !== "local") return true;
  if (!Number.isFinite(size) || size <= 0) return true;

  const minFree = config.uploads.minFreeBytes;
  for (const path of new Set([config.storage.localPath, stagingPath])) {
    if (!fitsOnDisk(size, await freeBytesAt(path), minFree)) return false;
  }
  return true;
}

/**
 * Device id of the nearest existing ancestor of `path`, or null when even the
 * filesystem root refuses to answer.
 *
 * Walking up matters because storage and staging directories are created
 * lazily: on a fresh install `data/storage` may not exist yet, and a missing
 * directory must not be mistaken for "a different disk".
 */
async function deviceOf(path: string): Promise<number | null> {
  let current = resolve(path);
  for (;;) {
    try {
      return (await stat(current)).dev;
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/**
 * Whether two paths live on the same filesystem, i.e. whether moving a file
 * between them is a free rename or a full copy.
 *
 * Unknown answers come back `false` on purpose: assuming a copy over-reserves
 * space, and over-reserving is the safe direction.
 */
export async function sameFilesystem(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([deviceOf(a), deviceOf(b)]);
  return da !== null && db !== null && da === db;
}
