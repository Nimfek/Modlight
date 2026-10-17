import "server-only";
import { Readable } from "node:stream";
import { cookies, headers } from "next/headers";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { uploads, user as users, userCodeAliases } from "@/lib/db/schema";
import { getStorage } from "@/lib/storage";
import { getSession } from "@/lib/auth-helpers";
import { authenticateApiToken, bearerFromRequest } from "@/lib/api-token";
import { serveDecision } from "@/lib/media/mime";
import { rowMimeType } from "@/lib/media/paste-type";
import { codeFromMediaCode } from "@/lib/media/paths";
import { backgroundStyle, type BackgroundStyle } from "@/lib/background";

export type MediaRow = typeof uploads.$inferSelect;

/**
 * Strip a trailing extension to recover the bare code.
 *
 * Defined in lib/media/paths.ts (pure, testable without a database) and
 * re-exported here because this is where every serving path already looks for it.
 */
export { codeFromMediaCode } from "@/lib/media/paths";

export interface MediaLookup {
  media: MediaRow;
  ownerUserCode: string;
  ownerId: string;
  ownerTheme: string;
  /**
   * The owner's wallpaper, so a shared link is decorated the way its owner
   * decorated their panel - the same promise `ownerTheme` already makes.
   */
  ownerBackground: BackgroundStyle | null;
  /**
   * Hostname the owner generates links with (null = deployment default). The
   * page and oEmbed responses build their canonical/OG URLs from it, so an
   * unfurled link reads as the same domain the owner shares everywhere else.
   * Resolve through `userBaseUrl()` — see lib/media/urls.ts.
   */
  ownerPreferredDomain: string | null;
}

/**
 * Look up a media by its public {userCode}/{code}, honoring soft-delete and
 * expiry/max-views. Returns null (→ 404) when missing/expired. Access control
 * (unpublished/password) is applied by callers with the requester's session.
 */
export async function getMedia(userCode: string, mediaCode: string): Promise<MediaLookup | null> {
  const code = codeFromMediaCode(mediaCode);
  const rows = await db
    .select()
    .from(uploads)
    .where(and(eq(uploads.code, code), isNull(uploads.deletedAt)))
    .limit(1);
  const media = rows[0];
  if (!media) return null;

  // Orphaned file (its account was deleted with "keep the files"). The public
  // URL is /{tag}/{code} and the tag belongs to the owner — with no owner there
  // is nothing to match it against, so the file is simply not on the web any
  // more. It stays visible to admins in Admin → Orphaned files.
  const ownerId = media.ownerId;
  if (!ownerId) return null;

  const ownerRows = await db
    .select({
      id: users.id,
      userCode: users.userCode,
      theme: users.theme,
      preferredDomain: users.preferredDomain,
      backgroundKey: users.backgroundKey,
      backgroundDim: users.backgroundDim,
    })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);
  const owner = ownerRows[0];
  if (!owner) return null;

  // The tag in the URL must belong to the owner — either their current one or a
  // tag they used previously. Without the alias check, letting a user rename
  // their tag would 404 every link they had ever shared.
  if (owner.userCode !== userCode) {
    const alias = await db
      .select({ userId: userCodeAliases.userId })
      .from(userCodeAliases)
      .where(eq(userCodeAliases.code, userCode))
      .limit(1);
    if (!alias[0] || alias[0].userId !== owner.id) return null;
  }

  // expiry / burn-after-views
  if (media.expiresAt && media.expiresAt.getTime() <= Date.now()) return null;
  if (media.maxViews != null && media.views >= media.maxViews) return null;

  return {
    // A paste's stored type was a placeholder (text/plain, whatever language
    // its author picked), so every reader of this row - the preview page, the
    // sandboxed render, oEmbed, link-info - was reasoning from it and getting
    // the same wrong answer. Resolving it here fixes the pastes created before
    // that was true without a migration, and is a no-op for the ones created
    // since. It changes nothing on the wire: `streamMedia` below still runs the
    // result through `serveDecision`, so a paste declared as HTML is still
    // handed over as text/plain; charset=utf-8.
    media: { ...media, mimeType: rowMimeType(media) },
    ownerUserCode: owner.userCode ?? userCode,
    ownerId: owner.id,
    ownerTheme: owner.theme ?? "modern",
    ownerBackground: backgroundStyle(owner.userCode, owner.backgroundKey, owner.backgroundDim),
    ownerPreferredDomain: owner.preferredDomain ?? null,
  };
}

