import { folderStats, listUserFolders, unfiledStats } from "@/lib/data/folders";
import { resolveApiCaller } from "@/lib/api-caller";
import { ROOT_FOLDER } from "@/lib/upload/folder-target";
import { readJsonObject, supplied } from "@/lib/api-json";
import {
  createFolderFor,
  deleteFolderFor,
  FolderOpError,
  getOwnedFolder,
  moveFolderFor,
  renameFolderFor,
  setFolderVisibilityFor,
  type FolderIssue,
  type FolderRecord,
} from "@/lib/folders";

/**
 * The caller's folders — reading them, and now changing them.
 *
 * Exists for the desktop companions (the Modlight App fork of ShareX, the YTDL
 * downloader): they can name a target folder on an upload, which is useless
 * without a way to learn the ids, and until the write verbs below existed the
 * app could only ever LIST. Everything that creates, renames, moves or deletes a
 * folder lived in Server Actions, which a C# client has no way to invoke — so
 * "the panel without needing a browser" stopped at read-only.
 *
 * None of the rules are restated here. `lib/folders.ts` holds them (depth
 * ceiling, slug uniqueness, cycle prevention, ownership, the two delete modes)
 * and the panel's actions call the same functions. What this file owns is the
 * HTTP shape: who is calling, what a body may contain, and which status each
 * refusal becomes.
 *
 * Authenticates with an API TOKEN first and a session second, in that order.
 * The token is what a desktop app has; the session is a convenience so the same
 * URL can be opened in a logged-in browser while debugging. Either way the
 * answer is scoped to one account and never says anything about another.
 */

export const dynamic = "force-dynamic";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // A per-account answer must never be held by a shared cache.
      "cache-control": "private, no-store",
    },
  });
}

/**
 * Who is calling, and may their token do this?
 *
 * The rule lives in lib/api-caller.ts: a present token decides on its own
 * (never a fall-through to whatever cookie the request carried), a banned
 * account keeps its tokens and loses the use of them, and a token whose scope
 * does not cover `required` is a 403 that says which scope would. This file used
 * to hold a fourth inlined copy of the first two rules, which is a fourth chance
 * to edit a security check wrong.
 */

/**
 * How each refusal reaches the wire.
 *
 * An exhaustive `Record`, so adding a member to `FolderIssue` stops compiling
 * here until somebody decides what it means over HTTP.
 *
 * `not-found` is 404 for an unknown id, another account's id and a malformed id
 * alike — that is the whole point of the single answer in `lib/folders.ts`, and
 * splitting it out here would put the oracle back. `too-deep` and `cycle` are
 * 409: the request is well formed and refused by the current shape of the tree,
 * which a different parent would fix.
 */
const STATUS: Record<FolderIssue, number> = {
  "not-found": 404,
  "invalid-name": 400,
  "too-deep": 409,
  cycle: 409,
};

function refuse(err: FolderOpError): Response {
  return json({ message: err.message, reason: err.reason }, STATUS[err.reason]);
}

/**
 * One folder, in the shape GET's `folders[]` entries use.
 *
 * The same keys in the same order on purpose: a client that draws a tile from a
 * listing row must be able to draw the identical tile from a create or a rename
 * without a second code path.
 */
async function folderView(ownerId: string, f: FolderRecord) {
  const stats = await folderStats(ownerId, f.id);
  return {
    id: f.id,
    name: f.name,
    slug: f.slug,
    parentId: f.parentId,
    isPublic: f.isPublic,
    // DIRECT contents only, as in the listing.
    fileCount: stats.count,
    size: stats.size,
    sortOrder: f.sortOrder,
  };
}

export async function GET(req: Request): Promise<Response> {
  // Listing folders is reading the library.
  const auth = await resolveApiCaller(req, "read");
  if (!auth.ok) return json(auth.body, auth.status);
  const ownerId = auth.caller.id;

  // The same function the panel's own folder browser is built from, rather than
  // a second query that would drift from it. It already returns the direct file
  // count and byte total per folder, computed as ONE grouped scan - the desktop
  // client draws a tile per folder showing exactly those two numbers, and asking
  // for them per folder would be an N+1 over ~6800 uploads.
  const rows = await listUserFolders(ownerId);

  // What is loose in the account, so a client can offer the "outside any folder"
  // shelf without inventing the number itself.
  const unfiled = await unfiledStats(ownerId);

  return json({
    // The literal a client sends back as `folderId` to mean "no folder", so it
    // does not have to hardcode our sentinel.
    rootValue: ROOT_FOLDER,
    unfiled: { fileCount: unfiled.count, size: unfiled.size },
    folders: rows.map((f) => ({
      id: f.id,
      name: f.name,
      slug: f.slug,
      parentId: f.parentId,
      isPublic: f.isPublic,
      // DIRECT contents only. Rolling the subtree up is left to the client, which
      // already has every folder and its parent here - doing it server-side would
      // mean a recursive query per request for a number that is one loop over a
      // list the caller is holding anyway.
      fileCount: f.count,
      size: f.size,
      sortOrder: f.sortOrder,
    })),
  });
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Read the id a write names, or a 400.
 *
 * Only the SHAPE is judged here — whether it exists and whose it is stays with
 * `lib/folders.ts`, which answers both with the same 404.
 */
function idOf(body: Record<string, unknown>): string | null {
  return typeof body.id === "string" && body.id.length > 0 ? body.id : null;
}

/**
 * A parent id from a body: a folder id, or `null` for the root.
 *
 * `rootValue` (the sentinel every client already has from GET) is accepted
 * alongside JSON `null`, so a client that stores "the root" as a string does not
 * have to special-case it on the way out.
 */
function parentOf(raw: unknown): { ok: true; value: string | null } | { ok: false } {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false };
  if (raw === ROOT_FOLDER || raw === "") return { ok: true, value: null };
  return { ok: true, value: raw };
}

