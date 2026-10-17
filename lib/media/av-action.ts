/**
 * The /convert handler for audio and video.
 *
 * Split out of the route because it is a different shape of work from the image
 * conversion beside it: it spawns processes, it streams outputs too large to
 * hold, and it is the only place in the app where a public request can start a
 * program. Keeping it in the route would have buried the authorization decision
 * in the middle of four hundred lines about thumbnails.
 *
 * Order of operations, and every step is here because skipping it costs
 * something real:
 *
 *   1. is this target offered for this KIND of file?       (free, static)
 *   2. may this caller ask for it?                          (free, session)
 *   3. is the file small enough?                            (one stat)
 *   4. is it cached?                                        (one stat)
 *   5. take a limiter slot
 *   6. ffprobe: what is it really, and how long?            (one cheap process)
 *   7. does the budget allow it?                            (arithmetic)
 *   8. can these codecs actually do it?                     (arithmetic)
 *   9. run ffmpeg
 *
 * Steps 1-4 all precede the slot, so the cheap refusals stay cheap under load,
 * and step 6 precedes step 9 so nothing expensive starts before the file has
 * been measured.
 */

import "server-only";
import { Readable } from "node:stream";
import { stat } from "node:fs/promises";
import {
  AV_MAX_INPUT_BYTES,
  AV_PROBE_TIMEOUT_MS,
  AV_WEIGHT,
  avBudget,
  avTimeoutFor,
} from "@/lib/media/av-cost";
import {
  audioCopyableTo,
  avOptionFor,
  AV_OUTPUT,
  type AvOption,
  type AvSourceKind,
} from "@/lib/media/av-targets";
import { probeAv } from "@/lib/media/av-probe";
import { totalSourcePixels } from "@/lib/media/av-meta";
import { avVariant, planAv, runAvPlan, type RefuseReason } from "@/lib/media/av-convert";
import { openAvWorkspace, readAndDispose, type AvWorkspace } from "@/lib/media/av-workspace";
import { ffmpegAvailable } from "@/lib/media/ffmpeg";
import { imageTransforms } from "@/lib/media/transform-queue";
import {
  derivedKey,
  mayCacheDerived,
  readDerived,
  readDerivedStream,
  writeDerived,
  writeDerivedFile,
} from "@/lib/media/derived-cache";
import { mediaKind } from "@/lib/media/mime";
import {
  readVerdict,
  rememberVerdict,
  verdictKey,
  type ConvertVerdict,
} from "@/lib/media/convert-verdict";
import type { MediaRow } from "@/lib/media/serve";

/**
 * A stable cache identity for the source bytes.
 *
 * The image path hashes the file, which it can do because it has already read
 * it. Hashing a 400 MB video to decide whether to convert it would cost more
 * than the conversion, so the identity is the row's own checksum when it has one
 * and (id, size, mtime-free) otherwise. Both change when the bytes change: a
 * vanity rename does not rewrite the file, and a re-upload gets a new row.
 */
function sourceTag(media: MediaRow): string {
  return media.checksum ?? `s${media.size}`;
}

export interface AvConvertRequest {
  media: MediaRow;
  /** Owner or admin. Decides whether an ENCODER may be run for this caller. */
  privileged: boolean;
  to: string | null;
  /** `?t=` seconds, for a frame grab or a clip start. */
  offsetSeconds: number | null;
  /** `?d=` seconds, for an animation clip length. */
  clipSeconds: number | null;
  signal?: AbortSignal;
  /**
   * Spend the file's view budget, returning false when it is exhausted.
   *
   * A hook rather than something the caller does around this function, because
   * only this function knows the right MOMENT. It has to come after the target
   * and permission checks - a request that is about to be answered 401 must not
   * burn a one-time link - and before the cache lookup, because a cache hit is
   * still a download and still counts.
   */
  admit?: () => Promise<boolean>;
  /**
   * Answer whether this conversion WOULD work, without producing it.
   *
   * The menu asks this before it starts a download, because the alternative -
   * which is what shipped - is that a refusal arrives as the body of a download
   * the browser has already committed to, where nothing reads it and the user
   * sees the word "Failed". Every gate runs; the encoder does not.
   *
   * Two things must not happen on a dry run, and both are easy to get wrong:
   * the view budget must not be spent (opening a menu would burn a one-time
   * link), and no output may be written to the derived cache.
   */
  dryRun?: boolean;
}

/**
 * Answer a /convert request for a media file, or return null when this file is
 * not audio/video at all and the image path should have it.
 */
