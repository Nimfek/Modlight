import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * "Pick one of my files", and what happens when the file is gone.
 *
 * Two claims, and both are one deleted word away from being false:
 *
 *  1. The upload id arrives from the browser, so the OWNER has to be inside the
 *     SELECT that fetches it. A check applied to a row that was already fetched
 *     is answering a question about a table as it looked a moment ago - and here
 *     the consequence is reading another account's private file and publishing
 *     a crop of it as somebody's face.
 *  2. An avatar that cannot be resolved degrades to initials. Never to a broken
 *     image, and never to a 500.
 *
 * Asserted against the SQL Drizzle actually renders, because "the owner is
 * checked" and "the owner is checked IN THIS STATEMENT" are different claims and
 * only the second one is a defence.
 */

const requireUser = vi.fn();
const getStorage = vi.fn();
const saveAvatar = vi.fn();

vi.mock("@/lib/auth-helpers", () => ({ requireUser, getSession: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/storage", () => ({ getStorage }));
vi.mock("@/lib/avatar-store", () => ({ saveAvatar, clearAvatar: vi.fn() }));

/** Rows the next SELECT resolves to, and the WHERE clauses it was handed. */
let rows: unknown[] = [];
let whereClauses: unknown[] = [];

function chain(): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
            Promise.resolve(rows).then(ok, err);
        }
        if (prop === "catch") {
          return (err: (e: unknown) => unknown) => Promise.resolve(rows).catch(err);
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
    select: () => chain(),
    insert: () => chain(),
    update: () => chain(),
    delete: () => chain(),
  },
}));

const { PgDialect } = await import("drizzle-orm/pg-core");
const { setAvatarFromUpload } = await import("@/app/actions/avatar");
const { avatarUrl, avatarKey } = await import("@/lib/avatar");
const avatarRoute = await import("@/app/avatar/[userCode]/route");

const ME = "11111111-1111-4111-8111-111111111111";
const MINE = "00000000-0000-4000-8000-000000000001";
const THEIRS = "deadbeef-dead-4bee-8bee-deadbeefdead";

/** The rendered WHERE of the upload lookup, whitespace-flattened. */
function whereSql(index = 0): { text: string; params: unknown[] } {
  const built = new PgDialect().sqlToQuery(whereClauses[index] as never);
  return { text: built.sql.replace(/\s+/g, " "), params: built.params };
}

beforeEach(() => {
  requireUser.mockReset();
  getStorage.mockReset();
  saveAvatar.mockReset();
  requireUser.mockResolvedValue({ user: { id: ME, email: "me@local.test" } });
  getStorage.mockReturnValue({ readBuffer: vi.fn(async () => Buffer.from("bytes")) });
  saveAvatar.mockResolvedValue({
    ok: true,
    url: "/avatar/mytag?v=abc",
    bytes: 1234,
    animated: false,
    degraded: null,
  });
  rows = [];
  whereClauses = [];
});

