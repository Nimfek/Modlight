import { unlink } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { AV_MAX_INPUT_BYTES, AV_PROBE_TIMEOUT_MS } from "@/lib/media/av-cost";
import { frameOffset } from "@/lib/media/av-convert";
import { probeAv } from "@/lib/media/av-probe";
import { openAvWorkspace, type AvWorkspace } from "@/lib/media/av-workspace";
import { ffmpegAvailable, inputArgs, runAvTool } from "@/lib/media/ffmpeg";
import { derivedKey, mayCacheDerived, readDerived, writeDerived } from "@/lib/media/derived-cache";
import type { MediaRow } from "@/lib/media/serve";

/**
 * One still frame from a video, for use as a tile.
 *
 * Why this exists: the desktop client draws its file grid from `thumbUrl`, and
 * that field was null for every video, so a library full of screen recordings
 * rendered as a wall of grey icons. The web panel gets away with having no
 * poster because a browser will draw one itself from `<video preload="metadata">`;
 * a desktop client cannot do that without downloading the video.
 *
 * The reason this is affordable at all is that `-ss` BEFORE `-i` makes ffmpeg
 * seek rather than decode: a frame out of a 700 MB recording costs about what
 * reading a few megabytes costs, not what transcoding costs. Everything below
 * exists to keep it that way.
 */

/** Wall clock for the extract. A seek-and-one-frame job that takes longer than
 *  this is not slow, it is broken - a damaged index, or a file that is not
 *  really seekable. */
const POSTER_TIMEOUT_MS = 10_000;

/**
 * The frame is captured at this width and then handed to the normal thumbnail
 * path, which does the real resizing. Larger than any tile we serve, so one
 * cached frame can answer every requested size, and small enough that the
 * encode is trivial.
 */
const POSTER_CAPTURE_WIDTH = 1280;

/**
 * A still frame for this row, or null when there is not going to be one.
 *
 * Null means "no poster", never "serve the original instead" - the caller must
 * not fall through to streaming the file, because answering a request for a 4 kB
 * tile with a 700 MB video is precisely the failure this is meant to prevent.
 */
export async function videoPoster(media: MediaRow, signal: AbortSignal): Promise<Buffer | null> {
  // The cache is keyed on the row's own checksum when it has one, and on its
  // size otherwise - the same identity /convert uses. Both change when the bytes
  // change, so converting a file in place cannot leave a poster of the old one.
  const cacheable = mayCacheDerived(media);
  const key = derivedKey(media.id, media.checksum ?? `s${media.size}`, "poster", "jpg");

  if (cacheable) {
    const hit = await readDerived(key);
    if (hit) return hit;
  }

  let ws: AvWorkspace | null = null;
  try {
    const opened = await openVideoSource(media);
    if (!opened.ok) return null;
    ws = opened.source;

    // The probe is what makes the offset honest. Without a duration we would
    // have to guess, and the guess that looks obvious - frame zero - is the one
    // that is very often a black frame or a fade-in.
    const probe = await probeAv(ws.input, { timeoutMs: AV_PROBE_TIMEOUT_MS, signal });
    if (!probe || !probe.video) return null;

    const at = frameOffset(null, probe.duration);
    const output = ws.output("poster.jpg");

    await runAvTool(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        // `inputArgs` rather than a hand-written `-i`, and that is a security
        // fix rather than tidying. Without it this invocation let ffmpeg
        // AUTODETECT the demuxer, which is the one default lib/media/ffmpeg.ts
        // calls load-bearing: a text file beginning `ffconcat version 1.0` is
        // read by the concat demuxer, which then opens whatever paths it names.
        // Every other ffmpeg call in the codebase forces the container from the
        // allowlist the probe just approved; this one was written before that
        // rule had a helper and did not. It also brings the protocol whitelist,
        // so a crafted file cannot make ffmpeg fetch a URL for us.
        //
        // `-ss` goes BEFORE `-i` on purpose. After it, ffmpeg decodes
        // everything up to the offset, which turns a cheap seek into a full
        // decode of the file.
        ...inputArgs(ws.input, probe.container, ["-ss", String(at)]),
        "-frames:v",
        "1",
        // Even the seek can land past the end on a file whose duration is a
        // lie; -update lets the single-image output overwrite rather than fail.
        "-update",
        "1",
        "-vf",
        `scale=${POSTER_CAPTURE_WIDTH}:-2:flags=bilinear`,
        "-q:v",
        "4",
        "-y",
        output,
      ],
      { timeoutMs: POSTER_TIMEOUT_MS, signal },
    );

    const frame = await readFile(output).catch(() => null);
    if (!frame || frame.length === 0) return null;

    if (cacheable) await writeDerived(key, frame);
    return frame;
  } catch {
    // A poster is decoration. Nothing here is worth turning a tile request into
    // a 500, and the caller treats null as "no poster".
    return null;
  } finally {
    if (ws) await ws.dispose().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Opening a video for ANY of the frame grabbers
// ---------------------------------------------------------------------------

/**
 * Why a video cannot be opened at all, in a vocabulary both frame grabbers
 * share. The timeline sheet turns these into `X-Timeline-Refused`; the poster
 * turns all three into "no poster" and lets the route answer 415.
 */
export type VideoSourceError = "too-large" | "no-engine" | "unreadable";

export type VideoSourceResult =
  | { ok: true; source: AvWorkspace }
  | { ok: false; error: VideoSourceError };

/**
 * A video ready for ffmpeg to read, or a reason there is not one.
 *
 * The three checks in front of every frame grab, in cheapest-first order: is the
 * file inside the ceiling the audio/video path budgets for, is there an engine
 * at all, and can the bytes be put somewhere ffmpeg can open them. Extracted
 * here, rather than copied into lib/media/timeline.ts, because the ceiling is
 * the interesting one and two copies of a ceiling is one copy that gets raised
 * and one that does not.
 *
 * `AV_MAX_INPUT_BYTES` is far above the image path's `MAX_TRANSFORM_BYTES`, and
 * it can be: nothing here reads the file into memory. ffmpeg streams from disk,
 * and on the local driver `openAvWorkspace` hands over the stored path itself
 * without copying a byte.
 */
export async function openVideoSource(
  media: Pick<MediaRow, "size" | "storageKey">,
): Promise<VideoSourceResult> {
  if (media.size > AV_MAX_INPUT_BYTES) return { ok: false, error: "too-large" };
  if (!(await ffmpegAvailable())) return { ok: false, error: "no-engine" };

  const opened = await openAvWorkspace(media.storageKey, AV_MAX_INPUT_BYTES);
  if ("error" in opened) {
    return { ok: false, error: opened.error === "too-large" ? "too-large" : "unreadable" };
  }
  return { ok: true, source: opened };
}

/** Test seam: the arguments are the part worth pinning, not the process. */
export const POSTER_INTERNALS = { POSTER_TIMEOUT_MS, POSTER_CAPTURE_WIDTH, unlink };
