/**
 * Which type card a file gets in a link preview, and where that card lives.
 *
 * Pure on purpose (no database, no storage, no sharp): the mapping is the part
 * worth pinning in a test, and keeping it here is also what makes the card route
 * unable to touch a file row at all. A card is addressed by (category, token),
 * never by a file code, so it cannot leak whether a code exists, cannot spend a
 * burn-after-view budget, and one cache entry is shared by every ZIP on the
 * instance rather than minted per upload.
 */

import { isDisplayableImage, mediaKind } from "@/lib/media/mime";

/**
 * Version segment, carried in the PATH rather than a query string.
 *
 * Discord copies an og:image onto media.discordapp.net and never revalidates,
 * so a URL's bytes must be frozen forever. Redrawing the art means minting new
 * URLs; old messages keep the old picture, which is the honest outcome.
 */
export const EMBED_CARD_VERSION = "v1";

/** Open Graph's canonical card size. Nothing crops at exactly 1.91:1. */
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

export const CARD_CATEGORIES = [
  "code",
  "archive",
  "document",
  "sheet",
  "audio",
  "text",
  "image",
  "binary",
] as const;

export type CardCategory = (typeof CARD_CATEGORIES)[number];

const CATEGORY_SET: ReadonlySet<string> = new Set(CARD_CATEGORIES);

export function isCardCategory(value: string): value is CardCategory {
  return CATEGORY_SET.has(value);
}

/**
 * Word shown when the extension is missing or unprintable.
 *
 * Every one of these is inside [A-Z] by construction, which is the whole
 * mechanism: the card's alphabet is closed, so the font cannot be asked for a
 * glyph it lacks and tofu is impossible however the file was named.
 */
const FALLBACK_TOKEN: Record<CardCategory, string> = {
  code: "CODE",
  archive: "ARCHIVE",
  document: "DOCUMENT",
  sheet: "SHEET",
  audio: "AUDIO",
  text: "TEXT",
  image: "IMAGE",
  binary: "FILE",
};

/** Longest token the card lays out. "DOCUMENT" is the longest word we emit. */
export const MAX_TOKEN_LENGTH = 8;

const TOKEN_RE = /^[A-Z0-9]{1,8}$/;

export function isCardToken(value: string): boolean {
  return TOKEN_RE.test(value);
}

/**
 * Extension to category. Ordered by how often a file of that kind is shared,
 * not alphabetically, because the tail of each list is where a wrong guess is
 * cheapest.
 */
const EXT_CATEGORY: Record<string, CardCategory> = {};

function claim(category: CardCategory, exts: string) {
  for (const ext of exts.split(/\s+/)) if (ext) EXT_CATEGORY[ext] = category;
}

claim(
  "code",
  `html htm css scss less js mjs cjs jsx ts tsx php py rb go rs java kt swift
   c h cpp hpp cs sh bash zsh ps1 bat sql json xml yml yaml toml ini env
   vue svelte lua pl r dart ex exs astro graphql proto tf`,
);
claim(
  "archive",
  `zip rar 7z tar gz tgz bz2 xz zst lz lzma arj cab iso dmg jar war apk xapk
   pkg deb rpm`,
);
claim("document", `pdf doc docx odt rtf tex epub mobi pages ppt pptx odp key`);
claim("sheet", `xls xlsx xlsm csv tsv ods numbers`);
claim("audio", `mp3 wav flac ogg oga opus m4a aac aiff wma mid midi amr`);
claim("text", `txt md markdown log nfo srt vtt rst cfg conf diff patch`);
// Images the browser will NOT render inline, so they never get a real thumbnail
// and today get no picture at all.
claim("image", `svg psd ai eps heic heif xcf raw cr2 cr3 nef arw dng orf rw2`);
claim("binary", `exe msi dll so dylib bin dat o a wasm class pyc ttf otf woff woff2`);

export interface CardSubject {
  ext: string;
  mimeType: string;
  /** uploads.kind: "file" | "paste". */
  kind: string;
}

export interface CardChoice {
  category: CardCategory;
  /** Short label drawn under the glyph, always [A-Z0-9]{1,8}. */
  token: string;
}

