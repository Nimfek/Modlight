import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { type UserRow } from "@/lib/api-token";
import { resolveApiOwner } from "@/lib/api-caller";
import { db } from "@/lib/db";
import { uploads } from "@/lib/db/schema";
import { deleteMediaHard, restoreMedia, softDeleteMedia } from "@/lib/media/actions";
import { listUploads, toFileItems } from "@/lib/data/uploads";
import { parseUploadQuery } from "@/lib/data/upload-query";
import { FolderAccessError, isUuid, resolveFolderTarget, ROOT_FOLDER } from "@/lib/upload/folder-target";
import { FolderOpError, moveUploadsToFolderFor } from "@/lib/folders";
import {
  actionableUploads,
  setExpiryFor,
  setMaxViewsFor,
  setPasswordFor,
  setPublishedFor,
  setVanityFor,
  UploadOpError,
  type UploadActor,
  type UploadIssue,
} from "@/lib/uploads";
import { checkRateLimit } from "@/lib/password";
import { readJsonObject, supplied } from "@/lib/api-json";
import { mediaUrls } from "@/lib/media/urls";
import { mediaKind } from "@/lib/media/mime";
import {
  canMotionPreview,
  clampMotionEdge,
  MOTION_PARAM,
} from "@/lib/media/motion-preview";
import { MAX_TRANSFORM_BYTES } from "@/lib/media/transform-cost";
import { AV_MAX_INPUT_BYTES } from "@/lib/media/av-cost";
import type { FileItem } from "@/components/dashboard/types";

/**
 * The caller's own uploads, paged - what a desktop client draws "My Space" from.
 *
 * Until this existed there was no HTTP way to ask the question at all: the panel
 * reads its grid through Server Actions and lib/data/uploads.ts, both of which
 * are server-only and unreachable from a C# app, so a desktop client could
 * upload a file and then never see it again.
 *
 * The rows come from `listUploads`, the exact function the dashboard renders
 * from, rather than from a second query written to look the same. Filters,
 * ordering, soft-delete and the page ceiling therefore cannot disagree between
 * the two surfaces, which they would within a release if this had its own SQL.
 *
 * Authenticates with an API TOKEN first and a session second, like
 * /api/folders and /api/me. Never returns anything that is not the caller's own.
 */

export const dynamic = "force-dynamic";

/**
 * Thumbnail width asked for in the `thumbUrl` we hand out.
 *
 * 480 is what the panel's own grid tiles use (components/dashboard/FileCard),
 * and it is one of the sizes the serving route snaps to (THUMB_SIZES), so a
 * desktop grid shares the render rather than minting a new one per client.
 */
const THUMB_PX = 480;

/**
 * The still size put through the clamp the serving route applies to a moving
 * preview. Today the two numbers are equal and this is a no-op, which is
 * exactly when a guard like it is free: without it, raising the still size
 * past MOTION_CAPTURE_WIDTH would make this URL and the one /api/link-info
 * hands out differ by a query parameter, and one render would become two.
 */
const MOTION_PX = clampMotionEdge(THUMB_PX) ?? THUMB_PX;

/**
 * Ceiling on how many ids one write may name, so a single request cannot ask
 * for an unbounded `IN (...)` list. Shared by DELETE and PATCH: the bound is a
 * property of the surface, not of the verb.
 */
const MAX_IDS = 500;

/**
 * Ceiling on a PATCH body.
 *
 * Sized FROM `MAX_IDS` rather than copied from the 16 KiB the shortlinks route
 * uses: 500 uuids cost about 41 bytes each once quoted and comma-separated, so a
 * perfectly legal "move everything I selected" body is ~20 KB and the smaller
 * cap would have refused it with a 413 before the id cap ever ran — the client
 * would see a size error for a request that was within every documented limit.
 */
const PATCH_BODY_MAX = 64 * 1024;

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // A per-account answer must never be held by a shared cache.
      "cache-control": "private, no-store",
      ...extra,
    },
  });
}

