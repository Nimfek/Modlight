import { describe, it, expect } from "vitest";
import {
  animationFilters,
  audioCoverPath,
  frameOffset,
  planAv,
  avVariant,
} from "@/lib/media/av-convert";
import { inputArgs, probeInputArgs } from "@/lib/media/ffmpeg";
import type { AvProbe, AvStream } from "@/lib/media/av-probe";
import type { AvOption, AvTarget } from "@/lib/media/av-targets";
import type { AvWorkspace } from "@/lib/media/av-workspace";

const ws: AvWorkspace = {
  input: "/data/storage/abc/xyz.mkv",
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
    duration: 32.23,
    video: stream({ kind: "video", codec: "h264", width: 1280, height: 720, frames: 968 }),
    audio: stream({ codec: "aac" }),
    streams: [],
    ...over,
  };
}

const opt = (to: AvTarget, cost: AvOption["cost"] = "copy"): AvOption => ({
  to,
  cost,
  yields: "video",
});

function plan(
  option: AvOption,
  over: Partial<AvProbe> = {},
  extra: Partial<Parameters<typeof planAv>[0]> = {},
) {
  const result = planAv({
    option,
    probe: probe(over),
    sourceKind: "video",
    workspace: ws,
    clipSeconds: null,
    offsetSeconds: null,
    ...extra,
  });
  if ("refuse" in result) throw new Error(`unexpected refusal: ${result.refuse}`);
  return result;
}

/** Index of a flag, or -1. Used to assert ORDER, which is what ffmpeg cares about. */
const at = (args: string[], flag: string) => args.indexOf(flag);

describe("the guards every invocation carries", () => {
  it("whitelists protocols so no file can make ffmpeg fetch a URL", () => {
    const args = inputArgs("/x.mp4", "mov");
    expect(args).toContain("-protocol_whitelist");
    expect(args[at(args, "-protocol_whitelist") + 1]).toBe("file,pipe");
    expect(probeInputArgs("/x.mp4")).toContain("-protocol_whitelist");
  });

  it("forces the demuxer rather than letting ffmpeg choose one", () => {
    // The load-bearing guard. Measured: handed an ffconcat playlist with no
    // `-f`, ffmpeg picks the concat demuxer and tries to open the paths in it.
    // And `-f lavfi` needs no protocol at all, so the whitelist alone would not
    // have covered this.
    const args = inputArgs("/x.mkv", "matroska");
    expect(args[at(args, "-f") + 1]).toBe("matroska");
    expect(at(args, "-f")).toBeLessThan(at(args, "-i"));
  });

  it("confines mov data references, and only where that option exists", () => {
    // Measured: `-use_absolute_path` against a non-mov demuxer is fatal
    // ("Option use_absolute_path not found."), so it may only be passed for the
    // family that owns it - which is also the only family with drefs to confine.
    expect(inputArgs("/x.mp4", "mov")).toContain("-use_absolute_path");
    for (const container of ["matroska", "mp3", "wav", "avi", "gif", "ogg", "image2"]) {
      expect(inputArgs("/x", container), container).not.toContain("-use_absolute_path");
    }
  });

  it("puts -ss before -i, where it seeks instead of decoding", () => {
    // After -i, ffmpeg decodes and discards every frame up to the offset. On a
    // long file that is the difference between 0.3 s and a minute of both cores.
    const args = inputArgs("/x.mp4", "mov", ["-ss", "5.000"]);
    expect(at(args, "-ss")).toBeGreaterThan(-1);
    expect(at(args, "-ss")).toBeLessThan(at(args, "-i"));
  });

  it("never lets a path be read as a flag", () => {
    // No shell is involved (spawn runs with shell:false), so the only thing that
    // matters is that the path stays one argument.
    const nasty = "/data/storage/a b/;rm -rf $(echo x).mkv";
    const args = inputArgs(nasty, "matroska");
    expect(args[args.length - 1]).toBe(nasty);
    expect(args.filter((a) => a === nasty)).toHaveLength(1);
  });
});

