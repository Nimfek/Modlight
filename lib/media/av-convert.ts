/**
 * Building the ffmpeg command for one target, and running it.
 *
 * The argument LISTS are pure functions, exported and unit-tested, because an
 * argument list is exactly the kind of thing that looks obviously right and is
 * not: `-ss` after `-i` decodes the whole file instead of seeking to it, `-vf`
 * before `-i` is a fatal parse error, and a missing `-map` silently picks a
 * stream ffmpeg thought was best rather than the one we meant.
 *
 * Nothing here interpolates a caller's string into an argument. Numbers arrive
 * clamped from av-cost.ts, the container comes from the allowlist in
 * av-probe.ts, and paths come from a workspace the caller owns. There is no
 * shell anywhere on this path (lib/media/ffmpeg.ts spawns with `shell: false`),
 * so even a filename full of shell metacharacters is only ever a filename.
 */

import path from "node:path";
import {
  AV_ANIMATION_FPS,
  AV_STILL_FPS,
  animationWidth,
  avTimeoutFor,
} from "@/lib/media/av-cost";
import {
  audioCopyableTo,
  containerVerdict,
  isVideoContainer,
  isIsoBmff,
  needsWebRescue,
  AV_OUTPUT,
  CONTAINER_MUXER,
  WEB_MAX_EDGE,
  type AvOption,
  type AvSourceKind,
  type AvTarget,
  type VideoContainer,
} from "@/lib/media/av-targets";
import type { AvProbe } from "@/lib/media/av-probe";
import { inputArgs, runAvTool, threadArgs } from "@/lib/media/ffmpeg";
import type { AvWorkspace } from "@/lib/media/av-workspace";

export type { AvSourceKind } from "@/lib/media/av-targets";

export interface AvPlan {
  /** The full argument list, ready for spawn. */
  args: string[];
  /** File the job writes, inside the workspace. */
  outputPath: string;
  mime: string;
  ext: string;
  /** Wall clock this job gets, and the deadline its process group dies on. */
  timeoutMs: number;
  /**
   * Something true about the result the caller did not ask for and would
   * otherwise not discover - "the audio track was dropped", "this is 6 seconds
   * of a 4 minute video". Surfaced as a response header, never swallowed.
   */
  note?: string;
  /**
   * The picture was RE-ENCODED, so the source's dimensions no longer describe
   * the result and a caller storing them would be recording a lie.
   *
   * Only lib/media/convert-in-place.ts cares, and it matters there more than it
   * looks: that module copies `probe.video.width/height` onto the row for every
   * video output, which is exactly right for a container copy and exactly wrong
   * for this one. A row left claiming 5056x1924 for a 1920x730 file would keep
   * offering the rescue for ever, and would go on telling Discord the wrong
   * aspect ratio (lib/media/embed.ts).
   */
  remeasure?: boolean;
}

/**
 * The still picture that plays behind an audio track.
 *
 * A committed asset (scripts/make-audio-cover.ts renders it from app/icon.svg),
 * not something drawn per request: it is the same 1280x720 frame for every file
 * on the server, so building it on the request path would be work with no
 * variable in it, and rasterising SVG at request time would put librsvg on a
 * public endpoint for no gain.
 */
export function audioCoverPath(): string {
  return process.env.AUDIO_COVER_PATH || path.join(process.cwd(), "public", "brand", "audio-cover.png");
}

/**
 * Where in the file to start a clip.
 *
 * Clamped into the file rather than refused: `?t=` past the end is a request
 * that has an obviously right answer. Defaults to one second in, not zero - the
 * first frame of a video is very often black.
 */
export function frameOffset(requested: number | null, duration: number | null): number {
  const asked = requested != null && Number.isFinite(requested) && requested >= 0 ? requested : 1;
  if (duration == null || duration <= 0) return asked;
  return Math.min(asked, Math.max(0, duration - 0.05));
}

/**
 * Filters for an animation.
 *
 * `fps` is applied only for VIDEO sources. An animated image (the AVIF sequence
 * this feature was built for) already carries its own frame timing, and forcing
 * it to 12 fps resamples 43 frames of a 20 fps loop into something visibly
 * jerkier than the file the user uploaded.
 */
