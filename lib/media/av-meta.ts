/**
 * What a stored audio or video file IS, in the five columns the row keeps.
 *
 * Until this existed, `select count(*) filter (where width is not null) from
 * uploads where mime_type like 'video/%'` answered 0 out of 467 on production.
 * Round 8 backfilled 8052 images and video was never done, so every consumer
 * downstream was blind: a tile could not be sized from the row, an embed fell
 * back to a hardcoded 1280x720 whatever the file really was, and the question
 * that started this work - "why does this recording stutter?" - could not be
 * asked at all without opening the bytes again.
 *
 * The answers live here rather than in the two callers because the upload path
 * and the backfill script must write the SAME numbers. Two readings of one
 * ffprobe output is how a repaired row stops matching a freshly uploaded one.
 *
 * Cost, measured in the production image (ffmpeg 5.1.9, `--cpus 2`) over 59 real
 * videos from 0.2 MB to 419 MB: 136 ms median warm, 158 ms median cold, and of
 * that 120 ms is the bare cost of spawning ffprobe at all (measured separately
 * against /dev/null). So the file's SIZE barely enters into it - the 419 MB file
 * answered in 144 ms warm - because a probe reads a header and seeks; it never
 * decodes. That is the whole reason this is affordable on the upload path.
 */

import { AV_MAX_INPUT_BYTES, AV_PROBE_TIMEOUT_MS } from "@/lib/media/av-cost";
import { probeAv, type AvProbe } from "@/lib/media/av-probe";
import { openAvWorkspace } from "@/lib/media/av-workspace";
import { frameTotal } from "@/lib/media/playback-health";
import { ffmpegAvailable } from "@/lib/media/ffmpeg";
import { getStorage } from "@/lib/storage";

/** The columns an audio/video row can learn from one probe. */
export interface AvMeta {
  /** Picture size. Null for audio, and for a video stream ffprobe cannot size. */
  width: number | null;
  height: number | null;
  /**
   * Frames ffprobe COUNTED (`nb_frames`), never a number derived from anything
   * else. Absent on about one production video in twenty - see frameCount() for
   * the fallback, which deliberately lives outside the stored column so that
   * "counted" and "estimated" stay distinguishable in the database.
   */
  frames: number | null;
  /** Seconds, or null when the container does not say. */
  durationSeconds: number | null;
  /** Frames per second; see AvStream.fps. */
  fps: number | null;
}

/** Nothing learned. Used as the "probe said no" answer so callers never branch on undefined. */
export const NO_AV_META: AvMeta = {
  width: null,
  height: null,
  frames: null,
  durationSeconds: null,
  fps: null,
};

/**
 * Project a probe onto the row's columns.
 *
 * Pure, so every shape that has ever surprised us is a unit test rather than a
 * production surprise. `probe.video` is already the non-cover-art stream, so an
 * MP3 with an embedded JPEG contributes a duration and nothing else - recording
 * 600x600 for a file that is three minutes of audio would make it look like a
 * picture to every consumer that asks the row whether it has dimensions.
 */
export function avMetaFrom(probe: AvProbe): AvMeta {
  const video = probe.video;
  return {
    width: video?.width ?? null,
    height: video?.height ?? null,
    frames: video?.frames ?? null,
    durationSeconds: probe.duration,
    fps: video?.fps ?? null,
  };
}

/**
 * How many picture frames the file holds, counted if possible and estimated if
 * not.
 *
 * The estimate is NOT written to `uploads.frames`: that column means "somebody
 * counted", which is exactly the distinction lib/media/convert-targets.ts draws
 * when it decides whether a WebP is animated. A derived number stored there
 * would make "43 frames" and "roughly 460 frames" indistinguishable forever.
 * Callers that only want a total - total pixels, bits per pixel - ask here.
 */
export function frameCount(meta: AvMeta): number | null {
  // One implementation, in the module the browser is allowed to import. This
  // file reaches for ffmpeg and storage, so a client component asking the same
  // question cannot come here - and two copies of this arithmetic is how the
  // panel's warning and the backfill script would come to disagree about how
  // many frames a file holds.
  return frameTotal(meta);
}

/**
 * Picture pixels in the whole file: width x height x frames.
 *
 * The meter a full re-encode is budgeted against (lib/media/av-cost.ts), and the
 * same arithmetic that makes a stuttering recording diagnosable - bits per pixel
 * is the file's size in bits divided by this. Null when the file holds no
 * picture, or when neither a counted frame total nor a duration-and-rate pair is
 * available to build one.
 */
export function totalSourcePixels(probe: AvProbe): number | null {
  const meta = avMetaFrom(probe);
  if (!meta.width || !meta.height) return null;
  const frames = frameCount(meta);
  if (frames == null || frames <= 0) return null;
  return meta.width * meta.height * frames;
}

export interface ProbeStoredOptions {
  /**
   * May the bytes be COPIED out of storage first?
   *
   * False on the upload path, and that is the load-bearing setting. With the
   * local driver the stored file is already on a filesystem ffmpeg can open, so
   * a probe costs one process; with S3 there is no such path and honouring this
   * would mean downloading the whole object back out of the bucket seconds
   * after uploading it to it. An offline backfill can pay that and says so; a
   * request finishing an upload cannot.
   */
  stageRemote?: boolean;
  signal?: AbortSignal;
}

/**
 * Probe a file that is already in storage, without ever failing the caller.
 *
 * Returns null - not a throw - for every reason there might be no answer: no
 * ffmpeg in the image, no local path and no permission to stage one, a file
 * that is not media we accept, a probe that timed out, a file that vanished.
 *
 * Swallowing the timeout is correct HERE and wrong in lib/media/av-action.ts,
 * and the difference is worth stating because the opposite mistake was a real
 * bug: av-action REMEMBERS a verdict for ten minutes and then serves it, so a
 * killed probe cached as "unreadable" turned a healthy video into a broken one
 * for everybody. Nothing is remembered here. A probe that does not answer
 * leaves the columns NULL, which is what they already were, and the backfill
 * script picks the row up on its next run.
 */
export async function probeStoredAvMeta(
  storageKey: string,
  opts: ProbeStoredOptions = {},
): Promise<AvMeta | null> {
  if (!(await ffmpegAvailable())) return null;

  const direct = getStorage().localPath?.(storageKey) ?? null;
  if (direct) return probeOrNull(direct, opts.signal);

  if (!opts.stageRemote) return null;

  const ws = await openAvWorkspace(storageKey, AV_MAX_INPUT_BYTES).catch(() => null);
  if (!ws || "error" in ws) return null;
  try {
    return await probeOrNull(ws.input, opts.signal);
  } finally {
    await ws.dispose().catch(() => {});
  }
}

async function probeOrNull(path: string, signal?: AbortSignal): Promise<AvMeta | null> {
  try {
    const probe = await probeAv(path, { timeoutMs: AV_PROBE_TIMEOUT_MS, signal });
    return probe ? avMetaFrom(probe) : null;
  } catch {
    // AvTimeoutError / AvAbortedError / a spawn failure. All of them mean "no
    // answer this time", and none of them is worth failing an upload whose
    // bytes are already on disk.
    return null;
  }
}
