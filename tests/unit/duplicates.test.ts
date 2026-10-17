import { describe, it, expect, vi } from "vitest";

/**
 * Retroactive duplicate detection: the two decisions that can destroy a file.
 *
 * The bucketing decides WHICH rows are called copies of each other, and the
 * selection decides which of those a click sends to the trash. Everything
 * between them is SQL and React. These are the parts worth pinning.
 *
 * The database is stubbed because none of this touches it: the aggregate query
 * lives in `scanDuplicates`, and what is exercised here are the pure functions
 * around it.
 */
vi.mock("@/lib/db", () => ({ db: {} }));

const { PgDialect } = await import("drizzle-orm/pg-core");
const {
  bucketByChecksum,
  duplicateAggregateQuery,
  hasUsableChecksum,
  parseUploadIds,
  MAX_GROUPS,
  MAX_ROWS,
  MAX_TRASH_IDS,
} = await import("@/lib/data/duplicates");
const { defaultSelection, keepsACopy, selectedIds, selectionTotals, toggleSelection } =
  await import("@/components/profile/duplicate-selection");

type Row = Parameters<typeof bucketByChecksum>[0][number];

const url = (code: string, ext: string) => `https://host.example/u/${code}.${ext}`;

let seq = 0;
function row(over: Partial<Row> = {}): Row {
  seq++;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    code: `code${seq}`,
    filename: `file${seq}.png`,
    ext: "png",
    mimeType: "image/png",
    size: 1000,
    createdAt: new Date(2026, 0, seq),
    folderId: null,
    folderName: null,
    views: 0,
    downloads: 0,
    checksum: "a".repeat(64),
    ...over,
  };
}

describe("the grouped aggregate", () => {
  const built = new PgDialect().sqlToQuery(duplicateAggregateQuery("user-1"));
  const text = built.sql.replace(/\s+/g, " ");

  it("groups in SQL rather than in Node", () => {
    // The live server holds 8735 uploads. Reading them all in to count them
    // would pull the table across the wire to answer a question one grouped
    // scan answers in the database.
    expect(text).toContain('group by "uploads"."checksum"');
    expect(text).toContain("having count(*) > 1");
  });

  it("excludes rows with no checksum, in the query itself", () => {
    // The rule this whole feature stands on. Enforced here AND in the bucketing
    // below, because losing it in either place turns "find duplicates" into
    // "offer to delete the entire imported library".
    expect(text).toContain('"uploads"."checksum" is not null');
    expect(text).toContain('length("uploads"."checksum") > 0');
  });

  it("leaves the trash alone", () => {
    expect(text).toContain('"uploads"."deleted_at" is null');
  });

  it("scopes to one account, as a bound parameter", () => {
    expect(text).toContain('"uploads"."owner_id" = $1');
    expect(built.params).toEqual(["user-1", MAX_GROUPS]);
  });

  it("never casts a byte total to int4", () => {
    // A library over 2 GB overflows int4, and this one passed that years ago.
    // Only the counts are ints; bytes stay bigint and arrive as strings.
    expect(text).toContain("sum(\"uploads\".\"size\")::bigint as bytes");
    expect(text).toContain("(sum(bytes - keep) over ())::bigint as total_reclaimable");
  });

  it("computes the totals with window functions, which run before the LIMIT", () => {
    // This is what lets a capped list still report the whole library's saving.
    expect(text).toContain("(count(*) over ())::int as total_groups");
    expect(text).toContain("limit $2");
  });
});

