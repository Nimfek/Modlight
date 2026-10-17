import "server-only";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { folders, uploads } from "@/lib/db/schema";
import { duplicateDismissals } from "@/lib/db/schema/duplicates-schema";
import { getUserPrefs } from "@/lib/data/user-prefs";
import { countUnchecksummed } from "@/lib/upload/duplicate-lookup";
import { mediaUrls } from "@/lib/media/urls";

/**
 * Retroactive duplicate detection, by CHECKSUM and nothing else.
 *
 * `uploads.checksum` holds a sha256 of the bytes for everything ingested since
 * the rewrite, so "these two rows are the same file" is a fact rather than a
 * guess. Names are explicitly not consulted: a screenshot tool hands the same
 * `image.png` to twenty unrelated files, and two copies of one video routinely
 * arrive as `clip.mp4` and `clip (1).mp4`. Matching on the bytes is the only
 * version of this feature that can be allowed to propose a delete.
 *
 * Two rules decide what the scan is even allowed to see:
 *
 *  - A NULL (or empty) checksum is EXCLUDED, never grouped. Every row written
 *    before checksums were recorded carries one, and if NULL grouped with
 *    NULL the scan would report that entire library as one
 *    enormous set of identical files and offer to delete all but the first.
 *    That is the single worst thing this feature could do, so the exclusion is
 *    enforced twice: in the SQL below, and again in `bucketByChecksum`.
 *  - Trashed rows are excluded. They are already on their way out (30-day
 *    sweep), they are not occupying the library, and offering to trash
 *    something that is in the trash would only restamp its expiry clock.
 *
 * The grouping happens in SQL. Reading every row into Node to count them would
 * mean pulling the whole uploads table across the wire to answer a question
 * Postgres can answer with one grouped scan.
 */

/** Groups returned with their file lists. Beyond this the caller is told it was capped. */
export const MAX_GROUPS = 100;

/**
 * Hard ceiling on rows fetched for the returned groups.
 *
 * Rows come back ordered by checksum, so hitting this truncates the TAIL of the
 * last groups rather than taking a random bite out of each. Every group still
 * reports its true `copies` count from the aggregate, so a trimmed list is
 * visibly incomplete instead of quietly wrong.
 */
export const MAX_ROWS = 2000;

/** Copies listed per group. A group of 300 is a story the UI tells, not a list. */
export const MAX_COPIES_LISTED = 50;

export interface DuplicateFile {
  id: string;
  code: string;
  filename: string;
  ext: string;
  mimeType: string;
  size: number;
  /** ISO 8601, so this survives the trip to a client component. */
  createdAt: string;
  folderId: string | null;
  folderName: string | null;
  views: number;
  downloads: number;
  /** Public preview link, on the hostname and in the shape this owner uses. */
  url: string;
  /**
   * Placeholder hash for the tile, when one was computed. Optional on the way in
   * (see `DuplicateRow`) and always present on the way out, because the preview
   * component's contract is `string | null`.
   */
  blurhash: string | null;
}

export interface DuplicateGroup {
  checksum: string;
  /** Live copies that exist. May exceed `files.length` - see MAX_COPIES_LISTED. */
  copies: number;
  /** Bytes one copy occupies. */
  size: number;
  /** Bytes the whole group occupies. */
  bytes: number;
  /** Bytes freed by keeping exactly one copy (the oldest). */
  reclaimable: number;
  /**
   * The owner has said these copies are meant to exist.
   *
   * Still listed, and still selectable: the page is a tool somebody opened on
   * purpose, so hiding a set they asked about would be answering a different
   * question. What the flag really governs is the REMINDER, which subtracts
   * every dismissed set from its totals - see `duplicateReminderQuery`.
   */
  dismissed: boolean;
  /** Oldest first: the original is almost always the one worth keeping. */
  files: DuplicateFile[];
}

/**
 * The three numbers "how much duplication is there" can mean.
 *
 * `redundant` and not "files involved": a set of two identical files contains
 * two files but only ONE that cleaning up would remove, and the reminder's own
 * sentence quotes the number it would remove. Deriving the trigger from a
 * different number than the message quotes is how a banner ends up saying
 * "12 files" while the page it opens offers to delete 6.
 */
export interface DuplicateTotals {
  groups: number;
  /** Copies beyond the one kept in each set: what cleaning up would remove. */
  redundant: number;
  /** Bytes cleaning up would free. */
  reclaimable: number;
}

