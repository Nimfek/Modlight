import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tokenOk } from "../helpers/token-auth";

const source = readFileSync(join(process.cwd(), "app/api/uploads/route.ts"), "utf8");

const authenticateApiToken = vi.fn();
const getSession = vi.fn();

vi.mock("@/lib/api-token", async () => {
  // The header parser stays real: it decides whether a token was offered at all.
  const actual = await vi.importActual<typeof import("@/lib/api-token")>("@/lib/api-token");
  return { ...actual, authenticateApiToken };
});
vi.mock("@/lib/auth-helpers", () => ({ getSession }));
vi.mock("@/lib/db", async () => {
  const fake = await import("../helpers/fake-db");
  return { db: fake.db };
});
vi.mock("@/lib/media/derived-cache", () => ({ purgeDerived: vi.fn(async () => {}) }));

/**
 * The three verbs the route delegates to, doing to the fake store what the real
 * ones do to Postgres.
 *
 * Replaced rather than run, because between them they touch the `user` table (a
 * quota refund) and the storage driver, neither of which the fake models - and
 * because what is under test is not what those functions do, it is WHICH ROWS
 * the route hands them. That selection is the whole of the bug: the route never
 * gave `deleteMediaHard` a trashed row to work on, so nothing that function
 * could have done would have mattered.
 */
vi.mock("@/lib/media/actions", async () => {
  const { store } = await import("../helpers/fake-db");
  return {
    deleteMediaHard: vi.fn(async (row: { id: string }) => {
      store.uploads = store.uploads.filter((r) => r.id !== row.id);
    }),
    softDeleteMedia: vi.fn(async (id: string) => {
      const row = store.uploads.find((r) => r.id === id);
      if (row) row.deletedAt = new Date();
    }),
    restoreMedia: vi.fn(async (id: string) => {
      const row = store.uploads.find((r) => r.id === id);
      if (row) row.deletedAt = null;
    }),
  };
});

const { resetDb, store, fakeUuid } = await import("../helpers/fake-db");
const route = await import("@/app/api/uploads/route");

const ME = "u1";
const THEM = "u2";
const ENDPOINT = "https://host.example.com/api/uploads";

/**
 * These assert the SHAPE of a destructive endpoint, read from its source.
 *
 * A behavioural test would need a database; what actually matters here is a
 * handful of decisions that are easy to undo by accident in an edit, and each of
 * them is visible in the text: the default mode, the ownership filter, and the
 * fact that "restore" does not get a licence to touch live rows.
 */
describe("DELETE /api/uploads", () => {
  it("defaults to the trash, never to permanent deletion", () => {
    // [\s\S] rather than the /s flag: this project's TS target predates it.
    const line = source.match(/const mode = [\s\S]+?;/)?.[0] ?? "";
    expect(line).toContain('"permanent"');
    expect(line).toContain('"restore"');
    // The fallback arm of the ternary is what an omitted `mode` lands on.
    expect(line.trim().endsWith(': "trash";')).toBe(true);
  });

  it("scopes every row it touches to the caller", () => {
    const block = source.slice(source.indexOf("export async function DELETE"));
    expect(block).toContain("eq(uploads.ownerId, owner.id)");
  });

  it("gives each mode its own view of the trash", () => {
    // This assertion USED to pin `mode === "restore" ? undefined :
    // isNull(uploads.deletedAt)`, and pinning it is how the bug survived: read
    // literally, that expression says "permanent" may only touch rows that are
    // NOT in the trash, so deleting for good out of the trash matched nothing
    // and answered `affected: 0`. The desktop client reported, correctly, that
    // the server had changed nothing.
    //
    // The three arms are pinned individually now, because the reason for each is
    // different and a single expression cannot state three reasons:
    const rule = source.match(/function reachableBy[\s\S]+?\n}/)?.[0] ?? "";
    // trash: live rows only, so a second trashing cannot restamp the 30-day clock.
    expect(rule).toContain('if (mode === "trash") return isNull(uploads.deletedAt);');
    // restore: trashed rows only, so restoring is not a licence to write to live rows.
    expect(rule).toContain('if (mode === "restore") return isNotNull(uploads.deletedAt);');
    // permanent: no deleted_at filter at all - from the library or from the bin.
    // A regex rather than endsWith: this file is checked out with CRLF line
    // endings on Windows, so the source read above carries them too and a
    // literal newline in the expectation would only pass on one platform.
    expect(rule.trimEnd()).toMatch(/return undefined;\s*\}$/);
  });

  it("bounds how many ids one request may name", () => {
    const block = source.slice(source.indexOf("export async function DELETE"));
    // The bound is a named constant now that PATCH shares it, so the literal and
    // the name are both accepted — what must not disappear is the comparison.
    expect(block).toMatch(/ids\.length > (\d+|MAX_IDS)/);
    // And the constant has to actually be a number, not a re-exported `Infinity`.
    expect(source).toMatch(/const MAX_IDS = \d+;/);
  });

  it("requires a caller", () => {
    const block = source.slice(source.indexOf("export async function DELETE"));
    // Matched by the shared helper's NAME rather than by a local alias: the
    // three routes that inlined this check now call lib/api-caller.ts, and a
    // test pinned to a private wrapper would go green the day somebody replaced
    // the call with nothing.
    // The capability is part of what is pinned. Deleting somebody's library is
    // the exact thing a read-only token must not be able to do, and a scope
    // silently softened to "read" here would pass every other test in the file.
    const authIndex = block.indexOf('await resolveApiOwner(req, "write")');
    const bodyIndex = block.indexOf("await req.json()");
    expect(authIndex).toBeGreaterThan(-1);
    // Authentication before parsing a body, so an unauthenticated caller cannot
    // make us do work by sending a large one.
    expect(authIndex).toBeLessThan(bodyIndex);
  });
});

