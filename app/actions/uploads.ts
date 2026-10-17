"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth-helpers";
import { deleteMediaHard, softDeleteMedia, restoreMedia } from "@/lib/media/actions";
import {
  auditForeignUpload,
  emptyTrashFor,
  getActionableUpload,
  setExpiryFor,
  setMaxViewsFor,
  setPasswordFor,
  setPublishedFor,
  setVanityFor,
  trashTotalsFor,
  type UploadActor,
} from "@/lib/uploads";

/**
 * The panel's half of the upload surface.
 *
 * Every rule these used to hold - the vanity slug and its clash check,
 * `passwordVersion` being cleared with a per-file password, the view-cap floor,
 * the audit entry an admin's touch leaves - now lives in `lib/uploads.ts`, which
 * `app/api/uploads/route.ts` calls too. A rule that lives in one of two paths
 * eventually only lives in one of them; see lib/shortlinks.ts for the time that
 * cost us an XSS hole, and lib/folders.ts for the same move made on folders.
 *
 * What stays here is the session (`getSession`) and `revalidatePath`: the first
 * is how a browser identifies itself and the second drops the router cache after
 * a mutation this browser made. Neither means anything to an HTTP client, which
 * is why neither crossed into the shared module.
 */

// NOTE: no `export type` re-export here. A "use server" module has every one of
// its exports registered as a server action, and a type re-export of a locally
// imported binding survives that pass as a reference to something that does not
// exist at runtime - so the module throws ReferenceError on import and takes
// EVERY server action in the panel down with it, while `tsc` stays perfectly
// happy because it knows the name is a type. Import types from @/lib/uploads.

/**
 * Who is acting, for the shared core.
 *
 * `isAdmin` is what lets the admin file browser touch another account's file at
 * all; `auditForeignUpload` inside the core is what makes that leave a trace.
 */
async function actor(): Promise<UploadActor> {
  return toActor(await currentSession());
}

/** The session, or a refusal. Local type: a "use server" module exports actions. */
type PanelSession = NonNullable<Awaited<ReturnType<typeof getSession>>>;

async function currentSession(): Promise<PanelSession> {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");
  return session;
}

function toActor(session: PanelSession): UploadActor {
  return {
    userId: session.user.id,
    email: session.user.email,
    isAdmin: session.user.role === "admin",
  };
}

/**
 * Whose trash a trash-wide call is about.
 *
 * The tag comes from the CALLER, because the two views that render the trash
 * are pointed at different libraries: the owner's own page and an
 * administrator's view of somebody else's. Defaulting to the session's own tag
 * keeps the sidebar shortcut (which knows nothing about a target) working, and
 * `lib/uploads.ts` is what decides whether this actor may reach that tag at all
 * - an unknown tag, another account's tag and an empty one are one answer for
 * anybody who is not an administrator.
 */
function trashTarget(session: PanelSession, ownerTag?: string): string {
  const asked = typeof ownerTag === "string" ? ownerTag.trim() : "";
  return asked.length > 0 ? asked : (session.user.userCode ?? "");
}

export async function togglePublish(id: string): Promise<{ published: boolean }> {
  const a = await actor();
  // Read first: this is a TOGGLE, so the new value is a function of the old one.
  const media = await getActionableUpload(a, id);
  const published = !media.published;
  await setPublishedFor(a, [id], published);
  revalidatePath("/dashboard");
  return { published };
}

export async function trashUpload(id: string): Promise<void> {
  const a = await actor();
  const media = await getActionableUpload(a, id);
  await softDeleteMedia(id);
  await auditForeignUpload(a, media, "admin.upload.trashed");
  revalidatePath("/dashboard");
}

export async function restoreUpload(id: string): Promise<void> {
  const a = await actor();
  const media = await getActionableUpload(a, id);
  await restoreMedia(id);
  await auditForeignUpload(a, media, "admin.upload.restored");
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/trash");
}