/**
 * Who is calling: `x-api-key` / `Authorization: Bearer` first, session second.
 *
 * A PRESENT token is the whole answer, valid or not. Falling through to the
 * session when the token fails would mean a desktop client holding a REVOKED key
 * quietly listing whichever library the browser it shares a cookie jar with
 * happens to be signed into - a refusal that reads as success is worse than no
 * endpoint at all. A banned account is refused on both paths, matching the
 * upload path: the tokens survive a ban, the use of them does not.
 *
 * The rule lives in lib/api-caller.ts, which is the module allowed to hold it:
 * it imports @/lib/auth-helpers and its `import "server-only"`, a specifier
 * esbuild passes through untouched, so nothing reachable from server.ts may
 * touch it. Route handlers are not reachable from there. This used to be three
 * inlined copies of the same security check across three routes, which is three
 * chances to edit it wrong and no test that notices.
 */

/**
 * Would `GET /{tag}/{code}/raw?w=…` actually return a thumbnail for this row?
 *
 * Exactly the conditions the serving route applies, and they have to stay
 * exactly those: outside them that URL streams the ORIGINAL file, so a client
 * that trusted a `thumbUrl` it could not actually get a tile for would download
 * the whole thing to draw one.
 * `mediaKind` rather than a `image/` prefix test, so a .avif that ShareX stored
 * as application/octet-stream still gets one - and so an SVG, which is an image
 * but never served as one (anti-XSS), does not claim to.
 */
function canThumbnail(f: FileItem): boolean {
  const kind = mediaKind(f.mimeType, f.ext);
  // Video earns a thumbUrl too, now that /raw answers a resize request for one
  // with a poster frame (lib/media/poster.ts). Without this the desktop client
  // never asks, and a library of screen recordings draws as a wall of grey
  // icons - the server grew the ability and nothing could reach it.
  //
  // The ceiling differs by kind on purpose. For an image MAX_TRANSFORM_BYTES
  // bounds a full read and a libvips decode. A poster is a SEEK: ffmpeg jumps to
  // the frame instead of decoding up to it, so a 700 MB recording costs about
  // what reading a few megabytes costs, and the honest bound is the one the
  // audio/video path already uses.
  if (kind === "video") return f.size <= AV_MAX_INPUT_BYTES;
  return kind === "image" && f.size <= MAX_TRANSFORM_BYTES;
}

export async function GET(req: Request): Promise<Response> {
  // Listing a library is reading it.
  const auth = await resolveApiOwner(req, "read");
  if (!auth.ok) return json(auth.body, auth.status);
  const owner = auth.caller;

  const q = parseUploadQuery(new URL(req.url).searchParams);

  // The folder id is a string the CLIENT wrote and `uploads.folder_id` is a uuid
  // column, so it goes through the same gate both upload paths use: uuid shape
  // checked BEFORE any query, ownership folded into the WHERE clause, and "not
  // yours", "gone" and "not a uuid" answered identically so this cannot be used
  // to enumerate other people's folders.
  let folderId: string | null | undefined;
  try {
    folderId = await resolveFolderTarget(owner.id, q.folder);
  } catch (err) {
    if (err instanceof FolderAccessError) return json({ message: "Folder not found." }, 404);
    throw err;
  }

  const result = await listUploads({
    userId: owner.id,
    page: q.page,
    perPage: q.perPage,
    search: q.search,
    sort: q.sort,
    kind: q.kind,
    trashed: q.trashed,
    folderId,
  });

  // `toFileItems` hydrates folder NAMES for the panel's chips; this surface
  // returns ids only and clients resolve the names from /api/folders, which they
  // already have to call to draw a folder picker. An empty map is the honest way
  // to say "not asked for" - it costs one query less than fetching names nobody
  // reads.
  const items = toFileItems(result.items, new Map());

  return json({
    // Echoed from what the query actually USED, never from what was asked for:
    // `listUploads` clamps perPage itself, and a client that trusted its own 500
    // while receiving 120 would compute a page count four times too small and
    // skip most of the library.
    page: result.page,
    perPage: result.perPage,
    total: result.total,
    /** The literal to send as `folderId` to mean "files in no folder". */
    rootValue: ROOT_FOLDER,
    items: items.map((f) => apiItem(f, owner, q.trashed)),
  });
}

