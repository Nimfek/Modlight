import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `/{tag}/{code}/raw?motion=1`, through the serving route.
 *
 * tests/integration/motion.test.ts proves the engine produces something that
 * moves. What is left, and what this file is for, is the contract around it, and
 * it is one sentence: WHEN THERE IS NO MOVING TILE, THE CALLER IS TOLD.
 *
 * That is not pedantry. The client this exists for draws a grid of tiles from
 * `GET /api/uploads`, and a route that answered "no preview" by falling through
 * to `streamMedia` would answer a request for a 20 kB tile with a 400 MB video -
 * once per tile. It is the same failure the video poster's 415 was added to
 * prevent, which is why `streamMedia` being untouched is asserted every time
 * rather than only in the refusal case.
 *
 * The second thing pinned here is the other half of the surface: a caller that
 * does not pass `motion=1` must reach exactly the code it reached before.
 */

const getMedia = vi.fn();
const isPrivilegedViewer = vi.fn();
const streamMedia = vi.fn();
const consumeView = vi.fn();
const motionPreview = vi.fn();

vi.mock("@/lib/media/serve", () => ({
  getMedia,
  isPrivilegedViewer,
  streamMedia,
  consumeView,
  cacheHeadersFor: () => ({ "Cache-Control": "public, max-age=60" }),
  codeFromMediaCode: (c: string) => c.split(".")[0],
}));

vi.mock("@/lib/media/motion", () => ({ motionPreview }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("@/lib/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) },
}));

const route = await import("@/app/[userCode]/[mediaCode]/[action]/route");
const { MOTION_DEFAULT_SIZE } = await import("@/lib/media/motion-preview");

/** A published, ungated video row - the case a moving tile is wanted for. */
function videoRow(over: Record<string, unknown> = {}) {
  return {
    media: {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      code: "abc123",
      filename: "recording.mp4",
      ext: "mp4",
      mimeType: "video/mp4",
      size: 400_000_000,
      storageKey: "tag/abc123.mp4",
      published: true,
      passwordHash: null,
      passwordVersion: null,
      expiresAt: null,
      maxViews: null,
      checksum: null,
      frames: null,
      width: null,
      height: null,
      ...over,
    },
    ownerId: "owner-1",
  };
}

const call = (query: string) =>
  route.GET(new Request(`https://example.test/tag/abc123/raw${query}`), {
    params: Promise.resolve({ userCode: "tag", mediaCode: "abc123", action: "raw" }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  getMedia.mockResolvedValue(videoRow());
  isPrivilegedViewer.mockResolvedValue(false);
  consumeView.mockResolvedValue(true);
  streamMedia.mockResolvedValue(new Response("THE WHOLE FILE", { status: 200 }));
});

describe("asking for a tile that moves", () => {
  it("hands back the animated WebP, with the frame count read off the bytes", async () => {
    motionPreview.mockResolvedValue({ ok: true, buffer: Buffer.from("RIFF-ish"), frames: 8 });

    const res = await call("?w=480&h=480&motion=1");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("x-motion-frames")).toBe("8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(streamMedia).not.toHaveBeenCalled();
  });

  it("answers a refusal with a status and a reason, NEVER with the file", async () => {
    motionPreview.mockResolvedValue({ ok: false, refusal: "not-animated" });

    const res = await call("?w=480&h=480&motion=1");

    expect(res.status).toBe(415);
    expect(res.headers.get("x-motion-refused")).toBe("not-animated");
    // The whole point. A grid that got the file here would download the library.
    expect(streamMedia).not.toHaveBeenCalled();
    expect(await res.text()).not.toContain("THE WHOLE FILE");
    // A row can gain the ability to produce one (a backfill, a conversion in
    // place), so the refusal must not be cached anywhere.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("reports a file too large for the engine separately from one that cannot move", async () => {
    motionPreview.mockResolvedValue({ ok: false, refusal: "too-large" });
    const res = await call("?w=480&motion=1");
    expect(res.status).toBe(413);
    expect(res.headers.get("x-motion-refused")).toBe("too-large");
    expect(streamMedia).not.toHaveBeenCalled();
  });

  it("still bounds the size when the caller names none", async () => {
    motionPreview.mockResolvedValue({ ok: true, buffer: Buffer.from("x"), frames: 8 });

    await call("?motion=1");

    expect(motionPreview).toHaveBeenCalledTimes(1);
    expect(motionPreview.mock.calls[0][1]).toMatchObject({ width: MOTION_DEFAULT_SIZE });
    // `?motion=1` alone used to be a request with no resize parameter at all,
    // which is the shape that falls through to the original file.
    expect(streamMedia).not.toHaveBeenCalled();
  });

  it("does not spend a view, because a grid is not a reader", async () => {
    motionPreview.mockResolvedValue({ ok: true, buffer: Buffer.from("x"), frames: 8 });
    await call("?motion=1");
    expect(consumeView).not.toHaveBeenCalled();
  });

  it("refuses without touching the engine when the file is gated", async () => {
    getMedia.mockResolvedValue(videoRow({ published: false }));
    const res = await call("?w=480&motion=1");
    expect(res.status).toBe(404);
    expect(motionPreview).not.toHaveBeenCalled();
    expect(streamMedia).not.toHaveBeenCalled();
  });
});

describe("callers that do not ask", () => {
  it("reach exactly the path they reached before", async () => {
    const res = await call("");
    expect(motionPreview).not.toHaveBeenCalled();
    expect(streamMedia).toHaveBeenCalledTimes(1);
    expect(await res.text()).toBe("THE WHOLE FILE");
  });

  it("are not diverted by a value that merely mentions motion", async () => {
    const res = await call("?motion=true");
    expect(motionPreview).not.toHaveBeenCalled();
    expect(streamMedia).toHaveBeenCalledTimes(1);
    expect(await res.text()).toBe("THE WHOLE FILE");
  });
});
