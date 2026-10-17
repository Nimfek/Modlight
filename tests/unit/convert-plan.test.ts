import { describe, it, expect } from "vitest";
import {
  bulkTargetSummary,
  conversionEngineFor,
  conversionRowPatch,
  currentFormatOf,
  isAlreadyInFormat,
  outputFor,
  planBulkConversion,
  planConversion,
  quotaAllowsDelta,
  quotaDeltaFor,
  type ConvertCandidate,
} from "@/lib/media/convert-plan";
import { codeFromMediaCode, suffixKey, swapFilenameExt, swapKeyExt } from "@/lib/media/paths";
import { publicUrl, rawUrl, storageKeyFor } from "@/lib/media/urls";

const NOW = new Date("2026-08-11T12:00:00Z");

function file(over: Partial<ConvertCandidate> = {}): ConvertCandidate {
  return {
    id: "id-1",
    ext: "png",
    mimeType: "image/png",
    frames: 1,
    size: 1000,
    kind: "file",
    deletedAt: null,
    expiresAt: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------

/**
 * The promise the whole feature rests on: after an in-place conversion the file
 * answers to the SAME link it always did.
 *
 * It holds because the lookup key is the code and the extension in the URL is
 * decorative. If either of those ever stops being true, these assertions are
 * where it shows up - not in a support message about a dead link somebody shared
 * six months ago.
 */
describe("an old link keeps working after an in-place conversion", () => {
  const row = {
    code: "bomep7",
    ext: "mp4",
    filename: "wakacje.2024.mp4",
    originalExt: null as string | null,
  };

  it("resolves the pre-conversion and post-conversion URLs to the same code", () => {
    const before = publicUrl("alicja", row.code, "mp4");
    const after = publicUrl("alicja", row.code, "gif");
    expect(before).not.toBe(after);

    const segment = (url: string) => url.split("/").pop()!;
    expect(codeFromMediaCode(segment(before))).toBe(row.code);
    expect(codeFromMediaCode(segment(after))).toBe(row.code);
    // ...and the bare form somebody may have copied without an extension.
    expect(codeFromMediaCode(row.code)).toBe(row.code);
  });

  it("keeps /raw addressable under the extension it was shared with", () => {
    // The raw URL carries the extension in a path segment of its own, and the
    // route admits `raw.<anything>`, so a link shared as raw.mp4 survives.
    expect(rawUrl("alicja", row.code, "mp4")).toContain(`/${row.code}/raw.mp4`);
    expect(rawUrl("alicja", row.code, "gif")).toContain(`/${row.code}/raw.gif`);
  });

  it("never writes the columns a link is made of", () => {
    const patch = conversionRowPatch(
      row,
      {
        storageKey: "alicja/bomep7.gif",
        size: 2700,
        checksum: "c".repeat(64),
        mime: "image/gif",
        ext: "gif",
        width: 480,
        height: 270,
        frames: 72,
        durationSeconds: null,
        fps: null,
        blurhash: "LEHV6nWB",
      },
      NOW,
    );

    for (const column of [
      "code",
      "deleteToken",
      "ownerId",
      "published",
      "views",
      "downloads",
      "passwordHash",
      "passwordVersion",
      "expiresAt",
      "maxViews",
      "folderId",
      "deletedAt",
      "createdAt",
    ]) {
      expect(patch, column).not.toHaveProperty(column);
    }
  });

  it("rewrites exactly what the bytes changed, and the name with them", () => {
    const patch = conversionRowPatch(row, {
      storageKey: "alicja/bomep7.gif",
      size: 2700,
      checksum: "c".repeat(64),
      mime: "image/gif",
      ext: "gif",
      width: 480,
      height: 270,
      frames: 72,
      durationSeconds: null,
      fps: null,
      blurhash: null,
    }, NOW);

    expect(patch.ext).toBe("gif");
    expect(patch.mimeType).toBe("image/gif");
    expect(patch.filename).toBe("wakacje.2024.gif");
    // A thumbnail of the old bytes is a picture of a file that no longer exists.
    expect(patch.thumbKey).toBeNull();
    expect(patch.originalExt).toBe("mp4");
    expect(patch.convertedAt).toBe(NOW);
  });

  it("clears the playing time and frame rate when the result has none", () => {
    // The row this patch lands on is a video: since uploads carry duration and
    // fps, converting one to a six second GIF would otherwise leave the
    // recording's own length and rate sitting on a file that has neither. The
    // patch writes both columns unconditionally, so "null" really does clear.
    const patch = conversionRowPatch(row, {
      storageKey: "alicja/bomep7.gif",
      size: 2700,
      checksum: "c".repeat(64),
      mime: "image/gif",
      ext: "gif",
      width: 480,
      height: 270,
      frames: 72,
      durationSeconds: null,
      fps: null,
      blurhash: null,
    }, NOW);

    expect(patch).toHaveProperty("durationSeconds");
    expect(patch).toHaveProperty("fps");
    expect(patch.durationSeconds).toBeNull();
    expect(patch.fps).toBeNull();
  });

  it("carries the playing time through a stream copy, which preserves it", () => {
    const patch = conversionRowPatch(row, {
      storageKey: "alicja/bomep7.mkv",
      size: 2_179_538,
      checksum: "c".repeat(64),
      mime: "video/x-matroska",
      ext: "mkv",
      width: 5056,
      height: 1924,
      frames: 403,
      durationSeconds: 13.434,
      fps: 30,
      blurhash: null,
    }, NOW);

    expect(patch.durationSeconds).toBe(13.434);
    expect(patch.fps).toBe(30);
  });

  it("remembers the FIRST format across a chain of conversions", () => {
    const second = conversionRowPatch(
      { ext: "gif", filename: "a.gif", originalExt: "mp4" },
      {
        storageKey: "k",
        size: 1,
        checksum: "x",
        mime: "image/webp",
        ext: "webp",
        width: null,
        height: null,
        durationSeconds: null,
        fps: null,
        frames: null,
        blurhash: null,
      },
      NOW,
    );
    expect(second.originalExt).toBe("mp4");
  });
});

// ---------------------------------------------------------------------------

describe("storage keys and filenames", () => {
  it("swaps only the extension, keeping the directory the file was uploaded under", () => {
    // The prefix is the owner's tag AS IT WAS. Rebuilding it from the current
    // tag would move the object; swapping the extension cannot.
    expect(swapKeyExt("ToqOse/bomep7.mp4", "gif")).toBe("ToqOse/bomep7.gif");
    expect(swapKeyExt("old-tag/bomep7.mp4", "gif")).toBe("old-tag/bomep7.gif");
    expect(swapKeyExt(storageKeyFor("ToqOse", "bomep7", "mp4"), "gif")).toBe("ToqOse/bomep7.gif");
  });

  it("handles a key with no extension at all", () => {
    expect(swapKeyExt("ToqOse/bomep7", "png")).toBe("ToqOse/bomep7.png");
    expect(swapKeyExt("ToqOse/bomep7.png", "")).toBe("ToqOse/bomep7");
  });

  it("treats only the LAST dot of a filename as an extension", () => {
    expect(swapFilenameExt("wakacje.2024.mp4", "gif")).toBe("wakacje.2024.gif");
    expect(swapFilenameExt("zrzut", "png")).toBe("zrzut.png");
    // A dotfile is a name, not an extension.
    expect(swapFilenameExt(".gitignore", "txt")).toBe(".gitignore.txt");
  });

  it("writes beside an occupied key rather than over it", () => {
    expect(suffixKey("ToqOse/bomep7.gif", "a1b2")).toBe("ToqOse/bomep7-a1b2.gif");
    expect(suffixKey("ToqOse/bomep7", "a1b2")).toBe("ToqOse/bomep7-a1b2");
  });
});

// ---------------------------------------------------------------------------

describe("what a file already is", () => {
  it("recognises the format from the stored type", () => {
    expect(currentFormatOf("image/png", "png")).toBe("png");
    expect(currentFormatOf("image/jpeg", "jpg")).toBe("jpg");
    expect(currentFormatOf("video/quicktime", "mov")).toBe("mov");
    expect(currentFormatOf("audio/mpeg", "mp3")).toBe("mp3");
  });

  it("falls back to the extension for the many rows stored as octet-stream", () => {
    // ShareX on Windows reads the type from a registry that has no entry for
    // anything modern, so this is not a rare case.
    expect(currentFormatOf("application/octet-stream", "avif")).toBe("avif");
    expect(currentFormatOf("application/octet-stream", "webp")).toBe("webp");
  });

  it("treats the spellings of one format as one format", () => {
    expect(isAlreadyInFormat("image/jpeg", "jpeg", "jpg")).toBe(true);
    expect(isAlreadyInFormat("application/octet-stream", "jpe", "jpg")).toBe(true);
    expect(isAlreadyInFormat("image/apng", "apng", "png")).toBe(true);
  });

  it("does not confuse two different formats", () => {
    expect(isAlreadyInFormat("image/png", "png", "webp")).toBe(false);
    expect(isAlreadyInFormat("video/mp4", "mp4", "mkv")).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("which engine answers", () => {
  it("gives ffmpeg the targets it claims, exactly as the route dispatches", () => {
    expect(conversionEngineFor("video/mp4", "mp4", null, "mkv")).toBe("av");
    expect(conversionEngineFor("audio/mpeg", "mp3", null, "ogg")).toBe("av");
    // The case the two engines fight over: an AVIF sequence's webp is all the
    // frames (ffmpeg), not the cover frame (libvips).
    expect(conversionEngineFor("image/avif", "avif", null, "webp")).toBe("av");
  });

  it("gives libvips the still-picture targets", () => {
    expect(conversionEngineFor("image/png", "png", 1, "webp")).toBe("image");
    expect(conversionEngineFor("image/jpeg", "jpg", 1, "pdf")).toBe("image");
  });

  it("answers null for anything neither engine offers", () => {
    expect(conversionEngineFor("application/zip", "zip", null, "png")).toBeNull();
    expect(conversionEngineFor("image/png", "png", 1, "mkv")).toBeNull();
  });

  it("names the output of every target it admits", () => {
    expect(outputFor("gif")).toEqual({ mime: "image/gif", ext: "gif" });
    expect(outputFor("pdf")).toEqual({ mime: "application/pdf", ext: "pdf" });
    expect(outputFor("nonsense")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("what a single conversion decides", () => {
  it("converts an ordinary picture", () => {
    expect(planConversion(file(), "webp", "replace", NOW)).toEqual({
      ok: true,
      engine: "image",
      ext: "webp",
      mime: "image/webp",
    });
  });

  it("skips a file already in the target format", () => {
    expect(planConversion(file(), "png", "replace", NOW)).toEqual({
      ok: false,
      reason: "already-in-format",
    });
  });

  it("skips a trashed file before anything else", () => {
    const row = file({ deletedAt: new Date("2026-01-01"), ext: "png" });
    expect(planConversion(row, "png", "replace", NOW).ok).toBe(false);
    expect(planConversion(row, "webp", "replace", NOW)).toEqual({
      ok: false,
      reason: "trashed",
    });
  });

  it("skips an expired file", () => {
    const row = file({ expiresAt: new Date("2026-08-01T00:00:00Z") });
    expect(planConversion(row, "webp", "replace", NOW)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("refuses to replace a paste, because its bytes ARE its text", () => {
    const paste = file({ kind: "paste", ext: "ts", mimeType: "text/plain", frames: null });
    expect(planConversion(paste, "pdf", "replace", NOW)).toEqual({
      ok: false,
      reason: "paste",
    });
  });

  it("reports a target this format cannot reach as unsupported, not as a failure", () => {
    expect(planConversion(file({ ext: "zip", mimeType: "application/zip" }), "png", "replace", NOW)).toEqual({
      ok: false,
      reason: "unsupported-target",
    });
  });
});

// ---------------------------------------------------------------------------

/**
 * The mixed-selection case from the report, verbatim: five JPEGs and three PNGs
 * selected, PNG chosen. Three of them have nothing to do, and saying so is the
 * difference between a readable result and three alarming failures.
 */
describe("a mixed selection", () => {
  const jpegs = Array.from({ length: 5 }, (_, i) =>
    file({ id: `jpg-${i}`, ext: "jpg", mimeType: "image/jpeg" }),
  );
  const pngs = Array.from({ length: 3 }, (_, i) =>
    file({ id: `png-${i}`, ext: "png", mimeType: "image/png" }),
  );
  const selection = [...jpegs, ...pngs];

  it("converts the five and leaves the three alone", () => {
    const plan = planBulkConversion(selection, "png", "replace", NOW);
    expect(plan.convert.map((c) => c.id)).toEqual(jpegs.map((f) => f.id));
    expect(plan.skipped).toHaveLength(3);
    expect(new Set(plan.skipped.map((s) => s.reason))).toEqual(new Set(["already-in-format"]));
  });

  it("counts each offered target before anything is clicked", () => {
    const summary = bulkTargetSummary(selection, "replace", NOW);
    const byName = Object.fromEntries(summary.map((s) => [s.to, s]));

    // Every file can become WebP or AVIF; only the JPEGs can become PNG, and
    // only the PNGs can become JPG.
    expect(byName.webp.eligible).toBe(8);
    expect(byName.avif.eligible).toBe(8);
    expect(byName.png.eligible).toBe(5);
    expect(byName.png.alreadyInFormat).toBe(3);
    expect(byName.jpg.eligible).toBe(3);
    expect(byName.jpg.alreadyInFormat).toBe(5);
  });

  it("puts the target that does the most work first", () => {
    const summary = bulkTargetSummary(selection, "replace", NOW);
    expect(summary[0].eligible).toBe(8);
    expect(summary.map((s) => s.eligible)).toEqual(
      [...summary.map((s) => s.eligible)].sort((a, b) => b - a),
    );
  });

  it("offers nothing that applies to no selected file", () => {
    const summary = bulkTargetSummary(selection, "replace", NOW);
    expect(summary.every((s) => s.eligible > 0)).toBe(true);
    // These are pictures; no video container is on the list.
    expect(summary.map((s) => s.to)).not.toContain("mkv");
  });

  it("counts a video's targets separately from the pictures beside it", () => {
    const mixed = [
      ...pngs,
      file({ id: "vid", ext: "mp4", mimeType: "video/mp4", frames: null }),
    ];
    const byName = Object.fromEntries(
      bulkTargetSummary(mixed, "replace", NOW).map((s) => [s.to, s]),
    );
    expect(byName.mkv.eligible).toBe(1);
    expect(byName.mkv.unsupported).toBe(3);
    expect(byName.webp.eligible).toBe(3);
  });

  it("drops trashed rows out of every count", () => {
    const withTrash = [...jpegs, file({ id: "gone", ext: "jpg", deletedAt: NOW })];
    const plan = planBulkConversion(withTrash, "png", "replace", NOW);
    expect(plan.convert).toHaveLength(5);
    expect(plan.skipped).toEqual([{ id: "gone", reason: "trashed" }]);
  });
});

// ---------------------------------------------------------------------------

describe("what a conversion costs the quota", () => {
  it("charges a copy for the whole new file", () => {
    expect(quotaDeltaFor("copy", 1000, 300)).toBe(300);
    expect(quotaDeltaFor("copy", 1000, 4000)).toBe(4000);
  });

  it("charges a replace only the difference", () => {
    expect(quotaDeltaFor("replace", 1000, 300)).toBe(-700);
    expect(quotaDeltaFor("replace", 1000, 4000)).toBe(3000);
    expect(quotaDeltaFor("replace", 1000, 1000)).toBe(0);
  });

  it("refuses a charge that would pass the limit", () => {
    const owner = { usedQuota: 900, maxQuota: 1000 };
    expect(quotaAllowsDelta(owner, 100)).toBe(true);
    expect(quotaAllowsDelta(owner, 101)).toBe(false);
  });

  it("never refuses a conversion that makes the file smaller", () => {
    // An admin lowering somebody's limit puts them over it. Refusing to shrink a
    // file in that state would trap them in exactly what the limit exists to end.
    const overLimit = { usedQuota: 5000, maxQuota: 1000 };
    expect(quotaAllowsDelta(overLimit, -1)).toBe(true);
    expect(quotaAllowsDelta(overLimit, 0)).toBe(true);
    expect(quotaAllowsDelta(overLimit, 1)).toBe(false);
  });

  it("treats the -1 unlimited sentinel as unlimited", () => {
    expect(quotaAllowsDelta({ usedQuota: 10 ** 12, maxQuota: -1 }, 10 ** 9)).toBe(true);
    expect(quotaAllowsDelta({ usedQuota: 10 ** 12, maxQuota: null }, 10 ** 9)).toBe(true);
  });
});