export function animationFilters(opts: {
  resampleFps: boolean;
  width: number;
  paletted: boolean;
}): string {
  const chain = [
    ...(opts.resampleFps ? [`fps=${AV_ANIMATION_FPS}`] : []),
    `scale=${opts.width}:-2:flags=lanczos`,
  ].join(",");

  // GIF holds 256 colours, so it needs a palette computed from the clip itself;
  // ffmpeg's default 8-bit palette turns anything with a gradient into mud.
  return opts.paletted
    ? `${chain},split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer`
    : chain;
}

/**
 * The one filter a web-playable copy needs.
 *
 * Written as a filter EXPRESSION rather than as two numbers computed here, and
 * that is not style. ffmpeg auto-rotates on the way in (a phone recording with a
 * 90-degree display matrix arrives at the filter graph already turned), so
 * literal output dimensions derived from ffprobe's CODED width and height would
 * squash exactly those files. `iw`/`ih` and a square bounding box are evaluated
 * after the rotation, so they cannot be wrong about it. The BRANCH is safe for
 * the same reason: the longest edge does not change when a picture is turned.
 *
 *  - `force_original_aspect_ratio=decrease` fits the picture inside a
 *    WEB_MAX_EDGE square, preserving the ratio and, because at least one edge
 *    already exceeds the box, never scaling anything up.
 *  - `force_divisible_by=2` rounds both edges down to an even number, which
 *    H.264 in 4:2:0 requires - an odd dimension is a hard encoder failure, and
 *    it is the same thing planAnimationVideo's `trunc(iw/2)*2` is for.
 *  - `lanczos` because the files this exists for are desktop captures full of
 *    text. Measured against the default bicubic on the reported file: 9.5 s
 *    against 9.4 s and 409 kB against 397 kB, for a visibly crisper result.
 *
 * The else branch is reachable when the row's dimensions and the bytes disagree
 * (a stale or hand-edited row). Re-encoding at native size is still a truthful
 * answer to what was asked for, and the even-edge fix still has to happen.
 */
export function webScaleFilter(width: number | null, height: number | null): string {
  return needsWebRescue({ width, height })
    ? `scale=w=${WEB_MAX_EDGE}:h=${WEB_MAX_EDGE}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`
    : "scale=trunc(iw/2)*2:trunc(ih/2)*2";
}

export interface PlanInput {
  option: AvOption;
  probe: AvProbe;
  sourceKind: AvSourceKind;
  workspace: AvWorkspace;
  /** From `avBudget` - already clamped. Null for targets that take no clip. */
  clipSeconds: number | null;
  /** `?t=` for a clip start, already a number or null. */
  offsetSeconds: number | null;
}

/**
 * Turn a target into a command.
 *
 * Returns a string instead of a plan when the file cannot do it after all -
 * the dynamic half of the split described in av-targets.ts. The caller turns
 * that into a 409 carrying the sentence, because "your .mkv holds VP9, which
 * cannot go into an MP4 without re-encoding" is something a person can act on
 * and a bare 415 is not.
 */
export function planAv(input: PlanInput): AvPlan | { refuse: RefuseReason } {
  const { option, probe, sourceKind, workspace, clipSeconds, offsetSeconds } = input;
  const out = AV_OUTPUT[option.to];
  const outputPath = workspace.output(`out.${out.ext}`);
  const common = { outputPath, mime: out.mime, ext: out.ext };
  // One deadline, decided once (lib/media/av-cost.ts): a stream copy gets the
  // short one, an ordinary encode the medium one, and the full picture
  // re-encode the long one. Every branch below shares this object, so a plan's
  // deadline and the limiter slot that holds it can never disagree.
  const timed = { ...common, timeoutMs: avTimeoutFor(option.to, option.cost) };

  // Before the container branch, because this target writes an .mp4 too and
  // `isVideoContainer` would otherwise never see it - it is not a container
  // choice at all, it is the only entry here that re-encodes a picture.
  if (option.to === "webmp4") return planWebVideo(probe, workspace, timed);

  if (isVideoContainer(option.to)) {
    // MP4 is reachable from three kinds of source and means something different
    // in each: move a video into another box, give an audio track a picture,
    // squeeze an animation into a real video. Dispatching on what the ROW says
    // the source is (never on the probe - see AvSourceKind) is what keeps those
    // three from being confused for one another.
    if (sourceKind === "audio") return planAudioVideo(probe, workspace, timed);
    if (sourceKind === "image-sequence") return planAnimationVideo(probe, workspace, timed);
    return planContainer(option.to, probe, workspace, timed);
  }

  switch (option.to) {
    case "mp3":
    case "ogg":
    case "wav":
      return planAudioEncode(option.to, probe, workspace, timed);
    case "gif":
    case "webp":
      return planAnimation(
        option.to,
        probe,
        sourceKind,
        workspace,
        clipSeconds,
        offsetSeconds,
        timed,
      );
  }
}

