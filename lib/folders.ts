// NOTE: deliberately free of `server-only`, like lib/upload/folder-target.ts and
// lib/maintenance/trash.ts. Nothing reachable from server.ts imports this today
// (server.ts pulls in lib/upload/*, lib/maintenance/trash, lib/mail-settings,
// lib/config, lib/runtime/*, lib/media/{sharp-runtime,transform-cost} — none of
// which touch this file), and the guard is not worth the risk of that changing:
// `server-only` is not an installed package, so esbuild's `--packages=external`
// bundle would carry the bare specifier into dist/server.js and `node
// dist/server.js` would die at link time, before server.listen().
// scripts/check-server-bundle.mjs is the backstop that turns that into a red
// build instead of a crash loop.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { folders, uploads } from "@/lib/db/schema";
import { slugifyName } from "@/lib/naming";
import { descendantFolderIds, wouldCreateCycle } from "@/lib/data/folders";
import { purgeDerived } from "@/lib/media/derived-cache";
import { isUuid } from "@/lib/upload/folder-target";

/**
 * Folder operations, with no idea who is logged in.
 *
 * Everything here used to live inside `app/actions/folders.ts`, reachable only
 * with a session cookie — which is why the desktop client could LIST folders and
 * do nothing else. Each function now takes the owner's id instead of calling
 * `requireUser()`, so the panel's Server Actions and `app/api/folders/route.ts`
 * run the same code rather than two implementations of the same rules.
 *
 * The precedent is `lib/shortlinks.ts`, and the reason is the same one: the
 * `javascript:` URL block lived in only one of two paths there, and the path
 * without it was an XSS hole. The rules that must not diverge here are the depth
 * ceiling, slug uniqueness, cycle prevention, the two delete modes, and above
 * all OWNERSHIP — which is folded into every WHERE clause below, never checked
 * after a row comes back.
 *
 * `revalidatePath` stays in the actions. It is a Next router-cache concern and
 * means nothing to an HTTP client.
 */

/** How deep folders may nest. Depth 1 is a root folder. */
export const MAX_FOLDER_DEPTH = 8;

/** Longest folder name we store (`folders.name` is varchar(120)). */
export const FOLDER_NAME_MAX = 120;

/** Ceiling on one "move these files" call. */
export const MOVE_UPLOADS_MAX = 1000;

/**
 * Why an operation was refused.
 *
 * Travels as a field on the error rather than being inferred from its message:
 * the panel shows the message, the HTTP surface maps the reason to a status, and
 * neither should be parsing English to find out what happened.
 */
export type FolderIssue = "not-found" | "invalid-name" | "too-deep" | "cycle";

export class FolderOpError extends Error {
  readonly reason: FolderIssue;

  constructor(reason: FolderIssue, message: string) {
    super(message);
    this.name = "FolderOpError";
    this.reason = reason;
  }
}

const notFound = () => new FolderOpError("not-found", "Folder not found");

export type FolderRecord = typeof folders.$inferSelect;

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Fetch a folder the caller owns, or refuse.
 *
 * Ownership is part of the WHERE clause, so somebody else's id and an id that
 * never existed produce the SAME answer — as does a string that is not a uuid at
 * all, which is checked before Postgres ever sees it (`folders.id` is a uuid
 * column, so a malformed one would otherwise be a 500 that says "well formed but
 * unknown" by omission). Answering these three differently would turn every
 * folder endpoint into an oracle for "is this id real, and whose is it".
 *
 * The old `ownedFolder` in app/actions/folders.ts threw "Folder not found" for a
 * missing row and "Forbidden" for someone else's — that distinction is gone on
 * purpose.
 */
export async function getOwnedFolder(userId: string, id: string): Promise<FolderRecord> {
  if (typeof id !== "string" || !isUuid(id)) throw notFound();

  const rows = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, id), eq(folders.ownerId, userId)))
    .limit(1);

  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/**
 * Slugs are unique per (owner, parent). The DB enforces it for nested folders
 * via a unique index and for root folders via a partial index; this loop just
 * picks a friendly free slug instead of surfacing a constraint violation.
 */
async function freeSlug(userId: string, parentId: string | null, name: string): Promise<string> {
  const base = slugifyName(name) || "folder";
  let slug = base;
  for (let i = 2; ; i++) {
    const clash = await db
      .select({ id: folders.id })
      .from(folders)
      .where(
        and(
          eq(folders.ownerId, userId),
          parentId === null ? isNull(folders.parentId) : eq(folders.parentId, parentId),
          eq(folders.slug, slug),
        ),
      )
      .limit(1);
    if (!clash.length) return slug;
    slug = `${base}-${i}`;
    if (i > 500) return `${base}-${Date.now()}`;
  }
}

