import type { Metadata } from "next";
import { humanFileSize } from "@/lib/format";
import { effectiveType, isDisplayableImage, mediaKind } from "@/lib/media/mime";
import { CARD_HEIGHT, CARD_WIDTH, cardChoiceFor, cardUrl } from "@/lib/media/card";

/**
 * What a shared link says when a chat client unfurls it.
 *
 * Pure on purpose (no database, no next/headers, no config import): the whole
 * point of this module is that the card can be asserted in a unit test, because
 * the old one was assembled inline and quietly said the product name four times
 * and the file name twice.
 *
 * The rules it encodes:
 *  - the brand appears EXACTLY once, as og:site_name;
 *  - the file name appears EXACTLY once, as og:title;
 *  - the description carries facts the title cannot (type, dimensions, size),
 *    or the opening of the text for a paste;
 *  - no twitter:* tag except the card size. X stopped rendering descriptions,
 *    twitter:title only duplicates og:title, and twitter:description/player are
 *    reported to break the Telegram embed outright.
 */

/** Discord and friends stop proxying a still somewhere around this size. */
const EMBED_PROXY_LIMIT = 8 * 1024 * 1024;

/**
 * Mirrors MAX_TRANSFORM_BYTES in the raw route: past this it declines to
 * rasterise anything and hands back the original. Kept in step by this comment
 * rather than by an import, because pulling a server-only route module into
 * this pure one would drag sharp and the storage driver in with it.
 */
const RAW_TRANSFORM_LIMIT = 32 * 1024 * 1024;

/** Widest still an unfurler will show; anything larger is scaled, never cropped. */
const EMBED_IMAGE_WIDTH = 1200;

/** Longest file name kept whole in a title before the middle is elided. */
const MAX_TITLE_LENGTH = 100;

/** Longest paste excerpt used as a description (Discord truncates near 300). */
const MAX_SNIPPET_LENGTH = 180;

export interface EmbedMedia {
  filename: string;
  ext: string;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  /** uploads.kind: "file" | "paste". */
  kind: string;
  published: boolean;
  hasPassword: boolean;
  /**
   * The file carries a view cap (burn-after-N-views).
   *
   * It suppresses og:image for the same reason a password does: an unfurler
   * copies the picture onto its own CDN and serves it publicly forever, so a
   * preview of a one-time link is that link's content published permanently -
   * and the fetch itself would spend one of the views the sender meant for a
   * person.
   */
  hasViewCap: boolean;
}

export interface EmbedContext {
  /** Site name, one word, same for every hostname of this deployment. */
  brand: string;
  /** Product name. Used only for the title of a protected file. */
  appName: string;
  /** Canonical preview page URL. */
  page: string;
  /** Raw file URL on the owner's hostname. */
  raw: string;
  /** oEmbed discovery href. */
  oembedHref: string;
  /**
   * Where the machine-readable description of THIS file lives
   * (`/api/link-info?url=…`). Optional, so a caller that has no use for it - the
   * unit tests, anything rendering a card in isolation - keeps working unchanged.
   *
   * Advertised for the same reason oEmbed is: something that fetched this URL
   * and got HTML has no way to guess the convention. oEmbed answers "how do I
   * embed this"; link-info answers "what IS this and where are the bytes", which
   * is the question an automated reader actually has after receiving 156 kB of
   * markup for what looked like a .png. Emitted only on a card, so a gated or
   * unlisted page keeps the empty head it was given deliberately.
   */
  linkInfoHref?: string;
  /**
   * Origin the type card is served from. Same host as the rest of the card, so
   * an unfurler makes one connection, not two.
   */
  cardOrigin: string;
  /** First bytes of a text file or paste, when they were cheap to read. */
  snippet?: string | null;
}

export interface OgImage {
  url: string;
  width?: number;
  height?: number;
  type?: string;
  alt: string;
}

export interface OgVideo {
  url: string;
  type: string;
  width: number;
  height: number;
}

export interface OgCard {
  type: "website" | "video.other";
  title: string;
  siteName: string;
  url: string;
  description: string;
  image?: OgImage;
  video?: OgVideo;
}

