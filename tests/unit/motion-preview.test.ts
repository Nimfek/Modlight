import { describe, expect, it } from "vitest";
import {
  canMotionPreview,
  clampMotionEdge,
  clipDelays,
  clipPages,
  countAnimatedWebpFrames,
  MOTION_CAPTURE_WIDTH,
  MOTION_CLIP_START_MAX_SECONDS,
  MOTION_FRAME_DELAY_MS,
  MOTION_MAX_DELAY_MS,
  MOTION_MIN_DELAY_MS,
  videoClip,
  wantsMotion,
} from "@/lib/media/motion-preview";
import {
  MAX_TRANSFORM_BYTES,
  MOTION_CLIP_FPS,
  MOTION_CLIP_MIN_SECONDS,
  MOTION_CLIP_SECONDS,
  MOTION_FRAMES,
  maxMotionDecodePixels,
  maxMotionSourcePixels,
  motionClipBudget,
  motionPageBudget,
} from "@/lib/media/transform-cost";
import { AV_MAX_INPUT_BYTES } from "@/lib/media/av-cost";

/**
 * The policy behind the moving thumbnail, with no engine attached.
 *
 * Everything here is arithmetic over a row, so the interesting cases - the ones
 * that would otherwise only show up as a container falling over on a Tuesday -
 * are cheap to pin.
 */

describe("a preview that reads as motion rather than as a slideshow", () => {
  /**
   * The complaint this whole shape exists to answer: eight frames spread over a
   * whole file is a summary. The number is pinned from both ends because both
   * ends are real - too few and it is a slideshow again, too many and the tile
   * is a download.
   */
  it("holds enough frames to be motion", () => {
    expect(MOTION_FRAMES).toBeGreaterThanOrEqual(20);
    expect(MOTION_FRAMES).toBeLessThanOrEqual(36);
    expect(MOTION_FRAMES).toBe(Math.round(MOTION_CLIP_SECONDS * MOTION_CLIP_FPS));
  });

  it("plays at real time, which a spread of samples could not claim to", () => {
    // The reciprocal of the capture rate. The eight-frame spread showed each of
    // its frames for 400 ms because frames from eight places in a file share no
    // clock; a clip has the clock the source had.
    expect(MOTION_FRAME_DELAY_MS).toBe(Math.round(1000 / MOTION_CLIP_FPS));
    expect(1000 / MOTION_FRAME_DELAY_MS).toBeGreaterThanOrEqual(10);
  });
});

describe("where in a video the clip is taken from", () => {
  it("does not start at frame zero, because videos open on black", () => {
    const clip = videoClip(60, MOTION_CLIP_SECONDS);
    expect(clip).not.toBeNull();
    expect(clip!.start).toBeGreaterThan(0);
    expect(clip!.seconds).toBe(MOTION_CLIP_SECONDS);
  });

  it("does not start six minutes into an hour-long recording", () => {
    const clip = videoClip(3600, MOTION_CLIP_SECONDS);
    expect(clip!.start).toBeLessThanOrEqual(MOTION_CLIP_START_MAX_SECONDS);
    expect(clip!.start).toBeGreaterThan(0);
  });

  it("never runs off the end, whatever the duration", () => {
    for (const duration of [0.2, 0.5, 1, 2.5, 3, 15, 54.6, 3600]) {
      const clip = videoClip(duration, MOTION_CLIP_SECONDS);
      expect(clip, `duration ${duration}`).not.toBeNull();
      expect(clip!.start).toBeGreaterThanOrEqual(0);
      expect(clip!.seconds).toBeGreaterThan(0);
      // `start` becomes an ffmpeg `-ss` and `seconds` a `-t`; between them they
      // must stay inside the pictures the file actually has.
      expect(clip!.start + clip!.seconds).toBeLessThanOrEqual(duration);
      expect(Number.isFinite(clip!.start) && Number.isFinite(clip!.seconds)).toBe(true);
    }
  });

  it("takes a file shorter than the clip whole rather than refusing it", () => {
    const clip = videoClip(1.2, MOTION_CLIP_SECONDS);
    expect(clip!.start).toBe(0);
    // Everything there is, minus the guard that keeps off the final picture.
    expect(clip!.seconds).toBeGreaterThan(1);
  });

  it("honours a clip length the budget shortened", () => {
    const clip = videoClip(15.05, 1.808);
    expect(clip!.seconds).toBe(1.808);
    expect(clip!.start).toBeCloseTo(1.505, 3);
  });

  it("says nothing when there is nothing to measure", () => {
    expect(videoClip(0)).toBeNull();
    expect(videoClip(Number.NaN)).toBeNull();
    expect(videoClip(Number.POSITIVE_INFINITY)).toBeNull();
    expect(videoClip(-5)).toBeNull();
    expect(videoClip(10, 0)).toBeNull();
  });
});

