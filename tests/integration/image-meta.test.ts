import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { imageMetaFromBuffer, makeThumbnail } from "@/lib/media/image";

async function still(width = 24, height = 16): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } },
  })
    .png()
    .toBuffer();
}

/** A real animated GIF with `n` differently coloured pages. */
async function animatedGif(n: number): Promise<Buffer> {
  const frames = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      sharp({
        create: { width: 12, height: 10, channels: 3, background: { r: 20 + i * 30, g: 10, b: 200 } },
      })
        .png()
        .toBuffer(),
    ),
  );
  return sharp(frames, { join: { animated: true } }).gif({ delay: 80, loop: 0 }).toBuffer();
}

/** An AVIF whose MAJOR brand is the sequence brand libvips refuses on sight. */
async function avifSequenceBrand(): Promise<Buffer> {
  const avif = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 10, g: 200, b: 90 } },
  })
    .avif({ quality: 40, effort: 0 })
    .toBuffer();
  const patched = Buffer.from(avif);
  patched.write("avis", 8, 4, "latin1");
  return patched;
}

describe("image metadata", () => {
  it("counts frames, so the conversion menu can describe this file", async () => {
    expect((await imageMetaFromBuffer(await still())).frames).toBe(1);
    expect((await imageMetaFromBuffer(await animatedGif(5))).frames).toBe(5);
  });

  it("reports dimensions and a blurhash for an ordinary image", async () => {
    const meta = await imageMetaFromBuffer(await still(24, 16));
    expect(meta.width).toBe(24);
    expect(meta.height).toBe(16);
    expect(meta.blurhash).toBeTruthy();
  });

  it("returns nothing at all for something that is not an image", async () => {
    expect(await imageMetaFromBuffer(Buffer.from("not an image"))).toEqual({});
  });
});

describe("the AVIF sequence brand libvips refuses", () => {
  it("still gets dimensions, a frame count and a blurhash", async () => {
    // Production has exactly one such file. It converted perfectly (the convert
    // path carried the workaround) and yet had no preview, no width/height and
    // no placeholder, because this path opened the buffer with a plain sharp()
    // call that libvips rejects on the major brand alone.
    const seq = await avifSequenceBrand();
    await expect(sharp(seq).metadata()).rejects.toThrow();

    const meta = await imageMetaFromBuffer(seq);
    expect(meta.width).toBe(16);
    expect(meta.height).toBe(16);
    // Frame count is left UNKNOWN, not 1. Only the cover is reachable through
    // libvips, but the file itself holds a whole sequence - and since ffmpeg
    // arrived, something in this system can read it. Recording 1 would be a
    // measurement of our reader rather than of the file, and it would strike
    // the frame-reading conversions off the menu for the one file that needs
    // them most. NULL already means "unknown" on this column.
    expect(meta.frames).toBeUndefined();
    expect(meta.blurhash).toBeTruthy();
  });

  it("can be thumbnailed once the reader has been talked round", async () => {
    const seq = await avifSequenceBrand();
    // makeThumbnail takes the buffer probeImage handed back, which is the point:
    // the route probes first and passes `probe.input` on.
    const { withStillAvifBrand } = await import("@/lib/media/avif-brand");
    const readable = withStillAvifBrand(seq);
    expect(readable).not.toBeNull();

    const thumb = await makeThumbnail(readable!, { width: 8, fit: "inside" });
    expect((await sharp(thumb).metadata()).format).toBe("webp");
  });

  it("leaves a well-formed file alone", async () => {
    const { withStillAvifBrand } = await import("@/lib/media/avif-brand");
    expect(withStillAvifBrand(await still())).toBeNull();
    expect(withStillAvifBrand(Buffer.alloc(4))).toBeNull();
  });
});
