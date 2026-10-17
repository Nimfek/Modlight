import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getOwnerPasswordVersion, resolveTaglessOwnerTag } from "@/lib/data/user-prefs";
import { config } from "@/lib/config";
import { consumeView, getMedia, viewerRelation, codeFromMediaCode } from "@/lib/media/serve";
import { isMediaUnlocked } from "@/lib/password";
import {
  publicUrl,
  rawUrl,
  downloadUrl,
  userBaseUrl,
  renderPath,
  mediaActionPath,
} from "@/lib/media/urls";
import { mediaKind } from "@/lib/media/mime";
import { diagnosePlayback } from "@/lib/media/playback-health";
import { toFileItems } from "@/lib/data/uploads";
import { inlineTextPlan, showsSource } from "@/lib/media/source-preview";
import { isDirectMediaBot, isPreviewBot } from "@/lib/media/bots";
import { buildEmbedPlan, embedMetadata } from "@/lib/media/embed";
import { canRenderInline, mintRenderTicket } from "@/lib/media/render-ticket";
import { canTimelinePreview, TIMELINE_TRACK_ACTION } from "@/lib/media/timeline-preview";
import { getStorage } from "@/lib/storage";
import { db } from "@/lib/db";
import { user as users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { MediaViewer } from "@/components/viewer/MediaViewer";
import { EncryptedViewer } from "@/components/viewer/EncryptedViewer";
import { PasswordGate } from "@/components/viewer/PasswordGate";
import { ThemeApplier } from "@/components/theme-applier";
import { isEncryptedUpload } from "@/lib/crypto/envelope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageParams = {
  params: Promise<{ userCode: string; mediaCode: string }>;
  // Needed only to carry the query string across the tagless redirect below.
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

// ---------------------------------------------------------------------------
// Link unfurling
// ---------------------------------------------------------------------------

/** Discord (and friends) stop proxying media somewhere around this size. */
const EMBED_PROXY_LIMIT = 8 * 1024 * 1024;

/** Kinds a bare URL embeds as media rather than as a download link. */
const DIRECT_MEDIA_KINDS = new Set(["image", "video", "audio"]);

/**
 * Width asked of the still shown before a video plays.
 *
 * One of the sizes /raw will render (THUMB_SIZES in the action route), large
 * enough to fill the stage on a laptop and small enough to be a placeholder
 * rather than a download: the frame itself is captured once at 1280 and cached,
 * so this only decides how much of it travels. Asking for a size off that list
 * would be rounded up anyway, and the poster is replaced by the first decoded
 * frame the moment playback starts.
 */
const POSTER_WIDTH = 800;

// ---------------------------------------------------------------------------
// Open Graph / Twitter / oEmbed metadata — so Discord/Twitter/Telegram embed.
// ---------------------------------------------------------------------------
export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { userCode, mediaCode } = await params;
  const found = await getMedia(userCode, mediaCode);
  if (!found) return { title: "Not found" };

  const { media, ownerUserCode, ownerPreferredDomain } = found;

  // Canonical/OG URLs use the OWNER's hostname, so an unfurled link matches the
  // domain they hand out everywhere else. Every configured name serves the file
  // either way — this only decides what the card says. The brand does NOT follow
  // the hostname (config.embedBrand is derived from APP_URL), so the same file
  // signs itself identically whoever shared it and on whichever domain.
  const ownerBase = userBaseUrl(ownerPreferredDomain);
  const page = publicUrl(ownerUserCode, media.code, media.ext, ownerBase);
  const raw = rawUrl(ownerUserCode, media.code, media.ext, ownerBase);

  // A paste (or any small text file) is the one kind whose description can carry
  // something better than metadata: the opening of the text itself. Skipped for
  // files that get no card anyway, so a protected upload is never even read.
  const hidden = !!media.passwordHash || !media.published;
  const snippet =
    !hidden && shouldPreviewText(media) ? await readSnippet(media.storageKey, media.size) : null;

  return embedMetadata(
    buildEmbedPlan(
      {
        filename: media.filename,
        ext: media.ext,
        mimeType: media.mimeType,
        size: media.size,
        width: media.width,
        height: media.height,
        kind: media.kind,
        published: media.published,
        hasPassword: !!media.passwordHash,
        // A capped link must not be advertised with a picture: the unfurler
        // both spends one of its views and keeps a public copy forever.
        hasViewCap: media.maxViews != null,
      },
      {
        brand: config.embedBrand,
        appName: config.appName,
        page,
        raw,
        // oEmbed discovery — rich unfurlers fetch this for a proper embed card.
        // Emits <link rel="alternate" type="application/json+oembed" href=…>.
        oembedHref: `${ownerBase}/oembed?url=${encodeURIComponent(page)}&format=json`,
        // Machine-readable description of this file, for a reader that is not an
        // unfurler. This page is HTML at a URL that ends in .png, which is the
        // single most misleading thing the deployment serves; the link says
        // where the answer actually is. It consumes nothing when fetched.
        linkInfoHref: `${ownerBase}/api/link-info?url=${encodeURIComponent(page)}`,
        // Type cards come off the owner's hostname too, so the card and its
        // picture agree about which site this link belongs to.
        cardOrigin: ownerBase,
        snippet,
      },
    ),
  );
}