/**
 * Is the caller allowed to see this media regardless of its published flag —
 * and, just as importantly, exempt from burning its view budget?
 *
 * Cheap path first: the vast majority of media hits are anonymous, and resolving
 * a session costs a database round-trip, so skip it when no session cookie was
 * even sent. Better Auth's cookie is `better-auth.session_token` (with the
 * `__Secure-` prefix in production).
 */
export async function isPrivilegedViewer(ownerId: string): Promise<boolean> {
  return (await viewerRelation(ownerId)).privileged;
}

/**
 * The same resolution, but keeping WHICH of the two it was.
 *
 * "Privileged" folds the owner and an administrator together, which is right for
 * everything it guards: both may see an unpublished file and neither should
 * spend its view budget. It is wrong for anything addressed to the person whose
 * file this is. An administrator reviewing somebody else's library cannot change
 * how that person records and should not be told their recording is a poor one,
 * so the playback note reads `isOwner` and nothing else does yet.
 *
 * One function rather than two so a page that needs both facts resolves the
 * session once, and so the token and cookie plumbing below exists in one place.
 */
export async function viewerRelation(
  ownerId: string,
): Promise<{ privileged: boolean; isOwner: boolean }> {
  // An API token is the account holder, and until now this function could not
  // see one. The consequence was not theoretical: the desktop client draws its
  // library from thumbnails, and since Round 6 stamps the account's default
  // password onto every new upload, an account using that feature would have
  // got 401 on every single tile. An account with "hide uploads" on would have
  // seen a blank grid. The token is checked FIRST because a desktop client
  // sends no cookies at all, so the cheap-path bail below would otherwise
  // refuse it before anything looked at the header.
  //
  // SCOPE: `read`. Seeing an unpublished file, or one behind the account's
  // default password, is reading the library — so an `upload`-scoped token (the
  // one in a ShareX config) is treated exactly like an anonymous visitor here
  // and gets whatever the public rules give it. That is not a regression for
  // ShareX: it fetches a ThumbnailURL as a plain GET with no headers at all, so
  // this branch was never what made its previews work. It IS what makes the
  // desktop client's grid work, and that client holds a `write` token.
  const token = bearerFromRequest(await headers());
  if (token) {
    const auth = await authenticateApiToken(token, "read");
    if (!auth.ok) return NOBODY;
    return relate(auth.user.id, auth.user.role, ownerId);
  }

  const jar = await cookies();
  if (!jar.getAll().some((c) => c.name.includes("session_token"))) return NOBODY;
  const session = await getSession();
  if (!session) return NOBODY;
  return relate(session.user.id, session.user.role, ownerId);
}

const NOBODY = { privileged: false, isOwner: false } as const;

function relate(
  viewerId: string,
  role: string | null | undefined,
  ownerId: string,
): { privileged: boolean; isOwner: boolean } {
  const isOwner = viewerId === ownerId;
  return { privileged: isOwner || role === "admin", isOwner };
}

/**
 * Count one access, atomically refusing to go past `maxViews`.
 *
 * Burn-after-view has to be enforced by the database, not by a read followed by
 * a write: two concurrent requests for a one-time link would both read views=0
 * and both be served. `UPDATE … WHERE views < max_views RETURNING` lets exactly
 * one of them win. Returns false when the budget is already spent (→ 404).
 *
 * Every serving path must go through this — /raw and /download are the URLs
 * that actually end up in ShareX and Discord, so a page-only counter counts
 * almost nothing.
 */
