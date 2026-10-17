import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `trashDuplicates` — the one statement in this feature that destroys anything.
 *
 * `tests/unit/duplicates.test.ts` pins the scan and the selection, which are
 * pure. What was left unpinned is the part with consequences: the UPDATE. Three
 * facts have to hold at once, and each of them is one deleted word away from
 * being false:
 *
 *  - the OWNER is in the WHERE clause, not in a SELECT that ran a moment
 *    earlier — between those two statements a row can change hands, and the
 *    check would be answering a question about a table that no longer exists;
 *  - it is a SOFT delete (a `deleted_at` stamp), because the worst case of this
 *    feature is destroying the only copy of something;
 *  - `deleted_at is null` is in the WHERE, so re-trashing something already in
 *    the trash cannot hand it another thirty days.
 *
 * Asserted against the SQL Drizzle actually renders rather than against the
 * source, because "the owner is checked" and "the owner is checked IN THIS
 * STATEMENT" are different claims and only the second one is a defence.
 */

const getSession = vi.fn();
const recordAudit = vi.fn(async () => {});
const purgeDerived = vi.fn(async () => {});

vi.mock("@/lib/auth-helpers", () => ({ getSession }));
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/media/derived-cache", () => ({ purgeDerived }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/** What the UPDATE was handed, and what it resolves to. */
let written: unknown[] = [];
let whereClauses: unknown[] = [];
let returned: unknown[] = [];

/**
 * A Drizzle builder of any shape. Every method returns the same thenable, so
 * whichever chain the action happens to write is accepted; `set` and `where` are
 * the two with side effects, because what they were handed is the whole question.
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
        if (prop === "set") {
          return (v: unknown) => {
            written.push(v);
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
    insert: () => chain(() => []),
    update: () => chain(() => returned),
    delete: () => chain(() => []),
  },
}));

const { PgDialect } = await import("drizzle-orm/pg-core");
const { trashDuplicates } = await import("@/app/actions/duplicates");

const ME = "11111111-1111-4111-8111-111111111111";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MINE = id(1);
const THEIRS = "deadbeef-dead-4bee-8bee-deadbeefdead";

/** The rendered WHERE of the UPDATE, whitespace-flattened. */
function whereSql(): { text: string; params: unknown[] } {
  expect(whereClauses).toHaveLength(1);
  const built = new PgDialect().sqlToQuery(whereClauses[0] as never);
  return { text: built.sql.replace(/\s+/g, " "), params: built.params };
}

beforeEach(() => {
  getSession.mockReset();
  recordAudit.mockClear();
  purgeDerived.mockClear();
  getSession.mockResolvedValue({ user: { id: ME, email: "me@local.test" } });
  written = [];
  whereClauses = [];
  returned = [];
});

describe("trashDuplicates", () => {
  it("scopes the delete to the caller inside the statement itself", async () => {
    returned = [{ id: MINE, size: 10, code: "abc" }];
    await trashDuplicates([MINE]);

    const { text, params } = whereSql();
    expect(text).toContain('"uploads"."owner_id" =');
    expect(text).toContain('"uploads"."deleted_at" is null');
    // The session's id, not anything the caller sent, and bound rather than
    // interpolated.
    expect(params).toContain(ME);
  });

  it("stamps deleted_at instead of removing the row", async () => {
    returned = [{ id: MINE, size: 10, code: "abc" }];
    await trashDuplicates([MINE]);

    expect(written).toHaveLength(1);
    expect(Object.keys(written[0] as object)).toEqual(["deletedAt"]);
    expect((written[0] as { deletedAt: unknown }).deletedAt).toBeInstanceOf(Date);
  });

  it("cannot reach another account's file", async () => {
    // The attempt: a hand-crafted call naming somebody else's upload id. It is a
    // well-formed uuid, so nothing upstream rejects it — the WHERE is the only
    // thing standing between this call and the file, which is why the UPDATE
    // matches nothing and the row is reported as skipped rather than trashed.
    returned = [];
    const result = await trashDuplicates([THEIRS]);

    expect(result).toEqual({ ok: true, trashed: 0, bytes: 0, skipped: 1 });
    expect(whereSql().params).toContain(ME);
    // Nothing happened, so nothing is claimed to have happened.
    expect(recordAudit).not.toHaveBeenCalled();
    expect(purgeDerived).not.toHaveBeenCalled();
  });

  it("counts and measures from what the statement returned, not from what was asked", async () => {
    // A client that believed it had selected four files, two of which are
    // somebody else's or already in the trash. The report has to describe the
    // rows, or "freed 4 GB" is a number about a browser's idea of the library.
    returned = [
      { id: id(1), size: 100, code: "a" },
      { id: id(2), size: 250, code: "b" },
    ];
    const result = await trashDuplicates([id(1), id(2), id(3), THEIRS]);

    expect(result).toEqual({ ok: true, trashed: 2, bytes: 350, skipped: 2 });
    expect(purgeDerived).toHaveBeenCalledTimes(2);
  });

  it("answers with data on a bad id list rather than throwing", async () => {
    // Next masks the message of anything thrown from a Server Action in
    // production, and this screen's entire job is saying why it refused.
    expect(await trashDuplicates(["not-a-uuid"])).toEqual({ ok: false, error: "malformed" });
    expect(await trashDuplicates([])).toEqual({ ok: false, error: "empty" });
    expect(whereClauses).toHaveLength(0);
  });

  it("refuses a signed-out caller before building any statement", async () => {
    getSession.mockResolvedValue(null);
    expect(await trashDuplicates([MINE])).toEqual({ ok: false, error: "unauthorized" });
    expect(whereClauses).toHaveLength(0);
    expect(written).toHaveLength(0);
  });
});