/** How many levels down `folderId` sits. 0 for the root (no folder). */
async function depthOf(userId: string, folderId: string | null): Promise<number> {
  if (!folderId) return 0;
  const rows = await db
    .select({ id: folders.id, parentId: folders.parentId })
    .from(folders)
    .where(eq(folders.ownerId, userId));
  const byId = new Map(rows.map((r) => [r.id, r]));
  let depth = 0;
  let cur = byId.get(folderId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    depth++;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return depth;
}

const tooDeep = () =>
  new FolderOpError("too-deep", `Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep`);

/** Trim and bound a name the way `folders.name` needs it. */
function cleanName(name: unknown, fallback: string | null): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) {
    if (fallback === null) {
      throw new FolderOpError("invalid-name", "Folder name cannot be empty");
    }
    return fallback;
  }
  return trimmed.slice(0, FOLDER_NAME_MAX);
}

/* -------------------------------------------------------------------------- */
/* Operations                                                                  */
/* -------------------------------------------------------------------------- */

export async function createFolderFor(
  userId: string,
  name: string,
  parentId: string | null = null,
): Promise<FolderRecord> {
  if (parentId) {
    await getOwnedFolder(userId, parentId);
    if ((await depthOf(userId, parentId)) >= MAX_FOLDER_DEPTH) throw tooDeep();
  }
  const clean = cleanName(name, "Folder");
  const slug = await freeSlug(userId, parentId, clean);

  const [row] = await db
    .insert(folders)
    .values({ ownerId: userId, parentId, name: clean, slug })
    .returning();

  return row;
}

export async function renameFolderFor(
  userId: string,
  id: string,
  name: string,
): Promise<FolderRecord> {
  const f = await getOwnedFolder(userId, id);
  // No fallback: renaming to nothing is a mistake, where CREATING with no name
  // is just an unnamed folder.
  const clean = cleanName(name, null);
  const slug = await freeSlug(userId, f.parentId, clean);

  const [row] = await db
    .update(folders)
    .set({ name: clean, slug })
    .where(and(eq(folders.id, id), eq(folders.ownerId, userId)))
    .returning();

  return row ?? { ...f, name: clean, slug };
}

export interface DeleteFolderResult {
  /** Folders removed (1 for a plain delete, the whole subtree otherwise). */
  folders: number;
  /** Files moved to the trash. Always 0 unless `withContents` was set. */
  trashed: number;
}

/**
 * Delete a folder, in one of two modes.
 *
 * Default ("folder only"): the safe one. Files fall back to "no folder" and
 * child folders are re-parented to the deleted folder's parent, so nothing is
 * ever lost behind a mis-click. This is what an omitted flag gets, on every
 * surface — the destructive reading is never the default.
 *
 * `withContents`: the folder and its whole subtree go, and every file inside
 * lands in the **trash** (soft-delete). Bytes are still never touched here —
 * the trash is what eventually reclaims them, 30 days later
 * (lib/maintenance/trash.ts). That is why the UI arms this button on a delay
 * rather than hiding it: it is recoverable, but it is not a small action.
 */
export async function deleteFolderFor(
  userId: string,
  id: string,
  opts: { withContents?: boolean } = {},
): Promise<DeleteFolderResult> {
  const f = await getOwnedFolder(userId, id);

  if (!opts.withContents) {
    await db.transaction(async (tx) => {
      await tx
        .update(folders)
        .set({ parentId: f.parentId })
        .where(and(eq(folders.parentId, id), eq(folders.ownerId, userId)));
      await tx
        .update(uploads)
        .set({ folderId: null })
        .where(and(eq(uploads.folderId, id), eq(uploads.ownerId, userId)));
      await tx.delete(folders).where(and(eq(folders.id, id), eq(folders.ownerId, userId)));
    });
    return { folders: 1, trashed: 0 };
  }

  // Ownership is already established for `id`; descendantFolderIds only walks
  // rows belonging to this user, so the subtree can't reach someone else's data.
  const subtree = await descendantFolderIds(userId, id);
  const now = new Date();

  const trashedIds = await db.transaction(async (tx) => {
    const scope = and(
      eq(uploads.ownerId, userId),
      inArray(uploads.folderId, subtree),
      isNull(uploads.deletedAt),
    );

    // The ids, not just a count: each one may have cached conversions under
    // derived/{id}/ that must go with it into the trash. A uuid per file is
    // cheap even for a folder holding thousands.
    const rows = await tx.select({ id: uploads.id }).from(uploads).where(scope);

    await tx.update(uploads).set({ deletedAt: now, updatedAt: now }).where(scope);
    // uploads.folder_id is ON DELETE SET NULL, so the trashed rows simply lose
    // their (now non-existent) folder reference.
    await tx.delete(folders).where(and(eq(folders.ownerId, userId), inArray(folders.id, subtree)));

    return rows.map((r) => r.id);
  });

  // Outside the transaction: storage is not transactional, and a cache we failed
  // to clear must never roll back a delete the user asked for.
  for (const uploadId of trashedIds) await purgeDerived(uploadId);

  return { folders: subtree.length, trashed: trashedIds.length };
}

