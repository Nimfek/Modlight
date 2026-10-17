import { describe, it, expect, vi, beforeEach } from "vitest";
import { tokenOk } from "../helpers/token-auth";

/**
 * The upload write verbs a desktop client meets, driven end to end: real route
 * handler, real `lib/uploads.ts` core, and tests/helpers/fake-db.ts underneath
 * parsing the WHERE clauses and filtering real rows.
 *
 * Only the credential and the audit sink are stubbed. Everything the task cares
 * about - whether an absent key leaves a value alone, whether a vanity clash
 * still bites once the session is out of the picture, whether setting a password
 * gives up the account default, what another account's id looks like from
 * outside - is a property of the whole path, and a test that mocked the core
 * would only prove the route can call a mock.
 *
 * The fake database is what makes the ownership assertions mean anything: it
 * PARSES the predicate, so deleting `eq(uploads.ownerId, actor.userId)` from
 * lib/uploads.ts makes rows start coming back exactly as Postgres would hand
 * them over, and the tests below go red.
 */

const authenticateApiToken = vi.fn();
const getSession = vi.fn();
const recordAudit = vi.fn(async () => {});

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
// `recordAudit` reads next/headers, which does not exist outside a request.
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/media/derived-cache", () => ({ purgeDerived: vi.fn(async () => {}) }));

const { resetDb, store, fakeUuid } = await import("../helpers/fake-db");
const uploads = await import("@/app/api/uploads/route");
const { setPublishedFor, setVanityFor, UploadOpError } = await import("@/lib/uploads");

const ME = "u1";
const THEM = "u2";
const MY_FILE = fakeUuid(301);
const OTHER_FILE = fakeUuid(302);
const THEIR_FILE = fakeUuid(303);

const URL_ = "https://host.example.com/api/uploads";

/** An upload row with every column the read-back path touches. */
function file(id: string, ownerId: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    ownerId,
    folderId: null,
    code: `code${id.slice(-4)}`,
    filename: "shot.png",
    ext: "png",
    mimeType: "image/png",
    kind: "file",
    language: null,
    size: 10,
    width: null,
    height: null,
    frames: null,
    blurhash: null,
    published: true,
    views: 0,
    downloads: 0,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
    expiresAt: null,
    maxViews: null,
    passwordHash: null,
    passwordVersion: null,
    ...extra,
  };
}

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request(URL_, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-api-key": "good", ...headers },
    body: JSON.stringify(body),
  });
}

async function patch(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await uploads.PATCH(req(body));
  return { status: res.status, json: JSON.parse(await res.text()) };
}

/** The stored row, straight out of the fake database. */
function row(id: string): Record<string, unknown> {
  return store.uploads.find((u) => u.id === id) as Record<string, unknown>;
}

beforeEach(() => {
  authenticateApiToken.mockReset();
  getSession.mockReset();
  recordAudit.mockReset();
  authenticateApiToken.mockResolvedValue(tokenOk({
    id: ME,
    banned: false,
    role: "user",
    email: "me@example.test",
    userCode: "Tagged",
    copyRaw: false,
  }));
  resetDb({
    uploads: [file(MY_FILE, ME), file(OTHER_FILE, ME), file(THEIR_FILE, THEM)],
  });
});

/* -------------------------------------------------------------------------- */
/* published                                                                   */
/* -------------------------------------------------------------------------- */

