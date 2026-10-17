import { describe, it, expect } from "vitest";
import {
  avOptionFor,
  avTargetsFor,
  audioCopyableTo,
  containerVerdict,
  isAvTarget,
  isVideoContainer,
  AV_OUTPUT,
  type AvOption,
} from "@/lib/media/av-targets";
import {
  AV_DEFAULT_CLIP_SECONDS,
  AV_MAX_ANIMATION_SECONDS,
  AV_MAX_AUDIO_SECONDS,
  AV_MAX_AUDIO_VIDEO_SECONDS,
  AV_MAX_CLIP_SECONDS,
  AV_MAX_INPUT_BYTES,
  AV_MAX_WAV_SECONDS,
  animationWidth,
  avBudget,
} from "@/lib/media/av-cost";

const names = (o: AvOption[]) => o.map((x) => x.to);
const costOf = (o: AvOption[], to: string) => o.find((x) => x.to === to)?.cost;
const yieldOf = (o: AvOption[], to: string) => o.find((x) => x.to === to)?.yields;

describe("what a video can be turned into", () => {
  it("offers other video containers, which is the thing people actually want", () => {
    // The complaint this rebuild came from: a .mp4 offered PNG, JPG and M4A and
    // no video format at all, so the one conversion anybody asks for was missing.
    expect(names(avTargetsFor("video/mp4", "mp4"))).toEqual(["mov", "mkv", "gif", "mp3"]);
    expect(names(avTargetsFor("video/quicktime", "mov"))).toEqual(["mp4", "mkv", "gif", "mp3"]);
  });

  it("never offers a video the format it already is", () => {
    for (const [mime, ext] of [
      ["video/mp4", "mp4"],
      ["video/quicktime", "mov"],
      ["video/x-matroska", "mkv"],
      ["video/webm", "webm"],
    ] as const) {
      expect(names(avTargetsFor(mime, ext)), ext).not.toContain(ext);
    }
  });

  it("puts the MP4/MOV swap first, because it is the cheapest useful entry", () => {
    // Both are ISO base media format, so this is a stream copy: measured at
    // 128 ms for a 184 kB clip and 269 ms for a 37 MB one, and the video comes
    // out bit-identical.
    expect(names(avTargetsFor("video/mp4", "mp4"))[0]).toBe("mov");
    expect(names(avTargetsFor("video/quicktime", "mov"))[0]).toBe("mp4");
  });

  it("offers MKV for every video, because Matroska takes every codec", () => {
    for (const [mime, ext] of [
      ["video/mp4", "mp4"],
      ["video/quicktime", "mov"],
      ["video/webm", "webm"],
      ["video/x-msvideo", "avi"],
      ["video/x-ms-wmv", "wmv"],
    ] as const) {
      expect(names(avTargetsFor(mime, ext)), ext).toContain("mkv");
    }
  });

  it("never offers WebM as a destination", () => {
    // WebM takes VP8/VP9/AV1 only, and a .mkv in circulation is almost always
    // H.264 or HEVC - so the entry was priced as a free copy, shown publicly,
    // and answered 409 for every real file on this server, including the only
    // .mkv here. The reverse direction still works and is still offered: a
    // .webm can go into Matroska, which accepts its codecs.
    expect(names(avTargetsFor("video/x-matroska", "mkv"))).not.toContain("webm");
    expect(names(avTargetsFor("video/webm", "webm"))).toEqual(["mkv", "gif", "mp3"]);
    expect(names(avTargetsFor("video/mp4", "mp4"))).not.toContain("webm");
  });

  it("no longer offers a still frame or a bare audio container", () => {
    // Both were reported as nonsense, and they were: "download this four minute
    // film as a PNG" is not a thing anybody wants, and nothing else in the app
    // used the frame grab (video posters are drawn by the browser).
    const video = avTargetsFor("video/mp4", "mp4");
    for (const gone of ["png", "jpg", "m4a"]) {
      expect(names(video), gone).not.toContain(gone);
    }
  });

  it("prices stream copies and encodes differently, because that is who may ask", () => {
    const video = avTargetsFor("video/x-matroska", "mkv");
    // Public: no encoder runs, cost is bounded by input size alone.
    for (const to of ["mp4", "mov"]) {
      expect(costOf(video, to), to).toBe("copy");
    }
    // Owner only: the caller chooses the workload.
    expect(costOf(video, "gif")).toBe("encode");
    expect(costOf(video, "mp3")).toBe("encode");
  });
});

