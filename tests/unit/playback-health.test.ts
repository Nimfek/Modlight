import { describe, it, expect } from "vitest";
import {
  bitsPerPixel,
  diagnosePlayback,
  frameTotal,
  HARDWARE_DECODER_MAX_EDGE,
  MACROBLOCK_PIXELS,
  MIN_BITS_PER_MACROBLOCK,
  STARVED_BITS_PER_PIXEL,
  TYPICAL_BITS_PER_PIXEL,
  type PlaybackSource,
} from "@/lib/media/playback-health";
import { frameCount } from "@/lib/media/av-meta";
import { WEB_MAX_EDGE } from "@/lib/media/av-targets";

/**
 * Real rows, measured read-only against production in September 2026 with
 * ffprobe 5.1.9 in the app container. Every number here is a fact about a file
 * that exists, not a shape invented to make a threshold look good.
 */

/** The reported recording. Both faults at once, and the lowest bpp of all 464. */
const REPORTED: PlaybackSource = {
  mimeType: "video/mp4",
  ext: "mp4",
  size: 2_181_784,
  width: 5056,
  height: 1924,
  frames: 403,
  durationSeconds: 13.433,
  fps: 30,
};

/** The same owner, the same capture rig, a recording nobody has complained about. */
const HEALTHY_WIDE: PlaybackSource = {
  mimeType: "video/mp4",
  ext: "mp4",
  size: 16_134_048,
  width: 5056,
  height: 1924,
  frames: 218,
  durationSeconds: 7.267,
  fps: 30,
};

/** An ordinary 1080p clip. Nothing about its shape is remarkable. */
const ORDINARY: PlaybackSource = {
  mimeType: "video/mp4",
  ext: "mp4",
  size: 2_061_014,
  width: 1280,
  height: 720,
  frames: 395,
  durationSeconds: 13.19,
  fps: 30,
};

/**
 * The lowest-bitrate file on production that the line does NOT flag: 0.00805
 * bits per pixel, 2.06 bits per macroblock. It is the margin, so it is pinned.
 */
const JUST_ABOVE_THE_LINE: PlaybackSource = {
  mimeType: "video/mp4",
  ext: "mp4",
  size: 7_549_000,
  width: 1080,
  height: 1920,
  frames: 3619,
  durationSeconds: 120.6,
  fps: 30,
};

describe("the thresholds themselves", () => {
  it("derives the bitrate line from macroblocks, not from taste", () => {
    expect(STARVED_BITS_PER_PIXEL).toBe(MIN_BITS_PER_MACROBLOCK / MACROBLOCK_PIXELS);
    expect(STARVED_BITS_PER_PIXEL).toBeCloseTo(0.0078125, 10);
  });

  it("keeps the hardware wall and the repair size apart", () => {
    // 4096 is where playback breaks; 1920 is where the repair parks the output.
    // Collapsing them would put every repaired file right under the wall, on
    // H.264 level 5.1, which plenty of devices decline for reasons of their own.
    expect(HARDWARE_DECODER_MAX_EDGE).toBe(4096);
    expect(WEB_MAX_EDGE).toBeLessThan(HARDWARE_DECODER_MAX_EDGE);
  });

  it("compares against what a normal video here really carries", () => {
    // The median of 464 production videos was 0.0649. It is used for the
    // sentence and nothing branches on it, but a value that drifted far from the
    // measurement would make the note say something untrue.
    expect(TYPICAL_BITS_PER_PIXEL).toBeGreaterThan(0.06);
    expect(TYPICAL_BITS_PER_PIXEL).toBeLessThan(0.07);
    expect(TYPICAL_BITS_PER_PIXEL / STARVED_BITS_PER_PIXEL).toBeGreaterThan(8);
  });
});

