import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The two promises `/api/link-info` makes, exercised through the route handler.
 *
 *   1. It consumes nothing.
 *   2. It is not an oracle.
 *
 * Both are the kind of promise that is easy to keep on the day it is written and
 * easy to break with one convenient-looking edit later - "just reuse
 * `redirectShortLink`", "just hand back the row" - so both are pinned here
 * rather than described in a comment and hoped for.
 *
 * The leak tests deliberately assert on the RAW RESPONSE TEXT rather than on
 * parsed fields. A gated file must not leak its name from anywhere in the body,
 * including a URL, a note or a field somebody adds next month, and only a scan
 * of the whole payload can say that.
 */

const getMedia = vi.fn();
const consumeView = vi.fn();
const isPrivilegedViewer = vi.fn();
const streamMedia = vi.fn();
const cacheHeadersFor = vi.fn();
const resolveTaglessOwnerTag = vi.fn();
const resolveApiCaller = vi.fn();
const dbUpdate = vi.fn();

let shortRows: Record<string, unknown>[] = [];

vi.mock("@/lib/media/serve", () => ({
  getMedia,
  consumeView,
  isPrivilegedViewer,
  streamMedia,
  cacheHeadersFor,
  codeFromMediaCode: (c: string) => c.split(".")[0],
}));

vi.mock("@/lib/data/user-prefs", () => ({ resolveTaglessOwnerTag }));
vi.mock("@/lib/api-caller", () => ({ resolveApiCaller }));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => shortRows }) }) }),
    update: dbUpdate,
  },
}));

const route = await import("@/app/api/link-info/route");
const { config } = await import("@/lib/config");

const BASE = config.appUrl;

/** A published, ungated PNG - the case the endpoint exists to answer well. */
function row(over: Record<string, unknown> = {}) {
  return {
    media: {
      id: "11111111-1111-4111-8111-111111111111",
      ownerId: "owner-1",
      code: "romuz3",
      filename: "Screenshot_example.png",
      ext: "png",
      kind: "file",
      language: null,
      mimeType: "image/png",
      size: 9901,
      storageKey: "alicja/romuz3.png",
      checksum: "e057ed0af8c0ffee",
      width: 428,
      height: 147,
      frames: null,
      blurhash: "LKO2",
      thumbKey: null,
      published: true,
      deleteToken: "TOKEN-THAT-DESTROYS-THE-FILE",
      views: 4,
      downloads: 4,
      lastAccessedAt: null,
      expiresAt: null,
      maxViews: null,
      passwordHash: null,
      passwordVersion: null,
      convertedAt: null,
      originalExt: null,
      folderId: null,
      deletedAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      ...over,
    },
    ownerUserCode: "alicja",
    ownerId: "owner-1",
    ownerTheme: "modern",
    ownerBackground: null,
    ownerPreferredDomain: null,
  };
}

/**
 * A gated file whose every fact is a distinctive string, so "did anything leak"
 * is a substring search rather than a field-by-field review.
 */
const SECRET = {
  filename: "raport-finansowy-2026-Q3.xlsx",
  ext: "xlsx",
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  size: 8675309,
  width: 4321,
  height: 8765,
  passwordHash: "scrypt$whatever",
  passwordVersion: null,
};

async function call(url: string) {
  const req = new Request(`${BASE}/api/link-info?url=${encodeURIComponent(url)}`);
  const res = await route.GET(req);
  const text = await res.text();
  return { res, text, body: JSON.parse(text) };
}

beforeEach(() => {
  vi.clearAllMocks();
  shortRows = [];
  // `link-info` has an anonymous mode: a refusal (no credential, a bad one, or
  // one scoped away from reading) is answered as a stranger would be.
  resolveApiCaller.mockResolvedValue({ ok: false, status: 401, body: {} });
  resolveTaglessOwnerTag.mockResolvedValue(null);
  cacheHeadersFor.mockReturnValue({
    ETag: '"FROM-CACHE-HEADERS"',
    "Cache-Control": "public, max-age=31536000, immutable",
  });
});

