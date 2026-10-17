import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The folder rules, exercised through the session-free core the panel's Server
 * Actions and `/api/folders` now share.
 *
 * These run against tests/helpers/fake-db.ts, which parses the Drizzle WHERE
 * clause and filters real rows with it. That is the whole reason it exists: the
 * rule under test is that ownership lives IN the query rather than in a check
 * after the rows come back, and a stub that answers the same rows to every
 * question cannot tell those two apart. Here, deleting
 * `eq(folders.ownerId, userId)` from lib/folders.ts makes the "another
 * account's folder" tests fail, because the fake would then hand the row over
 * exactly as Postgres would.
 */

vi.mock("@/lib/db", async () => {
  const fake = await import("../helpers/fake-db");
  return { db: fake.db };
});
// Storage, not a rule: `deleteFolderFor` clears cached conversions for the files
// it trashes, and that has no bearing on any decision made here.
vi.mock("@/lib/media/derived-cache", () => ({ purgeDerived: vi.fn(async () => {}) }));

const { resetDb, store, statements, statementsFor, fakeUuid } = await import(
  "../helpers/fake-db"
);
const {
  createFolderFor,
  deleteFolderFor,
  FolderOpError,
  getOwnedFolder,
  MAX_FOLDER_DEPTH,
  moveFolderFor,
  moveUploadsToFolderFor,
  renameFolderFor,
  setFolderVisibilityFor,
} = await import("@/lib/folders");

const ME = "u1";
const THEM = "u2";

/** A folder row as the DB would hold it. */
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

/** An upload row, trimmed to the columns these paths touch. */
function upload(id: string, ownerId: string, folderId: string | null) {
  return { id, ownerId, folderId, size: 100, deletedAt: null, updatedAt: new Date() };
}

const MINE = fakeUuid(101);
const THEIRS = fakeUuid(102);

beforeEach(() => {
  resetDb({
    folders: [
      folder(MINE, ME, { name: "Mine", slug: "mine" }),
      folder(THEIRS, THEM, { name: "Theirs", slug: "theirs" }),
    ],
  });
});

/** Assert a rejection carries the expected `reason`, and hand it back. */
async function refusal(promise: Promise<unknown>): Promise<InstanceType<typeof FolderOpError>> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(FolderOpError);
    return err as InstanceType<typeof FolderOpError>;
  }
  throw new Error("expected the operation to be refused, but it succeeded");
}

/* -------------------------------------------------------------------------- */

describe("ownership", () => {
  it("answers 'not found' for another account's folder, never 'forbidden'", async () => {
    const err = await refusal(getOwnedFolder(ME, THEIRS));
    expect(err.reason).toBe("not-found");
    expect(err.message).toBe("Folder not found");
    // The old app/actions/folders.ts said "Forbidden" here, which told a caller
    // that the id was real and belonged to somebody — a directory listing of
    // every folder on the server, one guess at a time.
    expect(err.message).not.toMatch(/forbidden/i);
  });

  it("gives an unknown id the identical answer", async () => {
    const err = await refusal(getOwnedFolder(ME, fakeUuid(999)));
    expect(err.reason).toBe("not-found");
    expect(err.message).toBe("Folder not found");
  });

  it("scopes the lookup by owner inside the query", async () => {
    await getOwnedFolder(ME, MINE);
    const [select] = statementsFor("folders", "select");
    expect(select.whereColumns).toContain("owner_id");
    expect(select.whereColumns).toContain("id");
  });

  it("refuses a malformed id without querying at all", async () => {
    const err = await refusal(getOwnedFolder(ME, "not-a-uuid"));
    expect(err.reason).toBe("not-found");
    // `folders.id` is a uuid column: handing Postgres a malformed one raises an
    // error, which a caller can measure against the silence a well-formed but
    // unknown id gets.
    expect(statements).toHaveLength(0);
  });

  it("will not create a folder under another account's parent", async () => {
    const err = await refusal(createFolderFor(ME, "Nope", THEIRS));
    expect(err.reason).toBe("not-found");
    expect(store.folders).toHaveLength(2);
  });

  it("will not rename another account's folder", async () => {
    const err = await refusal(renameFolderFor(ME, THEIRS, "Hijacked"));
    expect(err.reason).toBe("not-found");
    expect(store.folders.find((f) => f.id === THEIRS)?.name).toBe("Theirs");
  });

  it("will not delete another account's folder", async () => {
    const err = await refusal(deleteFolderFor(ME, THEIRS));
    expect(err.reason).toBe("not-found");
    expect(store.folders).toHaveLength(2);
  });

  it("will not publish another account's folder", async () => {
    const err = await refusal(setFolderVisibilityFor(ME, THEIRS, true));
    expect(err.reason).toBe("not-found");
    expect(store.folders.find((f) => f.id === THEIRS)?.isPublic).toBe(false);
  });

  it("keeps the owner in the WHERE of every folder statement it issues", async () => {
    await createFolderFor(ME, "Anything");
    await renameFolderFor(ME, MINE, "Renamed");
    await setFolderVisibilityFor(ME, MINE, true);
    await deleteFolderFor(ME, MINE);

    for (const s of statementsFor("folders")) {
      if (s.op === "insert") {
        expect((s.values as Record<string, unknown>).ownerId).toBe(ME);
        continue;
      }
      expect(s.whereColumns).toContain("owner_id");
    }
  });
});

