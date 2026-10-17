import { describe, it, expect } from "vitest";
import {
  canConvert,
  convertOptionFor,
  convertTargetsFor,
  isConvertTarget,
  keepsAnimation,
  type ConvertOption,
} from "@/lib/media/convert-targets";
import { conversionBudget } from "@/lib/media/convert";
import { maxPixelsFor } from "@/lib/media/transform-cost";

const names = (options: ConvertOption[]) => options.map((o) => o.to);
const motionOf = (options: ConvertOption[], to: string) =>
  options.find((o) => o.to === to)?.motion;

describe("what a file can be converted into", () => {
  it("offers the still list for an ordinary image, with nothing to say about motion", () => {
    const options = convertTargetsFor("image/png", "png");
    expect(names(options)).toEqual(["pdf", "jpg", "webp", "avif"]);
    expect(options.every((o) => o.motion === null)).toBe(true);
  });

  it("never offers the format the file already is", () => {
    // "Download this PNG as PNG" spends a decode and an encode to hand back the
    // file the reader already has; for JPEG it hands back a worse one.
    for (const [mime, ext, self] of [
      ["image/png", "png", "png"],
      ["image/jpeg", "jpg", "jpg"],
      ["image/webp", "webp", "webp"],
      ["image/avif", "avif", "avif"],
      ["application/octet-stream", "avif", "avif"],
    ] as const) {
      expect(names(convertTargetsFor(mime, ext, 1)), `${mime}`).not.toContain(self);
    }
    // ...but a GIF still gets every one of them, because it is none of them.
    expect(names(convertTargetsFor("image/gif", "gif", 1))).toEqual([
      "pdf",
      "png",
      "jpg",
      "webp",
      "avif",
    ]);
  });

  it("offers nothing for video, audio and archives", () => {
    // Not because those cannot be converted - ffmpeg does them now - but
    // because they belong to av-targets.ts. A file must be claimed by exactly
    // one engine, or `downloadOptionsFor` would offer two meanings of `?to=png`
    // for the same file and the route would have to guess which was meant.
    expect(convertTargetsFor("video/mp4", "mp4")).toEqual([]);
    expect(convertTargetsFor("audio/mpeg", "mp3")).toEqual([]);
    expect(convertTargetsFor("application/zip", "zip")).toEqual([]);
    expect(canConvert("video/quicktime", "mov")).toBe(false);
  });

  it("offers nothing for the image formats libvips will not open in our build", () => {
    // The menu used to offer five targets for each of these and the route
    // answered 415 to all five, because the two asked different questions.
    // SVG would in fact rasterise; it stays out deliberately, because running a
    // full SVG engine over attacker markup is a bigger surface than a raster
    // decoder and we serve those bytes as inert text everywhere else.
    for (const [mime, ext] of [
      ["image/svg+xml", "svg"],
      ["image/heic", "heic"],
      ["image/heif", "heif"],
      ["image/jxl", "jxl"],
      ["image/vnd.adobe.photoshop", "psd"],
    ] as const) {
      expect(convertTargetsFor(mime, ext), `${mime}`).toEqual([]);
    }
  });

  it("keeps a GIF's animation in WebP and says so, and admits the rest are one frame", () => {
    const options = convertTargetsFor("image/gif", "gif", 60);
    expect(names(options)[0]).toBe("webp");
    expect(motionOf(options, "webp")).toBe("keeps");
    expect(motionOf(options, "png")).toBe("single");
    expect(motionOf(options, "jpg")).toBe("single");
    expect(motionOf(options, "pdf")).toBe("single");
  });

  it("offers AVIF for an animation too, as a still", () => {
    // It was withheld on the grounds that it "does not work", which was untrue:
    // production converts a GIF to AVIF fine (200, 11568 bytes, 144x256, one
    // frame). The real objection was cost, and cost is now a budget rather than
    // a missing menu entry.
    expect(motionOf(convertTargetsFor("image/gif", "gif", 60), "avif")).toBe("single");
    expect(maxPixelsFor("avif")).toBeLessThan(maxPixelsFor("png"));
  });

  it("never promises to keep the animation of an AVIF sequence", () => {
    // libheif hands libvips only the cover image, so those 43 frames are simply
    // not reachable - claiming otherwise would be the exact failure this whole
    // change is about. (The menu hands this file to ffmpeg instead, which does
    // reach them; see download-menu.ts.)
    expect(motionOf(convertTargetsFor("image/avif", "avif", 43), "webp")).toBe("single");
  });

  it("judges a row stored as octet-stream by what it actually is", () => {
    // The reported file: ShareX on Windows had no registry entry for .avif.
    const options = convertTargetsFor("application/octet-stream", "avif");
    expect(options.length).toBeGreaterThan(0);
    expect(names(options)).toContain("png");
    // ...while a genuinely unknown binary still offers nothing.
    expect(convertTargetsFor("application/octet-stream", "gr2")).toEqual([]);
  });

  it("describes THIS file, not what its container is capable of", () => {
    // A still WebP was told, under every target, that it would come back as "a
    // single frame" - a warning about losing an animation it never had, which is
    // what made a user report the whole menu as nonsense.
    const still = convertTargetsFor("image/webp", "webp", 1);
    expect(names(still)).toEqual(["pdf", "png", "jpg", "avif"]);
    expect(still.every((o) => o.motion === null)).toBe(true);

    const animated = convertTargetsFor("image/gif", "gif", 12);
    expect(motionOf(animated, "webp")).toBe("keeps");
    expect(motionOf(animated, "png")).toBe("single");

    // A row nobody has counted - every imported one - says "if", because it
    // knows neither that the file moves nor that it does not.
    const unknown = convertTargetsFor("image/avif", "avif", null);
    expect(unknown.every((o) => o.motion === "single-if-animated")).toBe(true);
    // ...and the format-based knowledge it does have is still used.
    expect(motionOf(convertTargetsFor("image/gif", "gif", null), "webp")).toBe("keeps");
  });

  it("agrees with the route about which targets exist", () => {
    for (const option of convertTargetsFor("image/gif", "gif")) {
      expect(isConvertTarget(option.to)).toBe(true);
    }
    expect(isConvertTarget("gif")).toBe(false);
    expect(isConvertTarget(null)).toBe(false);
    // "jpeg" was in the ConvertTarget union but never in the target list, so the
    // encoder's `case "jpeg"` was unreachable code pretending to be a format.
    expect(isConvertTarget("jpeg")).toBe(false);
    expect(keepsAnimation("webp")).toBe(true);
    expect(keepsAnimation("png")).toBe(false);
  });
});

