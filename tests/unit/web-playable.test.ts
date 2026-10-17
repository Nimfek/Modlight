import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  avOptionFor,
  avTargetsFor,
  needsWebRescue,
  AV_OUTPUT,
  WEB_MAX_EDGE,
} from "@/lib/media/av-targets";
import { AV_MAX_WEB_PIXELS, AV_WEB_TIMEOUT_MS, avBudget, avTimeoutFor } from "@/lib/media/av-cost";
import { planAv, webScaleFilter } from "@/lib/media/av-convert";
import { parseAvProbe } from "@/lib/media/av-probe";
import { totalSourcePixels } from "@/lib/media/av-meta";
import {
  downloadHintKey,
  downloadLabelKey,
  downloadOptionsFor,
} from "@/lib/media/download-menu";
import { conversionEngineFor, planConversion } from "@/lib/media/convert-plan";
import type { AvProbe, AvStream } from "@/lib/media/av-probe";
import type { AvOption } from "@/lib/media/av-targets";
import type { AvWorkspace } from "@/lib/media/av-workspace";

/**
 * The file the whole feature was built from, as ffprobe 5.1.9 really described
 * it on production. Structurally perfect - faststart, constant 30 fps, 33.3 ms
 * between every frame - and unwatchable anyway: 5056 pixels wide, which is past
 * every hardware decoder, and 0.0044 bits per pixel, which is a tenth of what
 * the same owner's healthy recordings carry.
 */
const CAPTURE_PROBE = {
  programs: [],
  streams: [
    {
      codec_name: "h264",
      profile: "Constrained Baseline",
      codec_type: "video",
      width: 5056,
      height: 1924,
      pix_fmt: "yuv420p",
      level: 60,
      avg_frame_rate: "30/1",
      nb_frames: "403",
      disposition: { attached_pic: 0 },
    },
  ],
  format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "13.434000" },
};

/** The row that file produces once lib/media/av-meta.ts has measured it. */
const CAPTURE_ROW = {
  mimeType: "video/mp4",
  ext: "mp4",
  frames: 403,
  width: 5056,
  height: 1924,
};

const ws: AvWorkspace = {
  input: "/data/storage/alicja/kOREMAfi42.mp4",
  output: (name) => `/tmp/av-1/${name}`,
  dispose: async () => {},
};

const stream = (over: Partial<AvStream> & { codec: string }): AvStream => ({
  kind: "audio",
  width: null,
  height: null,
  frames: null,
  fps: null,
  attachedPicture: false,
  ...over,
});

function probe(over: Partial<AvProbe> = {}): AvProbe {
  return {
    container: "mov",
    formatName: "mov,mp4,m4a,3gp,3g2,mj2",
    duration: 13.434,
    video: stream({ kind: "video", codec: "h264", width: 5056, height: 1924, frames: 403, fps: 30 }),
    audio: null,
    streams: [],
    ...over,
  };
}

const WEB: AvOption = { to: "webmp4", cost: "encode", yields: "webVideo" };

function webPlan(over: Partial<AvProbe> = {}) {
  const result = planAv({
    option: WEB,
    probe: probe(over),
    sourceKind: "video",
    workspace: ws,
    clipSeconds: null,
    offsetSeconds: null,
  });
  if ("refuse" in result) throw new Error(`unexpected refusal: ${result.refuse}`);
  return result;
}

/** Value that follows a flag, which is the only thing ffmpeg reads it as. */
const after = (args: string[], flag: string): string | undefined =>
  args[args.indexOf(flag) + 1];

const names = (options: { to: string }[]) => options.map((o) => o.to);

// ---------------------------------------------------------------------------
// When the entry exists at all
// ---------------------------------------------------------------------------

