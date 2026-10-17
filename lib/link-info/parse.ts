/**
 * Taking a Modlight URL apart, without asking the database anything.
 *
 * `GET /api/link-info` exists so that a caller holding nothing but a link can
 * find out what is behind it in one request. Half of that job is pure string
 * work: which of this deployment's URL shapes is this, and which row does it
 * address? That half lives here, with no database, no `next/headers` and no
 * `server-only`, so the grammar can be pinned by unit tests instead of by
 * curling production.
 *
 * The grammar it encodes is the one the app already serves, not a new one:
 *
 *   /{tag}/{code}[.ext]                 preview page
 *   /{tag}/{code}/raw[.ext]             the bytes
 *   /{tag}/{code}/download              the bytes, as an attachment
 *   /{tag}/{code}/convert?to=...        a converted copy
 *   /{tag}/{code}/render?t=...          the sandboxed viewer frame
 *   /{code}[.ext]                       the same page, for accounts with
 *   /{code}/raw[.ext]                   user.skipTagInUrl
 *   /s/{code} and /s/{tag}/{name}       short links
 *   /a/{tag}/{slug}[/zip]               a shared folder gallery
 *   /u/{tag}                            a public profile gallery
 *
 * Two rules from that grammar are load-bearing here and neither is obvious:
 *
 *  1. The extension is DECORATIVE. `codeFromMediaCode` cuts at the FIRST dot,
 *     so /{tag}/{code}.png, /{tag}/{code}.zzz and /{tag}/{code} are one row -
 *     and the extension never influences the type that comes back either.
 *  2. Two segments are ambiguous by shape alone: /{tag}/{code} and /{code}/raw
 *     look identical. The app tries the tagged reading FIRST and only falls back
 *     to the tagless one, which is what keeps a file whose code happens to be
 *     "raw" reachable. This module reports both readings, in that order, and
 *     the caller resolves them in that order.
 */

import { config } from "@/lib/config";
import { codeFromMediaCode } from "@/lib/media/paths";
import { isReservedTag } from "@/lib/naming";

/** Longest input we will even try to parse. A URL is not a payload. */
const MAX_INPUT = 2048;

/**
 * Second segments that mean "an action on a file" rather than "a file".
 *
 * Copied deliberately from app/[userCode]/[mediaCode]/page.tsx: this is the set
 * the app is willing to read TAGLESSLY, and `render` is absent from it there, so
 * it is absent here. Reporting a tagless /{code}/render as resolvable would
 * describe a URL that answers 404.
 */
const TAGLESS_ACTIONS = /^(raw(\.[a-z0-9]+)?|download|convert)$/i;

/**
 * Paths that keep their own meaning on the shortener host.
 *
 * Mirrors PASSTHROUGH in proxy.ts. It has to: on that host every other path is
 * rewritten to /s{path}, and a describer that skipped the rewrite would look up
 * s.example.com/promo as a media code and answer "not found" about a short link
 * that works perfectly.
 */
const SHORT_HOST_PASSTHROUGH =
  /^\/(?:_next|api|s\/|favicon|icon|apple-icon|robots|sitemap|\.well-known)/;

export type MediaShape = "preview" | "raw" | "download" | "convert" | "render";

export interface MediaRef {
  /** Owner tag taken from the URL, or null when the URL carried no tag. */
  tag: string | null;
  /** The bare code, extension already stripped. */
  code: string;
  shape: MediaShape;
  /** Whatever followed the first dot in the URL, for reporting only. */
  urlExt: string;
}

export type LinkTarget =
  | {
      kind: "media";
      /** Reading to try first. */
      primary: MediaRef;
      /** Second reading of an ambiguous two-segment path, when there is one. */
      fallback?: MediaRef;
    }
  | { kind: "shortlink"; stored: string; unlockGate: boolean }
  | { kind: "folder-gallery"; tag: string; slug: string; zip: boolean }
  | { kind: "user-gallery"; tag: string }
  | { kind: "app-route"; path: string; label: string };

export type ParseRefusal =
  | "missing-url"
  | "unparseable"
  | "foreign-host"
  | "unsupported-shape"
  | "capability-url";

export interface ParsedOk {
  ok: true;
  /** Origin the URL was read on, after normalisation. */
  origin: string;
  /** Path after the shortener-host rewrite, if any. */
  path: string;
  search: string;
  target: LinkTarget;
  warnings: string[];
}

export type ParsedLink = ParsedOk | { ok: false; reason: ParseRefusal; message: string };

function refuse(reason: ParseRefusal, message: string): ParsedLink {
  return { ok: false, reason, message };
}

function safeUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Every origin this deployment answers on, including the shortener domain. */
export function knownOrigins(): string[] {
  const out = [...config.appDomains];
  const short = config.shortUrl;
  if (short && !out.some((o) => o.toLowerCase() === short.toLowerCase())) out.push(short);
  return out;
}

