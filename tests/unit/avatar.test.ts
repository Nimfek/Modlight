import { describe, it, expect } from "vitest";
import {
  AVATAR_MAX_FRAMES,
  AVATAR_MAX_FRAME_PIXELS,
  AVATAR_MAX_TOTAL_PIXELS,
  avatarKey,
  avatarToken,
  avatarUrl,
  isAcceptedAvatarType,
  isAvatarKey,
  planAvatar,
} from "@/lib/avatar";

describe("avatarKey / avatarToken", () => {
  it("round-trips the cache-busting token", () => {
    const key = avatarKey("user_123", "deadbeef");
    expect(key).toBe("avatars/user_123-deadbeef.webp");
    expect(avatarToken(key)).toBe("deadbeef");
  });

  it("takes the LAST dash, so an id containing dashes still resolves", () => {
    expect(avatarToken(avatarKey("a-b-c", "cafe"))).toBe("cafe");
  });

  it("returns empty for anything that is not one of our keys", () => {
    expect(avatarToken(null)).toBe("");
    expect(avatarToken(undefined)).toBe("");
    expect(avatarToken("nodash")).toBe("");
  });
});

describe("isAvatarKey", () => {
  it("recognises only values this app wrote", () => {
    expect(isAvatarKey(avatarKey("u1", "t"))).toBe(true);
    expect(isAvatarKey("backgrounds/u1-t.webp")).toBe(false);
    expect(isAvatarKey("https://cdn.example.com/face.png")).toBe(false);
    expect(isAvatarKey(null)).toBe(false);
    expect(isAvatarKey("")).toBe(false);
  });
});

describe("avatarUrl", () => {
  it("is root-relative, so it stays same-origin on every configured domain", () => {
    expect(avatarUrl("mytag", avatarKey("u1", "abc123"))).toBe("/avatar/mytag?v=abc123");
  });

  it("escapes the tag rather than interpolating it raw", () => {
    const url = avatarUrl('a"b', avatarKey("u1", "t"));
    expect(url).not.toContain('"');
    expect(url).toBe("/avatar/a%22b?v=t");
  });

  it("passes an absolute URL through untouched", () => {
    // `image` is Better Auth's own column. Nothing writes an http URL into it in
    // this deployment, but a social provider added later would, and mangling one
    // into a storage key would serve a 404 where a perfectly good picture exists.
    expect(avatarUrl("tag", "https://cdn.example.com/face.png")).toBe(
      "https://cdn.example.com/face.png",
    );
  });

  it("degrades to initials rather than to a broken image", () => {
    // Every one of these is a real state: an account that never set an avatar,
    // one whose tag has not been assigned yet, and a column holding something
    // this app did not write. A null here means the component renders no
    // <AvatarImage> at all, so Radix draws the fallback - which is the initials.
    expect(avatarUrl("tag", null)).toBeNull();
    expect(avatarUrl("tag", undefined)).toBeNull();
    expect(avatarUrl("tag", "")).toBeNull();
    expect(avatarUrl(null, avatarKey("u1", "t"))).toBeNull();
    expect(avatarUrl("tag", "some/other/object.bin")).toBeNull();
  });

  it("omits ?v when the key carries no token, rather than emitting v=", () => {
    expect(avatarUrl("tag", "avatars/legacy.webp")).toBe("/avatar/tag");
  });
});

describe("isAcceptedAvatarType", () => {
  it("accepts the raster formats libvips re-encodes, GIF included", () => {
    for (const t of ["image/png", "image/jpeg", "image/webp", "image/avif", "image/gif"]) {
      expect(isAcceptedAvatarType(t)).toBe(true);
    }
  });

  it("tolerates parameters and casing on the header", () => {
    expect(isAcceptedAvatarType("IMAGE/GIF")).toBe(true);
    expect(isAcceptedAvatarType("image/jpeg; charset=binary")).toBe(true);
  });

  it("rejects SVG and everything that is not an image", () => {
    expect(isAcceptedAvatarType("image/svg+xml")).toBe(false);
    expect(isAcceptedAvatarType("text/html")).toBe(false);
    expect(isAcceptedAvatarType("application/octet-stream")).toBe(false);
    expect(isAcceptedAvatarType(null)).toBe(false);
  });
});

