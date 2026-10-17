import { describe, it, expect } from "vitest";
import {
  isReservedTag,
  mediaPath,
  scopedShortCode,
  splitShortCode,
  checkTag,
  SHORT_CODE_MAX,
} from "@/lib/naming";

describe("isReservedTag", () => {
  it("guards the routes that exist today", () => {
    for (const name of ["login", "dashboard", "api", "s", "u", "a", "welcome", "trash"]) {
      expect(isReservedTag(name), name).toBe(true);
    }
  });

  it("is case-insensitive", () => {
    expect(isReservedTag("Login")).toBe(true);
    expect(isReservedTag("DASHBOARD")).toBe(true);
  });

  it("matches whole segments only, so real names stay usable", () => {
    // A tagless upload called login-screen.png must not be blocked.
    expect(isReservedTag("login-screen")).toBe(false);
    expect(isReservedTag("apis")).toBe(false);
    expect(isReservedTag("alicja")).toBe(false);
  });

  it("keeps the legacy production tags claimable", () => {
    // Reserving one of these would lock an existing account out of its own tag.
    for (const tag of ["alicja", "bobby", "root", "hIto3", "kiNo4"]) {
      expect(checkTag(tag), tag).toEqual({ ok: true });
    }
  });
});

describe("mediaPath", () => {
  it("includes the tag by default", () => {
    expect(mediaPath("alicja", "screenshot", "png")).toBe("/alicja/screenshot.png");
  });

  it("drops the tag segment for owners who opted out", () => {
    expect(mediaPath(null, "screenshot", "png")).toBe("/screenshot.png");
  });

  it("omits the dot when a file has no extension", () => {
    expect(mediaPath("alicja", "notes", "")).toBe("/alicja/notes");
    expect(mediaPath(null, "notes", "")).toBe("/notes");
  });
});

describe("short link codes", () => {
  it("namespaces a code under the owner's tag", () => {
    expect(scopedShortCode("alicja", "test")).toBe("alicja/test");
  });

  it("leaves root-level codes untouched", () => {
    expect(scopedShortCode(null, "test")).toBe("test");
  });

  it("round-trips", () => {
    expect(splitShortCode(scopedShortCode("alicja", "test"))).toEqual({
      tag: "alicja",
      code: "test",
    });
    expect(splitShortCode(scopedShortCode(null, "test"))).toEqual({ tag: null, code: "test" });
  });

  it("splits on the FIRST slash, so a code may not be mistaken for a tag", () => {
    expect(splitShortCode("alicja/a/b")).toEqual({ tag: "alicja", code: "a/b" });
  });

  it("lets two users own the same name", () => {
    expect(scopedShortCode("alicja", "test")).not.toBe(scopedShortCode("bobby", "test"));
  });

  it("stays inside the varchar(64) column for a max-length tag", () => {
    // 32-char tag + slash leaves 31 characters for the leaf.
    const tag = "x".repeat(32);
    expect(scopedShortCode(tag, "y".repeat(31)).length).toBe(SHORT_CODE_MAX);
    expect(scopedShortCode(tag, "y".repeat(32)).length).toBeGreaterThan(SHORT_CODE_MAX);
  });
});