/** One row, in the shape a desktop grid draws a tile from. */
function apiItem(f: FileItem, owner: UserRow, trashed: boolean) {
  // A trashed row has no working links, so it is given none. `getMedia` filters
  // on `deleted_at IS NULL`, which means every one of these URLs 404s while the
  // file sits in the bin - and handing a client four dead links is the bug the
  // panel's own trash view had (it rendered ordinary file cards) until TrashList
  // replaced them. A link that lies is worse than an absent one.
  const links = trashed ? null : mediaUrls(owner, f.code, f.ext);

  return {
    id: f.id,
    code: f.code,
    filename: f.filename,
    ext: f.ext,
    mimeType: f.mimeType,
    /**
     * The server's classification, not the client's. It consults
     * `effectiveType`, so a row whose stored MIME is application/octet-stream is
     * still filed as the image it is - a desktop app re-deriving this from the
     * MIME string alone would put a generic icon on exactly the files the panel
     * shows a picture for.
     */
    kind: f.kind,
    size: f.size,
    width: f.width,
    height: f.height,
    blurhash: f.blurhash,
    published: f.published,
    views: f.views,
    downloads: f.downloads,
    createdAt: f.createdAt,
    folderId: f.folderId,
    /**
     * Why a tile may fail to load, without a round trip to find out.
     *
     * `hasPassword` predicts a 401 from the media routes and the other two
     * predict a 404: an expired link and a spent view budget are refused to
     * EVERYONE by `getMedia`, the owner included. The panel draws these as
     * badges; a client without them can only show a broken image.
     */
    expiresAt: f.expiresAt ?? null,
    maxViews: f.maxViews ?? null,
    hasPassword: f.hasPassword ?? false,
    url: links?.url ?? null,
    rawUrl: links?.rawUrl ?? null,
    // Always carries w/h, and that is load-bearing rather than cosmetic: the
    // serving route treats a resize parameter as proof this is a preview and not
    // a read, so populating a grid never spends a view or burns a one-time link.
    thumbUrl: links && canThumbnail(f) ? `${links.rawUrl}?w=${THUMB_PX}&h=${THUMB_PX}` : null,
    /**
     * A thumbnail that MOVES (an animated WebP of frames sampled across the
     * file), or null when this row cannot produce one.
     *
     * Null is the whole point of the field, and it follows `canThumbnail`'s
     * discipline exactly: `canMotionPreview` applies the same conditions the
     * serving route applies, so a client that trusts this URL always gets a tile
     * from it. Advertising it optimistically would send a grid off to fetch a
     * preview that answers 415 for every still image in the library.
     *
     * The size matches `thumbUrl` so a client can swap one for the other on
     * hover without the tile changing size, and it is the size the serving
     * route uses when `motion=1` names none, so both spellings of the request
     * share one cache entry.
     */
    motionThumbUrl:
      links && canMotionPreview(f)
        ? `${links.rawUrl}?w=${MOTION_PX}&h=${MOTION_PX}&${MOTION_PARAM}=1`
        : null,
    // Which link goes on the clipboard is decided HERE, from `user.copy_raw`,
    // exactly as lib/upload/finalize.ts decides it for ShareX. A client choosing
    // for itself would mean one account copying two different shapes of link
    // depending on which app it came from, with the profile switch governing only
    // one of them.
    copyUrl: links ? (owner.copyRaw ? links.rawUrl : links.url) : null,
  };
}


/**
 * How each core refusal reaches the wire.
 *
 * An exhaustive `Record`, so adding a member to `UploadIssue` stops compiling
 * here until somebody decides what it means over HTTP - the only thing keeping
 * this table from quietly falling behind the union.
 *
 * `code-taken` is 409 rather than 400: the request is well formed and refused by
 * the current state of the world, which a different slug would fix. Everything
 * malformed is 400, and `not-found` is 404 for an unknown id, another account's
 * id and a malformed id alike.
 */
const UPLOAD_STATUS: Record<UploadIssue, number> = {
  "not-found": 404,
  "invalid-code": 400,
  "code-too-long": 400,
  "code-taken": 409,
  // 409 rather than 400: the request is well formed and refused by the current
  // state of the world, exactly like a code somebody else already holds. The app
  // holding it is still somebody holding it.
  "code-reserved": 409,
  "invalid-date": 400,
  "invalid-views": 400,
  "password-too-long": 400,
};

