import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharpLib from "sharp";

/**
 * The moving thumbnail, end to end, against real bytes.
 *
 * The one property worth this much setup is that the artefact REALLY MOVES.
 * Asking sharp how many pages it wrote would only confirm what it was told to
 * do, so every frame count here is walked out of the WebP container, and the
 * pixels of the first and last frame are compared - thirty identical frames is a
 * WebP that satisfies every count and animates nothing.
 *
 * The second property, and the one the shape was changed for, is that the count
 * is no longer eight. A preview holding eight frames of a long file is a
 * slideshow, so the counts below are asserted against MOTION_FRAMES rather than
 * against a literal, and against the budget that decided them.
 *
 * The driver is chosen from env at first use, hence the dynamic imports.
 */

let motion: typeof import("@/lib/media/motion");
let policy: typeof import("@/lib/media/motion-preview");
let ffmpeg: typeof import("@/lib/media/ffmpeg");
let root: string;
let hasFfmpeg = false;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "modlight-motion-"));
  process.env.STORAGE_DRIVER = "local";
  process.env.STORAGE_LOCAL_PATH = root;
  motion = await import("@/lib/media/motion");
  policy = await import("@/lib/media/motion-preview");
  ffmpeg = await import("@/lib/media/ffmpeg");
  hasFfmpeg = await ffmpeg.ffmpegAvailable();
}, 60_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A row shaped like `uploads.$inferSelect`, filled in only where it is read. */
function row(over: Record<string, unknown>) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    code: "abc123",
    published: true,
    passwordHash: null,
    expiresAt: null,
    maxViews: null,
    checksum: null,
    frames: null,
    width: null,
    height: null,
    ...over,
  } as unknown as Parameters<typeof motion.motionPreview>[0];
}

/** Frames that visibly differ, so a preview built from them has to move. */
async function animatedGif(frameCount: number, w = 160, h = 120): Promise<Buffer> {
  const frames: Buffer[] = [];
  for (let i = 0; i < frameCount; i++) {
    const raw = Buffer.alloc(w * h * 3);
    // A moving diagonal band: every frame differs from every other, and it
    // survives a downscale to a tile, which a per-pixel noise pattern would not.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const on = (x + y + i * 20) % 64 < 32;
        const p = (y * w + x) * 3;
        raw[p] = on ? 240 : 15;
        raw[p + 1] = on ? 40 : 200;
        raw[p + 2] = i * 7;
      }
    }
    frames.push(await sharpLib(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer());
  }
  return sharpLib(frames, { join: { across: 1, animated: true } })
    .gif({ delay: new Array(frameCount).fill(50), loop: 0 })
    .toBuffer();
}

async function store(name: string, body: Buffer): Promise<string> {
  await writeFile(join(root, name), body);
  return name;
}

/** Raw pixels of one page of an animated WebP, for comparing frame to frame. */
async function page(webp: Buffer, index: number): Promise<Buffer> {
  return sharpLib(webp, { animated: true, page: index, pages: 1 }).raw().toBuffer();
}

const opts = { width: 128, height: 128, fit: "cover" as const };

