import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "@/lib/config";
import { docxSupport, MAX_DOCX_BYTES } from "@/lib/media/docx-support";

/**
 * Authorization for the sandboxed HTML/SVG preview.
 *
 * /raw stays what it has always been: uploaded markup is served as text/plain,
 * inert whatever it contains. Rendering it for real happens on a separate route
 * (/{tag}/{code}/render), inside an iframe with no allow-same-origin and a CSP
 * `sandbox`, and only when the viewer asked for it by clicking.
 *
 * The ticket is what stops that route from becoming a bypass of the gates the
 * preview page enforces. The page is rendered only AFTER published/password/
 * expiry/view-budget have all been cleared, so the page is the right place to
 * issue proof that they were - a short-lived HMAC over the upload id, with no
 * server-side state to keep. The render route re-checks every gate anyway; the
 * ticket is what makes a hand-crafted /render URL useless on its own.
 *
 * Framework-agnostic (no next/*) so it stays unit-testable.
 */

/** Ticket lifetime. Long enough to click the toggle, short enough to not travel. */
export const RENDER_TICKET_TTL = 15 * 60;

/**
 * Largest file offered for rendering. A preview is a look at a page, not a way
 * to stream a multi-megabyte bundle through an iframe.
 */
export const MAX_RENDER_BYTES = 5 * 1024 * 1024;

/**
 * What a rendered document is allowed to be.
 *
 * `docx` is the odd one out and deliberately so: the other two serve the
 * uploaded BYTES, while docx serves markup we generate from them with mammoth.
 * It is in this table rather than in a mechanism of its own because the property
 * that matters is identical - it is HTML derived from a file somebody else
 * uploaded, so it belongs in an opaque origin. See lib/media/docx.ts for why
 * that was preferred to sanitising mammoth's output.
 */
export type SandboxShape = "html" | "svg" | "docx";

/**
 * Allowlist, not a blocklist: everything here executes script in the origin it
 * is served from, which is exactly why it may only ever be served into an opaque
 * one. Nothing else is renderable - notably NOT multipart/related (.mhtml),
 * which can smuggle a whole site into one file.
 */
const RENDERABLE: Record<string, SandboxShape> = {
  "text/html": "html",
  "application/xhtml+xml": "html",
  "image/svg+xml": "svg",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

/**
 * Shapes that must never be granted `allow-scripts` on their iframe.
 *
 * SVG because script in a drawing is essentially always an attack, and docx
 * because a converted document has nothing to run: mammoth emits headings,
 * lists, tables and images, and any script in that output would be a bug in
 * mammoth or a document exploiting one. Sandbox flags from the iframe attribute
 * and from the response policy INTERSECT, so this cannot be loosened by the
 * config-level CSP that grants allow-scripts for uploaded HTML.
 */
export function allowsScripts(shape: SandboxShape): boolean {
  return shape === "html";
}

function normalizeMime(mime: string): string {
  return mime.split(";")[0].trim().toLowerCase();
}

/** The shape for a renderable type, null for everything else. */
export function sandboxShape(
  mime: string | null | undefined,
  ext?: string | null,
): SandboxShape | null {
  const byMime = mime ? RENDERABLE[normalizeMime(mime)] : undefined;
  if (byMime) return byMime;
  // Only the document case falls back to the extension. Uploaded HTML and SVG
  // are decided by their stored type alone, on purpose: promoting a file to
  // "executable markup" on the strength of its NAME would let a .html suffix
  // turn any upload into a page, and those bytes are deliberately served as
  // inert text/plain everywhere else.
  return docxSupport(mime, ext) === "docx" ? "docx" : null;
}

/**
 * May this upload be offered a "render" toggle at all?
 *
 * `ext` is consulted because the stored type is so often useless: ShareX and
 * curl send application/octet-stream for anything Windows has no registry entry
 * for, and an imported row keeps whatever its old host guessed years ago. A
 * .docx stored as octet-stream is still a .docx, and without this it would get
 * no preview at all - which is most of them.
 *
 * The size ceiling is per shape: a document is a ZIP that expands, so it answers
 * to its own limit rather than to the one sized for a page of markup.
 */
export function canRenderInline(media: {
  mimeType: string;
  ext?: string | null;
  size: number;
}): boolean {
  const shape = sandboxShape(media.mimeType, media.ext);
  if (!shape) return false;
  return media.size <= (shape === "docx" ? MAX_DOCX_BYTES : MAX_RENDER_BYTES);
}

// ---------------------------------------------------------------------------
// Ticket
// ---------------------------------------------------------------------------

/** `<mediaId>.<expiry>.<HMAC>` - ids are uuids, so the separator is unambiguous. */
export function mintRenderTicket(mediaId: string, ttlSeconds: number = RENDER_TICKET_TTL): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `${mediaId}.${exp}.${sign(mediaId, exp)}`;
}