/** Password changes allowed per account, and the window they are counted over. */
const PASSWORD_LIMIT = 30;
const PASSWORD_WINDOW_MS = 60_000;

/**
 * PATCH - change files. Body: `{ ids: [...] }` plus any of the keys below.
 *
 * `folderId`   move between folders (`null` or `rootValue` = no folder)
 * `published`  publish or unpublish
 * `code`       the vanity URL. ONE id only
 * `expiresAt`  ISO date string, or `null` to clear
 * `maxViews`   view cap, or `null` to clear
 * `password`   per-file password, or `null` to clear
 *
 * This is what lets a desktop client offer the panel's right-click menu. Until
 * now the only mover was `moveUploadsToFolder` and the only publisher, vanity
 * setter and link-settings dialog were Server Actions, so a client could SEE all
 * of it and change none of it.
 *
 * An absent key means "leave alone"; an explicit `null` means "clear". That is
 * what `supplied()` is for, and collapsing the two would make a rename silently
 * drop an expiry the same way it once pulled files out of the folder tree.
 *
 * `code` is refused for a multi-id request rather than applied to the first one:
 * `uploads.code` is globally unique, so two files cannot share a URL and any
 * reading of "set the code on these five files" is a mistake.
 *
 * Every field is validated BEFORE anything is written, so a malformed later key
 * cannot leave a half-applied change behind.
 *
 * Scoped strictly to the caller's own files. An administrator's reach over other
 * accounts (`UploadActor.isAdmin`) is a panel affordance and stays there: the
 * links in the answer are built from the CALLER's account settings, so a foreign
 * row would come back with a URL its owner does not use.
 */
