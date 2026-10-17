/**
 * What one ffmpeg job is allowed to cost.
 *
 * The image side (lib/media/transform-cost.ts) budgets PIXELS, because a still
 * encoder's cost is a function of area. That is the wrong meter for video: a
 * 37 MB clip and a 37 MB clip of the same resolution can differ by a hundredfold
 * in work depending on whether an encoder runs at all. So the meters here are
 * the ones the operation is actually bound by - bytes for a copy, seconds for an
 * encode - and each ceiling is solved from a measurement.
 *
 * Measured in the production image (ffmpeg 5.1.9), in a container pinned to
 * `--cpus 2 --memory 2g` to match production, against real production uploads:
 *
 *   operation                              wall      output      throughput
 *   .mov -> .mp4, 184 kB (copy)            128 ms     188 kB     ~1.4 GB/s
 *   .mov -> .mkv, 184 kB (copy)            127 ms     187 kB
 *   .mkv -> .mov, 37 MB  (copy)            269 ms      37 MB     ~140 MB/s
 *   .mkv -> .mkv, 37 MB  (copy)            234 ms      37 MB
 *   5.0 MB / 209 s MP3 -> MP4 still       2196 ms     5.1 MB     ~95x realtime
 *   ...same, audio re-encoded to AAC     10920 ms     5.2 MB     ~19x realtime
 *   2.4 MB / 5.1 s GIF -> MP4              231 ms      32 kB     ~22x realtime
 *   209 s MP3 -> OGG (encode)             4001 ms     3.1 MB     ~52x realtime
 *   5 s clip @480px -> gif (encode)        968 ms                 ~5x realtime
 *   43-frame AVIF -> anim WebP             925 ms     457 kB
 *   whole 32 s file -> 480p h264          5556 ms                 ~6x realtime
 *
 * Two conclusions drive everything below.
 *
 * First, MEMORY IS NOT THE CONSTRAINT for video the way it is for stills. The
 * worst case measured is 166 MB, against the 838 MB a 36 Mpx WebP encode costs
 * and the 1380 MB an AVIF encode costs. ffmpeg streams; libvips materialises.
 * So a video job takes the same two-unit conversion slot as an image conversion
 * and lands comfortably inside its 512 MiB share, and the ceilings below are
 * about TIME instead.
 *
 * Second, at six times realtime a full re-encode of a video's PICTURE cannot be
 * an HTTP request. Ten minutes of video is a hundred seconds of both cores. That
 * is why every container entry in av-targets.ts is a stream copy, and why the
 * only encodes on offer are bounded by construction: a clip of at most 15
 * seconds, an audio track, or an animation that is short because animations are.
 *
 * The throughput numbers are for a job with both cores. Two may run at once, so
 * every ceiling is solved against HALF the measured rate.
 */

import type { AvCost, AvSourceKind, AvTarget } from "@/lib/media/av-targets";

// ---------------------------------------------------------------------------
// Slot and deadlines
// ---------------------------------------------------------------------------

/**
 * Units of the shared limiter an ffmpeg job holds - the same two an image
 * conversion takes, so at most two run at once and neither kind can crowd the
 * other out. Sized by memory (peak 166 MB against a 512 MiB share) with room for
 * inputs larger than anything on production today.
 */
export const AV_WEIGHT = 2;

/**
 * Deadline for a stream copy.
 *
 * A 512 MiB remux is 3.7 s of measured throughput, 7.5 s if a second job is
 * sharing the cores. 45 s is that with room for a cold page cache, and it is a
 * bound on the RESPONSE - the process itself is killed by its own group timeout
 * (lib/media/ffmpeg.ts), which for these is the same number.
 */
export const AV_COPY_TIMEOUT_MS = 45_000;

/** Deadline for anything that runs an encoder. */
export const AV_ENCODE_TIMEOUT_MS = 60_000;