export type RefuseReason = "video-codec" | "audio-codec" | "no-video" | "no-audio";

type Common = { outputPath: string; mime: string; ext: string; timeoutMs: number };

/**
 * Move the streams into another container without touching a sample.
 *
 * The whole video half of the menu is this one function: MP4, MOV, MKV and WebM
 * differ only in the muxer name, which codecs they accept (av-targets.ts) and
 * whether they have an index worth moving to the front.
 */
function planContainer(
  to: VideoContainer,
  probe: AvProbe,
  ws: AvWorkspace,
  common: Common,
): AvPlan | { refuse: RefuseReason } {
  // The codec tables live in av-targets.ts, next to the menu that depends on them.
  const verdict = containerVerdict(to, probe);
  if (!verdict.ok) return { refuse: verdict.reason };

  const keepAudio = audioCopyableTo(to, probe.audio?.codec);

  return {
    ...common,
    args: [
      "-v",
      "error",
      ...inputArgs(ws.input, probe.container),
      "-map",
      "0:v:0",
      ...(keepAudio ? ["-map", "0:a:0"] : []),
      // Subtitles and data streams have no home in MP4 or MOV and abort the mux.
      "-dn",
      "-sn",
      "-c",
      "copy",
      // Container metadata can carry the recording device, the software, and on
      // phone footage sometimes a location. Nothing here needs it, and the same
      // privacy rule already governs the image path (sharp strips EXIF).
      // Rotation survives: it lives in the track matrix, which `-c copy` keeps.
      "-map_metadata",
      "-1",
      // Move the index to the front so the result can start playing before it
      // has finished downloading. Matroska interleaves its cues anyway and
      // rejects the flag, so it is only ever passed to the box formats.
      ...(isIsoBmff(to) ? ["-movflags", "+faststart"] : []),
      "-f",
      CONTAINER_MUXER[to],
      "-y",
      common.outputPath,
    ],
    note: probe.audio && !keepAudio ? "audio-dropped" : undefined,
  };
}