export async function moveFolderFor(
  userId: string,
  id: string,
  newParentId: string | null,
): Promise<FolderRecord> {
  const f = await getOwnedFolder(userId, id);
  if (newParentId) await getOwnedFolder(userId, newParentId);

  if (await wouldCreateCycle(userId, id, newParentId)) {
    throw new FolderOpError("cycle", "A folder cannot be moved inside itself");
  }
  if ((await depthOf(userId, newParentId)) >= MAX_FOLDER_DEPTH) throw tooDeep();

  const slug = await freeSlug(userId, newParentId, f.name);
  const [row] = await db
    .update(folders)
    .set({ parentId: newParentId, slug })
    .where(and(eq(folders.id, id), eq(folders.ownerId, userId)))
    .returning();

  return row ?? { ...f, parentId: newParentId, slug };
}

export async function setFolderVisibilityFor(
  userId: string,
  id: string,
  isPublic: boolean,
): Promise<FolderRecord> {
  const f = await getOwnedFolder(userId, id);
  const [row] = await db
    .update(folders)
    .set({ isPublic })
    .where(and(eq(folders.id, id), eq(folders.ownerId, userId)))
    .returning();

  return row ?? { ...f, isPublic };
}

/**
 * Move files into a folder (or out of every folder when folderId is null).
 *
 * Ownership is enforced inside the UPDATE, so a forged id list can only ever
 * affect rows the caller already owns, and the target folder goes through
 * `ownedFolder` first so it cannot be somebody else's. Ids that are not uuids
 * are dropped before the query rather than handed to Postgres, which would
 * answer a malformed one with a 500 instead of "not yours".
 */
export async function moveUploadsToFolderFor(
  userId: string,
  uploadIds: string[],
  folderId: string | null,
): Promise<{ moved: number }> {
  const ids = uploadIds.filter((v) => typeof v === "string" && isUuid(v)).slice(0, MOVE_UPLOADS_MAX);
  if (ids.length === 0) return { moved: 0 };

  if (folderId) await getOwnedFolder(userId, folderId);

  const moved = await db
    .update(uploads)
    .set({ folderId, updatedAt: new Date() })
    .where(and(inArray(uploads.id, ids), eq(uploads.ownerId, userId)))
    .returning({ id: uploads.id });

  return { moved: moved.length };
}

/* -------------------------------------------------------------------------- */
/* Loose files                                                                 */
/* -------------------------------------------------------------------------- */

/** Files that belong to no folder at all (and aren't in the trash). */
export function unfiledScope(userId: string) {
  return and(eq(uploads.ownerId, userId), isNull(uploads.folderId), isNull(uploads.deletedAt));
}

export async function countUnfiledUploadsFor(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(uploads)
    .where(unfiledScope(userId));
  return Number(row?.n ?? 0);
}

/**
 * Sweep every loose file into one folder, creating it if needed.
 *
 * Written for the real shape of an imported library: thousands of files with
 * no folder at all. So this is a single UPDATE over the whole set —
 * never a loop over rows — and it reuses an existing top-level folder with the
 * same name instead of creating a twin on the second run.
 */
export async function moveUnfiledToFolderFor(
  userId: string,
  folderName = "Wszystko",
): Promise<{ moved: number; folderId: string; folderName: string }> {
  const clean = cleanName(folderName, "Wszystko");
  const slug = slugifyName(clean) || "folder";

  const existing = await db
    .select()
    .from(folders)
    .where(and(eq(folders.ownerId, userId), isNull(folders.parentId), eq(folders.slug, slug)))
    .limit(1);

  let target = existing[0];
  if (!target) {
    [target] = await db
      .insert(folders)
      .values({ ownerId: userId, parentId: null, name: clean, slug })
      .returning();
  }

  const scope = unfiledScope(userId);
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(uploads).where(scope);
  const moved = Number(row?.n ?? 0);

  if (moved > 0) {
    await db.update(uploads).set({ folderId: target.id, updatedAt: new Date() }).where(scope);
  }

  return { moved, folderId: target.id, folderName: target.name };
}