export async function avConvert(req: AvConvertRequest): Promise<Response | null> {
  const { media, privileged, to, dryRun } = req;

  // The row's own dimensions are part of the question, not a detail: the
  // web-playable target is offered only to files the numbers say are too big
  // for a hardware decoder, and this is the same call the menu renders from, so
  // an entry that is not drawn cannot be asked for either.
  const option = avOptionFor(media.mimeType, media.ext, media.frames, to, media);
  if (!option) return null;

  const memoKey = verdictKey({
    mediaId: media.id,
    sourceTag: sourceTag(media),
    to: option.to,
    privileged,
    clipSeconds: req.clipSeconds,
    offsetSeconds: req.offsetSeconds,
  });

  // A refusal we have already established is served from memory for BOTH kinds
  // of request. It costs no probe and, more importantly, no limiter slot - a
  // caller hammering a conversion these bytes will never satisfy cannot use up
  // the slots that working conversions need.
  //
  // A remembered `ok`, by contrast, only ever answers a dry run. On a real
  // request it would skip the work that produces the file.
  const known = readVerdict(memoKey);
  if (known && (!known.ok || dryRun)) {
    return verdictResponse(known);
  }

  // Every encoder is owner-only. The reasoning is in av-targets.ts: a stream
  // copy costs about what serving the file costs and serving it is already
  // public, while an encode lets the CALLER choose the workload - which
  // seconds, how many frames - and work chosen by a stranger must be
  // attributable to an account that can be turned off.
  // 403 rather than 401: `privileged` is false both for a visitor who is not
  // signed in and for one who is signed in as somebody else, and 401 would tell
  // the second group to authenticate again when the credentials are not the
  // problem. The message covers both readings.
  if (option.cost === "encode" && !privileged) {
    return decided(memoKey, { ok: false, status: 403, reason: "encode-requires-owner" });
  }

  if (!(await ffmpegAvailable())) {
    // Deliberately NOT remembered: this is a property of the server, not of
    // these bytes, and the next request may run on a container that has it.
    return refusal(501, "ffmpeg-unavailable");
  }

  // The row already knows the size, so the cheapest refusal of all needs no
  // filesystem call and happens before the cache lookup, let alone a slot.
  if (media.size > AV_MAX_INPUT_BYTES) {
    return decided(memoKey, {
      ok: false,
      status: 413,
      reason: "too-large",
      limit: String(AV_MAX_INPUT_BYTES),
    });
  }

  // Never on a dry run. `admit` spends the file's view budget, so letting a
  // check call it would mean opening the menu consumes a one-time link and the
  // download that the user then clicks answers 404.
  if (!dryRun && req.admit && !(await req.admit())) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  const out = AV_OUTPUT[option.to];
  const cacheable = mayCacheDerived(media);
  const key = derivedKey(
    media.id,
    sourceTag(media),
    avVariant(option.to, req.clipSeconds, req.offsetSeconds, sourceKindOf(media)),
    out.ext,
  );
  const base = media.filename.replace(/\.[^.]+$/, "") || media.code;
  const noteKeyForCache = `${key}.note`;

  // Before the slot: a hit costs one stat and no process at all. It is also the
  // cheapest possible YES for a dry run - the output already exists, so nothing
  // about this conversion can still refuse.
  if (cacheable) {
    const hit = await readDerivedStream(key);
    if (hit) {
      // The note is read back from beside the cached bytes rather than
      // recomputed, because on a cache hit there is no plan to ask.
      //
      // Without it, only the FIRST person to convert a file was told that its
      // sound could not come along - everybody afterwards got the identical
      // silent .mov with no warning at all, and so did the same person a day
      // later. The warning was attached to the work, when it is a property of
      // the RESULT.
      const note = await readCachedNote(noteKeyForCache);
      if (dryRun) {
        // Nobody is going to read this; leaving it open would hold a file handle
        // until GC. destroy() is synchronous and returns the stream, not a promise.
        hit.stream.destroy();
        return decided(memoKey, { ok: true, note });
      }
      return streamed(hit.stream, hit.size, out, base, note);
    }
  }

  // Limiter refusals (busy, deadline, caller gone) propagate to the route,
  // which already turns them into 503/499 for the image path.
  return imageTransforms.run((signal) => runOne(req, option, key, base, memoKey, signal), {
    weight: AV_WEIGHT,
    // A dry run stops after ffprobe, so holding it to the encode deadline would
    // let a slot sit occupied far longer than the work can possibly take.
    timeoutMs: dryRun ? AV_PROBE_TIMEOUT_MS * 2 : avTimeoutFor(option.to, option.cost),
    signal: req.signal,
  });
}

