/**
 * What the disk is actually holding, for the administrator.
 *
 * `serverStorageUsage()` in lib/data/admin.ts answers "how full is the machine".
 * This answers the question that follows it: WHAT is in there, and which end of
 * it is worth pulling on. Every number below is an aggregate the database
 * computes, never an extrapolation from a sample.
 *
 * Cost, on this install's ~8.7k uploads: five statements over `uploads`, plus
 * one primary-key lookup in `user`, run one after another on a SINGLE pooled
 * connection. Each is a sequential scan of a table of a few hundred heap pages
 * (~8.7k rows at a few hundred bytes each, so single-digit megabytes); after the
 * first visit that lives in shared_buffers, which puts the whole panel in the
 * low tens of milliseconds. Not measured against production - the pool must not
 * be pointed at it from here - so this is an argument from row count, and it
 * stops holding at a hundred times the size, where the comment above each query
 * names the index it would then want. None of those indexes is worth creating
 * today: every one of them is write amplification on the hottest table in the
 * app, bought to save a few milliseconds on a page only an administrator opens.
 *
 * Deliberately free of `import "server-only"`, exactly like lib/data/admin.ts:
 * the pure folding helpers at the bottom are unit-tested, and nothing here is
 * reachable from a client bundle anyway (it pulls in the database pool).
 */
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { uploads, user as users } from "@/lib/db/schema";
import { config } from "@/lib/config";
import { TRASH_RETENTION_MS } from "@/lib/maintenance/trash";
import { mediaKind, type MediaKind } from "@/lib/media/mime";

/**
 * How long a file has to go untouched before it is worth listing.
 *
 * Six months rather than a year: the point is to surface something an operator
 * can act on this quarter, and a year-long window on an install that is itself
 * younger than a year would report nothing at all.
 */
export const COLD_DAYS = 180;

/** A trashed file with this many days left is about to be purged for real. */
export const TRASH_DUE_SOON_DAYS = 7;

/** Rows per list. Long enough to see a pattern, short enough to read at a glance. */
const LIST_LIMIT = 6;

/** Accounts shown by name before the tail is folded into one "everyone else" row. */
const ACCOUNT_LIMIT = 6;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface HeavyFile {
  id: string;
  code: string;
  filename: string;
  ext: string;
  mimeType: string;
  size: number;
  /** Owner's id, or null for an orphan (owner deleted, files kept). */
  ownerId: string | null;
  /** Owner's tag, i.e. the first segment of their public links. */
  ownerTag: string | null;
  ownerName: string | null;
  /** ISO strings: a server component may only hand plain data to the client. */
  createdAt: string | null;
  /** Recorded fetches. Zero next to a large size is the clearest case to act on. */
  views: number;
  /**
   * Last recorded fetch, or null when nothing has fetched it since it arrived.
   *
   * Null is NOT proof the file was never read. Access has only been counted
   * since the row was written here, and rows that predate the counter, or were
   * imported, carry no history at all. The
   * UI has to say this rather than imply the file is unused.
   */
  lastAccessedAt: string | null;
}

export interface KindUsage {
  kind: MediaKind;
  files: number;
  bytes: number;
}

export interface AccountUsage {
  /** Null for the folded "everyone else" row and for the orphan row. */
  id: string | null;
  name: string | null;
  email: string | null;
  tag: string | null;
  /** True for the pseudo-row that stands for files with no owner. */
  orphaned: boolean;
  /** True for the folded tail. `accounts` says how many were folded in. */
  rest: boolean;
  accounts: number;
  liveFiles: number;
  liveBytes: number;
  trashedFiles: number;
  trashedBytes: number;
}

export interface TrashOutlook {
  files: number;
  bytes: number;
  /** ISO of the longest-standing trashed row, or null for an empty trash. */
  oldest: string | null;
  /** Purged within TRASH_DUE_SOON_DAYS: the bytes coming back on their own. */
  dueSoonFiles: number;
  dueSoonBytes: number;
  /**
   * Past the retention window and STILL here.
   *
   * Should be zero: the sweeper runs every six hours. Anything else is the
   * panel reporting that the sweeper is not running, which is the only way an
   * operator would ever find out.
   */
  overdueFiles: number;
  overdueBytes: number;
}

export interface ColdTotals {
  files: number;
  bytes: number;
  /** The window the two numbers above were measured over. */
  days: number;
}