describe("PATCH /api/uploads - published", () => {
  it("unpublishes and publishes again", async () => {
    const off = await patch({ ids: [MY_FILE], published: false });
    expect(off.status).toBe(200);
    expect(row(MY_FILE).published).toBe(false);
    expect((off.json.items as Array<{ published: boolean }>)[0].published).toBe(false);

    const on = await patch({ ids: [MY_FILE], published: true });
    expect(row(MY_FILE).published).toBe(true);
    expect((on.json.items as Array<{ published: boolean }>)[0].published).toBe(true);
  });

  it("applies to several ids at once", async () => {
    const res = await patch({ ids: [MY_FILE, OTHER_FILE], published: false });
    expect(res.json).toMatchObject({ requested: 2, affected: 2 });
    expect(row(MY_FILE).published).toBe(false);
    expect(row(OTHER_FILE).published).toBe(false);
  });

  it("refuses a mistyped value rather than ignoring it", async () => {
    // Ignoring it would answer 200 with the file unchanged, and a client would
    // believe the change it asked for had been made.
    const res = await patch({ ids: [MY_FILE], published: "yes" });
    expect(res.status).toBe(400);
    expect(row(MY_FILE).published).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* code (vanity)                                                               */
/* -------------------------------------------------------------------------- */

describe("PATCH /api/uploads - code", () => {
  it("normalises the slug the same way the panel does", async () => {
    const res = await patch({ ids: [MY_FILE], code: "My Cool File!" });
    expect(res.status).toBe(200);
    expect(row(MY_FILE).code).toBe("my-cool-file");
  });

  it("returns the NEW link, so a client redraws the card without re-fetching", async () => {
    const res = await patch({ ids: [MY_FILE], code: "holiday" });
    const item = (res.json.items as Array<{ code: string; url: string; rawUrl: string }>)[0];
    expect(item.code).toBe("holiday");
    expect(item.url).toContain("/holiday.png");
    expect(item.rawUrl).toContain("/holiday/raw.png");
  });

  it("still refuses a code another file already holds", async () => {
    // The clash check is the rule that decides which file a URL points at, and
    // it has to bite on this path exactly as it does in the panel.
    const taken = row(OTHER_FILE).code as string;
    const res = await patch({ ids: [MY_FILE], code: taken });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ reason: "code-taken" });
    expect(row(MY_FILE).code).toBe(`code${MY_FILE.slice(-4)}`);
  });

  it("refuses a clash with ANOTHER account's file too", async () => {
    // Codes are globally unique (uploads_code_idx). Scoping the clash check to
    // the caller would hand back a 200 and then die on the constraint.
    const res = await patch({ ids: [MY_FILE], code: row(THEIR_FILE).code as string });
    expect(res.status).toBe(409);
  });

  it("accepts the code the file already has, as a no-op", async () => {
    const same = row(MY_FILE).code as string;
    const res = await patch({ ids: [MY_FILE], code: same });
    expect(res.status).toBe(200);
    expect(row(MY_FILE).code).toBe(same);
  });

  it("refuses a code sent with several ids", async () => {
    // Two files cannot share one URL, so every reading of this request is a
    // mistake. Applying it to the first id would be the worst of them.
    const res = await patch({ ids: [MY_FILE, OTHER_FILE], code: "shared" });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ reason: "code-single-id" });
    expect(row(MY_FILE).code).not.toBe("shared");
    expect(row(OTHER_FILE).code).not.toBe("shared");
  });

  it("refuses a slug that normalises to nothing", async () => {
    const res = await patch({ ids: [MY_FILE], code: "!!!" });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ reason: "invalid-code" });
  });

  it("refuses a slug longer than the column", async () => {
    // `uploads.code` is a varchar(64); without this the write is a 500 that
    // reads like our fault.
    const res = await patch({ ids: [MY_FILE], code: "a".repeat(65) });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ reason: "code-too-long" });
  });

  it("treats another account's file as not found", async () => {
    const res = await patch({ ids: [THEIR_FILE], code: "hijacked" });
    // 404 rather than 403: a 403 would confirm the id is real and belongs to
    // somebody, which is an oracle for enumerating the server's uploads.
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ reason: "not-found" });
    expect(row(THEIR_FILE).code).toBe(`code${THEIR_FILE.slice(-4)}`);
  });

  it("gives an id that never existed the identical answer", async () => {
    const res = await patch({ ids: [fakeUuid(999)], code: "ghost" });
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ reason: "not-found" });
  });
});

/* -------------------------------------------------------------------------- */
/* link settings                                                               */
/* -------------------------------------------------------------------------- */

