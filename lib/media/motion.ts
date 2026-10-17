/**
 * A thumbnail that MOVES: one contiguous clip of a file, returned as a single
 * animated WebP.
 *
 * The policy - which rows qualify, which stretch is taken, how fast it plays,
 * what it is allowed to cost - is in lib/media/motion-preview.ts and
 * lib/media/transform-cost.ts. This module is only the two engines that act on
 * it, and the cache in front of them.
 *
 * WHY A CLIP AND NOT A SPREAD. The first version sampled eight frames from
 * across the whole file, and it read as a slideshow next to the video playing in
 * the panel. Raising the count was the obvious fix and the wrong one: on that
 * shape the cost is the SEEK, measured on the production 4K .mov at 1.8 s for
 * two frames, 3.3 s for four and 6.8 s for eight - about 0.85 s each - so
 * sixteen frames would have been fourteen seconds of ffmpeg for a tile. One seek
 * followed by a forward decode is the cheap direction, and it buys thirty frames
 * for less than eight seeks cost.
 *
 * WHOLE PIPELINE, measured on production (2 cores, ffmpeg 5.1.9, sharp 0.34.5),
 * against real uploads at a 480 px tile - the old spread against this code:
 *
 *   source                            was          is           frames    bytes
 *   3840x2160 .mov, 68 MB, 15 s       7389 ms      3915 ms      8 -> 22   138 -> 295 kB
 *   1920x1080 .mp4, 109 MB, 24 s      4089 ms      3443 ms      8 -> 30    65 -> 337 kB
 *   1920x1080 .mp4, 58 MB, 14 s       4233 ms      2789 ms      8 -> 30   102 -> 390 kB
 *   1920x1088 .mp4, 42 MB, 55 s       4263 ms      1868 ms      8 -> 30    80 -> 247 kB
 *   1280x720  .mp4, 24 MB, 22 s       2332 ms      1604 ms      8 -> 30   107 -> 299 kB
 *      48x96  .mp4, 400 MB, 42 s       500 ms       279 ms      2 -> 30     1 ->  17 kB
 *   1195x1169 GIF, 47 pages, 25 MB    2416 ms      1895 ms      7 -> 25   117 -> 405 kB
 *    624x765  GIF, 108 pages, 20 MB   2062 ms      1409 ms      8 -> 27   127 -> 267 kB
 *   1654x762  GIF, 256 pages, 4 MB    2433 ms      1269 ms      7 -> 27    79 -> 190 kB
 *    640x640  GIF, 135 pages, 7 MB    1468 ms      1216 ms      8 -> 27    63 -> 177 kB
 *
 * Three to four times the frames, and faster on every file we have. The 4K row
 * holds 22 rather than 30 because the decode budget in transform-cost.ts trims
 * its clip from 2.5 s to 1.808 s - it is the only file on this deployment the
 * budget touches at all.
 *
 * The bytes are the honest cost of the change and there is no way round them:
 * sweeping the WebP quality from 55 down to 18 only halves the file, because the
 * size is driven by the FRAME COUNT and not by the quality. So the quality moved
 * one notch (55 -> 45, a measured 14 %, invisible at tile scale) and the rest is
 * paid. A tile is written once per file and served from the derived cache after
 * that; the artefact is a 2.5 s clip, and 300 kB is what one costs in WebP.
 *
 * THE PIPELINE THAT ACTUALLY HOLDS. Two facts constrain it, and neither is
 * negotiable:
 *
 *  1. sharp writes an animated WebP only from an image it knows is animated.
 *     The ANIMATION path gets that for free - `{ page, pages }` loads a run of
 *     pages as one multi-page image, `.resize()` on it IS page-aware (verified
 *     on production: a 1195x1169 GIF comes out 480x480 per page, not one 14400px
 *     strip), and `.webp()` writes the pages straight out. The VIDEO path has no
 *     such image: its frames arrive as separate files, so they are stacked with
 *     `join: { animated: true }`. Two traps there, both measured rather than
 *     assumed: `join` does NOT accept raw pixel buffers (it throws "Input buffer
 *     contains unsupported image format"), so the intermediates have to be an
 *     encoded format; and `.resize()` AFTER a join is not page-aware - it
 *     silently collapses the pages into one image - so every frame is resized to
 *     its final size BEFORE it is joined.
 *
 *  2. ffmpeg 5.1 cannot demux an animated WebP (recorded in CLAUDE.md), so it
 *     cannot be the engine for animated images, and libvips cannot seek a video,
 *     so it cannot be the engine for video. Each kind therefore has its own
 *     sampler, and they meet at "an animated WebP whose frames we count".
 *
 * WHY SEEKING IS CHEAP. `-ss` BEFORE `-i` makes ffmpeg seek to the frame; after
 * `-i` it decodes everything up to it. The poster path learned this first. What
 * this path adds is that AFTER the one seek, decoding forward is the cheap
 * direction: the 4K file gets through 1244 Mpx of pictures in 4.3 s, where eight
 * seeks into the same file cost 7.0 s for eight of them.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sharp } from "@/lib/media/sharp-runtime";
import { probeImage } from "@/lib/media/probe";
import { probeAv } from "@/lib/media/av-probe";
import { openAvWorkspace, type AvWorkspace } from "@/lib/media/av-workspace";
import { ffmpegAvailable, inputArgs, runAvTool, threadArgs } from "@/lib/media/ffmpeg";
import { AV_MAX_INPUT_BYTES, AV_PROBE_TIMEOUT_MS } from "@/lib/media/av-cost";
import { derivedKey, mayCacheDerived, readDerived, writeDerived } from "@/lib/media/derived-cache";
import { getStorage } from "@/lib/storage";
import { mediaKind } from "@/lib/media/mime";
import {
  MAX_TRANSFORM_BYTES,
  MOTION_CLIP_FPS,
  MOTION_FRAMES,
  motionClipBudget,
  motionPageBudget,
} from "@/lib/media/transform-cost";
import {
  clampMotionEdge,
  clipDelays,
  clipPages,
  countAnimatedWebpFrames,
  MOTION_CAPTURE_WIDTH,
  videoClip,
  type MotionRefusal,
} from "@/lib/media/motion-preview";
import type { MediaRow } from "@/lib/media/serve";

/**
 * Wall clock for the one ffmpeg invocation.
 *
 * The heaviest clip measured on production is 4.3 s (the 4K60 .mov at the full
 * 2.5 s, which the pixel budget then trims to 1.8 s anyway). Fifteen seconds is
 * that with room for a cold page cache and a second job on the cores, and it
 * sits inside MOTION_TIMEOUT_MS so the process is killed before the response
 * gives up - a response that gives up first would leave a decoder running for
 * nobody.
 */