export type EmbedPlan =
  /** Password-gated: not even the file name may leak into a title. */
  | { mode: "protected"; documentTitle: string }
  /** Unpublished: reachable by its owner, never advertised. */
  | { mode: "unlisted"; documentTitle: string }
  | {
      mode: "card";
      documentTitle: string;
      canonical: string;
      oembedHref: string;
      linkInfoHref?: string;
      twitterCard: "summary" | "summary_large_image";
      og: OgCard;
    };

/** Decide every tag a preview page will emit. */
export function buildEmbedPlan(media: EmbedMedia, ctx: EmbedContext): EmbedPlan {
  // Unchanged from the original behaviour, and it has to be: the title is the
  // one thing a browser shows before anything is unlocked, and
  // "raport-finansowy-2026.xlsx" often says more than the contents would.
  if (media.hasPassword) return { mode: "protected", documentTitle: ctx.appName };
  if (!media.published) return { mode: "unlisted", documentTitle: media.filename };

  const title = elideMiddle(media.filename, MAX_TITLE_LENGTH);
  const documentTitle = `${title} · ${ctx.brand}`;
  // The extension travels with the type everywhere: an upload stored as
  // application/octet-stream is still an image, and its card should say so.
  const kind = mediaKind(media.mimeType, media.ext);
  const isImage = isDisplayableImage(media.mimeType, media.ext);
  const isText = media.kind === "paste" || kind === "text" || media.mimeType.startsWith("text/");

  const shared = {
    mode: "card" as const,
    documentTitle,
    canonical: ctx.page,
    oembedHref: ctx.oembedHref,
    ...(ctx.linkInfoHref ? { linkInfoHref: ctx.linkInfoHref } : {}),
  };

  if (isImage) {
    return {
      ...shared,
      twitterCard: "summary_large_image",
      og: {
        type: "website",
        title,
        siteName: ctx.brand,
        url: ctx.page,
        description: dimensionsDescription(media),
        ...(media.hasViewCap ? {} : { image: embedImage(media, ctx.raw, title) }),
      },
    };
  }

  if (kind === "video") {
    return {
      ...shared,
      // Not "player": that card needs an HTTPS iframe player on X's allowlist,
      // and we hand it a bare .mp4, so it renders nothing at all today.
      twitterCard: "summary",
      og: {
        type: "video.other",
        title,
        siteName: ctx.brand,
        url: ctx.page,
        description: dimensionsDescription(media),
        // No og:image on purpose: the thumbnail endpoint only rasterizes images,
        // so a "still" URL for a video streams the entire clip back.
        ...(media.hasViewCap
          ? {}
          : {
              video: {
                url: ctx.raw,
                type: media.mimeType,
                width: media.width ?? 1280,
                height: media.height ?? 720,
              },
            }),
      },
    };
  }

  // Everything else: archives, code, documents, pastes, audio, binaries, and the
  // image formats a browser refuses to render. None of these has a picture of
  // its own, and until now they had no og:image at all, so a shared .zip was
  // three lines of grey text. They get a drawn card instead - one family, one
  // glyph per category. `summary_large_image` is not decoration here: at
  // `summary` Discord files the picture into an 80x80 tile, where the glyph is
  // 17px and the token is a smear.
  const card = cardChoiceFor(media);

  return {
    ...shared,
    twitterCard: card ? "summary_large_image" : "summary",
    og: {
      type: "website",
      title,
      siteName: ctx.brand,
      url: ctx.page,
      description: isText
        ? (snippetDescription(ctx.snippet) ?? sizeDescription(media))
        : sizeDescription(media),
      ...(card
        ? {
            image: {
              url: cardUrl(ctx.cardOrigin, card),
              width: CARD_WIDTH,
              height: CARD_HEIGHT,
              type: "image/png",
              // The spoken equivalent of the glyph, for a screen reader.
              alt: longType(media),
            },
          }
        : {}),
    },
  };
}

