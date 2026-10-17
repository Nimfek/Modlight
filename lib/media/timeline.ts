/**
 * The scrub-bar preview: one sprite sheet of a video plus the WebVTT that says
 * which rectangle belongs to which moment.
 *
 * The policy - how many pictures, how far apart, how big, and the VTT text
 * itself - is in lib/media/timeline-preview.ts, and the budget is in
 * lib/media/transform-cost.ts. This module is the one ffmpeg invocation that
 * acts on them, and the cache in front of it.
 *
 * WHY ONE PASS AND NOT MANY SEEKS. This is the opposite of what the poster
 * (lib/media/poster.ts) and the motion clip (lib/media/motion.ts) do, and the
 * reason is that they want pictures from ONE place while a timeline wants
 * pictures from EVERYWHERE. A seek is how you avoid decoding the rest of a file;
 * a hundred seeks is a hundred walks into it. Measured in the production image
 * against real uploads, for a finished 100 tile sheet:
 *
 *   source                          one pass   40 separate seeking processes
 *   1080p .mp4, 181 MB, 35 s         1202 ms                       13596 ms
 *   1080p .mp4,  77 MB, 150 s         691 ms                       18982 ms
 *   4K    .mov,  72 MB, 15 s         2110 ms                       36212 ms
 *
 * And a hundred seeks batched into ONE process (`-ss` in front of each of N
 * `-i` flags), which is the obvious repair for the per-process overhead, is a
 * memory bomb: every input carries its own decoder and its own filtergraph
 * queues. Forty of them on a 1080p source peaked at 1.93 GB inside a 2 GiB
 * container and were killed by the kernel, twice, while this was being sized.
 *
 * WHAT MAKES THE ONE PASS AFFORDABLE. `-discard nokey` tells the DEMUXER to
 * throw away every packet that is not a keyframe, so the decoder is handed 13 to
 * 157 pictures for a normal clip instead of thousands, and the `fps` filter
 * picks the moments it wants out of those. Measured against decoding everything:
 *
 *   source                       full decode   -skip_frame nokey   -discard nokey
 *   1080p .mp4, 181 MB, 35 s        19507 ms             2383 ms          1202 ms
 *   1080p .mp4,  47 MB, 475 s       23456 ms             1369 ms           611 ms
 *   4K    .mov,  72 MB, 15 s        19725 ms             3380 ms          2110 ms
 *
 * `-skip_frame nokey` is the same idea one layer later (the decoder skips what
 * the demuxer still handed it) and it is consistently about twice the price.
 *
 * WHAT THE PREVIEW IS THEREFORE MADE OF: keyframes, and the nearest one at or
 * before each moment rather than the exact frame at it. That is what every
 * storyboard on the web is made of, and on this deployment it means a picture is
 * never more than about half a second stale (measured keyframe spacing: 0.12 to
 * 2.1 per second).
 *
 * LENGTH IS NOT THE COST, which is the measurement that decided the whole shape.
 * A two hour recording (built by stream-copy looping a production clip: 164 MB,
 * 1050 keyframes) costs 3.2 s and 80 MB of RSS. Fifteen seconds of 4K costs
 * 1.8 s and 260 MB. So the ceilings are on BYTES and on the size of one frame,
 * never on duration.
 */

import { readFile } from "node:fs/promises";
import { probeAv } from "@/lib/media/av-probe";
import { AV_MAX_INPUT_BYTES, AV_PROBE_TIMEOUT_MS } from "@/lib/media/av-cost";
import type { AvWorkspace } from "@/lib/media/av-workspace";
import { openVideoSource } from "@/lib/media/poster";
import { inputArgs, runAvTool, threadArgs } from "@/lib/media/ffmpeg";
import { derivedKey, mayCacheDerived, readDerived, writeDerived } from "@/lib/media/derived-cache";
import { maxTimelineFramePixels } from "@/lib/media/transform-cost";
import {
  canTimelinePreview,
  timelinePlan,
  timelineVtt,
  type TimelinePlan,
  type TimelineRefusal,
} from "@/lib/media/timeline-preview";
import type { MediaRow } from "@/lib/media/serve";