export interface DuplicateScan {
  /** Ordered by reclaimable bytes, descending: the biggest win first. */
  groups: DuplicateGroup[];
  /** Groups found in total, which exceeds `groups.length` when capped. */
  totalGroups: number;
  /** Files taking part in a duplicate group. */
  totalFiles: number;
  /** Bytes freed by keeping one copy of every group, across ALL groups. */
  reclaimable: number;
  /** Sets the owner has waved off, across the whole library. */
  dismissedGroups: number;
  /**
   * The same library with the dismissed sets subtracted - what the reminder
   * counts, and therefore what "you are back under the threshold" means.
   */
  active: DuplicateTotals;
  /** True when more groups exist than were returned. */
  truncated: boolean;
  /**
   * Live files this scan could not consider at all, because they carry no
   * checksum. Reported rather than hidden: on a server whose library was imported
   * this is nearly all of it, and "no duplicates found" would
   * otherwise read as a statement about files the scan never looked at.
   */
  unchecksummed: number;
  scannedAt: string;
}

/** A row as the query below hands it over, before it becomes a `DuplicateFile`. */
export interface DuplicateRow {
  id: string;
  code: string;
  filename: string;
  ext: string;
  mimeType: string;
  size: number;
  createdAt: Date;
  folderId: string | null;
  folderName: string | null;
  views: number;
  downloads: number;
  checksum: string | null;
  /**
   * Optional so a caller that only selected the columns the grouping needs -
   * every test in tests/unit/duplicates.test.ts, for one - still type-checks.
   * The scan itself always selects it, because a tile with no placeholder pops.
   */
  blurhash?: string | null;
}

/**
 * Per-group facts from the aggregate, keyed by checksum.
 *
 * `dismissed` is optional rather than required for the same reason `blurhash`
 * is: the map is also built by hand in tests that care only about counts, and a
 * missing flag can only mean "not dismissed".
 */
export type GroupStats = ReadonlyMap<
  string,
  { copies: number; bytes: number; dismissed?: boolean }
>;

/** A checksum a row may be grouped BY. Anything else is a row on its own. */
export function hasUsableChecksum(checksum: string | null | undefined): checksum is string {
  return typeof checksum === "string" && checksum.trim().length > 0;
}

/**
 * Turn rows into groups.
 *
 * Pure, and separated from the query for two reasons: it is where the NULL rule
 * gets its second enforcement, and it is the part with an ordering contract
 * worth pinning in a test (oldest first inside a group, biggest saving first
 * across groups).
 *
 * `stats` carries the authoritative per-group counts from the aggregate, so a
 * group whose file list was trimmed still reports how many copies really exist.
 * Without it, counts are derived from the rows themselves.
 */
export function bucketByChecksum(
  rows: readonly DuplicateRow[],
  urlFor: (code: string, ext: string) => string,
  stats?: GroupStats,
): DuplicateGroup[] {
  const buckets = new Map<string, DuplicateRow[]>();

  for (const row of rows) {
    if (!hasUsableChecksum(row.checksum)) continue;
    const key = row.checksum;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }

  const groups: DuplicateGroup[] = [];

  for (const [checksum, bucket] of buckets) {
    // Oldest first. Sorted here rather than trusted from the query, because the
    // "keep the oldest" default the UI hangs on is decided by position 0.
    bucket.sort((a, b) => {
      const byTime = a.createdAt.getTime() - b.createdAt.getTime();
      return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
    });

    const stat = stats?.get(checksum);
    const copies = stat?.copies ?? bucket.length;
    // A single row is not a duplicate. It can only appear here if the aggregate
    // and the row fetch disagreed, which means a copy was trashed in between.
    if (copies < 2 || bucket.length < 2) continue;

    const bytes = stat?.bytes ?? bucket.reduce((sum, r) => sum + r.size, 0);
    const kept = bucket[0].size;

    groups.push({
      checksum,
      copies,
      size: kept,
      bytes,
      reclaimable: Math.max(0, bytes - kept),
      dismissed: stat?.dismissed === true,
      files: bucket.slice(0, MAX_COPIES_LISTED).map((row) => ({
        id: row.id,
        code: row.code,
        filename: row.filename,
        ext: row.ext,
        mimeType: row.mimeType,
        size: row.size,
        createdAt: row.createdAt.toISOString(),
        folderId: row.folderId,
        folderName: row.folderName,
        views: row.views,
        downloads: row.downloads,
        url: urlFor(row.code, row.ext),
        blurhash: row.blurhash ?? null,
      })),
    });
  }

  // Dismissed sets last, then biggest saving first: the point of the page is
  // "what does deleting win?", and a set the owner has already said no to is not
  // an answer to that. It stays visible - it just stops competing for the top of
  // a capped list with the sets that still need a decision.
  groups.sort(
    (a, b) =>
      Number(a.dismissed) - Number(b.dismissed) ||
      b.reclaimable - a.reclaimable ||
      a.checksum.localeCompare(b.checksum),
  );
  return groups;
}

