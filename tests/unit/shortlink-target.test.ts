import { describe, it, expect, vi } from "vitest";

/**
 * The two pure decisions behind minting a short link.
 *
 * They matter more than they used to: `POST /api/shortlinks` reaches them with a
 * body a desktop client wrote, where the panel reached them through a form. The
 * value of extracting them was that both callers get the same answer, so this is
 * where that answer gets pinned.
 *
 * The database is stubbed — nothing here touches it, which is the point.
 */

vi.mock("@/lib/db", () => ({ db: {} }));

const { normalizeTarget, expiryFromDays } = await import("@/lib/shortlinks");

describe("short link target", () => {
  it("refuses script-bearing schemes", () => {
    // The whole reason this function exists. A shortener that will redirect to
    // `javascript:` runs script on whichever domain serves the redirect, and the
    // scheme test is case-insensitive because nothing says an attacker types in
    // lower case.
    for (const bad of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "ftp://example.com/x",
    ]) {
      expect(normalizeTarget(bad)).toBeNull();
    }
  });

  it("refuses a scheme hidden behind leading whitespace", () => {
    // The trim happens before the scheme test, not after. Reversed, a single
    // leading space would carry `javascript:` straight past the check.
    expect(normalizeTarget("  javascript:alert(1)")).toBeNull();
    expect(normalizeTarget("\njavascript:alert(1)")).toBeNull();
  });

  it("refuses a scheme split by characters the URL parser strips", () => {
    // WHATWG URL parsing deletes tabs and newlines from its input, so
    // `java\tscript:` becomes `javascript:` INSIDE the parser. This is the
    // classic bypass of a scheme check that runs before parsing. It survives
    // here only because an input with no recognised scheme is prefixed with
    // `https://` first, which makes the leftover colon a port and unparseable.
    expect(normalizeTarget("java\tscript:alert(1)")).toBeNull();
    expect(normalizeTarget("java\nscript:alert(1)")).toBeNull();
  });

  it("promotes a bare host to https, never to http", () => {
    // Defaulting to plaintext would silently downgrade every link somebody
    // pasted without typing a scheme.
    expect(normalizeTarget("google.pl")).toBe("https://google.pl/");
    expect(normalizeTarget("www.google.pl/a?b=c")).toBe("https://www.google.pl/a?b=c");
    // An explicit http:// target is the caller's choice and is left alone.
    expect(normalizeTarget("http://example.com/x")).toBe("http://example.com/x");
  });

  it("refuses a single-label host that is not localhost", () => {
    // Almost always a typo, and shortening to nowhere helps no one.
    expect(normalizeTarget("notaurl")).toBeNull();
    expect(normalizeTarget("")).toBeNull();
    expect(normalizeTarget("   ")).toBeNull();
    expect(normalizeTarget("http://localhost:3000/x")).toBe("http://localhost:3000/x");
  });

  it("caps the raw target before doing any work on it", () => {
    // `short_links.target` is a `text` column, so Postgres has no opinion about
    // a megabyte-long redirect target. Behind a form that was theoretical;
    // behind a token-authenticated POST it is not. The cap is generous enough
    // for real URLs - a signed S3 link runs to about 1.5 KiB.
    expect(normalizeTarget(`https://example.com/${"a".repeat(3000)}`)).not.toBeNull();
    expect(normalizeTarget(`https://example.com/${"a".repeat(5000)}`)).toBeNull();
  });
});

describe("short link expiry", () => {
  it("never produces an Invalid Date, however big the number", () => {
    // `Date.now() + 1e308 * 86_400_000` is Infinity and `new Date(Infinity)` is
    // an Invalid Date, which Postgres rejects - and the insert's catch used to
    // report every failure as `code-taken`, which would send a client off to
    // pick a different code for a problem that was never about the code.
    for (const huge of [1e308, Number.MAX_VALUE, 10 ** 15]) {
      const at = expiryFromDays(huge);
      expect(at).toBeInstanceOf(Date);
      expect(Number.isNaN(at!.getTime())).toBe(false);
    }
  });

  it("treats a non-positive or non-finite count as 'never expires'", () => {
    // A negative day count used to be truthy, so it minted a link that was
    // already dead. No dropdown can produce one and nobody means it.
    for (const none of [0, -1, -365, NaN, Infinity, -Infinity, null, undefined]) {
      expect(expiryFromDays(none as number)).toBeNull();
    }
  });

  it("keeps an ordinary expiry exact", () => {
    const before = Date.now();
    const at = expiryFromDays(7)!;
    // Allow for the clock moving between the two reads.
    expect(at.getTime() - before).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000);
    expect(at.getTime() - before).toBeLessThanOrEqual(7 * 86_400_000 + 1000);
  });
});
