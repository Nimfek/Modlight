import { describe, it, expect } from "vitest";
import {
  BYTES_PER_UNIT,
  CONTAINER_MEMORY_BYTES,
  CONVERT_MEMORY_BYTES,
  CONVERT_WEIGHT,
  RESERVED_MEMORY_BYTES,
  TRANSFORM_CAPACITY,
  TRANSFORM_POOL_BYTES,
  maxPixelsFor,
  peakBytesFor,
} from "@/lib/media/transform-cost";
import { IMAGE_TARGETS } from "@/lib/media/convert-targets";

/**
 * The arithmetic these tests protect is the answer to "how much RAM does the
 * worst permitted request take, times how many of them can run at once, against
 * the container's real limit". Getting it wrong does not fail a request - it
 * kills the container, taking the database and whatever else the OOM killer
 * reaches with it.
 */
describe("the transform memory budget fits the container", () => {
  it("is sized against the limit the container actually has", () => {
    // `docker inspect modlight` -> HostConfig.Memory = 2147483648, which is what
    // docker-compose.prod.yml asks for with `mem_limit: 2g`.
    expect(CONTAINER_MEMORY_BYTES).toBe(2 * 1024 * 1024 * 1024);
    // The app's own anonymous memory measured 348 MB in production, with the
    // cgroup already having hit its ceiling 431 times on reclaimable page cache.
    expect(RESERVED_MEMORY_BYTES).toBeGreaterThanOrEqual(768 * 1024 * 1024);
    expect(TRANSFORM_POOL_BYTES).toBe(CONTAINER_MEMORY_BYTES - RESERVED_MEMORY_BYTES);
  });

  it("never lets the worst permitted case exceed the pool", () => {
    const slots = Math.floor(TRANSFORM_CAPACITY / CONVERT_WEIGHT);
    expect(slots).toBe(2);

    for (const to of IMAGE_TARGETS) {
      for (const animated of [false, true]) {
        const worst = peakBytesFor(to, animated, maxPixelsFor(to, animated));
        expect(worst, `${to}${animated ? " (animated)" : ""} in one slot`).toBeLessThanOrEqual(
          CONVERT_MEMORY_BYTES,
        );
        expect(
          worst * slots,
          `${to}${animated ? " (animated)" : ""} across ${slots} slots`,
        ).toBeLessThanOrEqual(TRANSFORM_POOL_BYTES);
      }
    }
  });

  it("keeps the whole container inside its limit at full load", () => {
    const worst = Math.max(
      ...IMAGE_TARGETS.map((to) => peakBytesFor(to, false, maxPixelsFor(to, false))),
    );
    const slots = Math.floor(TRANSFORM_CAPACITY / CONVERT_WEIGHT);
    // 348 MB measured baseline, and a slice for everything else the process does.
    const atFullLoad = worst * slots + RESERVED_MEMORY_BYTES;
    expect(atFullLoad).toBeLessThanOrEqual(CONTAINER_MEMORY_BYTES);
  });

  it("divides the pool by capacity, not by job count", () => {
    expect(BYTES_PER_UNIT * TRANSFORM_CAPACITY).toBeLessThanOrEqual(TRANSFORM_POOL_BYTES);
    expect(CONVERT_MEMORY_BYTES).toBe(BYTES_PER_UNIT * CONVERT_WEIGHT);
  });
});

describe("the budget charges by target, not by source alone", () => {
  it("gives the expensive encoders much less room than the cheap ones", () => {
    // Measured bytes of peak RSS per source pixel: png 3.5, webp 24.2, avif 34.9.
    // A single ceiling for all of them is what let a 36 Mpx AVIF request ask for
    // 1.4 GB inside a 2 GiB container.
    expect(maxPixelsFor("png")).toBeGreaterThan(maxPixelsFor("webp"));
    expect(maxPixelsFor("webp")).toBeGreaterThan(maxPixelsFor("avif"));
    expect(maxPixelsFor("jpg")).toBeGreaterThan(maxPixelsFor("pdf"));
  });

  it("still allows an everyday picture through every target", () => {
    // 4000x3000 is a phone photo and a 4K screenshot is 8.3 Mpx; both have to
    // work, or the budget has broken the feature instead of protecting it.
    for (const to of IMAGE_TARGETS) {
      expect(maxPixelsFor(to), to).toBeGreaterThanOrEqual(12_000_000);
    }
  });

  it("gives an animated re-encode more pixels than a still one, because it streams", () => {
    // libvips feeds the WebP muxer a page at a time (measured: 1.42 B per source
    // pixel over 28.8 Mpx), so an animation is bound by the clock, not by RAM.
    expect(maxPixelsFor("webp", true)).toBeGreaterThan(maxPixelsFor("webp", false));
  });

  it("refuses the production GIF that started this", () => {
    // 1654x762 with 256 frames = 322 Mpx of decoding, which read as 1.26 Mpx
    // while only one frame was being counted.
    expect(1654 * 762 * 256).toBeGreaterThan(maxPixelsFor("webp", true));
  });
});

/**
 * The sprite-sheet budget, which is a memory ceiling on ONE FRAME rather than on
 * a whole picture the way the conversion targets are.
 *
 * The shape it guards is one ffmpeg pass with `-discard nokey`, which holds a
 * decoded frame and a few filter copies of it while it walks the file. What that
 * costs was measured over ffmpeg's own baseline in the production image: 38 B
 * per frame pixel at 720p, 39 B at 1080p, 27 B at 4K - the rate falls as the
 * picture grows, because a decoder's fixed structures stop dominating.
 */
describe("the timeline sheet's ceiling", () => {
  it("is a conversion slot's share of memory, at the measured rate", async () => {
    const { TIMELINE_BYTES_PER_FRAME_PIXEL, maxTimelineFramePixels } = await import(
      "@/lib/media/transform-cost"
    );
    expect(maxTimelineFramePixels() * TIMELINE_BYTES_PER_FRAME_PIXEL).toBeLessThanOrEqual(
      CONVERT_MEMORY_BYTES,
    );
  });

  it("allows 4K, which is what people actually record, and refuses 8K", async () => {
    const { maxTimelineFramePixels } = await import("@/lib/media/transform-cost");
    // Measured on the production 3840x2160 .mov: 260 MB peak, inside the slot.
    expect(3840 * 2160).toBeLessThanOrEqual(maxTimelineFramePixels());
    expect(5120 * 2880).toBeLessThanOrEqual(maxTimelineFramePixels());
    // 8K would want about a gigabyte inside a 2 GiB container that is also
    // serving the site, and two of them may run at once.
    expect(7680 * 4320).toBeGreaterThan(maxTimelineFramePixels());
  });

  it("takes a conversion's weight, not a thumbnail's", async () => {
    const { TIMELINE_WEIGHT, TIMELINE_TRACK_WEIGHT, TIMELINE_TIMEOUT_MS, TIMELINE_TRACK_TIMEOUT_MS } =
      await import("@/lib/media/transform-cost");
    // The worst job measured is 4.0 s of ffmpeg on a two core box. At a
    // thumbnail's weight four of those could run at once.
    expect(TIMELINE_WEIGHT).toBe(CONVERT_WEIGHT);
    // ...while the track is a probe, and must not queue behind the sheets.
    expect(TIMELINE_TRACK_WEIGHT).toBeLessThan(TIMELINE_WEIGHT);
    expect(TIMELINE_TRACK_TIMEOUT_MS).toBeLessThan(TIMELINE_TIMEOUT_MS);
  });
});