describe("grouping by checksum", () => {
  it("never groups rows that have no checksum", () => {
    // The reason this feature is dangerous at all. Every row written before
    // checksums were recorded stores NULL here, and if NULL matched NULL the
    // scan would report that whole library as one set
    // of identical files and offer to delete all but the first of them.
    const groups = bucketByChecksum(
      [
        row({ checksum: null }),
        row({ checksum: null }),
        row({ checksum: null }),
        row({ checksum: "" }),
        row({ checksum: "   " }),
      ],
      url,
    );
    expect(groups).toEqual([]);
  });

  it("keeps a checksummed pair while ignoring the checksumless rows beside it", () => {
    const groups = bucketByChecksum(
      [row({ checksum: null }), row({ checksum: "b".repeat(64) }), row({ checksum: "b".repeat(64) })],
      url,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].copies).toBe(2);
  });

  it("drops a checksum that only appears once", () => {
    // One copy is not a duplicate. This is what stops a group of two from
    // becoming a group of one - and an offer to delete it - when the other copy
    // is trashed between the aggregate and the row fetch.
    const groups = bucketByChecksum([row({ checksum: "c".repeat(64) })], url);
    expect(groups).toEqual([]);
  });

  it("puts the oldest copy first, whatever order the rows arrive in", () => {
    // Position 0 is not cosmetic: it is the copy the default selection keeps.
    const newest = row({ createdAt: new Date(2026, 5, 1), code: "newest" });
    const oldest = row({ createdAt: new Date(2020, 0, 1), code: "oldest" });
    const middle = row({ createdAt: new Date(2023, 0, 1), code: "middle" });

    const [group] = bucketByChecksum([newest, oldest, middle], url);
    expect(group.files.map((f) => f.code)).toEqual(["oldest", "middle", "newest"]);
  });

  it("breaks a timestamp tie by id, so the same library scans the same way twice", () => {
    const at = new Date(2024, 3, 3);
    const a = row({ createdAt: at, id: "00000000-0000-4000-8000-00000000000a", code: "a" });
    const b = row({ createdAt: at, id: "00000000-0000-4000-8000-00000000000b", code: "b" });

    expect(bucketByChecksum([b, a], url)[0].files.map((f) => f.code)).toEqual(["a", "b"]);
    expect(bucketByChecksum([a, b], url)[0].files.map((f) => f.code)).toEqual(["a", "b"]);
  });

  it("reports what deleting wins, keeping one copy", () => {
    const files = [row({ size: 500 }), row({ size: 500 }), row({ size: 500 })];
    const [group] = bucketByChecksum(files, url);
    expect(group.bytes).toBe(1500);
    expect(group.size).toBe(500);
    expect(group.reclaimable).toBe(1000);
  });

  it("orders the biggest saving first", () => {
    const small = "1".repeat(64);
    const big = "2".repeat(64);
    const groups = bucketByChecksum(
      [
        row({ checksum: small, size: 10 }),
        row({ checksum: small, size: 10 }),
        row({ checksum: big, size: 900 }),
        row({ checksum: big, size: 900 }),
      ],
      url,
    );
    expect(groups.map((g) => g.checksum)).toEqual([big, small]);
  });

  it("trusts the aggregate for the copy count when the row list was trimmed", () => {
    // A group can hold more copies than were fetched (MAX_ROWS / MAX_COPIES_LISTED).
    // The count has to describe the library, not the page, or "frees 4 GB" would
    // be a number about a list rather than about the files.
    const checksum = "d".repeat(64);
    const groups = bucketByChecksum(
      [row({ checksum, size: 100 }), row({ checksum, size: 100 })],
      url,
      new Map([[checksum, { copies: 9, bytes: 900 }]]),
    );
    expect(groups[0].copies).toBe(9);
    expect(groups[0].bytes).toBe(900);
    expect(groups[0].files).toHaveLength(2);
  });

  it("builds each file's public link from its own code and extension", () => {
    const [group] = bucketByChecksum([row({ code: "abc", ext: "mp4" }), row()], url);
    expect(group.files.map((f) => f.url)).toContain("https://host.example/u/abc.mp4");
  });
});

describe("hasUsableChecksum", () => {
  it("rejects everything that is not a real digest", () => {
    expect(hasUsableChecksum(null)).toBe(false);
    expect(hasUsableChecksum(undefined)).toBe(false);
    expect(hasUsableChecksum("")).toBe(false);
    expect(hasUsableChecksum("  ")).toBe(false);
    expect(hasUsableChecksum("a".repeat(64))).toBe(true);
  });
});

describe("the id list a client may hand to the delete", () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  it("refuses anything that is not a uuid", () => {
    // uploads.id is a uuid column, so a non-uuid makes Postgres raise
    // `invalid input syntax for type uuid`. Thrown from a Server Action, that
    // message is masked in production and the caller learns nothing at all.
    expect(parseUploadIds(["not-an-id"])).toEqual({ ok: false, issue: "malformed" });
    expect(parseUploadIds([id(1), "1; drop table uploads"])).toEqual({
      ok: false,
      issue: "malformed",
    });
  });

  it("refuses an empty list rather than running an unbounded delete", () => {
    expect(parseUploadIds([])).toEqual({ ok: false, issue: "empty" });
  });

  it("collapses repeats so a double click cannot inflate the count", () => {
    const result = parseUploadIds([id(1), id(1), id(2)]);
    expect(result).toEqual({ ok: true, ids: [id(1), id(2)] });
  });

  it("caps the batch", () => {
    const many = Array.from({ length: MAX_TRASH_IDS + 1 }, (_, i) => id(i));
    expect(parseUploadIds(many)).toEqual({ ok: false, issue: "too-many" });
  });

  it("accepts everything the scan itself can propose", () => {
    // The cap and the scan's row limit answer the same question from opposite
    // ends, and a gap between them is a dead end: the default selection is
    // every copy but the oldest of each group, i.e. up to MAX_ROWS - MAX_GROUPS
    // ids, and at a cap of 1000 the action refused its own recommendation with
    // "too many files" on any library large enough to reach it. The only way
    // forward was unticking hundreds of boxes by hand.
    const proposal = MAX_ROWS - MAX_GROUPS;
    expect(proposal).toBeLessThanOrEqual(MAX_TRASH_IDS);
    expect(parseUploadIds(Array.from({ length: proposal }, (_, i) => id(i))).ok).toBe(true);
  });
});

