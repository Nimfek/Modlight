import { describe, it, expect, vi, beforeEach } from "vitest";
import { tokenBanned, tokenOk, tokenUnknown } from "../helpers/token-auth";

/**
 * The folder write verbs a desktop client meets, driven end to end: real route
 * handler, real `lib/folders.ts` core, and tests/helpers/fake-db.ts underneath
 * parsing the WHERE clauses and filtering real rows.
 *
 * Only the credential is stubbed. Everything the task cares about — which mode a
 * DELETE lands in when a field is omitted, what another account's folder id
 * looks like from outside, whether the depth ceiling and the cycle guard still
 * bite once the session is out of the picture — is a property of the whole path,
 * and a test that mocked the core would only prove the route can call a mock.
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
vi.mock("@/lib/media/derived-cache", () => ({ purgeDerived: vi.fn(async () => {}) }));

const { resetDb, store, fakeUuid } = await import("../helpers/fake-db");
const folders = await import("@/app/api/folders/route");
const uploads = await import("@/app/api/uploads/route");
const { MAX_FOLDER_DEPTH } = await import("@/lib/folders");
const { ROOT_FOLDER } = await import("@/lib/upload/folder-target");

const ME = "u1";
const THEM = "u2";
const MINE = fakeUuid(101);
const THEIRS = fakeUuid(102);

const FOLDERS_URL = "https://host.example.com/api/folders";
const UPLOADS_URL = "https://host.example.com/api/uploads";

function folder(id: string, ownerId: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    ownerId,
    parentId: null,
    name: "Folder",
    slug: "folder",
    description: null,
    isPublic: false,
    coverUploadId: null,
    sortOrder: 0,
    createdAt: new Date(),
    ...extra,
  };
}

/** A signed-in request carrying a JSON body. */
function req(url: string, method: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", "x-api-key": "good", ...headers },
    body: JSON.stringify(body),
  });
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await res.text());
}

/** Create a folder through the endpoint and return its id. */
async function create(name: string, parentId?: string | null): Promise<string> {
  const body: Record<string, unknown> = { name };
  if (parentId !== undefined) body.parentId = parentId;
  const res = await folders.POST(req(FOLDERS_URL, "POST", body));
  expect(res.status).toBe(201);
  const json = await readJson(res);
  return (json.folder as { id: string }).id;
}

beforeEach(() => {
  authenticateApiToken.mockReset();
  getSession.mockReset();
  // The token path throughout: it is what a desktop client actually holds, and
  // it keeps the fake database out of the `user` table, which it does not model.
  authenticateApiToken.mockResolvedValue(tokenOk({ id: ME, banned: false, role: "user", copyRaw: false }));
  resetDb({
    folders: [
      folder(MINE, ME, { name: "Mine", slug: "mine" }),
      folder(THEIRS, THEM, { name: "Theirs", slug: "theirs" }),
    ],
  });
});

/* -------------------------------------------------------------------------- */
/* Authentication                                                              */
/* -------------------------------------------------------------------------- */

const WRITES: Array<[string, (r: Request) => Promise<Response>, string]> = [
  ["POST /api/folders", (r) => folders.POST(r), "POST"],
  ["PATCH /api/folders", (r) => folders.PATCH(r), "PATCH"],
  ["DELETE /api/folders", (r) => folders.DELETE(r), "DELETE"],
  ["PATCH /api/uploads", (r) => uploads.PATCH(r), "PATCH"],
];

