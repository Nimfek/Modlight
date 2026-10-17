/**
 * Read models and maintenance probes for the admin panel.
 *
 * Deliberately free of `import "server-only"`: the pure helpers at the bottom
 * (confirmation parsing, key normalisation) are unit-tested, and vitest cannot
 * import a module that server-only poisons. Nothing here is importable from a
 * client bundle anyway — it pulls in `node:fs` and the database pool.
 */
import { readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { asc, count, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiTokens, folders, shortLinks, uploads, user as users } from "@/lib/db/schema";
import { config } from "@/lib/config";
import { storageFilesystemSpace, type FilesystemSpace } from "@/lib/upload/disk";
import { DERIVED_PREFIX } from "@/lib/media/derived-cache";
import { BACKGROUND_PREFIX } from "@/lib/background";
import { AVATAR_PREFIX } from "@/lib/avatar";

// ---------------------------------------------------------------------------
// Orphaned uploads — files whose owning account was deleted with "keep files"
// ---------------------------------------------------------------------------

export interface OrphanSummary {
  /** Rows with no owner, trash included (they still occupy disk). */
  files: number;
  bytes: number;
  /** How many of those are also sitting in the trash. */
  trashed: number;
  /** Upload date of the oldest / newest orphan, ISO, or null when there are none. */
  oldest: string | null;
  newest: string | null;
}

export interface OrphanRow {
  id: string;
  code: string;
  filename: string;
  ext: string;
  mimeType: string;
  size: number;
  storageKey: string;
  /** ISO — server actions may only hand plain data to the client. */
  createdAt: string | null;
  deletedAt: string | null;
}

const EMPTY_ORPHAN_SUMMARY: OrphanSummary = {
  files: 0,
  bytes: 0,
  trashed: 0,
  oldest: null,
  newest: null,
};

/**
 * Headline numbers for the "Orphaned files" section.
 *
 * One aggregate query rather than a listing the browser counts: production
 * carries ~8.6k uploads, and the summary has to stay cheap enough to render on
 * every visit to the admin page.
 */
export async function orphanSummary(): Promise<OrphanSummary> {
  const [row] = await db
    .select({
      files: sql<number>`count(*)::int`,
      bytes: sql<string>`coalesce(sum(${uploads.size}), 0)`,
      trashed: sql<number>`(count(*) filter (where ${uploads.deletedAt} is not null))::int`,
      oldest: sql<Date | null>`min(${uploads.createdAt})`,
      newest: sql<Date | null>`max(${uploads.createdAt})`,
    })
    .from(uploads)
    .where(isNull(uploads.ownerId));

  if (!row) return EMPTY_ORPHAN_SUMMARY;

  return {
    files: Number(row.files ?? 0),
    bytes: Number(row.bytes ?? 0),
    trashed: Number(row.trashed ?? 0),
    oldest: isoOrNull(row.oldest),
    newest: isoOrNull(row.newest),
  };
}

/** Cap on how many orphan rows travel to the browser at once. */
export const ORPHAN_PAGE_SIZE = 200;

/** Oldest first: an orphan that has been sitting there for a year is the story. */
export async function listOrphans(limit = ORPHAN_PAGE_SIZE): Promise<OrphanRow[]> {
  const rows = await db
    .select({
      id: uploads.id,
      code: uploads.code,
      filename: uploads.filename,
      ext: uploads.ext,
      mimeType: uploads.mimeType,
      size: uploads.size,
      storageKey: uploads.storageKey,
      createdAt: uploads.createdAt,
      deletedAt: uploads.deletedAt,
    })
    .from(uploads)
    .where(isNull(uploads.ownerId))
    .orderBy(asc(uploads.createdAt))
    .limit(Math.min(ORPHAN_PAGE_SIZE, Math.max(1, limit)));

  return rows.map((r) => ({
    ...r,
    size: Number(r.size ?? 0),
    createdAt: isoOrNull(r.createdAt),
    deletedAt: isoOrNull(r.deletedAt),
  }));
}

// ---------------------------------------------------------------------------
// Server disk — how full the machine is, not just how full an account is
// ---------------------------------------------------------------------------

export interface ServerStorageUsage {
  /** Where the bytes actually live. "s3" means the filesystem numbers are absent. */
  driver: string;
  /** Uploads that are not in the trash. */
  liveFiles: number;
  liveBytes: number;
  /** Soft-deleted uploads. Still on disk, but reclaimable — that is the point. */
  trashedFiles: number;
  trashedBytes: number;
  /** The filesystem holding storage, or null for an object store / a failed statfs. */
  disk: FilesystemSpace | null;
  /** Operator's floor, so the panel can say WHY a number is alarming. */
  minFreeBytes: number;
}

/**
 * Disk usage for the whole install: what the database accounts for, and what the
 * machine actually has left.
 *
 * The second half is the reason this exists. Per-account quota answers "is this
 * user over their limit"; it says nothing about the host, and this host runs ten
 * other production sites off the same disk. A full disk takes all of them down
 * at once, so the number an administrator needs is the filesystem's, measured
 * through the very same statfs the upload guard refuses 507s with.
 *
 * Orphans (owner deleted, files kept) are counted here even though the overview
 * tiles exclude them: they occupy disk exactly like any other file, and the
 * question this answers is "how much disk", not "whose disk".
 *
 * Says nothing about who may see it — like every read model in this module, the
 * caller does the guarding. Two callers do: the admin page, behind
 * `requireAdmin`, and `GET /api/admin/disk`, which the desktop client's
 * administration tab reads.
 *
 * That second one used to be forbidden here, on the grounds that the host's
 * free space is the operator's business and not an API client's. The ground
 * moved rather than the principle: when that was written every API token was
 * the whole account, so "over HTTP" meant "to every token anyone had minted".
 * Scoped tokens made "the operator" something a credential can actually be, and
 * the route demands both the `admin` scope and the admin role before it answers.
 */
export async function serverStorageUsage(): Promise<ServerStorageUsage> {
  const [[totals], disk] = await Promise.all([
    // One pass over ~8.6k rows with filtered aggregates. Live and trashed are
    // split here rather than by two queries so the two numbers can never be
    // read from different instants.
    db
      .select({
        liveFiles: sql<number>`(count(*) filter (where ${uploads.deletedAt} is null))::int`,
        liveBytes: sql<string>`coalesce(sum(${uploads.size}) filter (where ${uploads.deletedAt} is null), 0)`,
        trashedFiles: sql<number>`(count(*) filter (where ${uploads.deletedAt} is not null))::int`,
        trashedBytes: sql<string>`coalesce(sum(${uploads.size}) filter (where ${uploads.deletedAt} is not null), 0)`,
      })
      .from(uploads),
    storageFilesystemSpace(),
  ]);

  return {
    driver: config.storage.driver,
    liveFiles: Number(totals?.liveFiles ?? 0),
    liveBytes: Number(totals?.liveBytes ?? 0),
    trashedFiles: Number(totals?.trashedFiles ?? 0),
    trashedBytes: Number(totals?.trashedBytes ?? 0),
    disk,
    minFreeBytes: config.uploads.minFreeBytes,
  };
}

// ---------------------------------------------------------------------------
// Account deletion — what exactly is about to be destroyed
// ---------------------------------------------------------------------------

export interface UserDeletionImpact {
  id: string;
  email: string;
  name: string;
  tag: string | null;
  /** Uploads owned, trash included — those bytes are on disk either way. */
  files: number;
  bytes: number;
  trashed: number;
  /** Rows that always go with the account (FK cascade), shown so it isn't a surprise. */
  folders: number;
  shortLinks: number;
  tokens: number;
}

/**
 * Everything the "delete account" dialog has to state out loud before the admin
 * decides what happens to the files. Returns null when the account is gone.
 */
export async function userDeletionImpact(userId: string): Promise<UserDeletionImpact | null> {
  const [account] = await db
    .select({ id: users.id, email: users.email, name: users.name, tag: users.userCode })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!account) return null;

  const [[files], [folderCount], [linkCount], [tokenCount]] = await Promise.all([
    db
      .select({
        files: sql<number>`count(*)::int`,
        bytes: sql<string>`coalesce(sum(${uploads.size}), 0)`,
        trashed: sql<number>`(count(*) filter (where ${uploads.deletedAt} is not null))::int`,
      })
      .from(uploads)
      .where(eq(uploads.ownerId, userId)),
    db.select({ n: count() }).from(folders).where(eq(folders.ownerId, userId)),
    db.select({ n: count() }).from(shortLinks).where(eq(shortLinks.ownerId, userId)),
    db.select({ n: count() }).from(apiTokens).where(eq(apiTokens.userId, userId)),
  ]);

  return {
    id: account.id,
    email: account.email,
    name: account.name,
    tag: account.tag ?? null,
    files: Number(files?.files ?? 0),
    bytes: Number(files?.bytes ?? 0),
    trashed: Number(files?.trashed ?? 0),
    folders: Number(folderCount?.n ?? 0),
    shortLinks: Number(linkCount?.n ?? 0),
    tokens: Number(tokenCount?.n ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Maintenance — quota recalculation
// ---------------------------------------------------------------------------

export interface QuotaRecalcRow {
  id: string;
  email: string;
  before: number;
  after: number;
}

export interface QuotaRecalcResult {
  accounts: number;
  /** Accounts whose stored counter disagreed with reality. */
  corrected: number;
  /** Signed byte delta applied across all accounts (negative = counter was too high). */
  drift: number;
  /** The corrected accounts, for the report. Capped — see MAX_RECALC_REPORT. */
  changes: QuotaRecalcRow[];
}

const MAX_RECALC_REPORT = 50;

/**
 * Recompute `used_quota` for EVERY account from the rows that actually exist.
 *
 * The counter is maintained incrementally (upload adds, permanent delete
 * subtracts), so it drifts whenever rows move out-of-band: a failed finalize, a
 * hand-written SQL fix, a bulk import, or an account deleted with its
 * files kept. Doing all accounts in one pass is the useful shape — after a
 * manual database operation you do not know which account was affected.
 *
 * Trashed files are counted on purpose: they still occupy disk until purged.
 * Orphans are excluded by construction — they group under a NULL owner, which
 * matches no account.
 */
export async function recalculateAllQuotas(): Promise<QuotaRecalcResult> {
  const [accounts, sums] = await Promise.all([
    db.select({ id: users.id, email: users.email, used: users.usedQuota }).from(users),
    db
      .select({ ownerId: uploads.ownerId, total: sql<string>`coalesce(sum(${uploads.size}), 0)` })
      .from(uploads)
      .where(isNotNull(uploads.ownerId))
      .groupBy(uploads.ownerId),
  ]);

  const actual = new Map<string, number>();
  for (const s of sums) if (s.ownerId) actual.set(s.ownerId, Number(s.total ?? 0));

  const changes: QuotaRecalcRow[] = [];
  let corrected = 0;
  let drift = 0;

  for (const account of accounts) {
    const before = Number(account.used ?? 0);
    const after = actual.get(account.id) ?? 0;
    if (before === after) continue;

    await db.update(users).set({ usedQuota: after }).where(eq(users.id, account.id));
    corrected++;
    drift += after - before;
    if (changes.length < MAX_RECALC_REPORT) {
      changes.push({ id: account.id, email: account.email, before, after });
    }
  }

  return { accounts: accounts.length, corrected, drift, changes };
}

// ---------------------------------------------------------------------------
// Maintenance — storage objects with no database row
// ---------------------------------------------------------------------------

export interface StorageOrphan {
  key: string;
  size: number;
  /** ISO mtime — how long the file has been lying around unreferenced. */
  modifiedAt: string | null;
}

export interface StorageScanResult {
  /** False when the configured driver cannot be walked (S3). */
  supported: boolean;
  /** Driver the scan ran against, for the report. */
  driver: string;
  /** Objects examined on disk. */
  scanned: number;
  /** Objects with no row in `uploads` (neither storageKey nor thumbKey). */
  orphans: number;
  orphanBytes: number;
  /** A sample of them, capped at MAX_STORAGE_ORPHAN_SAMPLE. */
  sample: StorageOrphan[];
  /** True when the walk hit its file ceiling and stopped early. */
  truncated: boolean;
  /** Files younger than the grace window that were skipped (likely in flight). */
  skippedRecent: number;
}

/** Never report an object younger than this — it may be mid-finalize. */
export const STORAGE_SCAN_GRACE_MS = 60 * 60 * 1000;

/**
 * Top-level storage trees that deliberately have no row in `uploads`.
 *
 * `derived/` holds cached conversions, keyed by content rather than by a row.
 * `backgrounds/` and `avatars/` hold per-account decoration, which is kept out
 * of `uploads` on purpose: it must not appear in a dashboard, count against a
 * quota, or be reachable at a /{tag}/{code} link. Each is freed by the feature
 * that wrote it (a replacement deletes its predecessor), so none of them is this
 * report's business.
 */
const UNTRACKED_PREFIXES = new Set([DERIVED_PREFIX, BACKGROUND_PREFIX, AVATAR_PREFIX]);

/** Hard ceiling on the walk, so one click can never wander off into a mount. */
const MAX_SCANNED_FILES = 250_000;

/** How many orphan keys travel to the browser. */
export const MAX_STORAGE_ORPHAN_SAMPLE = 100;

/**
 * Find bytes on disk that no `uploads` row points at.
 *
 * These are the mirror image of an orphaned row: an interrupted finalize, a row
 * deleted by hand, an import that half-ran. Nothing reads them and nothing will
 * ever free them, so they are pure dead weight on a VPS disk.
 *
 * Report only — deliberately no delete button. An upload that is being
 * finalised right now looks exactly like an orphan for a fraction of a second,
 * and "the admin panel ate my screenshot" is a far worse bug than some wasted
 * disk. The grace window below makes the report trustworthy; acting on it is a
 * deliberate, manual step.
 *
 * Local driver only: S3 listing is a paginated, billed API and belongs in a
 * background job, not in a page the admin clicks.
 */
export async function scanStorageOrphans(now: number = Date.now()): Promise<StorageScanResult> {
  const driver = config.storage.driver;
  if (driver !== "local") {
    return {
      supported: false,
      driver,
      scanned: 0,
      orphans: 0,
      orphanBytes: 0,
      sample: [],
      truncated: false,
      skippedRecent: 0,
    };
  }

  const root = resolve(config.storage.localPath);

  // Every key any row references — storageKey AND thumbKey, or every cached
  // thumbnail would be reported as garbage.
  const known = new Set<string>();
  const rows = await db
    .select({ storageKey: uploads.storageKey, thumbKey: uploads.thumbKey })
    .from(uploads);
  for (const r of rows) {
    known.add(normalizeKey(r.storageKey));
    if (r.thumbKey) known.add(normalizeKey(r.thumbKey));
  }

  let scanned = 0;
  let orphans = 0;
  let orphanBytes = 0;
  let truncated = false;
  let skippedRecent = 0;
  const sample: StorageOrphan[] = [];

  const queue: string[] = [root];
  while (queue.length > 0) {
    const dir = queue.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Storage root missing (fresh install) or unreadable — nothing to report.
      continue;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Top-level trees that no `uploads` row will ever point at, so every
        // single object under them would be reported as garbage. Each is owned
        // and cleaned up by its own feature, and a report that lists every
        // account's wallpaper as dead weight is a report the operator learns to
        // ignore.
        if (dir === root && UNTRACKED_PREFIXES.has(entry.name)) continue;
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;

      if (scanned >= MAX_SCANNED_FILES) {
        truncated = true;
        queue.length = 0;
        break;
      }
      scanned++;

      const key = toStorageKey(root, full);
      if (!key || known.has(key)) continue;

      let info;
      try {
        info = await stat(full);
      } catch {
        continue; // vanished between readdir and stat — that is fine
      }

      if (now - info.mtimeMs < STORAGE_SCAN_GRACE_MS) {
        skippedRecent++;
        continue;
      }

      orphans++;
      orphanBytes += info.size;
      if (sample.length < MAX_STORAGE_ORPHAN_SAMPLE) {
        sample.push({ key, size: info.size, modifiedAt: new Date(info.mtimeMs).toISOString() });
      }
    }
  }

  return { supported: true, driver, scanned, orphans, orphanBytes, sample, truncated, skippedRecent };
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested — keep free of I/O)
// ---------------------------------------------------------------------------

/**
 * Storage keys are stored with forward slashes ("tag/code.png") on every
 * platform; the filesystem walk hands back native separators. Normalising both
 * sides is what keeps the scan from reporting every single file as an orphan on
 * Windows.
 */
export function normalizeKey(key: string): string {
  return key.split(sep).join("/").replace(/^\.?\/+/, "");
}

/** Relative storage key for an absolute path under `root`, or null if outside it. */
export function toStorageKey(root: string, absolutePath: string): string | null {
  const normalizedRoot = root.endsWith(sep) ? root.slice(0, -sep.length) : root;
  if (!absolutePath.startsWith(normalizedRoot + sep)) return null;
  return normalizeKey(absolutePath.slice(normalizedRoot.length + sep.length));
}

// The typed-confirmation rule lives in components/admin/confirm.ts: the dialog
// and the Server Action both need it, and a value imported from this module
// would drag `node:fs` and the database pool into the client bundle.

/** Date → ISO for the client boundary, tolerating the null the aggregates return. */
function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

