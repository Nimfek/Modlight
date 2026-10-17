/**
 * The policy half of the moving thumbnail: who gets one, which stretch of the
 * file it is made of, and how fast it plays. Pure - no sharp, no ffmpeg, no
 * storage - so every decision here is a unit test, and so the API route can ask
 * "would this row produce one?" without dragging a media engine into its bundle.
 *
 * The engine that acts on these answers is lib/media/motion.ts.
 *
 * WHY A MOVING TILE AT ALL. A video row already gets a still poster frame
 * (lib/media/poster.ts), and a still is enough to tell a screen recording from a
 * photo but not enough to tell two screen recordings apart. An animated GIF is
 * worse off still: it goes down the image path, which hands back the first frame
 * of a file whose entire content is that it moves.
 *
 * WHY A CLIP RATHER THAN A SPREAD. The first version of this sampled eight
 * frames across the whole file, and next to the real video playing in the panel
 * it read as a slideshow. Raising the count was not the fix: on that shape the
 * cost is the SEEK, measured at about 0.85 s each on a 4K source, so sixteen
 * frames would have been fourteen seconds of ffmpeg for a tile. One seek
 * followed by a forward decode buys thirty frames for less than eight seeks cost
 * - see the measured table in transform-cost.ts - and thirty contiguous frames
 * at 12 fps look like video, which is the thing that was actually being asked
 * for.
 *
 * WHY A PARAMETER RATHER THAN A ROUTE. `/{tag}/{code}/raw` already takes `w`,
 * `h` and `fit`, already snaps sizes to a fixed list so a caller cannot mint
 * unlimited renders, and already carries the password gate, the view-budget
 * exemption for previews and the cache headers. A second route would be a second
 * copy of all of that, and the copy is where they drift apart.
 *
 * WHY `motion`. It is the word this codebase already uses for the property being
 * asked about: `ConvertTarget.motion` in convert-targets.ts is `keeps` or
 * `single`, and the download menu says "single frame" with it. `anim` would have
 * been a format hint (it is not - the answer is always WebP) and `preview` is
 * already taken by three other things in here. The value is a flag, not a
 * number, which keeps the render set at (sizes x fit x 2) rather than opening a
 * new axis a caller can enumerate.
 */

import { mediaKind } from "@/lib/media/mime";
import { MOTION_CLIP_FPS, MOTION_CLIP_SECONDS, MOTION_FRAMES } from "@/lib/media/transform-cost";
import { MAX_TRANSFORM_BYTES } from "@/lib/media/transform-cost";
import { AV_MAX_INPUT_BYTES } from "@/lib/media/av-cost";

/** Query flag that asks for a preview that moves. Only `1` counts. */
export const MOTION_PARAM = "motion";

/** Why a motion preview cannot be produced. One vocabulary, server and client. */
export type MotionRefusal =
  | "not-animated"
  | "too-large"
  | "too-many-pixels"
  | "unknown-duration"
  | "unreadable"
  | "no-engine";

/**
 * Milliseconds each frame of a VIDEO clip is shown.
 *
 * The reciprocal of the capture rate, so the preview plays at REAL TIME. The
 * spread this replaced showed each of its eight frames for 400 ms, and it had
 * to: frames drawn from eight places in a file have no shared clock, so playing
 * them at any particular rate would have been a claim about a continuity that
 * was not there. A clip has the clock the source had, and the whole point of it
 * is that it moves the way the file moves.
 */
export const MOTION_FRAME_DELAY_MS = Math.round(1000 / MOTION_CLIP_FPS);

/** Bounds on a per-frame delay, whatever the source claims. */
export const MOTION_MIN_DELAY_MS = 40;
export const MOTION_MAX_DELAY_MS = 2_000;

/**
 * Tile size used when a caller asks for `motion=1` and names no size.
 *
 * A member of the serving route's THUMB_SIZES, so the "sizes are snapped to a
 * fixed list" property holds for the default as much as for an explicit ask, and
 * it is the size `GET /api/uploads` advertises - so the default and the
 * advertised URL share one cache entry instead of minting two renders.
 */
export const MOTION_DEFAULT_SIZE = 480;