describe("what an audio file can be turned into", () => {
  it("never offers to re-encode a file into the format it already is", () => {
    expect(names(avTargetsFor("audio/mpeg", "mp3"))).toEqual(["ogg", "wav", "mp4"]);
    expect(names(avTargetsFor("audio/wav", "wav"))).toEqual(["mp3", "ogg", "mp4"]);
    expect(names(avTargetsFor("audio/ogg", "ogg"))).toEqual(["mp3", "wav", "mp4"]);
  });

  it("offers a video wrapper, for the places that refuse a bare audio file", () => {
    const audio = avTargetsFor("audio/mpeg", "mp3");
    expect(yieldOf(audio, "mp4")).toBe("audioVideo");
    expect(costOf(audio, "mp4")).toBe("encode");
  });

  it("keeps the audio-to-audio entries distinct from a video's audio track", () => {
    // The same target name means two different things, and the menu has to say
    // which: "the same sound in another format" against "the sound only".
    expect(yieldOf(avTargetsFor("audio/mp4", "m4a"), "mp3")).toBe("audioFormat");
    expect(yieldOf(avTargetsFor("video/mp4", "mp4"), "mp3")).toBe("audio");
  });
});

describe("what an animation can be turned into", () => {
  it("reaches the frames of an animated AVIF that libvips cannot open", () => {
    // The file this half was built for: 43 frames of AV1 in an AVIF sequence.
    // libheif hands libvips the cover frame only, so the image menu can offer
    // nothing but stills. ffmpeg demuxes it through the mov family.
    const options = avTargetsFor("image/avif", "avif", null);
    expect(names(options)).toEqual(["gif", "webp"]);
    expect(options.every((o) => o.cost === "encode" && o.yields === "animation")).toBe(true);
  });

  it("turns a GIF into an MP4, which is the biggest saving in the whole menu", () => {
    // Measured on a production 2.39 MB GIF: the MP4 is 32 kB, seventy-four times
    // smaller, with all 128 frames intact. libvips cannot produce it at all.
    const gif = avTargetsFor("image/gif", "gif", 128);
    expect(names(gif)).toEqual(["mp4"]);
    expect(yieldOf(gif, "mp4")).toBe("animation");
  });

  it("withholds the animation offer once a file is known to hold one frame", () => {
    // frames === 1 is a fact about the file. frames === null is every row
    // nobody has counted, and those keep the offer.
    expect(avTargetsFor("image/avif", "avif", 1)).toEqual([]);
    expect(avTargetsFor("image/gif", "gif", 1)).toEqual([]);
    expect(names(avTargetsFor("image/gif", "gif", null))).toEqual(["mp4"]);
  });

  it("offers nothing for still pictures, archives and documents", () => {
    // Those belong to convert-targets.ts alone.
    for (const [mime, ext] of [
      ["image/png", "png"],
      ["image/jpeg", "jpg"],
      ["image/webp", "webp"],
      ["application/zip", "zip"],
      ["application/pdf", "pdf"],
      ["text/plain", "txt"],
    ] as const) {
      expect(avTargetsFor(mime, ext), `${mime}`).toEqual([]);
    }
  });
});

describe("the menu and the route cannot come apart", () => {
  it("admits exactly what it displays, over the whole product of files and targets", () => {
    const files = [
      ["video/x-matroska", "mkv"],
      ["video/mp4", "mp4"],
      ["video/quicktime", "mov"],
      ["video/webm", "webm"],
      ["video/x-msvideo", "avi"],
      ["audio/mpeg", "mp3"],
      ["audio/wav", "wav"],
      ["image/avif", "avif"],
      ["image/gif", "gif"],
      ["image/png", "png"],
      ["application/zip", "zip"],
    ] as const;
    const asked = [
      "mp4",
      "mov",
      "mkv",
      "webm",
      "mp3",
      "ogg",
      "wav",
      "gif",
      "webp",
      "png",
      "jpg",
      "m4a",
      "exe",
      "",
    ];

    for (const [mime, ext] of files) {
      const visible = new Set<string>(names(avTargetsFor(mime, ext)));
      for (const to of asked) {
        const accepted = avOptionFor(mime, ext, null, to) !== null;
        expect(accepted, `${mime} -> ${to}`).toBe(visible.has(to));
      }
    }
  });

  it("rejects anything that is not one of our target names", () => {
    expect(isAvTarget("mp4")).toBe(true);
    expect(isAvTarget("mkv")).toBe(true);
    // Removed with the frame grabs and the bare audio container.
    expect(isAvTarget("png")).toBe(false);
    expect(isAvTarget("m4a")).toBe(false);
    expect(isAvTarget(null)).toBe(false);
    expect(isAvTarget("../../etc/passwd")).toBe(false);
  });

  it("knows a video container from the rest, and names an output for every target", () => {
    expect(isVideoContainer("mkv")).toBe(true);
    expect(isVideoContainer("gif")).toBe(false);
    for (const [mime, ext] of [
      ["video/x-matroska", "mkv"],
      ["audio/wav", "wav"],
      ["image/gif", "gif"],
    ] as const) {
      for (const option of avTargetsFor(mime, ext)) {
        expect(AV_OUTPUT[option.to], option.to).toBeTruthy();
      }
    }
  });
});