describe("how much of a video may be decoded", () => {
  const FOUR_K = 3840 * 2160;
  const FULL_HD = 1920 * 1080;

  it("gives an ordinary file the whole clip", () => {
    // 1080p60 is 311 Mpx over 2.5 s, measured at 2655 ms on production.
    expect(motionClipBudget(FULL_HD, 60).seconds).toBe(MOTION_CLIP_SECONDS);
    expect(motionClipBudget(1280 * 720, 30).seconds).toBe(MOTION_CLIP_SECONDS);
  });

  /**
   * The frame-aware multiplication, on the video side.
   *
   * A guard that looked only at the picture would see 8.3 Mpx here - less than
   * the still thumbnail ceiling - and wave the file through to decode 1244 Mpx
   * of it. The budget charges `framePixels x fps x seconds`, so the same file
   * gets a SHORTER clip instead of an unbounded decode or a refusal.
   */
  it("shortens the clip for a 4K60 source instead of refusing it", () => {
    const verdict = motionClipBudget(FOUR_K, 60);
    expect(verdict.ok).toBe(true);
    expect(verdict.seconds).toBeLessThan(MOTION_CLIP_SECONDS);
    expect(verdict.seconds).toBeGreaterThanOrEqual(MOTION_CLIP_MIN_SECONDS);
    expect(verdict.pixels).toBeLessThanOrEqual(maxMotionDecodePixels());
    // Still enough frames to be motion rather than a flicker.
    expect(verdict.frames).toBeGreaterThanOrEqual(MOTION_CLIP_MIN_SECONDS * MOTION_CLIP_FPS);
  });

  it("charges the frame rate, not only the picture", () => {
    // The same picture at half the rate is half the decode. At 30 fps a 4K clip
    // fits whole; at 60 it does not, and the clip is what gives way.
    expect(motionClipBudget(FOUR_K, 30).seconds).toBe(MOTION_CLIP_SECONDS);
    expect(motionClipBudget(FOUR_K, 60).seconds).toBeLessThan(MOTION_CLIP_SECONDS);
    for (const fps of [24, 30, 50, 60, 120]) {
      expect(motionClipBudget(FOUR_K, fps).pixels, `${fps} fps`).toBeLessThanOrEqual(
        maxMotionDecodePixels(),
      );
    }
  });

  it("refuses only when even the shortest clip is out of reach", () => {
    // 7680x4320 at 60 fps: 1990 Mpx per second of source.
    expect(motionClipBudget(7680 * 4320, 60).ok).toBe(false);
    expect(motionClipBudget(7680 * 4320, 60).frames).toBe(0);
  });

  it("assumes the expensive answer when the header does not say", () => {
    // No `nb_frames`: charged as if the source were 60 fps, which is the only
    // direction that cannot under-charge a 4K file with a thin header.
    expect(motionClipBudget(FOUR_K, null).seconds).toBe(motionClipBudget(FOUR_K, 60).seconds);
  });

  it("does not let a nonsense frame rate decide anything", () => {
    // A variable-frame-rate container can make `nb_frames / duration` absurd in
    // either direction; neither may turn into an unbounded decode or a refusal
    // of a perfectly ordinary file.
    expect(motionClipBudget(FULL_HD, 0.001).seconds).toBe(MOTION_CLIP_SECONDS);
    expect(motionClipBudget(FULL_HD, 100_000).ok).toBe(
      motionClipBudget(FULL_HD, 240).ok,
    );
    expect(motionClipBudget(0, 30).ok).toBe(false);
  });
});