/**
 * Cache variant, and the number on the end is load-bearing.
 *
 * A cached artefact outlives the code that made it, and here TWO of them have to
 * agree with each other: a VTT written by one plan and a sheet written by
 * another produce a preview whose rectangles are off by a tile. Both files carry
 * this one tag, so bumping it retires them together.
 *
 * BUMP IT whenever anything in timeline-preview.ts changes what a plan comes out
 * as - the tile box, the interval, the tile count, the grid. The motion path
 * learned this the expensive way: `motion` became `motion2` only after every
 * video anyone had already hovered kept serving its old eight frame preview.
 *
 * Deliberately not a bump of CACHE_EPOCH, which is shared with every thumbnail
 * and derivative on the deployment and would set two cores re-rendering the
 * whole library.
 */
const TIMELINE_VARIANT = "timeline1";

/**
 * Wall clock for the one ffmpeg invocation.
 *
 * The heaviest job measured on production is 4.0 s (a 79 minute, 470 MB
 * recording). Fifteen seconds is that with room for a cold page cache and a
 * second job on the cores, and it sits inside TIMELINE_TIMEOUT_MS so the process
 * is killed before the response gives up - a response that gave up first would
 * leave a decoder running for nobody.
 */
const TIMELINE_FFMPEG_TIMEOUT_MS = 15_000;

/**
 * JPEG quality of the sheet (ffmpeg's mjpeg scale, 2 best to 31 worst).
 *
 * Measured on a 100 tile sheet: q2 332 kB, q4 203 kB, q6 153 kB, q8 124 kB,
 * q10 107 kB. Six, because the picture is displayed at 160 pixels across inside
 * a tooltip, where the step from q4 costs nothing visible and saves a quarter of
 * the transfer. A WebP sheet of the same tiles was 123 kB but took 904 ms
 * against 596 ms, and would put a second encoder on a public path for 20 %.
 */
const TIMELINE_JPEG_QUALITY = 6;

export type TimelineSheet =
  | { ok: true; buffer: Buffer }
  | { ok: false; refusal: TimelineRefusal };

export type TimelineTrack =
  | { ok: true; vtt: string }
  | { ok: false; refusal: TimelineRefusal };

const refuse = (refusal: TimelineRefusal) => ({ ok: false as const, refusal });

/**
 * The metadata track for this video, or a reason there is none.
 *
 * Costs a probe and some string building, never a decode - which is the point of
 * splitting it from the sheet. The player asks for this on every view, and the
 * sheet only once somebody actually reaches for the scrub bar, so the expensive
 * half is never paid for a video nobody scrubs.
 */
export async function timelineTrack(media: MediaRow, signal: AbortSignal): Promise<TimelineTrack> {
  const cacheable = mayCacheDerived(media);
  const key = derivedKey(media.id, contentTag(media), TIMELINE_VARIANT, "vtt");

  if (cacheable) {
    const hit = await readDerived(key);
    // A cache hit answers without a probe at all, which is the whole reason the
    // key can be computed before the plan is: it names a version of the
    // generator, not a shape of the file.
    if (hit) return { ok: true, vtt: hit.toString("utf8") };
  }

  let source: AvWorkspace | null = null;
  try {
    const opened = await openTimelineSource(media, signal);
    if (!opened.ok) return opened;
    source = opened.source;

    const vtt = timelineVtt(opened.plan);
    if (cacheable) await writeDerived(key, Buffer.from(vtt, "utf8"));
    return { ok: true, vtt };
  } finally {
    if (source) await source.dispose().catch(() => {});
  }
}

/**
 * The sprite sheet for this video, or a reason there is none.
 *
 * Never the original bytes and never a single frame. A player that asked for a
 * sheet and was handed the video would download gigabytes to draw a tooltip,
 * which is the failure the video poster's 415 already exists to prevent.
 */