/**
 * Re-encode a recording into something a browser can actually play.
 *
 * The one entry in this menu that touches a video's picture, and it exists
 * because a file can be structurally perfect and still unwatchable. The
 * recording that prompted it is faststart, constant 30 fps, 33.3 ms between
 * every one of its 403 frames - and it stutters, for two reasons no viewer can
 * work around:
 *
 *  1. It is 5056 pixels wide. Hardware H.264 decoders stop at 4096, so the
 *     browser decodes it in software, which manages roughly 292 Mpx/s - and the
 *     file asks for 9.7 Mpx thirty times a second, which is 292 Mpx/s. There is
 *     no headroom at all, so anything else happening on the machine comes
 *     straight out of the frame rate.
 *  2. It carries 0.0044 bits per pixel. The same owner's healthy recordings
 *     measure 0.050 to 0.098, so this one's encoder could refresh only a sliver
 *     of the picture per frame - it looks frozen even where the timing is
 *     perfect.
 *
 * The second fault cannot be undone: information the source never recorded is
 * not recoverable, and this function does not pretend otherwise. What it fixes
 * is the first, which is the one that makes the file unplayable rather than
 * merely ugly - and once the picture is 1920 on its longest edge, the detail
 * that survived is all still there. See WEB_MAX_EDGE.
 *
 * WHY THESE SETTINGS, all measured on the production container (two cores,
 * 2 GiB, ffmpeg 5.1.9) against that file:
 *
 *  - CRF, NEVER A BITRATE. The input is starved; copying its 1296 kb/s would
 *    copy the fault. A quality target spends what the picture needs and no
 *    more - the result came out 409 kB from a 2.18 MB source, 244 kb/s, because
 *    there was very little left in there to encode. A rich 4K source through the
 *    same setting produced 43 MB from 72 MB. One knob, two honest answers.
 *  - CRF 21 rather than x264's default 23, because these are screen recordings
 *    with text and the second generation of a lossy encode is where text goes
 *    soft. The measured cost is 409 kB against 316 kB on the reported file.
 *  - PRESET veryfast. Not a guess either: `superfast` took the same 10 s and
 *    produced 1.49 MB, `faster` took 13 s and produced 496 kB, and `ultrafast`
 *    SILENTLY IGNORES `-profile:v high` - it turns off CABAC and 8x8 transforms,
 *    so the output came back Constrained Baseline at 3.03 MB. That is the very
 *    profile this function exists to get away from, arrived at by asking for
 *    speed.
 *  - PROFILE high, confirmed rather than assumed: the output really does report
 *    `High` and level 4.0, where the source is Constrained Baseline at level
 *    6.0 - a level no current hardware decoder accepts.
 *  - NO EXPLICIT `-g`. A two second keyframe interval was tried and costs 2.2x
 *    the file (894 kB against 409 kB) on a starved source, where a keyframe is
 *    enormous relative to everything around it. x264's own keyint plus its scene
 *    cut detection is the better default, and smooth playback - the thing being
 *    bought here - does not depend on it.
 *  - `+faststart`, verified in the bytes: moov at offset 36, mdat at 5671.
 *
 * The sound rides along untouched wherever MP4 accepts it, which is the usual
 * case (AAC), and is re-encoded otherwise with a note saying so.
 */