/**
 * Largest edge a moving tile is ever produced at, and the width video frames are
 * captured at before the tile resize.
 *
 * A CEILING, not a default: the still thumbnail path snaps to sizes up to 1200,
 * and a tile that size holding thirty frames would be megabytes - a download
 * dressed as a tile.
 *
 * It stays 480 under the longer clip even though the artefact grew, because 480
 * is also what `/api/uploads` and `/api/link-info` advertise for the STILL tile,
 * and a client swapping one for the other on hover must not see the picture
 * change size. Measured at 480 with 30 frames: 247-410 kB for a video clip and
 * 97-405 kB for an animation, against 65-138 kB for the eight-frame spread.
 * Cutting the edge to 320 would have saved about a third of that and cost the
 * swap, which is a worse trade than the bytes are worth - the artefact is cached
 * per file and fetched on hover, one at a time.
 */
export const MOTION_CAPTURE_WIDTH = 480;

/** Clamp a requested tile edge to what a moving preview is offered at. */
export function clampMotionEdge(edge: number | undefined): number | undefined {
  if (edge == null) return undefined;
  return Math.min(edge, MOTION_CAPTURE_WIDTH);
}

/**
 * Where in a video the clip starts, as a fraction of its length, and the cap on
 * that fraction.
 *
 * NOT frame zero. Videos open on black, on a fade-in, on a title card or on a
 * player's splash screen far more often than they open on their content - which
 * is why the still poster starts a second in rather than at the beginning. A
 * tenth of the way in clears that on a short clip; the cap stops an hour-long
 * recording from starting six minutes in, by which point "what this file opens
 * with" has stopped being the question the tile answers.
 */
export const MOTION_CLIP_START_FRACTION = 0.1;
export const MOTION_CLIP_START_MAX_SECONDS = 10;

/**
 * Kept clear of the very last picture.
 *
 * A container's duration is a claim, and a decode that runs past the end of the
 * pictures produces nothing for the frames it wanted there.
 */
export const MOTION_CLIP_TAIL_GUARD = 0.05;

/**
 * What the row says about itself, as far as this decision is concerned. Written
 * as a structural type rather than as `MediaRow` so the API route, which holds
 * `FileItem`, can ask the same question without a conversion.
 */
export interface MotionCandidate {
  mimeType: string | null;
  ext: string | null;
  size: number;
  /** Frames the DECODER reported when the file was ingested; null = unknown. */
  frames: number | null;
}

/**
 * Could this row produce a preview that moves?
 *
 * Answered from the row alone, with no read and no decode, because it is also
 * what `GET /api/uploads` publishes a URL from. The rule the still `thumbUrl`
 * follows applies here with more force: a client that trusts a URL it cannot get
 * a tile from downloads the whole file to draw one, and on this path "the whole
 * file" is a video.
 *
 * Two kinds qualify and they are bounded by different numbers, for the reason
 * av-cost.ts sets out. An animated image is READ AND DECODED, so it answers to
 * MAX_TRANSFORM_BYTES. A video is SEEKED ONCE and then decoded forward for a
 * couple of seconds - ffmpeg never reads the whole file - so it answers to the
 * much larger ceiling the audio/video path already uses.
 *
 * A still image is refused rather than quietly served as a one-frame animation:
 * "this does not move" is the true answer and the client can keep its still
 * tile. An image whose frame count was never recorded (`frames` is null: legacy
 * rows, and the AVIF sequence whose frames libvips will not enumerate) is
 * refused too. That is the same discipline `canThumbnail` follows - advertise
 * only what is certain - and it costs nothing, because those rows still get the
 * still thumbnail they get today.
 */
export function canMotionPreview(row: MotionCandidate): boolean {
  const kind = mediaKind(row.mimeType, row.ext);
  if (kind === "video") return row.size > 0 && row.size <= AV_MAX_INPUT_BYTES;
  if (kind !== "image") return false;
  return row.frames != null && row.frames > 1 && row.size <= MAX_TRANSFORM_BYTES;
}

/** Did the caller ask for a preview that moves? */
export function wantsMotion(params: URLSearchParams): boolean {
  return params.get(MOTION_PARAM) === "1";
}

/** One stretch of a video: where to seek to, and how much to decode from there. */
export interface MotionClip {
  start: number;
  seconds: number;
}

