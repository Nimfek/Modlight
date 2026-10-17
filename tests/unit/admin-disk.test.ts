import { describe, it, expect } from "vitest";
import { foldKinds, rankAccounts, type OwnerGroup, type TypeGroup } from "@/lib/data/admin-disk";

/**
 * The two folds behind the admin disk breakdown.
 *
 * Both exist because SQL is the wrong place for them: the kind of a file
 * follows from `effectiveType` (a rule the app owns, not the database), and the
 * account tail has to be summed rather than dropped. Neither is testable
 * through the query, so both are pure and tested here.
 */

const g = (mimeType: string, ext: string | null, files: number, bytes: number): TypeGroup => ({
  mimeType,
  ext,
  files,
  bytes,
});

describe("foldKinds", () => {
  it("sums the (type, extension) groups the database returns", () => {
    const kinds = foldKinds([
      g("image/png", "png", 3, 300),
      g("image/jpeg", "jpg", 2, 200),
      g("video/mp4", "mp4", 1, 5000),
    ]);
    expect(kinds).toEqual([
      { kind: "video", files: 1, bytes: 5000 },
      { kind: "image", files: 5, bytes: 500 },
    ]);
  });

  it("believes the extension when the stored type says nothing", () => {
    // Round 7: ShareX sends application/octet-stream for anything Windows has
    // no registry entry for, and .avif is exactly that. Splitting mime_type on
    // "/" in SQL would file every one of those rows under "other" and the
    // operator would be told their images are an unknown blob.
    const kinds = foldKinds([g("application/octet-stream", "avif", 4, 4000)]);
    expect(kinds).toEqual([{ kind: "image", files: 4, bytes: 4000 }]);
  });

  it("does not let an extension override a type that does say something", () => {
    const kinds = foldKinds([g("video/mp4", "png", 1, 10)]);
    expect(kinds[0].kind).toBe("video");
  });

  it("orders by bytes, heaviest first", () => {
    const kinds = foldKinds([
      g("text/plain", "txt", 900, 10),
      g("application/pdf", "pdf", 1, 900),
      g("application/zip", "zip", 2, 400),
    ]);
    expect(kinds.map((k) => k.kind)).toEqual(["pdf", "archive", "text"]);
  });

  it("is empty for an empty install rather than a zero row", () => {
    expect(foldKinds([])).toEqual([]);
  });
});

const o = (
  ownerId: string | null,
  liveBytes: number,
  trashedBytes = 0,
  files = 1,
): OwnerGroup => ({
  ownerId,
  liveFiles: files,
  liveBytes,
  trashedFiles: trashedBytes > 0 ? 1 : 0,
  trashedBytes,
});

const totalBytes = (rows: { liveBytes: number; trashedBytes: number }[]) =>
  rows.reduce((sum, r) => sum + r.liveBytes + r.trashedBytes, 0);

describe("rankAccounts", () => {
  it("orders by everything the account occupies, trash included", () => {
    const ranked = rankAccounts([o("a", 100), o("b", 10, 500), o("c", 200)]);
    expect(ranked.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("folds the tail instead of dropping it, so the column still adds up", () => {
    // A breakdown that does not reconcile with the total on the card above is
    // worse than no breakdown: the operator cannot tell which number is wrong.
    const groups = [o("a", 500), o("b", 400), o("c", 300), o("d", 200), o("e", 100)];
    const ranked = rankAccounts(groups, 2);
    expect(ranked).toHaveLength(3);
    expect(totalBytes(ranked)).toBe(totalBytes(groups));

    const rest = ranked.at(-1)!;
    expect(rest.rest).toBe(true);
    expect(rest.accounts).toBe(3);
    expect(rest.liveBytes).toBe(600);
    expect(rest.liveFiles).toBe(3);
  });

  it("keeps the ownerless group separate wherever it lands", () => {
    // Those bytes belong to nobody, which is the entire reason they need
    // looking at; folding them into a named account would hide them.
    const ranked = rankAccounts([o("a", 10), o(null, 900)], 1);
    expect(ranked[0]).toMatchObject({ id: null, orphaned: true, rest: false, liveBytes: 900 });
    expect(ranked.at(-1)).toMatchObject({ rest: true, accounts: 1, liveBytes: 10 });
  });

  it("adds no fold row when everything already fits", () => {
    const ranked = rankAccounts([o("a", 10), o("b", 20)], 6);
    expect(ranked).toHaveLength(2);
    expect(ranked.some((r) => r.rest)).toBe(false);
    expect(ranked.every((r) => r.accounts === 1)).toBe(true);
  });

  it("returns nothing for an install with no files", () => {
    expect(rankAccounts([])).toEqual([]);
  });
});