describe("how much of an animation may be decoded", () => {
  /**
   * The Round 7 shape, and the reason this budget exists at all.
   *
   * A guard that multiplies width by height sees 1.26 Mpx here and waves the
   * file through; the sampler it replaced then touched 322 Mpx of it. The run is
   * bounded at MOTION_FRAMES now, so what this pins is that the pages taken are
   * charged for, one by one.
   */
  it("counts every page it will decode, not just one", () => {
    const framePixels = 1654 * 762; // 1.26 Mpx - what a two-number guard sees
    const verdict = motionPageBudget(framePixels, 256);
    expect(verdict.ok).toBe(true);
    // Not all 256: only what the clip is worth.
    expect(verdict.frames).toBe(MOTION_FRAMES);
    expect(verdict.pixels).toBe(framePixels * MOTION_FRAMES);
  });

  /**
   * The property a guard that multiplied only width by height cannot have.
   *
   * A 4000x3000 animation is 12 Mpx per frame, which is inside the per-frame
   * ceiling, so a two-number guard admits it and the run then decodes 360 Mpx.
   * The budget cuts the run instead.
   */
  it("shortens the run for a large picture rather than decoding all of it", () => {
    const verdict = motionPageBudget(4000 * 3000, MOTION_FRAMES);
    expect(verdict.ok).toBe(true);
    expect(verdict.frames).toBeLessThan(MOTION_FRAMES);
    expect(verdict.frames).toBeGreaterThanOrEqual(2);
    expect(verdict.pixels).toBeLessThanOrEqual(maxMotionSourcePixels());
  });

  it("takes a short animation whole", () => {
    const verdict = motionPageBudget(200 * 200, 6);
    expect(verdict.frames).toBe(6);
  });

  it("refuses a single enormous frame even when there are few of them", () => {
    // 100 Mpx per page: past the ceiling that guards every libvips read, and a
    // page still has to be materialised whole however few are taken.
    expect(motionPageBudget(100_000_000, 2).ok).toBe(false);
  });

  it("refuses a still", () => {
    expect(motionPageBudget(1_000, 1).ok).toBe(false);
    expect(motionPageBudget(0, 8).ok).toBe(false);
  });

  /**
   * The regression the ceiling was rewritten for, once already.
   *
   * The first version borrowed `maxPixelsFor("webp", true)` - solved for a full
   * re-encode of every frame at source resolution - and refused the largest
   * animation on this deployment, which the sampler measurably gets through.
   */
  it("admits the largest animation that actually exists on this deployment", () => {
    // 1195x1169 across 47 pages. Measured: 30 contiguous pages in 1927 ms.
    const verdict = motionPageBudget(1195 * 1169, 47);
    expect(verdict.ok).toBe(true);
    expect(verdict.frames).toBe(MOTION_FRAMES);
  });
});

describe("which pages of an animation are taken", () => {
  it("is a run from the first page, not a spread", () => {
    const run = clipPages(300, MOTION_FRAMES);
    expect(run).toEqual({ start: 0, count: MOTION_FRAMES });
  });

  it("takes a short animation whole", () => {
    expect(clipPages(5, MOTION_FRAMES)).toEqual({ start: 0, count: 5 });
  });

  it("says nothing about a still, or about a run too short to move", () => {
    expect(clipPages(1, MOTION_FRAMES)).toBeNull();
    expect(clipPages(0, MOTION_FRAMES)).toBeNull();
    expect(clipPages(300, 1)).toBeNull();
  });
});

describe("how fast the preview plays", () => {
  it("uses the source's own per-frame delays when it has them", () => {
    // The shape that makes this matter: a GIF holding its first frame for a
    // second and then running fast. A uniform delay plays nothing like it.
    const source = [1000, 50, 50, 50];
    expect(clipDelays(source, 0, 4)).toEqual([1000, 50, 50, 50]);
    expect(clipDelays(source, 1, 3)).toEqual([50, 50, 50]);
  });

  it("falls back to the capture rate where the source says nothing", () => {
    expect(clipDelays(null, 0, 3)).toEqual(new Array(3).fill(MOTION_FRAME_DELAY_MS));
    // A GIF may carry a zero delay, which means "as fast as possible" and not
    // "show this for no time at all".
    expect(clipDelays([0, 0], 0, 2)).toEqual(new Array(2).fill(MOTION_FRAME_DELAY_MS));
    // Past the end of a short array, the rest of the run still needs a delay.
    expect(clipDelays([120], 0, 3)).toEqual([120, MOTION_FRAME_DELAY_MS, MOTION_FRAME_DELAY_MS]);
  });

  it("clamps anything absurd a file claims", () => {
    expect(clipDelays([1], 0, 1)[0]).toBe(MOTION_MIN_DELAY_MS);
    expect(clipDelays([10_000_000], 0, 1)[0]).toBe(MOTION_MAX_DELAY_MS);
  });
});