describe("PATCH /api/uploads - link settings", () => {
  it("sets and clears an expiry", async () => {
    const when = "2027-03-04T05:06:07.000Z";
    await patch({ ids: [MY_FILE], expiresAt: when });
    expect((row(MY_FILE).expiresAt as Date).toISOString()).toBe(when);

    await patch({ ids: [MY_FILE], expiresAt: null });
    expect(row(MY_FILE).expiresAt).toBeNull();
  });

  it("refuses a date it cannot read", async () => {
    const res = await patch({ ids: [MY_FILE], expiresAt: "next tuesday" });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ reason: "invalid-date" });
    expect(row(MY_FILE).expiresAt).toBeNull();
  });

  it("sets and clears a view cap", async () => {
    await patch({ ids: [MY_FILE], maxViews: 3 });
    expect(row(MY_FILE).maxViews).toBe(3);

    await patch({ ids: [MY_FILE], maxViews: null });
    expect(row(MY_FILE).maxViews).toBeNull();
  });

  it("floors the view cap at one", async () => {
    // A cap of zero is a link nobody can open, its owner included, and is always
    // a typo for one.
    await patch({ ids: [MY_FILE], maxViews: 0 });
    expect(row(MY_FILE).maxViews).toBe(1);

    await patch({ ids: [MY_FILE], maxViews: -5 });
    expect(row(MY_FILE).maxViews).toBe(1);

    await patch({ ids: [MY_FILE], maxViews: 2.7 });
    expect(row(MY_FILE).maxViews).toBe(2);
  });

  it("sets a password AND gives up the account default", async () => {
    // `passwordVersion` means "this file is on the account's default password",
    // which is the sole thing letting a recipient's remembered consent open it.
    // A password chosen for THIS file has to clear it, or everyone who ever
    // unlocked one of the owner's files can still read this one.
    store.uploads.find((u) => u.id === MY_FILE)!.passwordVersion = 4;

    const res = await patch({ ids: [MY_FILE], password: "hunter2" });
    expect(res.status).toBe(200);
    expect(typeof row(MY_FILE).passwordHash).toBe("string");
    expect(row(MY_FILE).passwordVersion).toBeNull();
    expect((res.json.items as Array<{ hasPassword: boolean }>)[0].hasPassword).toBe(true);
  });

  it("clears the password on null, and the version with it", async () => {
    store.uploads.find((u) => u.id === MY_FILE)!.passwordVersion = 4;
    await patch({ ids: [MY_FILE], password: null });
    expect(row(MY_FILE).passwordHash).toBeNull();
    expect(row(MY_FILE).passwordVersion).toBeNull();
  });

  it("hashes once for a whole selection", async () => {
    await patch({ ids: [MY_FILE, OTHER_FILE], password: "hunter2" });
    // Same scrypt output on both rows: one hash, applied to the matched set.
    // Per-row hashing would also produce two different salts, which is the
    // cheap way to see that a 500-file selection ran scrypt 500 times.
    expect(row(MY_FILE).passwordHash).toBe(row(OTHER_FILE).passwordHash);
  });

  it("refuses an unbounded password before hashing it", async () => {
    const res = await patch({ ids: [MY_FILE], password: "x".repeat(1025) });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ reason: "password-too-long" });
    expect(row(MY_FILE).passwordHash).toBeNull();
  });

  it("refuses mistyped link settings", async () => {
    expect((await patch({ ids: [MY_FILE], expiresAt: 7 })).status).toBe(400);
    expect((await patch({ ids: [MY_FILE], maxViews: "3" })).status).toBe(400);
    expect((await patch({ ids: [MY_FILE], password: 7 })).status).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */
/* absent vs null                                                              */
/* -------------------------------------------------------------------------- */

describe("PATCH /api/uploads - an absent key changes nothing", () => {
  beforeEach(async () => {
    await patch({ ids: [MY_FILE], expiresAt: "2027-01-01T00:00:00.000Z" });
    await patch({ ids: [MY_FILE], maxViews: 5 });
    await patch({ ids: [MY_FILE], password: "hunter2" });
  });

  it("leaves every unmentioned setting alone", async () => {
    const before = { ...row(MY_FILE) };

    const res = await patch({ ids: [MY_FILE], published: false });
    expect(res.status).toBe(200);

    const after = row(MY_FILE);
    // The distinction between an absent key and an explicit null is the whole
    // reason `supplied()` exists: collapsing them would make "unpublish this"
    // silently drop the expiry, the view cap and the password.
    expect(after.expiresAt).toEqual(before.expiresAt);
    expect(after.maxViews).toBe(before.maxViews);
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.code).toBe(before.code);
    expect(after.folderId).toBe(before.folderId);
    expect(after.published).toBe(false);
  });

  it("leaves them alone across a rename too", async () => {
    const before = { ...row(MY_FILE) };
    await patch({ ids: [MY_FILE], code: "renamed" });
    const after = row(MY_FILE);
    expect(after.code).toBe("renamed");
    expect(after.expiresAt).toEqual(before.expiresAt);
    expect(after.maxViews).toBe(before.maxViews);
    expect(after.passwordHash).toBe(before.passwordHash);
  });

  it("refuses a body that changes nothing at all", async () => {
    const res = await patch({ ids: [MY_FILE] });
    expect(res.status).toBe(400);
    expect(String(res.json.message)).toContain("Nothing to change");
  });
});

/* -------------------------------------------------------------------------- */
/* ownership                                                                   */
/* -------------------------------------------------------------------------- */

describe("PATCH /api/uploads - ownership", () => {
  it("counts another account's file as unaffected rather than refusing", async () => {
    const res = await patch({ ids: [MY_FILE, THEIR_FILE], published: false });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ requested: 2, affected: 1 });
    expect(row(THEIR_FILE).published).toBe(true);
    // And it is absent from the answer, so a client cannot learn it exists.
    const items = res.json.items as Array<{ id: string }>;
    expect(items.map((i) => i.id)).toEqual([MY_FILE]);
  });

  it("never touches another account's link settings", async () => {
    await patch({ ids: [THEIR_FILE], password: "hunter2", expiresAt: "2027-01-01T00:00:00.000Z" });
    expect(row(THEIR_FILE).passwordHash).toBeNull();
    expect(row(THEIR_FILE).expiresAt).toBeNull();
  });

  it("drops an id that is not a uuid instead of handing it to Postgres", async () => {
    // A uuid column answers a malformed value with an error, not a miss, so a
    // client with one bad id in a selection of fifty would get a 500 that looks
    // like our fault and lose the other forty-nine.
    const res = await patch({ ids: ["not-a-uuid", MY_FILE], published: false });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ requested: 2, affected: 1 });
    expect(row(MY_FILE).published).toBe(false);
  });

  it("does not let an administrator reach other accounts through HTTP", async () => {
    // The panel's admin file browser may act on anybody's file (UploadActor
    // .isAdmin). This surface deliberately does not offer that: every link it
    // returns is built from the CALLER's account settings, so a foreign row
    // would come back wearing a URL its owner does not use.
    authenticateApiToken.mockResolvedValue(tokenOk({
      id: ME,
      banned: false,
      role: "admin",
      email: "me@example.test",
      userCode: "Tagged",
      copyRaw: false,
    }));
    const res = await patch({ ids: [THEIR_FILE], published: false });
    expect(res.json).toMatchObject({ affected: 0 });
    expect(row(THEIR_FILE).published).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* several keys at once                                                        */
/* -------------------------------------------------------------------------- */

describe("PATCH /api/uploads - combined", () => {
  it("applies publish, expiry, cap, password and code in one call", async () => {
    const res = await patch({
      ids: [MY_FILE],
      published: false,
      expiresAt: "2027-06-01T00:00:00.000Z",
      maxViews: 1,
      password: "hunter2",
      code: "one-shot",
    });
    expect(res.status).toBe(200);

    const after = row(MY_FILE);
    expect(after.published).toBe(false);
    expect(after.maxViews).toBe(1);
    expect((after.expiresAt as Date).toISOString()).toBe("2027-06-01T00:00:00.000Z");
    expect(typeof after.passwordHash).toBe("string");
    expect(after.code).toBe("one-shot");

    const item = (res.json.items as Array<Record<string, unknown>>)[0];
    // The read-back is what the client draws, so it has to carry the whole new
    // state and not just the last field written.
    expect(item).toMatchObject({ code: "one-shot", published: false, maxViews: 1, hasPassword: true });
  });

  it("writes nothing when a later field is malformed", async () => {
    const res = await patch({ ids: [MY_FILE], published: false, maxViews: "lots" });
    expect(res.status).toBe(400);
    // Validation runs over the whole body before the first write, so a bad key
    // cannot leave half a change behind for the client to guess at.
    expect(row(MY_FILE).published).toBe(true);
  });

  it("answers in the item shape GET uses", async () => {
    const res = await patch({ ids: [MY_FILE], published: false });
    const item = (res.json.items as Array<Record<string, unknown>>)[0];
    expect(Object.keys(item).sort()).toEqual(
      [
        "blurhash",
        "code",
        "copyUrl",
        "createdAt",
        "downloads",
        "expiresAt",
        "ext",
        "filename",
        "folderId",
        "hasPassword",
        "height",
        "id",
        "kind",
        "maxViews",
        "mimeType",
        "motionThumbUrl",
        "published",
        "rawUrl",
        "size",
        "thumbUrl",
        "url",
        "views",
        "width",
      ].sort(),
    );
  });

  it("hands out no links for a file in the trash", async () => {
    store.uploads.find((u) => u.id === MY_FILE)!.deletedAt = new Date();
    const res = await patch({ ids: [MY_FILE], published: false });
    const item = (res.json.items as Array<Record<string, unknown>>)[0];
    // Every one of those URLs 404s while the row sits in the bin, and a link
    // that lies is worse than an absent one.
    expect(item.url).toBeNull();
    expect(item.rawUrl).toBeNull();
    expect(item.thumbUrl).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* the core, directly                                                          */
/* -------------------------------------------------------------------------- */

describe("lib/uploads core", () => {
  const admin = { userId: "admin-1", email: "root@example.test", isAdmin: true };

  it("lets an administrator act on another account's file, and records it", async () => {
    const rows = await setPublishedFor(admin, [THEIR_FILE], false);
    expect(rows).toHaveLength(1);
    expect(row(THEIR_FILE).published).toBe(false);
    // Touching somebody else's file leaves no trace in the file itself, so
    // without this entry "who unpublished this?" has no answer that survives
    // the session.
    expect(recordAudit).toHaveBeenCalledWith(
      "admin-1",
      "admin.upload.published",
      expect.objectContaining({ uploadId: THEIR_FILE, ownerId: THEM, published: false }),
    );
  });

  it("records nothing when acting on one's own file", async () => {
    await setPublishedFor({ userId: ME, email: "me@example.test" }, [MY_FILE], false);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("refuses a vanity clash with a typed reason, not a message to parse", async () => {
    const taken = row(OTHER_FILE).code as string;
    await expect(
      setVanityFor({ userId: ME, email: "me@example.test" }, MY_FILE, taken),
    ).rejects.toBeInstanceOf(UploadOpError);
    try {
      await setVanityFor({ userId: ME, email: "me@example.test" }, MY_FILE, taken);
    } catch (err) {
      expect((err as InstanceType<typeof UploadOpError>).reason).toBe("code-taken");
    }
  });
});

/**
 * A vanity code that the application itself owns can never be served.
 *
 * For an account with `skipTagInUrl` the public link is `/{code}`, so a code of
 * "login" or "dashboard" loses to the real Next route: the file is unreachable
 * AND the code stays consumed by the unique index, so nobody else can have it
 * either. Refusing it is not a restriction; accepting it was the bug.
 */
describe("reserved vanity codes", () => {
  it("refuses a code the app already owns", async () => {
    const { isReservedTag } = await import("@/lib/naming");
    // Sanity: if these ever stopped being reserved the test below would pass by
    // asserting nothing.
    expect(isReservedTag("login")).toBe(true);
    expect(isReservedTag("dashboard")).toBe(true);
    expect(isReservedTag("avatar")).toBe(true);

    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../lib/uploads.ts", import.meta.url), "utf8"),
    );
    // The guard runs on the NORMALISED code and before the length check, so a
    // reserved name cannot slip through as "too long" or in a different case.
    expect(source).toContain("isReservedTag(code)");
    expect(source.indexOf("isReservedTag(code)")).toBeLessThan(
      source.indexOf("code-too-long", source.indexOf("isReservedTag(code)") - 400),
    );
  });
});