/**
 * Which stretch of a video to take, in seconds.
 *
 * `seconds` is what the BUDGET allows (transform-cost.ts solves it from the
 * frame size and the source's rate); what this function adds is what the FILE
 * allows. Both numbers it returns are finite and non-negative, and `start +
 * seconds` never reaches the last picture, because `start` becomes an ffmpeg
 * `-ss` and `seconds` becomes a `-t`.
 *
 * A file shorter than the clip is not a failure - it is a shorter clip, taken
 * from the beginning, because there is nowhere else for it to come from.
 */
export function videoClip(duration: number, seconds = MOTION_CLIP_SECONDS): MotionClip | null {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  const usable = duration - MOTION_CLIP_TAIL_GUARD;
  if (usable <= 0) return null;

  const want = Math.min(seconds, usable);
  const preferred = Math.min(duration * MOTION_CLIP_START_FRACTION, MOTION_CLIP_START_MAX_SECONDS);
  // Never so late that the clip would run off the end: the start yields to the
  // length, because a clip that is cut short by the file is worse than one that
  // begins a little earlier than the fraction would like.
  const start = Math.min(preferred, Math.max(0, usable - want));

  return { start: round3(start), seconds: round3(Math.min(want, usable - start)) };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** One stretch of an animation: which page to start at, and how many to take. */
export interface MotionPageRun {
  start: number;
  count: number;
}

/**
 * Which pages of an animation to take.
 *
 * A run from page ZERO, not a spread across the sequence, and page zero is not
 * an arbitrary choice: it is the frame the still thumbnail already shows, so the
 * moving tile is that picture continuing rather than a different picture. It is
 * also the cheapest run there is - reading page p costs decoding pages 0..p, so
 * starting anywhere else means paying for frames nobody sees.
 *
 * What is given up is coverage: a 256-page GIF now shows its first twelve per
 * cent instead of eight stills from end to end. That is the trade the whole
 * change is - an animation playing its opening seconds looks like the animation,
 * and eight stills from across it never did.
 *
 * `count` comes from the budget. An animation with no more pages than that is
 * taken whole.
 */
export function clipPages(pages: number, count = MOTION_FRAMES): MotionPageRun | null {
  if (!Number.isInteger(pages) || pages < 2) return null;
  if (!Number.isFinite(count) || count < 2) return null;
  return { start: 0, count: Math.min(pages, Math.floor(count)) };
}

/**
 * Per-frame delays for the finished preview, in milliseconds.
 *
 * `source` is the decoder's own delay array when there is one, which is the case
 * for an animation and never for a video clip. Using it matters more than it
 * looks: a GIF that holds its first frame for a second and then runs at 20 fps
 * is extremely common, and a uniform delay turns that into a file that plays
 * nothing like itself. A video clip has no such array and does not need one -
 * every frame was captured at the same rate.
 *
 * Every value is clamped, because a delay comes out of a file: zero is legal in
 * a GIF and means "as fast as possible", and an hour is legal too.
 */
export function clipDelays(
  source: readonly number[] | null,
  start: number,
  count: number,
  fallbackMs = MOTION_FRAME_DELAY_MS,
): number[] {
  if (count < 1) return [];
  const fallback = clampDelay(fallbackMs);
  return Array.from({ length: count }, (_, i) => {
    const raw = source?.[start + i];
    return raw != null && Number.isFinite(raw) && raw > 0 ? clampDelay(raw) : fallback;
  });
}

function clampDelay(ms: number): number {
  return Math.round(Math.min(MOTION_MAX_DELAY_MS, Math.max(MOTION_MIN_DELAY_MS, ms)));
}

/**
 * How many frames are really in this WebP, counted from its bytes.
 *
 * A RIFF walk looking for ANMF chunks - the container's own record of an
 * animation frame. Deliberately not `sharp(...).metadata().pages`: the question
 * being answered is "does the artefact we are about to serve actually move", and
 * asking the same library that wrote it is asking it to confirm its own
 * intention rather than to inspect the result.
 */
export function countAnimatedWebpFrames(buf: Buffer): number {
  if (buf.length < 12) return 0;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return 0;
  let offset = 12;
  let frames = 0;
  while (offset + 8 <= buf.length) {
    const fourcc = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (fourcc === "ANMF") frames++;
    // Chunks are padded to an even length; ignoring that walks into the middle
    // of the next header and the count silently becomes nonsense.
    offset += 8 + size + (size % 2);
  }
  return frames;
}