describe.each(WRITES)("%s, credential", (name, call, method) => {
  const url = name.endsWith("/api/uploads") ? UPLOADS_URL : FOLDERS_URL;
  const body = { id: MINE, name: "x", ids: [fakeUuid(301)], folderId: null };

  it("refuses a request carrying neither a token nor a session", async () => {
    authenticateApiToken.mockReset();
    getSession.mockResolvedValue(null);
    const res = await call(
      new Request(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    expect(res.status).toBe(401);
    // One wording across /api/me, /api/folders, /api/uploads and
    // /api/shortlinks, so a client needs one branch rather than four.
    expect(await readJson(res)).toMatchObject({ message: "Token not specified or not found." });
  });

  it("refuses an invalid token WITHOUT falling through to the session", async () => {
    authenticateApiToken.mockResolvedValue(tokenUnknown());
    getSession.mockResolvedValue({ user: { id: THEM } });
    expect((await call(req(url, method, body, { "x-api-key": "revoked" }))).status).toBe(401);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("refuses a banned account holding a working token", async () => {
    authenticateApiToken.mockResolvedValue(tokenBanned({ id: ME, banned: true, role: "user" }));
    expect((await call(req(url, method, body))).status).toBe(401);
  });

  it("refuses before reading the body, so an anonymous flood is cheap", async () => {
    authenticateApiToken.mockReset();
    getSession.mockResolvedValue(null);
    const res = await call(
      new Request(url, { method, headers: { "content-type": "text/plain" }, body: "not json" }),
    );
    // 401 rather than 415: an unauthenticated caller learns nothing about the
    // parser, and we never buffered the body to find out.
    expect(res.status).toBe(401);
  });

  it("marks the answer private, so no shared cache keeps it", async () => {
    // `req()` attaches a token header, so the refusal has to come from the token
    // store rather than from an absent credential.
    authenticateApiToken.mockResolvedValue(tokenUnknown());
    getSession.mockResolvedValue(null);
    const res = await call(req(url, method, body));
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("requires a JSON content type", async () => {
    // A CSRF control on POST, where `text/plain` would be a CORS-simple request
    // a stranger's page could send at a logged-in visitor without a preflight.
    const res = await call(
      new Request(url, {
        method,
        headers: { "content-type": "text/plain;charset=UTF-8", "x-api-key": "good" },
        body: JSON.stringify(body),
      }),
    );
    expect(res.status).toBe(415);
  });
});

/* -------------------------------------------------------------------------- */
/* POST                                                                        */
/* -------------------------------------------------------------------------- */

describe("POST /api/folders", () => {
  it("creates a folder and answers in the shape GET uses", async () => {
    const res = await folders.POST(req(FOLDERS_URL, "POST", { name: "Holiday Photos" }));
    expect(res.status).toBe(201);

    const { folder: created } = (await readJson(res)) as { folder: Record<string, unknown> };
    // Exactly the keys a listing row carries, so a client draws one tile from
    // either answer.
    expect(Object.keys(created).sort()).toEqual(
      ["fileCount", "id", "isPublic", "name", "parentId", "size", "slug", "sortOrder"].sort(),
    );
    expect(created).toMatchObject({
      name: "Holiday Photos",
      slug: "holiday-photos",
      parentId: null,
      isPublic: false,
      fileCount: 0,
      size: 0,
    });
    expect(store.folders.find((f) => f.id === created.id)?.ownerId).toBe(ME);
  });

  it("nests under a parent the caller owns", async () => {
    const res = await folders.POST(req(FOLDERS_URL, "POST", { name: "Child", parentId: MINE }));
    expect(res.status).toBe(201);
    expect((await readJson(res)).folder).toMatchObject({ parentId: MINE });
  });

  it("treats another account's parent as a 404, not a 403", async () => {
    const res = await folders.POST(req(FOLDERS_URL, "POST", { name: "Nope", parentId: THEIRS }));
    // 403 would confirm the id is real and belongs to somebody, turning this
    // into a way to enumerate the server's folders one guess at a time.
    expect(res.status).toBe(404);
    expect(await readJson(res)).toMatchObject({ reason: "not-found" });
    expect(store.folders).toHaveLength(2);
  });

  it("gives a malformed parent id the identical answer", async () => {
    const res = await folders.POST(req(FOLDERS_URL, "POST", { name: "x", parentId: "nope" }));
    expect(res.status).toBe(404);
  });

  it("still refuses to nest past the depth ceiling", async () => {
    let parent: string | null = null;
    for (let i = 0; i < MAX_FOLDER_DEPTH; i++) parent = await create(`Level ${i + 1}`, parent);

    const res = await folders.POST(req(FOLDERS_URL, "POST", { name: "Too deep", parentId: parent }));
    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({ reason: "too-deep" });
  });

  it("requires a name", async () => {
    expect((await folders.POST(req(FOLDERS_URL, "POST", {}))).status).toBe(400);
    expect((await folders.POST(req(FOLDERS_URL, "POST", { name: 7 }))).status).toBe(400);
  });

  it("refuses a parentId that is neither a string nor null", async () => {
    const res = await folders.POST(req(FOLDERS_URL, "POST", { name: "x", parentId: 7 }));
    expect(res.status).toBe(400);
  });

  it("accepts the rootValue sentinel as 'no parent'", async () => {
    const res = await folders.POST(
      req(FOLDERS_URL, "POST", { name: "Top", parentId: ROOT_FOLDER }),
    );
    expect(res.status).toBe(201);
    expect((await readJson(res)).folder).toMatchObject({ parentId: null });
  });

  it("refuses a body that is not a JSON object", async () => {
    const res = await folders.POST(req(FOLDERS_URL, "POST", ["name"]));
    expect(res.status).toBe(400);
  });

  it("refuses an oversized body by its declared length", async () => {
    const res = await folders.POST(
      new Request(FOLDERS_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "good",
          "content-length": String(64 * 1024),
        },
        body: JSON.stringify({ name: "x".repeat(64 * 1024) }),
      }),
    );
    expect(res.status).toBe(413);
  });
});

/* -------------------------------------------------------------------------- */
/* PATCH                                                                       */
/* -------------------------------------------------------------------------- */

describe("PATCH /api/folders", () => {
  it("renames", async () => {
    const res = await folders.PATCH(req(FOLDERS_URL, "PATCH", { id: MINE, name: "Renamed" }));
    expect(res.status).toBe(200);
    expect((await readJson(res)).folder).toMatchObject({ name: "Renamed", slug: "renamed" });
  });

  it("moves into a folder", async () => {
    const child = await create("Child");
    const res = await folders.PATCH(req(FOLDERS_URL, "PATCH", { id: child, parentId: MINE }));
    expect(res.status).toBe(200);
    expect((await readJson(res)).folder).toMatchObject({ parentId: MINE });
  });

  it("moves back to the root when parentId is null", async () => {
    const child = await create("Child", MINE);
    const res = await folders.PATCH(req(FOLDERS_URL, "PATCH", { id: child, parentId: null }));
    expect(res.status).toBe(200);
    expect((await readJson(res)).folder).toMatchObject({ parentId: null });
    expect(store.folders.find((f) => f.id === child)?.parentId).toBeNull();
  });

  it("accepts the rootValue sentinel as the root too", async () => {
    const child = await create("Child", MINE);
    const res = await folders.PATCH(
      req(FOLDERS_URL, "PATCH", { id: child, parentId: ROOT_FOLDER }),
    );
    expect(res.status).toBe(200);
    expect((await readJson(res)).folder).toMatchObject({ parentId: null });
  });

  it("leaves the parent alone when parentId is absent", async () => {
    const child = await create("Child", MINE);
    await folders.PATCH(req(FOLDERS_URL, "PATCH", { id: child, name: "Still nested" }));
    // The distinction between an absent key and an explicit null is the whole
    // reason `supplied()` exists: collapsing them would make every rename
    // silently un-nest the folder.
    expect(store.folders.find((f) => f.id === child)?.parentId).toBe(MINE);
  });

  it("publishes and unpublishes", async () => {
    const on = await folders.PATCH(req(FOLDERS_URL, "PATCH", { id: MINE, isPublic: true }));
    expect((await readJson(on)).folder).toMatchObject({ isPublic: true });
    const off = await folders.PATCH(req(FOLDERS_URL, "PATCH", { id: MINE, isPublic: false }));
    expect((await readJson(off)).folder).toMatchObject({ isPublic: false });
  });

  it("applies a rename and a move together, re-deriving the slug in the destination", async () => {
    const child = await create("Child", MINE);
    const res = await folders.PATCH(
      req(FOLDERS_URL, "PATCH", { id: child, name: "Mine", parentId: null }),
    );
    expect(res.status).toBe(200);
    // "mine" is taken at the root by the fixture folder, so the move has to pick
    // a free slug from the NEW name rather than keep one computed for the old.
    expect((await readJson(res)).folder).toMatchObject({ name: "Mine", slug: "mine-2" });
  });

  it("refuses a cycle", async () => {
    const child = await create("Child", MINE);
    const res = await folders.PATCH(req(FOLDERS_URL, "PATCH", { id: MINE, parentId: child }));
    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({ reason: "cycle" });
    expect(store.folders.find((f) => f.id === MINE)?.parentId).toBeNull();
  });

  it("refuses moving a folder into itself", async () => {
    const res = await folders.PATCH(req(FOLDERS_URL, "PATCH", { id: MINE, parentId: MINE }));
    expect(res.status).toBe(409);
  });

  it("refuses a move that would breach the depth ceiling", async () => {
    let parent: string | null = null;
    for (let i = 0; i < MAX_FOLDER_DEPTH; i++) parent = await create(`Level ${i + 1}`, parent);
    const res = await folders.PATCH(req(FOLDERS_URL, "PATCH", { id: MINE, parentId: parent }));
    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({ reason: "too-deep" });
  });

  it("treats another account's folder as not found", async () => {
    const res = await folders.PATCH(req(FOLDERS_URL, "PATCH", { id: THEIRS, name: "Hijacked" }));
    expect(res.status).toBe(404);
    expect(store.folders.find((f) => f.id === THEIRS)?.name).toBe("Theirs");
  });

  it("refuses an empty name", async () => {
    const res = await folders.PATCH(req(FOLDERS_URL, "PATCH", { id: MINE, name: "   " }));
    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({ reason: "invalid-name" });
  });

  it("refuses a body that changes nothing", async () => {
    const res = await folders.PATCH(req(FOLDERS_URL, "PATCH", { id: MINE }));
    expect(res.status).toBe(400);
  });

  it("refuses a mistyped field rather than ignoring it", async () => {
    // Ignoring it would answer 200 with the folder unchanged, and a client would
    // believe the change it asked for had been made.
    expect(
      (await folders.PATCH(req(FOLDERS_URL, "PATCH", { id: MINE, isPublic: "yes" }))).status,
    ).toBe(400);
    expect((await folders.PATCH(req(FOLDERS_URL, "PATCH", { id: MINE, name: 7 }))).status).toBe(400);
  });

  it("requires an id", async () => {
    expect((await folders.PATCH(req(FOLDERS_URL, "PATCH", { name: "x" }))).status).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */
/* DELETE                                                                      */
/* -------------------------------------------------------------------------- */

describe("DELETE /api/folders", () => {
  const FILE = fakeUuid(201);

  async function withAFile(): Promise<string> {
    const child = await create("Child", MINE);
    store.uploads.push({
      id: FILE,
      ownerId: ME,
      folderId: MINE,
      size: 100,
      deletedAt: null,
      updatedAt: new Date(),
    });
    return child;
  }

  it("DEFAULTS to the safe mode when withContents is omitted", async () => {
    const child = await withAFile();
    const res = await folders.DELETE(req(FOLDERS_URL, "DELETE", { id: MINE }));

    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({
      message: "OK",
      withContents: false,
      folders: 1,
      trashed: 0,
    });
    // The file survived, out of any folder rather than in the bin...
    expect(store.uploads.find((u) => u.id === FILE)).toMatchObject({
      folderId: null,
      deletedAt: null,
    });
    // ...and the child folder was re-parented rather than deleted.
    expect(store.folders.find((f) => f.id === child)?.parentId).toBeNull();
  });

  it("only empties a tree into the trash when withContents is explicitly true", async () => {
    const child = await withAFile();
    const res = await folders.DELETE(
      req(FOLDERS_URL, "DELETE", { id: MINE, withContents: true }),
    );

    expect(await readJson(res)).toMatchObject({ withContents: true, folders: 2, trashed: 1 });
    expect(store.folders.find((f) => f.id === child)).toBeUndefined();
    expect(store.uploads.find((u) => u.id === FILE)?.deletedAt).toBeInstanceOf(Date);
  });

  it("does not accept a truthy string as consent", async () => {
    await withAFile();
    // A checkbox stringified on its way out of some client must not be the thing
    // that empties a folder into the trash.
    const res = await folders.DELETE(
      req(FOLDERS_URL, "DELETE", { id: MINE, withContents: "true" }),
    );
    expect(res.status).toBe(400);
    expect(store.folders.find((f) => f.id === MINE)).toBeDefined();
  });

  it("treats another account's folder as not found and deletes nothing", async () => {
    const res = await folders.DELETE(
      req(FOLDERS_URL, "DELETE", { id: THEIRS, withContents: true }),
    );
    expect(res.status).toBe(404);
    expect(await readJson(res)).toMatchObject({ reason: "not-found" });
    expect(store.folders.find((f) => f.id === THEIRS)).toBeDefined();
  });

  it("requires an id", async () => {
    expect((await folders.DELETE(req(FOLDERS_URL, "DELETE", {}))).status).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */
/* PATCH /api/uploads                                                          */
/* -------------------------------------------------------------------------- */

describe("PATCH /api/uploads", () => {
  const MY_FILE = fakeUuid(301);
  const THEIR_FILE = fakeUuid(302);

  /**
   * A row carrying every column the endpoint now reads back.
   *
   * The old fixture held only what a folder move touches, which was enough
   * while the answer was a bare count. It stopped being enough the moment PATCH
   * began returning the rows it changed, in the shape GET uses - `toFileItems`
   * calls `createdAt.toISOString()`, and an undefined one is a TypeError rather
   * than a missing field.
   */
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

  beforeEach(() => {
    store.uploads.push(file(MY_FILE, ME), file(THEIR_FILE, THEM));
  });

  it("moves files into a folder the caller owns", async () => {
    const res = await uploads.PATCH(
      req(UPLOADS_URL, "PATCH", { ids: [MY_FILE], folderId: MINE }),
    );
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({
      message: "OK",
      requested: 1,
      affected: 1,
      folderId: MINE,
    });
    expect(store.uploads.find((u) => u.id === MY_FILE)?.folderId).toBe(MINE);
  });

  it("moves files out of every folder when folderId is null", async () => {
    await uploads.PATCH(req(UPLOADS_URL, "PATCH", { ids: [MY_FILE], folderId: MINE }));
    const res = await uploads.PATCH(req(UPLOADS_URL, "PATCH", { ids: [MY_FILE], folderId: null }));
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ affected: 1, folderId: null });
    expect(store.uploads.find((u) => u.id === MY_FILE)?.folderId).toBeNull();
  });

  it("accepts the rootValue sentinel as 'no folder'", async () => {
    await uploads.PATCH(req(UPLOADS_URL, "PATCH", { ids: [MY_FILE], folderId: MINE }));
    const res = await uploads.PATCH(
      req(UPLOADS_URL, "PATCH", { ids: [MY_FILE], folderId: ROOT_FOLDER }),
    );
    expect(await readJson(res)).toMatchObject({ affected: 1, folderId: null });
    expect(store.uploads.find((u) => u.id === MY_FILE)?.folderId).toBeNull();
  });

  it("counts another account's file as unaffected rather than refusing", async () => {
    const res = await uploads.PATCH(
      req(UPLOADS_URL, "PATCH", { ids: [MY_FILE, THEIR_FILE], folderId: MINE }),
    );
    // `requested` and `affected` differing is not an error: a client moving a
    // stale selection should not have to treat a partial hit as a failure.
    expect(await readJson(res)).toMatchObject({ requested: 2, affected: 1 });
    expect(store.uploads.find((u) => u.id === THEIR_FILE)?.folderId).toBeNull();
  });

  it("treats another account's target folder as not found", async () => {
    const res = await uploads.PATCH(
      req(UPLOADS_URL, "PATCH", { ids: [MY_FILE], folderId: THEIRS }),
    );
    expect(res.status).toBe(404);
    expect(store.uploads.find((u) => u.id === MY_FILE)?.folderId).toBeNull();
  });

  it("requires folderId to be present, so a slip cannot mean 'unfile everything'", async () => {
    const res = await uploads.PATCH(req(UPLOADS_URL, "PATCH", { ids: [MY_FILE] }));
    expect(res.status).toBe(400);
    expect(store.uploads.find((u) => u.id === MY_FILE)?.folderId).toBeNull();
  });

  it("refuses an empty id list", async () => {
    expect(
      (await uploads.PATCH(req(UPLOADS_URL, "PATCH", { ids: [], folderId: null }))).status,
    ).toBe(400);
    expect(
      (await uploads.PATCH(req(UPLOADS_URL, "PATCH", { folderId: null }))).status,
    ).toBe(400);
  });

  it("caps the id list, exactly as DELETE does", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => fakeUuid(1000 + i));
    const res = await uploads.PATCH(req(UPLOADS_URL, "PATCH", { ids, folderId: null }));
    expect(res.status).toBe(400);
    expect((await readJson(res)).message).toMatch(/max 500/);
  });

  it("accepts a body carrying the full permitted id list", async () => {
    // The size ceiling has to be derived from the id ceiling, not guessed: 500
    // quoted uuids are ~20 KB, so the 16 KiB default used elsewhere refused a
    // request that was within every documented limit — with a 413, which reads
    // as "your body is malformed" rather than "you selected too many files".
    const ids = [MY_FILE, ...Array.from({ length: 499 }, (_, i) => fakeUuid(2000 + i))];
    const res = await uploads.PATCH(req(UPLOADS_URL, "PATCH", { ids, folderId: MINE }));
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ requested: 500, affected: 1 });
  });

  it("refuses a folderId that is neither a string nor null", async () => {
    const res = await uploads.PATCH(
      req(UPLOADS_URL, "PATCH", { ids: [MY_FILE], folderId: 7 }),
    );
    expect(res.status).toBe(400);
  });
});