describe("who is offered a moving tile", () => {
  const video = { mimeType: "video/mp4", ext: "mp4", size: 400_000_000, frames: null };
  const gif = { mimeType: "image/gif", ext: "gif", size: 2_000_000, frames: 43 };

  it("offers one for a video, on the seek budget rather than the read budget", () => {
    expect(canMotionPreview(video)).toBe(true);
    expect(video.size).toBeGreaterThan(MAX_TRANSFORM_BYTES);
    expect(canMotionPreview({ ...video, size: AV_MAX_INPUT_BYTES + 1 })).toBe(false);
  });

  it("offers one for an animation, on the read budget", () => {
    expect(canMotionPreview(gif)).toBe(true);
    expect(canMotionPreview({ ...gif, size: MAX_TRANSFORM_BYTES + 1 })).toBe(false);
  });

  it("stays silent about a still, and about a file whose frame count is unknown", () => {
    expect(canMotionPreview({ ...gif, frames: 1 })).toBe(false);
    // Legacy rows and the AVIF sequence libvips will not enumerate. Advertising
    // a URL here would send a grid off to collect 415s.
    expect(canMotionPreview({ ...gif, frames: null })).toBe(false);
  });

  it("stays silent about everything that is not a picture or a video", () => {
    expect(canMotionPreview({ mimeType: "audio/mpeg", ext: "mp3", size: 5_000, frames: null })).toBe(false);
    expect(canMotionPreview({ mimeType: "application/pdf", ext: "pdf", size: 5_000, frames: 9 })).toBe(false);
    // An SVG is an image that is never served as one (anti-XSS), so `mediaKind`
    // files it as "other" and it must not claim a moving tile either.
    expect(canMotionPreview({ mimeType: "image/svg+xml", ext: "svg", size: 5_000, frames: 9 })).toBe(false);
  });
});

describe("the query flag", () => {
  it("only answers to an exact 1", () => {
    expect(wantsMotion(new URLSearchParams("motion=1"))).toBe(true);
    expect(wantsMotion(new URLSearchParams("motion=true"))).toBe(false);
    expect(wantsMotion(new URLSearchParams("motion=0"))).toBe(false);
    expect(wantsMotion(new URLSearchParams("motion="))).toBe(false);
    // The whole point of the surface: a caller that does not ask is untouched.
    expect(wantsMotion(new URLSearchParams("w=480&h=480"))).toBe(false);
  });
});

describe("how large a moving tile may be", () => {
  it("caps a request at the size previews are offered at", () => {
    // The still path snaps up to 1200; thirty frames at 1200 is a download
    // wearing a tile's clothes.
    expect(clampMotionEdge(1200)).toBe(MOTION_CAPTURE_WIDTH);
    expect(clampMotionEdge(256)).toBe(256);
    expect(clampMotionEdge(undefined)).toBeUndefined();
  });

  it("still matches the still tile, so a hover swap does not resize the picture", () => {
    // /api/uploads and /api/link-info advertise 480 for both. The longer clip
    // made the artefact bigger, and the temptation was to cut the edge to 320
    // and take the third back; that would have broken the swap.
    expect(MOTION_CAPTURE_WIDTH).toBe(480);
  });
});

describe("counting frames out of WebP bytes", () => {
  it("reads zero from anything that is not a WebP", () => {
    expect(countAnimatedWebpFrames(Buffer.alloc(0))).toBe(0);
    expect(countAnimatedWebpFrames(Buffer.from("not a riff file at all"))).toBe(0);
  });

  /**
   * A hand-built container, so the walk is tested against bytes nobody's encoder
   * produced. The odd-sized chunk is the case that matters: RIFF pads chunks to
   * an even length, and a walk that ignores the pad byte lands in the middle of
   * the next header and starts counting nonsense.
   */
  it("follows the padding rule", () => {
    const chunk = (fourcc: string, body: Buffer) => {
      const head = Buffer.alloc(8);
      head.write(fourcc, 0, "ascii");
      head.writeUInt32LE(body.length, 4);
      const pad = body.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
      return Buffer.concat([head, body, pad]);
    };
    const body = Buffer.concat([
      Buffer.from("WEBP", "ascii"),
      chunk("VP8X", Buffer.alloc(10)),
      chunk("ANMF", Buffer.alloc(3)), // odd length, so a pad byte follows
      chunk("ANMF", Buffer.alloc(4)),
      chunk("ANMF", Buffer.alloc(5)), // odd again
    ]);
    const head = Buffer.alloc(8);
    head.write("RIFF", 0, "ascii");
    head.writeUInt32LE(body.length, 4);
    expect(countAnimatedWebpFrames(Buffer.concat([head, body]))).toBe(3);
  });
});
