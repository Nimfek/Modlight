import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `/{tag}/{code}/timeline.vtt` and `/{tag}/{code}/timeline.jpg`, through the
 * serving route.
 *
 * tests/unit/timeline-plan.test.ts proves the arithmetic. What is left, and what
 * this file is for, is the contract around it, and it is the same sentence the
 * motion tile's route test pins: WHEN THERE IS NO PREVIEW, THE CALLER IS TOLD.
 *
 * That matters more here than it looks. The player asks for the track on every
 * view of a video page, so a handler that answered "no timeline" by falling
 * through to `streamMedia` would hand a 400 MB recording to something that
 * wanted a two kilobyte text file, once per view. `streamMedia` being untouched
 * is therefore asserted on every path, not only on the refusals.
 *
 * The second thing pinned here is that neither half spends a view. Both are
 * fetched by the player while the page is loading or while a pointer moves over
 * the bar, and counting either would burn a one-time link before its recipient
 * had watched anything.
 */

const getMedia = vi.fn();
const isPrivilegedViewer = vi.fn();
const streamMedia = vi.fn();
const consumeView = vi.fn();
const timelineTrack = vi.fn();
const timelineSheet = vi.fn();

vi.mock("@/lib/media/serve", () => ({
  getMedia,
  isPrivilegedViewer,
  streamMedia,
  consumeView,
  // The real one, near enough: a published, ungated file gets a year and
  // `immutable`, which is exactly the promise the route has to walk back.
  cacheHeadersFor: (media: { published: boolean; passwordHash: string | null }) =>
    media.published && !media.passwordHash
      ? { ETag: '"abc"', "Cache-Control": "public, max-age=31536000, immutable" }
      : { "Cache-Control": "private, no-store", Vary: "Cookie" },
  codeFromMediaCode: (c: string) => c.split(".")[0],
}));

vi.mock("@/lib/media/timeline", () => ({ timelineTrack, timelineSheet }));
vi.mock("@/lib/media/motion", () => ({ motionPreview: vi.fn() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("@/lib/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) },
}));

const route = await import("@/app/[userCode]/[mediaCode]/[action]/route");
const { TIMELINE_SHEET_ACTION, TIMELINE_TRACK_ACTION } = await import(
  "@/lib/media/timeline-preview"
);

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
      convertedAt: null,
      frames: null,
      width: null,
      height: null,
      ...over,
    },
    ownerId: "owner-1",
  };
}

const call = (action: string) =>
  route.GET(new Request(`https://example.test/tag/abc123.mp4/${action}`), {
    params: Promise.resolve({ userCode: "tag", mediaCode: "abc123.mp4", action }),
  });

const VTT = "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\ntimeline.jpg#xywh=0,0,160,90\n";

beforeEach(() => {
  vi.clearAllMocks();
  getMedia.mockResolvedValue(videoRow());
  isPrivilegedViewer.mockResolvedValue(false);
  consumeView.mockResolvedValue(true);
  streamMedia.mockResolvedValue(new Response("THE WHOLE FILE", { status: 200 }));
  timelineTrack.mockResolvedValue({ ok: true, vtt: VTT });
  timelineSheet.mockResolvedValue({ ok: true, buffer: Buffer.from("JPEGISH") });
});

describe("the metadata track", () => {
  it("is served as WebVTT, and never as the file", async () => {
    const res = await call(TIMELINE_TRACK_ACTION);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/vtt; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe(VTT);
    expect(streamMedia).not.toHaveBeenCalled();
  });

  it("says why there is none, with a status a player can act on", async () => {
    timelineTrack.mockResolvedValue({ ok: false, refusal: "too-short" });

    const res = await call(TIMELINE_TRACK_ACTION);

    expect(res.status).toBe(415);
    expect(res.headers.get("x-timeline-refused")).toBe("too-short");
    // The whole point: a player that got the recording here would download it
    // to find out it has no preview.
    expect(streamMedia).not.toHaveBeenCalled();
    expect(await res.text()).not.toContain("THE WHOLE FILE");
    // A row can gain or lose the ability to produce one (a conversion in place,
    // an engine installed), so a refusal must not be cached anywhere.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("separates a file too large for the engine from one with no timeline", async () => {
    timelineTrack.mockResolvedValue({ ok: false, refusal: "too-large" });
    const res = await call(TIMELINE_TRACK_ACTION);
    expect(res.status).toBe(413);
    expect(res.headers.get("x-timeline-refused")).toBe("too-large");
    expect(streamMedia).not.toHaveBeenCalled();
  });

  it("does not spend a view, because a player loading a page is not a reader", async () => {
    await call(TIMELINE_TRACK_ACTION);
    expect(consumeView).not.toHaveBeenCalled();
  });
});