async function runOne(
  req: AvConvertRequest,
  option: AvOption,
  key: string,
  base: string,
  memoKey: string,
  signal: AbortSignal,
): Promise<Response> {
  const { media } = req;
  const out = AV_OUTPUT[option.to];
  const cacheable = mayCacheDerived(media);

  const opened = await openAvWorkspace(media.storageKey, AV_MAX_INPUT_BYTES);
  if ("error" in opened) {
    return opened.error === "missing"
      ? refusal(404, "missing")
      : refusal(413, "too-large", { limit: String(AV_MAX_INPUT_BYTES) });
  }
  const ws: AvWorkspace = opened;

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await ws.dispose();
  };

  try {
    const probe = await probeAv(ws.input, { timeoutMs: AV_PROBE_TIMEOUT_MS, signal });
    if (!probe) {
      await dispose();
      return decided(memoKey, { ok: false, status: 415, reason: "unreadable" });
    }

    const sourceKind = sourceKindOf(media);
    const budget = avBudget(
      option.to,
      option.cost,
      {
        bytes: media.size,
        duration: probe.duration,
        sourceKind,
        // Whether MP4 will take the sound untouched moves the length ceiling for
        // "audio as video" by a factor of five, and it is knowable only here.
        audioCopyable: audioCopyableTo("mp4", probe.audio?.codec),
        // Picture pixels in the whole file. The meter a full re-encode is
        // budgeted against, and the only one that separates a minute of 4K at
        // 60 fps from a minute of 1440p at 30.
        pixels: totalSourcePixels(probe),
      },
      req.clipSeconds,
    );
    if (!budget.ok) {
      await dispose();
      return decided(memoKey, {
        ok: false,
        status: 413,
        reason: budget.reason,
        limit: String(budget.limit),
      });
    }

    const plan = planAv({
      option,
      probe,
      sourceKind,
      workspace: ws,
      clipSeconds: budget.clipSeconds,
      offsetSeconds: req.offsetSeconds,
    });
    if ("refuse" in plan) {
      await dispose();
      // 409, not 415: the FORMAT is convertible in general, this particular
      // file's codecs are what decline. See the static/dynamic split in
      // av-targets.ts - the menu made an honest offer that these bytes refuse.
      //
      // This is the branch behind the complaint that started this work: "mp3"
      // offered on 93 of 304 videos that have no audio track at all. The reason
      // now reaches the UI instead of arriving as the body of a failed download.
      return decided(memoKey, { ok: false, status: 409, reason: plan.refuse });
    }

    // Everything that can refuse has now spoken, and the only thing left is the
    // work itself. That makes this the end of a dry run.
    if (req.dryRun) {
      await dispose();
      rememberVerdict(memoKey, { ok: true, note: plan.note });
      // The note travels with the YES, because it is exactly the case where the
      // user should be told before the download rather than after: the format
      // will be produced, but without the sound, or only the first few seconds.
      return new Response(null, {
        status: 204,
        headers: {
          ...(plan.note ? { "X-Convert-Note": plan.note } : {}),
          "Cache-Control": "no-store",
        },
      });
    }

    await runAvPlan(plan, signal);

    const produced = await stat(plan.outputPath);
    if (!produced.isFile() || produced.size === 0) {
      await dispose();
      return refusal(500, "empty-output");
    }

    // Written to the cache BEFORE the response streams, because the response
    // stream owns the workspace and deletes it on close. Streaming to storage
    // from a file we are about to unlink is a race with a very quiet failure.
    if (cacheable) {
      await writeDerivedFile(key, plan.outputPath);
      await writeCachedNote(`${key}.note`, plan.note);
    }

    // readAndDispose hands ownership of the workspace to the stream, so the
    // scratch directory is removed when the client finishes or hangs up.
    const body = readAndDispose(plan.outputPath, ws);
    disposed = true;
    return streamed(body as Readable, produced.size, out, base, plan.note);
  } catch (err) {
    await dispose();
    throw err;
  }
}

/** What the row already says the source is - never re-derived from the probe. */
function sourceKindOf(media: MediaRow): AvSourceKind {
  const kind = mediaKind(media.mimeType, media.ext);
  if (kind === "audio") return "audio";
  if (kind === "image") return "image-sequence";
  return "video";
}

