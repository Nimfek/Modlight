import { describe, it, expect } from "vitest";
import { randomFillSync } from "node:crypto";
import sharp from "sharp";
import { encodeAvatar } from "@/lib/media/avatar";
import { AVATAR_MAX_FRAMES, AVATAR_MAX_OUTPUT_BYTES, AVATAR_SIZE } from "@/lib/avatar";

/**
 * The encoder against real libvips, because the two claims that matter cannot be
 * made by a mock: that an animated GIF comes out still animated, and that the
 * budgets turn an abusive one into something a browser can hold.
 *
 * The animation claim in particular is worth a real encode. `sharp(buf)` reads
 * page zero and nothing else unless it is opened with `{ animated: true }`, so
 * the difference between a working feature and a frozen one is a single option
 * that no type checks and no unit test with a stubbed sharp would notice.
 */

/** A real animated GIF with `n` differently coloured pages. */
async function animatedGif(n: number, w = 60, h = 40): Promise<Buffer> {
  const frames = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      sharp({
        create: {
          width: w,
          height: h,
          channels: 3,
          background: { r: (20 + i * 7) % 256, g: (10 + i * 13) % 256, b: 200 },
        },
      })
        .png()
        .toBuffer(),
    ),
  );
  return sharp(frames, { join: { animated: true } }).gif({ delay: 80, loop: 0 }).toBuffer();
}

/** Incompressible frames, so an animated encode cannot come out tiny. */
async function noisyGif(n: number, edge = 300): Promise<Buffer> {
  const frames = await Promise.all(
    Array.from({ length: n }, async () => {
      const raw = randomFillSync(Buffer.allocUnsafe(edge * edge * 3));
      return sharp(raw, { raw: { width: edge, height: edge, channels: 3 } }).png().toBuffer();
    }),
  );
  return sharp(frames, { join: { animated: true } }).gif({ delay: 60, loop: 0 }).toBuffer();
}

/** Pages in a buffer, counted the way a browser would see them. */
async function pagesOf(buf: Buffer): Promise<number> {
  const meta = await sharp(buf, { animated: true }).metadata();
  return meta.pages && meta.pages > 0 ? meta.pages : 1;
}

describe("encodeAvatar", () => {
  it("keeps a GIF animated, frame for frame", async () => {
    const source = await animatedGif(6);
    expect(await pagesOf(source)).toBe(6);

    const result = await encodeAvatar(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.animated).toBe(true);
    expect(result.frames).toBe(6);
    // The claim, measured on the bytes rather than on our own bookkeeping.
    expect(await pagesOf(result.bytes)).toBe(6);

    const meta = await sharp(result.bytes, { animated: true }).metadata();
    expect(meta.format).toBe("webp");
    // Square, and never larger than the stored edge.
    expect(meta.width).toBeLessThanOrEqual(AVATAR_SIZE);
    expect(meta.width).toBe(meta.pageHeight);
  });

  it("produces a square that is small enough to sit on every page", async () => {
    const source = await sharp({
      create: { width: 1600, height: 1200, channels: 3, background: { r: 10, g: 120, b: 200 } },
    })
      .jpeg()
      .toBuffer();

    const result = await encodeAvatar(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const meta = await sharp(result.bytes).metadata();
    expect(meta.width).toBe(AVATAR_SIZE);
    expect(meta.height).toBe(AVATAR_SIZE);
    expect(result.animated).toBe(false);
    expect(result.degraded).toBeNull();
    expect(result.bytes.byteLength).toBeLessThan(AVATAR_MAX_OUTPUT_BYTES);
  });

  it("never upscales a source smaller than the stored edge", async () => {
    const source = await sharp({
      create: { width: 48, height: 48, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();

    const result = await encodeAvatar(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await sharp(result.bytes).metadata()).width).toBe(48);
  });

  it("strips EXIF, so a photograph does not publish where it was taken", async () => {
    const source = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 90, g: 90, b: 90 } },
    })
      .withExif({ IFD0: { Copyright: "somebody", Software: "a camera" } })
      .jpeg()
      .toBuffer();
    expect((await sharp(source).metadata()).exif).toBeTruthy();

    const result = await encodeAvatar(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await sharp(result.bytes).metadata()).exif).toBeUndefined();
  });

  it("saves a sequence past the frame cap as a still, and says which cap it was", async () => {
    // Tiny frames on purpose: the pixel budget is nowhere near, so only the
    // count can be what refused this. The owner still gets an avatar.
    const source = await animatedGif(AVATAR_MAX_FRAMES + 1, 8, 8);
    const result = await encodeAvatar(source);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.animated).toBe(false);
    expect(result.frames).toBe(1);
    expect(result.degraded).toBe("frames");
    expect(await pagesOf(result.bytes)).toBe(1);
  });

  it("falls back to a still when the animation encodes too heavy to serve", async () => {
    // Inside every pixel and frame budget, and still fat: 40 frames of noise
    // clear the ceilings and produce far more than half a megabyte of WebP. The
    // frame budget bounds the ENCODE; this is the guard on the RESULT, which is
    // the only number the viewer feels.
    const source = await noisyGif(40, 280);
    const result = await encodeAvatar(source);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bytes.byteLength).toBeLessThanOrEqual(AVATAR_MAX_OUTPUT_BYTES);
    expect(result.animated).toBe(false);
    expect(result.degraded).toBe("output-size");
  }, 60_000);

  it("answers 'not an image' rather than throwing", async () => {
    expect(await encodeAvatar(Buffer.from("this is not an image"))).toEqual({
      ok: false,
      error: "decode",
    });
  });
});