describe("the sprite sheet", () => {
  it("is served as one JPEG", async () => {
    const res = await call(TIMELINE_SHEET_ACTION);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("JPEGISH");
    expect(streamMedia).not.toHaveBeenCalled();
  });

  it("refuses rather than falling through, exactly like the track", async () => {
    timelineSheet.mockResolvedValue({ ok: false, refusal: "unreadable" });

    const res = await call(TIMELINE_SHEET_ACTION);

    expect(res.status).toBe(415);
    expect(res.headers.get("x-timeline-refused")).toBe("unreadable");
    expect(streamMedia).not.toHaveBeenCalled();
  });

  it("does not spend a view either", async () => {
    await call(TIMELINE_SHEET_ACTION);
    expect(consumeView).not.toHaveBeenCalled();
  });
});

describe("backpressure and cancellation", () => {
  it("answers a full limiter with 503 and a Retry-After, not with a refusal", async () => {
    const { BusyError } = await import("@/lib/media/transform-queue");
    timelineSheet.mockRejectedValue(new BusyError());

    const res = await call(TIMELINE_SHEET_ACTION);

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(streamMedia).not.toHaveBeenCalled();
  });

  it("passes a killed probe through as 503, not as 'this file has no preview'", async () => {
    // The Round 13 lesson, in its new home: a timeout is a fact about the
    // server, never about the bytes, and answering 415 would teach the player
    // to stop asking for a video that is perfectly fine.
    const { AvTimeoutError } = await import("@/lib/media/ffmpeg");
    timelineTrack.mockRejectedValue(new AvTimeoutError(10_000));

    const res = await call(TIMELINE_TRACK_ACTION);

    expect(res.status).toBe(503);
    expect(res.headers.get("x-timeline-refused")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("how long these may be cached", () => {
  it("promises a day rather than a year, because the two halves must agree", async () => {
    // `cacheHeadersFor` grants `immutable` for a year, which is right for the
    // file itself: it answers for itself. A VTT written by one version of the
    // planner and a sheet written by another do not, and a year is long enough
    // for a browser to hold one of each.
    for (const action of [TIMELINE_TRACK_ACTION, TIMELINE_SHEET_ACTION]) {
      const res = await call(action);
      expect(res.headers.get("cache-control")).toBe("public, max-age=86400, must-revalidate");
      expect(res.headers.get("cache-control")).not.toContain("immutable");
      expect(res.headers.get("etag")).toBe('"abc"');
    }
  });

  it("keeps a gated file out of every shared cache, as before", async () => {
    // Unpublished, viewed by its owner: reachable, and a derived copy of it must
    // still not enter a cache anyone else can read out of.
    getMedia.mockResolvedValue(videoRow({ published: false }));
    isPrivilegedViewer.mockResolvedValue(true);

    const res = await call(TIMELINE_TRACK_ACTION);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("the gates in front of both halves", () => {
  it("404s an unpublished file for anyone but its owner", async () => {
    getMedia.mockResolvedValue(videoRow({ published: false }));
    isPrivilegedViewer.mockResolvedValue(false);

    for (const action of [TIMELINE_TRACK_ACTION, TIMELINE_SHEET_ACTION]) {
      const res = await call(action);
      expect(res.status).toBe(404);
    }
    expect(timelineTrack).not.toHaveBeenCalled();
    expect(timelineSheet).not.toHaveBeenCalled();
  });

  it("401s a password-protected file before any work is done", async () => {
    getMedia.mockResolvedValue(videoRow({ passwordHash: "scrypt:whatever" }));

    for (const action of [TIMELINE_TRACK_ACTION, TIMELINE_SHEET_ACTION]) {
      const res = await call(action);
      expect(res.status).toBe(401);
    }
    // The preview is what an `<img>` and a `<track>` actually fetch, so leaving
    // it outside the gate would publish the contents of a locked file as a
    // hundred small pictures of it.
    expect(timelineTrack).not.toHaveBeenCalled();
    expect(timelineSheet).not.toHaveBeenCalled();
  });

  it("404s a file that is gone", async () => {
    getMedia.mockResolvedValue(null);
    expect((await call(TIMELINE_TRACK_ACTION)).status).toBe(404);
  });
});