describe("who is offered a web-playable copy", () => {
  it("offers it to the recording that started this, first in the menu", () => {
    const options = avTargetsFor("video/mp4", "mp4", 403, CAPTURE_ROW);
    expect(names(options)[0]).toBe("webmp4");
    expect(options[0]).toEqual({ to: "webmp4", cost: "encode", yields: "webVideo" });
  });

  it("leaves an ordinary recording alone", () => {
    // The whole point of the gate. A 1280x720 clip plays everywhere, and an
    // entry that re-encodes it would cost seconds of CPU to hand back a file
    // that is no better.
    expect(names(avTargetsFor("video/mp4", "mp4", 300, { width: 1280, height: 720 }))).not.toContain(
      "webmp4",
    );
    expect(
      names(avTargetsFor("video/mp4", "mp4", 300, { width: 1920, height: 1080 })),
    ).not.toContain("webmp4");
  });

  it("is absent, not disabled, when nobody has measured the file", () => {
    // Every row uploaded before the dimension columns existed reads like this,
    // and null means "unmeasured", never "small". Fail closed: an entry that
    // might do nothing is worse than an entry that is not there.
    expect(names(avTargetsFor("video/mp4", "mp4", 403))).not.toContain("webmp4");
    expect(names(avTargetsFor("video/mp4", "mp4", 403, { width: null, height: null }))).not.toContain(
      "webmp4",
    );
  });

  it("judges by the longest edge, so a portrait recording counts too", () => {
    expect(needsWebRescue({ width: 1080, height: 2400 })).toBe(true);
    expect(needsWebRescue({ width: 2400, height: 1080 })).toBe(true);
    expect(needsWebRescue({ width: WEB_MAX_EDGE, height: WEB_MAX_EDGE })).toBe(false);
    expect(needsWebRescue({ width: WEB_MAX_EDGE + 1, height: 100 })).toBe(true);
    expect(needsWebRescue(null)).toBe(false);
    expect(needsWebRescue(undefined)).toBe(false);
    expect(needsWebRescue({})).toBe(false);
  });

  it("never offers it for sound or for a picture, however large they are", () => {
    const big = { width: 8000, height: 8000 };
    expect(names(avTargetsFor("audio/mpeg", "mp3", null, big))).not.toContain("webmp4");
    expect(names(avTargetsFor("image/gif", "gif", 128, big))).not.toContain("webmp4");
    expect(names(avTargetsFor("image/avif", "avif", null, big))).not.toContain("webmp4");
    expect(names(avTargetsFor("image/png", "png", 1, big))).not.toContain("webmp4");
  });

  it("writes an ordinary .mp4, whatever the target is called", () => {
    expect(AV_OUTPUT.webmp4).toEqual({ mime: "video/mp4", ext: "mp4" });
  });
});

describe("the menu and the route cannot come apart", () => {
  it("accepts the target for exactly the rows that are shown it", () => {
    // The admission test in the route (lib/media/av-action.ts) is this very
    // function with the row passed through. If the size stopped travelling, the
    // menu would draw an entry the server answers 415 to.
    expect(avOptionFor("video/mp4", "mp4", 403, "webmp4", CAPTURE_ROW)).not.toBeNull();
    expect(avOptionFor("video/mp4", "mp4", 403, "webmp4", { width: 1920, height: 1080 })).toBeNull();
  });

  it("refuses the target when the size never arrives", () => {
    // Fail closed, and stated as a test rather than left to chance: a future
    // call site that forgets to pass the row loses the entry, it does not gain
    // an unbounded transcode on a public endpoint.
    expect(avOptionFor("video/mp4", "mp4", 403, "webmp4")).toBeNull();
  });

  it("shows it to the owner and hides it from a visitor", () => {
    const owner = downloadOptionsFor("video/mp4", "mp4", 403, { canEncode: true, ...CAPTURE_ROW });
    const visitor = downloadOptionsFor("video/mp4", "mp4", 403, {
      canEncode: false,
      ...CAPTURE_ROW,
    });
    expect(names(owner)).toContain("webmp4");
    // Re-encoding is owner-only for the reason in av-targets.ts: the caller
    // chooses the workload, so it must be attributable to an account.
    expect(names(visitor)).not.toContain("webmp4");
  });

  it("labels and describes the entry in words, not as WEBMP4", () => {
    expect(downloadLabelKey("webmp4")).toBe("convert.webPlayableLabel");
    expect(downloadLabelKey("mp4")).toBeNull();
    const option = downloadOptionsFor("video/mp4", "mp4", 403, {
      canEncode: true,
      ...CAPTURE_ROW,
    }).find((o) => o.to === "webmp4")!;
    expect(option.section).toBe("main");
    expect(downloadHintKey(option)).toBe("convert.webPlayable");
  });

  it("reaches the in-place converter through the same row", () => {
    expect(conversionEngineFor("video/mp4", "mp4", 403, "webmp4", CAPTURE_ROW)).toBe("av");
    expect(conversionEngineFor("video/mp4", "mp4", 403, "webmp4")).toBeNull();

    // An .mp4 asked for a web-playable copy is NOT "already in that format":
    // the extension is the same and the encoding is the entire point.
    const row = {
      id: "u1",
      ext: "mp4",
      mimeType: "video/mp4",
      frames: 403,
      width: 5056,
      height: 1924,
      size: 2_179_538,
      kind: "file",
      deletedAt: null,
      expiresAt: null,
    };
    expect(planConversion(row, "webmp4", "replace")).toEqual({
      ok: true,
      engine: "av",
      ext: "mp4",
      mime: "video/mp4",
    });
  });
});

