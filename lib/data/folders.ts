import "server-only";
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { folders, uploads, user as users, userCodeAliases } from "@/lib/db/schema";

export interface FolderNode {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  isPublic: boolean;
  sortOrder: number;
  createdAt: Date;
  /** Files directly in this folder (excludes descendants). */
  count: number;
  /** Files in this folder and everything beneath it. */
  totalCount: number;
  /** Bytes stored directly in this folder (excludes descendants). */
  size: number;
  /** Bytes in this folder and everything beneath it. */
  totalSize: number;
  children: FolderNode[];
}

export interface FolderRow {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  isPublic: boolean;
  sortOrder: number;
  createdAt: Date;
  count: number;
  size: number;
}

/**
 * Flat list of a user's folders with direct file counts **and byte totals**.
 *
 * The aggregate is a single grouped scan of `uploads` joined onto `folders`,
 * not one query (or worse, one `sum()`) per folder: the production account
 * holds ~6800 uploads, so anything per-folder turns the sidebar into an N+1.
 */
export async function listUserFolders(userId: string): Promise<FolderRow[]> {
  const agg = db
    .select({
      folderId: uploads.folderId,
      files: sql<number>`count(*)::int`.as("files"),
      // sum(bigint) comes back as numeric; ::text keeps it exact over the wire
      // and Number() below is safe well past any realistic library size.
      bytes: sql<string>`coalesce(sum(${uploads.size}), 0)::text`.as("bytes"),
    })
    .from(uploads)
    .where(
      and(
        eq(uploads.ownerId, userId),
        isNull(uploads.deletedAt),
        isNotNull(uploads.folderId),
      ),
    )
    .groupBy(uploads.folderId)
    .as("folder_agg");

  const rows = await db
    .select({
      id: folders.id,
      parentId: folders.parentId,
      name: folders.name,
      slug: folders.slug,
      isPublic: folders.isPublic,
      sortOrder: folders.sortOrder,
      createdAt: folders.createdAt,
      // A folder with no files has no aggregate row; the left join makes these
      // null, so they are coalesced in JS rather than in SQL.
      count: agg.files,
      size: agg.bytes,
    })
    .from(folders)
    .leftJoin(agg, eq(agg.folderId, folders.id))
    .where(eq(folders.ownerId, userId))
    .orderBy(asc(folders.sortOrder), asc(folders.name));

  return rows.map((r) => ({ ...r, count: Number(r.count ?? 0), size: Number(r.size ?? 0) }));
}

/**
 * The same two numbers `listUserFolders` reports, for ONE folder.
 *
 * Exists so a write endpoint can answer with a row in exactly the shape the
 * listing uses without re-running the grouped scan over the whole account —
 * ~6800 uploads on the production account, to describe the folder that was just
 * renamed. Scoped by owner as well as folder: the caller has already been
 * checked, and a predicate that does not depend on that is one less thing to
 * get wrong later.
 */
export async function folderStats(
  userId: string,
  folderId: string,
): Promise<{ count: number; size: number }> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      size: sql<string>`coalesce(sum(${uploads.size}), 0)::text`,
    })
    .from(uploads)
    .where(
      and(
        eq(uploads.ownerId, userId),
        eq(uploads.folderId, folderId),
        isNull(uploads.deletedAt),
      ),
    );

  return { count: Number(row?.count ?? 0), size: Number(row?.size ?? 0) };
}

/** Files that belong to no folder at all — the "Unsorted" pile. */
export async function unfiledStats(userId: string): Promise<{ count: number; size: number }> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      size: sql<string>`coalesce(sum(${uploads.size}), 0)::text`,
    })
    .from(uploads)
    .where(
      and(
        eq(uploads.ownerId, userId),
        isNull(uploads.deletedAt),
        isNull(uploads.folderId),
      ),
    );

  return { count: Number(row?.count ?? 0), size: Number(row?.size ?? 0) };
}

/**
 * Build the sidebar tree. Rows whose parent is missing (or which sit in a cycle
 * left behind by a bad edit) are attached at the root rather than vanishing —
 * a folder the user cannot see is a folder whose files look lost.
 */
export function buildFolderTree(rows: FolderRow[]): FolderNode[] {
  const byId = new Map<string, FolderNode>();
  for (const r of rows) {
    byId.set(r.id, { ...r, totalCount: r.count, totalSize: r.size, children: [] });
  }

  const roots: FolderNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent && parent.id !== node.id) parent.children.push(node);
    else roots.push(node);
  }

  // Roll direct counts and bytes up into the totals, depth-first.
  const rollUp = (n: FolderNode, seen: Set<string>): { count: number; size: number } => {
    if (seen.has(n.id)) return { count: 0, size: 0 }; // cycle guard
    seen.add(n.id);
    let count = n.count;
    let size = n.size;
    for (const child of n.children) {
      const sub = rollUp(child, seen);
      count += sub.count;
      size += sub.size;
    }
    n.totalCount = count;
    n.totalSize = size;
    return { count, size };
  };
  for (const r of roots) rollUp(r, new Set());

  return roots;
}

