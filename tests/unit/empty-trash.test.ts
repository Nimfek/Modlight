import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * "Empty the trash" - the one panel control that destroys a whole library's
 * worth of bytes in a single click.
 *
 * Driven through the real `lib/uploads.ts` core and the real
 * `deleteMediaBulk`, with tests/helpers/fake-db.ts underneath parsing the WHERE
 * clauses and filtering real rows. That is the entire point: the two claims
 * worth testing are "it can only ever touch rows that are IN THE TRASH" and "it
 * can only ever touch rows belonging to the account it was aimed at", and both
 * of them are properties of a WHERE clause. A stub that answers the same rows
 * whatever it is asked would pass just as happily against code with either
 * check deleted.
 *
 * The `user` table is not in fake-db's registry, so the two statements that
 * need it - resolving a tag to an account, and refunding the quota - are served
 * by a small shim in the mock below, built on fake-db's own exported predicate
 * parser rather than on a second copy of it.
 */

const h = vi.hoisted(() => ({
  /** Rows of the `user` table, which fake-db does not model. */
  users: [] as Array<Record<string, unknown>>,
  /** Every UPDATE aimed at `user`, so the quota refund can be asserted. */
  userUpdates: [] as Array<{ id: unknown; set: Record<string, unknown> }>,
  /** Storage keys actually unlinked. */
  deletedKeys: [] as string[],
  /**
   * Keys storage refuses to give up.
   *
   * Read by the storage mock, and deliberately left empty by every test here.
   * A refused key parks its row in `stuck`, and the next round excludes it with
   * `notInArray` - which tests/helpers/fake-db.ts currently parses as `IN`
   * (parseLeaf tests /\bin\b/ before it has ruled out "not in", and " not in "
   * matches). Under that helper the excluded row comes straight back, so an
   * assertion on `failed` would be measuring the helper rather than the
   * feature. The hook stays because the fix is one line in parseLeaf and this
   * is the first thing that should be asserted after it lands.
   */
  failKeys: new Set<string>(),
}));

const recordAudit = vi.fn(async () => {});

vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/media/derived-cache", () => ({ purgeDerived: vi.fn(async () => {}) }));
vi.mock("@/lib/storage", () => ({
  getStorage: () => ({
    async delete(key: string) {
      if (h.failKeys.has(key)) throw new Error("storage is read-only");
      h.deletedKeys.push(key);
    },
  }),
}));

vi.mock("@/lib/db", async () => {
  const fake = await import("../helpers/fake-db");
  const schema = await import("@/lib/db/schema");
  const userTable = schema.user as unknown as Record<string, unknown>;

  const isColumn = (v: unknown): v is { name: string } =>
    typeof v === "object" &&
    v !== null &&
    typeof (v as { name?: unknown }).name === "string" &&
    (v as { table?: unknown }).table !== undefined;

  const byColumn = new Map<string, string>();
  for (const [key, value] of Object.entries(userTable)) {
    if (isColumn(value)) byColumn.set(value.name, key);
  }
  const meta = { name: "user", byColumn };

  type Row = Record<string, unknown>;
  const project = (fields: Row | undefined, row: Row): Row => {
    if (!fields) return { ...row };
    const out: Row = {};
    for (const [key, col] of Object.entries(fields)) {
      out[key] = row[byColumn.get((col as { name: string }).name)!];
    }
    return out;
  };

  function userSelect(fields: Row | undefined) {
    let where: unknown;
    let take: number | undefined;
    const self: Record<string, unknown> = {
      where: (c: unknown) => ((where = c), self),
      limit: (n: number) => ((take = n), self),
      orderBy: () => self,
      then(ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) {
        try {
          const match = fake.parsePredicate(where, meta);
          let rows = h.users.filter(match);
          if (take !== undefined) rows = rows.slice(0, take);
          return Promise.resolve(rows.map((r) => project(fields, r))).then(ok, err);
        } catch (e) {
          return err ? Promise.resolve().then(() => err(e)) : Promise.reject(e);
        }
      },
    };
    return self;
  }

  function userUpdate() {
    let set: Row = {};
    const self: Record<string, unknown> = {
      set: (v: Row) => ((set = v), self),
      where(c: unknown) {
        for (const row of h.users.filter(fake.parsePredicate(c, meta))) {
          h.userUpdates.push({ id: row.id, set });
        }
        return self;
      },
      then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
        Promise.resolve([]).then(ok, err),
    };
    return self;
  }

  const inner = fake.db as unknown as {
    select: (f?: unknown) => { from: (t: unknown) => unknown };
    update: (t: unknown) => unknown;
    insert: (t: unknown) => unknown;
    delete: (t: unknown) => unknown;
    transaction: (cb: unknown) => unknown;
  };

  const db = {
    // The table is only known at `.from()`, so the choice is made there rather
    // than by pre-building a fake-db statement that would throw on `user`.
    select: (fields?: unknown) => ({
      from: (table: unknown) =>
        table === schema.user ? userSelect(fields as Row) : inner.select(fields).from(table),
    }),
    update: (table: unknown) => (table === schema.user ? userUpdate() : inner.update(table)),
    insert: (table: unknown) => inner.insert(table),
    delete: (table: unknown) => inner.delete(table),
    transaction: (cb: unknown) => inner.transaction(cb),
  };

  return { db };
});

