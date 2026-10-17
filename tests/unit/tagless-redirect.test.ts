import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(process.cwd(), "app/[userCode]/[mediaCode]/page.tsx"),
  "utf8",
);

/**
 * The tagless redirect has to carry the query string.
 *
 * Read from the source, in the style of `uploads-api-delete.test.ts`, because
 * the function is private to a page module and exporting it just to test it
 * would put a non-Next export on a route file.
 *
 * This is pinned because the failure was invisible: `/{code}/raw.png?w=64`
 * returned 200 with the FULL original instead of a 312-byte tile, and nothing
 * logged an error. A client drawing a grid of thumbnails would have pulled
 * gigabytes and looked like it was merely slow.
 */
describe("tagless action redirect", () => {
  it("takes the query and appends it to the canonical path", () => {
    const fn = source.match(/async function taglessActionRedirect[\s\S]+?\n}/)?.[0] ?? "";
    expect(fn).not.toBe("");
    // A third parameter carrying the parsed query.
    expect(fn).toMatch(/query: Record<string, string \| string\[\] \| undefined>/);
    // And the returned path actually ends with it.
    expect(fn).toContain("${second}${suffix}");
  });

  it("passes the request's query into it, rather than dropping it", () => {
    const page = source.slice(source.indexOf("export default async function MediaPage"));
    expect(page).toContain("searchParams ? await searchParams : {}");
    expect(page).toMatch(/taglessActionRedirect\(userCode, mediaCode, query\)/);
  });

  it("rebuilds the query instead of splicing a caller's string into the path", () => {
    const fn = source.match(/async function taglessActionRedirect[\s\S]+?\n}/)?.[0] ?? "";
    // URLSearchParams re-encodes every value, so nothing a caller appends can
    // introduce a second `?`, a `#`, or another path segment into the target.
    expect(fn).toContain("new URLSearchParams()");
  });
});
