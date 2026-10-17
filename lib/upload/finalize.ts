import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { uploads, user as users } from "@/lib/db/schema";
import { getStorage, readHead } from "@/lib/storage";
import { resolveUploadType } from "@/lib/media/sniff";
import { freeBytesForUploads, fitsOnDisk, sameFilesystem } from "@/lib/upload/disk";
import { config } from "@/lib/config";
import { secureToken, slugify } from "@/lib/ids";
import { allocateCode, isNamingScheme, isReservedTag, planCode } from "@/lib/naming";
import {
  extOf,
  storageKeyFor,
  mediaUrls,
  deleteUrl,
  userBaseUrl,
} from "@/lib/media/urls";
import { imageMetaFromBuffer } from "@/lib/media/image";
import { probeStoredAvMeta } from "@/lib/media/av-meta";
import { mediaKind } from "@/lib/media/mime";
import type { UserRow } from "@/lib/api-token";

export class QuotaExceededError extends Error {
  constructor() {
    super("User disk quota exceeded.");
  }
}

/**
 * Raised when the host is running out of room, regardless of the user's quota.
 *
 * Quotas protect users from each other; this protects the machine from all of
 * them. A full filesystem does not fail politely — it takes down every database
 * on the box and corrupts whatever backup happens to be mid-write.
 */
export class OutOfSpaceError extends Error {
  constructor() {
    super("Server is low on disk space; upload rejected.");
  }
}
export class CodeTakenError extends Error {
  constructor() {
    super("Custom url code already exists.");
  }
}

export interface FinalizeInput {
  owner: UserRow;
  filename: string;
  /** What the CLIENT claimed. The stored type is decided here — see below. */
  mime: string;
  size: number;
  /**
   * First bytes of the payload, when the caller already had them in hand.
   * Optional: without it the header is re-read from storage, which is one
   * 4 KiB ranged read.
   */
  head?: Buffer;
  /** Temp file to ingest (busboy / local tus). */
  localPath?: string;
  /** Already in storage at this key (e.g. S3 tus) — used as-is, no copy. */
  existingKey?: string;
  /** Optional precomputed sha256. */
  checksum?: string;
  /** Optional ShareX custom URL code. */
  customCode?: string;
  /**
   * Where the file should land, ALREADY checked against the owner.
   *
   * `undefined` keeps the historical behaviour (the account's default folder);
   * `null` means the root. Callers must pass the result of
   * `resolveFolderTarget` — this function does no ownership check of its own,
   * because by the time it runs the bytes are already stored and refusing here
   * would mean throwing away a completed upload.
   */
  folderId?: string | null;
}

export interface FinalizeResult {
  id: string;
  code: string;
  ext: string;
  storageKey: string;
  url: string;
  rawUrl: string;
  deletionUrl: string;
  /**
   * The link a client should put on the clipboard.
   *
   * Decided HERE, from `user.copy_raw`, rather than left to each client. That
   * preference already exists in the profile and already governs the panel and
   * ShareX; a second client re-implementing the choice would mean the same
   * account copying two different shapes of link depending on which app it came
   * from, and flipping the switch in the panel would silently not apply to one
   * of them.
   */
  copyUrl: string;
  /** Folder the row ended up in (null = root), for clients that chose one. */
  folderId: string | null;
}

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

/** The quota-relevant slice of a user row (kept narrow so it is easy to test). */
export interface QuotaHolder {
  usedQuota?: number | null;
  maxQuota?: number | null;
}

/**
 * Bytes this user may still store, or `null` when they are unlimited.
 * `maxQuota === -1` (and NULL, for rows predating the column) means unlimited —
 * the convention every stored account relies on.
 */
export function remainingQuota(owner: QuotaHolder): number | null {
  const max = owner.maxQuota ?? -1;
  if (max < 0) return null;
  return Math.max(0, max - (owner.usedQuota ?? 0));
}

/** Whether an upload of `size` bytes fits, given the same conventions. */
export function quotaFits(owner: QuotaHolder, size: number): boolean {
  const left = remainingQuota(owner);
  return left === null || size <= left;
}

/**
 * Reserve `size` bytes against the owner's quota, atomically.
 *
 * Reading the quota and then incrementing it are two statements, and two
 * concurrent uploads (ShareX fires several at once) can both read the same
 * "before" value and both pass — that is how a 20 GiB account ends up at 35 GiB.
 * Folding the predicate into the UPDATE's WHERE clause makes Postgres evaluate
 * it against the row it is about to lock, so exactly one of the racers wins.
 * Zero rows returned means the reservation was refused.
 *
 * Quotas are bigint columns; the arithmetic below stays in Postgres so it never
 * round-trips through a JS number that could lose precision at extreme sizes.
 */