const { resetDb, store, fakeUuid, statementsFor } = await import("../helpers/fake-db");
const { emptyTrashFor, trashTotalsFor, UploadOpError } = await import("@/lib/uploads");

const ME = "u1";
const THEM = "u2";
const MY_TAG = "Aaaaa";
const THEIR_TAG = "Bbbbb";

const LIVE = fakeUuid(401);
const TRASHED_A = fakeUuid(402);
const TRASHED_B = fakeUuid(403);
const THEIR_TRASHED = fakeUuid(404);

const me = { userId: ME, email: "me@example.test" };
const admin = { userId: "admin-1", email: "root@example.test", isAdmin: true };

function upload(id: string, ownerId: string, size: number, deletedAt: Date | null) {
  return {
    id,
    ownerId,
    size,
    storageKey: `${ownerId}/${id}.png`,
    thumbKey: null,
    deletedAt,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.users = [
    { id: ME, userCode: MY_TAG, usedQuota: 10_000 },
    { id: THEM, userCode: THEIR_TAG, usedQuota: 10_000 },
  ];
  h.userUpdates = [];
  h.deletedKeys = [];
  h.failKeys = new Set();
  resetDb({
    uploads: [
      // The row that must survive every single test in this file.
      upload(LIVE, ME, 100, null),
      upload(TRASHED_A, ME, 200, new Date("2026-08-01T00:00:00Z")),
      upload(TRASHED_B, ME, 300, new Date("2026-08-02T00:00:00Z")),
      upload(THEIR_TRASHED, THEM, 400, new Date("2026-08-03T00:00:00Z")),
    ],
  });
});

const ids = () => store.uploads.map((r) => r.id).sort();

describe("trashTotalsFor", () => {
  it("counts the whole trash of one account, and nothing else", async () => {
    // Not derived from a page of results: the confirmation dialog prints this
    // number, and the list it sits under stops at 120 items.
    expect(await trashTotalsFor(me, MY_TAG)).toEqual({ files: 2, bytes: 500 });
  });

  it("does not count live files", async () => {
    // The live row is 100 bytes; if `deleted_at is not null` left the WHERE
    // clause, the totals above would read 3 / 600.
    const totals = await trashTotalsFor(me, MY_TAG);
    expect(totals.files).toBe(2);
    expect(totals.bytes).toBe(500);
  });

  it("reads zero for an account whose trash is empty", async () => {
    resetDb({ uploads: [upload(LIVE, ME, 100, null)] });
    expect(await trashTotalsFor(me, MY_TAG)).toEqual({ files: 0, bytes: 0 });
  });

  it("refuses another account's tag, exactly as it refuses an unknown one", async () => {
    // One answer for both, so this is not an oracle for "is that tag taken".
    await expect(trashTotalsFor(me, THEIR_TAG)).rejects.toBeInstanceOf(UploadOpError);
    await expect(trashTotalsFor(me, "Zzzzz")).rejects.toBeInstanceOf(UploadOpError);
    await expect(trashTotalsFor(me, "")).rejects.toBeInstanceOf(UploadOpError);
  });

  it("lets an administrator count somebody else's trash", async () => {
    expect(await trashTotalsFor(admin, THEIR_TAG)).toEqual({ files: 1, bytes: 400 });
  });
});

