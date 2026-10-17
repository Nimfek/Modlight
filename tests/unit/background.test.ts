import { describe, it, expect } from "vitest";
import {
  backgroundKey,
  backgroundStyle,
  backgroundToken,
  backgroundUrl,
  clampDim,
  isAcceptedBackgroundType,
  DIM_DEFAULT,
  DIM_MAX,
  DIM_MIN,
} from "@/lib/background";

describe("clampDim", () => {
  it("keeps sane values", () => {
    expect(clampDim(0)).toBe(0);
    expect(clampDim(55)).toBe(55);
    expect(clampDim(95)).toBe(95);
  });

  it("clamps out-of-range values instead of rejecting them", () => {
    expect(clampDim(-40)).toBe(DIM_MIN);
    expect(clampDim(1000)).toBe(DIM_MAX);
  });

  it("falls back to the default for anything non-numeric", () => {
    // The value reaches this from a range input and from a database column that
    // predates the feature, so null/undefined/garbage must not paint an
    // undefined veil over somebody's panel.
    expect(clampDim(null)).toBe(DIM_DEFAULT);
    expect(clampDim(undefined)).toBe(DIM_DEFAULT);
    expect(clampDim("abc")).toBe(DIM_DEFAULT);
    expect(clampDim(NaN)).toBe(DIM_DEFAULT);
    expect(clampDim(Infinity)).toBe(DIM_DEFAULT);
  });

  it("rounds, so a fractional drag never reaches CSS", () => {
    expect(clampDim(55.4)).toBe(55);
    expect(clampDim(55.6)).toBe(56);
  });
});

describe("backgroundKey / backgroundToken", () => {
  it("round-trips the cache-busting token", () => {
    const key = backgroundKey("user_123", "deadbeef");
    expect(key).toBe("backgrounds/user_123-deadbeef.webp");
    expect(backgroundToken(key)).toBe("deadbeef");
  });

  it("takes the LAST dash, so an id containing dashes still resolves", () => {
    const key = backgroundKey("a-b-c", "cafe");
    expect(backgroundToken(key)).toBe("cafe");
  });

  it("returns empty for anything that is not one of our keys", () => {
    expect(backgroundToken(null)).toBe("");
    expect(backgroundToken(undefined)).toBe("");
    expect(backgroundToken("nodash")).toBe("");
  });
});

describe("backgroundUrl", () => {
  it("is null unless there is both a tag and a key", () => {
    expect(backgroundUrl(null, "backgrounds/u-1.webp")).toBeNull();
    expect(backgroundUrl("tag", null)).toBeNull();
    expect(backgroundUrl(null, null)).toBeNull();
  });

  it("is root-relative, so it stays same-origin on every configured domain", () => {
    const url = backgroundUrl("mytag", backgroundKey("u1", "abc123"));
    expect(url).toBe("/bg/mytag?v=abc123");
  });

  it("escapes the tag rather than interpolating it raw", () => {
    // Tags are validated on write, but this string lands inside a CSS url() on
    // every page the account owns - it must not be the weak link.
    const url = backgroundUrl('a"b', backgroundKey("u1", "t"));
    expect(url).not.toContain('"');
    expect(url).toBe("/bg/a%22b?v=t");
  });

  it("omits ?v when the key carries no token, rather than emitting v=", () => {
    expect(backgroundUrl("tag", "legacy.webp")).toBe("/bg/tag");
  });
});

describe("backgroundStyle", () => {
  it("hands CSS a 0-1 fraction, not a percentage", () => {
    const style = backgroundStyle("tag", backgroundKey("u1", "t"), 60);
    expect(style).toEqual({ url: "/bg/tag?v=t", dim: 0.6 });
  });

  it("is null when there is no wallpaper, so the applier clears the variables", () => {
    expect(backgroundStyle("tag", null, 60)).toBeNull();
  });

  it("uses the default veil when the column is null", () => {
    const style = backgroundStyle("tag", backgroundKey("u1", "t"), null);
    expect(style?.dim).toBeCloseTo(DIM_DEFAULT / 100);
  });
});

describe("isAcceptedBackgroundType", () => {
  it("accepts the raster formats sharp re-encodes", () => {
    for (const t of ["image/png", "image/jpeg", "image/webp", "image/avif", "image/gif"]) {
      expect(isAcceptedBackgroundType(t)).toBe(true);
    }
  });

  it("tolerates parameters and casing on the header", () => {
    expect(isAcceptedBackgroundType("IMAGE/PNG")).toBe(true);
    expect(isAcceptedBackgroundType("image/jpeg; charset=binary")).toBe(true);
  });

  it("rejects SVG", () => {
    // Deliberate: it is a script-bearing document, and this is the one image
    // path whose bytes arrive from a form rather than the upload pipeline.
    expect(isAcceptedBackgroundType("image/svg+xml")).toBe(false);
  });

  it("rejects non-images and missing headers", () => {
    expect(isAcceptedBackgroundType("text/html")).toBe(false);
    expect(isAcceptedBackgroundType("application/octet-stream")).toBe(false);
    expect(isAcceptedBackgroundType(null)).toBe(false);
    expect(isAcceptedBackgroundType(undefined)).toBe(false);
    expect(isAcceptedBackgroundType("")).toBe(false);
  });
});