const MOTION_FFMPEG_TIMEOUT_MS = 15_000;

/**
 * Quality of the finished preview. A tile, not a download.
 *
 * 45, down from the 55 the eight-frame spread used. Measured on the 720p
 * production file at 30 frames: q55 346 kB, q45 299 kB, q38 263 kB, q30 223 kB,
 * q18 164 kB. Halving the quality number does not halve the file, because at
 * thirty frames the count is what the bytes are made of - so the quality drops
 * one notch, where it is free, and stops there rather than trading away detail
 * for a saving the shape does not offer.
 */
const MOTION_WEBP_QUALITY = 45;
/** Effort 4 was measured at 411 kB against effort 3's 410 kB. Not worth it. */
const MOTION_WEBP_EFFORT = 3;

/**
 * Filename pattern ffmpeg writes its frames to.
 *
 * A `%04d` sequence, which is why it does not go through `AvWorkspace.output()`:
 * that helper refuses a `%`, correctly, because output names normally come from
 * a target table and a pattern is the one thing a name must never be able to
 * become. This one is a literal in this file, joined to the workspace's own
 * private directory, so nothing a request carries reaches it.
 */
const MOTION_FRAME_PREFIX = "mf";
const MOTION_FRAME_PATTERN = `${MOTION_FRAME_PREFIX}%04d.jpg`;

export interface MotionOptions {
  width?: number;
  height?: number;
  fit: "cover" | "inside";
}

export type MotionResult =
  | { ok: true; buffer: Buffer; frames: number }
  | { ok: false; refusal: MotionRefusal };

const refuse = (refusal: MotionRefusal): MotionResult => ({ ok: false, refusal });

/**
 * A preview that moves, or a reason there is none.
 *
 * Never returns the original bytes and never falls back to a still. The caller
 * turns a refusal into a status, because a client drawing a grid of tiles that
 * fell through to the file would start downloading gigabytes - the same rule the
 * poster path is built on.
 */
