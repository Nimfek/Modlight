import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The reminder and the answer to it.
 *
 * `tests/unit/duplicates.test.ts` pins the scan and the selection;
 * `duplicates-trash.test.ts` pins the delete. What is left unpinned is the half
 * of the feature that speaks without being asked, and the one thing that makes
 * that bearable: a dismissal.
 *
 * The owner's rule, in his words: if the user says they do not want those files
 * removed, never remind about them again, and count the next threshold from
 * zero. Three claims have to hold for that to be true, and each is one deleted
 * clause away from being false:
 *
 *  - the reminder counts with the dismissed sets SUBTRACTED (the anti-join),
 *    which is what "from zero" means in practice;
 *  - a dismissal is keyed on the CHECKSUM, so trashing one copy of a set does
 *    not revive the nag for its survivors and re-uploading the same bytes does
 *    not resurrect it either;
 *  - taking a dismissal back is scoped to the account that made it.
 */

const getSession = vi.fn();
const recordAudit = vi.fn(async () => {});

vi.mock("@/lib/auth-helpers", () => ({ getSession }));
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/** What each statement was handed, in the order the actions built them. */
let inserted: unknown[] = [];
let whereClauses: unknown[] = [];
let returned: unknown[] = [];

/**
 * A Drizzle builder of any shape: every method returns the same thenable, so
 * whichever chain the code happens to write is accepted. `values` and `where`
 * are the two with side effects, because what they were handed is the whole
 * question. (Same device as tests/unit/duplicates-trash.test.ts.)
 */
function chain(rows: () => unknown[]): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
            Promise.resolve(rows()).then(ok, err);
        }
        if (prop === "catch") {
          return (err: (e: unknown) => unknown) => Promise.resolve(rows()).catch(err);
        }
        if (prop === "values") {
          return (v: unknown) => {
            inserted.push(v);
            return proxy;
          };
        }
        if (prop === "where") {
          return (v: unknown) => {
            whereClauses.push(v);
            return proxy;
          };
        }
        return () => proxy;
      },
    },
  );
  return proxy;
}

vi.mock("@/lib/db", () => ({
  db: {
    select: () => chain(() => []),
    insert: () => chain(() => returned),
    update: () => chain(() => []),
    delete: () => chain(() => returned),
    execute: async () => ({ rows: [] }),
  },
}));

const { PgDialect } = await import("drizzle-orm/pg-core");
const {
  bucketByChecksum,
  duplicateReminderQuery,
  reminderDue,
  REMINDER_MIN_BYTES,
  REMINDER_MIN_REDUNDANT,
} = await import("@/lib/data/duplicates");
const { countDuplicateSetsAgain, keepDuplicateSets } = await import("@/app/actions/duplicates");
const { SNOOZE_COOKIE, SNOOZE_DAYS, isSnoozed, snoozeCookie, snoozeUntil } = await import(
  "@/components/duplicates/snooze"
);
const { dismissalsFor, keepEverything, keepOnly, keptId, splitByDismissed } = await import(
  "@/components/duplicates/selection"
);

const ME = "11111111-1111-4111-8111-111111111111";
const SHA = (c: string) => c.repeat(64);

/* -------------------------------------------------------------------------- */
/* The query the reminder is decided by                                        */
/* -------------------------------------------------------------------------- */

describe("the reminder aggregate", () => {
  const built = new PgDialect().sqlToQuery(duplicateReminderQuery("user-1"));
  const text = built.sql.replace(/\s+/g, " ");

  it("leaves out every set the owner has waved off", () => {
    // This single clause is "count the next threshold from zero". Without it a
    // dismissal changes nothing at all: the strip keeps quoting the same pile
    // the user already said they wanted to keep.
    expect(text).toContain("not exists");
    expect(text).toContain('"duplicate_dismissals"');
    expect(text).toContain('"duplicate_dismissals"."checksum" = d.checksum');
  });

  it("matches a dismissal on the owner as well as on the bytes", () => {
    // A checksum is a global fact about bytes. Matching on it alone would let
    // one account silence another account's reminder.
    expect(text).toContain('"duplicate_dismissals"."owner_id" = d.owner_id');
  });

  it("carries the same three safety clauses as the full scan", () => {
    expect(text).toContain('"uploads"."checksum" is not null');
    expect(text).toContain('length("uploads"."checksum") > 0');
    expect(text).toContain('"uploads"."deleted_at" is null');
    expect(text).toContain("having count(*) > 1");
  });

  it("scopes to one account, as a bound parameter, and asks for no rows", () => {
    expect(text).toContain('"uploads"."owner_id" = $1');
    expect(built.params).toEqual(["user-1"]);
    // One row out, whatever the library holds: this runs on every panel load.
    expect(text).toContain("count(*)::int as groups");
    expect(text).not.toContain("limit");
  });

  it("never casts a byte total to int4", () => {
    expect(text).toContain("::bigint as reclaimable");
  });
});