/** `bigint`/`numeric` come back from pg as strings. Never let a NaN through. */
function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * One row of the grouped aggregate. Snake_case and an index signature because
 * this is what the driver hands back verbatim: `bigint` and `numeric` arrive as
 * strings (see `num`), which is exactly why byte totals are never cast to int4
 * in the SQL - a library over 2 GB would overflow it.
 */
type AggregateRow = Record<string, unknown> & {
  checksum: string;
  copies: number;
  bytes: string;
  keep: string;
  dismissed: boolean;
  total_groups: number;
  total_files: number;
  total_reclaimable: string | null;
  active_groups: number;
  active_redundant: number;
  active_reclaimable: string | null;
};

/** One row of the reminder aggregate. Same three numbers, none of the rows. */
type ReminderRow = Record<string, unknown> & {
  groups: number;
  redundant: number;
  reclaimable: string | null;
};

/*
 * Every live file of this account that carries no checksum, and is therefore
 * invisible to the scan, is counted by `countUnchecksummed` in
 * lib/upload/duplicate-lookup.ts. It used to live here; the upload-time check
 * needs the same number to decide whether "no match" may be reported as "you do
 * not have this file", and two definitions of "unchecksummed" that disagreed
 * would put two different numbers in front of the same user on the same day.
 */

const NO_TOTALS: DuplicateTotals = { groups: 0, redundant: 0, reclaimable: 0 };

function emptyScan(unchecksummed: number): DuplicateScan {
  return {
    groups: [],
    totalGroups: 0,
    totalFiles: 0,
    reclaimable: 0,
    dismissedGroups: 0,
    active: NO_TOTALS,
    truncated: false,
    unchecksummed,
    scannedAt: new Date().toISOString(),
  };
}

/**
 * WHICH checksums this owner holds more than one of. The rule, once.
 *
 * Both queries below open with this, rather than each spelling out the three
 * clauses that make a duplicate scan safe. The NULL-checksum exclusion in
 * particular is the difference between "find duplicates" and "offer to delete
 * the entire imported library", and a rule written twice is a rule that will
 * one day be edited once.
 *
 * `owner_id` is carried through the grouping so the dismissal lookup can join on
 * the complete key without binding the id a second time. Grouping by it changes
 * nothing - the WHERE has already pinned it to one value - and it keeps the CTE
 * self-describing: what comes out is a (owner, checksum) set, which is exactly
 * what duplicate_dismissals is keyed on.
 */
function dupesCte(userId: string) {
  return sql`
    select
      ${uploads.checksum} as checksum,
      ${uploads.ownerId} as owner_id,
      count(*)::int as copies,
      sum(${uploads.size})::bigint as bytes,
      max(${uploads.size})::bigint as keep
    from ${uploads}
    where ${uploads.ownerId} = ${userId}
      and ${uploads.deletedAt} is null
      and ${uploads.checksum} is not null
      and length(${uploads.checksum}) > 0
    group by ${uploads.checksum}, ${uploads.ownerId}
    having count(*) > 1
  `;
}

/**
 * The grouped aggregate: which checksums this owner holds more than one of.
 *
 * Written out here, away from `scanDuplicates`, so the clauses that make it safe
 * are a thing a test can read. Three of them are load-bearing:
 *
 *  - `checksum is not null` / `length(...) > 0` is THE rule (see the module
 *    comment): without it every checksumless import groups with every other;
 *  - `deleted_at is null` keeps files already in the trash out of it;
 *  - the window functions run over the CTE, which Postgres evaluates before the
 *    LIMIT, so `total_groups` and `total_reclaimable` describe the whole library
 *    even when only the first hundred groups come back.
 *
 * `max(size)` as the kept copy makes `bytes - keep` the most conservative
 * reading of what deleting wins. Equal checksums mean equal bytes and therefore
 * equal sizes, so the two are the same number in practice - but if they ever
 * disagreed, understating the saving is the harmless direction.
 *
 * Nothing is cast to `int` except the counts. A byte total on a library over
 * 2 GB overflows int4, and this deployment passed that years ago.
 */