describe("frameTotal", () => {
  it("prefers the count when there is one", () => {
    expect(frameTotal({ frames: 403, durationSeconds: 13.4, fps: 30 })).toBe(403);
  });

  it("falls back to duration times rate, which is one video in twenty", () => {
    expect(frameTotal({ frames: null, durationSeconds: 40, fps: 29.97 })).toBe(1199);
  });

  it("answers null rather than zero when neither is available", () => {
    expect(frameTotal({})).toBeNull();
    expect(frameTotal({ frames: null, durationSeconds: 40 })).toBeNull();
    expect(frameTotal({ frames: null, fps: 30 })).toBeNull();
    expect(frameTotal({ frames: 0 })).toBeNull();
    expect(frameTotal({ frames: null, durationSeconds: 0.001, fps: 1 })).toBeNull();
  });

  it("survives the nonsense a damaged container reports", () => {
    expect(frameTotal({ frames: null, durationSeconds: Number.NaN, fps: 30 })).toBeNull();
    expect(frameTotal({ frames: null, durationSeconds: Infinity, fps: 30 })).toBeNull();
    expect(frameTotal({ frames: null, durationSeconds: 10, fps: Number.NaN })).toBeNull();
  });

  it("is the same implementation the upload path and the backfill use", () => {
    // av-meta re-exports it deliberately; two copies of this arithmetic is how
    // the panel's warning and scripts/backfill-av-metadata.ts would come to
    // disagree about how many frames a file holds.
    const meta = { width: 1920, height: 1080, frames: null, durationSeconds: 40, fps: 29.97 };
    expect(frameCount(meta)).toBe(frameTotal(meta));
    expect(frameCount({ ...meta, frames: 7 })).toBe(7);
  });
});

describe("bitsPerPixel", () => {
  it("reproduces the reported recording's measurement", () => {
    // 2.18 MB over 5056 x 1924 x 403 = 0.00445, the lowest of 464 production
    // videos, and 1.14 bits per 16x16 macroblock.
    const bpp = bitsPerPixel(REPORTED)!;
    expect(bpp).toBeCloseTo(0.00445, 5);
    expect(bpp * MACROBLOCK_PIXELS).toBeCloseTo(1.14, 2);
  });

  it("puts the same owner's healthy recording an order of magnitude higher", () => {
    expect(bitsPerPixel(HEALTHY_WIDE)!).toBeCloseTo(0.0609, 4);
    expect(bitsPerPixel(HEALTHY_WIDE)! / bitsPerPixel(REPORTED)!).toBeGreaterThan(13);
  });

  it("is null, not zero, when the row was never measured", () => {
    expect(bitsPerPixel({ size: 1000, width: null, height: null, frames: 10 })).toBeNull();
    expect(bitsPerPixel({ size: 0, width: 100, height: 100, frames: 10 })).toBeNull();
    expect(bitsPerPixel({ size: 1000, width: 100, height: 100 })).toBeNull();
  });
});