async function reserveQuota(userId: string, size: number): Promise<void> {
  const reserved = await db
    .update(users)
    .set({ usedQuota: sql`coalesce(${users.usedQuota}, 0) + ${size}` })
    .where(
      and(
        eq(users.id, userId),
        sql`(
          ${users.maxQuota} is null
          or ${users.maxQuota} < 0
          or coalesce(${users.usedQuota}, 0) + ${size} <= ${users.maxQuota}
        )`,
      ),
    )
    .returning({ usedQuota: users.usedQuota });

  if (reserved.length === 0) throw new QuotaExceededError();
}

/**
 * Bytes the ingest is still going to consume on the storage filesystem.
 *
 * By the time finalize runs, the payload is ALREADY on disk: busboy streamed it
 * into `data/tmp`, tus into `data/tus`. When that scratch area shares a
 * filesystem with storage, `LocalDriver.ingestLocalFile` moves it with
 * `rename()`, which costs nothing — charging the file's size a second time here
 * would reject a fully transferred 20 GB file on a disk that has room for it.
 * That is the "the panel ate my upload and refused it at the very end" failure,
 * and it is the worst one we can produce: an hour of the user's uplink spent to
 * be told no.
 *
 * A cross-device ingest is a real copy, so there the full size is charged.
 */
async function pendingWriteCost(input: FinalizeInput): Promise<number> {
  if (!input.localPath) return 0; // already in storage (S3 tus): nothing to write
  return (await sameFilesystem(input.localPath, config.storage.localPath)) ? 0 : input.size;
}

/**
 * Refuse an upload that would leave the filesystem with less than
 * `config.uploads.minFreeBytes` to spare.
 *
 * Only meaningful for the local driver — with S3 the bytes are somebody else's
 * problem. `statfs` is a cheap syscall, so this runs per upload rather than on
 * a timer, which is what makes it correct under a burst of concurrent uploads
 * rather than merely approximately right.
 *
 * With `cost` at 0 (the usual same-filesystem move) this still fires when the
 * disk is already below the reserve, which is the emergency the guard is for.
 */
async function assertDiskHeadroom(cost: number): Promise<void> {
  if (config.storage.driver !== "local") return;
  const floor = config.uploads.minFreeBytes;
  if (floor <= 0) return;

  if (!fitsOnDisk(cost, await freeBytesForUploads(), floor)) throw new OutOfSpaceError();
}

/** Give a reservation back when the upload it was made for never landed. */
async function releaseQuota(userId: string, size: number): Promise<void> {
  await db
    .update(users)
    .set({ usedQuota: sql`greatest(coalesce(${users.usedQuota}, 0) - ${size}, 0)` })
    .where(eq(users.id, userId));
}

// ---------------------------------------------------------------------------
// Code allocation
// ---------------------------------------------------------------------------

/**
 * Clean a client-supplied code down to something safe to put in a URL.
 *
 * Returns "" when nothing usable survives, or when the result would shadow an
 * application route — with `skipTagInUrl` a code occupies the root namespace, so
 * a code of `login` is not a naming question but an availability one.
 */
function sanitizeCustomCode(raw: string): string {
  const clean = slugify(raw).slice(0, 60);
  if (!clean || clean.length < 1) return "";
  return isReservedTag(clean) ? "" : clean;
}

async function codeIsTaken(candidate: string): Promise<boolean> {
  const hit = await db
    .select({ id: uploads.id })
    .from(uploads)
    .where(eq(uploads.code, candidate))
    .limit(1);
  return hit.length > 0;
}

/**
 * Allocate the public code for a new upload according to the owner's naming
 * scheme. Existing uploads are untouched — their code is already persisted, so
 * switching schemes never invalidates a link that is already in circulation.
 *
 * Exported because a conversion made as a COPY creates a genuinely new file and
 * must name it the same way an upload would (lib/media/convert-in-place.ts).
 * Re-implementing the scheme there would be a second answer to a question that
 * already has one.
 */
export async function allocateCodeFor(owner: UserRow, filename: string): Promise<string> {
  const scheme = isNamingScheme(owner.namingScheme) ? owner.namingScheme : "random";
  // `planCode` carries the collision strategy along with the first candidate:
  // name-derived schemes walk a `-2`, `-3` ladder, while the randomised ones
  // (words / unambiguous characters) draw a fresh, WIDER code instead — a
  // suffix on a random code advertises the collision without addressing it.
  const plan = planCode({
    scheme,
    pattern: owner.namingPattern,
    filename,
    wordCount: owner.namingWordCount,
    randomLength: owner.namingRandomLength,
  });
  return allocateCode(plan.base, codeIsTaken, plan.regenerate);
}