export function duplicateAggregateQuery(userId: string) {
  // The CTE is called `dupes` and not `groups`: GROUPS became a keyword in
  // Postgres 11 (window frame mode). It is non-reserved and would parse, but a
  // query nobody can rehearse against production is the wrong place to lean on
  // that distinction.
  //
  // The `marked` step stamps each set with whether its owner has waved it off.
  // A LEFT JOIN and not a correlated EXISTS, because the join key is complete -
  // (owner_id, checksum) is duplicate_dismissals' primary key, in order - so
  // this is one index probe per set and it costs no extra bound parameter.
  //
  // The `filter (where not dismissed)` window totals are the whole point of
  // storing dismissals at all: they are the same three numbers with the waved-off
  // sets subtracted, which is what "count the next threshold from zero" means in
  // practice. Dismiss everything and they read 0; upload a fresh pile of copies
  // and they climb again from there.
  return sql`
    with dupes as (${dupesCte(userId)}),
    marked as (
      select
        d.checksum,
        d.copies,
        d.bytes,
        d.keep,
        (${duplicateDismissals.checksum} is not null) as dismissed
      from dupes d
      left join ${duplicateDismissals}
        on ${duplicateDismissals.ownerId} = d.owner_id
       and ${duplicateDismissals.checksum} = d.checksum
    )
    select
      checksum,
      copies,
      bytes,
      keep,
      dismissed,
      (count(*) over ())::int as total_groups,
      (sum(copies) over ())::int as total_files,
      (sum(bytes - keep) over ())::bigint as total_reclaimable,
      (count(*) filter (where not dismissed) over ())::int as active_groups,
      coalesce(sum(copies - 1) filter (where not dismissed) over (), 0)::int as active_redundant,
      coalesce(sum(bytes - keep) filter (where not dismissed) over (), 0)::bigint as active_reclaimable
    from marked
    order by dismissed asc, (bytes - keep) desc, checksum
    limit ${MAX_GROUPS}
  `;
}

/* -------------------------------------------------------------------------- */
/* The reminder                                                                */
/* -------------------------------------------------------------------------- */

/**
 * How much duplication earns an interruption.
 *
 * The owner's rule, in his words: more than ten duplicate files, or more than
 * one gigabyte. Both are "more than", so ten redundant copies of a thumbnail is
 * silence and the eleventh speaks.
 *
 * A gigabyte here is 1024^3, the same gibibyte `humanFileSize` prints as "1 GB"
 * and the same one the quota card divides by. A threshold that reads differently
 * from the number printed beside it is a threshold nobody can confirm.
 */
export const REMINDER_MIN_REDUNDANT = 10;
export const REMINDER_MIN_BYTES = 1024 ** 3;

export type DuplicateReminderState = DuplicateTotals & {
  /** Is the account over one of the two thresholds RIGHT NOW? */
  due: boolean;
};

/** Pure, so the rule can be read (and tested) without a database. */
export function reminderDue(totals: DuplicateTotals): boolean {
  return totals.redundant > REMINDER_MIN_REDUNDANT || totals.reclaimable > REMINDER_MIN_BYTES;
}

/**
 * The reminder's aggregate: the same sets, minus the ones waved off, minus the
 * rows.
 *
 * A separate query from `duplicateAggregateQuery` and deliberately so. This one
 * runs on ordinary page loads, so it returns exactly one row and never touches
 * the uploads table twice; the full scan returns up to a hundred sets and then
 * goes and fetches their files. They share `dupesCte`, which is what keeps them
 * from ever disagreeing about what a duplicate is.
 *
 * `not exists` rather than the LEFT JOIN used above because here the dismissed
 * sets are not wanted at all, and an anti-join says that in one clause.
 */