export async function consumeView(
  media: MediaRow,
  opts: { download?: boolean } = {},
): Promise<boolean> {
  const now = new Date();
  const patch = opts.download
    ? {
        views: sql`${uploads.views} + 1`,
        downloads: sql`${uploads.downloads} + 1`,
        lastAccessedAt: now,
      }
    : { views: sql`${uploads.views} + 1`, lastAccessedAt: now };

  // Uncapped file: the counter is statistics, so don't make the client wait on
  // a write before its bytes start flowing.
  if (media.maxViews == null) {
    void db.update(uploads).set(patch).where(eq(uploads.id, media.id)).catch(() => {});
    return true;
  }

  const rows = await db
    .update(uploads)
    .set(patch)
    .where(
      and(
        eq(uploads.id, media.id),
        or(isNull(uploads.maxViews), lt(uploads.views, uploads.maxViews)),
      ),
    )
    .returning({ id: uploads.id });

  return rows.length > 0;
}

/**
 * Caching policy. Anything non-public must not land in a shared cache: an
 * unlisted, password-gated, expiring or view-capped file served with
 * `public, immutable` would keep being handed out by the CDN/proxy long after
 * the gate closed.
 */
export function cacheHeadersFor(media: MediaRow): Record<string, string> {
  const restricted =
    !media.published || !!media.passwordHash || !!media.expiresAt || media.maxViews != null;
  if (restricted) return { "Cache-Control": "private, no-store", Vary: "Cookie" };

  // A validator, always. The checksum changes with the bytes, so a cache that
  // holds an old copy can find out cheaply that it is stale.
  const headers: Record<string, string> = {};
  if (media.checksum) headers.ETag = `"${media.checksum}"`;

  // `immutable` is a promise that these bytes will never change at this URL, and
  // in-place conversion is the one thing in this app that breaks it: the code
  // stays, the extension in the URL is decorative, so /{tag}/{code} serves
  // different bytes afterwards. Every browser and proxy that had already fetched
  // it would keep the old file for the rest of the year.
  //
  // So the promise is only made for a file that has never been converted. Once
  // one has, it revalidates - a conditional request per view, which is a
  // rounding error next to serving the wrong file.
  headers["Cache-Control"] = media.convertedAt
    ? "public, max-age=300, must-revalidate"
    : "public, max-age=31536000, immutable";
  return headers;
}

interface Range {
  start: number;
  end: number;
}

function parseRange(header: string | null | undefined, size: number): Range | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    // suffix: last N bytes
    const suffix = Number(m[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isFinite(start) || start > end || start < 0) return null;
  return { start, end };
}

export interface StreamOpts {
  rangeHeader?: string | null;
  /** Force a download even for types that would be safe to show inline. */
  download?: boolean;
}

/** Build a streaming Response for a media file, with HTTP Range / 206 support. */
export async function streamMedia(media: MediaRow, opts: StreamOpts = {}): Promise<Response> {
  const storage = getStorage();
  const stat = await storage.stat(media.storageKey);
  if (!stat) return new Response("Not found", { status: 404 });
  const size = stat.size;

  // The type we advertise is decided by the allowlist, never by the uploader's
  // MIME — combined with nosniff, that is what keeps an uploaded .html or .svg
  // from running script on our origin.
  // The extension is passed too: plenty of uploads arrive as
  // application/octet-stream (ShareX, curl, some phones) or carry whatever an
  // older host guessed, and for those the name on disk is the better clue.
  const decided = serveDecision(media.mimeType, media.ext);
  const disposition = opts.download ? "attachment" : decided.disposition;

  const headers: Record<string, string> = {
    "Content-Type": decided.contentType,
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(media.filename)}`,
    ...cacheHeadersFor(media),
  };

  const range = parseRange(opts.rangeHeader, size);
  if (range) {
    const stream = await storage.readStream(media.storageKey, range);
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(range.end - range.start + 1),
      },
    });
  }

  const stream = await storage.readStream(media.storageKey);
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    status: 200,
    headers: { ...headers, "Accept-Ranges": "bytes", "Content-Length": String(size) },
  });
}