describe("createFolderFor", () => {
  it("creates a root folder with a slug derived from the name", async () => {
    const f = await createFolderFor(ME, "  Holiday Photos  ");
    expect(f.name).toBe("Holiday Photos");
    expect(f.slug).toBe("holiday-photos");
    expect(f.parentId).toBeNull();
    expect(f.ownerId).toBe(ME);
  });

  it("falls back to a name rather than refusing an empty one", async () => {
    const f = await createFolderFor(ME, "   ");
    expect(f.name).toBe("Folder");
  });

  it("picks a free slug instead of colliding inside the same parent", async () => {
    const a = await createFolderFor(ME, "Screenshots");
    const b = await createFolderFor(ME, "Screenshots");
    expect(a.slug).toBe("screenshots");
    expect(b.slug).toBe("screenshots-2");
  });

  it("lets the same slug exist under two different parents", async () => {
    const p1 = await createFolderFor(ME, "One");
    const p2 = await createFolderFor(ME, "Two");
    const a = await createFolderFor(ME, "Shots", p1.id);
    const b = await createFolderFor(ME, "Shots", p2.id);
    expect(a.slug).toBe("shots");
    expect(b.slug).toBe("shots");
  });

  it("refuses to nest deeper than the ceiling", async () => {
    let parent: string | null = null;
    for (let i = 0; i < MAX_FOLDER_DEPTH; i++) {
      parent = (await createFolderFor(ME, `Level ${i + 1}`, parent)).id;
    }
    const err = await refusal(createFolderFor(ME, "One too many", parent));
    expect(err.reason).toBe("too-deep");
    expect(err.message).toContain(String(MAX_FOLDER_DEPTH));
  });
});

describe("renameFolderFor", () => {
  it("refuses an empty name", async () => {
    const err = await refusal(renameFolderFor(ME, MINE, "   "));
    expect(err.reason).toBe("invalid-name");
  });

  it("bounds the name at the column width", async () => {
    const f = await renameFolderFor(ME, MINE, "x".repeat(400));
    expect(f.name).toHaveLength(120);
  });
});

describe("moveFolderFor", () => {
  it("refuses to move a folder inside itself", async () => {
    const err = await refusal(moveFolderFor(ME, MINE, MINE));
    expect(err.reason).toBe("cycle");
  });

  it("refuses to move a folder inside its own descendant", async () => {
    const child = await createFolderFor(ME, "Child", MINE);
    const grandchild = await createFolderFor(ME, "Grandchild", child.id);
    const err = await refusal(moveFolderFor(ME, MINE, grandchild.id));
    expect(err.reason).toBe("cycle");
    expect(store.folders.find((f) => f.id === MINE)?.parentId).toBeNull();
  });

  it("moves a nested folder back to the root", async () => {
    const child = await createFolderFor(ME, "Child", MINE);
    const moved = await moveFolderFor(ME, child.id, null);
    expect(moved.parentId).toBeNull();
    expect(store.folders.find((f) => f.id === child.id)?.parentId).toBeNull();
  });

  it("re-derives the slug for the destination", async () => {
    // A "child" already sits at the root, so moving another one there has to
    // pick a free slug rather than violate the root uniqueness index.
    await createFolderFor(ME, "Child");
    const nested = await createFolderFor(ME, "Child", MINE);
    const moved = await moveFolderFor(ME, nested.id, null);
    expect(moved.slug).toBe("child-2");
  });

  it("refuses a destination that would breach the depth ceiling", async () => {
    let parent: string | null = null;
    for (let i = 0; i < MAX_FOLDER_DEPTH; i++) {
      parent = (await createFolderFor(ME, `Level ${i + 1}`, parent)).id;
    }
    const err = await refusal(moveFolderFor(ME, MINE, parent));
    expect(err.reason).toBe("too-deep");
  });

  it("will not move a folder under another account's parent", async () => {
    const err = await refusal(moveFolderFor(ME, MINE, THEIRS));
    expect(err.reason).toBe("not-found");
    expect(store.folders.find((f) => f.id === MINE)?.parentId).toBeNull();
  });
});