/** Turn a plan into the Metadata object Next renders. */
export function embedMetadata(plan: EmbedPlan): Metadata {
  if (plan.mode !== "card") {
    return {
      // `absolute` here too: a plain string still runs through the root
      // layout's "%s - <appName>" template, which rendered the gated page as
      // "Modlight - Modlight".
      title: { absolute: plan.documentTitle },
      // The root layout's product blurb would otherwise describe every gated
      // file with a paragraph of marketing.
      description: null,
      applicationName: null,
      robots: { index: false, follow: false },
    };
  }

  const { og } = plan;
  return {
    // `absolute` skips the root layout's "%s - <appName>" template, so the tab
    // and the card agree instead of naming two different things.
    title: { absolute: plan.documentTitle },
    // Explicitly cleared, not merely omitted: metadata is INHERITED from the
    // root layout, so leaving these out published the product blurb (and a
    // second mention of the app name) on the page of every single file.
    description: null,
    applicationName: null,
    alternates: {
      canonical: plan.canonical,
      types: {
        "application/json+oembed": plan.oembedHref,
        // A second alternate representation of this page, and a distinct media
        // type from the oEmbed one, so the two links cannot be confused for each
        // other by a consumer that reads only `type`.
        ...(plan.linkInfoHref ? { "application/json": plan.linkInfoHref } : {}),
      },
    },
    openGraph: {
      type: og.type,
      title: og.title,
      siteName: og.siteName,
      url: og.url,
      description: og.description,
      ...(og.image
        ? {
            images: [
              {
                url: og.image.url,
                secureUrl: og.image.url,
                width: og.image.width,
                height: og.image.height,
                type: og.image.type,
                alt: og.image.alt,
              },
            ],
          }
        : {}),
      ...(og.video
        ? {
            videos: [
              {
                url: og.video.url,
                secureUrl: og.video.url,
                type: og.video.type,
                width: og.video.width,
                height: og.video.height,
              },
            ],
          }
        : {}),
    },
    // Stated explicitly, because Next fills the twitter:* family in from
    // openGraph whether or not this object exists. Routing the card through
    // `other` instead did not suppress that - it just added a SECOND
    // twitter:card tag next to the generated one. Declaring the block is the
    // only way to end up with exactly one of each; the values deliberately
    // mirror Open Graph, so no consumer sees two different stories.
    twitter: {
      card: plan.twitterCard,
      title: { absolute: og.title },
      description: og.description,
      images: og.image ? [og.image.url] : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------

/** "PNG · 1920x1080 · 240.0 KB" - facts the title and the picture don't carry. */
function dimensionsDescription(media: EmbedMedia): string {
  const parts = [shortType(media)];
  if (media.width && media.height) parts.push(`${media.width}x${media.height}`);
  parts.push(humanFileSize(media.size));
  return parts.join(" · ");
}

/** "ZIP archive · 24.8 MB" for everything without a picture to show. */
function sizeDescription(media: EmbedMedia): string {
  return `${longType(media)} · ${humanFileSize(media.size)}`;
}

/** The opening of a paste, whitespace collapsed. Null when there is nothing to show. */
function snippetDescription(snippet: string | null | undefined): string | null {
  if (!snippet) return null;
  const flat = snippet
    // A snippet is cut at a byte offset, so it can end mid character.
    .replace(/\ufffd/g, "")
    // Control characters would survive into the tag as garbage.
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return null;
  return flat.length > MAX_SNIPPET_LENGTH
    ? `${flat.slice(0, MAX_SNIPPET_LENGTH).trimEnd()}...`
    : flat;
}

/** Extension in caps ("PNG"), falling back to the MIME subtype. */
function shortType(media: EmbedMedia): string {
  if (media.ext) return media.ext.toUpperCase();
  const sub = media.mimeType.split("/")[1] ?? media.mimeType;
  return sub.split("+")[0].toUpperCase();
}

const LONG_TYPES: Record<string, string> = {
  pdf: "PDF document",
  zip: "ZIP archive",
  rar: "RAR archive",
  "7z": "7z archive",
  tar: "TAR archive",
  gz: "GZIP archive",
  tgz: "GZIP archive",
  mp3: "MP3 audio",
  wav: "WAV audio",
  flac: "FLAC audio",
  ogg: "OGG audio",
  opus: "Opus audio",
  m4a: "M4A audio",
  txt: "Text file",
  md: "Markdown document",
  json: "JSON file",
  csv: "CSV spreadsheet",
  html: "HTML document",
  // Stays "image", and its card carries the picture glyph: an SVG is a drawing
  // its author made, even though we serve the bytes as inert text. Filing it
  // under code would describe how we handle it, not what it is.
  svg: "SVG image",
  doc: "Word document",
  docx: "Word document",
  xls: "Excel spreadsheet",
  xlsx: "Excel spreadsheet",
  ppt: "PowerPoint presentation",
  pptx: "PowerPoint presentation",
};

/** A readable label ("PDF document"), or just the extension when unknown. */
function longType(media: EmbedMedia): string {
  const byExt = LONG_TYPES[media.ext.toLowerCase()];
  if (byExt) return byExt;
  const kind = mediaKind(media.mimeType, media.ext);
  if (kind === "audio") return `${shortType(media)} audio`;
  if (kind === "archive") return `${shortType(media)} archive`;
  return shortType(media);
}

// ---------------------------------------------------------------------------
// Image
// ---------------------------------------------------------------------------

/**
 * One og:image, never two.
 *
 * The page used to emit the original AND a 1200x630 crop of it; consumers pick
 * whichever they like, so a screenshot had a coin-flip chance of being shown
 * cropped to 1.91:1. Oversized stills are scaled with `fit=inside` (the raw
 * route's own thumbnailer, which returns WebP) so the whole frame survives.
 */
function embedImage(media: EmbedMedia, raw: string, alt: string): OgImage {
  const width = media.width ?? 0;
  const height = media.height ?? 0;
  const tooWide = width > EMBED_IMAGE_WIDTH;
  const tooHeavy = media.size > EMBED_PROXY_LIMIT;
  // The type an unfurler is TOLD, resolved the way every other decision on this
  // page resolves it. Taking `mimeType` literally announced a perfectly ordinary
  // .avif as `application/octet-stream` — which is exactly the type a chat
  // client refuses to render, on the file that reaches this branch precisely
  // because we decided it was an image.
  const declared = effectiveType(media.mimeType, media.ext);

  // Above the raw route's own transform ceiling the `?w=` parameter is ignored
  // and the original bytes are streamed instead, so asking for a resize here
  // would advertise a WebP of 1200px and deliver, say, a 6000px PNG. Announcing
  // the file as it really is beats announcing a picture that never arrives.
  if (media.size > RAW_TRANSFORM_LIMIT) {
    return {
      url: raw,
      width: media.width ?? undefined,
      height: media.height ?? undefined,
      type: declared,
      alt,
    };
  }

  if (!tooWide && !tooHeavy) {
    return {
      url: raw,
      width: media.width ?? undefined,
      height: media.height ?? undefined,
      type: declared,
      alt,
    };
  }

  const url = `${raw}?w=${EMBED_IMAGE_WIDTH}&fit=inside`;
  if (tooWide && height > 0) {
    return {
      url,
      width: EMBED_IMAGE_WIDTH,
      height: Math.max(1, Math.round((height * EMBED_IMAGE_WIDTH) / width)),
      type: "image/webp",
      alt,
    };
  }
  // Heavy but not wide: the thumbnailer keeps the original dimensions.
  return {
    url,
    width: media.width ?? undefined,
    height: media.height ?? undefined,
    type: "image/webp",
    alt,
  };
}

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------

/**
 * Shorten from the middle so the extension survives: a card reading
 * "very-long-generated-name...-final.pdf" still tells you what it is, one
 * truncated at the end does not.
 */
export function elideMiddle(name: string, max: number): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : "";
  const room = max - ext.length - 3;
  if (room < 8) return `${name.slice(0, Math.max(1, max - 3))}...`;
  const head = Math.ceil(room * 0.6);
  const tail = room - head;
  return `${name.slice(0, head)}...${name.slice(name.length - ext.length - tail, name.length - ext.length)}${ext}`;
}
