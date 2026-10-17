import { describe, it, expect, vi } from "vitest";

/**
 * The drop-target gate, which both upload paths now share.
 *
 * What is pinned here is the part that must never reach the database: a folder
 * id is a string the CLIENT writes (tus metadata on the web, a multipart field
 * from ShareX and the downloader companion), so anything that is not obviously
 * a uuid has to be refused before it becomes a query parameter, and "not mine"
 * has to be indistinguishable from "does not exist".
 *
 * The database is stubbed rather than reached: these are the branches that
 * decide whether a query happens at all.
 */

const select = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    select: (...args: unknown[]) => select(...args),
  },
}));

const { resolveFolderTarget, ROOT_FOLDER, FolderAccessError } = await import(
  "@/lib/upload/folder-target"
);

const OWNER = "user-1";
const VALID_UUID = "6f1e2b3c-4d5a-4e6f-8a9b-0c1d2e3f4a5b";

describe("folder target", () => {
  it("treats an absent id as 'no preference', not as 'root'", async () => {
    // The difference is load-bearing: undefined leaves the account's default
    // folder in charge, which is what every ShareX upload has always done.
    // Collapsing the two would silently move everybody's uploads to the root.
    await expect(resolveFolderTarget(OWNER, undefined)).resolves.toBeUndefined();
    await expect(resolveFolderTarget(OWNER, null)).resolves.toBeUndefined();
    await expect(resolveFolderTarget(OWNER, "")).resolves.toBeUndefined();
    expect(select).not.toHaveBeenCalled();
  });

  it("maps the root sentinel to null without touching the database", async () => {
    await expect(resolveFolderTarget(OWNER, ROOT_FOLDER)).resolves.toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  it("refuses anything that is not a uuid BEFORE querying", async () => {
    // `folders.id` is a uuid column: handing Postgres a non-uuid is an error at
    // best, and the shape of the refusal is what keeps it from being a probe.
    for (const bad of [
      "../../etc/passwd",
      "1; drop table folders",
      "root'",
      "6f1e2b3c-4d5a-4e6f-8a9b",
      "%00",
    ]) {
      await expect(resolveFolderTarget(OWNER, bad)).rejects.toBeInstanceOf(FolderAccessError);
    }
    expect(select).not.toHaveBeenCalled();
  });

  it("refuses a well-formed id that belongs to somebody else", async () => {
    // The query is scoped by owner, so another account's folder comes back as
    // zero rows — the same answer as a folder that never existed. A caller must
    // not be able to tell those apart, or this becomes a directory listing of
    // every folder on the server.
    select.mockReturnValue({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    });
    await expect(resolveFolderTarget(OWNER, VALID_UUID)).rejects.toBeInstanceOf(FolderAccessError);
  });

  it("returns the id when the caller owns it", async () => {
    select.mockReturnValue({
      from: () => ({ where: () => ({ limit: async () => [{ id: VALID_UUID }] }) }),
    });
    await expect(resolveFolderTarget(OWNER, VALID_UUID)).resolves.toBe(VALID_UUID);
  });
});