/**
 * Host comparison ignores the scheme on purpose.
 *
 * A link pasted out of a chat log may well say http://; the deployment serves
 * the same files either way and redirects to HTTPS, so refusing it would be
 * pedantry that costs the caller a round trip and teaches them nothing.
 */
function isKnownHost(host: string): boolean {
  const wanted = host.toLowerCase();
  return knownOrigins().some((o) => safeUrl(o)?.host.toLowerCase() === wanted);
}

/**
 * The hostname where every path IS a short link, or null when there is no such
 * host.
 *
 * The null case is the one that matters and it is easy to miss: `config.shortUrl`
 * falls back to APP_URL when SHORTLINK_URL is unset, which is the ordinary
 * single-domain install. proxy.ts installs its rewrite only when SHORTLINK_URL is
 * actually set, so treating that fallback as a shortener host would read every
 * path on the main domain as /s{path} - /login described as a missing short link,
 * every file described as a missing short link. Caught by a test with no
 * SHORTLINK_URL in the environment, which is what most self-hosted installs are.
 */
function shortHostname(): string | null {
  const short = safeUrl(config.shortUrl)?.hostname.toLowerCase() ?? null;
  const app = safeUrl(config.appUrl)?.hostname.toLowerCase() ?? null;
  return short && short !== app ? short : null;
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Everything after the FIRST dot, matching how the code itself is cut off. */
function urlExtOf(segment: string): string {
  const s = decode(segment);
  const dot = s.indexOf(".");
  return dot > 0 ? s.slice(dot + 1) : "";
}

function shapeOfAction(segment: string): MediaShape | null {
  const s = decode(segment).toLowerCase();
  if (s === "raw" || /^raw\.[a-z0-9]+$/.test(s)) return "raw";
  if (s === "download") return "download";
  if (s === "convert") return "convert";
  if (s === "render") return "render";
  return null;
}

/**
 * A human label for a path that is a page of the application rather than a file.
 *
 * Only the ones a caller plausibly pastes. Anything else gets the generic label,
 * which is still an honest answer: this is a page of the app, not a file.
 */
function appRouteLabel(path: string): string {
  const p = path.toLowerCase().replace(/\/+$/, "") || "/";
  if (p === "/") return "the application home page";
  if (p === "/download") return "the desktop app download page";
  if (p === "/download/app") return "a redirect to the current desktop app build";
  if (p === "/api/releases/app") return "the desktop app release manifest (public JSON)";
  if (p === "/oembed") return "the oEmbed endpoint";
  if (p === "/api/link-info") return "this endpoint";
  if (p.startsWith("/embed/")) return "a drawn file-type card (names a category, never a file)";
  if (p.startsWith("/avatar/")) return "an account avatar";
  if (p.startsWith("/bg/")) return "an account wallpaper";
  if (p.startsWith("/api/")) return "an API endpoint";
  if (p.startsWith("/dashboard")) return "a panel page (requires a session)";
  return "a page of the application, not a file";
}

/**
 * Turn any string a caller pasted into a URL on a known origin.
 *
 * Three input shapes are accepted because all three are things people actually
 * hand over: a full URL, a bare path copied out of a log, and a scheme-less
 * "h.example.com/romuz3.png" copied out of a browser bar that hid the scheme.
 */
export function parseLinkUrl(raw: string | null | undefined): ParsedLink {
  if (raw == null || raw.trim() === "") {
    return refuse("missing-url", "Pass the URL to describe as the `url` query parameter.");
  }
  const input = raw.trim();
  if (input.length > MAX_INPUT) {
    return refuse("unparseable", `That is longer than ${MAX_INPUT} characters, so it is not a URL.`);
  }

  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(input);
  let url: URL | null;

  if (scheme) {
    const proto = scheme[1].toLowerCase();
    if (proto !== "http" && proto !== "https") {
      return refuse("unparseable", `Only http and https URLs can be described, not ${proto}:.`);
    }
    url = safeUrl(input);
  } else if (input.startsWith("/")) {
    // A bare path is read on this deployment's own origin, which is the only
    // reading that can be meant.
    url = safeUrl(`${config.appUrl}${input}`);
  } else {
    // "h.example.com/romuz3.png" - a host if the first segment looks like one,
    // otherwise a path that lost its leading slash.
    const first = input.split("/")[0];
    const looksLikeHost = first.includes(".") && /^[a-z0-9.-]+(?::\d+)?$/i.test(first);
    url = safeUrl(looksLikeHost ? `https://${input}` : `${config.appUrl}/${input}`);
  }

  if (!url) return refuse("unparseable", "That is not a URL this endpoint can read.");
  if (!isKnownHost(url.host)) {
    return refuse(
      "foreign-host",
      `${url.host} is not a host of this deployment, so there is nothing here to describe.`,
    );
  }

  const warnings: string[] = [];
  let path = url.pathname;

  const short = shortHostname();
  if (
    short &&
    url.hostname.toLowerCase() === short &&
    path !== "/" &&
    !SHORT_HOST_PASSTHROUGH.test(path)
  ) {
    path = `/s${path}`;
    warnings.push(
      `${url.host} is the short link domain, where every path is a short link. Read as ${path}.`,
    );
  }

  const target = classify(path);
  if (!target.ok) return target.refusal;

  return {
    ok: true,
    origin: `${url.protocol}//${url.host}`,
    path,
    search: url.search,
    target: target.target,
    warnings,
  };
}

type Classified = { ok: true; target: LinkTarget } | { ok: false; refusal: ParsedLink };

function classify(path: string): Classified {
  const segs = path.split("/").filter(Boolean);
  const ok = (target: LinkTarget): Classified => ({ ok: true, target });
  const no = (reason: ParseRefusal, message: string): Classified => ({
    ok: false,
    refusal: refuse(reason, message),
  });

  if (segs.length === 0) return ok({ kind: "app-route", path: "/", label: appRouteLabel("/") });

  const [a, b, c, d] = segs;

  /**
   * A deletion link is a CAPABILITY, not an address: the token in it is the
   * whole authorisation, and POSTing to that exact URL destroys the file, the
   * row and the bytes with no second confirmation. So it is refused by shape,
   * before any lookup - describing it would put a live capability into a
   * metadata response, and probing it would turn this endpoint into an oracle
   * for guessed tokens.
   */
  if (segs.length === 4 && decode(c).toLowerCase() === "delete") {
    return no(
      "capability-url",
      "That is a deletion link. The token in it authorises destroying the file, so it is not described here. Do not POST to it.",
    );
  }

  if (a === "s") {
    const rest = segs.slice(1);
    if (rest.length === 0) return no("unsupported-shape", "A short link URL needs a code.");
    const unlockGate = decode(rest[rest.length - 1]).toLowerCase() === "unlock";
    const parts = unlockGate ? rest.slice(0, -1) : rest;
    if (parts.length === 0 || parts.length > 2) {
      return no("unsupported-shape", "A short link is /s/{code} or /s/{tag}/{name}.");
    }
    return ok({ kind: "shortlink", stored: parts.map(decode).join("/"), unlockGate });
  }

  if (a === "a") {
    if (!b || !c) return no("unsupported-shape", "A folder gallery is /a/{tag}/{slug}.");
    return ok({
      kind: "folder-gallery",
      tag: decode(b),
      slug: decode(c),
      zip: decode(d ?? "").toLowerCase() === "zip",
    });
  }

  if (a === "u") {
    if (!b) return no("unsupported-shape", "A profile gallery is /u/{tag}.");
    return ok({ kind: "user-gallery", tag: decode(b) });
  }

  // Anything whose first segment the app has reserved is a page of the app, not
  // a file. RESERVED_TAGS also covers routes that do not exist yet, which is
  // exactly right here: /pricing is not a file today and must not be reported as
  // one tomorrow either.
  if (isReservedTag(decode(a))) {
    return ok({ kind: "app-route", path, label: appRouteLabel(path) });
  }

  if (segs.length === 1) {
    const code = codeFromMediaCode(a);
    if (!code || a.startsWith(".") || isReservedTag(code)) {
      return no("unsupported-shape", "That single path segment is not a media code.");
    }
    return ok({
      kind: "media",
      primary: { tag: null, code, shape: "preview", urlExt: urlExtOf(a) },
    });
  }

  if (segs.length === 2) {
    const primary: MediaRef = {
      tag: decode(a),
      code: codeFromMediaCode(b),
      shape: "preview",
      urlExt: urlExtOf(b),
    };
    // The ambiguity. Both readings are returned; the caller tries them in this
    // order, which is the order the app itself tries them in.
    const taglessCode = codeFromMediaCode(a);
    const fallback: MediaRef | undefined =
      TAGLESS_ACTIONS.test(decode(b)) && taglessCode && !isReservedTag(taglessCode)
        ? {
            tag: null,
            code: taglessCode,
            shape: shapeOfAction(b) ?? "raw",
            urlExt: urlExtOf(a),
          }
        : undefined;
    return ok({ kind: "media", primary, fallback });
  }

  if (segs.length === 3) {
    const shape = shapeOfAction(c);
    if (!shape) {
      return no("unsupported-shape", `"${decode(c)}" is not an action this deployment serves.`);
    }
    return ok({
      kind: "media",
      primary: { tag: decode(a), code: codeFromMediaCode(b), shape, urlExt: urlExtOf(b) },
    });
  }

  return no("unsupported-shape", "That path is deeper than any URL shape this deployment serves.");
}
