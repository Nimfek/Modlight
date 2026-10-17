/**
 * Converting a file that already exists - either rewriting its bytes in place,
 * or producing a second file beside it.
 *
 * Deliberately a separate module from the /convert route. That endpoint READS: a
 * public visitor asks for a copy in another format and the stored file is never
 * touched. This one WRITES, destructively in `replace` mode, and the two must
 * not share a code path where a later edit could confuse them.
 *
 * ORDER OF OPERATIONS, and it is the whole design:
 *
 *   1. row, authorization, state gates, target admission   (no side effects)
 *   2. size ceiling, disk headroom                         (cheap refusals)
 *   3. limiter slot                                        (shared with /convert)
 *   4. produce the result into a buffer or a scratch file
 *   5. write it under a NEW storage key, and stat it back
 *   6. one transaction: lock the row, charge the quota, rewrite the row
 *   7. only then: drop the old bytes and the derived cache
 *
 * No step can leave a row pointing at bytes that do not exist. The row moves
 * only onto a key that has already been written AND verified, and the old object
 * is removed only after the row has stopped referring to it. Every failure in
 * between leaves at most an orphaned object on disk, which the admin's stray
 * file scan already reports (lib/data/admin.ts), and never a broken link.
 *
 * WHAT MAKES THIS SAFE FOR LINKS: `code` is not touched. The extension in a
 * public URL is decorative - the lookup strips it (lib/media/paths.ts) - so
 * /{tag}/{code}.mp4 keeps resolving to the row that now holds a GIF, and because
 * the code stays on this row for as long as the row exists it can never be
 * re-issued to somebody else's file.
 */

import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat as statFile } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { uploads, user as users } from "@/lib/db/schema";
import { getStorage } from "@/lib/storage";
import { config } from "@/lib/config";
import { fitsOnDisk, freeBytesForUploads } from "@/lib/upload/disk";
import { secureToken } from "@/lib/ids";
import { allocateCodeFor } from "@/lib/upload/finalize";
import { storageKeyFor } from "@/lib/media/urls";
import { suffixKey, swapFilenameExt, swapKeyExt } from "@/lib/media/paths";
import { imageMetaFromBuffer } from "@/lib/media/image";
import { probeImage } from "@/lib/media/probe";
import { conversionBudget, convertImageBuffer } from "@/lib/media/convert";
import { isConvertTarget, type ConvertTarget } from "@/lib/media/convert-targets";
import {
  audioCopyableTo,
  avOptionFor,
  type AvOption,
  type AvSourceKind,
} from "@/lib/media/av-targets";
import { probeAv } from "@/lib/media/av-probe";
import { totalSourcePixels } from "@/lib/media/av-meta";
import { planAv, runAvPlan } from "@/lib/media/av-convert";
import { openAvWorkspace } from "@/lib/media/av-workspace";
import { ffmpegAvailable } from "@/lib/media/ffmpeg";
import {
  AV_MAX_INPUT_BYTES,
  AV_PROBE_TIMEOUT_MS,
  AV_WEIGHT,
  avBudget,
  avTimeoutFor,
} from "@/lib/media/av-cost";
import {
  CONVERT_TIMEOUT_MS,
  CONVERT_WEIGHT,
  MAX_TRANSFORM_BYTES,
} from "@/lib/media/transform-cost";
import {
  AbortedError,
  BusyError,
  imageTransforms,
  TimeoutError,
} from "@/lib/media/transform-queue";
import { purgeDerived } from "@/lib/media/derived-cache";
import { mediaKind } from "@/lib/media/mime";
import {
  conversionRowPatch,
  planConversion,
  quotaDeltaFor,
  type ConvertedBytes,
  type ConvertFailure,
  type ConvertMode,
  type ConvertOutcome,
} from "@/lib/media/convert-plan";

type UploadRow = typeof uploads.$inferSelect;

/** Who is asking. `role` comes from the session, never from the caller's input. */
export interface ConvertActor {
  id: string;
  role?: string | null;
}

export interface ConvertInPlaceInput {
  uploadId: string;
  /** A target name from the same table the menu renders. */
  to: string;
  mode: ConvertMode;
  actor: ConvertActor;
  signal?: AbortSignal;
}