// ---------------------------------------------------------------------------
// Default file password
// ---------------------------------------------------------------------------

/** What a new upload inherits from the owner's default-password setting. */
interface DefaultPassword {
  passwordHash: string | null;
  passwordVersion: number | null;
}

/**
 * Stamp the owner's default password onto a new upload, if they have one.
 *
 * The hash is COPIED, not referenced: an owner who later changes their default
 * must not silently change the password of every link they have already shared.
 * The generation number travels with it so the viewer can tell "this file is on
 * the account default" from "somebody typed a password for this one file" —
 * only the former is opened by a recipient's remembered consent.
 *
 * Runs for every path into the app (ShareX and the resumable web upload both
 * finalize here), so there is no route that quietly produces an unprotected
 * file while the switch is on.
 */
function defaultPasswordFor(owner: UserRow): DefaultPassword {
  const hash = owner.defaultPasswordHash ?? null;
  if (!hash) return { passwordHash: null, passwordVersion: null };
  return { passwordHash: hash, passwordVersion: owner.defaultPasswordVersion ?? 0 };
}

// ---------------------------------------------------------------------------
// Finalize
// ---------------------------------------------------------------------------

/**
 * The single finalize pipeline shared by the ShareX (busboy) and web (tus) paths.
 *
 * Ordering is deliberate: the quota reservation happens BEFORE any bytes move,
 * and every step after it is undone on failure. Previously a crash between the
 * storage write and the DB insert left a file nobody could see or delete, and a
 * crash after the insert left the quota un-incremented.
 */