function planWebVideo(
  probe: AvProbe,
  ws: AvWorkspace,
  common: Common,
): AvPlan | { refuse: RefuseReason } {
  if (!probe.video) return { refuse: "no-video" };

  const audio = probe.audio;
  const copyAudio = !!audio && audioCopyableTo("mp4", audio.codec);

  return {
    ...common,
    args: [
      "-v",
      "error",
      ...inputArgs(ws.input, probe.container),
      ...threadArgs(),
      "-map",
      "0:v:0",
      ...(audio ? ["-map", "0:a:0"] : []),
      // Subtitles and data streams have no home in MP4 and abort the mux; the
      // production .mov that exercised this carries two of the latter.
      "-dn",
      "-sn",
      "-vf",
      webScaleFilter(probe.video.width, probe.video.height),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "21",
      "-profile:v",
      "high",
      // Every browser decodes 4:2:0 planar YUV; Safari refuses 4:4:4 outright,
      // and a screen recorder is exactly the kind of source that emits it.
      "-pix_fmt",
      "yuv420p",
      ...(audio ? (copyAudio ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k"]) : []),
      // Same privacy rule as every other plan here: container metadata can carry
      // the recording device and the software, and nothing downstream wants it.
      "-map_metadata",
      "-1",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      "-y",
      common.outputPath,
    ],
    remeasure: true,
    note: audio && !copyAudio ? "audio-reencoded" : undefined,
  };
}

/**
 * Wrap an audio track in a video, on one unchanging frame.
 *
 * The thing this exists for: places that accept a video and refuse an audio file
 * (most social timelines, several chat clients). The picture is the Modlight
 * mark on black - not a waveform, not a spectrum, because those would mean
 * decoding and rendering the whole track, and the point is a file that costs
 * almost nothing to produce.
 *
 * Two decisions carry the cost, both measured on a 209 s production MP3:
 *
 *  - ONE FRAME PER SECOND. Every frame is identical, so the frame rate buys
 *    nothing; 1 fps costs 2196 ms and 86 kB of video, 2 fps costs 4210 ms and
 *    125 kB.
 *  - COPY THE SOUND WHEN MP4 WILL TAKE IT. AAC, MP3 and ALAC go in untouched,
 *    which is both faster (2196 ms against 10920 ms for an AAC re-encode) and
 *    lossless. Anything else - WAV, FLAC, Vorbis, Opus - is re-encoded, and
 *    av-cost.ts gives that case a much shorter length ceiling for the same
 *    reason.
 *
 * `-shortest` alone stops the muxer but leaves the looping image running past
 * the audio by up to ten seconds; `-fflags +shortest` is what makes the video
 * stream actually end with it (measured: 218.5 s of video over 208.7 s of audio
 * without it, 210 s with).
 */
function planAudioVideo(
  probe: AvProbe,
  ws: AvWorkspace,
  common: Common,
): AvPlan | { refuse: RefuseReason } {
  if (!probe.audio) return { refuse: "no-audio" };
  const copyAudio = audioCopyableTo("mp4", probe.audio.codec);

  return {
    ...common,
    args: [
      "-v",
      "error",
      // The cover is our own file, so forcing `image2` here is not the security
      // measure it is for the upload - it is simply the demuxer that knows how
      // to hold one picture on screen for the length of another stream.
      ...inputArgs(audioCoverPath(), "image2", [
        "-loop",
        "1",
        "-framerate",
        String(AV_STILL_FPS),
      ]),
      ...inputArgs(ws.input, probe.container),
      ...threadArgs(),
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      // Tells x264 the picture does not move, which is exactly true here.
      "-tune",
      "stillimage",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(AV_STILL_FPS),
      // A keyframe a minute. Seeking in a static picture is free either way, and
      // fewer keyframes is a smaller file.
      "-g",
      String(AV_STILL_FPS * 60),
      ...(copyAudio ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k"]),
      // Length pinned to the audio, not left to `-shortest` alone.
      //
      // The still runs at one frame per second, so a frame lasts a whole second
      // and `-shortest` can only stop on a frame boundary - it overshoots by up
      // to a second, and with the large interleave delta below it overshot far
      // more than that: a 1.9 s track came out a 5.0 s video, so 62 percent of
      // the file was black silence. `-t` cuts on the sample, whatever the frame
      // grid is doing. Kept alongside `-shortest`, which still covers the case
      // of a file whose header lies about its duration.
      ...(probe.duration && probe.duration > 0 ? ["-t", probe.duration.toFixed(3)] : []),
      "-shortest",
      "-fflags",
      "+shortest",
      // Without this the muxer can stall waiting to interleave a stream that
      // produces one packet a second against one producing forty.
      "-max_interleave_delta",
      "100M",
      "-map_metadata",
      "-1",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      "-y",
      common.outputPath,
    ],
    note: copyAudio ? undefined : "audio-reencoded",
  };
}

/**
 * Re-encode a whole animation as an MP4.
 *
 * The single most valuable conversion in the menu by size: measured on a
 * production 2.39 MB GIF (211x211, 128 frames, 5.1 s), the MP4 is 32 kB and took
 * 231 ms. Seventy-four times smaller, with every frame intact.
 *
 * Unlike the clip targets nothing is trimmed or resampled - an animation is
 * short by construction, and taking the first six seconds of a loop would be
 * vandalism. The only filter is the even-dimension fix h264 requires; a 211x211
 * GIF cannot be encoded as-is.
 */
function planAnimationVideo(
  probe: AvProbe,
  ws: AvWorkspace,
  common: Common,
): AvPlan | { refuse: RefuseReason } {
  if (!probe.video) return { refuse: "no-video" };

  return {
    ...common,
    args: [
      "-v",
      "error",
      ...inputArgs(ws.input, probe.container),
      ...threadArgs(),
      "-map",
      "0:v:0",
      "-an",
      "-dn",
      "-sn",
      "-vf",
      "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      // GIF is palettised RGB; every player expects 4:2:0 planar YUV.
      "-pix_fmt",
      "yuv420p",
      "-map_metadata",
      "-1",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      "-y",
      common.outputPath,
    ],
  };
}

function planAudioEncode(
  to: "mp3" | "ogg" | "wav",
  probe: AvProbe,
  ws: AvWorkspace,
  common: Common,
): AvPlan | { refuse: RefuseReason } {
  if (!probe.audio) return { refuse: "no-audio" };

  const codec =
    to === "mp3"
      ? ["-c:a", "libmp3lame", "-q:a", "4"]
      : to === "ogg"
        ? ["-c:a", "libvorbis", "-q:a", "4"]
        : // 16-bit PCM at the source rate. WAV carries no compression, which is
          // why av-cost gives it a much shorter ceiling than the other two.
          ["-c:a", "pcm_s16le"];

  return {
    ...common,
    args: [
      "-v",
      "error",
      ...inputArgs(ws.input, probe.container),
      ...threadArgs(),
      "-map",
      "0:a:0",
      "-vn",
      "-dn",
      "-sn",
      ...codec,
      "-map_metadata",
      "-1",
      "-f",
      to === "ogg" ? "ogg" : to,
      "-y",
      common.outputPath,
    ],
  };
}

function planAnimation(
  to: "gif" | "webp",
  probe: AvProbe,
  sourceKind: AvSourceKind,
  ws: AvWorkspace,
  clipSeconds: number | null,
  offset: number | null,
  common: Common,
): AvPlan | { refuse: RefuseReason } {
  if (!probe.video) return { refuse: "no-video" };

  // See AvSourceKind: only a real video is clipped and resampled.
  const resample = sourceKind !== "image-sequence";
  const width = animationWidth(probe.video.width);
  const at = offset != null ? frameOffset(offset, probe.duration) : 0;
  const clipped = resample && clipSeconds != null;

  return {
    ...common,
    args: [
      "-v",
      "error",
      ...inputArgs(ws.input, probe.container, [
        ...(at > 0 && resample ? ["-ss", at.toFixed(3)] : []),
        // -t BEFORE -i, so the DEMUXER stops after the clip. As an output
        // option it bounds what is written, but `palettegen` cannot emit a
        // palette until its input ends, so the filter graph pulls the whole
        // remaining stream anyway. Measured on the 32 s test file: a 6 s GIF
        // cost 3917 ms with -t after -i and 995 ms with it before.
        ...(clipped ? ["-t", String(clipSeconds)] : []),
      ]),
      ...threadArgs(),
      "-map",
      "0:v:0",
      "-an",
      "-dn",
      "-sn",
      "-vf",
      animationFilters({ resampleFps: resample, width, paletted: to === "gif" }),
      ...(to === "webp" ? ["-c:v", "libwebp", "-lossless", "0", "-q:v", "75"] : []),
      // Loop forever. GIF defaults to this; libwebp defaults to playing once,
      // which makes a "converted to animated WebP" file look like a still.
      "-loop",
      "0",
      "-f",
      to,
      "-y",
      common.outputPath,
    ],
    note: clipped && probe.duration && probe.duration > (clipSeconds ?? 0) ? "clipped" : undefined,
  };
}

/** Run a plan. Resolves when the output file is complete on disk. */
export async function runAvPlan(plan: AvPlan, signal?: AbortSignal): Promise<void> {
  await runAvTool("ffmpeg", plan.args, { timeoutMs: plan.timeoutMs, signal });
}

/**
 * The variant tag a result caches under.
 *
 * Only the things the CALLER chose, because this has to be computable before the
 * conversion runs - a lookup that needs the answer to find the answer is not a
 * cache. Everything else that shapes the output (the source codecs, whether the
 * audio track survived) is a function of the source bytes, which the other half
 * of the key already identifies, so the same key can only ever mean the same
 * bytes.
 */
export function avVariant(
  to: AvTarget,
  clip: number | null,
  offset: number | null,
  sourceKind: AvSourceKind = "video",
): string {
  const parts: string[] = [to];
  // Only where the PLAN actually reads them. A container copy moves the whole
  // file, an audio encode takes the whole track, and an animation is converted
  // whole - so `?t=` and `?d=` change nothing about any of those outputs, and
  // folding them into the key anyway turned one cacheable result into an
  // unbounded family of identical ones. The container targets are reachable
  // without logging in, so `?t=1`, `?t=2`, `?t=3` was a way for anybody to fill
  // the disk with byte-identical copies.
  const clips = (to === "gif" || to === "webp") && sourceKind === "video";
  if (clips) {
    // Rounded, exactly like the offset below. `?d=6.1` and `?d=6.1001119` cut
    // the same frames, so leaving the raw number in the key minted a fresh
    // cache entry per keystroke - the same unbounded-disk vector already closed
    // for the timing parameters, arriving through the one that was left raw.
    if (clip != null) parts.push(`c${clip.toFixed(2)}`);
    if (offset != null && offset > 0) parts.push(`t${offset.toFixed(2)}`);
  }
  return parts.join("-");
}