/* -------------------------------------------------------------------------- */

/** A row as the fake store holds it. `deletedAt` is the only field on trial. */
function upload(id: string, ownerId: string, deletedAt: Date | null) {
  return { id, ownerId, deletedAt, size: 10, storageKey: "s/" + id, thumbKey: null };
}

function del(ids: string[], mode?: string) {
  const body: Record<string, unknown> = { ids };
  if (mode !== undefined) body.mode = mode;
  return new Request(ENDPOINT, {
    method: "DELETE",
    headers: { "content-type": "application/json", "x-api-key": "good" },
    body: JSON.stringify(body),
  });
}

async function call(ids: string[], mode?: string) {
  const res = await route.DELETE(del(ids, mode));
  return { status: res.status, body: JSON.parse(await res.text()) as Record<string, unknown> };
}

const LIVE = fakeUuid(1);
const TRASHED = fakeUuid(2);
const TRASHED_AT = new Date("2026-08-01T00:00:00.000Z");

/**
 * The same endpoint driven for real, against tests/helpers/fake-db.ts - which
 * parses the WHERE clause and filters actual rows, so a filter that excludes the
 * rows a mode is meant to reach shows up as a row still sitting in the store.
 *
 * The tests above say what the rule is written as; these say what it DOES, and
 * they are what would have caught this in the first place. The owner met it as
 * "there were files in the trash I could not delete from the app - I had to go
 * into the trash through the website, because it said the server changed
 * nothing".
 */
describe("DELETE /api/uploads, against rows", () => {
  beforeEach(() => {
    authenticateApiToken.mockReset();
    getSession.mockReset();
    authenticateApiToken.mockResolvedValue(
      tokenOk({ id: ME, banned: false, role: "user", copyRaw: false }),
    );
    resetDb({ uploads: [upload(LIVE, ME, null), upload(TRASHED, ME, TRASHED_AT)] });
  });

  it("deletes for good a file that is ALREADY in the trash - the bug", async () => {
    const { status, body } = await call([TRASHED], "permanent");

    expect(status).toBe(200);
    // Was `affected: 0` with the row untouched, which is precisely what the app
    // reported and what sent the owner to the website to finish the job.
    expect(body.affected).toBe(1);
    expect(store.uploads.map((r) => r.id)).toEqual([LIVE]);
  });

  it("deletes for good a file that is still in the library", async () => {
    const { body } = await call([LIVE], "permanent");

    expect(body.affected).toBe(1);
    expect(store.uploads.map((r) => r.id)).toEqual([TRASHED]);
  });

  it("empties a trash of several files in one call", async () => {
    const second = fakeUuid(3);
    resetDb({ uploads: [upload(TRASHED, ME, TRASHED_AT), upload(second, ME, TRASHED_AT)] });

    const { body } = await call([TRASHED, second], "permanent");

    expect(body.affected).toBe(2);
    expect(store.uploads).toHaveLength(0);
  });

  it("will not re-stamp a row already in the trash", async () => {
    const { body } = await call([TRASHED], "trash");

    // Nothing to do, and saying so is the point: a second stamp would move the
    // thirty-day clock, and a file that never quite expires is what a retention
    // window exists to prevent.
    expect(body.affected).toBe(0);
    expect(store.uploads.find((r) => r.id === TRASHED)?.deletedAt).toBe(TRASHED_AT);
  });

  it("restores out of the trash only, leaving live rows alone", async () => {
    const { body } = await call([LIVE, TRASHED], "restore");

    // One of the two ids was restorable. Counting the live row as well would be
    // a write that changed nothing, reported back as work done.
    expect(body.affected).toBe(1);
    expect(store.uploads.find((r) => r.id === TRASHED)?.deletedAt).toBeNull();
    expect(store.uploads.find((r) => r.id === LIVE)?.deletedAt).toBeNull();
  });

  it("cannot reach another account's trash", async () => {
    const theirs = fakeUuid(9);
    resetDb({ uploads: [upload(theirs, THEM, TRASHED_AT)] });

    const { status, body } = await call([theirs], "permanent");

    // Answered exactly like an id that never existed: 200, nothing affected. The
    // widened filter must not have widened whose rows it can see.
    expect(status).toBe(200);
    expect(body.affected).toBe(0);
    expect(store.uploads).toHaveLength(1);
  });
});