export function duplicateReminderQuery(userId: string) {
  return sql`
    with dupes as (${dupesCte(userId)})
    select
      count(*)::int as groups,
      coalesce(sum(d.copies - 1), 0)::int as redundant,
      coalesce(sum(d.bytes - d.keep), 0)::bigint as reclaimable
    from dupes d
    where not exists (
      select 1
      from ${duplicateDismissals}
      where ${duplicateDismissals.ownerId} = d.owner_id
        and ${duplicateDismissals.checksum} = d.checksum
    )
  `;
}

/**
 * What the reminder needs to decide whether to speak, and what to say.
 *
 * One query, no rows, no `countUnchecksummed`: the reminder never claims the
 * library is clean, it only ever says there is something to clean, so the
 * caveat that makes "no duplicates found" honest does not apply to it.
 */
export async function duplicateReminder(userId: string): Promise<DuplicateReminderState> {
  const result = await db.execute<ReminderRow>(duplicateReminderQuery(userId));
  const row = result.rows[0];

  const totals: DuplicateTotals = {
    groups: num(row?.groups),
    redundant: num(row?.redundant),
    reclaimable: num(row?.reclaimable),
  };

  return { ...totals, due: reminderDue(totals) };
}

/* -------------------------------------------------------------------------- */
/* The dismissed set                                                           */
/* -------------------------------------------------------------------------- */

/** What is recorded when a set is waved off. See duplicates-schema.ts. */
export interface DismissalInput {
  checksum: string;
  copies: number;
  bytes: number;
}

function whole(value: number): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Record "these copies are meant to exist" for one or more sets.
 *
 * Upsert rather than insert-or-fail: saying no twice is not an error, it is
 * somebody clicking again. The conflict path refreshes the remembered counts
 * (the set may have grown since) but leaves `created_at` where it was, because
 * that column answers "when did they first tell us" and re-stamping it would
 * quietly rewrite the only history this table keeps.
 *
 * Deduplicated first: Postgres refuses an ON CONFLICT DO UPDATE that would touch
 * the same row twice in one statement, and a client sending the same checksum
 * twice must not be able to turn that into a 500.
 */
export async function dismissChecksums(
  userId: string,
  entries: readonly DismissalInput[],
): Promise<number> {
  const byChecksum = new Map<string, DismissalInput>();
  for (const entry of entries) {
    if (!entry?.checksum) continue;
    byChecksum.set(entry.checksum, entry);
  }
  if (byChecksum.size === 0) return 0;

  const rows = await db
    .insert(duplicateDismissals)
    .values(
      [...byChecksum.values()].map((entry) => ({
        ownerId: userId,
        checksum: entry.checksum,
        copies: whole(entry.copies),
        bytes: whole(entry.bytes),
      })),
    )
    .onConflictDoUpdate({
      target: [duplicateDismissals.ownerId, duplicateDismissals.checksum],
      set: {
        copies: sql`excluded.copies`,
        bytes: sql`excluded.bytes`,
      },
    })
    .returning({ checksum: duplicateDismissals.checksum });

  return rows.length;
}

/**
 * Take a set back out of the dismissed pile, so it counts again.
 *
 * Ownership is in the WHERE clause, not checked beforehand: a checksum is a
 * global fact about bytes, so a delete that matched on the checksum alone would
 * let one account clear another's decision.
 */
export async function restoreChecksums(
  userId: string,
  checksums: readonly string[],
): Promise<number> {
  if (checksums.length === 0) return 0;

  const rows = await db
    .delete(duplicateDismissals)
    .where(
      and(
        eq(duplicateDismissals.ownerId, userId),
        inArray(duplicateDismissals.checksum, [...checksums]),
      ),
    )
    .returning({ checksum: duplicateDismissals.checksum });

  return rows.length;
}

/**
 * Read-only scan of ONE account's library.
 *
 * Three queries, none of which streams the table into Node:
 *
 *  1. the grouped aggregate above, which both picks the checksums worth listing
 *     and carries the whole-library totals;
 *  2. the rows of those groups;
 *  3. the count of files with no checksum.
 *
 * The aggregate walks this owner's rows through `uploads_owner_created_idx`. If
 * a single account ever grows to the point where that scan is felt, the fix is
 * an index on (owner_id, checksum) - not a different shape of query.
 */