describe("moving a video into another container", () => {
  it("copies the streams instead of encoding them, for every container", () => {
    for (const to of ["mp4", "mov", "mkv"] as const) {
      const { args } = plan(opt(to));
      expect(args[at(args, "-c") + 1], to).toBe("copy");
      expect(args, to).not.toContain("libx264");
    }
  });

  it("names the right muxer and the right file extension", () => {
    const cases: Array<[AvTarget, string, string]> = [
      ["mp4", "mp4", "mp4"],
      ["mov", "mov", "mov"],
      ["mkv", "matroska", "mkv"],
    ];
    for (const [to, muxer, ext] of cases) {
      const p = plan(opt(to));
      // The LAST -f is the output format; the first belongs to the input.
      expect(p.args[p.args.lastIndexOf("-f") + 1], to).toBe(muxer);
      expect(p.ext, to).toBe(ext);
      expect(p.outputPath.endsWith(`.${ext}`), to).toBe(true);
    }
  });

  it("moves the index to the front, but only for the formats that have one", () => {
    // Matroska interleaves its cues and rejects the flag outright.
    const mp4 = plan(opt("mp4")).args;
    expect(mp4[at(mp4, "-movflags") + 1]).toBe("+faststart");
    expect(plan(opt("mov")).args).toContain("-movflags");
    expect(plan(opt("mkv")).args).not.toContain("-movflags");
  });

  it("drops subtitle and data streams, which have no home in an MP4", () => {
    const { args } = plan(opt("mp4"));
    expect(args).toContain("-dn");
    expect(args).toContain("-sn");
  });

  it("strips container metadata, which can carry the device and the location", () => {
    const { args } = plan(opt("mp4"));
    expect(args[at(args, "-map_metadata") + 1]).toBe("-1");
  });

  it("carries a copyable audio track along and says nothing about it", () => {
    const p = plan(opt("mp4"));
    expect(p.args.filter((a) => a === "-map")).toHaveLength(2);
    expect(p.note).toBeUndefined();
  });

  it("drops an audio track it cannot copy, and says so", () => {
    // Opus in an MP4: the video is what the viewer wants, so it is delivered
    // rather than refused - but silently losing the sound would be a surprise.
    const p = plan(opt("mp4"), { audio: stream({ codec: "opus" }) });
    expect(p.args.filter((a) => a === "-map")).toHaveLength(1);
    expect(p.note).toBe("audio-dropped");
    // ...and the same track goes into a Matroska untouched.
    expect(plan(opt("mkv"), { audio: stream({ codec: "opus" }) }).note).toBeUndefined();
  });

  it("refuses codecs it would have to re-encode", () => {
    const vp9 = { video: stream({ kind: "video", codec: "vp9", width: 640, height: 480 }) };
    expect(
      planAv({
        option: opt("mp4"),
        probe: probe(vp9),
        sourceKind: "video",
        workspace: ws,
        clipSeconds: null,
        offsetSeconds: null,
      }),
    ).toEqual({ refuse: "video-codec" });
    // Matroska is the entry that never declines, which is why it is offered on
    // every video as the fallback.
    expect(plan(opt("mkv"), vp9).args).toContain("copy");
  });
});

describe("an audio file wrapped in a video", () => {
  const audioPlan = (over: Partial<AvProbe> = {}) =>
    plan(opt("mp4", "encode"), { video: null, ...over }, { sourceKind: "audio" });

  it("holds one still picture for the length of the track", () => {
    const { args } = audioPlan();
    expect(args).toContain(audioCoverPath());
    expect(args[at(args, "-loop") + 1]).toBe("1");
    expect(args[at(args, "-tune") + 1]).toBe("stillimage");
    // Two inputs, two maps: the picture and the sound.
    expect(args.filter((a) => a === "-i")).toHaveLength(2);
    expect(args[at(args, "-map") + 1]).toBe("0:v:0");
    expect(args[args.lastIndexOf("-map") + 1]).toBe("1:a:0");
  });

  it("ends the picture with the sound rather than ten seconds later", () => {
    // `-shortest` alone stops the muxer but leaves the looping image running:
    // measured 218.5 s of video over 208.7 s of audio without `-fflags
    // +shortest`, 210 s with it.
    const { args } = audioPlan();
    expect(args).toContain("-shortest");
    expect(args[at(args, "-fflags") + 1]).toBe("+shortest");
  });

  it("copies the sound when MP4 will take it, and says when it could not", () => {
    // Measured on a 209 s MP3: 2196 ms copying the track, 10920 ms re-encoding
    // it to AAC. Same file, five times the work.
    const copied = audioPlan({ audio: stream({ codec: "mp3" }) });
    expect(copied.args[at(copied.args, "-c:a") + 1]).toBe("copy");
    expect(copied.note).toBeUndefined();

    const reencoded = audioPlan({ audio: stream({ codec: "flac" }) });
    expect(reencoded.args[at(reencoded.args, "-c:a") + 1]).toBe("aac");
    expect(reencoded.note).toBe("audio-reencoded");
  });

  it("refuses a file with no sound in it", () => {
    expect(
      planAv({
        option: opt("mp4", "encode"),
        probe: probe({ video: null, audio: null }),
        sourceKind: "audio",
        workspace: ws,
        clipSeconds: null,
        offsetSeconds: null,
      }),
    ).toEqual({ refuse: "no-audio" });
  });
});