/** POST — create a folder. Body: `{ name, parentId? }`. */
export async function POST(req: Request): Promise<Response> {
  // Creating a folder changes the library.
  const auth = await resolveApiCaller(req, "write");
  if (!auth.ok) return json(auth.body, auth.status);
  // Resolved before the body is read, so an unauthenticated flood costs us nothing.
  const ownerId = auth.caller.id;

  const parsed = await readJsonObject(req);
  if (!parsed.ok) return json({ message: parsed.message }, parsed.status);
  const body = parsed.body;

  if (typeof body.name !== "string") {
    return json({ message: "`name` is required and must be a string." }, 400);
  }

  let parentId: string | null = null;
  if (supplied(body, "parentId")) {
    const parent = parentOf(body.parentId);
    if (!parent.ok) return json({ message: "`parentId` must be a string or null." }, 400);
    parentId = parent.value;
  }

  try {
    const folder = await createFolderFor(ownerId, body.name, parentId);
    return json({ message: "OK", folder: await folderView(ownerId, folder) }, 201);
  } catch (err) {
    if (err instanceof FolderOpError) return refuse(err);
    throw err;
  }
}

/**
 * PATCH — rename, move, or publish/unpublish. Body: `{ id, name?, parentId?, isPublic? }`.
 *
 * A field that is absent is left alone; `parentId: null` is an explicit "move to
 * the root". Several may be sent at once, and the order below matters: the
 * rename settles the name first so the move re-derives the slug from the NEW
 * name in the NEW parent, rather than leaving a slug computed for the old one.
 */
export async function PATCH(req: Request): Promise<Response> {
  // Renaming, moving and re-sorting a folder change the library.
  const auth = await resolveApiCaller(req, "write");
  if (!auth.ok) return json(auth.body, auth.status);
  const ownerId = auth.caller.id;

  const parsed = await readJsonObject(req);
  if (!parsed.ok) return json({ message: parsed.message }, parsed.status);
  const body = parsed.body;

  const id = idOf(body);
  if (!id) return json({ message: "`id` is required and must be a string." }, 400);

  const wantsName = supplied(body, "name");
  const wantsParent = supplied(body, "parentId");
  const wantsPublic = supplied(body, "isPublic");

  if (!wantsName && !wantsParent && !wantsPublic) {
    return json({ message: "Nothing to change: send `name`, `parentId` or `isPublic`." }, 400);
  }
  if (wantsName && typeof body.name !== "string") {
    return json({ message: "`name` must be a string." }, 400);
  }
  if (wantsPublic && typeof body.isPublic !== "boolean") {
    return json({ message: "`isPublic` must be a boolean." }, 400);
  }

  let parentId: string | null = null;
  if (wantsParent) {
    const parent = parentOf(body.parentId);
    if (!parent.ok) return json({ message: "`parentId` must be a string or null." }, 400);
    parentId = parent.value;
  }

  try {
    // The owner-scoped read comes first, so a folder that is missing, someone
    // else's, or not a uuid is one 404 before any field is looked at — a caller
    // learns nothing from WHICH part of the body would have failed.
    let folder = await getOwnedFolder(ownerId, id);

    if (wantsName) folder = await renameFolderFor(ownerId, id, body.name as string);
    if (wantsParent) folder = await moveFolderFor(ownerId, id, parentId);
    if (wantsPublic) folder = await setFolderVisibilityFor(ownerId, id, body.isPublic as boolean);

    return json({ message: "OK", folder: await folderView(ownerId, folder) });
  } catch (err) {
    if (err instanceof FolderOpError) return refuse(err);
    throw err;
  }
}

/**
 * DELETE — remove a folder. Body: `{ id, withContents?: boolean }`.
 *
 * `withContents` must be sent, and sent as `true`. Omitting it gets the SAFE
 * mode: the folder alone goes, its files fall back to "no folder" and its
 * children re-parent — exactly what the panel's default does. The destructive
 * reading is never the one a caller reaches by forgetting a field.
 */
export async function DELETE(req: Request): Promise<Response> {
  // Deleting a folder — and, with `withContents`, its files.
  const auth = await resolveApiCaller(req, "write");
  if (!auth.ok) return json(auth.body, auth.status);
  const ownerId = auth.caller.id;

  const parsed = await readJsonObject(req);
  if (!parsed.ok) return json({ message: parsed.message }, parsed.status);
  const body = parsed.body;

  const id = idOf(body);
  if (!id) return json({ message: "`id` is required and must be a string." }, 400);

  if (supplied(body, "withContents") && typeof body.withContents !== "boolean") {
    return json({ message: "`withContents` must be a boolean." }, 400);
  }
  // `=== true`, not truthy: a client that sends the string "false" (a checkbox
  // stringified on its way out, say) must not trip the mode that empties a tree
  // into the trash.
  const withContents = body.withContents === true;

  try {
    const result = await deleteFolderFor(ownerId, id, { withContents });
    return json({
      message: "OK",
      withContents,
      folders: result.folders,
      trashed: result.trashed,
    });
  } catch (err) {
    if (err instanceof FolderOpError) return refuse(err);
    throw err;
  }
}