/**
 * Largest result we will read back into memory to measure (dimensions, frame
 * count, blurhash). Above it the picture metadata is simply left unknown, which
 * is a column the whole app already treats as normal - every imported row carries NULL
 * there.
 */
const IMAGE_META_MAX_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function convertUploadInPlace(
  input: ConvertInPlaceInput,
): Promise<ConvertOutcome> {
  const { uploadId, to, mode, actor } = input;

  const rows = await db.select().from(uploads).where(eq(uploads.id, uploadId)).limit(1);
  const media = rows[0];
  if (!media) return failed(uploadId, "not-found");

  // Owner or admin, exactly as every other write action in the panel decides it
  // (app/actions/uploads.ts). An orphaned upload - one whose account was deleted
  // with "keep the files" - belongs to nobody, so only an admin may touch it.
  const isAdmin = actor.role === "admin";
  if (!isAdmin && (!media.ownerId || media.ownerId !== actor.id)) {
    return failed(uploadId, "forbidden");
  }

  const plan = planConversion(media, to, mode);
  if (!plan.ok) return { status: "skipped", uploadId, reason: plan.reason };

  // A copy is a NEW file: it needs a code under an owner's tag and its bytes are
  // charged to an owner's quota. An orphan has neither, so there is nothing
  // sensible to create.
  if (mode === "copy" && !media.ownerId) return failed(uploadId, "forbidden");

  const limit = plan.engine === "av" ? AV_MAX_INPUT_BYTES : MAX_TRANSFORM_BYTES;
  if (media.size > limit) return failed(uploadId, "too-large");

  // The result's size is not knowable before it exists, so the source's size is
  // the estimate. It is the right one for a container copy (measured within 2%),
  // generous for the conversions that shrink a file, and optimistic only for the
  // ones that grow it - which is why the real size is checked again against the
  // disk immediately before the write.
  if (!(await hasHeadroom(media.size))) return failed(uploadId, "no-space");

  const option =
    plan.engine === "av"
      ? avOptionFor(media.mimeType, media.ext, media.frames, to, media)
      : null;
  if (plan.engine === "av" && !option) return failed(uploadId, "unsupported-target");
  if (plan.engine === "image" && !isConvertTarget(to)) return failed(uploadId, "unsupported-target");

  let produced: Produced | { error: ConvertFailure };
  try {
    produced = await imageTransforms.run(
      (signal) =>
        option
          ? produceAv(media, option, signal)
          : produceImage(media, to as ConvertTarget, signal),
      {
        weight: option ? AV_WEIGHT : CONVERT_WEIGHT,
        timeoutMs: option ? avTimeoutFor(option.to, option.cost) : CONVERT_TIMEOUT_MS,
        signal: input.signal,
      },
    );
  } catch (err) {
    return failed(uploadId, limiterFailure(err));
  }

  if ("error" in produced) return failed(uploadId, produced.error);

  try {
    return mode === "copy"
      ? await commitCopy(media, produced)
      : await commitReplace(media, produced);
  } finally {
    await produced.dispose();
  }
}

// ---------------------------------------------------------------------------
// Producing the bytes
// ---------------------------------------------------------------------------

/**
 * A finished result, not yet in storage.
 *
 * Either a buffer (libvips, bounded by MAX_TRANSFORM_BYTES on the way in) or a
 * scratch file (ffmpeg, whose outputs are as large as their sources and must
 * never be materialised in a 2 GiB container).
 */
interface Produced {
  buffer?: Buffer;
  path?: string;
  size: number;
  checksum: string;
  mime: string;
  ext: string;
  width: number | null;
  height: number | null;
  frames: number | null;
  durationSeconds: number | null;
  fps: number | null;
  blurhash: string | null;
  /** Something true about the result that was not asked for. */
  note?: string;
  dispose(): Promise<void>;
}

