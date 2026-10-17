"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { folders, uploads } from "@/lib/db/schema";
import { requireUser } from "@/lib/auth-helpers";
import {
  createFolderFor,
  countUnfiledUploadsFor,
  deleteFolderFor,
  moveFolderFor,
  moveUnfiledToFolderFor,
  moveUploadsToFolderFor,
  renameFolderFor,
  setFolderVisibilityFor,
  type DeleteFolderResult,
} from "@/lib/folders";

/**
 * The panel's half of the folder surface.
 *
 * Every rule these used to hold — the depth ceiling, slug uniqueness, ownership,
 * cycle prevention, the two delete modes — now lives in `lib/folders.ts`, which
 * `app/api/folders/route.ts` calls too. A rule that lives in one of two paths
 * eventually only lives in one of them; see lib/shortlinks.ts for the time that
 * cost us an XSS hole.
 *
 * What stays here is the session (`requireUser`) and `revalidatePath`: the first
 * is how a browser identifies itself and the second drops the router cache after
 * a mutation this browser made. Neither means anything to an HTTP client, which
 * is why neither crossed into the shared module.
 */

// NOTE: no `export type` re-export here. A "use server" module has every one of
// its exports registered as a server action, and a type re-export survives that
// pass as a reference to a binding that does not exist at runtime - so the
// module threw ReferenceError on import and took EVERY server action in the
// panel down with it (deleting a file, revoking a token, all of it), while
// `tsc` stayed perfectly happy because it knows the name is a type.
// Import the type from @/lib/folders instead.


export async function createFolder(name: string, parentId: string | null = null) {
  const s = await requireUser();
  const folder = await createFolderFor(s.user.id, name, parentId);
  revalidatePath("/dashboard");
  return folder;
}

export async function renameFolder(id: string, name: string) {
  const s = await requireUser();
  await renameFolderFor(s.user.id, id, name);
  revalidatePath("/dashboard");
}

export async function deleteFolder(
  id: string,
  opts: { withContents?: boolean } = {},
): Promise<DeleteFolderResult> {
  const s = await requireUser();
  const result = await deleteFolderFor(s.user.id, id, opts);
  revalidatePath("/dashboard");
  return result;
}

export async function moveFolder(id: string, newParentId: string | null) {
  const s = await requireUser();
  await moveFolderFor(s.user.id, id, newParentId);
  revalidatePath("/dashboard");
}

export async function setFolderVisibility(id: string, isPublic: boolean) {
  const s = await requireUser();
  await setFolderVisibilityFor(s.user.id, id, isPublic);
  revalidatePath("/dashboard");
}

export async function moveUploadsToFolder(uploadIds: string[], folderId: string | null) {
  const s = await requireUser();
  const result = await moveUploadsToFolderFor(s.user.id, uploadIds, folderId);
  revalidatePath("/dashboard");
  return result;
}

/* -------------------------------------------------------------------------- */
/* Tidy up loose files                                                         */
/* -------------------------------------------------------------------------- */

export async function countUnfiledUploads(): Promise<number> {
  const s = await requireUser();
  return countUnfiledUploadsFor(s.user.id);
}

export async function moveUnfiledToFolder(
  folderName = "Wszystko",
): Promise<{ moved: number; folderId: string; folderName: string }> {
  const s = await requireUser();
  const result = await moveUnfiledToFolderFor(s.user.id, folderName);
  revalidatePath("/dashboard");
  return result;
}

export async function listFolders() {
  const s = await requireUser();
  return db
    .select({
      id: folders.id,
      parentId: folders.parentId,
      name: folders.name,
      slug: folders.slug,
      isPublic: folders.isPublic,
      count: sql<number>`(
        select count(*)::int from ${uploads}
        where ${uploads.folderId} = ${folders.id} and ${uploads.deletedAt} is null
      )`,
    })
    .from(folders)
    .where(eq(folders.ownerId, s.user.id));
}