export async function deleteUploadForever(id: string): Promise<void> {
  const a = await actor();
  const media = await getActionableUpload(a, id);
  // Trash rows only. This is the one verb in the panel that destroys bytes with
  // nothing left to restore from, and the only screen that offers it is the
  // trash - so a live id reaching it is a stale selection or a hand-made call,
  // never a user's intent. Refusing costs nothing and removes the whole class.
  if (media.deletedAt === null) throw new Error("Not found");
  await deleteMediaHard(media);
  await auditForeignUpload(a, media, "admin.upload.deleted", { size: Number(media.size) });
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/trash");
}

/**
 * What emptying a trash would destroy, counted right now.
 *
 * Read at the moment the confirmation is opened rather than at page render, and
 * over the WHOLE trash rather than over the page of items on screen: the trash
 * view lists 120 at a time, so "120 items will be deleted" can be an order of
 * magnitude short of the truth on an account that has been tidying up. A
 * confirmation that understates what it destroys is worse than one with no
 * number in it at all.
 */
export async function trashSummary(
  ownerTag?: string,
): Promise<{ files: number; bytes: number }> {
  const session = await currentSession();
  return trashTotalsFor(toActor(session), trashTarget(session, ownerTag));
}

/**
 * Empty a trash right now, instead of waiting out the 30-day sweep
 * (lib/maintenance/trash.ts).
 *
 * `ownerTag` names WHICH trash, because the same list component is rendered on
 * the owner's own page and inside an administrator's view of somebody else's
 * library. Omitted means "my own", which is what the sidebar shortcut asks for.
 *
 * The work itself is `emptyTrashFor` in lib/uploads.ts - the same
 * `deleteMediaBulk` core the orphan purge and account deletion use, so the
 * storage objects and the quota refund are handled exactly once, in one place.
 * `failed` is the rows storage would not give up: they stay in the trash, so a
 * retry (or the sweep) finds them again rather than the disk space quietly
 * becoming nobody's problem.
 */
export async function emptyTrash(
  ownerTag?: string,
): Promise<{ deleted: number; bytes: number; failed: number }> {
  const session = await currentSession();
  const result = await emptyTrashFor(toActor(session), trashTarget(session, ownerTag));

  revalidatePath("/dashboard");
  revalidatePath("/dashboard/trash");
  // `deleted` rather than `files`, because the sidebar shortcut in
  // components/app-shell.tsx already reads that name.
  return { deleted: result.files, bytes: result.bytes, failed: result.failed };
}

export async function setVanity(id: string, vanity: string): Promise<{ code: string }> {
  const a = await actor();
  const media = await setVanityFor(a, id, vanity);
  revalidatePath("/dashboard");
  return { code: media.code };
}

// Tags are gone: organisation is folders (see app/actions/folders.ts) and file
// type is derived from mimeType, so there is nothing to keep in sync.

// -- Advantage features: expiring / one-time / password-protected links -------
// Enforcement already lives in lib/media/serve.ts (expiry + max-views -> 404)
// and the raw/preview routes (password -> unlock cookie). These set the values,
// through lib/uploads.ts so the desktop client sets them the same way.

/** Set or clear a time-based expiry. `iso` = ISO date string, or null to clear. */
export async function setUploadExpiry(id: string, iso: string | null): Promise<void> {
  const a = await actor();
  await setExpiryFor(a, [id], iso);
  revalidatePath("/dashboard");
}

/** Set a view cap (burn-after-N-views), or null to clear. 1 = one-time link. */
export async function setUploadMaxViews(id: string, maxViews: number | null): Promise<void> {
  const a = await actor();
  await setMaxViewsFor(a, [id], maxViews);
  revalidatePath("/dashboard");
}

/** Set or clear a password (scrypt-hashed). `password` = null/empty clears it. */
export async function setUploadPassword(id: string, password: string | null): Promise<void> {
  const a = await actor();
  await setPasswordFor(a, [id], password);
  revalidatePath("/dashboard");
}

// NOTE: no batch variants here, tempting as they are. Every export of a "use
// server" module is a live endpoint, so an action nothing calls is attack
// surface with no user - the same reason a dead `saveSettings` was deleted from
// app/actions/account.ts. The panel's bulk bar already fans out per file; when
// it stops doing that, the batch action can arrive with its caller.