export async function motionPreview(
  media: MediaRow,
  requested: MotionOptions,
  signal: AbortSignal,
): Promise<MotionResult> {
  // Clamped BEFORE the cache key is built, so `w=1200` and `w=480` are one entry
  // and not two names for the same bytes.
  const opts: MotionOptions = {
    width: clampMotionEdge(requested.width),
    height: clampMotionEdge(requested.height),
    fit: requested.fit,
  };
  const cacheable = mayCacheDerived(media);
  // Keyed on the row's own checksum when it has one and on its size otherwise -
  // the identity /convert and the poster already use. Both change when the bytes
  // change, so converting a file in place cannot leave a preview of the old one.
  // The tile geometry is in the variant because the frames are resized before
  // they are joined, so one entry cannot answer a different size.
  const key = derivedKey(
    media.id,
    media.checksum ?? `s${media.size}`,
    // `motion2` rather than `motion`: the generator changed from eight seeks
    // spread over the whole file to one continuous clip, and a cached artefact
    // outlives the code that made it. Without this, every video anyone had
    // already hovered would keep serving its old eight-frame version for ever -
    // measured on production right after the deploy: a cached file answered 8
    // frames while an uncached one answered 30.
    // Deliberately NOT a bump of CACHE_EPOCH: that key is shared with every
    // thumbnail and derivative, so raising it would discard the cache for all
    // ~8700 uploads and set two cores re-rendering the entire library to fix a
    // change that only concerns motion previews.
    `motion2-${opts.width ?? 0}x${opts.height ?? 0}-${opts.fit}`,
    "webp",
  );

  if (cacheable) {
    const hit = await readDerived(key);
    // The frame count is read back out of the bytes rather than remembered
    // alongside them: it is a property of the artefact, and a cache that carried
    // it separately could disagree with what it is serving.
    if (hit) return { ok: true, buffer: hit, frames: countAnimatedWebpFrames(hit) };
  }

  const kind = mediaKind(media.mimeType, media.ext);
  const built =
    kind === "video"
      ? await videoMotion(media, opts, signal)
      : kind === "image"
        ? await animationMotion(media, opts, signal)
        : refuse("not-animated");

  if (built.ok && cacheable) await writeDerived(key, built.buffer);
  return built;
}

// ---------------------------------------------------------------------------
// Video: one seek, then decode forward
// ---------------------------------------------------------------------------