describe("container and audio-copy verdicts", () => {
  it("passes the codecs every browser decodes in an MP4 or a MOV", () => {
    for (const to of ["mp4", "mov"] as const) {
      expect(containerVerdict(to, { video: { codec: "h264" }, audio: { codec: "aac" } })).toEqual({
        ok: true,
      });
      expect(containerVerdict(to, { video: { codec: "av1" }, audio: null })).toEqual({ ok: true });
    }
  });

  it("declines VP9 in an MP4, which ffmpeg would mux but Safari would not play", () => {
    expect(containerVerdict("mp4", { video: { codec: "vp9" }, audio: { codec: "opus" } })).toEqual({
      ok: false,
      reason: "video-codec",
    });
  });

  it("lets Matroska take anything, which is why it is the fallback offer", () => {
    for (const codec of ["vp9", "h264", "wmv2", "theora", "prores"]) {
      expect(containerVerdict("mkv", { video: { codec }, audio: null }), codec).toEqual({ ok: true });
    }
    expect(audioCopyableTo("mkv", "opus")).toBe(true);
    expect(audioCopyableTo("mkv", "pcm_s16le")).toBe(true);
  });

  it("holds WebM to its own short codec list", () => {
    expect(containerVerdict("webm", { video: { codec: "vp9" }, audio: null })).toEqual({ ok: true });
    expect(containerVerdict("webm", { video: { codec: "h264" }, audio: null })).toEqual({
      ok: false,
      reason: "video-codec",
    });
    expect(audioCopyableTo("webm", "opus")).toBe(true);
    expect(audioCopyableTo("webm", "aac")).toBe(false);
  });

  it("declines a file with no video track at all", () => {
    expect(containerVerdict("mp4", { video: null, audio: { codec: "aac" } })).toEqual({
      ok: false,
      reason: "no-video",
    });
  });

  it("keeps an incompatible audio track out of the container rather than the file", () => {
    // Opus cannot ride along in our MP4, but the video still can - the caller is
    // told the track was dropped instead of being refused a working video.
    expect(containerVerdict("mp4", { video: { codec: "h264" }, audio: { codec: "opus" } }).ok).toBe(
      true,
    );
    expect(audioCopyableTo("mp4", "opus")).toBe(false);
    expect(audioCopyableTo("mp4", "aac")).toBe(true);
    expect(audioCopyableTo("mp4", "mp3")).toBe(true);
    expect(audioCopyableTo("mp4", null)).toBe(false);
  });
});