export interface DiskInsights {
  /** Storage driver, so the UI can say what it cannot know on an object store. */
  driver: string;
  /** True when the numbers below can be compared against a real filesystem. */
  local: boolean;
  kinds: KindUsage[];
  /** Live bytes the kind breakdown adds up to, so shares are honest. */
  kindBytes: number;
  accounts: AccountUsage[];
  biggest: HeavyFile[];
  cold: HeavyFile[];
  coldTotals: ColdTotals;
  trash: TrashOutlook;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const FILE_COLUMNS = {
  id: uploads.id,
  code: uploads.code,
  filename: uploads.filename,
  ext: uploads.ext,
  mimeType: uploads.mimeType,
  size: uploads.size,
  ownerId: uploads.ownerId,
  ownerTag: users.userCode,
  ownerName: users.name,
  createdAt: uploads.createdAt,
  views: uploads.views,
  lastAccessedAt: uploads.lastAccessedAt,
};

type FileRow = {
  id: string;
  code: string;
  filename: string;
  ext: string | null;
  mimeType: string;
  size: number | string;
  ownerId: string | null;
  ownerTag: string | null;
  ownerName: string | null;
  createdAt: Date | null;
  views: number | null;
  lastAccessedAt: Date | null;
};

function toHeavyFile(row: FileRow): HeavyFile {
  return {
    id: row.id,
    code: row.code,
    filename: row.filename,
    ext: row.ext ?? "",
    mimeType: row.mimeType,
    size: Number(row.size ?? 0),
    ownerId: row.ownerId,
    ownerTag: row.ownerTag,
    ownerName: row.ownerName,
    createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    views: Number(row.views ?? 0),
    lastAccessedAt: row.lastAccessedAt ? row.lastAccessedAt.toISOString() : null,
  };
}

/**
 * "Last time we know something touched this file."
 *
 * Falls back to the upload date, which is the truthful lower bound: before the
 * row existed there was nothing to record an access against. Written once here
 * so the list and the total that summarises it can never disagree about which
 * files are cold.
 */
const lastTouch = sql`coalesce(${uploads.lastAccessedAt}, ${uploads.createdAt})`;

/**
 * Everything the disk panel needs, read as one instant.
 *
 * A read-only REPEATABLE READ transaction rather than `Promise.all`, for two
 * reasons that point the same way:
 *
 *  - **The panel has to reconcile.** Its entire job is that the breakdowns add
 *    up to the total above them. Five statements issued in parallel are five
 *    different snapshots, so an upload landing mid-render puts a file in the
 *    type breakdown and not in the account one, and the operator is left
 *    deciding which of two numbers on the same card is lying.
 *  - **The pool is shared.** `max: 10` connections serve the whole site; one
 *    admin refresh must not take half of them to answer a question nobody is
 *    waiting on. Serial on one connection costs a few extra round trips against
 *    a database on the same host, which is not a cost anyone can perceive.
 *
 * `read only` is belt and braces: this is a read model, and the transaction
 * says so to Postgres rather than only to the reader.
 *
 * Says nothing about who may see it: like every read model in lib/data, the
 * caller does the guarding. Today that is the admin page, behind `requireAdmin`.
 */
export async function diskInsights(now: Date = new Date()): Promise<DiskInsights> {
  const coldCutoff = new Date(now.getTime() - COLD_DAYS * 86_400_000);
  const purgeCutoff = new Date(now.getTime() - TRASH_RETENTION_MS);
  const dueSoonCutoff = new Date(
    now.getTime() - TRASH_RETENTION_MS + TRASH_DUE_SOON_DAYS * 86_400_000,
  );

  return db.transaction(
    async (tx) => {
      /**
       * One scan, eight filtered aggregates: the trash outlook and the cold
       * totals are different questions about the same table, and asking them
       * separately would read it twice for no gain.
       *
       * At a hundred times this size: a partial index on (deleted_at) where
       * deleted_at is not null, plus an expression index on
       * coalesce(last_accessed_at, created_at).
       */
      const [scalars] = await tx
        .select({
          trashFiles: sql<number>`(count(*) filter (where ${uploads.deletedAt} is not null))::int`,
          trashBytes: sql<string>`coalesce(sum(${uploads.size}) filter (where ${uploads.deletedAt} is not null), 0)`,
          trashOldest: sql<Date | null>`min(${uploads.deletedAt})`,
          dueSoonFiles: sql<number>`(count(*) filter (where ${uploads.deletedAt} < ${dueSoonCutoff} and ${uploads.deletedAt} >= ${purgeCutoff}))::int`,
          dueSoonBytes: sql<string>`coalesce(sum(${uploads.size}) filter (where ${uploads.deletedAt} < ${dueSoonCutoff} and ${uploads.deletedAt} >= ${purgeCutoff}), 0)`,
          overdueFiles: sql<number>`(count(*) filter (where ${uploads.deletedAt} < ${purgeCutoff}))::int`,
          overdueBytes: sql<string>`coalesce(sum(${uploads.size}) filter (where ${uploads.deletedAt} < ${purgeCutoff}), 0)`,
          coldFiles: sql<number>`(count(*) filter (where ${uploads.deletedAt} is null and ${lastTouch} < ${coldCutoff}))::int`,
          coldBytes: sql<string>`coalesce(sum(${uploads.size}) filter (where ${uploads.deletedAt} is null and ${lastTouch} < ${coldCutoff}), 0)`,
        })
        .from(uploads);

      /**
       * Bytes per stored type, folded into media kinds afterwards rather than
       * in SQL.
       *
       * `split_part(mime_type, '/', 1)` would have been one line, and wrong:
       * what a file IS follows from `effectiveType(mime, ext)` (Round 7),
       * because a client that sent application/octet-stream told us nothing and
       * the name on disk is then the better evidence. Grouping by the (type,
       * extension) pair keeps that rule available while still costing one scan:
       * the group count is the number of distinct pairs on the install, a few
       * hundred at most, not the number of files.
       */
      const kindRows = await tx
        .select({
          mimeType: uploads.mimeType,
          ext: uploads.ext,
          files: sql<number>`count(*)::int`,
          bytes: sql<string>`coalesce(sum(${uploads.size}), 0)`,
        })
        .from(uploads)
        .where(isNull(uploads.deletedAt))
        .groupBy(uploads.mimeType, uploads.ext);

      /**
       * Per-owner totals, live and trashed apart.
       *
       * Unlimited on purpose: the group count is the number of accounts that
       * hold files (six here, plus one null group for orphans), not the number
       * of files, so the tail is folded in JS where the leftovers can still be
       * summed honestly. A hash aggregate over the whole table is the right plan
       * at any size where the table fits in cache.
       */
      const accountRows = await tx
        .select({
          ownerId: uploads.ownerId,
          liveFiles: sql<number>`(count(*) filter (where ${uploads.deletedAt} is null))::int`,
          liveBytes: sql<string>`coalesce(sum(${uploads.size}) filter (where ${uploads.deletedAt} is null), 0)`,
          trashedFiles: sql<number>`(count(*) filter (where ${uploads.deletedAt} is not null))::int`,
          trashedBytes: sql<string>`coalesce(sum(${uploads.size}) filter (where ${uploads.deletedAt} is not null), 0)`,
        })
        .from(uploads)
        .groupBy(uploads.ownerId);

      /**
       * The heaviest live files. Scan plus a top-N heapsort of LIST_LIMIT rows,
       * and the owner join is a primary-key lookup for each of those few rows.
       *
       * At a hundred times this size: index on (size desc) where deleted_at is
       * null. Today it would be a second index to maintain on every upload in
       * exchange for saving under a millisecond.
       */
      const biggestRows = await tx
        .select(FILE_COLUMNS)
        .from(uploads)
        .leftJoin(users, eq(uploads.ownerId, users.id))
        .where(isNull(uploads.deletedAt))
        .orderBy(desc(uploads.size))
        .limit(LIST_LIMIT);

      /** The longest-untouched live files, by the same definition as the totals. */
      const coldRows = await tx
        .select(FILE_COLUMNS)
        .from(uploads)
        .leftJoin(users, eq(uploads.ownerId, users.id))
        .where(and(isNull(uploads.deletedAt), sql`${lastTouch} < ${coldCutoff}`))
        .orderBy(asc(lastTouch))
        .limit(LIST_LIMIT);

      const kinds = foldKinds(
        kindRows.map((r) => ({
          mimeType: r.mimeType,
          ext: r.ext,
          files: Number(r.files ?? 0),
          bytes: Number(r.bytes ?? 0),
        })),
      );

      const ranked = rankAccounts(
        accountRows.map((r) => ({
          ownerId: r.ownerId,
          liveFiles: Number(r.liveFiles ?? 0),
          liveBytes: Number(r.liveBytes ?? 0),
          trashedFiles: Number(r.trashedFiles ?? 0),
          trashedBytes: Number(r.trashedBytes ?? 0),
        })),
      );

      // Only the accounts that survived folding need a name, so the user table
      // is read for at most ACCOUNT_LIMIT ids rather than for every group. It
      // is read inside the same snapshot: an account deleted between the
      // grouping and the lookup would otherwise render as an unnamed row.
      const namedIds = ranked.map((a) => a.id).filter((id): id is string => id !== null);
      const owners = namedIds.length
        ? await tx
            .select({
              id: users.id,
              name: users.name,
              email: users.email,
              tag: users.userCode,
            })
            .from(users)
            .where(inArray(users.id, namedIds))
        : [];
      const byId = new Map(owners.map((o) => [o.id, o]));

      return {
        driver: config.storage.driver,
        local: config.storage.driver === "local",
        kinds,
        kindBytes: kinds.reduce((sum, k) => sum + k.bytes, 0),
        accounts: ranked.map((a) => {
          const owner = a.id ? byId.get(a.id) : undefined;
          return {
            ...a,
            name: owner?.name ?? null,
            email: owner?.email ?? null,
            tag: owner?.tag ?? null,
          };
        }),
        biggest: biggestRows.map(toHeavyFile),
        cold: coldRows.map(toHeavyFile),
        coldTotals: {
          files: Number(scalars?.coldFiles ?? 0),
          bytes: Number(scalars?.coldBytes ?? 0),
          days: COLD_DAYS,
        },
        trash: {
          files: Number(scalars?.trashFiles ?? 0),
          bytes: Number(scalars?.trashBytes ?? 0),
          oldest: scalars?.trashOldest ? new Date(scalars.trashOldest).toISOString() : null,
          dueSoonFiles: Number(scalars?.dueSoonFiles ?? 0),
          dueSoonBytes: Number(scalars?.dueSoonBytes ?? 0),
          overdueFiles: Number(scalars?.overdueFiles ?? 0),
          overdueBytes: Number(scalars?.overdueBytes ?? 0),
        },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

// ---------------------------------------------------------------------------
// Pure folding (unit-tested)
// ---------------------------------------------------------------------------

export interface TypeGroup {
  mimeType: string;
  ext: string | null;
  files: number;
  bytes: number;
}

/**
 * (stored type, extension) groups collapsed into the media kinds the rest of the
 * app reasons in, heaviest first.
 *
 * `mediaKind` is the app's one answer to "what is this file", `effectiveType`
 * included; nothing here re-derives it.
 */
export function foldKinds(groups: TypeGroup[]): KindUsage[] {
  const acc = new Map<MediaKind, KindUsage>();
  for (const g of groups) {
    const kind = mediaKind(g.mimeType, g.ext);
    const seen = acc.get(kind);
    if (seen) {
      seen.files += g.files;
      seen.bytes += g.bytes;
    } else {
      acc.set(kind, { kind, files: g.files, bytes: g.bytes });
    }
  }
  return [...acc.values()].sort((a, b) => b.bytes - a.bytes || a.kind.localeCompare(b.kind));
}

export interface OwnerGroup {
  ownerId: string | null;
  liveFiles: number;
  liveBytes: number;
  trashedFiles: number;
  trashedBytes: number;
}

type RankedAccount = Omit<AccountUsage, "name" | "email" | "tag">;

/**
 * Per-owner groups ordered by what they occupy, with the tail folded into one
 * row rather than dropped.
 *
 * Dropping it would make the column stop adding up to the total on the card
 * above, and a breakdown that does not reconcile is worse than no breakdown.
 * The orphan group (no owner) is kept separate wherever it lands: those bytes
 * belong to nobody, which is the whole reason they need looking at.
 */
export function rankAccounts(groups: OwnerGroup[], limit: number = ACCOUNT_LIMIT): RankedAccount[] {
  const rows: RankedAccount[] = groups
    .map((g) => ({
      id: g.ownerId,
      orphaned: g.ownerId === null,
      rest: false,
      accounts: 1,
      liveFiles: g.liveFiles,
      liveBytes: g.liveBytes,
      trashedFiles: g.trashedFiles,
      trashedBytes: g.trashedBytes,
    }))
    .sort((a, b) => b.liveBytes + b.trashedBytes - (a.liveBytes + a.trashedBytes));

  if (rows.length <= limit) return rows;

  const head = rows.slice(0, limit);
  const tail = rows.slice(limit);
  head.push(
    tail.reduce<RankedAccount>(
      (sum, r) => ({
        id: null,
        orphaned: false,
        rest: true,
        accounts: sum.accounts + 1,
        liveFiles: sum.liveFiles + r.liveFiles,
        liveBytes: sum.liveBytes + r.liveBytes,
        trashedFiles: sum.trashedFiles + r.trashedFiles,
        trashedBytes: sum.trashedBytes + r.trashedBytes,
      }),
      {
        id: null,
        orphaned: false,
        rest: true,
        accounts: 0,
        liveFiles: 0,
        liveBytes: 0,
        trashedFiles: 0,
        trashedBytes: 0,
      },
    ),
  );
  return head;
}
