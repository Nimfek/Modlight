import { describe, expect, it } from "vitest";
import { downloadOptionsFor } from "@/lib/media/download-menu";
import {
  estimateConvertedSize,
  estimateTargetSize,
  estimateTotalSize,
  formatEstimate,
  roundSignificant,
} from "@/lib/media/convert-size";

const MB = 1024 * 1024;

function option(mime: string, ext: string, frames: number | null, to: string) {
  const found = downloadOptionsFor(mime, ext, frames, { canEncode: true }).find((o) => o.to === to);
  if (!found) throw new Error(`${mime} does not offer ${to}`);
  return found;
}

describe("what a conversion will weigh", () => {
  it("says a container copy exactly, because no encoder runs", () => {
    const estimate = estimateConvertedSize(
      { mimeType: "video/quicktime", ext: "mov", size: 19.3 * MB },
      option("video/quicktime", "mov", null, "mp4"),
    );
    expect(estimate).toEqual({ confidence: "exact", bytes: 19.3 * MB });
  });

  it("refuses to guess anything an encoder produces", () => {
    // Measured: the same 6 second clip came out anywhere from 226 kB to 15 MB.
    expect(
      estimateConvertedSize(
        { mimeType: "video/mp4", ext: "mp4", size: 40 * MB },
        option("video/mp4", "mp4", null, "gif"),
      ),
    ).toBeNull();
    // No duration column exists, so an audio extraction has nothing to scale by.
    expect(
      estimateConvertedSize(
        { mimeType: "video/mp4", ext: "mp4", size: 40 * MB },
        option("video/mp4", "mp4", null, "mp3"),
      ),
    ).toBeNull();
  });

  it("predicts a JPEG from its own size", () => {
    const src = { mimeType: "image/jpeg", ext: "jpg", size: 1000 * 1024, width: 1920, height: 1080 };
    const webp = estimateConvertedSize(src, option("image/jpeg", "jpg", 1, "webp"))!;
    expect(webp.confidence).toBe("approx");
    // 0.74x, rounded to two significant figures.
    expect(webp.bytes).toBeGreaterThan(0.6 * src.size);
    expect(webp.bytes).toBeLessThan(0.85 * src.size);

    const png = estimateConvertedSize(src, option("image/jpeg", "jpg", 1, "png"))!;
    expect(png.bytes).toBeGreaterThan(src.size * 5);
  });

  it("predicts a PNG from its PIXELS, never from its size", () => {
    const small = { mimeType: "image/png", ext: "png", size: 10 * 1024, width: 1920, height: 1080 };
    const large = { mimeType: "image/png", ext: "png", size: 5 * MB, width: 1920, height: 1080 };
    const a = estimateTargetSize(small, "webp");
    const b = estimateTargetSize(large, "webp");
    // A log-log fit over 24 production PNGs put the exponent on source size at
    // 0.00 to 0.09: two files of the same size in pixels predict the same result
    // however far apart their byte counts are.
    expect(a).toEqual(b);
    expect(a!.confidence).toBe("approx");
  });

  it("says nothing about a PNG whose dimensions were never recorded", () => {
    expect(
      estimateTargetSize({ mimeType: "image/png", ext: "png", size: 2 * MB }, "webp"),
    ).toBeNull();
  });

  it("says nothing about an animation that stays an animation", () => {
    // gif -> animated webp measured between 0.10x and 3.89x the source.
    expect(
      estimateTargetSize(
        { mimeType: "image/gif", ext: "gif", size: 2 * MB, width: 480, height: 270, frames: 40 },
        "webp",
      ),
    ).toBeNull();
    // ...but a single frame out of the same GIF is predictable.
    expect(
      estimateTargetSize(
        { mimeType: "image/gif", ext: "gif", size: 2 * MB, width: 480, height: 270, frames: 40 },
        "png",
      ),
    ).not.toBeNull();
  });

  it("keeps the unpredictable files visible in a total instead of inventing bytes", () => {
    const total = estimateTotalSize(
      [
        { mimeType: "image/png", ext: "png", size: 1 * MB, width: 1000, height: 1000 },
        { mimeType: "image/png", ext: "png", size: 1 * MB, width: 1000, height: 1000 },
        { mimeType: "image/png", ext: "png", size: 1 * MB },
      ],
      "webp",
    );
    expect(total.counted).toBe(2);
    expect(total.unknown).toBe(1);
    expect(total.bytes).toBeGreaterThan(0);
  });

  it("rounds to significant figures, because the rounding IS the error bar", () => {
    expect(roundSignificant(123_456, 1)).toBe(100_000);
    expect(roundSignificant(123_456, 2)).toBe(120_000);
    expect(roundSignificant(0, 1)).toBe(0);
    expect(roundSignificant(-5, 1)).toBe(0);
  });

  it("does not print a decimal that the rounding already removed", () => {
    expect(formatEstimate(100 * 1024)).toBe("100 KB");
    expect(formatEstimate(2.7 * MB)).toBe("2.7 MB");
  });
});