describe("the video budget", () => {
  it("refuses an input larger than ffmpeg is ever pointed at", () => {
    const verdict = avBudget("mp4", "copy", { bytes: AV_MAX_INPUT_BYTES + 1, duration: 10 });
    expect(verdict).toEqual({ ok: false, reason: "too-large", limit: AV_MAX_INPUT_BYTES });
  });

  it("does not care how long a stream copy is, only how big", () => {
    // A copy's cost is bytes moved. A three-hour file that fits the size ceiling
    // is 4 s of work, and refusing it for its length would be superstition.
    for (const to of ["mp4", "mov", "mkv", "webm"] as const) {
      expect(avBudget(to, "copy", { bytes: 1000, duration: 3 * 3600 }), to).toEqual({
        ok: true,
        clipSeconds: null,
      });
    }
  });

  it("refuses an audio encode longer than it can finish inside the request", () => {
    expect(avBudget("mp3", "encode", { bytes: 1000, duration: AV_MAX_AUDIO_SECONDS + 1 })).toEqual({
      ok: false,
      reason: "too-long",
      limit: AV_MAX_AUDIO_SECONDS,
    });
    expect(avBudget("mp3", "encode", { bytes: 1000, duration: 60 }).ok).toBe(true);
  });

  it("holds WAV to a much shorter ceiling, because PCM does not compress", () => {
    // 10.6 MB per minute whatever went in: at the general ceiling one click
    // would produce a 158 MB download from a 5 MB source.
    expect(AV_MAX_WAV_SECONDS).toBeLessThan(AV_MAX_AUDIO_SECONDS);
    const tooLong = avBudget("wav", "encode", { bytes: 1000, duration: AV_MAX_WAV_SECONDS + 1 });
    expect(tooLong).toEqual({ ok: false, reason: "too-long", limit: AV_MAX_WAV_SECONDS });
    // ...while the same length is fine as an MP3.
    expect(avBudget("mp3", "encode", { bytes: 1000, duration: AV_MAX_WAV_SECONDS + 1 }).ok).toBe(
      true,
    );
  });

  it("charges audio-as-video by whether the sound has to be re-encoded", () => {
    // Measured on a 209 s MP3: 2196 ms when MP4 takes the track as it is,
    // 10920 ms when it has to become AAC. Five times the work per second, so
    // five times less of it fits in one request.
    expect(AV_MAX_AUDIO_VIDEO_SECONDS).toBeLessThan(AV_MAX_AUDIO_SECONDS);
    const long = { bytes: 1000, duration: AV_MAX_AUDIO_SECONDS - 1, sourceKind: "audio" as const };
    expect(avBudget("mp4", "encode", { ...long, audioCopyable: true }).ok).toBe(true);
    expect(avBudget("mp4", "encode", { ...long, audioCopyable: false })).toEqual({
      ok: false,
      reason: "too-long",
      limit: AV_MAX_AUDIO_VIDEO_SECONDS,
    });
  });

  it("treats an unknown duration as unknown, not as unlimited", () => {
    expect(avBudget("mp3", "encode", { bytes: 1000, duration: null }).ok).toBe(false);
    expect(
      avBudget("mp4", "encode", { bytes: 1000, duration: null, sourceKind: "audio" }).ok,
    ).toBe(false);
  });

  it("converts an animation whole, and refuses one that is implausibly long", () => {
    // Taking the first six seconds of a 43-frame loop would be vandalism, so
    // there is no clip here - only a length past which we decline.
    const sequence = { bytes: 1000, duration: 2.15, sourceKind: "image-sequence" as const };
    expect(avBudget("webp", "encode", sequence, 6)).toEqual({ ok: true, clipSeconds: null });
    expect(avBudget("mp4", "encode", sequence)).toEqual({ ok: true, clipSeconds: null });
    // A duration we could not read is fine: the frame count bounds the work, and
    // the input size ceiling bounds the frame count.
    expect(
      avBudget("mp4", "encode", { bytes: 1000, duration: null, sourceKind: "image-sequence" }).ok,
    ).toBe(true);
    expect(
      avBudget("gif", "encode", {
        bytes: 1000,
        duration: AV_MAX_ANIMATION_SECONDS + 1,
        sourceKind: "image-sequence",
      }),
    ).toEqual({ ok: false, reason: "too-long", limit: AV_MAX_ANIMATION_SECONDS });
  });

  it("clamps a clip instead of refusing it, and never past the end of the file", () => {
    // Asking for a longer GIF than we make is a preference, not an error.
    expect(avBudget("gif", "encode", { bytes: 1000, duration: 600 }, 9999)).toEqual({
      ok: true,
      clipSeconds: AV_MAX_CLIP_SECONDS,
    });
    expect(avBudget("gif", "encode", { bytes: 1000, duration: 600 }, null)).toEqual({
      ok: true,
      clipSeconds: AV_DEFAULT_CLIP_SECONDS,
    });
    // A 2 s source cannot yield a 6 s clip.
    expect(avBudget("gif", "encode", { bytes: 1000, duration: 2.15 }, 6)).toEqual({
      ok: true,
      clipSeconds: 2.15,
    });
    // Zero and negatives land on the floor rather than producing an empty file.
    expect(avBudget("gif", "encode", { bytes: 1000, duration: 600 }, -5)).toEqual({
      ok: true,
      clipSeconds: 1,
    });
  });

  it("scales an animation down but never up", () => {
    expect(animationWidth(1920)).toBe(480);
    expect(animationWidth(320)).toBe(320);
    expect(animationWidth(null)).toBe(480);
  });
});