describe("the route admits exactly what the menu shows", () => {
  const cases: Array<[string, string, number | null]> = [
    ["image/png", "png", null],
    ["image/gif", "gif", null],
    ["image/webp", "webp", 1],
    ["image/webp", "webp", 40],
    ["application/octet-stream", "avif", null],
    ["image/svg+xml", "svg", null],
    ["video/mp4", "mp4", null],
  ];

  it("accepts every offered target and refuses every unoffered one", () => {
    for (const [mime, ext, frames] of cases) {
      const offered = new Set<string>(names(convertTargetsFor(mime, ext, frames)));
      for (const to of ["pdf", "png", "jpg", "webp", "avif", "jpeg", "gif", "", "../etc"]) {
        const admitted = convertOptionFor(mime, ext, frames, to) !== null;
        expect(admitted, `${mime} (${ext}, frames=${frames}) -> ${to}`).toBe(offered.has(to));
      }
    }
  });

  it("refuses a target for a file that offers none at all", () => {
    expect(convertOptionFor("video/mp4", "mp4", null, "png")).toBeNull();
    expect(convertOptionFor("image/png", "png", null, null)).toBeNull();
  });
});

describe("the budget counts frames and charges by target", () => {
  // Measured on production: 1654x762 with 256 frames. The old guard looked at
  // one frame, saw 1.26 Mpx, and let a 322 Mpx job through a 64 Mpx limit.
  const bigGif = {
    animated: true,
    framePixels: 1654 * 762,
    totalPixels: 1654 * 762 * 256,
  };

  it("refuses an animated re-encode whose every frame is counted", () => {
    const verdict = conversionBudget(bigGif, "webp");
    expect(verdict.ok).toBe(false);
    expect(verdict.pixels).toBe(bigGif.totalPixels);
    expect(verdict.pixels).toBeGreaterThan(verdict.limit);
  });

  it("allows the same file as a single frame, because that is all it decodes", () => {
    const verdict = conversionBudget(bigGif, "png");
    expect(verdict.ok).toBe(true);
    expect(verdict.animated).toBe(false);
    expect(verdict.pixels).toBe(bigGif.framePixels);
  });

  it("still stops a decompression bomb on the still path", () => {
    const pixels = maxPixelsFor("png") + 1;
    expect(conversionBudget({ animated: false, framePixels: pixels, totalPixels: pixels }, "png").ok).toBe(
      false,
    );
  });

  it("passes an everyday animation through with the animated flag on", () => {
    const gif = { animated: true, framePixels: 358 * 640, totalPixels: 358 * 640 * 63 };
    const verdict = conversionBudget(gif, "webp");
    expect(verdict.ok).toBe(true);
    expect(verdict.animated).toBe(true);
    expect(verdict.pixels).toBe(gif.totalPixels);
  });

  it("lets a picture through as PNG that it refuses as AVIF", () => {
    // The point of the whole exercise: 30 Mpx of PNG is 180 MB and under three
    // seconds; the same 30 Mpx of AVIF would be 1.2 GB inside a 2 GiB container.
    const still = { animated: false, framePixels: 30_000_000, totalPixels: 30_000_000 };
    expect(conversionBudget(still, "png").ok).toBe(true);
    expect(conversionBudget(still, "avif").ok).toBe(false);
  });
});