/**
 * ...and the longer one for the single target that re-encodes a video's whole
 * PICTURE, which is a different order of work from everything else here.
 *
 * Measured on the production container (two cores, 2 GiB, ffmpeg 5.1.9) against
 * real uploads, converting each to a 1920-edge H.264 copy:
 *
 *   source                              total pixels   wall     rate
 *   5056x1924, 403 frames, 2.1 MB          3.92 Gpx    9.5 s   412 Mpx/s
 *   2560x1440, 1150 frames, 76 MB          4.24 Gpx   31.6 s   134 Mpx/s
 *   3840x2160,  903 frames, 72 MB          7.49 Gpx   61.7 s   121 Mpx/s
 *
 * The three rates differ by more than three to one, and the reason is worth
 * writing down: the first file is the starved capture this feature exists for -
 * 1.3 Mbit/s of residual for 9.7 Mpx frames - so its DECODE is nearly free
 * (3.4 s measured on its own, against 19.4 s for the 4K file). Source pixels is
 * therefore the conservative meter, and the ceiling below is solved against the
 * WORST of the three rather than the average.
 *
 * 8 Gpx at 121 Mpx/s is 66 s alone and about 132 s with a second job sharing the
 * cores, which is what AV_WEIGHT allows. 150 s is that with headroom.
 */
export const AV_WEB_TIMEOUT_MS = 150_000;

/** ffprobe is a header read. If it has not answered by now the file is broken. */
export const AV_PROBE_TIMEOUT_MS = 10_000;

/**
 * The deadline for one option, in one place.
 *
 * Both the argument builder and the limiter need this number, and they used to
 * derive it separately from `cost`. That was fine while every encode shared one
 * ceiling; the moment one of them did not, two derivations became two chances to
 * give a job less time than its own process is allowed - which shows up as a
 * limiter that gives up while ffmpeg is still working, and a slot released to a
 * caller whose predecessor is still spending both cores.
 */