describe("when the reminder is allowed to speak", () => {
  const totals = (redundant: number, reclaimable: number) => ({
    groups: 1,
    redundant,
    reclaimable,
  });

  it("says nothing at either threshold exactly", () => {
    // Both rules are "more than": ten redundant copies is silence, the eleventh
    // speaks. A threshold that fires ON the number is a threshold nobody can
    // confirm against the sentence beside it.
    expect(reminderDue(totals(REMINDER_MIN_REDUNDANT, 0))).toBe(false);
    expect(reminderDue(totals(0, REMINDER_MIN_BYTES))).toBe(false);
  });

  it("speaks one file over, or one byte over", () => {
    expect(reminderDue(totals(REMINDER_MIN_REDUNDANT + 1, 0))).toBe(true);
    expect(reminderDue(totals(0, REMINDER_MIN_BYTES + 1))).toBe(true);
  });

  it("measures a gigabyte the way the panel prints one", () => {
    // humanFileSize divides by 1024, and so does the quota card. A threshold
    // written in 1000s would read as "1.07 GB" next to the number that tripped it.
    expect(REMINDER_MIN_BYTES).toBe(1024 ** 3);
  });

  it("stays quiet on an empty library", () => {
    expect(reminderDue(totals(0, 0))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* "Not now": the cookie                                                       */
/* -------------------------------------------------------------------------- */

describe("the snooze", () => {
  const NOW = Date.UTC(2026, 7, 19, 12, 0, 0);

  it("holds for exactly as long as it says, then lapses", () => {
    const value = String(snoozeUntil(NOW));
    expect(isSnoozed(value, NOW)).toBe(true);
    expect(isSnoozed(value, NOW + SNOOZE_DAYS * 86_400_000 - 1)).toBe(true);
    expect(isSnoozed(value, NOW + SNOOZE_DAYS * 86_400_000)).toBe(false);
  });

  it("treats anything unreadable as not snoozed", () => {
    // A hand-typed cookie must not be able to silence the reminder forever, and
    // showing a strip too often is the recoverable direction.
    expect(isSnoozed(undefined, NOW)).toBe(false);
    expect(isSnoozed(null, NOW)).toBe(false);
    expect(isSnoozed("", NOW)).toBe(false);
    expect(isSnoozed("soon", NOW)).toBe(false);
    expect(isSnoozed("Infinity", NOW)).toBe(false);
  });

  it("writes a cookie whose Max-Age agrees with the instant inside it", () => {
    const cookie = snoozeCookie(NOW);
    expect(cookie.startsWith(`${SNOOZE_COOKIE}=${snoozeUntil(NOW)};`)).toBe(true);
    expect(cookie).toContain(`Max-Age=${SNOOZE_DAYS * 86_400}`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Lax");
  });
});

/* -------------------------------------------------------------------------- */
/* Choosing what survives                                                      */
/* -------------------------------------------------------------------------- */

let seq = 0;
function group(checksum: string, sizes: number[], dismissed = false) {
  const rows = sizes.map((size, i) => {
    seq++;
    return {
      id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      code: `code${seq}`,
      filename: `file${seq}.png`,
      ext: "png",
      mimeType: "image/png",
      size,
      createdAt: new Date(2026, 0, i + 1),
      folderId: null,
      folderName: null,
      views: 0,
      downloads: 0,
      checksum,
    };
  });

  return bucketByChecksum(
    rows,
    (code, ext) => `https://host.example/u/${code}.${ext}`,
    new Map([
      [checksum, { copies: sizes.length, bytes: sizes.reduce((a, b) => a + b, 0), dismissed }],
    ]),
  )[0];
}

describe("keeping one copy of a set", () => {
  it("marks every other copy in that set", () => {
    const g = group(SHA("a"), [10, 10, 10]);
    const selected = keepOnly(new Set(), g, g.files[2].id);

    expect(selected.has(g.files[2].id)).toBe(false);
    expect(selected.has(g.files[0].id)).toBe(true);
    expect(selected.has(g.files[1].id)).toBe(true);
    expect(keptId(g, selected)).toBe(g.files[2].id);
  });

  it("leaves other sets exactly as they were", () => {
    // Pressing "keep this one" in one set must not rewrite a decision made in
    // another, which is why the operation is scoped to the group.
    const a = group(SHA("b"), [10, 10]);
    const b = group(SHA("c"), [10, 10]);
    const before = new Set([b.files[1].id]);

    const after = keepOnly(before, a, a.files[0].id);
    expect(after.has(b.files[1].id)).toBe(true);
    expect(after.has(b.files[0].id)).toBe(false);
    expect(before.has(a.files[1].id)).toBe(false); // the input is not mutated
  });

  it("takes a whole set back out of the selection", () => {
    const g = group(SHA("d"), [10, 10, 10]);
    const all = new Set(g.files.map((f) => f.id));
    expect(keepEverything(all, g).size).toBe(0);
  });

  it("reports no single keeper when none or several survive", () => {
    const g = group(SHA("e"), [10, 10, 10]);
    expect(keptId(g, new Set())).toBe(null);
    expect(keptId(g, new Set(g.files.map((f) => f.id)))).toBe(null);
  });
});

describe("splitting counted sets from kept ones", () => {
  it("separates by the dismissed flag the scan stamped", () => {
    const counted = group(SHA("1"), [10, 10]);
    const kept = group(SHA("2"), [10, 10], true);
    const split = splitByDismissed([counted, kept]);

    expect(split.counted.map((g) => g.checksum)).toEqual([SHA("1")]);
    expect(split.kept.map((g) => g.checksum)).toEqual([SHA("2")]);
  });

  it("describes a set for the dismissal by its checksum and its size", () => {
    const g = group(SHA("3"), [100, 100]);
    expect(dismissalsFor([g])).toEqual([{ checksum: SHA("3"), copies: 2, bytes: 200 }]);
  });
});

/* -------------------------------------------------------------------------- */
/* The actions                                                                 */
/* -------------------------------------------------------------------------- */

/** The rendered WHERE of the statement, whitespace-flattened. */
function whereSql(index = 0): { text: string; params: unknown[] } {
  const built = new PgDialect().sqlToQuery(whereClauses[index] as never);
  return { text: built.sql.replace(/\s+/g, " "), params: built.params };
}

beforeEach(() => {
  getSession.mockReset();
  recordAudit.mockClear();
  getSession.mockResolvedValue({ user: { id: ME, email: "me@local.test" } });
  inserted = [];
  whereClauses = [];
  returned = [];
});

describe("keepDuplicateSets", () => {
  it("stores one row per set, keyed by the owner and the checksum", async () => {
    returned = [{ checksum: SHA("a") }];
    const result = await keepDuplicateSets([{ checksum: SHA("a"), copies: 4, bytes: 400 }]);

    expect(result).toEqual({ ok: true, kept: 1, checksums: [SHA("a")] });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toEqual([
      { ownerId: ME, checksum: SHA("a"), copies: 4, bytes: 400 },
    ]);
  });

  it("normalises the digest and collapses repeats", async () => {
    // Postgres refuses an ON CONFLICT DO UPDATE that would touch the same row
    // twice in one statement, so a client sending the same set twice - a double
    // click on "I want these" - must not be able to turn that into a 500.
    returned = [{ checksum: SHA("a") }];
    const upper = SHA("A");
    await keepDuplicateSets([
      { checksum: upper, copies: 2, bytes: 20 },
      { checksum: SHA("a"), copies: 2, bytes: 20 },
    ]);

    expect(inserted[0]).toEqual([{ ownerId: ME, checksum: SHA("a"), copies: 2, bytes: 20 }]);
  });

  it("refuses anything that is not a sha256, before it reaches a statement", async () => {
    // duplicate_dismissals.checksum is a varchar, so Postgres would not reject
    // a stray string the way it rejects a malformed uuid: it would store it,
    // and the row would sit there forever matching nothing.
    expect(await keepDuplicateSets([{ checksum: "nope", copies: 1, bytes: 1 }])).toEqual({
      ok: false,
      error: "malformed",
    });
    expect(await keepDuplicateSets([])).toEqual({ ok: false, error: "empty" });
    expect(inserted).toHaveLength(0);
  });

  it("refuses a signed-out caller before building anything", async () => {
    getSession.mockResolvedValue(null);
    expect(await keepDuplicateSets([{ checksum: SHA("a"), copies: 1, bytes: 1 }])).toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(inserted).toHaveLength(0);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

describe("countDuplicateSetsAgain", () => {
  it("scopes the delete to the caller inside the statement itself", async () => {
    // The undo behind the toast. A checksum is a global fact about bytes, so a
    // delete matching on the digest alone would clear somebody else's decision.
    returned = [{ checksum: SHA("a") }];
    const result = await countDuplicateSetsAgain([SHA("a")]);

    expect(result).toEqual({ ok: true, restored: 1 });
    const { text, params } = whereSql();
    expect(text).toContain('"duplicate_dismissals"."owner_id" =');
    expect(params).toContain(ME);
  });

  it("answers with data on a bad list rather than throwing", async () => {
    expect(await countDuplicateSetsAgain(["not-a-digest"])).toEqual({
      ok: false,
      error: "malformed",
    });
    expect(whereClauses).toHaveLength(0);
  });

  it("refuses a signed-out caller", async () => {
    getSession.mockResolvedValue(null);
    expect(await countDuplicateSetsAgain([SHA("a")])).toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(whereClauses).toHaveLength(0);
  });
});