export async function PATCH(req: Request): Promise<Response> {
  // Renaming, re-coding, moving and publishing are all changes to the library.
  const auth = await resolveApiOwner(req, "write");
  // Before the body, so an unauthenticated caller cannot make us buffer one.
  if (!auth.ok) return json(auth.body, auth.status);
  const owner = auth.caller;

  const parsed = await readJsonObject(req, PATCH_BODY_MAX);
  if (!parsed.ok) return json({ message: parsed.message }, parsed.status);
  const body = parsed.body;

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
  if (!ids.length) return json({ message: "No ids given." }, 400);
  // The same cap DELETE applies, for the same reason: one request must not be
  // able to ask for an unbounded IN (...) list.
  if (ids.length > MAX_IDS) return json({ message: `Too many ids (max ${MAX_IDS}).` }, 400);

  const wantsFolder = supplied(body, "folderId");
  const wantsPublished = supplied(body, "published");
  const wantsCode = supplied(body, "code");
  const wantsExpiry = supplied(body, "expiresAt");
  const wantsMaxViews = supplied(body, "maxViews");
  const wantsPassword = supplied(body, "password");

  if (
    !wantsFolder &&
    !wantsPublished &&
    !wantsCode &&
    !wantsExpiry &&
    !wantsMaxViews &&
    !wantsPassword
  ) {
    // Includes the old "`folderId` is required" case: a body naming ids and
    // nothing else changes nothing, and answering 200 to it would tell a client
    // its edit landed.
    return json(
      {
        message:
          "Nothing to change: send `folderId`, `published`, `code`, `expiresAt`, `maxViews` or `password`.",
      },
      400,
    );
  }

  /* -- shapes, all of them, before a single write ------------------------- */

  let folderId: string | null = null;
  if (wantsFolder) {
    const raw = body.folderId;
    if (raw !== null && typeof raw !== "string") {
      return json({ message: "`folderId` must be a string or null." }, 400);
    }
    folderId = raw === null || raw === "" || raw === ROOT_FOLDER ? null : raw;
  }

  if (wantsPublished && typeof body.published !== "boolean") {
    return json({ message: "`published` must be a boolean." }, 400);
  }

  if (wantsCode) {
    if (typeof body.code !== "string") {
      return json({ message: "`code` must be a string." }, 400);
    }
    if (ids.length > 1) {
      return json(
        {
          message: "`code` sets one file's URL, so it cannot be sent with several ids.",
          reason: "code-single-id",
        },
        400,
      );
    }
  }

  if (wantsExpiry && body.expiresAt !== null && typeof body.expiresAt !== "string") {
    return json({ message: "`expiresAt` must be an ISO date string or null." }, 400);
  }

  if (wantsMaxViews && body.maxViews !== null && typeof body.maxViews !== "number") {
    return json({ message: "`maxViews` must be a number or null." }, 400);
  }

  if (wantsPassword && body.password !== null && typeof body.password !== "string") {
    return json({ message: "`password` must be a string or null." }, 400);
  }

  // Priced per call, unlike everything else here: hashing a password runs
  // scrypt, which is deliberately expensive, and that is exactly what makes an
  // unbounded loop of them a way to spend the server's CPU. Keyed on the
  // account rather than the address, because a token IS an account and rotating
  // addresses would otherwise sidestep it. Clearing a password is free and is
  // not counted.
  if (wantsPassword && typeof body.password === "string" && body.password.length > 0) {
    const gate = checkRateLimit(
      `upload-password:${owner.id}`,
      PASSWORD_LIMIT,
      PASSWORD_WINDOW_MS,
    );
    if (!gate.allowed) {
      return json(
        { message: "Too many password changes. Try again shortly.", reason: "rate-limited" },
        429,
        { "retry-after": String(Math.ceil(gate.retryAfterMs / 1000)) },
      );
    }
  }

  /* -- writes -------------------------------------------------------------- */

  const actor: UploadActor = { userId: owner.id, email: owner.email };

  try {
    if (wantsFolder) await moveUploadsToFolderFor(owner.id, ids, folderId);
    if (wantsPublished) await setPublishedFor(actor, ids, body.published as boolean);
    if (wantsExpiry) await setExpiryFor(actor, ids, body.expiresAt as string | null);
    if (wantsMaxViews) await setMaxViewsFor(actor, ids, body.maxViews as number | null);
    if (wantsPassword) await setPasswordFor(actor, ids, body.password as string | null);
    // Last, so the rows read back below already answer on the new URL.
    if (wantsCode) await setVanityFor(actor, ids[0], body.code as string);
  } catch (err) {
    // An unknown or foreign TARGET FOLDER is one 404 for both cases - the same
    // answer GET gives, so this cannot be used to test whether a folder id is
    // real.
    if (err instanceof FolderOpError) return json({ message: err.message, reason: err.reason }, 404);
    if (err instanceof UploadOpError) {
      return json({ message: err.message, reason: err.reason }, UPLOAD_STATUS[err.reason]);
    }
    throw err;
  }

  /* -- what the client should now draw ------------------------------------ */

  // Read back rather than reconstructed: the client redraws a card from this,
  // and a client that has to re-fetch the whole page after every small edit
  // feels exactly as sluggish as the app this one is replacing. One scoped
  // SELECT is the cheapest honest answer, and it is the same shape GET returns
  // so there is one card renderer rather than two.
  const rows = await actionableUploads(actor, ids);
  const items = toFileItems(rows, new Map()).map((f, i) =>
    // Per row, not per request: a file sitting in the trash has no working
    // links, and handing a client four dead URLs is worse than handing it none.
    apiItem(f, owner, rows[i].deletedAt !== null),
  );

  const payload: Record<string, unknown> = {
    message: "OK",
    // `affected` can be lower than `requested` without that being an error: an
    // id that is gone, not a uuid, or not this account's is reported by the
    // count rather than by a status, so a client editing a stale selection does
    // not have to treat a partial hit as a failure.
    requested: ids.length,
    affected: rows.length,
    items,
  };
  if (wantsFolder) payload.folderId = folderId;

  return json(payload);
}

/** The three things this endpoint can be asked to do. */
type DeleteMode = "trash" | "permanent" | "restore";

