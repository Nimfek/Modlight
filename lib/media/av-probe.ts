/**
 * What ffprobe says a file is, and whether we believe it.
 *
 * This runs BEFORE any encoder, and that ordering is the point: a duration and a
 * codec cost one cheap process (measured: 50-100 ms), and knowing them is what
 * lets an over-long or unsupported input be refused for free instead of being
 * discovered halfway through a job that has already taken a slot.
 *
 * The parsing is separated from the spawning so every interesting shape - a
 * stream with no duration, a container claiming to be six formats at once, an
 * audio-only file with a cover-art "video" stream - is a unit test.
 */

import { AvAbortedError, AvTimeoutError, probeInputArgs, runAvTool } from "@/lib/media/ffmpeg";

/**
 * Demuxers we are willing to force with `-f`.
 *
 * An allowlist, and a short one. Everything ffmpeg can read that is NOT here
 * (concat, hls, dash, lavfi, image2 with a glob pattern…) is a way to make one
 * "file" mean many files, which is the shape of every local-file-disclosure bug
 * in this area. The key is the family ffprobe reports, the value is the single
 * demuxer name we hand back to ffmpeg.
 *
 * `mov,mp4,m4a,3gp,3g2,mj2` covers more than its name suggests: it is also how
 * ffmpeg 5.1 reads an ANIMATED AVIF, which is the format that started this work
 * (measured on the production file: 43 frames of AV1, 274x498, 2.15 s - where
 * libvips hands back only the cover frame).
 */
const CONTAINER_ALLOWLIST: Record<string, string> = {
  "mov,mp4,m4a,3gp,3g2,mj2": "mov",
  matroska: "matroska",
  "matroska,webm": "matroska",
  webm: "matroska",
  avi: "avi",
  asf: "asf",
  flv: "flv",
  mpegts: "mpegts",
  mpeg: "mpeg",
  ogg: "ogg",
  gif: "gif",
  mp3: "mp3",
  "mp3,mp2,mp1": "mp3",
  wav: "wav",
  flac: "flac",
  aac: "aac",
  "aac,adts": "aac",
  ape: "ape",
  "wv,wvpack": "wv",
  opus: "ogg",
  m4v: "m4v",
};

export interface AvStream {
  kind: "video" | "audio" | "other";
  codec: string;
  width: number | null;
  height: number | null;
  frames: number | null;
  /**
   * Frames per second, from ffprobe's `avg_frame_rate`.
   *
   * It sits next to `frames` because the two are not equally available, which
   * is a measurement rather than a guess: over 59 production videos probed in
   * the runtime image, `nb_frames` was missing on 3 of them (an MPEG-TS stream
   * wearing an .mp4 name, a WebM, and one damaged MP4) while `avg_frame_rate`
   * was present on all 59. So this is the field that still answers when the
   * counted one does not, and "how many pixels does this file contain" - the
   * question behind a stuttering recording - stays answerable either way.
   *
   * Null when ffprobe writes `0/0`, which is its word for "no idea".
   */
  fps: number | null;
  /**
   * True for a still picture carried in an audio file (album art). ffprobe
   * reports it as a video stream, and treating it as one turns "extract the
   * audio from this MP3" into "this file already has video".
   */
  attachedPicture: boolean;
}

export interface AvProbe {
  /** The demuxer to FORCE on every later invocation. Never inferred again. */
  container: string;
  /** Raw `format_name`, kept for diagnostics and error messages. */
  formatName: string;
  /** Seconds, or null when the container does not say (some streamed files). */
  duration: number | null;
  video: AvStream | null;
  audio: AvStream | null;
  /** Every stream, so callers can tell "two audio tracks" from "one". */
  streams: AvStream[];
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function positive(v: unknown): number | null {
  const n = num(v);
  return n != null && n > 0 ? n : null;
}

/**
 * ffprobe writes a frame rate as a rational STRING, not a number: "30/1" for a
 * fixed-rate recording, "122972160/4355237" for a variable one (a real
 * production file), and "0/0" when it does not know. Reading it with `Number()`
 * yields NaN for every one of those, so it needs its own parser.
 *
 * A bare number is accepted too, since some builds emit one, and anything that
 * is not a positive finite rate comes back null rather than 0 - zero would pass
 * every "is this fast enough" test ever written.
 */
export function parseRational(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== "string") return null;
  const slash = v.indexOf("/");
  const numerator = Number(slash === -1 ? v : v.slice(0, slash));
  const denominator = slash === -1 ? 1 : Number(v.slice(slash + 1));
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (numerator <= 0 || denominator <= 0) return null;
  return numerator / denominator;
}

