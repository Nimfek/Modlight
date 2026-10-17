import { describe, it, expect } from "vitest";
import {
  DEFAULT_PER_PAGE,
  MAX_PAGE,
  MAX_PER_PAGE,
  parseUploadQuery,
  type UploadQuery,
} from "@/lib/data/upload-query";

/**
 * The query string of GET /api/uploads, which a desktop client writes and this
 * server has to survive.
 *
 * Everything pinned here is a value that ends up in a SQL clause, so the tests
 * are about what must never reach one - not about parsing for its own sake.
 */

const q = (search: string): UploadQuery => parseUploadQuery(new URLSearchParams(search));

describe("parseUploadQuery", () => {
  it("defaults to the first page of the panel's page size", () => {
    expect(q("")).toMatchObject({ page: 1, perPage: DEFAULT_PER_PAGE, sort: "newest" });
  });

  it("turns a non-numeric page or perPage into the default, never NaN", () => {
    // This is the one that would be a 500. `Math.max(1, Number("abc"))` is NaN,
    // NaN survives every clamp, and `LIMIT NaN` reaches Postgres as 22P02.
    for (const bad of ["abc", "1e999", "-Infinity", "null", "{}"]) {
      const parsed = q(`page=${bad}&perPage=${bad}`);
      expect(Number.isSafeInteger(parsed.page)).toBe(true);
      expect(Number.isSafeInteger(parsed.perPage)).toBe(true);
    }
  });

  it("reads an EMPTY parameter as absent rather than as zero", () => {
    // `Number("")` is 0, so the obvious implementation clamps `?perPage=` up to
    // a one-item page - and any HTTP client whose config field is left blank
    // sends exactly that.
    expect(q("page=&perPage=")).toMatchObject({ page: 1, perPage: DEFAULT_PER_PAGE });
  });

  it("floors fractions and refuses to go below page 1", () => {
    expect(q("page=2.9&perPage=10.5")).toMatchObject({ page: 2, perPage: 10 });
    expect(q("page=0&perPage=0")).toMatchObject({ page: 1, perPage: 1 });
    expect(q("page=-5")).toMatchObject({ page: 1 });
  });

  it("caps the page number, not just perPage", () => {
    // `page` reads as harmless because it is only ever multiplied - and the
    // product is what reaches Postgres, as `OFFSET (page - 1) * perPage`.
    // node-postgres serialises a parameter with `toString()`, so page 1e30
    // arrives as the literal "3e+31" and Postgres answers 22P02, i.e. a 500 out
    // of the driver. Finite is not the same as usable: the test above passes
    // only because "1e999" parses to Infinity, and the exponent one digit below
    // that slips through every check it makes.
    for (const huge of ["1e30", "1e21", "999999999999999999999999", String(Number.MAX_SAFE_INTEGER)]) {
      const { page, perPage } = q(`page=${huge}`);
      expect(page).toBe(MAX_PAGE);
      // The whole point: the offset has to survive `toString()` as digits.
      expect(String((page - 1) * perPage)).toMatch(/^\d+$/);
    }
  });

  it("caps perPage at the shared ceiling", () => {
    // 8733 uploads sit on one production account. Without this, one request can
    // ask the server to build all of them into a single JSON response.
    expect(q("perPage=100000").perPage).toBe(MAX_PER_PAGE);
    expect(q(`perPage=${MAX_PER_PAGE + 1}`).perPage).toBe(MAX_PER_PAGE);
  });

  it("ignores a sort or kind this deployment does not know", () => {
    // Not an error on purpose: a newer client asking for a key we have not
    // shipped yet should still see its files, just ordered the default way.
    expect(q("sort=DROP TABLE uploads").sort).toBe("newest");
    expect(q("kind=../../etc/passwd").kind).toBeUndefined();
    expect(q("sort=largest&kind=video")).toMatchObject({ sort: "largest", kind: "video" });
  });

  it("only treats the literal 1 as 'list the trash'", () => {
    // Same spelling the panel's own toggles use, so "trashed=0" or "trashed=false"
    // cannot accidentally hide somebody's whole library behind the bin.
    expect(q("trashed=1").trashed).toBe(true);
    expect(q("trashed=0").trashed).toBe(false);
    expect(q("trashed=true").trashed).toBe(false);
    expect(q("").trashed).toBe(false);
  });

  it("passes the folder id through untouched, sentinel included", () => {
    // Validation belongs to resolveFolderTarget, which has the caller's id and
    // the database. What matters here is that the sentinel is not swallowed and
    // a blank value does not become a filter for "files in folder ''".
    expect(q("folderId=root").folder).toBe("root");
    expect(q("folderId=  ").folder).toBeUndefined();
    expect(q("").folder).toBeUndefined();
    expect(q("folderId=6f1e2b3c-4d5a-4e6f-8a9b-0c1d2e3f4a5b").folder).toBe(
      "6f1e2b3c-4d5a-4e6f-8a9b-0c1d2e3f4a5b",
    );
  });

  it("bounds the search needle", () => {
    // The needle goes inside an ILIKE '%…%' over every row the account owns, and
    // it costs the client nothing to send a megabyte of it.
    expect(q(`search=${"a".repeat(5000)}`).search).toHaveLength(200);
    expect(q("search=%20%20").search).toBeUndefined();
    expect(q("search=  screenshot  ").search).toBe("screenshot");
  });
});