describe("setAvatarFromUpload: ownership", () => {
  it("scopes the lookup to the caller inside the statement itself", async () => {
    rows = [{ storageKey: "u/1.png", mimeType: "image/png", ext: "png", size: 1000 }];
    await setAvatarFromUpload(MINE);

    const { text, params } = whereSql();
    expect(text).toContain('"uploads"."owner_id" =');
    expect(text).toContain('"uploads"."id" =');
    // Trash is excluded: a file on its way out must not leave a copy of itself
    // on somebody's profile.
    expect(text).toContain('"uploads"."deleted_at" is null');
    // The session's id, not anything the caller sent, and bound rather than
    // interpolated into the text.
    expect(params).toContain(ME);
    expect(params).toContain(MINE);
  });

  it("cannot reach another account's file", async () => {
    // The attempt: a hand-crafted call naming somebody else's upload. It is a
    // well-formed uuid, so nothing upstream rejects it - the WHERE is the only
    // thing standing between this call and the file, which is why the SELECT
    // matches nothing.
    rows = [];
    const result = await setAvatarFromUpload(THEIRS);

    expect(result).toEqual({ ok: false, error: "not-found" });
    expect(whereSql().params).toContain(ME);
    // Nothing was read and nothing was written.
    expect(saveAvatar).not.toHaveBeenCalled();
  });

  it("never lets a malformed id reach the uuid column", async () => {
    // `uploads.id` is uuid; Postgres raises a syntax error on anything else,
    // which would surface as a 500 on a request anybody can send by hand.
    const result = await setAvatarFromUpload("' OR 1=1 --");

    expect(result).toEqual({ ok: false, error: "not-found" });
    expect(whereClauses).toHaveLength(0);
    expect(saveAvatar).not.toHaveBeenCalled();
  });

  it("refuses an SVG even though it is stored as an image", async () => {
    // libvips would rasterise it, but its SVG loader has been a source of
    // file-read and network-fetch bugs, and an uploaded SVG is exactly the
    // attacker-controlled document that path was never meant to meet.
    rows = [{ storageKey: "u/1.svg", mimeType: "image/svg+xml", ext: "svg", size: 500 }];

    expect(await setAvatarFromUpload(MINE)).toEqual({ ok: false, error: "unsupported" });
    expect(saveAvatar).not.toHaveBeenCalled();
  });

  it("applies the input ceiling to a stored file too, not just to a browser body", async () => {
    rows = [{ storageKey: "u/1.png", mimeType: "image/png", ext: "png", size: 40 * 1024 * 1024 }];

    expect(await setAvatarFromUpload(MINE)).toEqual({ ok: false, error: "too-large" });
    expect(saveAvatar).not.toHaveBeenCalled();
  });

  it("reports a row whose bytes have vanished as missing, not as a crash", async () => {
    rows = [{ storageKey: "u/gone.png", mimeType: "image/png", ext: "png", size: 1000 }];
    getStorage.mockReturnValue({
      readBuffer: vi.fn(async () => {
        throw new Error("ENOENT");
      }),
    });

    expect(await setAvatarFromUpload(MINE)).toEqual({ ok: false, error: "not-found" });
  });
});

describe("an avatar that is gone falls back to initials", () => {
  it("resolves to no URL at all, so no <AvatarImage> is rendered", () => {
    // The components read this: `{url ? <AvatarImage/> : null}` over an
    // <AvatarFallback> holding the initials. A null here is the initials.
    expect(avatarUrl("mytag", null)).toBeNull();
    expect(avatarUrl("mytag", "")).toBeNull();
  });

  it("answers 404 when the account has no avatar", async () => {
    rows = [{ key: null }];
    const res = await avatarRoute.GET(new Request("https://host.example.com/avatar/mytag"), {
      params: Promise.resolve({ userCode: "mytag" }),
    });
    expect(res.status).toBe(404);
  });

  it("answers 404 when the column points at an object storage no longer has", async () => {
    // The one way a live avatar can break: the row still names a key, the bytes
    // are gone. Radix falls back the moment the image fails to load, so this is
    // the initials again rather than a broken-image icon on every page.
    rows = [{ key: avatarKey("u1", "abc") }];
    getStorage.mockReturnValue({ stat: vi.fn(async () => null) });

    const res = await avatarRoute.GET(new Request("https://host.example.com/avatar/mytag?v=abc"), {
      params: Promise.resolve({ userCode: "mytag" }),
    });
    expect(res.status).toBe(404);
  });

  it("refuses to treat a foreign value in user.image as a storage path", async () => {
    // `user.image` is Better Auth's column. If a social provider ever writes a
    // URL into it, handing that to the storage driver would be asking it to
    // interpret an arbitrary string as a path.
    rows = [{ key: "https://cdn.example.com/face.png" }];
    const stat = vi.fn(async () => null);
    getStorage.mockReturnValue({ stat });

    const res = await avatarRoute.GET(new Request("https://host.example.com/avatar/mytag"), {
      params: Promise.resolve({ userCode: "mytag" }),
    });
    expect(res.status).toBe(404);
    expect(stat).not.toHaveBeenCalled();
  });
});