/** Is this file worth spending a small read on for the card's description? */
function shouldPreviewText(media: {
  kind: string;
  mimeType: string;
  ext: string;
  language?: string | null;
  size: number;
}): boolean {
  return showsSource(media) && media.size > 0;
}

/** First few kilobytes of a file, for the embed description. Never throws. */
async function readSnippet(storageKey: string, size: number): Promise<string | null> {
  const MAX = 8 * 1024;
  try {
    const storage = getStorage();
    if (size <= MAX) return (await storage.readBuffer(storageKey)).toString("utf8");
    const stream = await storage.readStream(storageKey, { start: 0, end: MAX - 1 });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
/**
 * Second segments that mean "an action on a file", not "a file".
 *
 * `/{code}/raw` is indistinguishable from `/{tag}/{code}` by shape alone, so
 * order decides: the tagged reading is tried first and always wins, which keeps
 * every link shared so far resolving exactly as before.
 */
const MEDIA_ACTIONS = /^(raw(\.[a-z0-9]+)?|download|convert|timeline\.(vtt|jpg))$/i;

/**
 * Recover a tagless media action: /{code}/raw -> /{ownerTag}/{code}/raw.
 *
 * Returns the canonical path to redirect to, or null when the first segment is
 * not a tagless code belonging to an owner who opted into tagless links.
 *
 * The QUERY STRING has to travel with it. Dropping it was silent and expensive:
 * `/{code}/raw.png?w=64` is exactly the shape a client uses to draw a grid of
 * tiles, and losing `w` turns each tile into the full original. Measured on
 * production before the fix: the tagged URL answered 312 bytes and the tagless
 * one 9901 - the whole file - for the same picture, with no error anywhere. The
 * same drop disabled `motion=1`, so an animated preview quietly became a still.
 */
async function taglessActionRedirect(
  first: string,
  second: string,
  query: Record<string, string | string[] | undefined> = {},
): Promise<string | null> {
  if (!MEDIA_ACTIONS.test(second)) return null;
  const code = codeFromMediaCode(first);
  const ownerTag = await resolveTaglessOwnerTag(code);
  if (!ownerTag) return null;

  // Rebuilt from the parsed params rather than passed through as a raw string,
  // so nothing a caller appended can steer the redirect target itself.
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) for (const v of value) qs.append(key, v);
    else if (value !== undefined) qs.append(key, value);
  }
  const suffix = qs.size > 0 ? `?${qs}` : "";
  return `/${ownerTag}/${code}/${second}${suffix}`;
}

