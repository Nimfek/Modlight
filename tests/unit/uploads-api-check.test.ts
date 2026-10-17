import { describe, it, expect, vi, beforeEach } from "vitest";
import { tokenBanned, tokenOk, tokenUnknown } from "../helpers/token-auth";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * POST /api/uploads/check - "before I send this, do I already have it?"
 *
 * Driven end to end: the real route handler, the real lookup in
 * lib/upload/duplicate-lookup.ts, and tests/helpers/fake-db.ts underneath
 * PARSING the WHERE clauses and filtering real rows. Only the credential is
 * stubbed.
 *
 * That last detail is what makes the ownership assertions worth anything. The
 * usual "every builder method returns the same thenable" stub ignores the
 * predicate, so it answers the same rows whatever it is asked - and would pass
 * just as happily against a lookup with `eq(uploads.ownerId, userId)` deleted.
 * Here, deleting it makes another account's file start coming back exactly as
 * Postgres would hand it over, and the tests below go red.
 *
 * The four things that can lie, and are therefore pinned:
 *
 *  1. a checksum only somebody ELSE holds must read as not found;
 *  2. a file in the trash is not a reason to skip an upload;
 *  3. anything that is not a sha256 is refused BEFORE a query is built;
 *  4. the batch ceiling actually bites.
 *
 * Plus the one that is easiest to get wrong and worst to get wrong: a library
 * holding files with no stored checksum can never be reported as "you do not
 * have this file". ~8600 imported rows and every resumable upload are in that
 * state, so the confident answer would be wrong for most of this deployment.
 */

const authenticateApiToken = vi.fn();
const getSession = vi.fn();

vi.mock("@/lib/api-token", async () => {
  // The header parser is the real one: it decides whether a token was offered at
  // all, which is the input to the auth branch.
  const actual = await vi.importActual<typeof import("@/lib/api-token")>("@/lib/api-token");
  return { ...actual, authenticateApiToken };
});
vi.mock("@/lib/auth-helpers", () => ({ getSession }));
vi.mock("@/lib/db", async () => {
  const fake = await import("../helpers/fake-db");
  return { db: fake.db };
});

const { resetDb, statements, fakeUuid } = await import("../helpers/fake-db");
const route = await import("@/app/api/uploads/check/route");
const { MAX_CHECKSUMS, parseChecksums, statusFor } = await import(
  "@/lib/upload/duplicate-check"
);
const { firstMatchFor } = await import("@/lib/upload/duplicate-lookup");

const ME = "u1";
const THEM = "u2";
const URL_ = "https://host.example.com/api/uploads/check";

/** A syntactically valid sha256, distinct per number. */
function sum(n: number): string {
  return n.toString(16).padStart(64, "0");
}

const MINE = sum(1);
const THEIRS = sum(2);
const TRASHED = sum(3);
const ABSENT = sum(4);

const FOLDER = fakeUuid(900);

function file(id: string, ownerId: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    ownerId,
    folderId: null,
    code: `code${id.slice(-4)}`,
    filename: "shot.png",
    ext: "png",
    mimeType: "image/png",
    size: 1234,
    checksum: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
    ...extra,
  };
}

interface Result {
  checksum: string;
  status: string;
  matches: { code: string; filename: string; folderName: string | null; url: string }[];
}

async function post(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown>; results: Result[] }> {
  const res = await route.POST(
    new Request(URL_, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "good", ...headers },
      body: JSON.stringify(body),
    }),
  );
  const json = JSON.parse(await res.text());
  return { status: res.status, json, results: (json.results ?? []) as Result[] };
}

/** The one requested checksum's answer. */
function only(results: Result[]): Result {
  expect(results).toHaveLength(1);
  return results[0];
}

beforeEach(() => {
  authenticateApiToken.mockReset();
  getSession.mockReset();
  authenticateApiToken.mockResolvedValue(tokenOk({
    id: ME,
    banned: false,
    role: "user",
    email: "me@example.test",
    userCode: "Tagged",
    copyRaw: false,
  }));
  resetDb({
    folders: [{ id: FOLDER, ownerId: ME, name: "Screenshots" }],
    uploads: [
      // Mine, in a folder, with a checksum: the only thing that may ever come
      // back as a duplicate.
      file(fakeUuid(1), ME, { checksum: MINE, folderId: FOLDER, filename: "a.png" }),
      // Somebody else's copy of some other bytes.
      file(fakeUuid(2), THEM, { checksum: THEIRS, filename: "theirs.png" }),
      // Mine, but on its way out of the library.
      file(fakeUuid(3), ME, {
        checksum: TRASHED,
        deletedAt: new Date("2026-02-01T00:00:00.000Z"),
        filename: "binned.png",
      }),
    ],
  });
});

/* -------------------------------------------------------------------------- */
/* What is and is not a duplicate                                              */
/* -------------------------------------------------------------------------- */