async function produceImage(
  media: UploadRow,
  to: ConvertTarget,
  signal: AbortSignal,
): Promise<Produced | { error: ConvertFailure }> {
  const src = await getStorage().readBuffer(media.storageKey);

  // Ask libvips whether it can open this at all before committing to the work,
  // so a format we merely classify as an image fails as "this cannot be
  // converted" rather than as a thrown encoder.
  const probe = await probeImage(src);
  if (!probe) return { error: "encoder" };

  const budget = conversionBudget(probe, to);
  if (!budget.ok) return { error: "too-large" };

  const { buffer, mime, ext } = await convertImageBuffer(probe.input, to, {
    animated: budget.animated,
    timeoutMs: CONVERT_TIMEOUT_MS,
    signal,
  });

  const meta = mime.startsWith("image/") ? await imageMetaFromBuffer(buffer) : {};
  return {
    buffer,
    size: buffer.length,
    checksum: createHash("sha256").update(buffer).digest("hex"),
    mime,
    ext,
    width: meta.width ?? null,
    height: meta.height ?? null,
    frames: meta.frames ?? null,
    // A still or an animation has no playing time and no frame rate in the
    // sense these columns mean, and the source's would be a leftover.
    durationSeconds: null,
    fps: null,
    blurhash: meta.blurhash ?? null,
    dispose: async () => {},
  };
}

async function produceAv(
  media: UploadRow,
  option: AvOption,
  signal: AbortSignal,
): Promise<Produced | { error: ConvertFailure }> {
  if (!(await ffmpegAvailable())) return { error: "encoder" };

  const opened = await openAvWorkspace(media.storageKey, AV_MAX_INPUT_BYTES);
  if ("error" in opened) {
    return { error: opened.error === "missing" ? "storage" : "too-large" };
  }
  const ws = opened;

  try {
    const probe = await probeAv(ws.input, { timeoutMs: AV_PROBE_TIMEOUT_MS, signal });
    if (!probe) {
      await ws.dispose();
      return { error: "encoder" };
    }

    const sourceKind = sourceKindOf(media);
    const budget = avBudget(
      option.to,
      option.cost,
      {
        bytes: media.size,
        duration: probe.duration,
        sourceKind,
        audioCopyable: audioCopyableTo("mp4", probe.audio?.codec),
        pixels: totalSourcePixels(probe),
      },
      // No caller-chosen clip: an in-place conversion has no query string to take
      // one from, so the defaults in av-cost.ts apply and the UI states them.
      null,
    );
    if (!budget.ok) {
      await ws.dispose();
      return { error: "too-large" };
    }

    const plan = planAv({
      option,
      probe,
      sourceKind,
      workspace: ws,
      clipSeconds: budget.clipSeconds,
      offsetSeconds: null,
    });
    if ("refuse" in plan) {
      await ws.dispose();
      return { error: "encoder" };
    }

    await runAvPlan(plan, signal);

    const produced = await statFile(plan.outputPath);
    if (!produced.isFile() || produced.size === 0) {
      await ws.dispose();
      return { error: "encoder" };
    }

    const checksum = await hashFile(plan.outputPath);

    // When the picture was re-encoded, the source probe has stopped describing
    // the result and the only honest way to fill the row is to look at what was
    // actually written. One more ffprobe: a header read, 136 ms median over 59
    // production videos, against a row that would otherwise claim 5056x1924 for
    // a 1920x730 file for ever - which would keep the rescue entry on offer and
    // keep lib/media/embed.ts telling Discord the wrong shape.
    const remeasured = plan.remeasure
      ? await probeAv(plan.outputPath, { timeoutMs: AV_PROBE_TIMEOUT_MS, signal }).catch(
          () => null,
        )
      : null;

    // A GIF or an animated WebP is a picture, and the dashboard wants a picture's
    // metadata for it. Anything else keeps the source's frame size where that is
    // still true (a container copy shows the same picture) and nothing at all
    // where it is not - claiming 1920x1080 for an extracted MP3 is a lie the meta
    // bar would print.
    let width: number | null = null;
    let height: number | null = null;
    let frames: number | null = null;
    let durationSeconds: number | null = null;
    let fps: number | null = null;
    let blurhash: string | null = null;

    if (plan.mime.startsWith("image/") && produced.size <= IMAGE_META_MAX_BYTES) {
      try {
        const meta = await imageMetaFromBuffer(await readFile(plan.outputPath));
        width = meta.width ?? null;
        height = meta.height ?? null;
        frames = meta.frames ?? null;
        blurhash = meta.blurhash ?? null;
      } catch {
        // Metadata is a nicety; a result we cannot measure is still a result.
      }
    } else if (plan.mime.startsWith("video/")) {
      const shape = remeasured?.video ?? probe.video;
      width = shape?.width ?? null;
      height = shape?.height ?? null;
    }

    // Playing time survives every audio/video target on the menu, and that is a
    // property of the menu rather than luck: the container targets are stream
    // copies, and the audio ones encode the whole file. The only targets that
    // SHORTEN anything are the clip ones, and those produce an image, which took
    // the branch above and keeps both columns null.
    if (plan.mime.startsWith("video/") || plan.mime.startsWith("audio/")) {
      durationSeconds = remeasured?.duration ?? probe.duration;
      // Frame rate and frame count are carried over only when not one sample is
      // touched. A re-encode picks its own - a still picture runs at 1 fps
      // (AV_STILL_FPS) - so copying the source's here would print a guess as a
      // fact on the file's own detail panel. Unless the result was measured, in
      // which case these are not the source's numbers at all: they are counted
      // from the file that now exists, which is what the column means.
      const counted = remeasured?.video ?? (option.cost === "copy" ? probe.video : null);
      if (counted) {
        fps = counted.fps;
        frames = counted.frames;
      }
    }

    return {
      path: plan.outputPath,
      size: produced.size,
      checksum,
      mime: plan.mime,
      ext: plan.ext,
      width,
      height,
      durationSeconds,
      fps,
      frames,
      blurhash,
      note: plan.note,
      dispose: () => ws.dispose(),
    };
  } catch (err) {
    await ws.dispose();
    throw err;
  }
}