describe("planAvatar: the frame-aware budget", () => {
  it("keeps the animation of an ordinary GIF", () => {
    const plan = planAvatar({ width: 480, height: 360, pages: 30 });
    expect(plan).toEqual({ ok: true, animate: true, frames: 30, reason: "animate" });
  });

  it("treats a still as a still, with nothing lost", () => {
    const plan = planAvatar({ width: 4000, height: 3000, pages: 1 });
    expect(plan).toEqual({ ok: true, animate: false, frames: 1, reason: "still" });
  });

  it("charges every FRAME, which is the whole point", () => {
    // The case Round 7 was written about, in avatar form: 1654x762 with 256
    // frames reads as 1.26 Mpx to a `width * height` guard and costs 322 Mpx to
    // decode. A per-frame budget waves it through; this one does not.
    const naive = 1654 * 762;
    expect(naive).toBeLessThan(AVATAR_MAX_TOTAL_PIXELS);

    const plan = planAvatar({ width: 1654, height: 762, pages: 256 });
    expect(plan.animate).toBe(false);
    // Refused for its frame count first - it is over that ceiling too - and the
    // owner still gets a working avatar out of frame one.
    expect(plan.ok).toBe(true);
    expect(plan.frames).toBe(1);
  });

  it("refuses to animate a sequence that clears the frame cap but not the pixel one", () => {
    // Well under AVATAR_MAX_FRAMES, so only the multiplication can catch it:
    // 2000 x 1500 x 20 = 60 Mpx against a 40 Mpx ceiling.
    const frames = 20;
    expect(frames).toBeLessThanOrEqual(AVATAR_MAX_FRAMES);
    expect(2000 * 1500 * frames).toBeGreaterThan(AVATAR_MAX_TOTAL_PIXELS);

    const plan = planAvatar({ width: 2000, height: 1500, pages: frames });
    expect(plan).toEqual({ ok: true, animate: false, frames: 1, reason: "pixels" });
  });

  it("names the frame cap when that is what bound it", () => {
    // Tiny frames, so the pixel budget is nowhere near: only the count can
    // refuse this, and the two reasons must not be reported as one another.
    const plan = planAvatar({ width: 64, height: 64, pages: AVATAR_MAX_FRAMES + 1 });
    expect(plan).toEqual({ ok: true, animate: false, frames: 1, reason: "frames" });
    expect(64 * 64 * (AVATAR_MAX_FRAMES + 1)).toBeLessThan(AVATAR_MAX_TOTAL_PIXELS);
  });

  it("accepts exactly the cap, and one frame past it degrades", () => {
    expect(planAvatar({ width: 64, height: 64, pages: AVATAR_MAX_FRAMES }).animate).toBe(true);
    expect(planAvatar({ width: 64, height: 64, pages: AVATAR_MAX_FRAMES + 1 }).animate).toBe(false);
  });

  it("degrades an oversized animation instead of refusing the file", () => {
    // "Your GIF is too long to animate at this size" leaves the user with an
    // avatar. A 415 leaves them with nothing, for a problem they can neither see
    // nor fix.
    const plan = planAvatar({ width: 1000, height: 1000, pages: 100 });
    expect(plan.ok).toBe(true);
    expect(plan.animate).toBe(false);
  });

  it("REFUSES a single frame over the decompression-bomb ceiling", () => {
    // Different class of problem, and so a different answer: there is no cheaper
    // thing to encode from a 40 kB PNG that declares 100000 x 100000.
    const plan = planAvatar({ width: 100_000, height: 100_000, pages: 1 });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe("frame-too-large");
    expect(100_000 * 100_000).toBeGreaterThan(AVATAR_MAX_FRAME_PIXELS);
  });

  it("survives the shapes a decoder can hand back", () => {
    // `pages` is 0 or absent on plenty of stills, and NaN dimensions have to
    // land somewhere defined rather than making every comparison false.
    expect(planAvatar({ width: 100, height: 100, pages: 0 }).frames).toBe(1);
    expect(planAvatar({ width: 100, height: 100, pages: Number.NaN }).animate).toBe(false);
    expect(planAvatar({ width: Number.NaN, height: 100, pages: 4 }).ok).toBe(true);
  });
});