describe("POST /api/uploads/check - matching", () => {
  it("finds the caller's own live file and says enough to act on it", async () => {
    const { status, results } = await post({ checksums: [MINE] });
    expect(status).toBe(200);

    const result = only(results);
    expect(result.status).toBe("duplicate");
    expect(result.matches).toHaveLength(1);
    // Everything a client needs to offer "you already have this, here it is".
    expect(result.matches[0]).toMatchObject({
      code: "code0001",
      filename: "a.png",
      size: 1234,
      folderId: FOLDER,
      folderName: "Screenshots",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.matches[0].url).toContain("/Tagged/code0001");
  });

  it("does not find a checksum that belongs to another account", async () => {
    const { status, results } = await post({ checksums: [THEIRS] });
    expect(status).toBe(200);

    const result = only(results);
    // Not "duplicate", and no rows leaked either. A checksum is a global fact
    // about bytes, so an unscoped lookup would answer "does anybody on this
    // server hold this file" - which is the question a public host must never
    // answer for anyone.
    expect(result.status).not.toBe("duplicate");
    expect(result.matches).toEqual([]);
  });

  it("keeps ownership and soft-delete in the WHERE clause, not in JS", async () => {
    await post({ checksums: [MINE] });
    const lookup = statements.find((s) => s.table === "uploads" && s.op === "select");
    expect(lookup?.whereColumns).toContain("owner_id");
    expect(lookup?.whereColumns).toContain("deleted_at");
    expect(lookup?.whereColumns).toContain("checksum");
  });

  it("does not count a trashed file as a duplicate", async () => {
    const { results } = await post({ checksums: [TRASHED] });
    // The file exists, it is the caller's, and its bytes match - but its links
    // already 404 and a 30-day sweep is coming for it. Calling that a duplicate
    // tells somebody not to upload a file that is about to stop existing.
    expect(only(results).status).not.toBe("duplicate");
    expect(only(results).matches).toEqual([]);
  });

  it("answers several checksums in one request, in the order asked", async () => {
    const { results } = await post({ checksums: [ABSENT, MINE] });
    expect(results.map((r) => r.checksum)).toEqual([ABSENT, MINE]);
    expect(results[1].status).toBe("duplicate");
  });

  it("collapses a checksum sent twice without losing either file's answer", async () => {
    // Two identical files in one drop: one lookup, one result, and the caller
    // maps both of its files onto it by checksum rather than by position.
    const { json, results } = await post({ checksums: [MINE, MINE.toUpperCase()] });
    expect(json.requested).toBe(1);
    expect(only(results).status).toBe("duplicate");
  });
});

/* -------------------------------------------------------------------------- */
/* "unknown" is not "no"                                                        */
/* -------------------------------------------------------------------------- */

describe("POST /api/uploads/check - what an absence means", () => {
  it("says `new` only when every live file carries a checksum", async () => {
    const { json, results } = await post({ checksums: [ABSENT] });
    expect(json.unchecksummed).toBe(0);
    expect(only(results).status).toBe("new");
  });

  it("says `unknown` when the library holds files it cannot see", async () => {
    resetDb({
      uploads: [
        file(fakeUuid(1), ME, { checksum: MINE }),
        // An imported row, or one landed through the resumable path:
        // no checksum, and therefore invisible to any comparison.
        file(fakeUuid(4), ME, { checksum: null }),
      ],
    });

    const { json, results } = await post({ checksums: [ABSENT] });
    expect(json.unchecksummed).toBe(1);
    // The whole honesty of the feature is this one assertion. "new" here would
    // be a confident lie told precisely to the accounts most affected by it.
    expect(only(results).status).toBe("unknown");
  });

  it("still says `duplicate` when a match is found in a partly blind library", async () => {
    resetDb({
      uploads: [
        file(fakeUuid(1), ME, { checksum: MINE }),
        file(fakeUuid(4), ME, { checksum: null }),
      ],
    });
    // Finding one proves the file is there, whatever else could not be seen.
    expect(only((await post({ checksums: [MINE] })).results).status).toBe("duplicate");
  });

  it("does not count another account's checksumless files, or trashed ones", async () => {
    resetDb({
      uploads: [
        file(fakeUuid(5), THEM, { checksum: null }),
        file(fakeUuid(6), ME, { checksum: null, deletedAt: new Date() }),
      ],
    });
    const { json, results } = await post({ checksums: [ABSENT] });
    expect(json.unchecksummed).toBe(0);
    expect(only(results).status).toBe("new");
  });
});

/* -------------------------------------------------------------------------- */
/* Refusals                                                                    */
/* -------------------------------------------------------------------------- */

describe("POST /api/uploads/check - refusals", () => {
  it("refuses a malformed checksum before building a query", async () => {
    const { status, json } = await post({ checksums: [MINE, "not-a-checksum"] });
    expect(status).toBe(400);
    expect(json.reason).toBe("malformed");
    // Nothing reached the database. `uploads.checksum` is a varchar, so a
    // free-form string would not raise the way a bad uuid does - it would just
    // be compared, turning a lookup into a 500-term search over a column that
    // has no business being searched.
    expect(statements).toEqual([]);
  });

  it("refuses a checksum of the wrong length, and non-hex characters", async () => {
    expect((await post({ checksums: [MINE.slice(0, 63)] })).status).toBe(400);
    expect((await post({ checksums: ["z".repeat(64)] })).status).toBe(400);
    expect((await post({ checksums: [`${MINE} `] })).status).toBe(200); // trimmed, valid
  });

  it("refuses a list that is empty or not a list", async () => {
    expect((await post({ checksums: [] })).json.reason).toBe("empty");
    expect((await post({ checksums: "abc" })).json.reason).toBe("empty");
    expect((await post({})).json.reason).toBe("empty");
    expect(statements).toEqual([]);
  });

  it("bites at the batch ceiling", async () => {
    const tooMany = Array.from({ length: MAX_CHECKSUMS + 1 }, (_, i) => sum(i + 10));
    const { status, json } = await post({ checksums: tooMany });
    expect(status).toBe(400);
    expect(json.reason).toBe("too-many");
    expect(statements).toEqual([]);
  });

  it("accepts a full batch, so the body ceiling cannot refuse a legal request", async () => {
    // 500 checksums are ~33 KB once quoted and comma-separated. Sized from the
    // default 16 KiB instead, this endpoint would answer 413 to a request that
    // is within every documented limit - the bug PATCH_BODY_MAX was sized to
    // avoid on the neighbouring route.
    const full = Array.from({ length: MAX_CHECKSUMS }, (_, i) => sum(i + 10));
    const { status, json } = await post({ checksums: full });
    expect(status).toBe(200);
    expect(json.requested).toBe(MAX_CHECKSUMS);
  });

  it("refuses a body that is not application/json", async () => {
    const res = await route.POST(
      new Request(URL_, {
        method: "POST",
        headers: { "content-type": "text/plain", "x-api-key": "good" },
        body: JSON.stringify({ checksums: [MINE] }),
      }),
    );
    // Not pedantry: this route also accepts a session cookie, and
    // `application/json` is what keeps a cross-origin POST preflighted instead
    // of arriving as a CORS-simple request nobody asked for.
    expect(res.status).toBe(415);
  });

  it("refuses a present-but-wrong token instead of falling back to the session", async () => {
    authenticateApiToken.mockResolvedValue(tokenUnknown());
    getSession.mockResolvedValue({ user: { id: THEM, role: "admin" } });

    const { status } = await post({ checksums: [MINE] });
    expect(status).toBe(401);
    expect(getSession).not.toHaveBeenCalled();
    // And the refusal happened before the body was read, let alone queried.
    expect(statements).toEqual([]);
  });

  it("refuses a banned account holding a valid token", async () => {
    authenticateApiToken.mockResolvedValue(tokenBanned({ id: ME, banned: true, role: "user" }));
    expect((await post({ checksums: [MINE] })).status).toBe(401);
  });
});

/* -------------------------------------------------------------------------- */
/* The pure half of the contract                                               */
/* -------------------------------------------------------------------------- */

describe("parseChecksums", () => {
  it("normalises case and drops repeats, keeping the first order", () => {
    const parsed = parseChecksums([MINE.toUpperCase(), THEIRS, MINE]);
    expect(parsed).toEqual({ ok: true, checksums: [MINE, THEIRS] });
  });

  it("names its ceiling rather than silently truncating", () => {
    const over = Array.from({ length: MAX_CHECKSUMS + 1 }, (_, i) => sum(i));
    expect(parseChecksums(over)).toEqual({ ok: false, issue: "too-many" });
    // A ceiling that trimmed instead would answer 500 questions out of 501 and
    // let the caller believe the missing one was checked and came back clean.
  });
});

describe("statusFor", () => {
  it("only calls something new when the whole library was visible", () => {
    expect(statusFor(false, false)).toBe("new");
    expect(statusFor(false, true)).toBe("unknown");
  });

  it("lets a match win over blindness", () => {
    expect(statusFor(true, true)).toBe("duplicate");
  });
});

/* -------------------------------------------------------------------------- */
/* The single-checksum form the ShareX path uses                               */
/* -------------------------------------------------------------------------- */

describe("firstMatchFor", () => {
  it("is scoped to the owner and skips the trash", async () => {
    await expect(firstMatchFor(ME, MINE)).resolves.toMatchObject({ filename: "a.png" });
    await expect(firstMatchFor(ME, THEIRS)).resolves.toBeNull();
    await expect(firstMatchFor(THEM, MINE)).resolves.toBeNull();
    await expect(firstMatchFor(ME, TRASHED)).resolves.toBeNull();
  });

  it("can never fail a completed ShareX upload", () => {
    // The bytes are already on our disk by the time this runs, so an advisory
    // field is not worth throwing away a finished transfer over. Asserted
    // against the source because the failure mode is an unhandled rejection on
    // the hottest path in the product, which no happy-path test would show.
    const source = readFileSync(join(process.cwd(), "lib", "upload", "sharex.ts"), "utf8");
    expect(source).toMatch(/firstMatchFor\([^)]*\)\s*\.catch\(/);
    // And it is asked BEFORE the row is inserted, so the new upload cannot
    // match itself and need excluding by id.
    expect(source.indexOf("firstMatchFor")).toBeLessThan(source.indexOf("await finalizeUpload"));
  });
});