// ── The selection the UI proposes ──────────────────────────────────────────

const group = (checksum: string, sizes: number[], copies?: number) =>
  bucketByChecksum(
    sizes.map((size, i) => row({ checksum, size, createdAt: new Date(2026, 0, i + 1) })),
    url,
    copies ? new Map([[checksum, { copies, bytes: sizes.reduce((a, b) => a + b, 0) }]]) : undefined,
  )[0];

describe("default selection", () => {
  it("keeps the oldest copy of every set and marks the rest", () => {
    // The oldest is the copy the links already in circulation point at; a later
    // copy is what happens when somebody re-uploads what they already had.
    const groups = [group("e".repeat(64), [10, 10, 10]), group("f".repeat(64), [20, 20])];
    const selected = defaultSelection(groups);

    expect(selected.has(groups[0].files[0].id)).toBe(false);
    expect(selected.has(groups[1].files[0].id)).toBe(false);
    expect(selected.size).toBe(3);
  });

  it("always leaves every set holding a copy", () => {
    const groups = [group("e".repeat(64), [10, 10, 10]), group("f".repeat(64), [20, 20])];
    const selected = defaultSelection(groups);
    for (const g of groups) expect(keepsACopy(g, selected)).toBe(true);
  });

  it("selects nothing when there is nothing to de-duplicate", () => {
    expect(defaultSelection([]).size).toBe(0);
  });
});

describe("selection totals", () => {
  it("sums the files the user actually ticked, not the recommendation", () => {
    // Unticking one copy has to move the headline number, or the page is
    // advertising a saving the button will not deliver.
    const g = group("e".repeat(64), [100, 100, 100]);
    const selected = defaultSelection([g]);
    expect(selectionTotals([g], selected)).toEqual({ files: 2, bytes: 200, emptied: 0 });

    const fewer = toggleSelection(selected, g.files[2].id);
    expect(selectionTotals([g], fewer)).toEqual({ files: 1, bytes: 100, emptied: 0 });
  });

  it("counts a set whose every copy is ticked, so the UI can say so", () => {
    const g = group("e".repeat(64), [100, 100]);
    const all = new Set(g.files.map((f) => f.id));
    expect(selectionTotals([g], all).emptied).toBe(1);
    expect(keepsACopy(g, all)).toBe(false);
  });

  it("does not call a trimmed set emptied: its unlisted copies survive", () => {
    const g = group("e".repeat(64), [100, 100], 7);
    const all = new Set(g.files.map((f) => f.id));
    expect(selectionTotals([g], all).emptied).toBe(0);
    expect(keepsACopy(g, all)).toBe(true);
  });
});

describe("selectedIds", () => {
  it("returns only ids that belong to a listed file", () => {
    // The set can outlive the list it was built from - a re-scan replaces the
    // groups - and a stale id would be a delete aimed at a row the user can no
    // longer see.
    const g = group("e".repeat(64), [1, 1]);
    const stale = new Set([g.files[1].id, "00000000-0000-4000-8000-999999999999"]);
    expect(selectedIds([g], stale)).toEqual([g.files[1].id]);
  });

  it("keeps group order, so the deletion follows what is on screen", () => {
    const a = group("1".repeat(64), [900, 900]);
    const b = group("2".repeat(64), [10, 10]);
    const selected = defaultSelection([a, b]);
    expect(selectedIds([a, b], selected)).toEqual([a.files[1].id, b.files[1].id]);
  });
});

describe("toggleSelection", () => {
  it("returns a new set both ways, so React sees the change", () => {
    const before: ReadonlySet<string> = new Set(["x"]);
    const removed = toggleSelection(before, "x");
    const added = toggleSelection(removed, "x");
    expect(removed).not.toBe(before);
    expect(removed.has("x")).toBe(false);
    expect(added.has("x")).toBe(true);
  });
});