// ---------------------------------------------------------------------------
// 1. It consumes nothing
// ---------------------------------------------------------------------------

describe("it consumes nothing", () => {
  it("never counts a view, on any shape", async () => {
    getMedia.mockResolvedValue(row());
    for (const url of [
      `${BASE}/alicja/romuz3.png`,
      `${BASE}/alicja/romuz3/raw.png`,
      `${BASE}/alicja/romuz3/download`,
      `${BASE}/alicja/romuz3/convert`,
    ]) {
      await call(url);
    }
    expect(consumeView).not.toHaveBeenCalled();
  });

  it("never reads the cookie jar to decide who is asking", async () => {
    getMedia.mockResolvedValue(row());
    await call(`${BASE}/alicja/romuz3.png`);
    // isPrivilegedViewer resolves the session through next/headers AND honours
    // the unlock cookie. Both are side channels this endpoint must not open, so
    // the caller is resolved with resolveApiCaller instead.
    expect(isPrivilegedViewer).not.toHaveBeenCalled();
    expect(resolveApiCaller).toHaveBeenCalled();
  });

  it("never streams bytes to answer a metadata question", async () => {
    getMedia.mockResolvedValue(row({ size: 2_000_000_000 }));
    const { body } = await call(`${BASE}/alicja/romuz3/raw.png`);
    expect(streamMedia).not.toHaveBeenCalled();
    // The size still comes back, from the row, which is the whole point: a model
    // can decide not to pull two gigabytes.
    expect(body.file.size).toBe(2_000_000_000);
  });

  it("resolves a short link without counting a click", async () => {
    shortRows = [
      {
        id: "s1",
        ownerId: "owner-1",
        code: "promo",
        target: "https://example.com/landing",
        passwordHash: null,
        clicks: 17,
        lastUsedAt: null,
        expiresAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ];
    const { body } = await call(`${BASE}/s/promo`);
    expect(body.status).toBe("public");
    expect(body.target).toBe("https://example.com/landing");
    // redirectShortLink increments clicks and stamps last_used_at as a side
    // effect of answering. Describing a link with it would inflate the owner's
    // own statistics every single time.
    expect(dbUpdate).not.toHaveBeenCalled();
    // Nor does it leak the owner's counter to a stranger.
    expect(body.owner).toBeUndefined();
  });

  it("does not call any of the admitting helpers, by source inspection", () => {
    const path = join(process.cwd(), "app", "api", "link-info", "route.ts");
    const source = readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    for (const helper of [
      "consumeView",
      "isMediaUnlocked",
      "streamMedia",
      "redirectShortLink",
      "isPrivilegedViewer",
      "admit",
    ]) {
      expect(new RegExp(`\\b${helper}\\s*\\(`).test(source)).toBe(false);
    }
    // The unlock cookie is minted and verified in lib/password. Not importing it
    // is what makes "no cookie honoured, none issued" structural.
    expect(source).not.toContain('from "@/lib/password"');
  });
});

// ---------------------------------------------------------------------------
// 2. It is not an oracle
// ---------------------------------------------------------------------------

describe("missing, gone and unlisted are one answer", () => {
  it("answers a code that does not exist and an unpublished file identically", async () => {
    getMedia.mockResolvedValue(null);
    const missing = await call(`${BASE}/alicja/nosuchcode`);

    getMedia.mockResolvedValue(row({ published: false }));
    const unlisted = await call(`${BASE}/alicja/romuz3.png`);

    expect(missing.res.status).toBe(404);
    expect(unlisted.res.status).toBe(404);
    // Byte for byte, minus the URL the caller already knows they sent.
    const strip = (t: string) => t.replace(/"input":[^\n]*\n/, "");
    expect(strip(unlisted.text)).toBe(strip(missing.text));
    expect(unlisted.text).not.toContain("Modlight_U5VHmsivm7");
  });

  it("says nothing about which of expired, spent or trashed applies", async () => {
    // getMedia already collapses all of them to null. This endpoint must not be
    // the one surface that pulls them apart again.
    getMedia.mockResolvedValue(null);
    const { body } = await call(`${BASE}/alicja/romuz3.png`);
    expect(body.reason).toBe("not-found");
    expect(body.message).toMatch(/unlisted, expired or spent/);
  });
});

describe("a password gated file gives up nothing", () => {
  it("leaks no name, type, size or dimensions anywhere in the payload", async () => {
    getMedia.mockResolvedValue(row(SECRET));
    const { res, text, body } = await call(`${BASE}/alicja/romuz3.png`);

    expect(res.status).toBe(200);
    expect(body.status).toBe("password-required");
    expect(body.file).toBeNull();

    for (const secret of [
      "raport-finansowy",
      "xlsx",
      "spreadsheetml",
      "8675309",
      "4321",
      "8765",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("builds its URLs without the extension, because the extension is a fact too", async () => {
    getMedia.mockResolvedValue(row(SECRET));
    const { body } = await call(`${BASE}/alicja/romuz3.png`);
    // The extension is decorative, so dropping it costs nothing and the links
    // still work. The preview page withholds it the same way: a gated file gets
    // no canonical and no og:title at all.
    expect(body.normalizedUrl).toBe(`${BASE}/alicja/romuz3`);
    expect(body.bytes.url).toBe(`${BASE}/alicja/romuz3/raw`);
    expect(body.bytes.anonymous).toBe(false);
  });

  it("tells the owner everything about their own gated file", async () => {
    getMedia.mockResolvedValue(row(SECRET));
    resolveApiCaller.mockResolvedValue({ ok: true, caller: { id: "owner-1", role: "user" }, scope: null });
    const { body } = await call(`${BASE}/alicja/romuz3.png`);

    expect(body.privileged).toBe(true);
    expect(body.status).toBe("password-required");
    expect(body.file.filename).toBe(SECRET.filename);
    expect(body.owner.hasPassword).toBe(true);
  });

  it("does not let one account read another account's row", async () => {
    getMedia.mockResolvedValue(row({ published: false }));
    resolveApiCaller.mockResolvedValue({ ok: true, caller: { id: "someone-else", role: "user" }, scope: null });
    const { res } = await call(`${BASE}/alicja/romuz3.png`);
    expect(res.status).toBe(404);
  });

  it("lets an admin read it, the same rule the serving layer applies", async () => {
    getMedia.mockResolvedValue(row({ published: false }));
    resolveApiCaller.mockResolvedValue({ ok: true, caller: { id: "someone-else", role: "admin" }, scope: null });
    const { body } = await call(`${BASE}/alicja/romuz3.png`);
    expect(body.status).toBe("unlisted");
    expect(body.privileged).toBe(true);
  });
});

describe("what an anonymous caller learns about a public file", () => {
  it("is exactly what a HEAD on the raw URL would have told them", async () => {
    getMedia.mockResolvedValue(row());
    const { body } = await call(`${BASE}/alicja/romuz3.png`);

    expect(body.file).toMatchObject({
      filename: "Screenshot_example.png",
      type: "image/png",
      servedType: "image/png",
      kind: "image",
      size: 9901,
      width: 428,
      height: 147,
    });
    expect(body.links.raw).toBe(`${BASE}/alicja/romuz3/raw.png`);
    expect(body.bytes.anonymous).toBe(true);
    expect(body.notes.join(" ")).toContain("decorative");
  });

  it("publishes the checksum exactly when the serving layer publishes an ETag", async () => {
    getMedia.mockResolvedValue(row());
    const open = await call(`${BASE}/alicja/romuz3.png`);
    // Read out of cacheHeadersFor, not re-derived: that is what keeps the two
    // surfaces from disagreeing about which files are public.
    expect(open.body.file.checksum).toBe("FROM-CACHE-HEADERS");
    expect(open.body.bytes.cacheable).toBe(true);

    cacheHeadersFor.mockReturnValue({ "Cache-Control": "private, no-store", Vary: "Cookie" });
    const closed = await call(`${BASE}/alicja/romuz3.png`);
    expect(closed.body.file.checksum).toBeNull();
    expect(closed.body.bytes.cacheable).toBe(false);
    expect(closed.body.notes.join(" ")).toMatch(/time limited or view limited/);
  });

  it("never reveals the expiry, the view cap or the folder", async () => {
    getMedia.mockResolvedValue(
      row({ expiresAt: new Date("2030-01-01T00:00:00.000Z"), maxViews: 1, folderId: "folder-9" }),
    );
    cacheHeadersFor.mockReturnValue({ "Cache-Control": "private, no-store", Vary: "Cookie" });
    const { text, body } = await call(`${BASE}/alicja/romuz3.png`);

    expect(body.owner).toBeUndefined();
    expect(text).not.toContain("2030-01-01");
    expect(text).not.toContain("folder-9");
    expect(text).not.toContain("maxViews");
  });

  it("never hands out the deletion token or the storage key", async () => {
    getMedia.mockResolvedValue(row());
    resolveApiCaller.mockResolvedValue({ ok: true, caller: { id: "owner-1", role: "user" }, scope: null });
    const { text } = await call(`${BASE}/alicja/romuz3.png`);
    // Even to the owner. One is a live capability that destroys the file with a
    // single POST; the other is an internal path a client cannot use.
    expect(text).not.toContain("TOKEN-THAT-DESTROYS-THE-FILE");
    expect(text).not.toContain("storageKey");
  });
});

describe("what the owner learns", () => {
  it("gets the counters, the gates and the id the write endpoints take", async () => {
    getMedia.mockResolvedValue(row({ maxViews: 3, expiresAt: new Date("2030-01-01T00:00:00.000Z") }));
    resolveApiCaller.mockResolvedValue({ ok: true, caller: { id: "owner-1", role: "user" }, scope: null });
    const { body } = await call(`${BASE}/alicja/romuz3.png`);

    expect(body.owner).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      views: 4,
      downloads: 4,
      maxViews: 3,
      hasPassword: false,
    });
    expect(body.owner.expiresAt).toContain("2030-01-01");
  });
});

// ---------------------------------------------------------------------------
// Refusals and next steps
// ---------------------------------------------------------------------------

describe("refusals are clear, never a 500", () => {
  it("describes itself when called with no url", async () => {
    const res = await route.GET(new Request(`${BASE}/api/link-info`));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toBe("missing-url");
    expect(body.endpoint.path).toBe("/api/link-info");
    expect(body.guarantees.join(" ")).toContain("never burns a one-time link");
  });

  it("refuses a foreign host without touching the database", async () => {
    const { res, body } = await call("https://evil.example.com/alicja/romuz3.png");
    expect(res.status).toBe(400);
    expect(body.reason).toBe("foreign-host");
    expect(getMedia).not.toHaveBeenCalled();
  });

  it("refuses a deletion link without touching the database", async () => {
    const { res, body } = await call(`${BASE}/alicja/romuz3/delete/sometoken`);
    expect(res.status).toBe(400);
    expect(body.reason).toBe("capability-url");
    expect(getMedia).not.toHaveBeenCalled();
  });

  it("describes a page of the application as a page, not as a missing file", async () => {
    const { res, body } = await call(`${BASE}/login`);
    expect(res.status).toBe(200);
    expect(body.kind).toBe("app-route");
    expect(getMedia).not.toHaveBeenCalled();
  });
});

describe("telling the caller what to do next", () => {
  it("points a preview URL at the bytes and says the page is HTML", async () => {
    getMedia.mockResolvedValue(row());
    const { body } = await call(`${BASE}/alicja/romuz3.png`);
    expect(body.requestShape).toBe("preview");
    expect(body.notes.join(" ")).toContain("returns HTML");
    expect(body.bytes.url).toBe(`${BASE}/alicja/romuz3/raw.png`);
  });

  it("offers a thumbnail URL only when one would really be produced", async () => {
    getMedia.mockResolvedValue(row());
    const small = await call(`${BASE}/alicja/romuz3.png`);
    expect(small.body.links.thumbnail).toContain("?w=480&h=480");

    // Past the transform ceiling the resize parameter is ignored and the
    // ORIGINAL is streamed, so advertising a tile would cost a full download.
    getMedia.mockResolvedValue(row({ size: 500 * 1024 * 1024 }));
    const huge = await call(`${BASE}/alicja/romuz3.png`);
    expect(huge.body.links.thumbnail).toBeNull();
  });

  it("says where to read the text of a paste", async () => {
    getMedia.mockResolvedValue(
      row({ kind: "paste", language: "py", ext: "py", mimeType: "text/plain", size: 900 }),
    );
    const { body } = await call(`${BASE}/alicja/romuz3.py`);
    expect(body.text).toMatchObject({ language: "py", renderedInline: true });
    expect(body.text.url).toBe(`${BASE}/alicja/romuz3/raw.py`);
  });

  it("lists the conversion targets, so a client needs one request instead of five", async () => {
    getMedia.mockResolvedValue(row());
    const { body } = await call(`${BASE}/alicja/romuz3.png`);
    const targets = body.convert.targets.map((t: { to: string }) => t.to);
    // The row is a PNG, so PNG is not offered: a conversion to the format the
    // file already is has no meaning.
    expect(targets).not.toContain("png");
    expect(targets).toContain("webp");
    expect(body.convert.dryRunTemplate).toContain("check=1");
  });

  it("marks the ffmpeg re-encodes as owner only, which is how the route serves them", async () => {
    getMedia.mockResolvedValue(row({ mimeType: "video/mp4", ext: "mp4", filename: "clip.mp4" }));
    const { body } = await call(`${BASE}/alicja/romuz3.mp4`);
    const byTarget = new Map<string, boolean>(
      body.convert.targets.map((t: { to: string; requiresOwner: boolean }) => [t.to, t.requiresOwner]),
    );
    expect(byTarget.get("mov")).toBe(false); // container copy, public
    expect(byTarget.get("mp3")).toBe(true); // re-encode, owner only
  });
});

describe("the tagless form", () => {
  it("resolves /{code} through the owner's opt in", async () => {
    getMedia.mockImplementation(async (tag: string) => (tag === "alicja" ? row() : null));
    resolveTaglessOwnerTag.mockResolvedValue("alicja");
    const { body } = await call(`${BASE}/romuz3.png`);
    expect(body.resolvedAs).toMatchObject({ tag: "alicja", code: "romuz3", tagless: true });
  });

  /**
   * The measured bug this warning exists for: the app's own redirect for
   * /{code}/raw builds a bare path, so ?w=256 is dropped and the caller receives
   * the full original instead of a thumbnail.
   */
  it("warns that a tagless action URL loses its query string", async () => {
    getMedia.mockImplementation(async (tag: string, code: string) =>
      tag === "alicja" && code === "romuz3" ? row() : null,
    );
    resolveTaglessOwnerTag.mockResolvedValue("alicja");
    const { body } = await call(`${BASE}/romuz3/raw.png?w=256`);
    expect(body.resolvedAs.tagless).toBe(true);
    expect(body.warnings.join(" ")).toContain("drops the query string");
  });
});

// ---------------------------------------------------------------------------
// The moving tile
// ---------------------------------------------------------------------------

const { MOTION_CAPTURE_WIDTH, MOTION_PARAM } = await import("@/lib/media/motion-preview");

/**
 * `links.motionThumbnail` under the same three rules as the rest of the endpoint.
 *
 * The field is only worth having if its null is trustworthy. A client that
 * trusts a URL it cannot get a tile from does not shrug and move on: it falls
 * back to fetching the file itself to draw one, and on this path the file is a
 * video. So every case below is really one question, does the advertised URL
 * still produce a tile, asked once per way a row can fail to move.
 *
 * The predicate is deliberately NOT restated here. These tests drive rows
 * through the route and read what comes out, so they pin the CONTRACT (offered
 * exactly when a tile exists, absent on every gated path) rather than a copy of
 * `canMotionPreview`'s body, which is covered in tests/unit/motion-preview.test.ts.
 */
describe("the moving tile", () => {
  /** Well inside AV_MAX_INPUT_BYTES (512 MB): a video always moves. */
  const video = { mimeType: "video/mp4", ext: "mp4", filename: "clip.mp4", size: 700_000 };
  /** An animation the decoder counted frames for at upload. */
  const gif = {
    mimeType: "image/gif",
    ext: "gif",
    filename: "loop.gif",
    size: 400_000,
    frames: 12,
  };

  it("offers a tile for a video and for an animation", async () => {
    for (const over of [video, gif]) {
      getMedia.mockResolvedValue(row(over));
      const { body } = await call(`${BASE}/alicja/romuz3.${over.ext}`);
      expect(body.links.motionThumbnail).toBe(
        `${BASE}/alicja/romuz3/raw.${over.ext}?w=480&h=480&${MOTION_PARAM}=1`,
      );
    }
  });

  it("advertises the same URL /api/uploads does, so both share one cache entry", async () => {
    getMedia.mockResolvedValue(row(video));
    const { body } = await call(`${BASE}/alicja/romuz3.mp4`);
    // Same edge as the still tile, which is what lets a grid swap one for the
    // other on hover without the tile changing size.
    expect(body.links.motionThumbnail).toBe(`${body.links.thumbnail}&${MOTION_PARAM}=1`);
    // And never past the ceiling the serving route clamps to, or the route would
    // silently reduce it: two spellings of one request and two renders.
    const edge = Number(new URL(body.links.motionThumbnail).searchParams.get("w"));
    expect(edge).toBeLessThanOrEqual(MOTION_CAPTURE_WIDTH);
  });

  it("carries w and h, so drawing the tile spends no view", async () => {
    getMedia.mockResolvedValue(row(video));
    const { body } = await call(`${BASE}/alicja/romuz3.mp4`);
    // isPreviewFetch reads a size parameter as proof this is a preview rather
    // than a read. `motion=1` is exempt on its own today, but a URL that says
    // what it wants cannot be broken by a change to which parameters count.
    const q = new URL(body.links.motionThumbnail).searchParams;
    expect(q.get("w")).toBe("480");
    expect(q.get("h")).toBe("480");
  });

  it("refuses a still image rather than promising a one frame animation", async () => {
    // The default row is a PNG whose frame count was never recorded.
    getMedia.mockResolvedValue(row());
    const still = await call(`${BASE}/alicja/romuz3.png`);
    expect(still.body.links.motionThumbnail).toBeNull();
    // The still tile is unaffected: refusing to move is not refusing to preview.
    expect(still.body.links.thumbnail).toContain("?w=480&h=480");

    getMedia.mockResolvedValue(row({ ...gif, frames: 1 }));
    const oneFrame = await call(`${BASE}/alicja/romuz3.gif`);
    expect(oneFrame.body.links.motionThumbnail).toBeNull();
  });

  it("refuses a row whose frame count was never recorded, rather than guessing", async () => {
    // Most of an imported library. Guessing here would send a grid to
    // fetch a preview that answers 415 for every legacy still in the account.
    getMedia.mockResolvedValue(row({ ...gif, frames: null }));
    const { body } = await call(`${BASE}/alicja/romuz3.gif`);
    expect(body.links.motionThumbnail).toBeNull();
  });

  it("honours the two different ceilings, because the two paths cost differently", async () => {
    const size = 40 * 1024 * 1024; // past MAX_TRANSFORM_BYTES, inside AV_MAX_INPUT_BYTES

    // An animation is READ AND DECODED, so 40 MB is past its budget.
    getMedia.mockResolvedValue(row({ ...gif, size }));
    const bigGif = await call(`${BASE}/alicja/romuz3.gif`);
    expect(bigGif.body.links.motionThumbnail).toBeNull();

    // A video of the identical size is SEEKED, so it is still offered. If one
    // ceiling ever gets applied to both kinds, exactly one of these two flips.
    getMedia.mockResolvedValue(row({ ...video, size }));
    const bigVideo = await call(`${BASE}/alicja/romuz3.mp4`);
    expect(bigVideo.body.links.motionThumbnail).not.toBeNull();

    // Past the video ceiling too, and the still poster goes with it.
    getMedia.mockResolvedValue(row({ ...video, size: 600 * 1024 * 1024 }));
    const huge = await call(`${BASE}/alicja/romuz3.mp4`);
    expect(huge.body.links.motionThumbnail).toBeNull();
    expect(huge.body.links.thumbnail).toBeNull();
  });

  it("explains the tile only when there is one to explain", async () => {
    getMedia.mockResolvedValue(row(video));
    const moving = await call(`${BASE}/alicja/romuz3.mp4`);
    expect(moving.body.notes.join(" ")).toContain("motionThumbnail");
    // Says what it is. A client told "a preview" would reasonably expect the
    // opening seconds, and would report the sampled frames as a bug.
    expect(moving.body.notes.join(" ")).toContain("sampled across the whole file");

    getMedia.mockResolvedValue(row());
    const stillFile = await call(`${BASE}/alicja/romuz3.png`);
    expect(stillFile.text).not.toContain("motionThumbnail is");
  });

  // -------------------------------------------------------------------------
  // Nothing new leaks
  // -------------------------------------------------------------------------

  it("says nothing at all about a gated file, not even that it moves", async () => {
    getMedia.mockResolvedValue(
      row({ ...video, filename: "wesele-nagranie-prywatne.mp4", passwordHash: "scrypt$whatever" }),
    );
    const { body, text } = await call(`${BASE}/alicja/romuz3.mp4`);

    expect(body.status).toBe("password-required");
    // Absent, not null: the gated branch answers with its own small body, so a
    // motion field cannot arrive there by being appended to the open one.
    expect(body.links.motionThumbnail).toBeUndefined();
    expect(Object.keys(body.links)).toEqual(["page"]);
    // "It moves" is a fact about the file, and a gated file gives up no facts.
    // A tile is also eight real frames of the content, which is the leak itself.
    expect(text).not.toContain(MOTION_PARAM);
    expect(text).not.toContain("wesele");
  });

  it("adds nothing to the expired, spent and trashed answer", async () => {
    // getMedia collapses all of them to null before this code is reached.
    getMedia.mockResolvedValue(null);
    const { res, text } = await call(`${BASE}/alicja/romuz3.mp4`);
    expect(res.status).toBe(404);
    expect(text).not.toContain(MOTION_PARAM);
  });

  it("does not offer a stranger a tile of an unpublished file", async () => {
    getMedia.mockResolvedValue(row({ ...video, published: false }));
    const stranger = await call(`${BASE}/alicja/romuz3.mp4`);
    expect(stranger.res.status).toBe(404);
    expect(stranger.text).not.toContain(MOTION_PARAM);

    // The owner does get one: it is their own row, and their own panel draws it.
    resolveApiCaller.mockResolvedValue({ ok: true, caller: { id: "owner-1", role: "user" }, scope: null });
    const owner = await call(`${BASE}/alicja/romuz3.mp4`);
    expect(owner.body.status).toBe("unlisted");
    expect(owner.body.links.motionThumbnail).not.toBeNull();
  });

  it("is answered from the row, with no byte read", async () => {
    getMedia.mockResolvedValue(row({ ...video, size: 500 * 1024 * 1024 }));
    const { body } = await call(`${BASE}/alicja/romuz3.mp4`);
    expect(body.links.motionThumbnail).not.toBeNull();
    // Half a gigabyte described without opening it. The predicate reads mime,
    // extension, size and the recorded frame count, and nothing else.
    expect(streamMedia).not.toHaveBeenCalled();
    expect(consumeView).not.toHaveBeenCalled();
  });
});