// ---------------------------------------------------------------------------
// What the encoder is told
// ---------------------------------------------------------------------------

describe("the scale filter", () => {
  it("fits the picture inside a square box, which is rotation-proof", () => {
    // Written as an expression rather than as two numbers because ffmpeg
    // auto-rotates on the way in: a phone recording reaches the filter graph
    // already turned, and literal dimensions taken from the coded ones would
    // squash it.
    const filter = webScaleFilter(5056, 1924);
    expect(filter).toContain(`w=${WEB_MAX_EDGE}:h=${WEB_MAX_EDGE}`);
    expect(filter).toContain("force_original_aspect_ratio=decrease");
    // H.264 in 4:2:0 cannot encode an odd dimension at all.
    expect(filter).toContain("force_divisible_by=2");
    expect(filter).toContain("flags=lanczos");
  });

  it("uses the same box whichever way up the picture is", () => {
    expect(webScaleFilter(1080, 2400)).toBe(webScaleFilter(2400, 1080));
  });

  it("never upscales a picture that is already small enough", () => {
    // The else branch is reachable when the row and the bytes disagree. It
    // still has to make both edges even - the same job planAnimationVideo's
    // trunc(iw/2)*2 does.
    const filter = webScaleFilter(1280, 720);
    expect(filter).toBe("scale=trunc(iw/2)*2:trunc(ih/2)*2");
    expect(webScaleFilter(null, null)).toBe("scale=trunc(iw/2)*2:trunc(ih/2)*2");
  });
});

