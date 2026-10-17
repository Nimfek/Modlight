import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { uploads } from "@/lib/db/schema";

/**
 * The queries behind "do I already have this file?".
 *
 * Split from lib/upload/duplicate-check.ts, which is the same feature's
 * database-free contract: that half is imported by the BROWSER (the panel hashes
 * a small file before uploading it), and dragging `@/lib/db` into a client
 * bundle is not a thing that fails loudly - it fails at build time with a
 * message about `pg`.
 *
 * NO `import "server-only"` here, and it must stay that way: lib/upload/sharex.ts
 * calls `firstMatchFor` and is bundled into `dist/server.js` by esbuild with
 * `--packages=external`. That specifier resolves only inside Next's bundler and
 * vitest's alias, so it would survive into the bundle verbatim and kill
 * `node dist/server.js` at link time, before it ever listened. Same rule as
 * lib/maintenance/trash.ts:14 and lib/upload/folder-target.ts;
 * scripts/check-server-bundle.mjs is the backstop.
 *
 * Every query here folds ownership into the WHERE clause. A checksum is a
 * global fact about bytes, so a lookup that filtered afterwards - or not at all -
 * would turn this into an oracle for "does anybody on this server hold this
 * file", which is precisely the question a public host must never answer.
 */

/**
 * Hard ceiling on rows fetched for one request.
 *
 * Rows come back ordered by checksum, so hitting this truncates whole checksums
 * off the TAIL rather than taking a random bite out of each - and the caller is
 * told, which downgrades every unmatched checksum in the reply from `new` to
 * `unknown`. The same number lib/data/duplicates.ts uses for the same job.
 */
export const MAX_MATCH_ROWS = 2000;

/** A live upload of the caller's that matched, before it becomes a `CheckMatch`. */
export interface ChecksumRow {
  id: string;
  code: string;
  filename: string;
  ext: string;
  mimeType: string;
  size: number;
  createdAt: Date;
  folderId: string | null;
  checksum: string | null;
}

const ROW_FIELDS = {
  id: uploads.id,
  code: uploads.code,
  filename: uploads.filename,
  ext: uploads.ext,
  mimeType: uploads.mimeType,
  size: uploads.size,
  createdAt: uploads.createdAt,
  folderId: uploads.folderId,
  checksum: uploads.checksum,
} as const;

export interface ChecksumMatches {
  /** Keyed by checksum; oldest copy first. Checksums with no match are absent. */
  byChecksum: Map<string, ChecksumRow[]>;
  /** The row ceiling bit. True means part of the answer was cut off. */
  truncated: boolean;
}

/**
 * Which of these checksums does `userId` already hold, live?
 *
 * One indexed lookup (`uploads_owner_checksum_idx`), grouped in Node - the
 * grouping is over at most MAX_MATCH_ROWS rows that were going to cross the
 * wire anyway, so pushing it into SQL would buy nothing and cost a query shape
 * the test helper cannot read.
 *
 * `deleted_at is null` is load-bearing: a file in the trash is on its way out
 * (30-day sweep) and its links already 404, so calling it a duplicate would tell
 * somebody they need not upload a file that is about to stop existing.
 */
export async function matchesByChecksum(
  userId: string,
  checksums: readonly string[],
): Promise<ChecksumMatches> {
  const byChecksum = new Map<string, ChecksumRow[]>();
  if (checksums.length === 0) return { byChecksum, truncated: false };

  const rows = await db
    .select(ROW_FIELDS)
    .from(uploads)
    .where(
      and(
        eq(uploads.ownerId, userId),
        isNull(uploads.deletedAt),
        inArray(uploads.checksum, [...checksums]),
      ),
    )
    // Checksum first so the ceiling drops whole groups rather than nibbling at
    // each; then oldest first, because the original is the copy worth linking to.
    .orderBy(asc(uploads.checksum), asc(uploads.createdAt), asc(uploads.id))
    .limit(MAX_MATCH_ROWS);

  for (const row of rows) {
    if (!row.checksum) continue; // impossible via inArray, cheap to not rely on
    const bucket = byChecksum.get(row.checksum);
    if (bucket) bucket.push(row);
    else byChecksum.set(row.checksum, [row]);
  }

  return { byChecksum, truncated: rows.length >= MAX_MATCH_ROWS };
}

/**
 * The oldest live file of `userId`'s carrying exactly these bytes, or null.
 *
 * The single-checksum form, for the ShareX path: those bytes have already
 * arrived, so this can only ever be a REPORT, never a refusal - see the call
 * site in lib/upload/sharex.ts.
 */
export async function firstMatchFor(
  userId: string,
  checksum: string,
): Promise<ChecksumRow | null> {
  const rows = await db
    .select(ROW_FIELDS)
    .from(uploads)
    .where(
      and(
        eq(uploads.ownerId, userId),
        isNull(uploads.deletedAt),
        eq(uploads.checksum, checksum),
      ),
    )
    .orderBy(asc(uploads.createdAt), asc(uploads.id))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Live files of this account that carry no checksum, and are therefore
 * invisible to every lookup above.
 *
 * The one number that decides whether "no match" may be reported as "you do not
 * have this file". Shared with lib/data/duplicates.ts rather than written twice:
 * the retroactive scan shows the same count to explain why it found nothing, and
 * two definitions of "unchecksummed" that disagreed would put two different
 * numbers in front of the same user on the same day.
 *
 * The empty-string arm is belt and braces - every writer of this column stores
 * either 64 hex characters or NULL - but it costs nothing and it is what makes
 * this a statement about "no usable checksum" rather than about one encoding of
 * absence.
 */
export async function countUnchecksummed(userId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(uploads)
    .where(
      and(
        eq(uploads.ownerId, userId),
        isNull(uploads.deletedAt),
        or(isNull(uploads.checksum), eq(uploads.checksum, "")),
      ),
    );

  const n = Number(rows[0]?.n ?? 0);
  return Number.isFinite(n) ? n : 0;
}