export async function scanDuplicates(userId: string): Promise<DuplicateScan> {
  const [aggregate, prefs, unchecksummed] = await Promise.all([
    db.execute<AggregateRow>(duplicateAggregateQuery(userId)),
    getUserPrefs(userId),
    countUnchecksummed(userId),
  ]);

  const summaries = aggregate.rows;
  if (summaries.length === 0) return emptyScan(unchecksummed);

  const totalGroups = num(summaries[0].total_groups);
  const totalFiles = num(summaries[0].total_files);
  const reclaimable = num(summaries[0].total_reclaimable);

  const active: DuplicateTotals = {
    groups: num(summaries[0].active_groups),
    redundant: num(summaries[0].active_redundant),
    reclaimable: num(summaries[0].active_reclaimable),
  };

  const stats: Map<string, { copies: number; bytes: number; dismissed: boolean }> = new Map(
    summaries.map((s) => [
      s.checksum,
      { copies: num(s.copies), bytes: num(s.bytes), dismissed: s.dismissed === true },
    ]),
  );

  const rows = await db
    .select({
      id: uploads.id,
      code: uploads.code,
      filename: uploads.filename,
      ext: uploads.ext,
      mimeType: uploads.mimeType,
      size: uploads.size,
      createdAt: uploads.createdAt,
      folderId: uploads.folderId,
      folderName: folders.name,
      views: uploads.views,
      downloads: uploads.downloads,
      checksum: uploads.checksum,
      blurhash: uploads.blurhash,
    })
    .from(uploads)
    .leftJoin(folders, eq(folders.id, uploads.folderId))
    .where(
      and(
        eq(uploads.ownerId, userId),
        isNull(uploads.deletedAt),
        inArray(uploads.checksum, [...stats.keys()]),
      ),
    )
    .orderBy(asc(uploads.checksum), asc(uploads.createdAt), asc(uploads.id))
    .limit(MAX_ROWS);

  const owner = {
    userCode: prefs?.userCode ?? null,
    preferredDomain: prefs?.preferredDomain ?? null,
    skipTagInUrl: prefs?.skipTagInUrl ?? false,
  };

  const groups = bucketByChecksum(
    rows.map((r) => ({ ...r, size: Number(r.size) })),
    (code, ext) => mediaUrls(owner, code, ext).url,
    stats,
  );

  return {
    groups,
    totalGroups,
    totalFiles,
    reclaimable,
    dismissedGroups: Math.max(0, totalGroups - active.groups),
    active,
    truncated: totalGroups > groups.length,
    unchecksummed,
    scannedAt: new Date().toISOString(),
  };
}

// ── Input the CLIENT supplies ──────────────────────────────────────────────

/**
 * Ids the trash action will accept in one call.
 *
 * Tied to MAX_ROWS rather than picked, because the two numbers answer the same
 * question from opposite ends and a gap between them is a dead end the user
 * cannot get out of. A scan can list up to MAX_ROWS files across at most
 * MAX_GROUPS groups, so the DEFAULT selection - every copy but the oldest of
 * each - is up to `MAX_ROWS - MAX_GROUPS` ids. At 1000 the action refused its
 * own recommendation on any library big enough to reach the cap, and the only
 * way forward was unticking hundreds of boxes by hand.
 *
 * A single statement with this many bound parameters is still nowhere near
 * Postgres' 65535 limit, so the delete stays ONE atomic UPDATE. Batching it
 * would trade a bound this comment can state for a half-applied delete nobody
 * can describe. `tests/unit/duplicates.test.ts` pins the relationship.
 */
export const MAX_TRASH_IDS = MAX_ROWS;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type IdListIssue = "empty" | "malformed" | "too-many";

/**
 * Validate the list of ids a client asked to trash.
 *
 * The shape check is not decoration: `uploads.id` is a uuid column, so a string
 * that is not one makes Postgres raise `invalid input syntax for type uuid` -
 * an exception, from a Server Action, whose message production strips. The
 * caller would see "an unexpected error occurred" and have no idea which of the
 * things it sent was wrong. Refusing here turns that into an answer.
 *
 * Duplicates are collapsed so a double-click cannot inflate the count reported
 * back, and the ceiling keeps one statement's parameter list finite.
 */
export function parseUploadIds(
  input: readonly string[],
): { ok: true; ids: string[] } | { ok: false; issue: IdListIssue } {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, issue: "empty" };
  if (input.length > MAX_TRASH_IDS) return { ok: false, issue: "too-many" };

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string" || !UUID.test(raw.trim())) return { ok: false, issue: "malformed" };
    const id = raw.trim().toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  if (ids.length === 0) return { ok: false, issue: "empty" };
  return { ok: true, ids };
}
