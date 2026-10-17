import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { conversionBudget, convertImageBuffer, probeImage } from "@/lib/media/convert";

async function sampleImage(): Promise<Buffer> {
  return sharp({
    create: { width: 32, height: 24, channels: 3, background: { r: 120, g: 80, b: 200 } },
  })
    .png()
    .toBuffer();
}

const FRAMES = 4;
const FRAME_W = 16;
const FRAME_H = 12;

/** A real animated GIF: `FRAMES` pages, each a different colour. */
async function animatedGif(): Promise<Buffer> {
  const frames = await Promise.all(
    Array.from({ length: FRAMES }, (_, i) =>
      sharp({
        create: {
          width: FRAME_W,
          height: FRAME_H,
          channels: 3,
          background: { r: 40 + i * 50, g: 20, b: 200 - i * 40 },
        },
      })
        .png()
        .toBuffer(),
    ),
  );
  return sharp(frames, { join: { animated: true } }).gif({ delay: 100, loop: 0 }).toBuffer();
}

describe("convertImageBuffer", () => {
  it("converts to png/jpg/webp with correct mime + ext", async () => {
    const src = await sampleImage();
    const cases: Array<["png" | "jpg" | "webp", string, string]> = [
      ["png", "image/png", "png"],
      ["jpg", "image/jpeg", "jpg"],
      ["webp", "image/webp", "webp"],
    ];
    for (const [to, mime, ext] of cases) {
      const r = await convertImageBuffer(src, to);
      expect(r.mime).toBe(mime);
      expect(r.ext).toBe(ext);
      expect(r.buffer.length).toBeGreaterThan(0);
    }
  });

  it("wraps an image into a valid PDF", async () => {
    const src = await sampleImage();
    const r = await convertImageBuffer(src, "pdf");
    expect(r.mime).toBe("application/pdf");
    expect(r.ext).toBe("pdf");
    expect(r.buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("embeds the picture as DCTDecode, so pdf-lib never touches a pixel", async () => {
    // The property that matters, not an implementation detail: pdf-lib embeds a
    // PNG by decoding it with @pdf-lib/upng and re-deflating it with pako, both
    // synchronous JavaScript on the main thread. Measured at the 64 Mpx the old
    // budget allowed: 7.6 seconds with the event loop of the whole application
    // blocked solid, and 1433 MB of RSS. `embedJpg` passes the bytes through
    // untouched (0.96 s, 54 ms of block, 623 MB), and DCTDecode in the output is
    // how we know which path ran.
    const src = await sampleImage();
    const r = await convertImageBuffer(src, "pdf");
    const text = r.buffer.toString("latin1");
    expect(text).toContain("DCTDecode");
    expect(text).not.toContain("FlateDecode/Image");
  });

  it("does not block the event loop while building a PDF", async () => {
    // A 12 Mpx source is well inside the 40 Mpx the pdf target now allows.
    const big = await sharp({
      create: { width: 4000, height: 3000, channels: 3, background: { r: 30, g: 60, b: 90 } },
    })
      .png()
      .toBuffer();

    let worstGap = 0;
    let last = performance.now();
    const probe = setInterval(() => {
      const now = performance.now();
      worstGap = Math.max(worstGap, now - last - 5);
      last = now;
    }, 5);
    // The interval has to be running before the work starts, and measured after
    // it ends, or a synchronous block would simply not be sampled.
    await new Promise((r) => setImmediate(r));
    last = performance.now();
    await convertImageBuffer(big, "pdf");
    await new Promise((r) => setImmediate(r));
    clearInterval(probe);

    // Generous: the assertion is "hundreds of milliseconds, not seconds". The
    // old PNG path measured 1.0 s of block on this size and 7.6 s at the ceiling.
    expect(worstGap).toBeLessThan(600);
  });

  it("flattens transparency onto white rather than losing it to black", async () => {
    const transparent = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const r = await convertImageBuffer(transparent, "pdf");
    expect(r.buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

describe("animation survives the one conversion that promises to keep it", () => {
  it("re-encodes an animated GIF as an animated WebP with every frame", async () => {
    const src = await animatedGif();
    const probe = await probeImage(src);
    expect(probe?.animated).toBe(true);
    expect(probe?.pages).toBe(FRAMES);
    // The frame height, not the height of the stacked strip - that distinction
    // is what the pixel budget is counted in.
    expect(probe?.height).toBe(FRAME_H);

    const budget = conversionBudget(probe!, "webp");
    expect(budget).toMatchObject({ ok: true, animated: true });

    const out = await convertImageBuffer(probe!.input, "webp", { animated: true });
    const meta = await sharp(out.buffer, { animated: true }).metadata();
    expect(meta.pages).toBe(FRAMES);
    expect(meta.pageHeight).toBe(FRAME_H);
  });

  it("returns a single frame, not a sprite sheet, for the targets that cannot animate", async () => {
    // Passing `animated` to a still target is how a 135-frame GIF becomes a
    // 640x86400 PNG. The budget refuses to set the flag, and the converter
    // ignores it even if somebody does.
    const src = await animatedGif();
    const probe = await probeImage(src);
    expect(conversionBudget(probe!, "png")).toMatchObject({ ok: true, animated: false });

    const out = await convertImageBuffer(src, "png", { animated: true });
    const meta = await sharp(out.buffer).metadata();
    expect(meta.height).toBe(FRAME_H);
    expect(meta.pages ?? 1).toBe(1);
  });
});

describe("formats libvips will not open", () => {
  it("reports undecodable input instead of throwing from the encoder", async () => {
    // The route turns this null into a 415 the user can act on, rather than the
    // catch-all 500 a thrown encoder used to produce.
    expect(await probeImage(Buffer.from("not an image at all"))).toBeNull();
  });

  it("opens an AVIF whose major brand is a sequence brand", async () => {
    // libvips picks its loader from the major brand alone, so a file marked
    // `avis` is refused outright even though libheif can decode its cover image.
    // Production has exactly one such file, and it is the reason for this work.
    const still = await sharp({
      create: { width: 16, height: 16, channels: 3, background: { r: 10, g: 200, b: 90 } },
    })
      .avif({ quality: 40, effort: 0 })
      .toBuffer();

    const sequence = Buffer.from(still);
    expect(sequence.toString("latin1", 4, 8)).toBe("ftyp");
    sequence.write("avis", 8, 4, "latin1");

    await expect(sharp(sequence).metadata()).rejects.toThrow();

    const probe = await probeImage(sequence);
    expect(probe).not.toBeNull();
    expect(probe?.coverOnly).toBe(true);
    // ...and being cover-only means no target may claim to keep the animation.
    expect(conversionBudget(probe!, "webp")).toMatchObject({ ok: true, animated: false });

    const out = await convertImageBuffer(probe!.input, "png");
    expect((await sharp(out.buffer).metadata()).width).toBe(16);
  });
});
