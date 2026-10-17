import { eq } from "drizzle-orm";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { shortLinks } from "@/lib/db/schema";
import { resolveApiCaller, type ApiCaller } from "@/lib/api-caller";
import { cacheHeadersFor, getMedia, type MediaLookup } from "@/lib/media/serve";
import { resolveTaglessOwnerTag } from "@/lib/data/user-prefs";
import { effectiveType, mediaKind, serveDecision } from "@/lib/media/mime";
// The ceiling the preview page actually applies, imported rather than mirrored.
// A copy of it lived here with a comment pointing at the file it was copied
// from; the number and the comment both went stale the moment the constant
// moved, and this endpoint exists to PREDICT what the page will do.
import { MAX_INLINE_TEXT } from "@/lib/media/source-preview";
import { convertTargetsFor } from "@/lib/media/convert-targets";
import { avTargetsFor } from "@/lib/media/av-targets";
import { MAX_TRANSFORM_BYTES } from "@/lib/media/transform-cost";
import { AV_MAX_INPUT_BYTES } from "@/lib/media/av-cost";
// The predicate the serving route and `GET /api/uploads` both answer from,
// imported rather than restated. Whether a row can produce a moving tile is one
// question with one answer, and a second spelling of it here is a second thing
// to forget when the ceilings move.
import {
  canMotionPreview,
  clampMotionEdge,
  MOTION_PARAM,
} from "@/lib/media/motion-preview";
import { humanFileSize } from "@/lib/format";
import { downloadUrl, publicUrl, rawUrl, userBaseUrl } from "@/lib/media/urls";
import { splitShortCode } from "@/lib/naming";
import {
  parseLinkUrl,
  type LinkTarget,
  type MediaRef,
  type ParseRefusal,
} from "@/lib/link-info/parse";

/**
 * GET /api/link-info?url=<any Modlight URL> - what is behind this link, in JSON.
 *
 * The failure it exists for: something is handed a link, fetches it, receives
 * 156 kB of HTML because /{tag}/{code}.png is a PAGE and the extension on it is
 * decorative, and concludes the link is broken. Every fact it wanted was already
 * in the database row. One request now answers "a 428x147 PNG of 9.7 KB, bytes
 * at .../raw.png, safe to fetch anonymously" without touching a single byte of
 * the file.
 *
 * Three rules shape everything below.
 *
 * 1. IT CONSUMES NOTHING. No view counted, no download counted, no one-time link
 *    burned, no unlock cookie read or issued. `getMedia` is a pure read and is
 *    used; `consumeView`, `isMediaUnlocked`, `admit`, `streamMedia`,
 *    `redirectShortLink` (it counts clicks) and `isPrivilegedViewer` (it reads
 *    the cookie jar) are all deliberately NOT called. A describer with a side
 *    effect is worse than no describer: it would spend the very links it was
 *    asked to describe, and a model exploring a page would burn its content.
 *
 * 2. IT IS NOT AN ORACLE. The rule is parity, and it is exact: an anonymous
 *    caller learns nothing here that `HEAD /{tag}/{code}/raw` plus the preview
 *    page's own meta tags would not already have told them. So a public file
 *    gives up its filename, type, size, dimensions and checksum - all of which
 *    are already a Content-Disposition, a Content-Type, a Content-Length,
 *    og:image:width/height and an ETag. A password-gated file gives up only that
 *    it is gated, which its own preview page announces with a visible form and
 *    /raw announces with 401. Missing, expired, spent, trashed, orphaned and
 *    unpublished all answer with the SAME 404 body, because `getMedia` already
 *    refuses to distinguish them and this must not become the one surface that
 *    does. A caller who authenticates (API token, or the session cookie, exactly
 *    like /api/uploads and /api/me) gets the owner's own view of their own row.
 *
 * 3. IT ANSWERS FROM THE ROW. Two SELECTs, no storage driver, no sharp, no
 *    ffmpeg. Round 8 backfilled dimensions for 8052 images, so width and height
 *    are usually right there; reading bytes to answer a metadata question would
 *    make the cheap call expensive exactly when it is called in a loop.
 */

export const dynamic = "force-dynamic";

/** Thumbnail size the panel's own grid uses, and one the raw route snaps to. */
const THUMB_PX = 480;