export function avTimeoutFor(to: AvTarget, cost: AvCost): number {
  if (to === "webmp4") return AV_WEB_TIMEOUT_MS;
  return cost === "encode" ? AV_ENCODE_TIMEOUT_MS : AV_COPY_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Input ceilings
// ---------------------------------------------------------------------------

/**
 * Largest file ffmpeg will be pointed at.
 *
 * Comfortably above everything on production (largest video: 400 MB) while
 * keeping the worst-case copy inside its deadline. Note this is far above
 * MAX_TRANSFORM_BYTES (32 MB) on the image path, and it can be: nothing here
 * reads the file into memory, ffmpeg streams from disk and writes to disk.
 */
export const AV_MAX_INPUT_BYTES = 512 * 1024 * 1024;

/**
 * Longest source an audio extraction will re-encode.
 *
 * 52x realtime measured, 26x assuming a second job shares the cores: 15 minutes
 * of audio is 35 s of work, which fits the encode deadline. Beyond this the
 * honest answer is a refusal that names the limit, not a truncated file the user
 * has no way of knowing is truncated.
 */
export const AV_MAX_AUDIO_SECONDS = 15 * 60;

/**
 * ...and the much shorter one for WAV, which is bounded by its OUTPUT.
 *
 * PCM does not compress: 16-bit stereo at 44.1 kHz is 10.6 MB per minute
 * whatever went in. At the general 15 minute ceiling a single click would
 * produce a 158 MB download and a 158 MB cache entry, from a 5 MB source. Five
 * minutes caps that at roughly 53 MB, which is a file somebody might actually
 * want. The other two encoders shrink their input, so only this one needs it.
 */
export const AV_MAX_WAV_SECONDS = 5 * 60;

/**
 * Longest audio that will be wrapped in a video with a still picture, when the
 * sound has to be RE-ENCODED to get there.
 *
 * Two very different rates hide behind one menu entry, so there are two
 * ceilings. Measured on a 209 s production MP3: with `-c:a copy` (which MP4
 * allows for AAC, MP3 and ALAC) the whole job is 2196 ms, about 95x realtime -
 * the still picture is nearly all of it, and 15 minutes costs under 20 s even
 * with a second job on the cores. Re-encoding to AAC instead takes 10920 ms,
 * 19x realtime, so at half rate 15 minutes would be 95 s and blow the 60 s
 * deadline. Six minutes leaves it at 38 s, which fits with room to spare.
 *
 * A WAV or a FLAC therefore gets the shorter ceiling and an MP3 does not, which
 * is exactly the distinction the user would draw if they knew how the file was
 * built.
 */
export const AV_MAX_AUDIO_VIDEO_SECONDS = 6 * 60;

/**
 * Longest animation that will be re-encoded whole.
 *
 * Unlike a video clip, an animation is converted in full - taking the first six
 * seconds of a 43-frame loop would be vandalism. So the bound is the source's
 * own length, and 2 minutes is far past anything a GIF or an AVIF sequence
 * plausibly is (the largest on production is 5.1 s). At the 22x realtime
 * measured for GIF -> MP4, and half that under load, 2 minutes is 11 s of work.
 */
export const AV_MAX_ANIMATION_SECONDS = 120;

/**
 * Most source pixels a web-playable copy will re-encode: width x height x
 * frames, counted over the whole file.
 *
 * SECONDS is the wrong meter here, and it is the one every other encode on this
 * menu uses. A minute of 3840x2160 at 60 fps is four times the work of a minute
 * of 2560x1440 at 30, and this target is only ever offered to files above
 * 1920 - that is, to exactly the recordings where the difference is largest. So
 * the budget counts frames, the way the image side counts them
 * (lib/media/transform-cost.ts), rather than trusting a duration.
 *
 * What 8 Gpx admits, in the shapes that actually turn up here:
 *
 *   3840x2160 @60     15 s        2560x1440 @60     36 s
 *   3840x2160 @30     31 s        2560x1440 @30     72 s
 *   5056x1924 @30     27 s        2560x1080 @60     48 s
 *
 * Every ShareX capture on this server fits. A ten minute 4K recording does not,
 * and is refused with `too-many-pixels` and the limit, because at roughly two
 * minutes of both cores it is not an HTTP request - it is a background job this
 * application does not have.
 */
export const AV_MAX_WEB_PIXELS = 8_000_000_000;

/**
 * Longest clip an animation target will produce from a VIDEO, and the default
 * when the caller does not ask for one.
 *
 * A GIF runs at about 5x realtime and a 15 s clip at 480px is roughly 3 s of
 * work. The cap is also a kindness: a 30-second GIF is tens of megabytes and
 * nobody wants the file they just asked for.
 */
export const AV_MAX_CLIP_SECONDS = 15;
export const AV_DEFAULT_CLIP_SECONDS = 6;

/** Frame rate and width an animation is rendered at. Bounded, never chosen. */
export const AV_ANIMATION_FPS = 12;
export const AV_ANIMATION_WIDTH = 480;

/**
 * Frame rate of the still-picture video built around an audio track.
 *
 * One frame per second, not the 25 a video normally carries, because every frame
 * is the same frame. Measured on the 209 s MP3: at 1 fps the encode is 2196 ms
 * and the picture adds 86 kB to a 5.0 MB source; at 2 fps it is 4210 ms and
 * 125 kB. Nobody watching a static logo can tell the difference, and halving the
 * work of the single most expensive entry in the menu is worth having.
 */
export const AV_STILL_FPS = 1;

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export type AvBudget =
  | { ok: true; clipSeconds: number | null }
  | { ok: false; reason: "too-large" | "too-long" | "too-many-pixels"; limit: number };

export interface AvBudgetInput {
  bytes: number;
  /** Seconds, or null when the container does not say. */
  duration: number | null;
  /** What the ROW says the source is - see AvSourceKind. */
  sourceKind?: AvSourceKind;
  /**
   * Can the audio track be copied into MP4 rather than re-encoded? Known only
   * after the probe, and it moves the audio-to-video ceiling by a factor of five.
   */
  audioCopyable?: boolean;
  /**
   * Picture pixels in the whole file (width x height x frames), from the probe.
   *
   * Null means the file did not say how many frames it holds AND its duration
   * or frame rate is missing too - see lib/media/av-meta.ts, which counts first
   * and estimates second. Only the web target reads it, and it treats null as
   * "cannot promise to finish" rather than as "small".
   */
  pixels?: number | null;
}

/**
 * May this job run, and over how much of the file?
 *
 * Pure, so the interesting cases are unit tests. `duration` may be null - some
 * containers do not carry one - and that is treated as "unknown, not unlimited"
 * for whole-file encodes: a file we cannot measure is one we cannot promise to
 * finish, and the clip targets bound themselves anyway.
 */
export function avBudget(
  to: AvTarget,
  cost: AvCost,
  input: AvBudgetInput,
  requestedClip?: number | null,
): AvBudget {
  if (input.bytes > AV_MAX_INPUT_BYTES) {
    return { ok: false, reason: "too-large", limit: AV_MAX_INPUT_BYTES };
  }

  // A copy is bounded by size alone; length does not enter into it.
  if (cost === "copy") return { ok: true, clipSeconds: null };

  const wholeAnimation = input.sourceKind === "image-sequence";

  // The one target whose cost is neither bytes nor seconds. See
  // AV_MAX_WEB_PIXELS for why, and for what the number admits.
  if (to === "webmp4") {
    const pixels = input.pixels;
    if (pixels == null || pixels <= 0) {
      // Unmeasurable, which is not the same as small. Refused as "too long" -
      // the honest reading of "we cannot tell how much of this there is" - and
      // it is the same refusal an audio encode gives for a missing duration.
      return { ok: false, reason: "too-long", limit: AV_MAX_WEB_PIXELS };
    }
    if (pixels > AV_MAX_WEB_PIXELS) {
      return { ok: false, reason: "too-many-pixels", limit: AV_MAX_WEB_PIXELS };
    }
    return { ok: true, clipSeconds: null };
  }

  if (to === "gif" || to === "webp") {
    if (wholeAnimation) return animationBudget(input.duration);

    const asked = requestedClip ?? AV_DEFAULT_CLIP_SECONDS;
    // Clamped, never refused: asking for a longer GIF than we make is a
    // preference, not an error, and the response says how long it really is.
    const clip = Math.min(Math.max(1, asked), AV_MAX_CLIP_SECONDS);
    return { ok: true, clipSeconds: input.duration ? Math.min(clip, input.duration) : clip };
  }

  // MP4 is the one target reachable from two very different sources: an
  // animation being re-encoded whole, and an audio track being given a picture.
  if (to === "mp4") {
    if (wholeAnimation) return animationBudget(input.duration);
    const ceiling = input.audioCopyable ? AV_MAX_AUDIO_SECONDS : AV_MAX_AUDIO_VIDEO_SECONDS;
    return wholeFile(input.duration, ceiling);
  }

  // Whole-file audio encode: the only target whose cost really is the length.
  // WAV answers to its output size instead - see AV_MAX_WAV_SECONDS.
  return wholeFile(input.duration, to === "wav" ? AV_MAX_WAV_SECONDS : AV_MAX_AUDIO_SECONDS);
}

function wholeFile(duration: number | null, ceiling: number): AvBudget {
  if (duration == null || duration > ceiling) {
    return { ok: false, reason: "too-long", limit: ceiling };
  }
  return { ok: true, clipSeconds: null };
}

/**
 * An animation is converted whole, so there is no clip to return - only a
 * refusal if it is implausibly long. A missing duration is allowed here, unlike
 * for audio: an animation's cost is bounded by its own frame count, and the
 * input size ceiling already bounds that.
 */
function animationBudget(duration: number | null): AvBudget {
  if (duration != null && duration > AV_MAX_ANIMATION_SECONDS) {
    return { ok: false, reason: "too-long", limit: AV_MAX_ANIMATION_SECONDS };
  }
  return { ok: true, clipSeconds: null };
}

/**
 * Width to render an animation at: never up, only down.
 *
 * Upscaling a 160px source to 480 makes a bigger file out of the same picture,
 * which is the opposite of what a share-ready clip wants.
 */
export function animationWidth(sourceWidth: number | null): number {
  if (!sourceWidth || sourceWidth <= 0) return AV_ANIMATION_WIDTH;
  return Math.min(sourceWidth, AV_ANIMATION_WIDTH);
}