describe("the ffmpeg command", () => {
  it("re-encodes at a quality target, never at the source's bitrate", () => {
    // Copying 1296 kb/s would copy the fault. A CRF encode spends what the
    // picture needs: measured, this file came out 409 kB at 244 kb/s, and a
    // rich 4K source through the same setting came out 43 MB.
    const args = webPlan().args;
    expect(after(args, "-c:v")).toBe("libx264");
    expect(after(args, "-crf")).toBe("21");
    expect(args).not.toContain("-b:v");
    expect(args).not.toContain("-maxrate");
  });

  it("asks for High profile and a preset that will honour it", () => {
    // `ultrafast` silently ignores -profile:v high - it turns off CABAC and the
    // 8x8 transform - and hands back Constrained Baseline, which is the very
    // profile this target exists to get away from. Measured: 3.03 MB against
    // 409 kB, for the same 10 s.
    const args = webPlan().args;
    expect(after(args, "-profile:v")).toBe("high");
    expect(after(args, "-preset")).toBe("veryfast");
    expect(after(args, "-pix_fmt")).toBe("yuv420p");
  });

  it("moves the index to the front so it can start playing while it downloads", () => {
    expect(after(webPlan().args, "-movflags")).toBe("+faststart");
    expect(after(webPlan().args, "-f")).toBe("mov"); // the forced INPUT demuxer
    expect(webPlan().args.slice(-3, -2)[0]).toBe("mp4"); // ...and the output muxer
  });

  it("strips container metadata, subtitles and data streams", () => {
    const args = webPlan().args;
    expect(after(args, "-map_metadata")).toBe("-1");
    expect(args).toContain("-dn");
    expect(args).toContain("-sn");
  });

  it("says the result must be measured again", () => {
    // The row would otherwise go on claiming 5056x1924 for a 1920x730 file:
    // the entry would keep being offered, and the embed would keep telling
    // Discord the wrong shape.
    expect(webPlan().remeasure).toBe(true);
  });

  it("gives the job the long deadline, and says so in one place", () => {
    expect(webPlan().timeoutMs).toBe(AV_WEB_TIMEOUT_MS);
    expect(avTimeoutFor("webmp4", "encode")).toBe(AV_WEB_TIMEOUT_MS);
    expect(avTimeoutFor("mp3", "encode")).toBeLessThan(AV_WEB_TIMEOUT_MS);
    expect(avTimeoutFor("mkv", "copy")).toBeLessThan(AV_WEB_TIMEOUT_MS);
  });

  it("maps no audio when the file has none", () => {
    // The reported recording has no audio stream at all, and mapping one that
    // does not exist is a fatal ffmpeg error rather than an empty track.
    const args = webPlan().args;
    expect(args.filter((a) => a === "-map")).toHaveLength(1);
    expect(args).not.toContain("-c:a");
    expect(webPlan().note).toBeUndefined();
  });

  it("carries AAC across untouched and re-encodes anything MP4 will not take", () => {
    const aac = webPlan({ audio: stream({ codec: "aac" }) });
    expect(after(aac.args, "-c:a")).toBe("copy");
    expect(aac.note).toBeUndefined();

    const opus = webPlan({ audio: stream({ codec: "opus" }) });
    expect(after(opus.args, "-c:a")).toBe("aac");
    // Told, rather than silently different from what was asked for.
    expect(opus.note).toBe("audio-reencoded");
  });

  it("refuses a file with no picture instead of producing an empty video", () => {
    const result = planAv({
      option: WEB,
      probe: probe({ video: null, audio: stream({ codec: "aac" }) }),
      sourceKind: "video",
      workspace: ws,
      clipSeconds: null,
      offsetSeconds: null,
    });
    expect(result).toEqual({ refuse: "no-video" });
  });
});

// ---------------------------------------------------------------------------
// What it is allowed to cost
// ---------------------------------------------------------------------------

describe("the pixel budget", () => {
  const budget = (pixels: number | null) =>
    avBudget("webmp4", "encode", { bytes: 2_179_538, duration: 13.434, pixels });

  it("admits the recording it was built for", () => {
    // 5056 x 1924 x 403 = 3.92 Gpx, measured at 9.5 s on the production
    // container.
    expect(totalSourcePixels(parseAvProbe(CAPTURE_PROBE)!)).toBe(5056 * 1924 * 403);
    expect(budget(5056 * 1924 * 403)).toEqual({ ok: true, clipSeconds: null });
  });

  it("counts frames, not seconds", () => {
    // A minute of 4K at 60 fps is four times the work of a minute of 1440p at
    // 30, and this target is only ever offered to the files where that gap is
    // widest. Same duration, opposite verdicts.
    expect(avBudget("webmp4", "encode", { bytes: 1, duration: 60, pixels: 2_000_000_000 }).ok).toBe(
      true,
    );
    expect(
      avBudget("webmp4", "encode", { bytes: 1, duration: 60, pixels: 20_000_000_000 }).ok,
    ).toBe(false);
  });

  it("refuses over the ceiling with the reason and the limit", () => {
    expect(budget(AV_MAX_WEB_PIXELS + 1)).toEqual({
      ok: false,
      reason: "too-many-pixels",
      limit: AV_MAX_WEB_PIXELS,
    });
  });

  it("treats an unmeasurable file as too long rather than as small", () => {
    // No counted frames, no duration and no frame rate. "We cannot tell how
    // much of this there is" is not "there is not much of it".
    expect(budget(null).ok).toBe(false);
    expect(budget(0).ok).toBe(false);
  });

  it("still refuses a file past the byte ceiling before it looks at pixels", () => {
    const verdict = avBudget("webmp4", "encode", {
      bytes: 600 * 1024 * 1024,
      duration: 10,
      pixels: 1,
    });
    expect(verdict).toMatchObject({ ok: false, reason: "too-large" });
  });
});