/**
 * Tile edge advertised for a MOVING preview.
 *
 * The still size put through the clamp the serving route applies to `motion=1`,
 * rather than the still size itself: a moving tile is offered up to
 * MOTION_CAPTURE_WIDTH and no further, so naming a larger edge here would
 * advertise a size the route silently reduces - two spellings of one request,
 * two cache entries, and a tile that changes size when a client swaps the still
 * for the moving one on hover. Today both numbers are 480 and the clamp is a
 * no-op, which is exactly when a guard like this is cheap to add.
 */
const MOTION_PX = clampMotionEdge(THUMB_PX) ?? THUMB_PX;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // The answer depends on the caller's credential, so it must never land in
      // a shared cache: an owner's full row served from a proxy to the next
      // anonymous caller is the whole leak this endpoint is written to avoid.
      "cache-control": "private, no-store",
      vary: "Authorization, Cookie",
    },
  });
}

const HTTP_FOR_REFUSAL: Record<ParseRefusal | "not-found", number> = {
  "missing-url": 400,
  unparseable: 400,
  "foreign-host": 400,
  "unsupported-shape": 400,
  "capability-url": 400,
  "not-found": 404,
};

function refusal(reason: ParseRefusal | "not-found", message: string, input?: string): Response {
  return json({ ok: false, reason, message, ...(input ? { input } : {}) }, HTTP_FOR_REFUSAL[reason]);
}

/**
 * The single answer for "there is no file here".
 *
 * Deliberately identical for a code that never existed, one that expired, one
 * whose view budget is spent, one in the trash, one whose account was deleted,
 * one addressed with the wrong tag, and an unpublished file asked about by a
 * stranger. `getMedia` already collapses the first six; adding the seventh keeps
 * this endpoint from becoming the one place where "does this exist" can be asked
 * separately from "may I have it".
 */
function notFound(input: string): Response {
  return refusal(
    "not-found",
    "No file answers that link, or it is not available to you. It may never have existed, or it may be unlisted, expired or spent.",
    input,
  );
}