/**
 * The card a file should advertise, or null when it must keep advertising
 * itself.
 *
 * Null for displayable images and for video: those unfurl as the real picture
 * or a real player, and replacing that with a drawing of a picture would be a
 * downgrade. This function is the single place that decision is written down,
 * so it is testable without building a whole embed plan.
 */
export function cardChoiceFor(media: CardSubject): CardChoice | null {
  if (isDisplayableImage(media.mimeType, media.ext)) return null;
  const kind = mediaKind(media.mimeType, media.ext);
  if (kind === "video") return null;

  const category = categoryFor(media, kind);
  return { category, token: tokenFor(media.ext, category) };
}

function categoryFor(media: CardSubject, kind: ReturnType<typeof mediaKind>): CardCategory {
  // An in-app paste is text whatever the extension says, and its extension is
  // whatever language the author picked.
  if (media.kind === "paste") return "text";

  const byExt = EXT_CATEGORY[media.ext.toLowerCase()];
  if (byExt) return byExt;

  if (kind === "audio") return "audio";
  if (kind === "archive") return "archive";
  if (kind === "pdf") return "document";
  if (kind === "text") return "text";

  const mime = media.mimeType.toLowerCase();
  if (mime.startsWith("text/")) return "text";
  // Not displayable (that returned null already), so this is a raster/vector
  // format the browser declines to show: still an image to the person who has it.
  if (mime.startsWith("image/")) return "image";
  if (mime.endsWith("+json") || mime.endsWith("+xml") || mime === "application/json") return "code";
  if (mime.includes("javascript")) return "code";
  if (mime.includes("spreadsheet") || mime.includes("ms-excel")) return "sheet";
  if (mime.includes("word") || mime.includes("presentation") || mime.includes("powerpoint")) {
    return "document";
  }

  return "binary";
}

/** Extension as a drawable token, or the category's word when it is not one. */
/**
 * The label on the card, and it may only ever be one of a CLOSED set.
 *
 * An unrecognised extension falls back to the category's generic word rather
 * than being echoed onto the card. That costs a `.xyzzy` upload its bespoke
 * label and buys something much more valuable: the set of card URLs this
 * deployment can emit is finite and known, which is what lets the public,
 * unauthenticated render route reject everything else outright.
 *
 * Echoing the extension made the address space 8 x 36^8, roughly 2.2e13 valid
 * URLs, every one of which drew a fresh PNG through sharp and kept it in a map
 * that never evicted - unbounded memory and unbounded CPU behind no auth.
 */
export function tokenFor(ext: string, category: CardCategory): string {
  const cleaned = ext.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, MAX_TOKEN_LENGTH);
  if (cleaned && EXT_CATEGORY[cleaned.toLowerCase()]) return cleaned;
  return FALLBACK_TOKEN[category];
}

/**
 * Is this pair one the app could actually have produced?
 *
 * Pair, not token: `code-ZIP.png` is not a URL any file would generate, and
 * refusing it keeps the render cache to one entry per real combination instead
 * of one per category per token.
 */
export function isRenderableChoice(category: CardCategory, token: string): boolean {
  if (FALLBACK_TOKEN[category] === token) return true;
  return EXT_CATEGORY[token.toLowerCase()] === category;
}

/** `/embed/v1/archive-ZIP.png` - no file identifier anywhere in it. */
export function cardPath(choice: CardChoice): string {
  return `/embed/${EMBED_CARD_VERSION}/${choice.category}-${choice.token}.png`;
}

export function cardUrl(origin: string, choice: CardChoice): string {
  return `${origin.replace(/\/+$/, "")}${cardPath(choice)}`;
}

/**
 * Read back a `{category}-{TOKEN}.png` filename. Returns null for anything the
 * closed lists do not admit, so no arbitrary string ever reaches the renderer.
 */
export function parseCardFile(file: string): CardChoice | null {
  const m = /^([a-z]+)-([A-Z0-9]{1,8})\.png$/.exec(file);
  if (!m) return null;
  const [, category, token] = m;
  if (!isCardCategory(category)) return null;
  // The shape check above is not enough on its own: it admits 36^8 tokens per
  // category, and every admitted URL costs one sharp render and one cache entry
  // that is never evicted. Only pairs this app can emit get drawn.
  if (!isRenderableChoice(category, token)) return null;
  return { category, token };
}