export async function finalizeUpload(input: FinalizeInput): Promise<FinalizeResult> {
  const { owner, filename, size } = input;

  // 1) code (custom or generated) — no side effects, so it comes first
  const ext = extOf(filename);
  let code: string;
  if (input.customCode) {
    // ShareX lets the client pick the code. It lands in a URL, in a storage key
    // and in a globally-unique column, so it gets the same treatment as a vanity
    // code set from the dashboard — anything else and a `code` of "a/b" creates
    // a row whose own URL cannot address it.
    const custom = sanitizeCustomCode(input.customCode);
    if (!custom) throw new CodeTakenError();
    if (await codeIsTaken(custom)) throw new CodeTakenError();
    code = custom;
  } else {
    code = await allocateCodeFor(owner, filename);
  }

  // 2) host headroom — checked before the per-user quota, because a full disk
  //    hurts every application on the machine, not just this account. Only the
  //    bytes still to be WRITTEN count; see pendingWriteCost.
  await assertDiskHeadroom(await pendingWriteCost(input));

  // 3) quota — atomic reserve; throws QuotaExceededError when it doesn't fit
  await reserveQuota(owner.id, size);

  const storage = getStorage();
  const storageKey = input.existingKey ?? storageKeyFor(owner.userCode ?? "u", code, ext);
  let wroteBytes = false;

  try {
    // 3) ingest bytes
    if (!input.existingKey) {
      if (!input.localPath) throw new Error("finalizeUpload: no source provided");
      await storage.ingestLocalFile(input.localPath, storageKey);
      wroteBytes = true;
    }

    // 4) what the file actually IS.
    //
    // The stored type used to be whatever the client sent, and on Windows that
    // is a registry lookup which has no entry for anything modern: ShareX
    // uploads a .avif and we record `application/octet-stream`, which costs the
    // file its preview, its inline display and its "download as". Deciding it
    // here rather than in each caller fixes both upload paths at once - and
    // every future one - and keeps the serving layer a pure function of the row.
    const head = input.head?.length ? input.head : await readHead(storageKey, 4096);
    const mime = resolveUploadType({ clientMime: input.mime, filename, head });

    // 5) image metadata (best-effort, small images only). Keyed off the RESOLVED
    // type, or the file this whole change is about still gets no dimensions.
    let width: number | undefined;
    let height: number | undefined;
    let blurhash: string | undefined;
    let frames: number | undefined;
    if (mime.startsWith("image/") && size <= 64 * 1024 * 1024) {
      try {
        const buf = await storage.readBuffer(storageKey);
        const meta = await imageMetaFromBuffer(buf);
        width = meta.width;
        height = meta.height;
        blurhash = meta.blurhash;
        // Counted once, here, so "Download as…" never has to guess whether this
        // particular WebP holds an animation. See uploads.frames.
        frames = meta.frames;
      } catch {
        /* non-fatal */
      }
    }

    // 5b) audio/video metadata, from the same ffprobe the conversion path uses.
    //
    // Nothing ever wrote these: production carried 467 videos and NOT ONE had a
    // width, because Round 8's backfill only ever looked at images. So a video
    // tile could not be laid out from its row, a Discord embed advertised a
    // hardcoded 1280x720 for a 5056x1924 recording, and there was no way to tell
    // a 4K capture from a phone clip without opening the file.
    //
    // Affordable because a probe is a SEEK, not a decode: measured across 59
    // production videos it is 136 ms median, of which 120 ms is the cost of
    // spawning ffprobe at all, and the largest file on the box (419 MB) came
    // back in 144 ms. It also never reads the bytes into memory, which is why
    // there is no size ceiling here the way there is on the image branch above.
    //
    // It DELAYS the response, though, which is the one cost worth naming: the
    // 201 a ShareX client is waiting on now comes after a probe. Measured p90
    // cold is 271 ms and the worst of the 59 was 2789 ms, against the 10 s
    // ceiling AV_PROBE_TIMEOUT_MS puts on it. Deliberately NOT behind the
    // transform limiter (lib/media/transform-queue.ts): a slot is held for
    // seconds by a conversion, and making an upload queue behind one would
    // trade a rare 3 s for a routine one on the path this project treats as
    // priority number one.
    //
    // Best-effort in the strongest sense: `probeStoredAvMeta` cannot throw and
    // returns null for a timeout, a missing ffmpeg, an unreadable file or a
    // remote driver with nothing local to point at. The payload is already on
    // disk by this line; losing it over a metadata read would be indefensible,
    // and the row simply keeps the NULLs it would have had anyway until
    // scripts/backfill-av-metadata.ts comes past.
    let durationSeconds: number | undefined;
    let fps: number | undefined;
    const avKind = mediaKind(mime, ext);
    if (avKind === "video" || avKind === "audio") {
      const meta = await probeStoredAvMeta(storageKey);
      if (meta) {
        width = meta.width ?? undefined;
        height = meta.height ?? undefined;
        // Counted frames only; see AvMeta.frames. For audio this stays absent,
        // because cover art is not a frame of anything.
        frames = meta.frames ?? undefined;
        durationSeconds = meta.durationSeconds ?? undefined;
        fps = meta.fps ?? undefined;
      }
    }

    // 6) DB row. File *type* is derived from mimeType at read time — there is no
    // tag table to keep in sync any more.
    const deleteToken = secureToken(16);
    const { passwordHash, passwordVersion } = defaultPasswordFor(owner);
    const [row] = await db
      .insert(uploads)
      .values({
        ownerId: owner.id,
        code,
        filename,
        ext,
        mimeType: mime,
        size,
        storageKey,
        checksum: input.checksum ?? null,
        width,
        height,
        frames,
        durationSeconds,
        fps,
        blurhash,
        published: owner.hideUploads ? false : true,
        deleteToken,
        // Account default file password, or nothing at all. See
        // defaultPasswordFor() for why the hash is copied per file.
        passwordHash,
        passwordVersion,
        // Land in the owner's chosen folder. The column is set with an
        // ownership check in app/actions/account.ts, and the FK is ON DELETE
        // SET NULL, so a folder deleted in the meantime simply means "no
        // folder" rather than a failed upload.
        // An explicit target wins; without one the account default stands. The
        // FK is ON DELETE SET NULL, so a folder deleted in the meantime means
        // "no folder" rather than a failed upload.
        folderId: input.folderId !== undefined ? input.folderId : (owner.defaultFolderId ?? null),
      })
      .returning();

    const uc = owner.userCode ?? "u";
    const base = userBaseUrl(owner.preferredDomain);

    // The owner's hostname and their tagless-link preference both live in
    // `mediaUrls` (lib/media/urls.ts), which is also what the listing API builds
    // from - so what ShareX puts on the clipboard and what the desktop client
    // shows for the same file are the same string by construction.
    const { url: pageUrl, rawUrl: directUrl } = mediaUrls(owner, code, ext);
    return {
      id: row.id,
      code,
      ext,
      storageKey,
      url: pageUrl,
      rawUrl: directUrl,
      copyUrl: owner.copyRaw ? directUrl : pageUrl,
      folderId: row.folderId ?? null,
      // The deletion link always carries the tag: it is not a link anyone
      // shares, and keeping one shape makes the route unambiguous.
      deletionUrl: deleteUrl(uc, code, deleteToken, base),
    };
  } catch (err) {
    // Unwind in reverse. Only bytes WE wrote are removed: with `existingKey` the
    // object is still the upload's own tus artifact, and the client may resume
    // onto it.
    if (wroteBytes) {
      await storage.delete(storageKey).catch((e) => {
        console.error("[finalize] orphaned object left in storage:", storageKey, e);
      });
    }
    await releaseQuota(owner.id, size).catch((e) => {
      console.error("[finalize] could not release quota reservation:", owner.id, e);
    });
    throw err;
  }
}