async function videoMotion(
  media: MediaRow,
  opts: MotionOptions,
  signal: AbortSignal,
): Promise<MotionResult> {
  if (media.size > AV_MAX_INPUT_BYTES) return refuse("too-large");
  if (!(await ffmpegAvailable())) return refuse("no-engine");

  let ws: AvWorkspace | null = null;
  try {
    const opened = await openAvWorkspace(media.storageKey, AV_MAX_INPUT_BYTES);
    if ("error" in opened) {
      return refuse(opened.error === "too-large" ? "too-large" : "unreadable");
    }
    ws = opened;

    const probe = await probeAv(ws.input, { timeoutMs: AV_PROBE_TIMEOUT_MS, signal });
    if (!probe || !probe.video) return refuse("unreadable");
    // Without a duration there is nothing to place the clip inside, and guessing
    // an offset against a file we cannot measure is how a seek lands past the end
    // and the whole invocation comes back with no pictures.
    if (probe.duration == null) return refuse("unknown-duration");
    // A video stream that will not say how big its picture is cannot be charged
    // for, and this budget is the only thing standing between an 8K source and a
    // decode that outlives its deadline.
    const { width: srcWidth, height: srcHeight } = probe.video;
    if (!srcWidth || !srcHeight) return refuse("unreadable");

    // `nb_frames / duration` rather than a rate field, because the probe already
    // carries both and ffprobe fills `nb_frames` in for four of the five
    // production videos checked. The fifth falls back to the assumed rate, which
    // over-charges rather than under-charges - see MOTION_ASSUMED_FPS.
    const sourceFps = probe.video.frames != null ? probe.video.frames / probe.duration : null;
    const budget = motionClipBudget(srcWidth * srcHeight, sourceFps);
    if (!budget.ok) return refuse("too-many-pixels");

    const clip = videoClip(probe.duration, budget.seconds);
    if (!clip) return refuse("unknown-duration");

    // A plain integer, never an ffmpeg expression: `scale='min(480,iw)'` works
    // but puts a comma inside a filter argument, and quoting rules inside a
    // filtergraph are not a thing to rely on when the width is already known.
    const width = Math.max(2, Math.min(MOTION_CAPTURE_WIDTH, srcWidth));

    // The workspace's own directory. `output()` builds a path inside it and
    // refuses a name with a `%` in it, so the pattern is joined here instead -
    // see MOTION_FRAME_PATTERN for why that is safe.
    const dir = dirname(ws.output("frames.jpg"));

    await runAvTool(
      "ffmpeg",
      [
        "-hide_banner",
        "-v",
        "error",
        // ONE input with ONE `-ss` in front of its `-i`. `inputArgs` is what
        // forces the demuxer from the allowlist, so this open is as confined as
        // the one the probe made.
        ...inputArgs(ws.input, probe.container, ["-ss", clip.start.toFixed(3)]),
        // After `-i`, so it bounds the OUTPUT: decode this many seconds forward
        // from where the seek landed.
        "-t",
        clip.seconds.toFixed(3),
        // Nothing but the picture. Audio and subtitles would be demuxed and
        // discarded, which is work for a tile that has neither.
        "-an",
        "-sn",
        ...threadArgs(),
        "-vf",
        `fps=${MOTION_CLIP_FPS},scale=${width}:-2:flags=bilinear`,
        // A hard cap on top of `-t`. A container whose duration is a lie cannot
        // turn a tile into an unbounded write into the workspace.
        "-frames:v",
        String(MOTION_FRAMES),
        "-q:v",
        "4",
        "-y",
        join(dir, MOTION_FRAME_PATTERN),
      ],
      { timeoutMs: MOTION_FFMPEG_TIMEOUT_MS, signal },
    );

    // Read back what was written rather than what was asked for: a clip that ran
    // into the end of the file has fewer frames, and that is a shorter loop and
    // not an error. Sorted by name, which is why the pattern is zero-padded.
    const names = (await readdir(dir).catch(() => []))
      .filter((name) => name.startsWith(MOTION_FRAME_PREFIX) && name.endsWith(".jpg"))
      .sort();
    if (names.length === 0) return refuse("unreadable");

    const grabbed: Buffer[] = [];
    for (const name of names.slice(0, MOTION_FRAMES)) {
      const buf = await readFile(join(dir, name)).catch(() => null);
      if (!buf || buf.length === 0) return refuse("unreadable");
      grabbed.push(buf);
    }

    // No source delay array for a video: every frame was captured at the same
    // rate, so the clip plays back at the rate it was captured at.
    return assemble(grabbed, clipDelays(null, 0, grabbed.length), opts);
  } finally {
    if (ws) await ws.dispose().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Animated image: one run of pages, one load
// ---------------------------------------------------------------------------

async function animationMotion(
  media: MediaRow,
  opts: MotionOptions,
  signal: AbortSignal,
): Promise<MotionResult> {
  // The image engine reads the whole file into memory, so the ceiling that
  // guards every other libvips read applies unchanged. Video is exempt from it
  // because a seek reads neither.
  if (media.size > MAX_TRANSFORM_BYTES) return refuse("too-large");

  const src = await getStorage().readBuffer(media.storageKey);
  if (signal.aborted) return refuse("unreadable");

  // probeImage rather than a bare metadata() call: it carries the `avis` brand
  // workaround and it reports the height of ONE FRAME rather than of the stacked
  // strip, which is the difference between a budget and a decoration.
  const probe = await probeImage(src);
  if (!probe) return refuse("unreadable");
  // `animated` is false for a still and for the AVIF sequence whose frames
  // libvips will not enumerate. Both are honestly "there is no motion here that
  // this engine can reach", and answering with a one-frame animation would be a
  // moving tile that does not move.
  if (!probe.animated) return refuse("not-animated");

  // The frame-aware budget, which now also decides HOW MANY pages are affordable
  // rather than only whether the file is. `framePixels x frames`, never
  // `width x height`: a 1654x762 GIF with 256 frames reads as 1.26 Mpx to a guard
  // that multiplies two numbers.
  const budget = motionPageBudget(probe.framePixels, probe.pages);
  if (!budget.ok) return refuse("too-many-pixels");

  const run = clipPages(probe.pages, budget.frames);
  if (!run) return refuse("not-animated");

  const delays = clipDelays(await sourceDelays(src), run.start, run.count);
  if (signal.aborted) return refuse("unreadable");

  try {
    // ONE load of the whole run. The sampler this replaced opened the file once
    // per frame, and reading page p costs decoding pages 0..p, so eight spread
    // samples were about four passes over the sequence; a run from page zero is
    // one pass. Measured on the 1195x1169 47-page production GIF: 2.4 s for eight
    // sampled frames against 1.9 s for thirty contiguous ones.
    //
    // `limitInputPixels: false` because the budget above is the ceiling here, and
    // it is the tighter of the two: sharp's default counts the STACKED height, so
    // a long run of small pages can trip a limit meant for one enormous picture.
    const buffer = await sharp(probe.input, {
      failOn: "none",
      page: run.start,
      pages: run.count,
      limitInputPixels: false,
    })
      // Page-aware, unlike a resize after a `join` - verified on production, a
      // 1195x1169 GIF comes back 480x480 per page rather than one tall strip.
      .resize(opts.width, opts.height, {
        fit: opts.fit,
        // `position: centre`, NOT the `attention` the still thumbnail uses.
        // Attention picks the crop from the content it is given, so a run of
        // frames gets a different crop each time and the tile jitters as it
        // plays. A moving tile has to hold still.
        position: "centre",
        withoutEnlargement: true,
      })
      .webp({
        quality: MOTION_WEBP_QUALITY,
        effort: MOTION_WEBP_EFFORT,
        loop: 0,
        // Per page. A scalar only sets the first frame's delay and leaves the
        // rest at libvips' default, which is how a 400 ms loop becomes a 100 ms
        // one.
        delay: delays,
      })
      .toBuffer();
    return finish(buffer);
  } catch {
    return refuse("unreadable");
  }
}

/**
 * The per-frame delays the source animation carries, or null when it carries
 * none.
 *
 * A header read, and it is worth the call: a GIF that holds its opening frame
 * for a second and then runs at 20 fps is completely ordinary, and a uniform
 * delay would make the preview play nothing like the file it previews.
 */
async function sourceDelays(buf: Buffer): Promise<number[] | null> {
  try {
    const meta = await sharp(buf, { failOn: "none", animated: true }).metadata();
    const delays = meta.delay;
    return Array.isArray(delays) && delays.length > 0 ? delays : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared: frames -> animated WebP
// ---------------------------------------------------------------------------

/**
 * One frame, resized to its final tile size.
 *
 * PNG rather than WebP or JPEG for the intermediate: it is thrown away moments
 * later, and a lossy intermediate would quantise every frame twice.
 */
async function tile(buf: Buffer, opts: MotionOptions): Promise<Buffer> {
  return sharp(buf, { failOn: "none" })
    .resize(opts.width, opts.height, {
      fit: opts.fit,
      position: "centre",
      withoutEnlargement: true,
    })
    .png({ compressionLevel: 1 })
    .toBuffer();
}

/**
 * Stack tile-sized frames into one animated WebP. The VIDEO path only - an
 * animation is already one multi-page image and never comes through here.
 *
 * `join: { animated: true }` is what makes the result multi-page; without it
 * sharp writes a single tall picture. Nothing is resized after this point - see
 * the module header for why that would collapse the pages.
 */
async function assemble(
  frames: Buffer[],
  delays: number[],
  opts: MotionOptions,
): Promise<MotionResult> {
  if (frames.length < 2) return refuse("not-animated");

  const sized = await Promise.all(frames.map((f) => tile(f, opts)));

  const buffer = await sharp(sized, { failOn: "none", join: { across: 1, animated: true } })
    .webp({
      quality: MOTION_WEBP_QUALITY,
      effort: MOTION_WEBP_EFFORT,
      loop: 0,
      delay: delays.slice(0, sized.length),
    })
    .toBuffer();

  return finish(buffer);
}

/**
 * What came out, not what went in.
 *
 * libwebp collapses frames that are byte for byte identical, so thirty samples
 * can legitimately become fewer pages - and when they collapse to ONE, the file
 * did not visibly change across the clip and there is no motion to preview.
 * Found on production with the old sampler: a 400 MB 48x96 video whose eight
 * samples reduced to two. Serving a one-frame "animation" would be a moving tile
 * that does not move, which is worse than saying so, because the client would
 * stop drawing its still one.
 */
function finish(buffer: Buffer): MotionResult {
  const written = countAnimatedWebpFrames(buffer);
  if (written < 2) return refuse("not-animated");
  return { ok: true, buffer, frames: written };
}