/**
 * Which rows a given mode is allowed to touch - one arm per mode, on purpose.
 *
 * This was written as `mode === "restore" ? undefined : isNull(deletedAt)`, and
 * read literally that says PERMANENT may only see rows that are NOT in the
 * trash. So "delete for good" - the one verb whose whole job is emptying a
 * trash - matched nothing whenever the file was actually in the trash, answered
 * `affected: 0`, and the desktop client correctly reported that the server had
 * changed nothing. The panel's own trash screen never noticed, because it goes
 * through a Server Action rather than this route. Files could be put in the bin
 * from the app and only ever taken out of it from the website.
 *
 * Stated as three arms rather than a cleverer two, because the three answers
 * genuinely differ:
 *
 *  - `trash` sees LIVE rows only. Re-stamping a row already in the trash hands
 *    it another thirty days before the sweeper takes it, which is a bug that has
 *    been fixed here once already; `softDeleteMedia` guards it a second time,
 *    and both guards are deliberate.
 *  - `restore` sees TRASHED rows only. Not "everything": clearing `deleted_at`
 *    on a row that never had it set is a write that says nothing, and it would
 *    inflate the very count this endpoint reports back as what it did.
 *  - `permanent` sees BOTH. A file can be destroyed straight from the library or
 *    out of the trash, and whether `deleted_at` is set has no bearing on whether
 *    its bytes may be removed.
 */
function reachableBy(mode: DeleteMode) {
  if (mode === "trash") return isNull(uploads.deletedAt);
  if (mode === "restore") return isNotNull(uploads.deletedAt);
  return undefined;
}

/**
 * Delete uploads: to the trash by default, permanently on request.
 *
 * Why this exists: the desktop client could not offer a trash at all. The only
 * deletion route that accepts an API token is /{tag}/{code}/delete/{token}, and
 * that one deletes for good - correctly, because it is a link you hand to other
 * people and "moved to my trash" would be a lie to a recipient who cannot see
 * the trash. Everything softer lived in session-only server actions the panel
 * calls, which a desktop app has no way to reach.
 *
 * Body: `{ "ids": [...], "mode": "trash" | "permanent" | "restore" }`.
 * `mode` defaults to "trash", so the destructive reading is never the one a
 * caller gets by forgetting a field.
 */
export async function DELETE(req: Request): Promise<Response> {
  // Trash, restore and permanent removal alike.
  const auth = await resolveApiOwner(req, "write");
  if (!auth.ok) return json(auth.body, auth.status);
  const owner = auth.caller;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ message: "Expected a JSON body." }, 400);
  }

  const input = (body ?? {}) as { ids?: unknown; mode?: unknown };
  // Shape checked BEFORE the query, like every other id this app accepts. Without
  // it one malformed entry in the list makes Postgres reject the whole statement,
  // which surfaces as a 500 and deletes nothing - so a client with one bad id in
  // a selection of fifty gets an error that looks like our fault and loses the
  // other forty-nine. A non-uuid cannot be anybody's row, so dropping it here
  // says the same thing the query would: not found.
  const ids = Array.isArray(input.ids)
    ? input.ids.filter((v): v is string => typeof v === "string" && isUuid(v))
    : [];
  if (!ids.length) return json({ message: "No ids given." }, 400);
  // A cap so one request cannot ask for an unbounded IN (...) list.
  if (ids.length > MAX_IDS) return json({ message: `Too many ids (max ${MAX_IDS}).` }, 400);

  const mode = input.mode === "permanent" || input.mode === "restore" ? input.mode : "trash";

  // Ownership is folded into the SELECT, so an id belonging to somebody else is
  // simply not found - identical to an id that never existed. Anything else
  // would turn this endpoint into a way to test whether a given upload id is
  // real, and whose it is.
  const rows = await db
    .select()
    .from(uploads)
    .where(and(inArray(uploads.id, ids), eq(uploads.ownerId, owner.id), reachableBy(mode)));

  let done = 0;
  for (const row of rows) {
    if (mode === "permanent") {
      await deleteMediaHard(row);
    } else if (mode === "restore") {
      await restoreMedia(row.id);
    } else {
      await softDeleteMedia(row.id);
    }
    done++;
  }

  // `done` can be lower than `ids.length` and that is not an error: an id that
  // is already in the trash, already gone, or not this account's is reported by
  // the count rather than by a status, so a client deleting a stale selection
  // does not have to treat a partial hit as a failure.
  return json({ message: "OK", mode, requested: ids.length, affected: done });
}