describe("a moving thumbnail of an animation", () => {
  it("produces an animated WebP whose frames really differ", async () => {
    const { MOTION_FRAMES, motionPageBudget } = await import("@/lib/media/transform-cost");
    const gif = await animatedGif(40);
    const media = row({ mimeType: "image/gif", ext: "gif", frames: 40, size: gif.length, storageKey: await store("anim.gif", gif) });

    const res = await motion.motionPreview(media, opts, new AbortController().signal);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Counted out of the container, not out of sharp's opinion of it.
    const counted = policy.countAnimatedWebpFrames(res.buffer);
    // Exactly what the budget said the run was worth - which is the whole clip,
    // because 160x120 across thirty pages is nowhere near the ceiling.
    expect(counted).toBe(motionPageBudget(160 * 120, 40).frames);
    expect(counted).toBe(MOTION_FRAMES);
    expect(res.frames).toBe(counted);
    // Independent second opinion: if the RIFF walk were wrong these would differ.
    expect((await sharpLib(res.buffer, { animated: true }).metadata()).pages).toBe(counted);

    // ...and it MOVES. Thirty copies of frame zero would pass every count above.
    const first = await page(res.buffer, 0);
    const last = await page(res.buffer, counted - 1);
    expect(Buffer.compare(first, last)).not.toBe(0);
    // Consecutive frames too: a run that repeated one page thirty times and then
    // changed once would pass the first-against-last check.
    expect(Buffer.compare(await page(res.buffer, 1), await page(res.buffer, 2))).not.toBe(0);

    // Still a tile rather than a download, at four times the frames.
    expect(res.buffer.length).toBeLessThan(500_000);
  }, 60_000);

  it("keeps a short animation whole rather than stretching it", async () => {
    const gif = await animatedGif(4);
    const media = row({ mimeType: "image/gif", ext: "gif", frames: 4, size: gif.length, storageKey: await store("short.gif", gif) });

    const res = await motion.motionPreview(media, opts, new AbortController().signal);
    expect(res.ok).toBe(true);
    if (res.ok) expect(policy.countAnimatedWebpFrames(res.buffer)).toBe(4);
  }, 60_000);

  it("serves the second request from cache, byte for byte", async () => {
    const gif = await animatedGif(12);
    const media = row({
      mimeType: "image/gif",
      ext: "gif",
      frames: 12,
      size: gif.length,
      // A checksum makes the row cacheable through the content-addressed key.
      checksum: "b".repeat(64),
      storageKey: await store("cached.gif", gif),
    });

    const cold = await motion.motionPreview(media, opts, new AbortController().signal);
    const warm = await motion.motionPreview(media, opts, new AbortController().signal);
    expect(cold.ok && warm.ok).toBe(true);
    if (!cold.ok || !warm.ok) return;
    expect(Buffer.compare(cold.buffer, warm.buffer)).toBe(0);
    // The frame count survives the cache round trip because it is re-read from
    // the bytes rather than remembered next to them.
    expect(warm.frames).toBe(cold.frames);
  }, 60_000);
});

describe("when there is no moving thumbnail to be had", () => {
  it("refuses a still picture instead of returning one frame", async () => {
    const png = await sharpLib({
      create: { width: 200, height: 150, channels: 3, background: { r: 10, g: 200, b: 90 } },
    })
      .png()
      .toBuffer();
    const media = row({ mimeType: "image/png", ext: "png", frames: 1, size: png.length, storageKey: await store("still.png", png) });

    const res = await motion.motionPreview(media, opts, new AbortController().signal);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.refusal).toBe("not-animated");
  }, 30_000);

  it("refuses an animation whose single frame is past the read ceiling", async () => {
    // The one shape the page budget still refuses outright rather than
    // shortening: a page too large to materialise at all. Building a 64 Mpx
    // animation for real would take minutes and gigabytes, so the arithmetic is
    // pinned here and the engine's use of it is pinned by construction - it is
    // the only gate between `probeImage` and the loader.
    const { motionPageBudget } = await import("@/lib/media/transform-cost");
    expect(motionPageBudget(9000 * 9000, 30).ok).toBe(false);
  });

  it("shortens a run it cannot afford whole, rather than refusing it", async () => {
    // 4000x3000 per page is inside the per-page ceiling, so a guard that looked
    // only at the picture would admit the full thirty-page run and decode
    // 360 Mpx of it.
    const { MOTION_FRAMES, maxMotionSourcePixels, motionPageBudget } = await import(
      "@/lib/media/transform-cost"
    );
    const verdict = motionPageBudget(4000 * 3000, 120);
    expect(verdict.ok).toBe(true);
    expect(verdict.frames).toBeLessThan(MOTION_FRAMES);
    expect(verdict.pixels).toBeLessThanOrEqual(maxMotionSourcePixels());
  });

  /**
   * Found on production: a 400 MB video whose eight samples were identical
   * enough that libwebp collapsed them into two pages. Nothing in the frame
   * counts catches a preview that holds still - only the finished container
   * does, which is why the check is on what was WRITTEN.
   */
  it("refuses an animation that never actually changes", async () => {
    const w = 120, h = 90;
    const raw = Buffer.alloc(w * h * 3, 90);
    const frame = await sharpLib(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
    const gif = await sharpLib(new Array(10).fill(frame), { join: { across: 1, animated: true } })
      .gif({ delay: new Array(10).fill(80), loop: 0 })
      .toBuffer();
    const media = row({ mimeType: "image/gif", ext: "gif", frames: 10, size: gif.length, storageKey: await store("frozen.gif", gif) });

    const res = await motion.motionPreview(media, opts, new AbortController().signal);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.refusal).toBe("not-animated");
  }, 60_000);

  it("refuses a file that is not media at all", async () => {
    const junk = Buffer.from("this is not a picture");
    const media = row({ mimeType: "application/octet-stream", ext: "bin", frames: null, size: junk.length, storageKey: await store("junk.bin", junk) });

    const res = await motion.motionPreview(media, opts, new AbortController().signal);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.refusal).toBe("not-animated");
  }, 30_000);

  it("refuses an animation larger than the read ceiling without reading it", async () => {
    const { MAX_TRANSFORM_BYTES } = await import("@/lib/media/transform-cost");
    const media = row({
      mimeType: "image/gif",
      ext: "gif",
      frames: 40,
      size: MAX_TRANSFORM_BYTES + 1,
      // Deliberately a key that does not exist: reaching storage at all would
      // throw, so a pass proves the size gate ran first.
      storageKey: "does-not-exist.gif",
    });

    const res = await motion.motionPreview(media, opts, new AbortController().signal);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.refusal).toBe("too-large");
  }, 30_000);
});