describe("deleteFolderFor", () => {
  const FILE_A = fakeUuid(201);
  const FILE_B = fakeUuid(202);

  async function tree() {
    const child = await createFolderFor(ME, "Child", MINE);
    store.uploads.push(upload(FILE_A, ME, MINE), upload(FILE_B, ME, child.id));
    return child;
  }

  it("defaults to the SAFE mode: nothing is trashed", async () => {
    const child = await tree();
    const result = await deleteFolderFor(ME, MINE);

    expect(result).toEqual({ folders: 1, trashed: 0 });
    // The folder itself is gone...
    expect(store.folders.find((f) => f.id === MINE)).toBeUndefined();
    // ...its child was re-parented to where the deleted folder sat (the root)...
    expect(store.folders.find((f) => f.id === child.id)?.parentId).toBeNull();
    // ...its files fell back to "no folder" rather than into the bin...
    expect(store.uploads.find((u) => u.id === FILE_A)).toMatchObject({
      folderId: null,
      deletedAt: null,
    });
    // ...and the child's files were never touched at all.
    expect(store.uploads.find((u) => u.id === FILE_B)).toMatchObject({
      folderId: child.id,
      deletedAt: null,
    });
  });

  it("only trashes when withContents is explicitly true", async () => {
    const child = await tree();
    const result = await deleteFolderFor(ME, MINE, { withContents: true });

    expect(result).toEqual({ folders: 2, trashed: 2 });
    expect(store.folders.find((f) => f.id === child.id)).toBeUndefined();
    for (const id of [FILE_A, FILE_B]) {
      expect(store.uploads.find((u) => u.id === id)?.deletedAt).toBeInstanceOf(Date);
    }
  });

  it("treats an absent flag exactly like withContents: false", async () => {
    await tree();
    const omitted = await deleteFolderFor(ME, MINE);
    expect(omitted.trashed).toBe(0);

    resetDb({ folders: [folder(MINE, ME, { name: "Mine", slug: "mine" })] });
    await tree();
    const explicit = await deleteFolderFor(ME, MINE, { withContents: false });
    expect(explicit).toEqual(omitted);
  });

  it("leaves a file already in the trash where it is", async () => {
    await tree();
    const already = new Date("2020-01-01T00:00:00Z");
    store.uploads.find((u) => u.id === FILE_A)!.deletedAt = already;

    const result = await deleteFolderFor(ME, MINE, { withContents: true });
    // Counted once, not twice: re-stamping a row already in the bin would hand
    // it another 30 days before the sweeper reclaims it.
    expect(result.trashed).toBe(1);
    expect(store.uploads.find((u) => u.id === FILE_A)?.deletedAt).toBe(already);
  });
});

describe("moveUploadsToFolderFor", () => {
  const MY_FILE = fakeUuid(301);
  const THEIR_FILE = fakeUuid(302);

  beforeEach(() => {
    store.uploads.push(upload(MY_FILE, ME, null), upload(THEIR_FILE, THEM, null));
  });

  it("moves the caller's files into a folder they own", async () => {
    const result = await moveUploadsToFolderFor(ME, [MY_FILE], MINE);
    expect(result).toEqual({ moved: 1 });
    expect(store.uploads.find((u) => u.id === MY_FILE)?.folderId).toBe(MINE);
  });

  it("moves files out of every folder when the target is null", async () => {
    await moveUploadsToFolderFor(ME, [MY_FILE], MINE);
    const result = await moveUploadsToFolderFor(ME, [MY_FILE], null);
    expect(result).toEqual({ moved: 1 });
    expect(store.uploads.find((u) => u.id === MY_FILE)?.folderId).toBeNull();
  });

  it("silently skips another account's file rather than moving it", async () => {
    const result = await moveUploadsToFolderFor(ME, [MY_FILE, THEIR_FILE], MINE);
    expect(result).toEqual({ moved: 1 });
    expect(store.uploads.find((u) => u.id === THEIR_FILE)?.folderId).toBeNull();
  });

  it("refuses a target folder the caller does not own, and moves nothing", async () => {
    const err = await refusal(moveUploadsToFolderFor(ME, [MY_FILE], THEIRS));
    expect(err.reason).toBe("not-found");
    expect(store.uploads.find((u) => u.id === MY_FILE)?.folderId).toBeNull();
  });

  it("drops ids that are not uuids instead of handing them to Postgres", async () => {
    const result = await moveUploadsToFolderFor(ME, ["../../etc/passwd", MY_FILE], MINE);
    expect(result).toEqual({ moved: 1 });
  });

  it("does nothing at all when no id survives validation", async () => {
    const result = await moveUploadsToFolderFor(ME, ["nope", ""], MINE);
    expect(result).toEqual({ moved: 0 });
    // Not even the folder lookup: there is nothing to move it into.
    expect(statements).toHaveLength(0);
  });

  it("keeps the owner in the WHERE of the UPDATE", async () => {
    await moveUploadsToFolderFor(ME, [MY_FILE], null);
    const [update] = statementsFor("uploads", "update");
    expect(update.whereColumns).toContain("owner_id");
    expect(update.whereColumns).toContain("id");
  });
});
