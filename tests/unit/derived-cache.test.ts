import { describe, it, expect } from "vitest";
import {
  contentHash,
  DERIVED_PREFIX,
  derivedKey,
  derivedPrefixFor,
  mayCacheDerived,
} from "@/lib/media/derived-cache";

const UPLOAD = "6f1c0f2e-0f3a-4a1a-9d3e-2f0d8c9a1b22";

describe("where a derived file lives", () => {
  it("never lands under a user's tag, so it can never count against a quota", () => {
    // Quota is users.used_quota, maintained from uploads.size on insert and
    // delete. A key outside every upload's storage key is unreachable by that
    // arithmetic - which is the whole mechanism, not a convention.
    const key = derivedKey(UPLOAD, contentHash(Buffer.from("x")), "png", "png");
    expect(key.startsWith(`${DERIVED_PREFIX}/`)).toBe(true);
    expect(key.startsWith(derivedPrefixFor(UPLOAD))).toBe(true);
  });

  it("groups everything for one upload under one prefix, so cleanup is one call", () => {
    const hash = contentHash(Buffer.from("x"));
    for (const variant of ["png", "pdf", "webp-anim", "avif"]) {
      expect(derivedKey(UPLOAD, hash, variant, variant.split("-")[0]).startsWith(
        derivedPrefixFor(UPLOAD),
      )).toBe(true);
    }
    expect(derivedPrefixFor(UPLOAD).endsWith("/")).toBe(true);
  });

  it("addresses the content, so different bytes and different targets never collide", () => {
    const a = contentHash(Buffer.from("one"));
    const b = contentHash(Buffer.from("two"));
    expect(a).not.toBe(b);
    expect(derivedKey(UPLOAD, a, "png", "png")).not.toBe(derivedKey(UPLOAD, b, "png", "png"));
    // "keeps animation" and "one frame" are different outputs of the same target.
    expect(derivedKey(UPLOAD, a, "webp", "webp")).not.toBe(
      derivedKey(UPLOAD, a, "webp-anim", "webp"),
    );
  });

  it("is stable for the same input, or nothing would ever hit", () => {
    const h = contentHash(Buffer.from("same bytes"));
    expect(derivedKey(UPLOAD, h, "pdf", "pdf")).toBe(derivedKey(UPLOAD, h, "pdf", "pdf"));
  });
});

describe("what may be cached at all", () => {
  const open = {
    published: true,
    passwordHash: null,
    expiresAt: null,
    maxViews: null,
  };

  it("caches an ordinary public file", () => {
    expect(mayCacheDerived(open)).toBe(true);
  });

  it("refuses every file whose access is gated", () => {
    // A cached derivative is a copy that outlives the gate: it would still be on
    // disk after the expiry, after the last permitted view, and for a password
    // nobody has to enter again. Refusing them is also what makes "clean up with
    // the source" exact - an expiry deletes no row, so there is nothing left to
    // chase.
    expect(mayCacheDerived({ ...open, published: false })).toBe(false);
    expect(mayCacheDerived({ ...open, passwordHash: "scrypt$..." })).toBe(false);
    expect(mayCacheDerived({ ...open, expiresAt: new Date(Date.now() + 60_000) })).toBe(false);
    expect(mayCacheDerived({ ...open, maxViews: 1 })).toBe(false);
  });
});