export async function folderTree(userId: string): Promise<FolderNode[]> {
  return buildFolderTree(await listUserFolders(userId));
}

/** Breadcrumb chain from root down to `folderId`. Empty when not found. */
export async function folderPath(
  userId: string,
  folderId: string,
): Promise<{ id: string; name: string; slug: string }[]> {
  const rows = await db
    .select({ id: folders.id, parentId: folders.parentId, name: folders.name, slug: folders.slug })
    .from(folders)
    .where(eq(folders.ownerId, userId));

  const byId = new Map(rows.map((r) => [r.id, r]));
  const chain: { id: string; name: string; slug: string }[] = [];
  const seen = new Set<string>();

  let cur = byId.get(folderId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift({ id: cur.id, name: cur.name, slug: cur.slug });
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain;
}

/**
 * All folder ids at or beneath `folderId`. Used so that opening a folder can
 * optionally include everything nested under it.
 */
export async function descendantFolderIds(userId: string, folderId: string): Promise<string[]> {
  const rows = await db
    .select({ id: folders.id, parentId: folders.parentId })
    .from(folders)
    .where(eq(folders.ownerId, userId));

  const childrenOf = new Map<string, string[]>();
  for (const r of rows) {
    const key = r.parentId ?? "__root__";
    const list = childrenOf.get(key) ?? [];
    list.push(r.id);
    childrenOf.set(key, list);
  }

  const out: string[] = [];
  const stack = [folderId];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    stack.push(...(childrenOf.get(id) ?? []));
  }
  return out;
}

/**
 * True when moving `folderId` under `newParentId` would create a cycle (i.e.
 * the target is the folder itself or one of its descendants).
 */
export async function wouldCreateCycle(
  userId: string,
  folderId: string,
  newParentId: string | null,
): Promise<boolean> {
  if (!newParentId) return false;
  if (newParentId === folderId) return true;
  const descendants = await descendantFolderIds(userId, folderId);
  return descendants.includes(newParentId);
}

/**
 * Public gallery for a shared folder: /a/{userCode}/{slug}.
 *
 * Accepts a retired tag via user_code_aliases, so a gallery link keeps working
 * after its owner renames their tag.
 */
export async function getPublicFolder(userCode: string, slug: string) {
  const ownerRows = await db
    .select({
      id: users.id,
      userCode: users.userCode,
      name: users.name,
      theme: users.theme,
      preferredDomain: users.preferredDomain,
      backgroundKey: users.backgroundKey,
      backgroundDim: users.backgroundDim,
    })
    .from(users)
    .where(eq(users.userCode, userCode))
    .limit(1);

  let owner = ownerRows[0];
  if (!owner) {
    const alias = await db
      .select({ userId: userCodeAliases.userId })
      .from(userCodeAliases)
      .where(eq(userCodeAliases.code, userCode))
      .limit(1);
    if (!alias[0]) return null;
    const viaAlias = await db
      .select({
        id: users.id,
        userCode: users.userCode,
        name: users.name,
        theme: users.theme,
        preferredDomain: users.preferredDomain,
        backgroundKey: users.backgroundKey,
        backgroundDim: users.backgroundDim,
      })
      .from(users)
      .where(eq(users.id, alias[0].userId))
      .limit(1);
    if (!viaAlias[0]) return null;
    owner = viaAlias[0];
  }

  const folderRows = await db
    .select()
    .from(folders)
    .where(and(eq(folders.ownerId, owner.id), eq(folders.slug, slug)))
    .limit(1);
  const folder = folderRows[0];
  if (!folder || !folder.isPublic) return null;

  // Expired / burned / password-protected files are excluded from the public
  // listing — the gallery must not become a side channel around those gates.
  //
  // The column list is explicit rather than `select()`: these rows are handed to
  // a public page, and nothing that gates access (password hash, expiry, view
  // budget) has any business travelling with them. `storageKey` stays because
  // the ZIP route streams from it server-side.
  const items = await db
    .select({
      id: uploads.id,
      code: uploads.code,
      ext: uploads.ext,
      filename: uploads.filename,
      mimeType: uploads.mimeType,
      size: uploads.size,
      blurhash: uploads.blurhash,
      storageKey: uploads.storageKey,
      createdAt: uploads.createdAt,
    })
    .from(uploads)
    .where(
      and(
        eq(uploads.folderId, folder.id),
        eq(uploads.published, true),
        isNull(uploads.deletedAt),
        isNull(uploads.passwordHash),
        sql`(${uploads.expiresAt} is null or ${uploads.expiresAt} > now())`,
        sql`(${uploads.maxViews} is null or ${uploads.views} < ${uploads.maxViews})`,
      ),
    )
    .orderBy(desc(uploads.createdAt));

  return { folder, owner, items };
}