function streamed(
  body: Readable,
  size: number,
  out: { mime: string; ext: string },
  base: string,
  note?: string,
): Response {
  return new Response(Readable.toWeb(body) as unknown as ReadableStream, {
    headers: {
      "Content-Type": out.mime,
      "Content-Length": String(size),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${base}.${out.ext}`)}`,
      "X-Content-Type-Options": "nosniff",
      // Something true about the result that was not asked for - the audio track
      // could not come along, or this is a clip of a longer file. A header
      // rather than a silent difference between what was requested and what
      // arrived.
      ...(note ? { "X-Convert-Note": note } : {}),
      // Same rule as the image conversions: our own disk caches the bytes, but
      // the response must not enter a shared cache, because the file behind it
      // can be unpublished or deleted at any moment.
      "Cache-Control": "no-store",
    },
  });
}

/**
 * The note that belongs to a cached conversion, stored beside its bytes.
 *
 * A note ("the sound could not travel to this format", "this is the beginning
 * of a longer file") is a property of the RESULT, not of the work that produced
 * it - so it has to outlive the run. Keeping it only in the ten-minute verdict
 * memo meant the first person to convert a file was warned and everybody after
 * them, including the same person the next day, silently received a soundless
 * copy of their own video.
 *
 * A few bytes next to a file that is often megabytes; the read costs one stat.
 */
async function readCachedNote(key: string): Promise<string | undefined> {
  try {
    const buf = await readDerived(key);
    const text = buf?.toString("utf8").trim();
    return text ? text : undefined;
  } catch {
    return undefined;
  }
}

async function writeCachedNote(key: string, note: string | undefined): Promise<void> {
  if (!note) return;
  // Never awaited by the response path in a way that could fail it: a missing
  // note costs a missing warning, not a missing file.
  try {
    await writeDerived(key, Buffer.from(note, "utf8"));
  } catch {
    /* the conversion still succeeded */
  }
}

/**
 * Remember a verdict and answer with it in one step.
 *
 * Every gate that decides something about THESE BYTES goes through here, so the
 * memo cannot drift from what was actually returned. `ffmpeg-unavailable` is the
 * one refusal that does not: it says something about the server, and remembering
 * it would keep answering no for ten minutes after ffmpeg appears.
 */
function decided(key: string, verdict: ConvertVerdict): Response {
  rememberVerdict(key, verdict);
  return verdictResponse(verdict);
}

/** The response for a verdict, whether it was just decided or recalled. */
function verdictResponse(verdict: ConvertVerdict): Response {
  if (verdict.ok) {
    return new Response(null, {
      status: 204,
      headers: {
        // Carried on EVERY yes, not just the first one. Without this the second
        // visitor inside the memo window got a silent 204 and no warning.
        ...(verdict.note ? { "X-Convert-Note": verdict.note } : {}),
        "Cache-Control": "no-store",
      },
    });
  }
  return refusal(
    verdict.status,
    verdict.reason,
    verdict.limit ? { limit: verdict.limit } : {},
  );
}

/**
 * A refusal the UI can translate.
 *
 * The reason travels as a header token rather than as prose, so the message the
 * user reads comes from messages/{en,pl} like every other string in the app,
 * and the body stays a short English fallback for anything reading the endpoint
 * directly (curl, ShareX, a script).
 */
function refusal(
  status: number,
  reason: RefuseReason | string,
  extra: Record<string, string> = {},
): Response {
  return new Response(REASON_TEXT[reason] ?? reason, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Convert-Refused": reason,
      ...extra,
      "Cache-Control": "no-store",
    },
  });
}

const REASON_TEXT: Record<string, string> = {
  "encode-requires-owner":
    "Sign in as the owner of this file to convert it. Re-encoding is not available on public links.",
  "ffmpeg-unavailable": "Audio and video conversion is not available on this server.",
  "video-codec":
    "This file's video cannot be placed in that format without re-encoding, which is too expensive to do on demand. Try MKV, which accepts it as it is.",
  "audio-codec": "This file's audio track cannot be copied into the requested container.",
  "no-video": "This file has no video track.",
  "no-audio": "This file has no audio track.",
  unreadable: "This file could not be read as audio or video.",
  "too-large": "This file is too large to convert.",
  "too-long": "This file is too long to convert.",
  "too-many-pixels":
    "This recording holds too many frames of too many pixels to re-encode on demand.",
  "empty-output": "The conversion produced no output.",
  missing: "Not found",
};