/** What the ROW says the source is - never re-derived from the probe. */
function sourceKindOf(media: UploadRow): AvSourceKind {
  const kind = mediaKind(media.mimeType, media.ext);
  if (kind === "audio") return "audio";
  if (kind === "image") return "image-sequence";
  return "video";
}

// ---------------------------------------------------------------------------
// Committing
// ---------------------------------------------------------------------------

/** Aborts a transaction with a reason the caller can report. */
class ConvertAbort extends Error {
  constructor(readonly reason: ConvertFailure) {
    super(`convert aborted: ${reason}`);
    this.name = "ConvertAbort";
  }
}

async function commitReplace(
  media: UploadRow,
  produced: Produced,
): Promise<ConvertOutcome> {
  const stored = await storeProduced(produced, swapKeyExt(media.storageKey, produced.ext));
  if (!stored) return failed(media.id, "no-space");
  if ("error" in stored) return failed(media.id, stored.error);

  const bytes: ConvertedBytes = { ...toBytes(produced), storageKey: stored.key };
  const patch = conversionRowPatch(media, bytes);

  let previousSize = media.size;
  try {
    await db.transaction(async (tx) => {
      const locked = await tx
        .select({
          storageKey: uploads.storageKey,
          size: uploads.size,
          ownerId: uploads.ownerId,
        })
        .from(uploads)
        .where(eq(uploads.id, media.id))
        .for("update")
        .limit(1);

      const row = locked[0];
      // Somebody else changed the bytes while we were encoding (another
      // conversion, a delete). Ours describe a file that is no longer current, so
      // they are abandoned rather than applied.
      if (!row || row.storageKey !== media.storageKey) throw new ConvertAbort("conflict");

      previousSize = Number(row.size) || 0;
      // Read UNDER the lock, never from the snapshot taken before the encode:
      // two conversions of the same file would otherwise both compute their delta
      // from the same "before" size and charge the account twice.
      const delta = quotaDeltaFor("replace", previousSize, produced.size);
      if (row.ownerId) await chargeQuota(tx, row.ownerId, delta);

      const updated = await tx
        .update(uploads)
        .set(patch)
        .where(and(eq(uploads.id, media.id), eq(uploads.storageKey, media.storageKey)))
        .returning({ id: uploads.id });
      if (updated.length === 0) throw new ConvertAbort("conflict");
    });
  } catch (err) {
    // Ours are the only bytes nobody is pointing at, so ours are the ones to go.
    await getStorage().delete(stored.key).catch(() => {});
    return failed(media.id, err instanceof ConvertAbort ? err.reason : "storage");
  }

  // Past the commit. Everything below is cleanup: it may fail without making the
  // conversion any less complete, and none of it may throw into the caller.
  await purgeDerived(media.id);
  if (stored.key !== media.storageKey) {
    await getStorage().delete(media.storageKey).catch((err) => {
      console.error("[convert] old object left behind:", media.storageKey, err);
    });
  }
  if (media.thumbKey) await getStorage().delete(media.thumbKey).catch(() => {});

  return {
    status: "converted",
    uploadId: media.id,
    code: media.code,
    ext: produced.ext,
    mimeType: produced.mime,
    size: produced.size,
    previousSize,
    previousExt: media.ext ?? "",
    note: produced.note,
  };
}

