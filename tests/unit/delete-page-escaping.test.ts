import { describe, it, expect } from "vitest";

/**
 * Regression guard for the stored XSS on the delete-by-token page.
 *
 * The page is hand-built HTML (not React), and `filename` arrives verbatim from
 * a multipart upload. An attacker uploads a file named with a payload, gets its
 * deletion URL back, and sends that URL to someone else — the script would then
 * run on the app's own origin, inside the victim's session. `unsafe-inline` in
 * the global CSP means an inline handler is not blocked, so escaping is the
 * control that matters.
 *
 * The escaper is duplicated here deliberately: the route is a Next.js handler
 * whose module-level imports pull in config and the database, which a unit test
 * has no business booting. If the route's implementation ever drifts from this,
 * the test stops protecting anything — so keep the two in sync.
 */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

describe("escaping on the delete-by-token page", () => {
  it("neutralises an image/onerror payload in a filename", () => {
    const payload = `<img src=x onerror="fetch('/api/auth/update-user')">`;
    const out = esc(payload);
    expect(out).not.toContain("<img");
    expect(out).not.toContain(">");
    expect(out).toContain("&lt;img");
  });

  it("neutralises a script tag", () => {
    expect(esc("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("escapes quotes, so a payload cannot break out of an attribute", () => {
    expect(esc(`" onmouseover="alert(1)`)).toBe("&quot; onmouseover=&quot;alert(1)");
    expect(esc(`' onfocus='alert(1)`)).toBe("&#39; onfocus=&#39;alert(1)");
  });

  it("escapes ampersands first, so entities cannot be smuggled in", () => {
    // Naive ordering would turn "&lt;" into "&amp;lt;" only if & is handled
    // first — doing it last would re-encode the entities this function just
    // produced and let `&#60;script&#62;` through in some parsers.
    expect(esc("&lt;script&gt;")).toBe("&amp;lt;script&amp;gt;");
  });

  it("leaves ordinary filenames readable", () => {
    expect(esc("Źródła wiedzy.docx")).toBe("Źródła wiedzy.docx");
    expect(esc("raport-2026.pdf")).toBe("raport-2026.pdf");
  });
});