export async function timelineSheet(media: MediaRow, signal: AbortSignal): Promise<TimelineSheet> {
  const cacheable = mayCacheDerived(media);
  const key = derivedKey(media.id, contentTag(media), TIMELINE_VARIANT, "jpg");

  if (cacheable) {
    const hit = await readDerived(key);
    if (hit) return { ok: true, buffer: hit };
  }

  let source: AvWorkspace | null = null;
  try {
    const opened = await openTimelineSource(media, signal);
    if (!opened.ok) return opened;
    source = opened.source;

    const output = source.output("sheet.jpg");
    await runAvTool(
      "ffmpeg",
      sheetArgs(source.input, opened.container, opened.plan, output),
      { timeoutMs: TIMELINE_FFMPEG_TIMEOUT_MS, signal },
    );

    const sheet = await readFile(output).catch(() => null);
    // Nothing written means the pass found no keyframe it could decode. That is
    // a fact about the file, and the only honest answer is that there is no
    // preview - not a partial sheet, whose empty cells the VTT would still be
    // pointing at.
    if (!sheet || sheet.length === 0) return refuse("unreadable");

    if (cacheable) await writeDerived(key, sheet);
    return { ok: true, buffer: sheet };
  } finally {
    if (source) await source.dispose().catch(() => {});
  }
}

/**
 * The identity the cache addresses these by.
 *
 * The row's checksum when it has one and its size otherwise - the same identity
 * /convert, the poster and the motion preview already use. Both change when the
 * bytes change, so converting a file in place cannot leave a timeline of the old
 * one behind.
 */
function contentTag(media: MediaRow): string {
  return media.checksum ?? `s${media.size}`;
}

type OpenedTimeline =
  | { ok: true; source: AvWorkspace; container: string; plan: TimelinePlan }
  | { ok: false; refusal: TimelineRefusal };

/**
 * Open the file, ask what it is, and turn that into a plan - or refuse.
 *
 * Note what is NOT caught here: `probeAv` throws `AvTimeoutError` and
 * `AvAbortedError`, and both are allowed straight through to the route, which
 * answers 503 and 499. They are facts about the server and the socket, never
 * about the bytes, and swallowing them into a refusal is how "we were busy for a
 * moment" turns into "this video has no preview" - the exact failure av-probe.ts
 * was changed to stop producing.
 */
async function openTimelineSource(
  media: MediaRow,
  signal: AbortSignal,
): Promise<OpenedTimeline> {
  // Asked from the ROW first, before anything is opened. On a non-local storage
  // driver `openVideoSource` stages a copy of the object, so letting a request
  // for the timeline of a PDF or an MP3 reach the probe would mean copying up to
  // 512 MB to be told there is no video in it.
  if (!canTimelinePreview(media)) {
    return refuse(media.size > AV_MAX_INPUT_BYTES ? "too-large" : "not-video");
  }

  const opened = await openVideoSource(media);
  if (!opened.ok) return refuse(opened.error);

  let source: AvWorkspace | null = opened.source;
  try {
    const probe = await probeAv(source.input, { timeoutMs: AV_PROBE_TIMEOUT_MS, signal });
    if (!probe) return refuse("unreadable");
    if (!probe.video) return refuse("not-video");
    if (probe.duration == null) return refuse("unknown-duration");

    const { width, height } = probe.video;
    if (!width || !height) return refuse("unreadable");
    // The one ceiling a sheet has of its own. See maxTimelineFramePixels: the
    // pass holds a decoded picture and a few filter copies of it, so a frame
    // large enough to fill a conversion slot's share of memory is refused rather
    // than attempted inside a container that is also serving the site.
    if (width * height > maxTimelineFramePixels()) return refuse("too-many-pixels");

    const decision = timelinePlan(probe.duration, width, height);
    if (!decision.ok) return decision;

    const handed = source;
    source = null;
    return { ok: true, source: handed, container: probe.container, plan: decision.plan };
  } finally {
    // Disposed on every path that does not hand it to the caller, including the
    // refusals above - a workspace left behind by a refused request is a
    // staged copy of a 400 MB video sitting in the scratch directory.
    if (source) await source.dispose().catch(() => {});
  }
}