async function commitCopy(media: UploadRow, produced: Produced): Promise<ConvertOutcome> {
  const ownerId = media.ownerId;
  if (!ownerId) return failed(media.id, "forbidden");

  const ownerRows = await db.select().from(users).where(eq(users.id, ownerId)).limit(1);
  const owner = ownerRows[0];
  if (!owner) return failed(media.id, "forbidden");

  const filename = swapFilenameExt(media.filename, produced.ext);
  const code = await allocateCodeFor(owner, filename);
  const key = storageKeyFor(owner.userCode ?? "u", code, produced.ext);

  const stored = await storeProduced(produced, key);
  if (!stored) return failed(media.id, "no-space");
  if ("error" in stored) return failed(media.id, stored.error);

  try {
    const created = await db.transaction(async (tx) => {
      // A copy is a whole new file, so it is charged in full - the same
      // conditional UPDATE the upload path uses, for the same reason: two
      // concurrent copies must not both read the same "before" value and both
      // pass.
      await chargeQuota(tx, ownerId, produced.size);

      const inserted = await tx
        .insert(uploads)
        .values({
          ownerId,
          code,
          filename,
          ext: produced.ext,
          // A copy of a paste is a file: its bytes are a PDF or a picture now,
          // and nothing about it should still render as source code.
          kind: "file",
          language: null,
          mimeType: produced.mime,
          size: produced.size,
          storageKey: stored.key,
          checksum: produced.checksum,
          width: produced.width,
          height: produced.height,
          frames: produced.frames,
          blurhash: produced.blurhash,
          // Inherited from the SOURCE ROW, not from the account defaults. The
          // owner has already made these decisions about this file, and the only
          // direction that leaks is a copy of a private file coming out public.
          published: media.published,
          folderId: media.folderId,
          // The hash travels WITH its generation, always. The generation is what
          // says "this file is on the account default password"; copying the hash
          // without it would turn the copy into a hand-picked password (always
          // asks, remembered consent never opens it), and copying neither would
          // publish a protected file naked.
          passwordHash: media.passwordHash,
          passwordVersion: media.passwordVersion,
          // Policy travels; history does not. Without maxViews a copy of a
          // burn-after-view link would be a permanent one, and with the source's
          // view COUNT a copy of an already-spent link would be dead on arrival.
          expiresAt: media.expiresAt,
          maxViews: media.maxViews,
          deleteToken: secureToken(16),
          convertedAt: new Date(),
          originalExt: media.ext ?? null,
        })
        .returning({ id: uploads.id });

      return inserted[0];
    });

    return {
      status: "created",
      uploadId: created.id,
      sourceId: media.id,
      code,
      ext: produced.ext,
      mimeType: produced.mime,
      size: produced.size,
      note: produced.note,
    };
  } catch (err) {
    await getStorage().delete(stored.key).catch(() => {});
    return failed(media.id, err instanceof ConvertAbort ? err.reason : "conflict");
  }
}

/**
 * Add `delta` to the owner's usage, atomically, refusing only when it would take
 * them past their limit.
 *
 * The predicate lives in the WHERE clause so Postgres evaluates it against the
 * row it is about to lock - the same shape as the upload path's reservation, and
 * for the same reason. A delta of zero or less is applied unconditionally and can
 * never be refused: declining to shrink a file because the account is over its
 * limit would trap the owner in exactly the state the limit exists to end.
 */