export default async function MediaPage({ params, searchParams }: PageParams) {
  const { userCode, mediaCode } = await params;
  const found = await getMedia(userCode, mediaCode);
  if (!found) {
    // Might be a tagless action (/{code}/raw) rather than a missing file.
    const query = searchParams ? await searchParams : {};
    const canonical = await taglessActionRedirect(userCode, mediaCode, query);
    if (canonical) redirect(canonical);
    notFound();
  }

  const { media, ownerUserCode, ownerId, ownerTheme, ownerBackground, ownerPreferredDomain } = found;

  // Access control: unpublished media is visible only to owner/admin, who are
  // also exempt from the view counter and the burn-after-view budget.
  const { privileged, isOwner } = await viewerRelation(ownerId);
  if (!media.published && !privileged) notFound();

  const ownerBase = userBaseUrl(ownerPreferredDomain);
  const page = publicUrl(ownerUserCode, media.code, media.ext, ownerBase);
  const raw = rawUrl(ownerUserCode, media.code, media.ext, ownerBase);
  const dl = downloadUrl(ownerUserCode, media.code, ownerBase);

  const requestHeaders = await headers();
  const ua = requestHeaders.get("user-agent") ?? "";
  const isBot = isPreviewBot(ua);

  // Send the media-capable unfurlers to the bytes themselves, so a pasted link
  // becomes the picture/video instead of a card about the picture. Deliberately
  // never for protected, unlisted or one-shot links: those must not be handed
  // out to a crawler, and a preview fetch must not consume a view budget.
  if (
    isBot &&
    isDirectMediaBot(ua) &&
    media.published &&
    !media.passwordHash &&
    media.maxViews == null &&
    DIRECT_MEDIA_KINDS.has(mediaKind(media.mimeType, media.ext))
  ) {
    // Oversized stills would silently fail to proxy, so those get a 1200px
    // WebP render (uncropped) rather than nothing at all. Video/audio always go
    // to the original — the raw route speaks Range, which is what a player needs.
    const tooBigToProxy =
      mediaKind(media.mimeType, media.ext) === "image" && media.size > EMBED_PROXY_LIMIT;
    redirect(tooBigToProxy ? `${raw}?w=1200&fit=inside` : raw);
  }

  // Password gate: render the unlock form unless a valid signed unlock token is
  // present. The cookie is client-controlled, so only its signature counts.
  //
  // Two tokens can open the door — one minted for this file, and one minted for
  // the owner's default password when this file carries that same generation of
  // it. See lib/password.ts.
  if (media.passwordHash && !privileged) {
    const jar = await cookies();
    const unlocked = isMediaUnlocked(
      { mediaId: media.id, ownerId, passwordVersion: media.passwordVersion },
      (name) => jar.get(name)?.value,
    );

    if (!unlocked) {
      // Only a file stamped with the owner's CURRENT default may offer "remember
      // for 30 days" — that consent travels to their other files, so it must not
      // be offered for a password that is this file's alone.
      const ownerVersion = await getOwnerPasswordVersion(ownerId);
      const onDefault = media.passwordVersion != null && media.passwordVersion === ownerVersion;

      return (
        <CenteredShell>
          <ThemeApplier theme={ownerTheme} background={ownerBackground} />
          <PasswordGate
            mediaId={media.id}
            appName={config.appName}
            onDefaultPassword={onDefault}
          />
        </CenteredShell>
      );
    }
  }

  /**
   * End-to-end encrypted upload: everything below this line happens in the
   * visitor's browser instead.
   *
   * The server has the container and nothing else - not the filename, not the
   * type, not one byte of content - so there is nothing here to render, embed,
   * thumbnail or convert. The viewer reads the key out of the URL fragment,
   * which is the one part of a URL a browser never transmits, and decrypts.
   *
   * The view is NOT counted here, and that is the whole reason this branch sits
   * above the counter rather than below it. This page on its own shows a
   * spinner; the read that means anything is the viewer's first ranged request
   * for the container header, and `/raw` counts exactly that shape of request
   * (a range starting at zero) and no other. Counting here as well would spend
   * two views per open and would 404 a burn-after-view link halfway through the
   * only reading it will ever get. The budget itself is still enforced: getMedia
   * refuses the row once `views >= maxViews`.
   */
  if (isEncryptedUpload(media.mimeType, media.ext)) {
    return (
      <Shell>
        <ThemeApplier theme={ownerTheme} background={ownerBackground} />
        <EncryptedViewer
          // Relative on purpose. The deployment answers on several hostnames and
          // the viewer fetches with the page's own origin; an absolute URL built
          // from the owner's preferred domain would be a cross-origin request
          // with no CORS to allow it.
          rawPath={rawUrl(ownerUserCode, media.code, media.ext, "")}
          cipherSize={media.size}
          createdAt={media.createdAt.toISOString()}
          views={media.views}
          downloads={media.downloads}
          appName={config.appName}
        />
      </Shell>
    );
  }

  // Owner's copyRaw preference governs which link the primary copy button yields.
  let copyRaw = false;
  try {
    const ownerRows = await db
      .select({ copyRaw: users.copyRaw })
      .from(users)
      .where(eq(users.id, ownerId))
      .limit(1);
    copyRaw = !!ownerRows[0]?.copyRaw;
  } catch {
    /* preference is non-essential */
  }

  // Count the view only once the gate has been cleared, and let the database
  // decide whether the burn-after-view budget still allows it. Crawlers are
  // excluded: an unfurl is not a reader, and letting one spend a burn-after-view
  // budget means the link dies in the chat window before anyone opens it.
  if (!privileged && !isBot && !(await consumeView(media))) notFound();

  // Source preview: anything /raw would hand over as text, plus every in-app
  // paste, is read server-side (bounded) and passed to the client as a plain
  // string. `showsSource` is the ONE definition of that, shared with the viewer,
  // so the page cannot decide to read bytes the viewer then declines to draw.
  //
  // We never inline-render markup: the content is escaped as text downstream
  // (React text children in TextView, never dangerouslySetInnerHTML), and an
  // uploaded page is only ever executed behind the explicit toggle below.
  //
  // A .docx is deliberately NOT in this set. It is renderable but it is a zip
  // archive, so reading half a megabyte of it off disk to hand the viewer as a
  // string would be waste on every document page view.
  const isText = showsSource(media);
  let textContent: string | null = null;
  // Which of the two it is travels with it: "too large" and "we could not open
  // it" are different facts, and telling a visitor a 3 kB file is too large
  // because the storage read threw is a lie the page used to tell.
  let textUnavailable: "too-large" | "unreadable" | null = null;
  if (isText) {
    if (inlineTextPlan(media.size) === "too-large") {
      textUnavailable = "too-large";
    } else {
      try {
        const buf = await getStorage().readBuffer(media.storageKey);
        textContent = buf.toString("utf8");
      } catch {
        textUnavailable = "unreadable";
      }
    }
  }

  // The ticket for the sandboxed render is minted HERE and only here, because
  // this line is reached only once every gate above has been cleared: published,
  // password, expiry and the view budget. It is short-lived and bound to this
  // one file, so it is worthless anywhere else.
  const renderHref = canRenderInline(media)
    ? renderPath(ownerUserCode, media.code, mintRenderTicket(media.id))
    : null;

  /**
   * The deployment answers on several hostnames but the session cookie belongs
   * to exactly one of them (Better Auth sets no Domain attribute, which is what
   * keeps the token off every other app on the registrable domain). So an owner
   * who opens their own file on a secondary hostname arrives anonymous, and the
   * encoder-backed entries of "Download as…" correctly disappear - which reads
   * as a bug, because from the panel they were right there.
   *
   * The panel now links to files relatively so the common case cannot happen at
   * all (components/dashboard/media.ts). This is for the link that was shared
   * earlier, or typed: one entry pointing at the same file on the hostname where
   * a session can exist. Never shown to somebody who is already privileged, and
   * never on the app's own hostname, where a missing menu really does mean the
   * viewer is a stranger.
   */
  const appHost = new URL(config.appUrl).host.toLowerCase();
  const requestHost = (requestHeaders.get("host") ?? "").toLowerCase();
  const signInUrl =
    !privileged && requestHost && requestHost !== appHost
      ? publicUrl(ownerUserCode, media.code, media.ext, config.appUrl)
      : null;

  /**
   * What the video player fetches for itself, as paths on the page's own
   * origin (see mediaActionPath for why an origin would break both).
   *
   * The track is offered on what the ROW can settle - kind and size. Duration
   * is not a column, so "long enough to be worth a timeline" is decided by the
   * endpoint after its probe, and a refusal there costs the player nothing: no
   * cues means no preview picture and a scrub bar that behaves exactly as it
   * did before the feature existed.
   *
   * The poster is offered for every video, because /raw?w= answers one with a
   * seeked frame (cached) and refuses with 415 rather than ever handing back
   * the file - and a poster that 415s leaves the browser painting the first
   * decoded frame, which is what it painted before.
   */
  const timelineTrack = canTimelinePreview(media)
    ? mediaActionPath(ownerUserCode, media.code, TIMELINE_TRACK_ACTION)
    : null;
  const posterUrl =
    mediaKind(media.mimeType, media.ext) === "video"
      ? `${mediaActionPath(ownerUserCode, media.code, "raw")}?w=${POSTER_WIDTH}`
      : null;

  /**
   * Is this video outside the shape a browser plays well, and is the person
   * reading this the one who can do something about it?
   *
   * `isOwner` rather than `privileged`: an administrator opening somebody
   * else's link cannot change how that person records, and the repair
   * rewrites a file that is not theirs. Everything the note needs comes off
   * the row already in hand, so a file with nothing wrong with it costs one
   * comparison and no query.
   */
  const playback = isOwner ? diagnosePlayback(media) : null;
  // Built from the SAME mapping the dashboard uses, so the repair dialog is
  // handed exactly the shape it is handed there. Folder names are not
  // needed: the dialog reads the file's identity, not its placement.
  const playbackRepair = playback
    ? {
        item: toFileItems([media], new Map())[0],
        userCode: ownerUserCode,
        appUrl: ownerBase,
      }
    : null;

  return (
    <Shell>
      <ThemeApplier theme={ownerTheme} background={ownerBackground} />
      <MediaViewer
        filename={media.filename}
        mimeType={media.mimeType}
        ext={media.ext}
        size={media.size}
        views={media.views}
        downloads={media.downloads}
        createdAt={media.createdAt}
        width={media.width}
        height={media.height}
        frames={media.frames}
        publicUrl={page}
        rawUrl={raw}
        downloadUrl={dl}
        copyRaw={copyRaw}
        // `privileged` is exactly the test the convert route applies, so the
        // menu shows an encoder-backed target precisely when asking for one
        // would succeed.
        canEncode={privileged}
        signInUrl={signInUrl}
        textContent={textContent}
        textUnavailable={textUnavailable}
        renderPath={renderHref}
        timelineTrack={timelineTrack}
        posterUrl={posterUrl}
        playback={playback}
        playbackRepair={playbackRepair}
      />
    </Shell>
  );
}

/**
 * Full-viewport stage for the viewer.
 *
 * The decorative layers that used to live here — a primary-tinted radial glow
 * bleeding in from the top edge and a masked grid texture — are gone: they read
 * as a stray light leak above every file, whatever its type. A plain background
 * lets the media be the only thing on the page. The height is fixed rather than
 * a minimum so the stage inside resolves to a real height (percentages need a
 * definite one) and the page itself never scrolls under the floating bar.
 */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="page-surface flex h-dvh w-full flex-col overflow-hidden">{children}</main>
  );
}

/** Centered shell for the interstitials (password gate), which size to content. */
function CenteredShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="page-surface flex min-h-dvh w-full items-center justify-center px-4 py-10 sm:py-16">
      {children}
    </main>
  );
}