/** The upload id this ticket authorizes, or null when it proves nothing. */
export function verifyRenderTicket(ticket: string | null | undefined): string | null {
  if (!ticket) return null;
  const parts = ticket.split(".");
  if (parts.length !== 3) return null;
  const [mediaId, rawExp, signature] = parts;
  if (!mediaId || !signature) return null;

  const exp = Number(rawExp);
  if (!Number.isSafeInteger(exp) || exp <= 0) return null;
  if (exp * 1000 <= Date.now()) return null;

  return equalStrings(signature, sign(mediaId, exp)) ? mediaId : null;
}

function sign(mediaId: string, exp: number): string {
  const message = ["render", mediaId, String(exp)].map(encodeURIComponent).join("|");
  return createHmac("sha256", config.auth.secret).update(message).digest("base64url");
}

function equalStrings(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Request admission
// ---------------------------------------------------------------------------

export type RenderAdmission =
  | { allow: true; mediaId: string }
  /** A genuine top-level visit: hand the visitor the preview page instead. */
  | { allow: false; reason: "not-a-frame" }
  /**
   * The client did not say what it was fetching for, so we cannot tell a
   * top-level visit from a frame. Distinct from `not-a-frame` because the two
   * deserve opposite answers: redirecting is friendly for a real navigation and
   * harmful for a frame, where it would load the whole preview page INSIDE the
   * frame and spend a second view on every click of the toggle.
   */
  | { allow: false; reason: "unknown-dest" }
  | { allow: false; reason: "bad-ticket" };

/**
 * Is this request allowed to receive executable markup?
 *
 * `Sec-Fetch-Dest: iframe` is the load-bearing half. Without it a /render URL
 * could be pasted into a chat and opened as a TOP-LEVEL document on our domain,
 * with our certificate in the address bar - the perfect phishing page, and it
 * would need no scripting at all. The header cannot be set from JavaScript, and
 * anything that omits it (curl, an old client) is treated as "not a frame",
 * which is the safe default.
 */
export function renderAdmission(input: {
  secFetchDest: string | null | undefined;
  ticket: string | null | undefined;
}): RenderAdmission {
  // Absent header: every browser that can run this feature sends it (Safari
  // gained it in 16.4), so the remaining callers are scripts and very old
  // clients. Refuse rather than redirect - see `unknown-dest` above.
  if (!input.secFetchDest) return { allow: false, reason: "unknown-dest" };
  if (input.secFetchDest !== "iframe") return { allow: false, reason: "not-a-frame" };
  const mediaId = verifyRenderTicket(input.ticket);
  if (!mediaId) return { allow: false, reason: "bad-ticket" };
  return { allow: true, mediaId };
}

// ---------------------------------------------------------------------------
// Response headers
// ---------------------------------------------------------------------------

/**
 * The policy that makes this safe at all.
 *
 * `sandbox` in a RESPONSE header drops the document into an opaque origin
 * whether or not it ended up in a frame, so it can reach no cookie, no
 * localStorage, no Service Worker and no server action of ours. The iframe's own
 * sandbox attribute is the second layer (it is what removes forms, popups,
 * downloads and top-level navigation); the two intersect, so neither can loosen
 * the other.
 *
 * SVG gets no allow-scripts: script in an SVG is essentially always an attack,
 * and nothing legitimate about a vector drawing needs it.
 *
 * IMPORTANT, and measured rather than assumed: on the live route this policy is
 * usually NOT the one the browser sees. Next applies the next.config header
 * rules with res.setHeader before the handler runs, and then merges a route's
 * own headers only for keys the response does not already carry
 * (send-response.js) - Content-Security-Policy is not on its exception list, so
 * the config wins and this string is discarded. It is kept as the fallback that
 * engages if that rule is ever narrowed or removed, not as a second layer.
 *
 * What actually gives SVG its stricter treatment is the iframe's own
 * sandbox="" attribute (components/viewer/SourceView.tsx): sandbox flags from
 * the attribute and from a policy INTERSECT, so allow-scripts arriving from the
 * config cannot re-enable scripting for a frame that never granted it.
 */
export function renderCsp(shape: SandboxShape): string {
  return [
    allowsScripts(shape) ? "sandbox allow-scripts" : "sandbox",
    "default-src 'none'",
    "img-src data: blob:",
    "media-src data: blob:",
    "font-src data:",
    "style-src 'unsafe-inline'",
    ...(allowsScripts(shape) ? ["script-src 'unsafe-inline'"] : []),
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

export function renderContentType(shape: SandboxShape): string {
  return shape === "svg" ? "image/svg+xml; charset=utf-8" : "text/html; charset=utf-8";
}

/**
 * Is this shape the uploaded bytes, or markup we generate from them?
 *
 * The render route streams the file for `html` and `svg` and has to run a
 * converter for `docx`, and that is the only place the two differ.
 */
export function isGenerated(shape: SandboxShape): boolean {
  return shape === "docx";
}