describe("a moving thumbnail of a video", () => {
  it("takes one contiguous clip in one ffmpeg invocation", async ({ skip }) => {
    if (!hasFfmpeg) skip();

    // A 20 s clip whose picture changes constantly, so identical frames would
    // mean the decode did not move.
    const src = join(root, "clip.mp4");
    await ffmpeg.runAvTool(
      "ffmpeg",
      [
        "-nostdin", "-hide_banner", "-v", "error",
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=20",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", src,
      ],
      { timeoutMs: 60_000 },
    );
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(src);

    const media = row({ mimeType: "video/mp4", ext: "mp4", frames: null, size: bytes.length, storageKey: "clip.mp4" });
    const started = Date.now();
    const res = await motion.motionPreview(media, opts, new AbortController().signal);
    const elapsed = Date.now() - started;

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const { MOTION_FRAMES } = await import("@/lib/media/transform-cost");
    const counted = policy.countAnimatedWebpFrames(res.buffer);
    // 320x240 at 25 fps is nowhere near the decode budget, so the clip is taken
    // at its full length: MOTION_FRAMES, not the eight this replaced.
    expect(counted).toBe(MOTION_FRAMES);
    expect(counted).toBeGreaterThan(8);
    expect((await sharpLib(res.buffer, { animated: true }).metadata()).pages).toBe(counted);

    // Consecutive frames of a moving test pattern cannot be identical. This is
    // the check that a contiguous clip has to pass and a spread does not: eight
    // frames from across a file differ trivially, thirty frames 83 ms apart only
    // differ if the decode really walked forward.
    expect(Buffer.compare(await page(res.buffer, 0), await page(res.buffer, 1))).not.toBe(0);
    expect(Buffer.compare(await page(res.buffer, 3), await page(res.buffer, 4))).not.toBe(0);
    expect(Buffer.compare(await page(res.buffer, 0), await page(res.buffer, counted - 1))).not.toBe(0);

    // One seek and a forward decode, not thirty seeks. Generous, because CI
    // machines are not fast.
    expect(elapsed).toBeLessThan(20_000);
  }, 120_000);

  it("does not open on the very first frame of the file", async ({ skip }) => {
    if (!hasFfmpeg) skip();

    // A file whose first second is black and whose content starts after it -
    // the shape that made a preview starting at frame zero useless. The tile
    // must not be black.
    const src = join(root, "fade.mp4");
    await ffmpeg.runAvTool(
      "ffmpeg",
      [
        "-nostdin", "-hide_banner", "-v", "error",
        "-f", "lavfi", "-i", "color=c=black:size=320x240:rate=25:duration=3",
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=12",
        "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", src,
      ],
      { timeoutMs: 60_000 },
    );
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(src);

    const media = row({ mimeType: "video/mp4", ext: "mp4", frames: null, size: bytes.length, storageKey: "fade.mp4" });
    const res = await motion.motionPreview(media, opts, new AbortController().signal);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // 15 s of video, so the clip starts a tenth of the way in - past the three
    // seconds of black. A run of identical black frames would have collapsed to
    // one page and been refused outright, so reaching here at all is the proof;
    // the pixels are checked anyway, because "not refused" is not "not black".
    const first = await page(res.buffer, 0);
    expect(first.some((v) => v > 24)).toBe(true);
  }, 120_000);
});
