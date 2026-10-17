"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { uploads, user as users } from "@/lib/db/schema";
import { requireUser } from "@/lib/auth-helpers";
import { getStorage } from "@/lib/storage";
import { listUploads } from "@/lib/data/uploads";
import { effectiveType } from "@/lib/media/mime";
import { AVATAR_MAX_BYTES, avatarUrl } from "@/lib/avatar";
import { saveAvatar, type AvatarSaveError } from "@/lib/avatar-store";
import type { AvatarDegradation } from "@/lib/media/avatar";

/**
 * Setting an avatar from a file the account has already uploaded.
 *
 * Why this is an action while the file upload is a route handler: this request
 * carries an id, not an image, so the 1 MB Server Action body cap is irrelevant
 * - and an action gets `requireUser()`, ownership scoping and `revalidatePath`
 * without a second HTTP surface to authorise.
 *
 * Why the chosen upload is COPIED rather than referenced, which is the decision
 * that shapes this whole file:
 *
 *  1. Deleting a screenshot from your library must not silently blank your
 *     face. A reference makes tidying up destructive at a distance.
 *  2. A 12 MB source would otherwise be fetched on every page of the panel. The
 *     derived square is ~20 kB.
 *  3. The upload's own state stays out of it. Uploads can be unpublished,
 *     password-gated, expiring, one-time (`maxViews`), converted in place, or
 *     counted (`views`/`downloads`). Serving one as an avatar means either
 *     honouring all of that on a decoration - an avatar that vanishes when a
 *     burn-after-view link is spent - or bypassing it, which is a hole. Copying
 *     ends the question: the avatar is a separate 256 px object with no link to
 *     the row it came from.
 */

/** One image the owner may choose from. Nothing here is not already theirs. */
export interface AvatarPick {
  id: string;
  filename: string;
  /** Same relative thumbnail URL the dashboard tiles use. */
  thumbUrl: string;
  blurhash: string | null;
  size: number;
  /** Shown so the picker can flag "this file is not public" next to the choice. */
  published: boolean;
  /** Over AVATAR_MAX_BYTES: offered greyed out rather than silently missing. */
  tooLarge: boolean;
}

export interface AvatarPickPage {
  items: AvatarPick[];
  total: number;
  page: number;
  perPage: number;
}

const PICKER_PER_PAGE = 24;

/**
 * The owner's own images, newest first.
 *
 * Goes through `listUploads`, which puts `eq(uploads.ownerId, userId)` in the
 * WHERE clause - the scoping is in the query, never a filter applied to rows
 * that were already fetched. The id the client sends back is checked against the
 * same owner again in `setAvatarFromUpload`; this list is a convenience, not the
 * authorisation.
 */
export async function listAvatarPicks(params: {
  page?: number;
  search?: string;
} = {}): Promise<AvatarPickPage> {
  const session = await requireUser();

  const { items, total, page, perPage } = await listUploads({
    userId: session.user.id,
    page: params.page,
    perPage: PICKER_PER_PAGE,
    search: params.search?.trim() || undefined,
    kind: "image",
    sort: "newest",
  });

  const tag = await ownerTag(session.user.id);

  return {
    total,
    page,
    perPage,
    items: items
      .filter((u) => isPickableImage(u.mimeType, u.ext))
      .map((u) => ({
        id: u.id,
        filename: u.filename,
        // The same `/raw?w&h` tile the dashboard grid asks for, and relative on
        // purpose: the session cookie is host-only, so a thumbnail asked for on
        // the owner's preferred domain would arrive anonymous and 404 for
        // anything private.
        thumbUrl: `/${tag}/${u.code}/raw${u.ext ? `.${u.ext}` : ""}?w=200&h=200`,
        blurhash: u.blurhash,
        size: Number(u.size),
        published: u.published,
        tooLarge: Number(u.size) > AVATAR_MAX_BYTES,
      })),
  };
}

export type AvatarActionResult =
  | { ok: true; url: string | null; animated: boolean; degraded: AvatarDegradation | null }
  | { ok: false; error: AvatarSaveError | "not-found" | "too-large" | "unsupported" };

/**
 * Make one of the caller's own uploads their avatar.
 *
 * The ownership test is `and(eq(id), eq(ownerId), isNull(deletedAt))` in a single
 * statement: a row that is not the caller's simply does not come back, so there
 * is no fetched object to forget to check afterwards. A trashed file is excluded
 * too - it is on its way out, and an avatar made from it would outlive it in a
 * way the owner did not ask for.
 */
export async function setAvatarFromUpload(uploadId: string): Promise<AvatarActionResult> {
  const session = await requireUser();

  // `uploads.id` is a uuid column; Postgres raises a syntax error on anything
  // that is not one, which would surface as a 500 on a request the user can send
  // by hand. A malformed id is simply not found.
  if (!isUuid(uploadId)) return { ok: false, error: "not-found" };

  const [row] = await db
    .select({
      storageKey: uploads.storageKey,
      mimeType: uploads.mimeType,
      ext: uploads.ext,
      size: uploads.size,
    })
    .from(uploads)
    .where(
      and(
        eq(uploads.id, uploadId),
        eq(uploads.ownerId, session.user.id),
        isNull(uploads.deletedAt),
      ),
    )
    .limit(1);

  if (!row) return { ok: false, error: "not-found" };
  if (!isPickableImage(row.mimeType, row.ext)) return { ok: false, error: "unsupported" };
  // The whole object is read into memory to be re-encoded, so the input ceiling
  // applies here exactly as it does to a body posted from a browser.
  if (Number(row.size) > AVATAR_MAX_BYTES) return { ok: false, error: "too-large" };

  let input: Buffer;
  try {
    input = await getStorage().readBuffer(row.storageKey);
  } catch {
    // The row exists but its bytes do not. Nothing to encode, and nothing the
    // user did wrong.
    return { ok: false, error: "not-found" };
  }

  const result = await saveAvatar(session.user.id, input);
  if (!result.ok) return { ok: false, error: result.error };

  // <html> and the sidebar both carry the avatar, and those come from the root
  // layout - revalidating only the profile page would leave the old picture in
  // the rail until the next full navigation.
  revalidatePath("/", "layout");

  return { ok: true, url: result.url, animated: result.animated, degraded: result.degraded };
}

/** Current avatar URL, read back after a change rather than guessed. */
export async function myAvatar(): Promise<{ url: string | null }> {
  const session = await requireUser();
  const [row] = await db
    .select({ userCode: users.userCode, image: users.image })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);

  return { url: avatarUrl(row?.userCode, row?.image) };
}

/**
 * Images we are willing to re-encode.
 *
 * SVG is excluded here as well as on the upload route. libvips would rasterise
 * it, but its SVG loader has been a source of file-read and network-fetch bugs,
 * and an uploaded SVG is exactly the attacker-controlled document that path was
 * never meant to meet.
 *
 * `effectiveType` rather than the stored type alone: ShareX on Windows labels a
 * .avif `application/octet-stream`, and Round 7's whole point was that such a
 * file is still an image.
 */
function isPickableImage(mime: string | null | undefined, ext: string | null | undefined): boolean {
  const type = effectiveType(mime, ext);
  return type.startsWith("image/") && type !== "image/svg+xml";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return typeof value === "string" && UUID.test(value);
}

/** The tag the owner's own links are built on, for the picker's thumbnails. */
async function ownerTag(userId: string): Promise<string> {
  const [row] = await db
    .select({ userCode: users.userCode })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.userCode ?? "";
}