describe("an animation re-encoded as a video", () => {
  const gifPlan = () =>
    plan(opt("mp4", "encode"), { container: "gif", duration: 5.12 }, { sourceKind: "image-sequence" });

  it("keeps every frame instead of clipping, and drops no sound it never had", () => {
    const { args } = gifPlan();
    expect(args).not.toContain("-t");
    expect(args).not.toContain("-ss");
    expect(args).toContain("-an");
  });

  it("fixes the odd dimensions h264 refuses, without resizing the picture", () => {
    // A 211x211 GIF cannot be encoded as-is; measured, the fix costs nothing and
    // the result is 32 kB against the GIF's 2.39 MB.
    const { args } = gifPlan();
    expect(args[at(args, "-vf") + 1]).toBe("scale=trunc(iw/2)*2:trunc(ih/2)*2");
    expect(args[at(args, "-pix_fmt") + 1]).toBe("yuv420p");
  });
});

describe("clips and animated pictures", () => {
  it("computes a palette from the clip, because GIF holds 256 colours", () => {
    const filters = animationFilters({ resampleFps: true, width: 480, paletted: true });
    expect(filters).toContain("palettegen");
    expect(filters).toContain("paletteuse");
    expect(filters).toContain("fps=");
  });

  it("does not palette a WebP, which is truecolour", () => {
    const filters = animationFilters({ resampleFps: true, width: 480, paletted: false });
    expect(filters).not.toContain("palettegen");
  });

  it("leaves an image sequence's own frame timing alone", () => {
    // The AVIF from the bug report is a 43-frame loop at about 20 fps. Forcing
    // it to 12 would make the converted file visibly jerkier than the original,
    // which is the opposite of the point. A video, being arbitrarily long, is
    // resampled and clipped.
    const sequence = plan(
      opt("webp", "encode"),
      { duration: 2.15, audio: null },
      { sourceKind: "image-sequence", clipSeconds: 6 },
    );
    const filters = sequence.args[at(sequence.args, "-vf") + 1];
    expect(filters).not.toContain("fps=");
    expect(sequence.args).not.toContain("-t");

    const video = plan(opt("gif", "encode"), {}, { clipSeconds: 6 });
    expect(video.args[at(video.args, "-vf") + 1]).toContain("fps=");
    expect(video.args[at(video.args, "-t") + 1]).toBe("6");
  });

  it("stops the demuxer at the clip, not just the muxer", () => {
    // -t after -i bounds what is WRITTEN, but palettegen cannot emit a palette
    // until its input ends, so the graph pulls the whole remaining stream.
    // Measured on the 32 s test file: 3917 ms with -t after -i, 995 ms before.
    const { args } = plan(opt("gif", "encode"), {}, { clipSeconds: 6 });
    expect(at(args, "-t")).toBeLessThan(at(args, "-i"));
  });

  it("loops forever, which libwebp does not do by default", () => {
    const { args } = plan(opt("webp", "encode"), {}, { clipSeconds: 6 });
    expect(args[at(args, "-loop") + 1]).toBe("0");
    expect(args).toContain("libwebp");
  });

  it("says when the result is a clip of something longer", () => {
    expect(plan(opt("gif", "encode"), { duration: 240 }, { clipSeconds: 6 }).note).toBe("clipped");
    expect(plan(opt("gif", "encode"), { duration: 4 }, { clipSeconds: 4 }).note).toBeUndefined();
  });

  it("offsets a clip but never a frozen picture", () => {
    expect(frameOffset(null, 60)).toBe(1);
    expect(frameOffset(9999, 32.23)).toBeCloseTo(32.18, 2);
    expect(frameOffset(5, 32.23)).toBe(5);
    expect(frameOffset(-3, 60)).toBe(1);
    expect(frameOffset(10, null)).toBe(10);
  });
});

describe("cache identity", () => {
  it("keys on what the caller chose, so a lookup needs no conversion first", () => {
    // Both numbers are rounded: `?d=6.1` and `?d=6.1001119` cut the same
    // frames, so an unrounded clip length minted a fresh cache entry per
    // keystroke - the same disk-filling trick the offset was already fixed for.
    expect(avVariant("gif", 6, 12)).toBe("gif-c6.00-t12.00");
    expect(avVariant("gif", 6.1001119, 12)).toBe(avVariant("gif", 6.1, 12));
    expect(avVariant("mp4", null, null)).toBe("mp4");
    // A container copy moves the whole file, so timing cannot change its bytes.
    // Folding `?t=` in anyway let anybody holding a public link mint unlimited
    // byte-identical cache entries out of one video.
    expect(avVariant("mkv", 6, 4)).toBe("mkv");
    // The same is true of an animation, which is converted whole.
    expect(avVariant("gif", 6, 4, "image-sequence")).toBe("gif");
  });

  it("gives different requests different keys", () => {
    expect(avVariant("gif", 6, 0)).not.toBe(avVariant("gif", 15, 0));
    expect(avVariant("gif", 6, 1)).not.toBe(avVariant("gif", 6, 2));
  });
});