describe("totalSourcePixels", () => {
  it("falls back to duration times frame rate when nothing counted the frames", () => {
    // About one production video in twenty carries no nb_frames - an MPEG-TS
    // stream wearing an .mp4 name, a WebM, a damaged MP4 - and the budget still
    // has to have an answer for those.
    const raw = {
      programs: [],
      streams: [
        {
          codec_name: "h264",
          codec_type: "video",
          width: 2560,
          height: 1440,
          avg_frame_rate: "60/1",
          disposition: { attached_pic: 0 },
        },
      ],
      format: { format_name: "matroska,webm", duration: "20.000000" },
    };
    expect(totalSourcePixels(parseAvProbe(raw)!)).toBe(2560 * 1440 * 1200);
  });

  it("has no answer for sound, and says so", () => {
    const raw = {
      programs: [],
      streams: [{ codec_name: "mp3", codec_type: "audio", disposition: { attached_pic: 0 } }],
      format: { format_name: "mp3", duration: "209.000000" },
    };
    expect(totalSourcePixels(parseAvProbe(raw)!)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The guard the type system cannot give us
// ---------------------------------------------------------------------------

/**
 * Every production call to the two target functions must hand over the row's
 * size.
 *
 * The parameter is optional, because most of what those functions answer has
 * nothing to do with dimensions - and an optional parameter that a caller
 * forgets fails CLOSED here, which is the safe direction but a silent one: the
 * menu simply stops offering the rescue, on exactly the files that need it, and
 * nothing goes red. So the call sites are read instead.
 *
 * Scraped rather than typed, for the same reason lib/media/convert-notes.ts is
 * scraped by tests/unit/convert-vocabulary.test.ts: these modules reach a
 * database and a storage driver, and importing them here to count their
 * arguments would drag both into a unit test.
 */
function callsIn(source: string, fn: string): string[] {
  const calls: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf(`${fn}(`, from);
    if (start === -1) return calls;
    let depth = 0;
    let i = start + fn.length;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(start + fn.length + 1, i));
    from = i;
  }
}

/** Arguments at the TOP level of one call, so `{ width, height }` counts once. */
function argCount(call: string): number {
  let depth = 0;
  let count = 1;
  for (const ch of call) {
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) count++;
  }
  return call.trim() === "" ? 0 : count;
}

describe("every caller hands over the row's size", () => {
  const files = [
    "lib/media/av-action.ts",
    "lib/media/convert-in-place.ts",
    "lib/media/convert-plan.ts",
    "lib/media/download-menu.ts",
    "app/api/link-info/route.ts",
    "app/[userCode]/[mediaCode]/[action]/route.ts",
  ];

  it("passes five arguments to avOptionFor and four to avTargetsFor", () => {
    let seen = 0;
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      for (const call of callsIn(source, "avOptionFor")) {
        expect(argCount(call), `${file}: avOptionFor(${call})`).toBe(5);
        seen++;
      }
      for (const call of callsIn(source, "avTargetsFor")) {
        expect(argCount(call), `${file}: avTargetsFor(${call})`).toBe(4);
        seen++;
      }
    }
    // If the scrape matched nothing, everything above passed by saying nothing.
    expect(seen).toBeGreaterThanOrEqual(6);
  });
});