async function chargeQuota(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  ownerId: string,
  delta: number,
): Promise<void> {
  if (delta === 0) return;

  if (delta < 0) {
    await tx
      .update(users)
      .set({ usedQuota: sql`greatest(0, coalesce(${users.usedQuota}, 0) + ${delta})` })
      .where(eq(users.id, ownerId));
    return;
  }

  const charged = await tx
    .update(users)
    .set({ usedQuota: sql`coalesce(${users.usedQuota}, 0) + ${delta}` })
    .where(
      and(
        eq(users.id, ownerId),
        sql`(
          ${users.maxQuota} is null
          or ${users.maxQuota} < 0
          or coalesce(${users.usedQuota}, 0) + ${delta} <= ${users.maxQuota}
        )`,
      ),
    )
    .returning({ id: users.id });

  if (charged.length === 0) throw new ConvertAbort("quota");
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Put the result in storage under a key nothing else occupies, and prove it
 * arrived whole.
 *
 * The stat afterwards is not ceremony: a short write on a full disk produces a
 * truncated object that looks entirely valid to every later reader, and the row
 * would then be committed onto it. Comparing against the size we produced is the
 * only moment that is detectable.
 */
async function storeProduced(
  produced: Produced,
  preferredKey: string,
): Promise<{ key: string } | { error: ConvertFailure } | null> {
  // Re-checked with the REAL size now that it is known: the estimate before the
  // encode was the source's size, and a conversion may grow a file.
  if (!(await hasHeadroom(produced.size))) return null;

  const storage = getStorage();
  let key: string;
  try {
    key = freshKey(preferredKey);
  } catch {
    return { error: "storage" };
  }

  try {
    if (produced.path) await storage.ingestLocalFile(produced.path, key);
    else if (produced.buffer) await storage.write(key, produced.buffer);
    else return { error: "storage" };

    const info = await storage.stat(key);
    if (!info || info.size !== produced.size) {
      await storage.delete(key).catch(() => {});
      return { error: "storage" };
    }
  } catch {
    await storage.delete(key).catch(() => {});
    return { error: "storage" };
  }

  return { key };
}

/**
 * A key nothing else can be using, by construction rather than by checking.
 *
 * The obvious version of this asked storage whether the preferred key was free
 * and used it if so. That is a time-of-check/time-of-use race, and on the one
 * code path in this application that OVERWRITES a user's file it is the worst
 * kind: convert the same file to the same format twice at once (two tabs, a
 * double-clicked retry) and both calls compute the same key, both see it free,
 * and both write there. One transaction wins and points the row at those bytes;
 * the loser's cleanup then deletes them. The row survives, the file does not.
 *
 * Randomising unconditionally removes the race instead of narrowing it: two
 * calls cannot agree on a key they never compared. 48 bits is far more than
 * enough when the namespace is one upload, and the cost is nil, because a
 * storage key is internal - public URLs are built from the code and extension
 * (lib/media/urls.ts), never from this string.
 */
function freshKey(preferred: string): string {
  return suffixKey(preferred, randomBytes(6).toString("hex"));
}

/** Would `bytes` more leave the storage filesystem below the operator's reserve? */
async function hasHeadroom(bytes: number): Promise<boolean> {
  if (config.storage.driver !== "local") return true;
  const floor = config.uploads.minFreeBytes;
  if (floor <= 0) return true;
  return fitsOnDisk(bytes, await freeBytesForUploads(), floor);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function toBytes(produced: Produced): Omit<ConvertedBytes, "storageKey"> {
  return {
    size: produced.size,
    checksum: produced.checksum,
    mime: produced.mime,
    ext: produced.ext,
    width: produced.width,
    height: produced.height,
    frames: produced.frames,
    durationSeconds: produced.durationSeconds,
    fps: produced.fps,
    blurhash: produced.blurhash,
  };
}

function failed(uploadId: string, reason: ConvertFailure): ConvertOutcome {
  return { status: "failed", uploadId, reason };
}

/** Turn a limiter refusal into a reason. Anything else is a genuine failure. */
function limiterFailure(err: unknown): ConvertFailure {
  if (err instanceof BusyError) return "busy";
  if (err instanceof TimeoutError) return "timeout";
  if (err instanceof AbortedError) return "aborted";
  return "encoder";
}