describe("diagnosePlayback", () => {
  it("names both faults on the recording that started this", () => {
    const d = diagnosePlayback(REPORTED)!;
    expect(d.faults).toEqual(["oversized", "starved"]);
    expect(d.edge).toBe(5056);
    expect(d.repairable).toBe(true);
    expect(d.repairEdge).toBe(WEB_MAX_EDGE);
    // "about fifteen times less than a normal video here" is the sentence.
    expect(d.starvationFactor).toBe(15);
  });

  it("still warns about the same owner's healthy 5056px recordings", () => {
    // Its bitrate is fine; its width is not, and no hardware decoder cares how
    // well encoded a picture it cannot accept is.
    const d = diagnosePlayback(HEALTHY_WIDE)!;
    expect(d.faults).toEqual(["oversized"]);
    expect(d.repairable).toBe(true);
    // ...and it is not told it is starved of bitrate, however the ratio to the
    // median happens to round. Only the starved fault carries that number.
    expect(d.starvationFactor).toBeNull();
  });

  it("says nothing about an ordinary clip", () => {
    expect(diagnosePlayback(ORDINARY)).toBeNull();
  });

  it("leaves the file just above the line alone", () => {
    expect(bitsPerPixel(JUST_ABOVE_THE_LINE)! * MACROBLOCK_PIXELS).toBeGreaterThan(
      MIN_BITS_PER_MACROBLOCK,
    );
    expect(diagnosePlayback(JUST_ABOVE_THE_LINE)).toBeNull();
  });

  it("fires exactly at the wall, not one pixel early", () => {
    const at = { ...ORDINARY, width: HARDWARE_DECODER_MAX_EDGE, height: 1000, frames: 1 };
    expect(diagnosePlayback({ ...at, size: 50_000_000 })).toBeNull();
    expect(
      diagnosePlayback({ ...at, width: HARDWARE_DECODER_MAX_EDGE + 1, size: 50_000_000 })!.faults,
    ).toEqual(["oversized"]);
  });

  it("judges width by the longest edge, so a portrait capture counts", () => {
    const tall = { ...ORDINARY, width: 2160, height: 4320, size: 400_000_000, frames: 100 };
    expect(diagnosePlayback(tall)!.faults).toEqual(["oversized"]);
    expect(diagnosePlayback(tall)!.edge).toBe(4320);
  });

  it("fails closed on a row nobody has measured", () => {
    // Every imported video reads like this. Null means "nobody
    // measured", never "fine" and never "small", and a notice whose whole value
    // is that it is rare must never be raised on a guess.
    expect(diagnosePlayback({ mimeType: "video/mp4", ext: "mp4", size: 900 })).toBeNull();
    expect(
      diagnosePlayback({ mimeType: "video/mp4", ext: "mp4", size: 900, width: null, height: null }),
    ).toBeNull();
    // Dimensions but no frame total: the width rule can still answer, the
    // bitrate rule cannot, and the diagnosis says so rather than guessing.
    const noFrames = diagnosePlayback({
      mimeType: "video/mp4",
      ext: "mp4",
      size: 900,
      width: 5056,
      height: 1924,
    })!;
    expect(noFrames.faults).toEqual(["oversized"]);
    expect(noFrames.bitsPerPixel).toBeNull();
    expect(noFrames.starvationFactor).toBeNull();
  });

  it("is about video and nothing else", () => {
    const shape = { size: 400, width: 8000, height: 8000, frames: 1 };
    expect(diagnosePlayback({ ...shape, mimeType: "image/png", ext: "png" })).toBeNull();
    expect(diagnosePlayback({ ...shape, mimeType: "image/gif", ext: "gif" })).toBeNull();
    expect(diagnosePlayback({ ...shape, mimeType: "audio/mpeg", ext: "mp3" })).toBeNull();
    expect(diagnosePlayback({ ...shape, mimeType: "application/pdf", ext: "pdf" })).toBeNull();
  });

  it("recognises a video that ShareX on Windows typed as octet-stream", () => {
    // Round 7: the stored MIME is whatever the client sent, so the extension is
    // the evidence that matters on a great many production rows.
    const d = diagnosePlayback({ ...REPORTED, mimeType: "application/octet-stream" })!;
    expect(d.faults).toEqual(["oversized", "starved"]);
  });

  it("offers no repair for a starved file that is already small", () => {
    // Downscaling cannot put back detail the recorder never wrote, and the
    // webmp4 target is not even offered below WEB_MAX_EDGE - so the note has to
    // be able to say "there is nothing to press" rather than draw a button that
    // would hand back the same picture at the same size.
    const small: PlaybackSource = {
      mimeType: "video/mp4",
      ext: "mp4",
      size: 460_000,
      width: 1624,
      height: 916,
      frames: 480,
      durationSeconds: 16,
      fps: 30,
    };
    const d = diagnosePlayback(small)!;
    expect(d.faults).toEqual(["starved"]);
    expect(d.repairable).toBe(false);
  });

  it("agrees with needsWebRescue about when the repair exists", () => {
    // The button must never offer a conversion the route would refuse, so
    // `repairable` is that same test and not a rule of its own.
    for (const edge of [WEB_MAX_EDGE - 1, WEB_MAX_EDGE, WEB_MAX_EDGE + 1, 5056]) {
      const d = diagnosePlayback({
        mimeType: "video/mp4",
        ext: "mp4",
        size: 1000,
        width: edge,
        height: 400,
        frames: 500,
      });
      if (!d) continue;
      expect(d.repairable).toBe(edge > WEB_MAX_EDGE);
    }
  });
});