export async function GET(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const input = params.get("url");

  if (input == null || input.trim() === "") return json(usage(), 400);

  const parsed = parseLinkUrl(input);
  if (!parsed.ok) return refusal(parsed.reason, parsed.message, input);

  // Token first, session second, and a present-but-wrong token is a refusal
  // rather than a fall-through to whatever cookie the request carried. That is
  // `resolveApiCaller`'s contract and the reason it is shared: a second copy of
  // that rule is a second chance to write it the obvious, wrong way.
  //
  // SCOPE: `read`. A token that cannot read the library describes links as a
  // stranger would - degraded to anonymous rather than refused outright,
  // because this endpoint has an anonymous mode by design and always has: an
  // invalid token has always meant "you get the public answer" here, and
  // turning that into a 403 would change what a public URL does.
  const auth = await resolveApiCaller(req, "read");
  const caller = auth.ok ? auth.caller : null;

  const described = await describe(parsed.target, caller, input, parsed.warnings, 0);
  return described;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function describe(
  target: LinkTarget,
  caller: ApiCaller | null,
  input: string,
  warnings: string[],
  depth: number,
): Promise<Response> {
  switch (target.kind) {
    case "media":
      return describeMedia(target.primary, target.fallback, caller, input, warnings);
    case "shortlink":
      return describeShortLink(target, caller, input, warnings, depth);
    case "folder-gallery":
      return json({
        ok: true,
        kind: "folder-gallery",
        status: "unchecked",
        input,
        warnings,
        gallery: { tag: target.tag, slug: target.slug },
        links: {
          page: `${config.appUrl}/a/${target.tag}/${target.slug}`,
          zip: `${config.appUrl}/a/${target.tag}/${target.slug}/zip`,
        },
        notes: [
          "A shared folder gallery. Its files are ordinary uploads, so each tile on the page has its own link this endpoint can describe.",
          "Whether the folder exists and is published was not checked, because that answer belongs to the page itself and probing it here would make this a folder oracle.",
          "The zip link streams the whole folder. It has no size limit, so check the page first.",
        ],
      });
    case "user-gallery":
      return json({
        ok: true,
        kind: "user-gallery",
        status: "unchecked",
        input,
        warnings,
        gallery: { tag: target.tag },
        links: { page: `${config.appUrl}/u/${target.tag}` },
        notes: [
          "A public profile gallery. It answers 404 unless the account turned public profiles on, and it lists at most 200 published files.",
          "Whether this account exists was not checked here.",
        ],
      });
    case "app-route":
      return json({
        ok: true,
        kind: "app-route",
        status: "unchecked",
        input,
        warnings,
        route: { path: target.path, label: target.label },
        notes: [
          `That URL is ${target.label}. There is no upload behind it, so there is nothing to describe from the database.`,
        ],
      });
  }
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

/**
 * Resolve one reading of a URL to a row, honouring the tagless form.
 *
 * Pure reads throughout: a SELECT on uploads, a SELECT on user, and for the
 * tagless form one more SELECT to find out whether the owner opted into it.
 */
async function lookup(ref: MediaRef): Promise<MediaLookup | null> {
  if (ref.tag) return getMedia(ref.tag, ref.code);
  const tag = await resolveTaglessOwnerTag(ref.code);
  return tag ? getMedia(tag, ref.code) : null;
}

async function describeMedia(
  primary: MediaRef,
  fallback: MediaRef | undefined,
  caller: ApiCaller | null,
  input: string,
  warnings: string[],
): Promise<Response> {
  // Tagged reading first, tagless second - the order the app itself resolves in,
  // so a file whose code happens to be "raw" is described the way it is served.
  let ref = primary;
  let found = await lookup(primary);
  if (!found && fallback) {
    const alt = await lookup(fallback);
    if (alt) {
      ref = fallback;
      found = alt;
      warnings.push(
        "Read as a tagless action URL, not as /{tag}/{code}. Note that the redirect the app issues for this shape drops the query string, so a resize or a conversion target sent to it is lost. Use the tagged form to keep query parameters.",
      );
    }
  }
  if (!found) return notFound(input);

  const { media, ownerUserCode, ownerId, ownerPreferredDomain } = found;
  const privileged = !!caller && (caller.id === ownerId || caller.role === "admin");

  // An unpublished file is its owner's business. A stranger gets the same answer
  // as for a code that was never minted.
  if (!media.published && !privileged) return notFound(input);

  const base = userBaseUrl(ownerPreferredDomain);
  const status = !media.published ? "unlisted" : media.passwordHash ? "password-required" : "public";

  /**
   * A gated file gives up its EXTENSION too, and that is not pedantry: the
   * preview page's own metadata for a protected file emits no canonical, no
   * og:title and no description precisely so the name cannot leak, and
   * "raport-finansowy.xlsx" often says everything the contents would. So the
   * URLs handed back for a gated file are built with an empty extension. They
   * work identically, because the extension in a Modlight URL is decorative.
   */
  const gated = status === "password-required" && !privileged;
  const ext = gated ? "" : media.ext;
  const page = publicUrl(ownerUserCode, media.code, ext, base);
  const raw = rawUrl(ownerUserCode, media.code, ext, base);

  if (gated) {
    return json({
      ok: true,
      kind: "media",
      status,
      privileged: false,
      input,
      warnings,
      normalizedUrl: page,
      requestShape: ref.shape,
      file: null,
      links: { page },
      bytes: { url: raw, anonymous: false },
      notes: [
        "This file is password protected. Nothing about it is described here - not its name, type, size or dimensions - because its own preview page withholds all of that as well.",
        "The preview page answers 200 with a password form. The raw and download URLs answer 401 until the form is cleared in a browser.",
        "Sign in as the owner (API token or session) to see the full description.",
      ],
    });
  }

  const type = effectiveType(media.mimeType, media.ext);
  const decision = serveDecision(media.mimeType, media.ext);
  const kind = mediaKind(media.mimeType, media.ext);

  /**
   * The checksum is published in exactly the cases the serving layer already
   * publishes it, and the parity is enforced by reading it back out of
   * `cacheHeadersFor` rather than by re-deriving the condition. A restricted
   * file (unlisted, gated, expiring or view-capped) gets `private, no-store` and
   * no ETag there, so it gets no checksum here either.
   */
  const serveHeaders = cacheHeadersFor(media);
  const publicBytes = !serveHeaders["Cache-Control"].startsWith("private");
  const etag = serveHeaders.ETag ?? null;

  const isText =
    media.kind === "paste" || kind === "text" || media.mimeType.startsWith("text/");

  const notes: string[] = [
    "The extension in a Modlight URL is decorative: the lookup key is the code alone, so the same row answers with any extension or with none.",
  ];
  if (ref.shape === "preview") {
    notes.push(
      "The URL you asked about is the preview PAGE and returns HTML. The bytes are at the raw URL below.",
    );
  }
  if (!publicBytes) {
    notes.push(
      "The serving layer marks this link private and no-store, which means it carries at least one restriction: it may be time limited or view limited. Fetching the bytes may consume it. Which restriction applies is not disclosed to an anonymous caller.",
    );
  }

  const thumbnail = thumbUrlFor(kind, media.size, raw);
  const motionThumbnail = motionThumbUrlFor(media, raw);
  if (motionThumbnail) {
    notes.push(
      "This file moves, so a moving tile is offered as well: motionThumbnail is an animated WebP of frames sampled across the whole file, not a clip of its opening seconds. Like the still thumbnail it is a preview, so fetching it spends no view and burns no one-time link.",
    );
  }

  return json({
    ok: true,
    kind: "media",
    status,
    privileged,
    input,
    warnings,
    normalizedUrl: page,
    requestShape: ref.shape,
    /** How the URL was read, so a caller can tell an ambiguity was resolved. */
    resolvedAs: { tag: ownerUserCode, code: media.code, tagless: ref.tag === null },
    file: {
      filename: media.filename,
      ext: media.ext,
      /** What we believe the file IS (sniffed at upload, refined by extension). */
      type,
      /** What /raw actually puts on the wire. Differs for SVG and HTML, which
       *  are forced to text/plain so an upload cannot script our origin. */
      servedType: decision.contentType,
      kind,
      size: media.size,
      sizeHuman: humanFileSize(media.size),
      width: media.width,
      height: media.height,
      checksum: etag ? etag.replace(/"/g, "") : privileged ? media.checksum : null,
      isPaste: media.kind === "paste",
    },
    links: {
      page,
      raw,
      download: downloadUrl(ownerUserCode, media.code, base),
      thumbnail,
      /**
       * A tile that MOVES, or null when this row cannot produce one.
       *
       * Null is the point of the field, exactly as it is for `thumbnail`: the
       * serving route answers `motion=1` for a still image with a refusal, and a
       * client that trusted an optimistic URL would fall back to fetching the
       * file itself to draw one - and on this path the file is a video.
       */
      motionThumbnail,
      oembed: `${base}/oembed?url=${encodeURIComponent(page)}&format=json`,
    },
    bytes: {
      url: raw,
      size: media.size,
      sizeHuman: humanFileSize(media.size),
      contentType: decision.contentType,
      disposition: decision.disposition,
      rangeSupported: true,
      /** True when a caller with no credential can fetch the bytes right now. */
      anonymous: media.published && !media.passwordHash,
      /** False when the serving layer refuses to let a shared cache keep them. */
      cacheable: publicBytes,
      etag,
    },
    text: isText
      ? {
          language: media.language,
          /** Fetch this for the content. It is served as text, not as HTML. */
          url: raw,
          inlineLimitBytes: MAX_INLINE_TEXT,
          /** Whether the preview page will render the content inline. */
          renderedInline: media.size <= MAX_INLINE_TEXT,
        }
      : null,
    convert: convertPlan(media, base, ownerUserCode),
    ...(privileged ? { owner: ownerBlock(found) } : {}),
    notes,
  });
}

/**
 * Would `/{tag}/{code}/raw?w=` actually return a thumbnail for this row?
 *
 * The same conditions the serving route applies, because outside them that URL
 * streams the ORIGINAL: a caller that trusted an optimistic thumbnail URL would
 * download a 700 MB recording to draw a tile. The ceilings differ by kind on
 * purpose - an image is fully read and decoded, a video poster is a seek.
 */
function thumbUrlFor(kind: string, size: number, raw: string): string | null {
  const fits =
    kind === "video" ? size <= AV_MAX_INPUT_BYTES : kind === "image" && size <= MAX_TRANSFORM_BYTES;
  // The w/h are load-bearing, not cosmetic: the serving layer treats a resize
  // parameter as proof this is a preview rather than a read, so drawing a tile
  // never spends a view or burns a one-time link.
  return fits ? `${raw}?w=${THUMB_PX}&h=${THUMB_PX}` : null;
}

/**
 * Would `/{tag}/{code}/raw?motion=1` actually return a tile that moves?
 *
 * The predicate is `canMotionPreview`, unmodified and not re-stated: it is what
 * the serving route is bounded by and what `GET /api/uploads` publishes
 * `motionThumbUrl` from, so the same row gets the same answer from all three.
 * It reads mime, extension, size and the recorded frame count and nothing else,
 * which keeps this endpoint's third rule intact - the answer comes from the row,
 * no byte is opened to find it.
 *
 * A row whose frame count was never recorded is refused rather than guessed at,
 * which on the imported library is most of it. That is the honest answer: the
 * still thumbnail still works, and drawing one teaches the row about itself
 * (renderThumbnail records `frames` while the file is open), so the moving tile
 * appears here on a later call without any backfill.
 */
function motionThumbUrlFor(media: MediaLookup["media"], raw: string): string | null {
  if (!canMotionPreview(media)) return null;
  // w/h alongside the flag for the same reason the still tile carries them: the
  // serving layer reads a size parameter as proof this is a preview rather than
  // a read. `motion=1` is exempt on its own, but a URL that says what it wants
  // cannot be broken by a change to which parameters count as a preview.
  return `${raw}?w=${MOTION_PX}&h=${MOTION_PX}&${MOTION_PARAM}=1`;
}

/**
 * What "Download as" would offer for this file, from the row alone.
 *
 * Until now this list lived only in a TypeScript module the panel imports, so a
 * client that is not TypeScript had to probe every candidate target with its own
 * request to build one menu. Both functions here are pure and read nothing but
 * mime, extension and frame count, so the whole menu costs nothing.
 *
 * These are CANDIDATES. The route still applies runtime gates a row cannot
 * answer - the pixel budget, the codec inside the container, the concurrency
 * limiter - so a caller that needs certainty asks with `&check=1`, which runs
 * every gate and returns 204 or the refusal, without doing the work.
 */
function convertPlan(
  media: MediaLookup["media"],
  base: string,
  tag: string,
): {
  urlTemplate: string;
  dryRunTemplate: string;
  targets: { to: string; requiresOwner: boolean; motion: string | null; yields?: string }[];
} {
  const image = convertTargetsFor(media.mimeType, media.ext, media.frames).map((o) => ({
    to: o.to,
    // Image conversions are open to anyone; only ffmpeg re-encodes are gated.
    requiresOwner: false,
    motion: o.motion,
  }));
  const av = avTargetsFor(media.mimeType, media.ext, media.frames, media).map((o) => ({
    to: o.to,
    // A re-encode costs seconds of CPU on a public endpoint, so the serving
    // layer allows it only for the signed-in owner. A container copy is public.
    requiresOwner: o.cost === "encode",
    motion: null,
    yields: o.yields,
  }));

  const convertBase = `${base}/${tag}/${media.code}/convert`;
  return {
    urlTemplate: `${convertBase}?to={target}`,
    dryRunTemplate: `${convertBase}?to={target}&check=1`,
    targets: [...image, ...av],
  };
}

/** The owner's own view of their own row. Never sent to anyone else. */
function ownerBlock(found: MediaLookup) {
  const { media } = found;
  return {
    /** The id `/api/uploads` PATCH and DELETE take. */
    id: media.id,
    ownerId: found.ownerId,
    ownerTag: found.ownerUserCode,
    published: media.published,
    createdAt: media.createdAt,
    updatedAt: media.updatedAt,
    views: media.views,
    downloads: media.downloads,
    lastAccessedAt: media.lastAccessedAt,
    expiresAt: media.expiresAt,
    maxViews: media.maxViews,
    hasPassword: !!media.passwordHash,
    /** Non-null means the file carries the account default rather than its own. */
    passwordVersion: media.passwordVersion,
    folderId: media.folderId,
    checksum: media.checksum,
    blurhash: media.blurhash,
    frames: media.frames,
    convertedAt: media.convertedAt,
    originalExt: media.originalExt,
    // Deliberately absent: uploads.delete_token and uploads.storage_key. The
    // first is a live capability that destroys the file with one POST and has no
    // business in a metadata response; the second is an internal path a client
    // has no way to use.
  };
}

// ---------------------------------------------------------------------------
// Short links
// ---------------------------------------------------------------------------

/**
 * Resolve a short link WITHOUT following it.
 *
 * `redirectShortLink` is not called and cannot be: it increments `clicks` and
 * stamps `last_used_at` as a side effect of answering, so describing a link with
 * it would inflate the owner's own statistics every time. This does its own
 * SELECT instead, which is the same lookup minus the write.
 */
async function describeShortLink(
  target: Extract<LinkTarget, { kind: "shortlink" }>,
  caller: ApiCaller | null,
  input: string,
  warnings: string[],
  depth: number,
): Promise<Response> {
  const rows = await db
    .select()
    .from(shortLinks)
    .where(eq(shortLinks.code, target.stored))
    .limit(1);
  const link = rows[0];
  if (!link) return notFound(input);

  const owned = !!caller && (caller.id === link.ownerId || caller.role === "admin");
  const { tag, code } = splitShortCode(link.code);
  const shared = {
    ok: true as const,
    kind: "shortlink" as const,
    privileged: owned,
    input,
    warnings,
    shortlink: { code, tag, stored: link.code },
    links: {
      canonical: `${config.shortUrl}/s/${link.code}`,
      onShortDomain: `${config.shortUrl}/${link.code}`,
    },
    ...(owned
      ? {
          owner: {
            id: link.id,
            ownerId: link.ownerId,
            clicks: link.clicks,
            lastUsedAt: link.lastUsedAt,
            createdAt: link.createdAt,
            expiresAt: link.expiresAt,
            hasPassword: !!link.passwordHash,
            target: link.target,
          },
        }
      : {}),
  };

  // Expiry IS publicly distinguishable already: the redirect route answers 410
  // with "This link has expired" rather than 404, so saying so here reveals
  // nothing new and saves a caller from concluding the link never existed.
  if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) {
    return json({
      ...shared,
      status: "expired",
      target: null,
      notes: ["This short link has expired. Following it returns 410."],
    });
  }

  if (link.passwordHash) {
    return json({
      ...shared,
      status: "password-required",
      target: owned ? link.target : null,
      links: { ...shared.links, unlock: `${config.appUrl}/s/${link.code}/unlock` },
      notes: [
        "This short link is password protected. Following it redirects to an unlock page instead of to its destination.",
        "The destination is withheld, because handing it over would be exactly the redirect the password was set to prevent.",
      ],
    });
  }

  const body = {
    ...shared,
    status: "public",
    target: link.target,
    notes: [
      "Following this link returns 302 to the target and counts one click. This description counted none.",
    ],
  };

  /**
   * One hop, and one only. A short link that points at a file on this same
   * deployment is the common case, and answering "it redirects to
   * https://h.example.com/alicja/romuz3.png" is only half an answer - the caller then
   * has to ask again about a page that returns HTML. Depth is capped at one so a
   * chain of short links pointing at each other cannot turn one request into a
   * walk.
   */
  if (depth === 0) {
    const inner = parseLinkUrl(link.target);
    if (inner.ok && inner.target.kind === "media") {
      const described = await describe(inner.target, caller, link.target, [], depth + 1);
      const parsedBody = await described.json().catch(() => null);
      return json({ ...body, targetInfo: parsedBody });
    }
  }

  return json(body);
}

// ---------------------------------------------------------------------------
// Self description
// ---------------------------------------------------------------------------

/**
 * Answer for a call with no `url`.
 *
 * A refusal that explains the endpoint is worth more than one that repeats its
 * own name, and this is the one response a caller reaches by guessing the path,
 * which is how it will usually be found: nothing in the deployment publishes an
 * API index (there is no robots.txt, no openapi.json and no /api listing), so
 * the preview page's `<link rel="alternate" type="application/json">` and this
 * paragraph are the whole discovery surface.
 */
function usage() {
  return {
    ok: false,
    reason: "missing-url" as const,
    message: "Pass the URL to describe as the `url` query parameter.",
    endpoint: {
      method: "GET",
      path: "/api/link-info",
      parameters: { url: "Any URL served by this deployment, absolute or as a bare path." },
      example: `${config.appUrl}/api/link-info?url=${encodeURIComponent(`${config.appUrl}/tag/code.png`)}`,
      auth: "Optional. An API token (Authorization: Bearer, or X-API-Key) or a session cookie adds the owner's own fields for their own files.",
    },
    describes: [
      "/{tag}/{code}[.ext] and /{code}[.ext] - the preview page",
      "/{tag}/{code}/raw[.ext], /download, /convert, /render - the file itself",
      "/s/{code} and /s/{tag}/{name} - short links, resolved without counting a click",
      "/a/{tag}/{slug} and /u/{tag} - shared galleries",
    ],
    guarantees: [
      "Never counts a view or a download, never burns a one-time link, never follows a short link.",
      "Answers from the database row. It never reads the file.",
      "Tells an anonymous caller nothing that a HEAD on the raw URL would not.",
    ],
    knownOrigins: config.appDomains,
  };
}