describe("emptyTrashFor", () => {
  it("destroys the trashed rows and leaves the live one alone", async () => {
    const result = await emptyTrashFor(me, MY_TAG);

    expect(result).toEqual({ files: 2, bytes: 500, failed: 0 });
    // The live file and the other account's trash are still there. Deleting
    // `isNotNull(uploads.deletedAt)` from trashScope makes this line red.
    expect(ids()).toEqual([LIVE, THEIR_TRASHED].sort());
  });

  it("takes the bytes with the rows", async () => {
    await emptyTrashFor(me, MY_TAG);
    // Rows without storage objects are the failure mode this whole feature is
    // supposed to avoid: invisible, and still billed for.
    expect(h.deletedKeys.sort()).toEqual(
      [`${ME}/${TRASHED_A}.png`, `${ME}/${TRASHED_B}.png`].sort(),
    );
    expect(h.deletedKeys).not.toContain(`${ME}/${LIVE}.png`);
  });

  it("refunds the freed bytes to the owner's quota", async () => {
    await emptyTrashFor(me, MY_TAG);
    expect(h.userUpdates.map((u) => u.id)).toEqual([ME]);
    expect(Object.keys(h.userUpdates[0].set)).toContain("usedQuota");
  });

  it("never reaches another account, however it is asked", async () => {
    await expect(emptyTrashFor(me, THEIR_TAG)).rejects.toBeInstanceOf(UploadOpError);
    // Nothing at all happened: not their rows, and not ours either.
    expect(ids()).toEqual([LIVE, TRASHED_A, TRASHED_B, THEIR_TRASHED].sort());
    expect(h.deletedKeys).toEqual([]);
  });

  it("lets an administrator empty somebody else's trash, and writes it down", async () => {
    const result = await emptyTrashFor(admin, THEIR_TAG);

    expect(result).toEqual({ files: 1, bytes: 400, failed: 0 });
    expect(ids()).toEqual([LIVE, TRASHED_A, TRASHED_B].sort());
    // Emptying somebody else's trash leaves no trace in the files themselves,
    // so this entry is the only place the fact can be written down - and it is
    // written ONCE for the operation, not once per file.
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledWith(
      "admin-1",
      "admin.trash.emptied",
      expect.objectContaining({ ownerId: THEM, ownerTag: THEIR_TAG, files: 1, bytes: 400 }),
    );
  });

  it("records nothing when an account empties its own trash", async () => {
    await emptyTrashFor(me, MY_TAG);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("clears a trash bigger than one batch", async () => {
    // The loop reads 200 rows per round, so 250 is the smallest seed that
    // proves it comes back for the second one. This is the ordinary case for
    // this button, not an exotic one: the account that reaches for "empty the
    // trash" is the account that has been tidying up, and stopping after the
    // first round would report a number far larger than what it deleted.
    const many = Array.from({ length: 250 }, (_, n) =>
      upload(fakeUuid(1000 + n), ME, 10, new Date(Date.UTC(2026, 7, 1, 0, 0, n))),
    );
    resetDb({ uploads: [upload(LIVE, ME, 100, null), ...many] });

    const result = await emptyTrashFor(me, MY_TAG);

    expect(result).toEqual({ files: 250, bytes: 2500, failed: 0 });
    expect(h.deletedKeys).toHaveLength(250);
    // The live row is still the row that survives everything.
    expect(ids()).toEqual([LIVE]);
  });

  it("never reads a row without naming the trash and the owner", async () => {
    // The other tests here prove the RESULT is right; this one proves the
    // QUERY is, which is the claim that has to hold even when the rows behind
    // it are somebody's real library. There is no id parameter anywhere in
    // this path, so the only thing standing between it and a live file is
    // these two columns being in the WHERE - not in a check applied to rows
    // that have already come back.
    await emptyTrashFor(me, MY_TAG);

    const selects = statementsFor("uploads", "select");
    expect(selects.length).toBeGreaterThan(0);
    for (const statement of selects) {
      expect(statement.whereColumns).toContain("deleted_at");
      expect(statement.whereColumns).toContain("owner_id");
    }
  });

  it("is a no-op on an empty trash", async () => {
    resetDb({ uploads: [upload(LIVE, ME, 100, null)] });
    expect(await emptyTrashFor(me, MY_TAG)).toEqual({ files: 0, bytes: 0, failed: 0 });
    expect(ids()).toEqual([LIVE]);
    expect(h.deletedKeys).toEqual([]);
  });
});
