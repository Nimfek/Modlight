import { describe, it, expect } from "vitest";
import { join, resolve, sep } from "node:path";
import { normalizeKey, toStorageKey } from "@/lib/data/admin";
import { confirmationMatches } from "@/components/admin/confirm";

/**
 * The "delete every orphaned file" gate.
 *
 * This is the only control in the app that erases bytes with no trash step, so
 * the confirmation is the last thing standing between a mis-click and a
 * permanent loss. It must be strict about what it accepts and forgiving only
 * about digit grouping.
 */
describe("confirmationMatches", () => {
  it("accepts the exact count", () => {
    expect(confirmationMatches("42", 42)).toBe(true);
  });

  it("rejects a different number — a stale dialog must not confirm", () => {
    expect(confirmationMatches("41", 42)).toBe(false);
    expect(confirmationMatches("420", 42)).toBe(false);
  });

  it("ignores the grouping a locale-formatted count carries", () => {
    // The dialog prints 8,630 / 8 630 / 8.630 depending on locale; retyping
    // what is on screen has to work.
    expect(confirmationMatches("8,630", 8630)).toBe(true);
    expect(confirmationMatches("8 630", 8630)).toBe(true);
    expect(confirmationMatches("8.630", 8630)).toBe(true);
    expect(confirmationMatches("8 630", 8630)).toBe(true);
  });

  it("tolerates surrounding whitespace from a paste", () => {
    expect(confirmationMatches("  42  ", 42)).toBe(true);
  });

  it("refuses anything that is not a plain number", () => {
    expect(confirmationMatches("", 42)).toBe(false);
    expect(confirmationMatches("delete", 42)).toBe(false);
    expect(confirmationMatches("42 files", 42)).toBe(false);
    expect(confirmationMatches("-42", 42)).toBe(false);
    expect(confirmationMatches("4e1", 42)).toBe(false);
  });

  it("never confirms when there is nothing to delete", () => {
    // Otherwise an empty input ("" -> 0) would sail through on an empty list.
    expect(confirmationMatches("0", 0)).toBe(false);
    expect(confirmationMatches("", 0)).toBe(false);
  });

  it("refuses a nonsensical count instead of throwing", () => {
    expect(confirmationMatches("1", Number.NaN)).toBe(false);
    expect(confirmationMatches("1", -1)).toBe(false);
  });
});

/**
 * Storage keys are stored with forward slashes on every platform. The disk walk
 * hands back native separators — without normalising, the Windows scan would
 * report every single file as unreferenced.
 */
describe("normalizeKey", () => {
  it("leaves a canonical key alone", () => {
    expect(normalizeKey("alicja/quick-fox-42.png")).toBe("alicja/quick-fox-42.png");
  });

  it("converts native separators to forward slashes", () => {
    expect(normalizeKey(["alicja", "quick-fox-42.png"].join(sep))).toBe("alicja/quick-fox-42.png");
  });

  it("strips a leading ./ or / so both spellings compare equal", () => {
    expect(normalizeKey("./alicja/a.png")).toBe("alicja/a.png");
    expect(normalizeKey("/alicja/a.png")).toBe("alicja/a.png");
  });
});

describe("toStorageKey", () => {
  const root = resolve("/srv/modlight/storage");

  it("returns the key a database row would hold", () => {
    expect(toStorageKey(root, join(root, "alicja", "quick-fox-42.png"))).toBe(
      "alicja/quick-fox-42.png",
    );
  });

  it("handles a nested thumbnail path", () => {
    expect(toStorageKey(root, join(root, "thumbs", "alicja", "quick-fox-42.webp"))).toBe(
      "thumbs/alicja/quick-fox-42.webp",
    );
  });

  it("refuses a path outside the root rather than inventing a key", () => {
    // A key computed from the wrong root would miss every known entry and the
    // scan would report the whole disk as garbage.
    expect(toStorageKey(root, resolve("/srv/modlight/tus/incoming.bin"))).toBeNull();
  });

  it("is not fooled by a sibling directory that shares the prefix", () => {
    expect(toStorageKey(root, resolve("/srv/modlight/storage-old/a.png"))).toBeNull();
  });

  it("returns null for the root itself", () => {
    expect(toStorageKey(root, root)).toBeNull();
  });

  it("tolerates a root handed over with a trailing separator", () => {
    expect(toStorageKey(root + sep, join(root, "alicja", "a.png"))).toBe("alicja/a.png");
  });
});