/**
 * Turn ffprobe's JSON into something with a type, or null when the file is not
 * one we are prepared to touch.
 *
 * Null has one meaning here and it is deliberate: "no supported media in a
 * container we allow". The caller answers 415 with that, which is a fact the
 * person can act on, unlike the 500 a thrown encoder produces.
 */
export function parseAvProbe(raw: unknown): AvProbe | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as { format?: unknown; streams?: unknown };

  const format = (root.format ?? {}) as Record<string, unknown>;
  const formatName = typeof format.format_name === "string" ? format.format_name : "";
  const container = CONTAINER_ALLOWLIST[formatName];
  if (!container) return null;

  const rawStreams = Array.isArray(root.streams) ? root.streams : [];
  const streams: AvStream[] = rawStreams.map((s) => {
    const entry = (s ?? {}) as Record<string, unknown>;
    const type = entry.codec_type;
    const disposition = (entry.disposition ?? {}) as Record<string, unknown>;
    return {
      kind: type === "video" ? "video" : type === "audio" ? "audio" : "other",
      codec: typeof entry.codec_name === "string" ? entry.codec_name : "",
      width: positive(entry.width),
      height: positive(entry.height),
      frames: positive(entry.nb_frames),
      fps: parseRational(entry.avg_frame_rate),
      attachedPicture: disposition.attached_pic === 1,
    };
  });

  // Cover art is not video. An MP3 with an embedded JPEG reports a `video`
  // stream of one frame, and picking it as THE video stream would offer "extract
  // a frame at 00:30" for a file that is thirty minutes of audio.
  const video = streams.find((s) => s.kind === "video" && !s.attachedPicture) ?? null;
  const audio = streams.find((s) => s.kind === "audio") ?? null;
  if (!video && !audio) return null;

  // Format duration first: a stream may omit it, and for a remux the container's
  // answer is the one that matters. Falling back to the stream keeps files whose
  // header is thin (some Matroska writers) from reading as "unknown length" and
  // being refused by the duration ceiling.
  const duration =
    positive(format.duration) ??
    positive((rawStreams[0] as Record<string, unknown> | undefined)?.duration) ??
    null;

  return { container, formatName, duration, video, audio, streams };
}

/**
 * Ask ffprobe about a file on disk.
 *
 * The one invocation allowed to let ffmpeg guess the container, because
 * discovering it is the entire job - and it is safe here precisely because
 * ffprobe only ever reports. Nothing is demuxed into an output, and the result
 * is checked against the allowlist before any second process exists.
 */
export async function probeAv(
  path: string,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<AvProbe | null> {
  let out: string;
  try {
    const res = await runAvTool(
      "ffprobe",
      [
        "-v",
        "error",
        ...probeInputArgs(path),
        // `disposition` is a nested object, so it needs its own `stream_disposition`
        // selector - asking for it inside `stream=` silently returns nothing, and
        // then every MP3 with cover art looks like a file that has video in it.
        "-show_entries",
        // `avg_frame_rate` rides along for free: it is one more field in a
        // request that is already being made, and it is the only frame-rate
        // answer some containers give (see AvStream.fps).
        "format=format_name,duration:stream=codec_type,codec_name,width,height,nb_frames,avg_frame_rate,duration:stream_disposition=attached_pic",
        "-of",
        "json",
      ],
      { ...opts, captureStdout: true },
    );
    out = res.stdout;
  } catch (err) {
    // A KILLED probe is not an answer about the file.
    //
    // `null` from here means one thing only: ffprobe looked and this is not
    // media we accept. It used to also mean "the caller hung up" and "we ran out
    // of time", because a bare catch cannot tell them apart - and the conversion
    // path turns `null` into a REMEMBERED "unreadable" verdict that is then
    // served, for ten minutes, to every later request for that file, including
    // real downloads. One reload at the wrong moment, or one busy minute on the
    // server, and a perfectly good video starts reporting that it cannot be
    // opened. Both of those are facts about the server or the socket, never
    // about the bytes, so they propagate and let the caller decide.
    if (err instanceof AvTimeoutError || err instanceof AvAbortedError) throw err;
    return null;
  }

  try {
    return parseAvProbe(JSON.parse(out));
  } catch {
    return null;
  }
}