/**
 * The one ffmpeg command, and every part of it is load-bearing.
 *
 * `inputArgs` rather than a hand-written `-i`, so the demuxer is FORCED to the
 * one the probe approved from the allowlist and the protocol whitelist comes
 * with it. That is a security control, not tidiness: handed a text file that
 * begins `ffconcat version 1.0`, an ffmpeg left to guess picks the concat
 * demuxer and opens whatever paths the file names. It also matters for ordinary
 * files - one production upload is named `.mkv` and is really an MP4, and
 * choosing the demuxer from the extension fails on it outright.
 *
 * `-discard nokey` sits before `-i` because it is an input option. It is what
 * makes this affordable at all; see the tables in the module header.
 *
 * The filter chain, in the order it has to be in:
 *
 *  1. `fps` picks one picture per slice, starting HALF a slice in so each tile
 *     is a picture of the middle of what it stands for. Frame zero of a video is
 *     black, a fade or a title card far more often than it is content.
 *
 *  2. `tpad` clones the last picture forward, and it is not decoration: `fps`
 *     stops at the last KEYFRAME, not at the end of the file, so without this
 *     the final cells come out black on any video whose last keyframe is more
 *     than half a slice from the end. Measured on production before it was
 *     added: a 22 s clip asked for 23 tiles and got 20, a 14 s clip asked for 15
 *     and got 14, the 4K clip asked for 16 and got 15. With it, every one of
 *     them delivers exactly the number asked for. It comes AFTER `fps` so it
 *     clones at the tile rate rather than at the source's, which bounds the
 *     pathological case (a file with a single keyframe) to one wasted tile's
 *     work instead of one per source frame.
 *
 *  3. `scale` fits the picture inside the tile and `pad` centres it there, which
 *     is a cheap insurance policy rather than a live concern. A phone video
 *     carries its orientation in a rotation matrix, so ffmpeg's output is
 *     1080x1920 while ffprobe's `width`/`height` - which the plan was solved
 *     from - say 1920x1080. Scaling to fixed numbers would squash it; fitting
 *     and padding letterboxes it instead. Zero of the 397 videos on production
 *     today carry a rotation matrix, so this costs nothing now and is correct
 *     when a phone upload makes it stop being zero. `force_divisible_by=2` keeps
 *     the inner picture even for the chroma planes.
 *
 *  4. `tile` composes the grid. `-frames:v 1` then ends the process the moment
 *     the one sheet is written, so nothing keeps reading a file we are done with.
 */
function sheetArgs(
  input: string,
  container: string,
  plan: TimelinePlan,
  output: string,
): string[] {
  const rate = (plan.count / plan.duration).toFixed(9);
  const start = (plan.interval / 2).toFixed(3);
  const pad = plan.duration.toFixed(3);
  const { tileWidth: tw, tileHeight: th } = plan;

  const chain = [
    `fps=fps=${rate}:start_time=${start}`,
    `tpad=stop_mode=clone:stop_duration=${pad}`,
    `scale=${tw}:${th}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bilinear`,
    `pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `tile=${plan.columns}x${plan.rows}`,
  ].join(",");

  return [
    "-hide_banner",
    "-v",
    "error",
    ...inputArgs(input, container, ["-discard", "nokey"]),
    // A sheet has no sound and no subtitles; demuxing them would be work for
    // streams nothing downstream consumes.
    "-an",
    "-sn",
    ...threadArgs(),
    "-vf",
    chain,
    "-frames:v",
    "1",
    "-update",
    "1",
    "-q:v",
    String(TIMELINE_JPEG_QUALITY),
    "-y",
    output,
  ];
}

/** Test seam: the arguments are the part worth pinning, not the process. */
export const TIMELINE_INTERNALS = {
  TIMELINE_VARIANT,
  TIMELINE_FFMPEG_TIMEOUT_MS,
  TIMELINE_JPEG_QUALITY,
  sheetArgs,
};
